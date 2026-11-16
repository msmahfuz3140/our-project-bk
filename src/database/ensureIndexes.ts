import mongoose from 'mongoose';
import { PaymentModel } from '../models/Payment';
import { PaymentEventModel } from '../models/PaymentEvent';
import { SubscriptionModel } from '../models/Subscription';
import { UserModel } from '../models/User';
import { OtpVerificationModel } from '../models/OtpVerification';
import { ContactMessageModel } from '../models/ContactMessage';
import { SecurityLogModel } from '../models/SecurityLog';
import { ReferralClickModel } from '../models/ReferralClick';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { CommissionPolicyModel } from '../models/CommissionPolicy';
import { WalletModel } from '../models/Wallet';
import { WalletTransactionModel } from '../models/WalletTransaction';
import { WithdrawalRequestModel } from '../models/WithdrawalRequest';
import { SystemMigrationModel } from '../models/SystemMigration';
import { logger } from '../utils/logger';

let ensured = false;
let lastError: string | null = null;
let lastEnsuredAt: Date | null = null;
let securityBaselineEnsured = false;

/**
 * Production safety net: `autoIndex` is disabled when NODE_ENV=production.
 * The webhook idempotency guarantees depend on unique indexes, so we create
 * the critical indexes explicitly on startup. MongoDB makes this idempotent.
 */
export async function ensurePaymentIndexes(): Promise<boolean> {
  if (mongoose.connection.readyState !== 1) {
    return false;
  }

  if (ensured) {
    return true;
  }

  try {
    await Promise.all([
      PaymentModel.createIndexes(),
      PaymentEventModel.createIndexes(),
      SubscriptionModel.createIndexes(),
      ContactMessageModel.createIndexes(),
      SecurityLogModel.createIndexes(),
      ReferralClickModel.createIndexes(),
      ReferralCommissionModel.createIndexes(),
      CommissionPolicyModel.createIndexes(),
      WalletModel.createIndexes(),
      WalletTransactionModel.createIndexes(),
      WithdrawalRequestModel.createIndexes(),
      UserModel.createIndexes(),
      SystemMigrationModel.createIndexes(),
      OtpVerificationModel.createIndexes()
    ]);
    ensured = true;
    lastError = null;
    lastEnsuredAt = new Date();
    logger.info('Payment and subscription indexes are ready');
    return true;
  } catch (error: any) {
    lastError = error?.message || 'Unknown index creation error';
    logger.error('Failed to ensure payment indexes', error);
    return false;
  }
}

export function getPaymentIndexStatus(): {
  ready: boolean;
  lastError: string | null;
  lastEnsuredAt: string | null;
} {
  return {
    ready: ensured,
    lastError,
    lastEnsuredAt: lastEnsuredAt ? lastEnsuredAt.toISOString() : null
  };
}

/**
 * One-time security cleanup for legacy documents:
 * - Removes the historical `plainPassword` field, which must never exist.
 * - Removes development-only raw OTP codes that may have been written by an
 *   older build running with NODE_ENV=development.
 *
 * This does not delete users, payments, subscriptions, or any business data.
 */
export async function ensureSecurityBaseline(): Promise<{ removedPlaintextPasswords: number; removedRawOtps: number }> {
  if (mongoose.connection.readyState !== 1) {
    return { removedPlaintextPasswords: 0, removedRawOtps: 0 };
  }

  if (securityBaselineEnsured) {
    return { removedPlaintextPasswords: 0, removedRawOtps: 0 };
  }

  const migrationKey = '2026-11-security-baseline-v1';
  const existingMigration = await SystemMigrationModel.findOne({ key: migrationKey }).lean();
  if (existingMigration) {
    securityBaselineEnsured = true;
    return { removedPlaintextPasswords: 0, removedRawOtps: 0 };
  }

  const [passwordResult, otpResult] = await Promise.all([
    UserModel.collection.updateMany(
      { plainPassword: { $exists: true } },
      { $unset: { plainPassword: '' } }
    ),
    OtpVerificationModel.collection.updateMany(
      { rawCodeDev: { $exists: true } },
      { $unset: { rawCodeDev: '' } }
    )
  ]);

  await SystemMigrationModel.updateOne(
    { key: migrationKey },
    {
      $setOnInsert: {
        key: migrationKey,
        appliedAt: new Date(),
        details: {
          removedPlaintextPasswords: passwordResult.modifiedCount,
          removedRawOtps: otpResult.modifiedCount
        }
      }
    },
    { upsert: true }
  );

  securityBaselineEnsured = true;

  if (passwordResult.modifiedCount > 0) {
    logger.warn('Security migration removed legacy plaintext password fields', {
      modifiedUsers: passwordResult.modifiedCount
    });
  }
  if (otpResult.modifiedCount > 0) {
    logger.warn('Security migration removed legacy development OTP fields', {
      modifiedOtps: otpResult.modifiedCount
    });
  }

  return {
    removedPlaintextPasswords: passwordResult.modifiedCount,
    removedRawOtps: otpResult.modifiedCount
  };
}
