import mongoose from 'mongoose';
import { UserModel } from '../models/User';
import { CommissionPolicyModel } from '../models/CommissionPolicy';
import { ReferralCommissionModel, IReferralCommission } from '../models/ReferralCommission';
import { WalletTransactionModel } from '../models/WalletTransaction';
import { UserRole } from '../shared/roles';
import { notificationService } from './notification.service';
import { walletService } from './wallet.service';
import { logger } from '../utils/logger';

export function normalizeCommissionRate(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric > 1 ? Math.round(numeric) / 100 : Math.round(numeric * 100) / 100;
}

export class CommissionService {
  /**
   * Awards the correct referral commission after a payment has been fully
   * verified and fulfilled. Never call this for pending/unverified payments.
   */
  async awardForPayment(payment: any, subscriptionId?: string): Promise<IReferralCommission | null> {
    const referrerId = payment.referredByModeratorId;
    if (!referrerId) return null;

    const [policy, referrer] = await Promise.all([
      CommissionPolicyModel.getActivePolicy(),
      UserModel.findById(referrerId)
    ]);

    if (!policy.referralEnabled) return null;
    if (!referrer || referrer.isDeleted || referrer.referralEligible === false) return null;
    if (referrer.accountStatus && referrer.accountStatus !== 'ACTIVE') return null;

    const isModerator = referrer.role === UserRole.MODERATOR;
    const commissionType =
      payment.referralCommissionTypeSnapshot ||
      referrer.referralCommissionType ||
      (isModerator ? 'LIFETIME' : 'ONE_TIME');

    const rate =
      typeof payment.commissionRateSnapshot === 'number'
        ? normalizeCommissionRate(payment.commissionRateSnapshot)
        : referrer.referralCommissionRate !== undefined
        ? normalizeCommissionRate(referrer.referralCommissionRate)
        : isModerator
        ? normalizeCommissionRate(policy.moderatorRate ?? policy.defaultRate ?? 0.5)
        : normalizeCommissionRate(policy.normalUserRate ?? 0.3);

    if (!(rate > 0)) return null;

    if (commissionType === 'ONE_TIME') {
      const existingOneTime = await ReferralCommissionModel.findOne({
        referredUserId: payment.userId,
        commissionType: 'ONE_TIME',
        status: { $ne: 'REVERSED' }
      }).select('_id');
      if (existingOneTime) return null;
    }

    const idempotencyKey =
      commissionType === 'ONE_TIME'
        ? `commission-first:${payment.userId.toString()}`
        : `commission-payment:${payment._id.toString()}`;

    const purchaseCents = Math.round(Number(payment.priceAmount || 0) * 100);
    if (purchaseCents <= 0) return null;
    const amountCents = Math.round(purchaseCents * rate);
    if (amountCents <= 0) return null;

    const commission = await ReferralCommissionModel.findOneAndUpdate(
      { idempotencyKey },
      {
        $setOnInsert: {
          moderatorId: referrer._id,
          referredUserId: payment.userId,
          subscriptionId: subscriptionId
            ? new mongoose.Types.ObjectId(subscriptionId)
            : payment.subscriptionId,
          paymentId: payment._id,
          purchaseId: payment.orderId,
          subscriptionPlan: payment.planId,
          originalPurchaseAmount: payment.priceAmount,
          commissionableAmount: payment.priceAmount,
          commissionRate: rate,
          amountUsd: amountCents / 100,
          referrerRole: referrer.role,
          commissionType,
          idempotencyKey,
          status: 'PENDING',
          notes:
            commissionType === 'ONE_TIME'
              ? 'One-time normal-user referral commission for the referred user’s first eligible purchase'
              : 'Lifetime moderator referral commission'
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (!commission) return null;

    // A reversed one-time commission is terminal. A later purchase by the same
    // referred customer must not silently re-credit it; an admin adjustment is
    // required for an exceptional correction.
    if (commission.status === 'REVERSED') return null;

    // A second worker may have created the same commission; wallet credit is
    // independently idempotent, and already-credited records are returned.
    if (commission.status === 'CREDITED' && commission.walletTransactionId) {
      return commission;
    }

    try {
      const existingWalletTx = await WalletTransactionModel.findOne({
        idempotencyKey: `commission-wallet:${commission._id}`
      });

      const walletTx =
        existingWalletTx ||
        (await walletService.credit({
          userId: referrer._id.toString(),
          amountCents,
          countAsCommission: true,
          context: {
            type: 'REFERRAL_COMMISSION',
            idempotencyKey: `commission-wallet:${commission._id}`,
            relatedUserId: payment.userId.toString(),
            relatedPaymentId: payment._id.toString(),
            relatedSubscriptionId: subscriptionId,
            relatedCommissionId: commission._id.toString(),
            reason:
              commissionType === 'ONE_TIME'
                ? '30% one-time referral commission'
                : 'Lifetime moderator referral commission'
          }
        }));

      commission.status = 'CREDITED';
      commission.walletTransactionId = walletTx._id as mongoose.Types.ObjectId;
      await commission.save();

      await notificationService.createNotification(
        referrer._id,
        'WALLET_UPDATE',
        'Referral Commission Earned',
        `You earned $${(amountCents / 100).toFixed(2)} from a verified referral purchase${
          commissionType === 'ONE_TIME' ? ' (one-time commission)' : ''
        }.`,
        '/dashboard?tab=wallet',
        {
          commissionId: commission._id.toString(),
          amountUsd: amountCents / 100,
          paymentId: payment.orderId
        }
      ).catch(() => null);

      return commission;
    } catch (error: any) {
      logger.error('Referral commission created but wallet credit failed', {
        commissionId: commission._id.toString(),
        referrerId: referrer._id.toString(),
        error: error?.message
      });
      return commission;
    }
  }

  async reversePaymentCommissions(paymentId: string, reason: string): Promise<void> {
    const commissions = await ReferralCommissionModel.find({
      paymentId: new mongoose.Types.ObjectId(paymentId),
      status: { $ne: 'REVERSED' }
    });

    for (const commission of commissions) {
      await walletService.reverseCommission({
        commissionId: commission._id.toString(),
        reason
      });
    }
  }
}

export const commissionService = new CommissionService();
