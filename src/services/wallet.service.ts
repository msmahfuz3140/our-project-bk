import mongoose from 'mongoose';
import { WalletModel, IWallet } from '../models/Wallet';
import {
  WalletTransactionModel,
  IWalletTransaction,
  WalletTransactionType
} from '../models/WalletTransaction';
import { WithdrawalRequestModel, IWithdrawalRequest, WithdrawalStatus } from '../models/WithdrawalRequest';
import { UserModel } from '../models/User';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { CommissionPolicyModel } from '../models/CommissionPolicy';
import { AuditLogModel } from '../models/AuditLog';
import { ApiError } from '../utils/apiError';
import { env } from '../config/env';
import { generateRandomString } from '../utils/crypto';
import { notificationService } from './notification.service';
import { logger } from '../utils/logger';

function nowId(prefix: string): string {
  return `${prefix}_${Date.now()}_${generateRandomString(8).toUpperCase()}`;
}

function toCents(amountUsd: number): number {
  return Math.round(Number(amountUsd) * 100);
}

export interface WalletOperationContext {
  type: WalletTransactionType;
  idempotencyKey: string;
  relatedUserId?: string;
  relatedPaymentId?: string;
  relatedSubscriptionId?: string;
  relatedCommissionId?: string;
  relatedWithdrawalId?: string;
  adminId?: string;
  adminEmail?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export class WalletService {
  async ensureWallet(userId: string | mongoose.Types.ObjectId): Promise<IWallet> {
    const userObjectId = new mongoose.Types.ObjectId(userId.toString());
    const wallet = await WalletModel.findOneAndUpdate(
      { userId: userObjectId },
      {
        $setOnInsert: {
          userId: userObjectId,
          currency: 'USD',
          availableBalanceCents: 0,
          reservedWithdrawalCents: 0,
          lifetimeCommissionCents: 0,
          totalWithdrawnCents: 0
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return wallet!;
  }

  private async findOrCreatePendingTransaction(params: {
    userId: string;
    amountCents: number;
    context: WalletOperationContext;
  }): Promise<{ transaction: IWalletTransaction; existing: boolean }> {
    const existing = await WalletTransactionModel.findOne({
      idempotencyKey: params.context.idempotencyKey
    });
    if (existing) {
      if (existing.status === 'COMPLETED') {
        return { transaction: existing, existing: true };
      }
      if (existing.status === 'PENDING') {
        throw ApiError.conflict('This financial operation is already processing.');
      }
      throw ApiError.conflict('This financial operation was already rejected.');
    }

    const transaction = await WalletTransactionModel.create({
      transactionId: nowId('WLT'),
      idempotencyKey: params.context.idempotencyKey,
      userId: new mongoose.Types.ObjectId(params.userId),
      type: params.context.type,
      amountCents: params.amountCents,
      currency: 'USD',
      previousAvailableCents: 0,
      newAvailableCents: 0,
      previousReservedCents: 0,
      newReservedCents: 0,
      status: 'PENDING',
      relatedUserId: params.context.relatedUserId
        ? new mongoose.Types.ObjectId(params.context.relatedUserId)
        : undefined,
      relatedPaymentId: params.context.relatedPaymentId
        ? new mongoose.Types.ObjectId(params.context.relatedPaymentId)
        : undefined,
      relatedSubscriptionId: params.context.relatedSubscriptionId
        ? new mongoose.Types.ObjectId(params.context.relatedSubscriptionId)
        : undefined,
      relatedCommissionId: params.context.relatedCommissionId
        ? new mongoose.Types.ObjectId(params.context.relatedCommissionId)
        : undefined,
      relatedWithdrawalId: params.context.relatedWithdrawalId
        ? new mongoose.Types.ObjectId(params.context.relatedWithdrawalId)
        : undefined,
      adminId: params.context.adminId ? new mongoose.Types.ObjectId(params.context.adminId) : undefined,
      adminEmail: params.context.adminEmail,
      reason: params.context.reason,
      metadata: params.context.metadata
    });

    return { transaction, existing: false };
  }

  private async finalizeTransaction(
    transaction: IWalletTransaction,
    wallet: IWallet,
    previousAvailableCents: number,
    previousReservedCents: number
  ): Promise<IWalletTransaction> {
    transaction.previousAvailableCents = previousAvailableCents;
    transaction.newAvailableCents = wallet.availableBalanceCents;
    transaction.previousReservedCents = previousReservedCents;
    transaction.newReservedCents = wallet.reservedWithdrawalCents;
    transaction.status = 'COMPLETED';
    await transaction.save();
    return transaction;
  }

  async credit(params: {
    userId: string;
    amountCents: number;
    countAsCommission?: boolean;
    context: WalletOperationContext;
  }): Promise<IWalletTransaction> {
    if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
      throw ApiError.badRequest('Credit amount must be a positive integer in cents');
    }

    const { transaction, existing } = await this.findOrCreatePendingTransaction({
      userId: params.userId,
      amountCents: params.amountCents,
      context: params.context
    });
    if (existing) return transaction;

    const userObjectId = new mongoose.Types.ObjectId(params.userId);
    await this.ensureWallet(userObjectId);

    const updated = await WalletModel.findOneAndUpdate(
      { userId: userObjectId },
      {
        $inc: {
          availableBalanceCents: params.amountCents,
          ...(params.countAsCommission ? { lifetimeCommissionCents: params.amountCents } : {})
        },
        $set: { currency: 'USD' }
      },
      { new: true }
    );

    if (!updated) {
      transaction.status = 'FAILED';
      await transaction.save().catch(() => null);
      throw ApiError.internal('Wallet could not be updated');
    }

    const previousAvailableCents = updated.availableBalanceCents - params.amountCents;
    const previousReservedCents = updated.reservedWithdrawalCents;

    return this.finalizeTransaction(transaction, updated, previousAvailableCents, previousReservedCents);
  }

  private async debitAvailable(params: {
    userId: string;
    amountCents: number;
    reserveForWithdrawal?: boolean;
    context: WalletOperationContext;
  }): Promise<IWalletTransaction> {
    if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
      throw ApiError.badRequest('Debit amount must be a positive integer in cents');
    }

    const { transaction, existing } = await this.findOrCreatePendingTransaction({
      userId: params.userId,
      amountCents: -params.amountCents,
      context: params.context
    });
    if (existing) return transaction;

    const userObjectId = new mongoose.Types.ObjectId(params.userId);
    await this.ensureWallet(userObjectId);

    const updated = await WalletModel.findOneAndUpdate(
      {
        userId: userObjectId,
        availableBalanceCents: { $gte: params.amountCents }
      },
      {
        $inc: {
          availableBalanceCents: -params.amountCents,
          ...(params.reserveForWithdrawal
            ? { reservedWithdrawalCents: params.amountCents }
            : {})
        }
      },
      { new: true }
    );

    if (!updated) {
      transaction.status = 'REJECTED';
      await transaction.save().catch(() => null);
      throw ApiError.badRequest('Insufficient available wallet balance');
    }

    const previousAvailableCents = updated.availableBalanceCents + params.amountCents;
    const previousReservedCents = params.reserveForWithdrawal
      ? updated.reservedWithdrawalCents - params.amountCents
      : updated.reservedWithdrawalCents;

    return this.finalizeTransaction(transaction, updated, previousAvailableCents, previousReservedCents);
  }

  async reserveForWithdrawal(params: {
    userId: string;
    withdrawalId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<IWalletTransaction> {
    return this.debitAvailable({
      userId: params.userId,
      amountCents: params.amountCents,
      reserveForWithdrawal: true,
      context: {
        type: 'WITHDRAWAL_RESERVE',
        idempotencyKey: params.idempotencyKey,
        relatedWithdrawalId: params.withdrawalId,
        reason: 'Withdrawal amount reserved from available balance'
      }
    });
  }

  async refundWithdrawal(params: {
    userId: string;
    withdrawalId: string;
    amountCents: number;
  }): Promise<IWalletTransaction> {
    const idempotencyKey = `withdrawal-refund:${params.withdrawalId}`;
    const existing = await WalletTransactionModel.findOne({ idempotencyKey });
    if (existing?.status === 'COMPLETED') return existing;

    const transaction = await WalletTransactionModel.create({
      transactionId: nowId('WLT'),
      idempotencyKey,
      userId: new mongoose.Types.ObjectId(params.userId),
      type: 'WITHDRAWAL_REFUND',
      amountCents: params.amountCents,
      currency: 'USD',
      previousAvailableCents: 0,
      newAvailableCents: 0,
      previousReservedCents: 0,
      newReservedCents: 0,
      status: 'PENDING',
      relatedWithdrawalId: new mongoose.Types.ObjectId(params.withdrawalId),
      reason: 'Withdrawal rejected — reserved amount returned'
    });

    const userObjectId = new mongoose.Types.ObjectId(params.userId);
    const updated = await WalletModel.findOneAndUpdate(
      {
        userId: userObjectId,
        reservedWithdrawalCents: { $gte: params.amountCents }
      },
      {
        $inc: {
          reservedWithdrawalCents: -params.amountCents,
          availableBalanceCents: params.amountCents
        }
      },
      { new: true }
    );

    if (!updated) {
      transaction.status = 'FAILED';
      await transaction.save().catch(() => null);
      throw ApiError.conflict('Withdrawal reservation is no longer available to refund');
    }

    return this.finalizeTransaction(
      transaction,
      updated,
      updated.availableBalanceCents - params.amountCents,
      updated.reservedWithdrawalCents + params.amountCents
    );
  }

  async completeWithdrawal(params: {
    userId: string;
    withdrawalId: string;
    amountCents: number;
  }): Promise<IWalletTransaction> {
    const idempotencyKey = `withdrawal-paid:${params.withdrawalId}`;
    const existing = await WalletTransactionModel.findOne({ idempotencyKey });
    if (existing?.status === 'COMPLETED') return existing;

    const transaction = await WalletTransactionModel.create({
      transactionId: nowId('WLT'),
      idempotencyKey,
      userId: new mongoose.Types.ObjectId(params.userId),
      type: 'WITHDRAWAL_PAID',
      amountCents: 0,
      currency: 'USD',
      previousAvailableCents: 0,
      newAvailableCents: 0,
      previousReservedCents: 0,
      newReservedCents: 0,
      status: 'PENDING',
      relatedWithdrawalId: new mongoose.Types.ObjectId(params.withdrawalId),
      reason: 'Withdrawal paid/completed; reserved amount converted to total withdrawn'
    });

    const userObjectId = new mongoose.Types.ObjectId(params.userId);
    const updated = await WalletModel.findOneAndUpdate(
      {
        userId: userObjectId,
        reservedWithdrawalCents: { $gte: params.amountCents }
      },
      {
        $inc: {
          reservedWithdrawalCents: -params.amountCents,
          totalWithdrawnCents: params.amountCents
        }
      },
      { new: true }
    );

    if (!updated) {
      transaction.status = 'FAILED';
      await transaction.save().catch(() => null);
      throw ApiError.conflict('Withdrawal reservation is no longer available');
    }

    return this.finalizeTransaction(
      transaction,
      updated,
      updated.availableBalanceCents,
      updated.reservedWithdrawalCents + params.amountCents
    );
  }

  async recordWithdrawalApproval(params: {
    userId: string;
    withdrawalId: string;
    adminId: string;
    adminEmail: string;
    note?: string;
  }): Promise<void> {
    const idempotencyKey = `withdrawal-approved:${params.withdrawalId}`;
    const existing = await WalletTransactionModel.findOne({ idempotencyKey });
    if (existing) return;
    const wallet = await this.ensureWallet(params.userId);
    await WalletTransactionModel.create({
      transactionId: nowId('WLT'),
      idempotencyKey,
      userId: new mongoose.Types.ObjectId(params.userId),
      type: 'WITHDRAWAL_APPROVED',
      amountCents: 0,
      currency: 'USD',
      previousAvailableCents: wallet.availableBalanceCents,
      newAvailableCents: wallet.availableBalanceCents,
      previousReservedCents: wallet.reservedWithdrawalCents,
      newReservedCents: wallet.reservedWithdrawalCents,
      status: 'COMPLETED',
      relatedWithdrawalId: new mongoose.Types.ObjectId(params.withdrawalId),
      adminId: new mongoose.Types.ObjectId(params.adminId),
      adminEmail: params.adminEmail,
      reason: params.note || 'Withdrawal request approved; amount remains reserved until payment is sent'
    });
  }

  async adjustBalance(params: {
    userId: string;
    direction: 'ADD' | 'DEDUCT';
    amountCents: number;
    reason: string;
    adminId: string;
    adminEmail: string;
    idempotencyKey?: string;
  }): Promise<IWalletTransaction> {
    if (!params.reason || params.reason.trim().length < 3) {
      throw ApiError.badRequest('A clear reason is required for manual wallet adjustments');
    }

    const key = params.idempotencyKey || nowId('ADJ');
    let transaction: IWalletTransaction;
    if (params.direction === 'ADD') {
      transaction = await this.credit({
        userId: params.userId,
        amountCents: params.amountCents,
        countAsCommission: false,
        context: {
          type: 'MANUAL_BALANCE_ADD',
          idempotencyKey: key,
          adminId: params.adminId,
          adminEmail: params.adminEmail,
          reason: params.reason.trim()
        }
      });
    } else {
      transaction = await this.debitAvailable({
        userId: params.userId,
        amountCents: params.amountCents,
        context: {
          type: 'MANUAL_BALANCE_DEDUCT',
          idempotencyKey: key,
          adminId: params.adminId,
          adminEmail: params.adminEmail,
          reason: params.reason.trim()
        }
      });
    }

    const targetUser = await UserModel.findById(params.userId).select('email').lean<any>();
    await AuditLogModel.create({
      action: 'WALLET_MANUAL_ADJUST',
      adminId: new mongoose.Types.ObjectId(params.adminId),
      adminEmail: params.adminEmail,
      targetUserId: new mongoose.Types.ObjectId(params.userId),
      targetUserEmail: targetUser?.email,
      reason: params.reason.trim(),
      previousValue: { availableBalanceCents: transaction.previousAvailableCents },
      newValue: {
        availableBalanceCents: transaction.newAvailableCents,
        amountCents:
          params.direction === 'ADD' ? params.amountCents : -params.amountCents,
        transactionId: transaction.transactionId
      }
    }).catch(() => null);

    return transaction;
  }

  async reverseCommission(params: {
    commissionId: string;
    reason: string;
    adminId?: string;
    adminEmail?: string;
  }): Promise<void> {
    const commission = await ReferralCommissionModel.findById(params.commissionId);
    if (!commission || commission.status === 'REVERSED') return;

    const previousStatus = commission.status;
    commission.status = 'REVERSED';
    commission.reversalDetails = {
      reversedAt: new Date(),
      reversedByAdminId: params.adminId ? new mongoose.Types.ObjectId(params.adminId) : undefined,
      reversedByAdminEmail: params.adminEmail,
      reason: params.reason
    };
    await commission.save();

    const walletCredit = await WalletTransactionModel.findOne({
      idempotencyKey: `commission-wallet:${commission._id}`
    });
    if (walletCredit?.status === 'COMPLETED') {
      const amount = Math.abs(walletCredit.amountCents);
      const wallet = await this.ensureWallet(commission.moderatorId);
      const deductible = Math.min(amount, wallet.availableBalanceCents);
      if (deductible > 0) {
        try {
          await this.debitAvailable({
            userId: commission.moderatorId.toString(),
            amountCents: deductible,
            context: {
              type: 'COMMISSION_REVERSAL',
              idempotencyKey: `commission-reversal:${commission._id}`,
              relatedCommissionId: commission._id.toString(),
              relatedPaymentId: commission.paymentId?.toString(),
              adminId: params.adminId,
              adminEmail: params.adminEmail,
              reason: params.reason,
              metadata: { originalStatus: previousStatus, shortfallCents: amount - deductible }
            }
          });
        } catch (error: any) {
          logger.warn('Commission wallet reversal could not debit available balance', {
            commissionId: commission._id.toString(),
            error: error?.message
          });
        }
      }
    }
  }

  async getSummary(userId: string, options: { transactionPage?: number; transactionLimit?: number } = {}) {
    const wallet = await this.ensureWallet(userId);
    const user = await UserModel.findById(userId).select(
      'name email referralCode referredBy referralCommissionRate referralCommissionType referralEligible role'
    );
    if (!user) throw ApiError.notFound('User not found');

    if (!user.referralCode) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = `REF-${generateRandomString(8).toUpperCase()}`;
        const exists = await UserModel.exists({ referralCode: candidate });
        if (!exists) {
          user.referralCode = candidate;
          await user.save();
          break;
        }
      }
    }

    const page = Math.max(1, options.transactionPage || 1);
    const limit = Math.min(100, Math.max(1, options.transactionLimit || 25));

    const [policy, totalReferredUsers, commissions, transactions, totalTransactions, withdrawals] =
      await Promise.all([
        CommissionPolicyModel.getActivePolicy(),
        UserModel.countDocuments({ referredBy: user._id, isDeleted: { $ne: true } }),
        ReferralCommissionModel.find({
          moderatorId: user._id,
          status: { $in: ['CREDITED', 'APPROVED', 'ELIGIBLE'] }
        })
          .select('amountUsd status commissionType createdAt referredUserId')
          .lean(),
        WalletTransactionModel.find({ userId: user._id })
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        WalletTransactionModel.countDocuments({ userId: user._id }),
        WithdrawalRequestModel.find({ userId: user._id }).sort({ createdAt: -1 }).limit(20).lean()
      ]);

    const totalCommissionEarnedCents = commissions.reduce(
      (sum, item) => sum + Math.round((item.amountUsd || 0) * 100),
      0
    );
    const successfulReferrals = new Set(
      commissions.map((item) => item.referredUserId?.toString()).filter(Boolean)
    ).size;

    const commissionType =
      user.referralCommissionType ||
      (user.role === 'MODERATOR' ? 'LIFETIME' : policy.normalUserCommissionType || 'ONE_TIME');
    const commissionRate =
      user.referralCommissionRate ??
      (user.role === 'MODERATOR'
        ? policy.moderatorRate ?? policy.defaultRate ?? 0.5
        : policy.normalUserRate ?? 0.3);

    const origin = (env.PUBLIC_WEBSITE_URL || 'https://www.accuracy.tools').replace(/\/$/, '');

    return {
      wallet: {
        availableBalanceCents: wallet.availableBalanceCents,
        reservedWithdrawalCents: wallet.reservedWithdrawalCents,
        totalWalletBalanceCents: wallet.availableBalanceCents + wallet.reservedWithdrawalCents,
        lifetimeCommissionCents: wallet.lifetimeCommissionCents,
        totalCommissionEarnedCents,
        totalWithdrawnCents: wallet.totalWithdrawnCents
      },
      referral: {
        code: user.referralCode,
        link: user.referralCode ? `${origin}/gerister?ref=${user.referralCode}` : '',
        totalReferredUsers,
        successfulReferrals,
        commissionRate,
        commissionType,
        referralEligible: user.referralEligible !== false,
        referralEnabled: policy.referralEnabled !== false
      },
      withdrawals,
      transactions,
      transactionPagination: {
        page,
        limit,
        total: totalTransactions,
        totalPages: Math.max(1, Math.ceil(totalTransactions / limit))
      }
    };
  }

  async listTransactions(userId: string, options: {
    page?: number;
    limit?: number;
    type?: string;
    status?: string;
  }) {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 25));
    const query: Record<string, any> = { userId: new mongoose.Types.ObjectId(userId) };
    if (options.type && options.type !== 'ALL') query.type = options.type;
    if (options.status && options.status !== 'ALL') query.status = options.status;

    const [transactions, total] = await Promise.all([
      WalletTransactionModel.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      WalletTransactionModel.countDocuments(query)
    ]);

    return { transactions, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async createWithdrawal(userId: string, input: {
    amountCents?: number;
    amountUsd?: number;
    walletAddress: string;
    network: string;
    idempotencyKey?: string;
  }): Promise<IWithdrawalRequest> {
    const amountCents =
      input.amountCents !== undefined ? Math.round(Number(input.amountCents)) : toCents(input.amountUsd || 0);

    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw ApiError.badRequest('Withdrawal amount must be greater than zero');
    }
    if (!input.walletAddress || input.walletAddress.trim().length < 8) {
      throw ApiError.badRequest('A valid receiving wallet address is required');
    }
    if (!input.network || input.network.trim().length < 2) {
      throw ApiError.badRequest('Receiving payment network is required');
    }

    const user = await UserModel.findById(userId);
    if (!user || user.isDeleted) throw ApiError.notFound('User not found');

    const idempotencyKey = input.idempotencyKey?.trim() || nowId('WDR');
    const existing = await WithdrawalRequestModel.findOne({ idempotencyKey });
    if (existing) {
      if (existing.userId.toString() !== userId) {
        throw ApiError.conflict('Withdrawal idempotency key belongs to another account');
      }
      return existing;
    }

    const recentDuplicate = await WithdrawalRequestModel.findOne({
      userId: user._id,
      amountCents,
      walletAddress: input.walletAddress.trim(),
      status: { $in: ['PENDING', 'APPROVED'] },
      createdAt: { $gte: new Date(Date.now() - 30_000) }
    });
    if (recentDuplicate) {
      throw ApiError.conflict('A matching withdrawal request was already submitted');
    }

    const withdrawal = await WithdrawalRequestModel.create({
      requestId: nowId('WDR'),
      idempotencyKey,
      userId: user._id,
      amountCents,
      currency: 'USD',
      walletAddress: input.walletAddress.trim(),
      network: input.network.trim().toUpperCase(),
      status: 'PENDING'
    });

    try {
      await this.reserveForWithdrawal({
        userId,
        withdrawalId: withdrawal._id.toString(),
        amountCents,
        idempotencyKey: `withdrawal-reserve:${withdrawal._id}`
      });
    } catch (error) {
      withdrawal.status = 'REJECTED';
      withdrawal.rejectionReason = 'Insufficient available balance at submission';
      withdrawal.rejectedAt = new Date();
      await withdrawal.save().catch(() => null);
      throw error;
    }

    await notificationService.createNotification(
      user._id,
      'WITHDRAWAL_UPDATE',
      'Withdrawal Request Submitted',
      `Your withdrawal request for $${(amountCents / 100).toFixed(2)} is pending admin review.`,
      '/dashboard?tab=wallet'
    ).catch(() => null);

    return withdrawal;
  }

  async listUserWithdrawals(userId: string, page = 1, limit = 20) {
    const cleanPage = Math.max(1, page);
    const cleanLimit = Math.min(100, Math.max(1, limit));
    const [withdrawals, total] = await Promise.all([
      WithdrawalRequestModel.find({ userId })
        .sort({ createdAt: -1 })
        .skip((cleanPage - 1) * cleanLimit)
        .limit(cleanLimit)
        .lean(),
      WithdrawalRequestModel.countDocuments({ userId })
    ]);
    return { withdrawals, total, page: cleanPage, totalPages: Math.max(1, Math.ceil(total / cleanLimit)) };
  }

  private async getWithdrawalOrThrow(id: string) {
    const withdrawal = await WithdrawalRequestModel.findById(id).populate('userId', 'name email role');
    if (!withdrawal) throw ApiError.notFound('Withdrawal request not found');
    return withdrawal;
  }

  async approveWithdrawal(adminId: string, adminEmail: string, id: string, note?: string) {
    const withdrawal = await this.getWithdrawalOrThrow(id);
    if (withdrawal.status === 'APPROVED') return withdrawal;
    if (withdrawal.status === 'PAID') throw ApiError.conflict('Withdrawal is already paid');
    if (withdrawal.status === 'REJECTED') throw ApiError.conflict('Withdrawal was already rejected');

    const updated = await WithdrawalRequestModel.findOneAndUpdate(
      { _id: withdrawal._id, status: 'PENDING' },
      {
        $set: {
          status: 'APPROVED',
          adminNote: note?.trim(),
          reviewedByAdminId: new mongoose.Types.ObjectId(adminId),
          reviewedByAdminEmail: adminEmail,
          reviewedAt: new Date()
        }
      },
      { new: true }
    );
    if (!updated) throw ApiError.conflict('Withdrawal request is no longer pending');

    await this.recordWithdrawalApproval({
      userId: updated.userId.toString(),
      withdrawalId: updated._id.toString(),
      adminId,
      adminEmail,
      note: note?.trim()
    });

    await notificationService.createNotification(
      updated.userId,
      'WITHDRAWAL_UPDATE',
      'Withdrawal Approved',
      'Your withdrawal request has been approved. The reserved amount remains pending until the payment is marked as sent.',
      '/dashboard?tab=wallet'
    ).catch(() => null);

    await AuditLogModel.create({
      action: 'WITHDRAWAL_APPROVE',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetUserId: updated.userId,
      targetResourceId: updated.requestId,
      resourceType: 'WithdrawalRequest',
      reason: note?.trim() || 'Withdrawal request approved',
      newValue: { status: 'APPROVED', amountCents: updated.amountCents }
    }).catch(() => null);

    return updated;
  }

  async rejectWithdrawal(adminId: string, adminEmail: string, id: string, reason: string) {
    if (!reason || reason.trim().length < 3) {
      throw ApiError.badRequest('A rejection reason is required');
    }
    const withdrawal = await this.getWithdrawalOrThrow(id);
    if (withdrawal.status === 'PAID') throw ApiError.conflict('A paid withdrawal cannot be rejected');
    if (withdrawal.status === 'REJECTED') {
      await this.refundWithdrawal({
        userId: withdrawal.userId.toString(),
        withdrawalId: withdrawal._id.toString(),
        amountCents: withdrawal.amountCents
      });
      return withdrawal;
    }

    const updated = await WithdrawalRequestModel.findOneAndUpdate(
      { _id: withdrawal._id, status: { $in: ['PENDING', 'APPROVED'] } },
      {
        $set: {
          status: 'REJECTED',
          adminNote: reason.trim(),
          rejectionReason: reason.trim(),
          reviewedByAdminId: new mongoose.Types.ObjectId(adminId),
          reviewedByAdminEmail: adminEmail,
          reviewedAt: new Date(),
          rejectedAt: new Date()
        }
      },
      { new: true }
    );
    if (!updated) throw ApiError.conflict('Withdrawal request is no longer reviewable');

    await this.refundWithdrawal({
      userId: updated.userId.toString(),
      withdrawalId: updated._id.toString(),
      amountCents: updated.amountCents
    });

    await notificationService.createNotification(
      updated.userId,
      'WITHDRAWAL_UPDATE',
      'Withdrawal Rejected — Amount Refunded',
      `Your withdrawal request was rejected. The reserved amount of $${(updated.amountCents / 100).toFixed(2)} has been returned to your available wallet balance. Reason: ${reason.trim()}`,
      '/dashboard?tab=wallet'
    ).catch(() => null);

    await AuditLogModel.create({
      action: 'WITHDRAWAL_REJECT',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetUserId: updated.userId,
      targetResourceId: updated.requestId,
      resourceType: 'WithdrawalRequest',
      reason: reason.trim(),
      previousValue: { status: withdrawal.status },
      newValue: { status: 'REJECTED', amountCents: updated.amountCents }
    }).catch(() => null);

    return updated;
  }

  async markWithdrawalPaid(adminId: string, adminEmail: string, id: string, transactionHash?: string) {
    const withdrawal = await this.getWithdrawalOrThrow(id);
    if (withdrawal.status === 'PAID') {
      await this.completeWithdrawal({
        userId: withdrawal.userId.toString(),
        withdrawalId: withdrawal._id.toString(),
        amountCents: withdrawal.amountCents
      });
      return withdrawal;
    }
    if (withdrawal.status !== 'APPROVED') {
      throw ApiError.conflict('Withdrawal must be approved before it can be marked paid');
    }

    const updated = await WithdrawalRequestModel.findOneAndUpdate(
      { _id: withdrawal._id, status: 'APPROVED' },
      {
        $set: {
          status: 'PAID',
          transactionHash: transactionHash?.trim(),
          reviewedByAdminId: new mongoose.Types.ObjectId(adminId),
          reviewedByAdminEmail: adminEmail,
          paidAt: new Date()
        }
      },
      { new: true }
    );
    if (!updated) throw ApiError.conflict('Withdrawal is no longer approved');

    await this.completeWithdrawal({
      userId: updated.userId.toString(),
      withdrawalId: updated._id.toString(),
      amountCents: updated.amountCents
    });

    await notificationService.createNotification(
      updated.userId,
      'WITHDRAWAL_UPDATE',
      'Withdrawal Paid',
      `Your withdrawal request has been completed. Payment of $${(updated.amountCents / 100).toFixed(2)} has been sent to your wallet.${transactionHash ? ` Transaction hash: ${transactionHash}` : ''}`,
      '/dashboard?tab=wallet'
    ).catch(() => null);

    await AuditLogModel.create({
      action: 'WITHDRAWAL_PAID',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetUserId: updated.userId,
      targetResourceId: updated.requestId,
      resourceType: 'WithdrawalRequest',
      reason: 'Withdrawal marked paid/completed',
      newValue: {
        status: 'PAID',
        amountCents: updated.amountCents,
        transactionHash: transactionHash?.trim()
      }
    }).catch(() => null);

    return updated;
  }

  async adminListWithdrawals(options: {
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 25));
    const query: Record<string, any> = {};

    if (options.status && options.status !== 'ALL') query.status = options.status;

    if (options.search && options.search.trim()) {
      const escaped = options.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      const users = await UserModel.find({ $or: [{ name: regex }, { email: regex }] }).select('_id').lean();
      query.$or = [
        { requestId: regex },
        { walletAddress: regex },
        { transactionHash: regex },
        { userId: { $in: users.map((u) => u._id) } }
      ];
    }

    const [withdrawals, total] = await Promise.all([
      WithdrawalRequestModel.find(query)
        .populate('userId', 'name email phone role accountStatus')
        .populate('reviewedByAdminId', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      WithdrawalRequestModel.countDocuments(query)
    ]);

    return { withdrawals, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async adminListTransactions(options: {
    search?: string;
    type?: string;
    status?: string;
    userId?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 25));
    const query: Record<string, any> = {};

    if (options.type && options.type !== 'ALL') query.type = options.type;
    if (options.status && options.status !== 'ALL') query.status = options.status;
    if (options.userId) query.userId = new mongoose.Types.ObjectId(options.userId);
    if (options.startDate || options.endDate) {
      query.createdAt = {};
      if (options.startDate) query.createdAt.$gte = new Date(options.startDate);
      if (options.endDate) query.createdAt.$lte = new Date(options.endDate);
    }
    if (options.search && options.search.trim()) {
      const escaped = options.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      const users = await UserModel.find({ $or: [{ name: regex }, { email: regex }] }).select('_id').lean();
      query.$or = [
        { transactionId: regex },
        { idempotencyKey: regex },
        { reason: regex },
        { adminEmail: regex },
        { userId: { $in: users.map((u) => u._id) } }
      ];
    }

    const [transactions, total] = await Promise.all([
      WalletTransactionModel.find(query)
        .populate('userId', 'name email role')
        .populate('relatedUserId', 'name email')
        .populate('adminId', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      WalletTransactionModel.countDocuments(query)
    ]);

    return { transactions, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async adminListWallets(options: {
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<any> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 25));
    const userQuery: Record<string, any> = { isDeleted: { $ne: true } };
    if (options.search && options.search.trim()) {
      const escaped = options.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      userQuery.$or = [
        { name: regex },
        { email: regex },
        { phone: regex },
        { referralCode: regex }
      ];
      if (mongoose.Types.ObjectId.isValid(options.search.trim())) {
        userQuery.$or.push({ _id: new mongoose.Types.ObjectId(options.search.trim()) });
      }
    }

    const [users, total] = await Promise.all([
      UserModel.find(userQuery)
        .select('name email phone role referralCode referralCommissionRate referralCommissionType referralEligible accountStatus')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      UserModel.countDocuments(userQuery)
    ]);

    const userIds = users.map((u) => u._id);
    const [wallets, referredCounts, commissionSums, withdrawalSums] = await Promise.all([
      WalletModel.find({ userId: { $in: userIds } }).lean(),
      UserModel.aggregate([
        { $match: { referredBy: { $in: userIds }, isDeleted: { $ne: true } } },
        { $group: { _id: '$referredBy', count: { $sum: 1 } } }
      ]),
      ReferralCommissionModel.aggregate([
        { $match: { moderatorId: { $in: userIds }, status: { $in: ['CREDITED', 'APPROVED', 'ELIGIBLE'] } } },
        { $group: { _id: '$moderatorId', total: { $sum: '$amountUsd' }, count: { $sum: 1 } } }
      ]),
      WithdrawalRequestModel.aggregate([
        { $match: { userId: { $in: userIds }, status: { $in: ['PENDING', 'APPROVED'] } } },
        { $group: { _id: '$userId', total: { $sum: '$amountCents' } } }
      ])
    ]);

    const walletMap = new Map(wallets.map((w) => [w.userId.toString(), w]));
    const referredMap = new Map(referredCounts.map((r) => [r._id.toString(), r.count]));
    const commissionMap = new Map(commissionSums.map((c) => [c._id.toString(), c]));
    const withdrawalMap = new Map(withdrawalSums.map((w) => [w._id.toString(), w.total]));

    const policy = await CommissionPolicyModel.getActivePolicy();

    return {
      wallets: users.map((u: any) => {
        const wallet = walletMap.get(u._id.toString());
        const commission = commissionMap.get(u._id.toString());
        return {
          user: {
            ...u,
            id: u._id.toString()
          },
          wallet: wallet
            ? {
                ...wallet,
                totalWalletBalanceCents: wallet.availableBalanceCents + wallet.reservedWithdrawalCents
              }
            : {
                availableBalanceCents: 0,
                reservedWithdrawalCents: 0,
                lifetimeCommissionCents: 0,
                totalWithdrawnCents: 0,
                totalWalletBalanceCents: 0
              },
          referral: {
            totalReferredUsers: referredMap.get(u._id.toString()) || 0,
            successfulReferrals: commission?.count || 0,
            commissionRate:
              u.referralCommissionRate ??
              (u.role === 'MODERATOR'
                ? policy.moderatorRate ?? policy.defaultRate ?? 0.5
                : policy.normalUserRate ?? 0.3),
            commissionType:
              u.referralCommissionType ||
              (u.role === 'MODERATOR' ? 'LIFETIME' : 'ONE_TIME'),
            referralEligible: u.referralEligible !== false
          },
          pendingWithdrawalCents: withdrawalMap.get(u._id.toString()) || 0
        };
      }),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit))
    };
  }

  async getAdminWalletStats() {
    const [walletAgg, withdrawalAgg, commissionAgg] = await Promise.all([
      WalletModel.aggregate([
        {
          $group: {
            _id: null,
            available: { $sum: '$availableBalanceCents' },
            reserved: { $sum: '$reservedWithdrawalCents' },
            lifetime: { $sum: '$lifetimeCommissionCents' },
            withdrawn: { $sum: '$totalWithdrawnCents' }
          }
        }
      ]),
      WithdrawalRequestModel.aggregate([
        { $group: { _id: '$status', total: { $sum: '$amountCents' }, count: { $sum: 1 } } }
      ]),
      ReferralCommissionModel.aggregate([
        { $match: { status: { $in: ['CREDITED', 'APPROVED', 'ELIGIBLE'] } } },
        { $group: { _id: '$commissionType', total: { $sum: '$amountUsd' }, count: { $sum: 1 } } }
      ])
    ]);

    const walletRow = walletAgg[0] || { available: 0, reserved: 0, lifetime: 0, withdrawn: 0 };
    const withdrawals: Record<string, any> = {};
    for (const row of withdrawalAgg) {
      withdrawals[row._id] = { totalCents: row.total || 0, count: row.count || 0 };
    }
    const commissions: Record<string, any> = {};
    for (const row of commissionAgg) {
      commissions[row._id || 'ONE_TIME'] = { totalUsd: row.total || 0, count: row.count || 0 };
    }

    return {
      wallet: {
        totalAvailableCents: walletRow.available || 0,
        totalReservedCents: walletRow.reserved || 0,
        totalLifetimeCommissionCents: walletRow.lifetime || 0,
        totalWithdrawnCents: walletRow.withdrawn || 0
      },
      withdrawals,
      commissions
    };
  }
}

export const walletService = new WalletService();
