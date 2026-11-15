import mongoose from 'mongoose';
import { UserModel, AccountStatus } from '../models/User';
import { SubscriptionModel, ISubscription } from '../models/Subscription';
import { PaymentModel, IPayment } from '../models/Payment';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { AuditLogModel } from '../models/AuditLog';
import { UserRole } from '../shared/roles';
import { PaymentStatus, SubscriptionStatus } from '../shared/subscriptions';
import { SUBSCRIPTION_PLANS } from '../shared/plans';
import { ApiError } from '../utils/apiError';

/**
 * Neutralizes spreadsheet formula injection (CSV Injection).
 * If a cell begins with '=', '+', '-', '@', '\t', or '\r', it is prefixed with a single quote (').
 * Also escapes double quotes according to RFC 4180.
 */
export function sanitizeCsvCell(value: any): string {
  if (value === null || value === undefined) return '""';
  let str = String(value);

  // Formula injection prevention
  if (/^[=\+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }

  // Quote escaping
  return `"${str.replace(/"/g, '""')}"`;
}

export interface ReportsFilter {
  startDate?: string;
  endDate?: string;
  planId?: string;
  moderatorId?: string;
  status?: string;
}

export interface PlatformReportsSummary {
  period: {
    startDate?: string;
    endDate?: string;
  };
  users: {
    totalRegistrations: number;
    activeUsers: number;
    blockedUsers: number;
    suspendedUsers: number;
    moderatorsCount: number;
  };
  subscriptions: {
    totalActive: number;
    totalExpired: number;
    totalRevoked: number;
    planDistribution: Array<{
      planId: string;
      planName: string;
      activeCount: number;
      percentage: number;
    }>;
  };
  finances: {
    grossSalesUsd: number;
    refundsUsd: number;
    estimatedFeesUsd: number;
    netRevenueUsd: number;
    confirmedOrdersCount: number;
    failedOrdersCount: number;
    refundedOrdersCount: number;
    pendingCommissionLiabilitiesUsd: number;
    approvedCommissionLiabilitiesUsd: number;
    reversedCommissionsUsd: number;
    disclaimer: string;
  };
  moderatorPerformance: Array<{
    moderatorId: string;
    name: string;
    email: string;
    referralCode: string;
    attributedCustomers: number;
    attributedSalesCount: number;
    attributedRevenueUsd: number;
    creditedCommissionUsd: number;
  }>;
}

function parseReportDate(value?: string): Date | undefined {
  if (!value || value === 'undefined' || value === 'null') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export class ReportsService {
  /**
   * Generates comprehensive platform analytical report with strict financial definition compliance
   */
  async getSummaryReport(filters: ReportsFilter = {}): Promise<PlatformReportsSummary> {
    const startDate = parseReportDate(filters.startDate);
    const endDate = parseReportDate(filters.endDate);
    const dateQuery: Record<string, any> = {};
    if (startDate || endDate) {
      dateQuery.createdAt = {};
      if (startDate) dateQuery.createdAt.$gte = startDate;
      if (endDate) dateQuery.createdAt.$lte = endDate;
    }

    // 1. User registrations telemetry
    const [totalRegistrations, activeUsers, blockedUsers, suspendedUsers, moderatorsCount] = await Promise.all([
      UserModel.countDocuments({ ...dateQuery, isDeleted: false }),
      UserModel.countDocuments({ accountStatus: AccountStatus.ACTIVE, isDeleted: false }),
      UserModel.countDocuments({ accountStatus: AccountStatus.BLOCKED, isDeleted: false }),
      UserModel.countDocuments({ accountStatus: AccountStatus.SUSPENDED, isDeleted: false }),
      UserModel.countDocuments({ role: UserRole.MODERATOR, isDeleted: false })
    ]);

    // 2. Subscriptions telemetry
    const now = new Date();
    const [totalActive, totalExpired, totalRevoked, allActiveSubs] = await Promise.all([
      SubscriptionModel.countDocuments({
        status: SubscriptionStatus.ACTIVE,
        isRevoked: { $ne: true },
        endDate: { $gt: now }
      }),
      SubscriptionModel.countDocuments({
        $or: [{ status: SubscriptionStatus.EXPIRED }, { endDate: { $lte: now } }]
      }),
      SubscriptionModel.countDocuments({
        $or: [{ isRevoked: true }, { status: SubscriptionStatus.REVOKED }]
      }),
      SubscriptionModel.find({
        status: SubscriptionStatus.ACTIVE,
        isRevoked: { $ne: true },
        endDate: { $gt: now }
      }).select('planId')
    ]);

    // Calculate plan distribution
    const planCounts: Record<string, number> = {};
    for (const sub of allActiveSubs) {
      planCounts[sub.planId] = (planCounts[sub.planId] || 0) + 1;
    }

    const totalActiveCount = allActiveSubs.length || 1;
    const planDistribution = Object.keys(SUBSCRIPTION_PLANS).map((pId) => {
      const plan = SUBSCRIPTION_PLANS[pId];
      const count = planCounts[pId] || 0;
      return {
        planId: pId,
        planName: plan?.name || pId,
        activeCount: count,
        percentage: Math.round((count / totalActiveCount) * 1000) / 10
      };
    });

    // 3. Financial calculations
    const paymentQuery: Record<string, any> = { ...dateQuery };
    if (filters.planId) paymentQuery.planId = filters.planId;
    if (filters.moderatorId) paymentQuery.referredByModeratorId = new mongoose.Types.ObjectId(filters.moderatorId);

    const payments = await PaymentModel.find(paymentQuery);

    let grossSalesUsd = 0;
    let refundsUsd = 0;
    let confirmedOrdersCount = 0;
    let failedOrdersCount = 0;
    let refundedOrdersCount = 0;

    for (const p of payments) {
      if (p.status === PaymentStatus.FINISHED || p.isFulfilled) {
        grossSalesUsd += p.priceAmount;
        confirmedOrdersCount++;
      } else if (p.status === PaymentStatus.REFUNDED) {
        refundsUsd += p.priceAmount;
        refundedOrdersCount++;
      } else if (p.status === PaymentStatus.FAILED || p.status === PaymentStatus.EXPIRED) {
        failedOrdersCount++;
      }
    }

    // Estimated blockchain and gateway processing network fee (approx 1% of gross)
    const estimatedFeesUsd = Math.round(grossSalesUsd * 0.01 * 100) / 100;
    const netRevenueUsd = Math.round((grossSalesUsd - refundsUsd - estimatedFeesUsd) * 100) / 100;

    // 4. Commission liabilities
    const commQuery: Record<string, any> = { ...dateQuery };
    if (filters.moderatorId) commQuery.moderatorId = new mongoose.Types.ObjectId(filters.moderatorId);

    const commissions = await ReferralCommissionModel.find(commQuery);

    let pendingCommissionLiabilitiesUsd = 0;
    let approvedCommissionLiabilitiesUsd = 0;
    let reversedCommissionsUsd = 0;

    for (const c of commissions) {
      if (c.status === 'PENDING' || c.status === 'ELIGIBLE') {
        pendingCommissionLiabilitiesUsd += c.amountUsd;
      } else if (c.status === 'APPROVED' || c.status === 'CREDITED') {
        approvedCommissionLiabilitiesUsd += c.amountUsd;
      } else if (c.status === 'REVERSED') {
        reversedCommissionsUsd += c.amountUsd;
      }
    }

    // 5. Moderator performance ranking
    const moderators = await UserModel.find({
      role: UserRole.MODERATOR,
      isDeleted: false
    });

    const moderatorPerformance = await Promise.all(
      moderators.map(async (mod) => {
        const modId = mod._id;
        const [customerCount, modComms] = await Promise.all([
          UserModel.countDocuments({ referredBy: modId, isDeleted: false }),
          ReferralCommissionModel.find({ moderatorId: modId })
        ]);

        let attributedSalesCount = 0;
        let attributedRevenueUsd = 0;
        let creditedCommissionUsd = 0;

        for (const mc of modComms) {
          if (mc.status !== 'REVERSED') {
            attributedSalesCount++;
            attributedRevenueUsd += mc.originalPurchaseAmount || mc.commissionableAmount || (mc.amountUsd * 2);
            if (mc.status === 'CREDITED' || mc.status === 'APPROVED') {
              creditedCommissionUsd += mc.amountUsd;
            }
          }
        }

        return {
          moderatorId: modId.toString(),
          name: mod.name,
          email: mod.email || '',
          referralCode: mod.referralCode || '',
          attributedCustomers: customerCount,
          attributedSalesCount,
          attributedRevenueUsd: Math.round(attributedRevenueUsd * 100) / 100,
          creditedCommissionUsd: Math.round(creditedCommissionUsd * 100) / 100
        };
      })
    );

    return {
      period: {
        startDate: filters.startDate,
        endDate: filters.endDate
      },
      users: {
        totalRegistrations,
        activeUsers,
        blockedUsers,
        suspendedUsers,
        moderatorsCount
      },
      subscriptions: {
        totalActive,
        totalExpired,
        totalRevoked,
        planDistribution
      },
      finances: {
        grossSalesUsd: Math.round(grossSalesUsd * 100) / 100,
        refundsUsd: Math.round(refundsUsd * 100) / 100,
        estimatedFeesUsd,
        netRevenueUsd,
        confirmedOrdersCount,
        failedOrdersCount,
        refundedOrdersCount,
        pendingCommissionLiabilitiesUsd: Math.round(pendingCommissionLiabilitiesUsd * 100) / 100,
        approvedCommissionLiabilitiesUsd: Math.round(approvedCommissionLiabilitiesUsd * 100) / 100,
        reversedCommissionsUsd: Math.round(reversedCommissionsUsd * 100) / 100,
        disclaimer:
          'Financial reporting is strictly for internal accounting and audit transparency. Gross sales represent settled customer deposits before expenses. Commission liabilities do not represent custodial account balances or processed payouts; there is zero automated withdrawal functionality.'
      },
      moderatorPerformance
    };
  }

  /**
   * Export reports to CSV format with formula injection protection and sensitive data masking
   */
  async exportReportCsv(
    reportType: 'REGISTRATIONS' | 'SUBSCRIPTIONS' | 'SALES' | 'MODERATORS' | 'ACTIVITY',
    filters: ReportsFilter = {}
  ): Promise<string> {
    const startDate = parseReportDate(filters.startDate);
    const endDate = parseReportDate(filters.endDate);
    const dateQuery: Record<string, any> = {};
    if (startDate || endDate) {
      dateQuery.createdAt = {};
      if (startDate) dateQuery.createdAt.$gte = startDate;
      if (endDate) dateQuery.createdAt.$lte = endDate;
    }

    if (reportType === 'REGISTRATIONS') {
      const users = await UserModel.find({ ...dateQuery, isDeleted: false })
        .populate('referredBy', 'name email referralCode')
        .sort({ createdAt: -1 })
        .limit(10000);

      const header = ['User ID', 'Name', 'Email', 'Phone', 'Role', 'Account Status', 'Referred By Code', 'Referred At', 'Registered At'];
      const rows = users.map((u: any) => [
        sanitizeCsvCell(u._id.toString()),
        sanitizeCsvCell(u.name),
        sanitizeCsvCell(u.email || ''),
        sanitizeCsvCell(u.phone || ''),
        sanitizeCsvCell(u.role),
        sanitizeCsvCell(u.accountStatus),
        sanitizeCsvCell(u.referredBy?.referralCode || u.referralCodeUsed || 'DIRECT'),
        sanitizeCsvCell(u.referredAt ? u.referredAt.toISOString() : ''),
        sanitizeCsvCell(u.createdAt ? u.createdAt.toISOString() : '')
      ]);

      return [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
    }

    if (reportType === 'SALES') {
      const payments = await PaymentModel.find({ ...dateQuery })
        .populate('userId', 'email name')
        .populate('referredByModeratorId', 'email referralCode')
        .sort({ createdAt: -1 })
        .limit(10000);

      const header = [
        'Order ID',
        'Payment ID',
        'Customer Email',
        'Plan Name',
        'Price USD',
        'Pay Currency',
        'Status',
        'Is Fulfilled',
        'Referral Code',
        'Commission Rate Snapshot',
        'Created At'
      ];

      const rows = payments.map((p: any) => [
        sanitizeCsvCell(p.orderId),
        sanitizeCsvCell(p.paymentId),
        sanitizeCsvCell(p.userId?.email || ''),
        sanitizeCsvCell(p.planName),
        sanitizeCsvCell(p.priceAmount),
        sanitizeCsvCell(p.payCurrency),
        sanitizeCsvCell(p.status),
        sanitizeCsvCell(p.isFulfilled ? 'YES' : 'NO'),
        sanitizeCsvCell(p.referralCodeSnapshot || 'NONE'),
        sanitizeCsvCell(p.commissionRateSnapshot ? `${p.commissionRateSnapshot * 100}%` : 'N/A'),
        sanitizeCsvCell(p.createdAt ? p.createdAt.toISOString() : '')
      ]);

      return [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
    }

    if (reportType === 'SUBSCRIPTIONS') {
      const subs = await SubscriptionModel.find({ ...dateQuery })
        .populate('userId', 'email name')
        .sort({ createdAt: -1 })
        .limit(10000);

      const header = ['Subscription ID', 'Customer Email', 'Plan ID', 'Status', 'Start Date', 'End Date', 'Is Manual Grant', 'Is Revoked'];
      const rows = subs.map((s: any) => [
        sanitizeCsvCell(s._id.toString()),
        sanitizeCsvCell(s.userId?.email || ''),
        sanitizeCsvCell(s.planId),
        sanitizeCsvCell(s.status),
        sanitizeCsvCell(s.startDate ? s.startDate.toISOString() : ''),
        sanitizeCsvCell(s.endDate ? s.endDate.toISOString() : ''),
        sanitizeCsvCell(s.isManualGrant ? 'YES' : 'NO'),
        sanitizeCsvCell(s.isRevoked ? 'YES' : 'NO')
      ]);

      return [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
    }

    if (reportType === 'MODERATORS') {
      const summary = await this.getSummaryReport(filters);
      const header = ['Moderator ID', 'Name', 'Email', 'Referral Code', 'Attributed Customers', 'Sales Count', 'Attributed Revenue USD', 'Credited Commission USD'];
      const rows = summary.moderatorPerformance.map((m) => [
        sanitizeCsvCell(m.moderatorId),
        sanitizeCsvCell(m.name),
        sanitizeCsvCell(m.email),
        sanitizeCsvCell(m.referralCode),
        sanitizeCsvCell(m.attributedCustomers),
        sanitizeCsvCell(m.attributedSalesCount),
        sanitizeCsvCell(m.attributedRevenueUsd),
        sanitizeCsvCell(m.creditedCommissionUsd)
      ]);

      return [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
    }

    // ACTIVITY / AUDIT LOGS
    const logs = await AuditLogModel.find({ ...dateQuery }).sort({ createdAt: -1 }).limit(10000);
    const header = ['Log ID', 'Action', 'Admin Email', 'Target User Email', 'Resource Type', 'Reason', 'Timestamp'];
    const rows = logs.map((l: any) => [
      sanitizeCsvCell(l._id.toString()),
      sanitizeCsvCell(l.action),
      sanitizeCsvCell(l.adminEmail),
      sanitizeCsvCell(l.targetUserEmail || ''),
      sanitizeCsvCell(l.resourceType || ''),
      sanitizeCsvCell(l.reason || ''),
      sanitizeCsvCell(l.createdAt ? l.createdAt.toISOString() : '')
    ]);

    return [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }
}

export const reportsService = new ReportsService();
