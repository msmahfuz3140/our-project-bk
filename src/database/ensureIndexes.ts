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
import { EmailNotificationModel } from '../models/EmailNotification';
import { AdminTwoFactorModel } from '../models/AdminTwoFactor';
import { AdminRecoveryCodeModel } from '../models/AdminRecoveryCode';
import { AdminTwoFactorChallengeModel } from '../models/AdminTwoFactorChallenge';
import { SystemMigrationModel } from '../models/SystemMigration';
import { resolveWithdrawalMethod } from '../shared/withdrawalMethods';
import { generateRandomString } from '../utils/crypto';
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
      EmailNotificationModel.createIndexes(),
      AdminTwoFactorModel.createIndexes(),
      AdminRecoveryCodeModel.createIndexes(),
      AdminTwoFactorChallengeModel.createIndexes(),
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

/**
 * Safe, idempotent data migration for the referral/verification/withdrawal
 * release. It only fills missing optional fields and never rewrites business
 * history, balances, commissions, or referral relationships.
 */
export async function ensureTrustAndPayoutMigration(): Promise<{
  withdrawalMethodsBackfilled: number;
  verifiedTimestampsBackfilled: number;
}> {
  if (mongoose.connection.readyState !== 1) {
    return { withdrawalMethodsBackfilled: 0, verifiedTimestampsBackfilled: 0 };
  }

  const migrationKey = '2026-11-referral-verification-payout-v1';
  const existing = await SystemMigrationModel.findOne({ key: migrationKey }).lean();
  if (existing) {
    return { withdrawalMethodsBackfilled: 0, verifiedTimestampsBackfilled: 0 };
  }

  let withdrawalMethodsBackfilled = 0;
  const legacyWithdrawals = await WithdrawalRequestModel.find({
    $or: [
      { withdrawalCurrency: { $exists: false } },
      { networkId: { $exists: false } }
    ]
  })
    .select('_id network withdrawalCurrency networkId')
    .lean();

  for (const withdrawal of legacyWithdrawals as any[]) {
    const method = resolveWithdrawalMethod({ network: withdrawal.network });
    if (!method) continue;
    await WithdrawalRequestModel.updateOne(
      { _id: withdrawal._id },
      {
        $set: {
          withdrawalCurrency: withdrawal.withdrawalCurrency || method.currency,
          networkId: withdrawal.networkId || method.id,
          network: method.network
        }
      }
    );
    withdrawalMethodsBackfilled += 1;
  }

  const verifiedUsers = await UserModel.find({
    isEmailVerified: true,
    emailVerifiedAt: { $exists: false }
  })
    .select('_id updatedAt createdAt')
    .lean();

  let verifiedTimestampsBackfilled = 0;
  for (const user of verifiedUsers as any[]) {
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { emailVerifiedAt: user.updatedAt || user.createdAt || new Date() } }
    );
    verifiedTimestampsBackfilled += 1;
  }

  await SystemMigrationModel.updateOne(
    { key: migrationKey },
    {
      $setOnInsert: {
        key: migrationKey,
        appliedAt: new Date(),
        details: { withdrawalMethodsBackfilled, verifiedTimestampsBackfilled }
      }
    },
    { upsert: true }
  );

  if (withdrawalMethodsBackfilled || verifiedTimestampsBackfilled) {
    logger.info('Applied referral/verification/payout data migration', {
      withdrawalMethodsBackfilled,
      verifiedTimestampsBackfilled
    });
  }

  return { withdrawalMethodsBackfilled, verifiedTimestampsBackfilled };
}

/**
 * Records the Admin 2FA rollout marker. Existing administrators are NOT marked
 * as 2FA-enabled; they must complete setup on their next login. The marker only
 * documents how many admin accounts require enrollment at deployment time.
 */
export async function ensureAdminTwoFactorRolloutMarker(): Promise<{
  adminAccountsAtRollout: number;
}> {
  if (mongoose.connection.readyState !== 1) {
    return { adminAccountsAtRollout: 0 };
  }

  const migrationKey = '2026-11-admin-2fa-mandatory-v1';
  const existing = await SystemMigrationModel.findOne({ key: migrationKey }).lean();
  if (existing) {
    return {
      adminAccountsAtRollout: Number((existing as any)?.details?.adminAccountsAtRollout || 0)
    };
  }

  const adminAccountsAtRollout = await UserModel.countDocuments({
    role: 'SUPER_ADMIN',
    isDeleted: { $ne: true }
  });

  await SystemMigrationModel.updateOne(
    { key: migrationKey },
    {
      $setOnInsert: {
        key: migrationKey,
        appliedAt: new Date(),
        details: {
          adminAccountsAtRollout,
          requiredEnrollment: true,
          note: 'Existing admins are not auto-enabled; each must complete TOTP setup on next login.'
        }
      }
    },
    { upsert: true }
  );

  logger.info('Admin 2FA rollout marker applied', { adminAccountsAtRollout });
  return { adminAccountsAtRollout };
}

/**
 * Backfills missing referral codes for existing accounts (especially older
 * admin accounts). Every active account must have a shareable code. The
 * migration is idempotent and does not change existing codes or attribution.
 */
export async function ensureMissingReferralCodes(): Promise<{ backfilled: number }> {
  if (mongoose.connection.readyState !== 1) {
    return { backfilled: 0 };
  }

  const migrationKey = '2026-11-referral-code-backfill-v1';
  const existing = await SystemMigrationModel.findOne({ key: migrationKey }).lean();
  if (existing) {
    return { backfilled: Number((existing as any)?.details?.backfilled || 0) };
  }

  const users = await UserModel.find({
    isDeleted: { $ne: true },
    $or: [
      { referralCode: { $exists: false } },
      { referralCode: null },
      { referralCode: '' }
    ]
  })
    .select('_id role')
    .limit(10000)
    .lean();

  let backfilled = 0;
  for (const user of users as any[]) {
    const prefix = user.role === 'SUPER_ADMIN' ? 'ADMIN-' : 'REF-';
    let code = '';
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = `${prefix}${generateRandomString(8).toUpperCase()}`;
      const exists = await UserModel.exists({ referralCode: candidate });
      if (!exists) {
        code = candidate;
        break;
      }
    }
    if (!code) continue;
    await UserModel.updateOne(
      {
        _id: user._id,
        $or: [
          { referralCode: { $exists: false } },
          { referralCode: null },
          { referralCode: '' }
        ]
      },
      { $set: { referralCode: code } }
    );
    backfilled += 1;
  }

  await SystemMigrationModel.updateOne(
    { key: migrationKey },
    {
      $setOnInsert: {
        key: migrationKey,
        appliedAt: new Date(),
        details: { backfilled }
      }
    },
    { upsert: true }
  );

  if (backfilled > 0) {
    logger.info('Backfilled missing referral codes', { backfilled });
  }
  return { backfilled };
}
