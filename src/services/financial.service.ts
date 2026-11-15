import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { PaymentModel } from '../models/Payment';
import { PayoutModel, IPayout } from '../models/Payout';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { AuditLogModel } from '../models/AuditLog';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import { memoryCache } from '../utils/cache';

export interface FinancialSummary {
  totalIncomeCents: number;
  totalPayoutsCents: number;
  currentBalanceCents: number;
  totalIncomeUsd: number;
  totalPayoutsUsd: number;
  currentBalanceUsd: number;
  confirmedPaymentCount: number;
  completedPayoutCount: number;
  estimatedPaymentFeesCents: number;
  estimatedPaymentFeesUsd: number;
  netPlatformRevenueCents: number;
  netPlatformRevenueUsd: number;
  outstandingCommissionLiabilitiesCents: number;
  outstandingCommissionLiabilitiesUsd: number;
  refundsCents: number;
  refundsUsd: number;
}

export interface FinancialTransaction {
  id: string;
  transactionId: string;
  type: 'INCOME' | 'PAYOUT';
  amountCents: number;
  amountUsd: number;
  previousBalanceCents: number;
  newBalanceCents: number;
  previousBalanceUsd: number;
  newBalanceUsd: number;
  description: string;
  method: string;
  reference: string;
  adminName: string;
  adminId: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

function toCentsFromPayment(payment: any): number {
  if (typeof payment?.priceCents === 'number' && Number.isFinite(payment.priceCents)) {
    return Math.round(payment.priceCents);
  }
  if (typeof payment?.priceAmount === 'number' && Number.isFinite(payment.priceAmount)) {
    return Math.round(payment.priceAmount * 100);
  }
  return 0;
}

export function parseUsdToCents(input: unknown): number {
  const raw =
    typeof input === 'number'
      ? Number.isFinite(input)
        ? input.toFixed(2)
        : ''
      : String(input ?? '').trim();

  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw ApiError.badRequest(
      'Payout amount must be a valid positive number with at most 2 decimal places.'
    );
  }

  const [whole, fraction = ''] = raw.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw ApiError.badRequest('Payout amount must be greater than zero.');
  }
  return cents;
}

export class FinancialService {
  private async getTotals(): Promise<{
    incomeCents: number;
    payoutsCents: number;
    refundsCents: number;
    commissionCents: number;
    confirmedPaymentCount: number;
    completedPayoutCount: number;
  }> {
    const [incomeAgg, payoutAgg, refundAgg, commissionAgg, paymentCount, payoutCount] =
      await Promise.all([
        PaymentModel.aggregate([
          { $match: { isFulfilled: true } },
          {
            $group: {
              _id: null,
              total: {
                $sum: {
                  $ifNull: [
                    '$priceCents',
                    { $round: [{ $multiply: ['$priceAmount', 100] }, 0] }
                  ]
                }
              }
            }
          }
        ]),
        PayoutModel.aggregate([
          { $match: { status: 'COMPLETED' } },
          { $group: { _id: null, total: { $sum: '$amountCents' } } }
        ]),
        PaymentModel.aggregate([
          { $match: { status: 'REFUNDED' } },
          {
            $group: {
              _id: null,
              total: {
                $sum: {
                  $ifNull: [
                    '$priceCents',
                    { $round: [{ $multiply: ['$priceAmount', 100] }, 0] }
                  ]
                }
              }
            }
          }
        ]),
        ReferralCommissionModel.aggregate([
          { $match: { status: { $ne: 'REVERSED' } } },
          { $group: { _id: null, total: { $sum: { $multiply: ['$amountUsd', 100] } } } }
        ]),
        PaymentModel.countDocuments({ isFulfilled: true }),
        PayoutModel.countDocuments({ status: 'COMPLETED' })
      ]);

    return {
      incomeCents: Math.round(incomeAgg[0]?.total || 0),
      payoutsCents: Math.round(payoutAgg[0]?.total || 0),
      refundsCents: Math.round(refundAgg[0]?.total || 0),
      commissionCents: Math.round(commissionAgg[0]?.total || 0),
      confirmedPaymentCount: paymentCount,
      completedPayoutCount: payoutCount
    };
  }

  async getSummary(): Promise<FinancialSummary> {
    return memoryCache.getOrSet('admin:financialSummary', 5, async () => {
      const totals = await this.getTotals();
      const estimatedFees = Math.round(totals.incomeCents * 0.01);
      const current = totals.incomeCents - totals.payoutsCents;
      const net =
        totals.incomeCents -
        totals.refundsCents -
        estimatedFees -
        totals.commissionCents;

      return {
        totalIncomeCents: totals.incomeCents,
        totalPayoutsCents: totals.payoutsCents,
        currentBalanceCents: current,
        totalIncomeUsd: totals.incomeCents / 100,
        totalPayoutsUsd: totals.payoutsCents / 100,
        currentBalanceUsd: current / 100,
        confirmedPaymentCount: totals.confirmedPaymentCount,
        completedPayoutCount: totals.completedPayoutCount,
        estimatedPaymentFeesCents: estimatedFees,
        estimatedPaymentFeesUsd: estimatedFees / 100,
        netPlatformRevenueCents: net,
        netPlatformRevenueUsd: net / 100,
        outstandingCommissionLiabilitiesCents: totals.commissionCents,
        outstandingCommissionLiabilitiesUsd: totals.commissionCents / 100,
        refundsCents: totals.refundsCents,
        refundsUsd: totals.refundsCents / 100
      };
    });
  }

  async createPayout(
    adminId: string,
    adminEmail: string,
    input: {
      amountUsd?: number | string;
      amountCents?: number;
      description?: string;
      method?: string;
      reference?: string;
      idempotencyKey?: string;
    }
  ): Promise<{ payout: IPayout; summary: FinancialSummary; duplicate: boolean }> {
    const amountCents =
      typeof input.amountCents === 'number'
        ? (() => {
            if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
              throw ApiError.badRequest('Payout amount must be a positive integer in cents.');
            }
            return input.amountCents;
          })()
        : parseUsdToCents(input.amountUsd);

    const description = (input.description || '').trim().slice(0, 500);
    const method = (input.method || 'MANUAL').trim().slice(0, 80);
    const reference = (input.reference || '').trim().slice(0, 160);
    const idempotencyKey =
      (input.idempotencyKey || '').trim() ||
      `payout:${adminId}:${amountCents}:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`;

    // Idempotent replay: the same client submission returns the original payout.
    const existing = await PayoutModel.findOne({ idempotencyKey });
    if (existing) {
      memoryCache.del('admin:financialSummary');
      return { payout: existing, summary: await this.getSummary(), duplicate: true };
    }

    // Accidental double-click guard when a client omits an idempotency key.
    if (!input.idempotencyKey) {
      const recent = await PayoutModel.findOne({
        adminId: new mongoose.Types.ObjectId(adminId),
        amountCents,
        description,
        status: 'COMPLETED',
        createdAt: { $gte: new Date(Date.now() - 15_000) }
      });
      if (recent) {
        memoryCache.del('admin:financialSummary');
        return { payout: recent, summary: await this.getSummary(), duplicate: true };
      }
    }

    memoryCache.del('admin:financialSummary');
    const summary = await this.getSummary();
    const previousBalanceCents = summary.currentBalanceCents;
    const newBalanceCents = previousBalanceCents - amountCents;

    const transactionId = `PAY-${Date.now()}-${crypto
      .randomBytes(3)
      .toString('hex')
      .toUpperCase()}`;

    try {
      const payout = await PayoutModel.create({
        transactionId,
        idempotencyKey,
        amountCents,
        amountUsd: amountCents / 100,
        currency: 'USD',
        description,
        method,
        reference,
        adminId: new mongoose.Types.ObjectId(adminId),
        adminEmail,
        status: 'COMPLETED',
        previousBalanceCents,
        newBalanceCents,
        completedAt: new Date()
      });

      await AuditLogModel.create({
        action: 'FINANCIAL_PAYOUT',
        adminId: new mongoose.Types.ObjectId(adminId),
        adminEmail,
        reason: description || `Manual payout ${transactionId}`,
        targetResourceId: transactionId,
        resourceType: 'Payout',
        newValue: {
          transactionId,
          amountCents,
          amountUsd: amountCents / 100,
          method,
          reference,
          previousBalanceCents,
          newBalanceCents
        }
      }).catch((err) => logger.error('Failed to audit financial payout', err));

      memoryCache.del('admin:dashboardMetrics');
      memoryCache.del('admin:financialSummary');
      logger.info(
        `Main Admin ${adminEmail} recorded payout ${transactionId} for $${(amountCents / 100).toFixed(2)}.`
      );

      return { payout, summary: await this.getSummary(), duplicate: false };
    } catch (err: any) {
      // Unique idempotency key race: return the already-recorded transaction.
      if (err?.code === 11000) {
        const raced = await PayoutModel.findOne({ idempotencyKey });
        if (raced) {
          memoryCache.del('admin:financialSummary');
          return { payout: raced, summary: await this.getSummary(), duplicate: true };
        }
      }
      throw err;
    }
  }

  async listTransactions(filters: {
    type?: string;
    search?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    transactions: FinancialTransaction[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    summary: FinancialSummary;
  }> {
    const page = Math.max(1, filters.page || 1);
    const limit = Math.min(100, Math.max(1, filters.limit || 25));

    const [payments, payouts] = await Promise.all([
      PaymentModel.find({ isFulfilled: true }).sort({ createdAt: 1 }).lean(),
      PayoutModel.find({ status: 'COMPLETED' }).sort({ createdAt: 1 }).lean()
    ]);

    type Event = {
      sortAt: number;
      transaction: FinancialTransaction;
    };

    const events: Event[] = [];
    let runningBalance = 0;

    const combined = [
      ...payments.map((payment: any) => ({
        kind: 'INCOME' as const,
        at: new Date(payment.createdAt || payment.updatedAt || 0).getTime(),
        payment
      })),
      ...payouts.map((payout: any) => ({
        kind: 'PAYOUT' as const,
        at: new Date(payout.createdAt || payout.completedAt || 0).getTime(),
        payout
      }))
    ].sort((a, b) => a.at - b.at);

    for (const item of combined) {
      if (item.kind === 'INCOME') {
        const amountCents = toCentsFromPayment(item.payment);
        if (amountCents <= 0) continue;
        const previousBalanceCents = runningBalance;
        runningBalance += amountCents;
        const createdAt = new Date(item.at).toISOString();
        const transactionId =
          item.payment.orderId || item.payment.paymentId || item.payment._id?.toString();
        events.push({
          sortAt: item.at,
          transaction: {
            id: item.payment._id?.toString() || transactionId,
            transactionId,
            type: 'INCOME',
            amountCents,
            amountUsd: amountCents / 100,
            previousBalanceCents,
            newBalanceCents: runningBalance,
            previousBalanceUsd: previousBalanceCents / 100,
            newBalanceUsd: runningBalance / 100,
            description: `${item.payment.planName || item.payment.planId || 'Subscription'} purchase`,
            method: item.payment.payCurrency || 'CRYPTO',
            reference: item.payment.orderId || item.payment.paymentId || '',
            adminName: 'Gateway / System',
            adminId: 'system',
            status: 'COMPLETED',
            createdAt,
            completedAt: createdAt
          }
        });
      } else {
        const amountCents = Math.round(item.payout.amountCents || 0);
        if (amountCents <= 0) continue;
        const previousBalanceCents = runningBalance;
        runningBalance -= amountCents;
        const createdAt = new Date(item.at).toISOString();
        events.push({
          sortAt: item.at,
          transaction: {
            id: item.payout._id?.toString() || item.payout.transactionId,
            transactionId: item.payout.transactionId,
            type: 'PAYOUT',
            amountCents,
            amountUsd: amountCents / 100,
            previousBalanceCents,
            newBalanceCents: runningBalance,
            previousBalanceUsd: previousBalanceCents / 100,
            newBalanceUsd: runningBalance / 100,
            description: item.payout.description || 'Manual payout',
            method: item.payout.method || 'MANUAL',
            reference: item.payout.reference || '',
            adminName: item.payout.adminEmail || 'Main Admin',
            adminId: item.payout.adminId?.toString() || '',
            status: item.payout.status,
            createdAt,
            completedAt: item.payout.completedAt
              ? new Date(item.payout.completedAt).toISOString()
              : null
          }
        });
      }
    }

    events.sort((a, b) => b.sortAt - a.sortAt);

    const search = (filters.search || '').trim().toLowerCase();
    const type = (filters.type || 'ALL').toUpperCase();
    const start = filters.startDate ? new Date(filters.startDate).getTime() : null;
    const end = filters.endDate ? new Date(filters.endDate).getTime() : null;

    const filtered = events.filter(({ sortAt, transaction }) => {
      if (type === 'INCOME' || type === 'PAYOUT') {
        if (transaction.type !== type) return false;
      }
      if (start !== null && sortAt < start) return false;
      if (end !== null) {
        const endOfDay = new Date(filters.endDate as string);
        endOfDay.setHours(23, 59, 59, 999);
        if (sortAt > endOfDay.getTime()) return false;
      }
      if (search) {
        const haystack = [
          transaction.transactionId,
          transaction.reference,
          transaction.description,
          transaction.adminName,
          transaction.method
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    const total = filtered.length;
    const paged = filtered.slice((page - 1) * limit, page * limit);

    return {
      transactions: paged.map((event) => event.transaction),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      summary: await this.getSummary()
    };
  }
}

export const financialService = new FinancialService();
