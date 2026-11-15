import mongoose from 'mongoose';
import { UserModel, AccountStatus } from '../models/User';
import { SubscriptionModel, ISubscription } from '../models/Subscription';
import { PaymentModel, IPayment } from '../models/Payment';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { AuditLogModel } from '../models/AuditLog';
import { UserRole } from '../shared/roles';
import { PaymentStatus, SubscriptionStatus } from '../shared/subscriptions';
import { PlanModel } from '../models/Plan';
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
    const [totalActive, totalExpired, totalRevoked, planRows, catalogPlans] = await Promise.all([
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
      SubscriptionModel.aggregate([
        {
          $match: {
            status: SubscriptionStatus.ACTIVE,
            isRevoked: { $ne: true },
            endDate: { $gt: now }
          }
        },
        { $group: { _id: '$planId', count: { $sum: 1 } } }
      ]),
      PlanModel.find().select('planId name').lean()
    ]);

    // Calculate plan distribution from the live plan catalogue.
    const planCounts: Record<string, number> = {};
    for (const row of planRows) {
      if (row._id) planCounts[row._id] = row.count;
    }

    const totalActiveCount = planRows.reduce((sum: number, row: any) => sum + (row.count || 0), 0) || 1;
    const knownPlanIds = new Set(catalogPlans.map((plan) => plan.planId));
    const planDistribution = [
      ...catalogPlans.map((plan) => {
        const count = planCounts[plan.planId] || 0;
        return {
          planId: plan.planId,
          planName: plan.name,
          activeCount: count,
          percentage: Math.round((count / totalActiveCount) * 1000) / 10
        };
      }),
      ...Object.entries(planCounts)
        .filter(([planId]) => !knownPlanIds.has(planId))
        .map(([planId, count]) => ({
          planId,
          planName: planId.replace(/_/g, ' '),
          activeCount: count,
          percentage: Math.round((count / totalActiveCount) * 1000) / 10
        }))
    ];

    // 3. Financial calculations (single aggregation, no full-document scan)
    const paymentQuery: Record<string, any> = { ...dateQuery };
    if (filters.planId) paymentQuery.planId = filters.planId;
    if (filters.moderatorId) paymentQuery.referredByModeratorId = new mongoose.Types.ObjectId(filters.moderatorId);

    const commQuery: Record<string, any> = { ...dateQuery };
    if (filters.moderatorId) commQuery.moderatorId = new mongoose.Types.ObjectId(filters.moderatorId);

    const [paymentAgg, commAgg, moderators] = await Promise.all([
      PaymentModel.aggregate([
        { $match: paymentQuery },
        {
          $group: {
            _id: null,
            grossSalesUsd: {
              $sum: {
                $cond: [
                  { $or: [{ $eq: ['$isFulfilled', true] }, { $eq: ['$status', PaymentStatus.FINISHED] }] },
                  '$priceAmount',
                  0
                ]
              }
            },
            refundsUsd: {
              $sum: { $cond: [{ $eq: ['$status', PaymentStatus.REFUNDED] }, '$priceAmount', 0] }
            },
            confirmedOrdersCount: {
              $sum: {
                $cond: [
                  { $or: [{ $eq: ['$isFulfilled', true] }, { $eq: ['$status', PaymentStatus.FINISHED] }] },
                  1,
                  0
                ]
              }
            },
            failedOrdersCount: {
              $sum: {
                $cond: [
                  { $in: ['$status', [PaymentStatus.FAILED, PaymentStatus.EXPIRED]] },
                  1,
                  0
                ]
              }
            },
            refundedOrdersCount: {
              $sum: { $cond: [{ $eq: ['$status', PaymentStatus.REFUNDED] }, 1, 0] }
            }
          }
        }
      ]),
      ReferralCommissionModel.aggregate([
        { $match: commQuery },
        { $group: { _id: '$status', totalUsd: { $sum: '$amountUsd' }, count: { $sum: 1 } } }
      ]),
      UserModel.find({ role: UserRole.MODERATOR, isDeleted: false })
        .select('_id name email referralCode')
        .lean()
    ]);

    const paymentTotals = paymentAgg[0] || {
      grossSalesUsd: 0,
      refundsUsd: 0,
      confirmedOrdersCount: 0,
      failedOrdersCount: 0,
      refundedOrdersCount: 0
    };

    const grossSalesUsd = paymentTotals.grossSalesUsd || 0;
    const refundsUsd = paymentTotals.refundsUsd || 0;
    const confirmedOrdersCount = paymentTotals.confirmedOrdersCount || 0;
    const failedOrdersCount = paymentTotals.failedOrdersCount || 0;
    const refundedOrdersCount = paymentTotals.refundedOrdersCount || 0;

    // Estimated blockchain and gateway processing network fee (approx 1% of gross)
    const estimatedFeesUsd = Math.round(grossSalesUsd * 0.01 * 100) / 100;
    const netRevenueUsd = Math.round((grossSalesUsd - refundsUsd - estimatedFeesUsd) * 100) / 100;

    // 4. Commission liabilities from the grouped status totals
    let pendingCommissionLiabilitiesUsd = 0;
    let approvedCommissionLiabilitiesUsd = 0;
    let reversedCommissionsUsd = 0;

    for (const row of commAgg) {
      if (row._id === 'PENDING' || row._id === 'ELIGIBLE') {
        pendingCommissionLiabilitiesUsd += row.totalUsd || 0;
      } else if (row._id === 'APPROVED' || row._id === 'CREDITED') {
        approvedCommissionLiabilitiesUsd += row.totalUsd || 0;
      } else if (row._id === 'REVERSED') {
        reversedCommissionsUsd += row.totalUsd || 0;
      }
    }

    // 5. Moderator performance ranking (bulk queries, no N+1)
    const moderatorIds = moderators.map((mod) => mod._id);
    const [customerCounts, allModeratorCommissions] = await Promise.all([
      moderatorIds.length
        ? UserModel.aggregate([
            { $match: { referredBy: { $in: moderatorIds }, isDeleted: false } },
            { $group: { _id: '$referredBy', count: { $sum: 1 } } }
          ])
        : [],
      moderatorIds.length
        ? ReferralCommissionModel.find({ moderatorId: { $in: moderatorIds } })
            .select('moderatorId status amountUsd originalPurchaseAmount commissionableAmount')
            .lean()
        : []
    ]);

    const customerCountMap = new Map<string, number>();
    for (const row of customerCounts) {
      customerCountMap.set(String(row._id), row.count || 0);
    }

    const commissionsByModerator = new Map<string, any[]>();
    for (const commission of allModeratorCommissions as any[]) {
      const key = String(commission.moderatorId);
      if (!commissionsByModerator.has(key)) commissionsByModerator.set(key, []);
      commissionsByModerator.get(key)!.push(commission);
    }

    const moderatorPerformance = moderators.map((mod) => {
      const modId: any = mod._id;
      const modComms = commissionsByModerator.get(String(modId)) || [];

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
        attributedCustomers: customerCountMap.get(String(modId)) || 0,
        attributedSalesCount,
        attributedRevenueUsd: Math.round(attributedRevenueUsd * 100) / 100,
        creditedCommissionUsd: Math.round(creditedCommissionUsd * 100) / 100
      };
    });

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
