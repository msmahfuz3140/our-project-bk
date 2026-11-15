import mongoose from 'mongoose';
import { UserModel, IUser, AccountStatus } from '../models/User';
import { SubscriptionModel, ISubscription } from '../models/Subscription';
import { PaymentModel, IPayment } from '../models/Payment';
import { FinancialLedgerModel } from '../models/FinancialLedger';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { AuditLogModel, IAuditLog, AuditActionType } from '../models/AuditLog';
import { DualApprovalModel, IDualApproval, DualApprovalActionType } from '../models/DualApproval';
import { UserRole } from '../shared/roles';
import { PaymentStatus, SubscriptionStatus } from '../shared/subscriptions';
import { PLANS_ARRAY } from '../shared/plans';
import { PlanModel } from '../models/Plan';
import { hashPassword, generateRandomString } from '../utils/crypto';
import { normalizePhoneNumber } from '../utils/phone';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import { memoryCache } from '../utils/cache';
import { financialService } from './financial.service';

export interface AdminDashboardMetrics {
  totalRegisteredUsers: number;
  activeUsers: number;
  blockedUsers: number;
  suspendedUsers: number;
  deletedUsers: number;
  activeSubscriptions: number;
  expiredSubscriptions: number;
  confirmedPaymentCount: number;
  pendingPaymentCount: number;
  moderatorsCount: number;
  financials: {
    grossSalesUsd: number;
    refundsUsd: number;
    estimatedPaymentFeesUsd: number;
    outstandingCommissionLiabilitiesUsd: number;
    netRevenueUsd: number;
    referralAttributedSalesUsd: number;
    totalIncomeCents?: number;
    totalPayoutsCents?: number;
    currentBalanceCents?: number;
    totalIncomeUsd?: number;
    totalPayoutsUsd?: number;
    currentBalanceUsd?: number;
    completedPayoutCount?: number;
    confirmedIncomeCount?: number;
  };
  planDistribution: Record<string, number>;
  recentAuditActivities: any[];
}

export interface UserManagementFilter {
  search?: string;
  role?: string;
  accountStatus?: string;
  subscriptionStatus?: string;
  page?: number;
  limit?: number;
}

export class AdminService {
  /**
   * Log an immutable administrative action for compliance and security auditing
   */
  async logAction(params: {
    action: AuditActionType;
    adminId: string;
    adminEmail: string;
    reason: string;
    targetUserId?: string;
    targetUserEmail?: string;
    targetResourceId?: string;
    resourceType?: string;
    previousValue?: any;
    newValue?: any;
    details?: Record<string, any>;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<IAuditLog> {
    const entry = await AuditLogModel.create({
      action: params.action,
      adminId: new mongoose.Types.ObjectId(params.adminId),
      adminEmail: params.adminEmail,
      reason: params.reason,
      targetUserId: params.targetUserId ? new mongoose.Types.ObjectId(params.targetUserId) : undefined,
      targetUserEmail: params.targetUserEmail,
      targetResourceId: params.targetResourceId,
      resourceType: params.resourceType,
      previousValue: params.previousValue,
      newValue: params.newValue,
      details: params.details,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent
    });

    logger.info(`[ADMIN AUDIT] ${params.action} by ${params.adminEmail}. Reason: ${params.reason}`);
    memoryCache.del('admin:dashboardMetrics');
    return entry;
  }

  /**
   * Fetch comprehensive platform metrics with transparent financial breakdown
   */
  async getDashboardMetrics(): Promise<AdminDashboardMetrics> {
    return memoryCache.getOrSet('admin:dashboardMetrics', 15, async () => {
      const now = new Date();

    const [
      totalRegisteredUsers,
      activeUsers,
      blockedUsers,
      suspendedUsers,
      deletedUsers,
      activeSubscriptions,
      expiredSubscriptions,
      confirmedPaymentCount,
      pendingPaymentCount,
      moderatorsCount,
      finishedPaymentsAgg,
      refundedPaymentsAgg,
      commissionsAgg,
      referralSalesAgg,
      subscriptionsByPlan,
      recentAuditActivities
    ] = await Promise.all([
      UserModel.countDocuments({ isDeleted: { $ne: true } }),
      UserModel.countDocuments({ isDeleted: { $ne: true }, accountStatus: AccountStatus.ACTIVE, isActive: true }),
      UserModel.countDocuments({ isDeleted: { $ne: true }, accountStatus: AccountStatus.BLOCKED }),
      UserModel.countDocuments({ isDeleted: { $ne: true }, accountStatus: AccountStatus.SUSPENDED }),
      UserModel.countDocuments({ isDeleted: true }),
      SubscriptionModel.countDocuments({ status: SubscriptionStatus.ACTIVE, isRevoked: { $ne: true }, endDate: { $gt: now } }),
      SubscriptionModel.countDocuments({
        $or: [
          { status: SubscriptionStatus.EXPIRED },
          { endDate: { $lte: now } }
        ]
      }),
      PaymentModel.countDocuments({ status: PaymentStatus.FINISHED }),
      PaymentModel.countDocuments({ status: { $in: [PaymentStatus.WAITING, PaymentStatus.CONFIRMING, PaymentStatus.SENDING] } }),
      UserModel.countDocuments({ role: UserRole.MODERATOR, isDeleted: { $ne: true } }),
      PaymentModel.aggregate([
        { $match: { isFulfilled: true } },
        { $group: { _id: null, total: { $sum: '$priceAmount' } } }
      ]),
      PaymentModel.aggregate([
        { $match: { status: PaymentStatus.REFUNDED } },
        { $group: { _id: null, total: { $sum: '$priceAmount' } } }
      ]),
      ReferralCommissionModel.aggregate([
        { $match: { status: { $ne: 'REVERSED' } } },
        { $group: { _id: null, total: { $sum: '$amountUsd' } } }
      ]),
      ReferralCommissionModel.aggregate([
        { $match: { status: { $ne: 'REVERSED' } } },
        {
          $lookup: {
            from: 'payments',
            localField: 'paymentId',
            foreignField: '_id',
            as: 'payment'
          }
        },
        { $unwind: '$payment' },
        { $group: { _id: null, total: { $sum: '$payment.priceAmount' } } }
      ]),
      SubscriptionModel.aggregate([
        { $group: { _id: '$planId', count: { $sum: 1 } } }
      ]),
      AuditLogModel.find().sort({ createdAt: -1 }).limit(12).lean()
    ]);

    // Financial Calculation from fast aggregation outputs
    const grossSalesUsd = finishedPaymentsAgg[0]?.total || 0;
    const refundsUsd = refundedPaymentsAgg[0]?.total || 0;
    const outstandingCommissionLiabilitiesUsd = commissionsAgg[0]?.total || 0;
    const referralAttributedSalesUsd = referralSalesAgg[0]?.total || 0;

    // 1% estimated crypto gateway & network transfer fee
    const estimatedPaymentFeesUsd = Math.round(grossSalesUsd * 0.01 * 100) / 100;
    const netRevenueUsd = Math.round((grossSalesUsd - refundsUsd - estimatedPaymentFeesUsd - outstandingCommissionLiabilitiesUsd) * 100) / 100;

    // Plan distribution dictionary
    const planDistribution: Record<string, number> = {};
    for (const p of PLANS_ARRAY) {
      planDistribution[p.id] = 0;
    }
    for (const row of subscriptionsByPlan) {
      if (row._id) {
        planDistribution[row._id] = row.count;
      }
    }

    const financialSummary = await financialService.getSummary();

    return {
      totalRegisteredUsers,
      activeUsers,
      blockedUsers,
      suspendedUsers,
      deletedUsers,
      activeSubscriptions,
      expiredSubscriptions,
      confirmedPaymentCount,
      pendingPaymentCount,
      moderatorsCount,
      financials: {
        grossSalesUsd: Math.round(grossSalesUsd * 100) / 100,
        refundsUsd: Math.round(refundsUsd * 100) / 100,
        estimatedPaymentFeesUsd,
        outstandingCommissionLiabilitiesUsd: Math.round(outstandingCommissionLiabilitiesUsd * 100) / 100,
        netRevenueUsd,
        referralAttributedSalesUsd: Math.round(referralAttributedSalesUsd * 100) / 100,
        totalIncomeCents: financialSummary.totalIncomeCents,
        totalPayoutsCents: financialSummary.totalPayoutsCents,
        currentBalanceCents: financialSummary.currentBalanceCents,
        totalIncomeUsd: financialSummary.totalIncomeUsd,
        totalPayoutsUsd: financialSummary.totalPayoutsUsd,
        currentBalanceUsd: financialSummary.currentBalanceUsd,
        completedPayoutCount: financialSummary.completedPayoutCount,
        confirmedIncomeCount: financialSummary.confirmedPaymentCount
      },
      planDistribution,
      recentAuditActivities
    };
  });
}

  /**
   * Search, filter, and paginate platform users
   */
  async getUsers(filter: UserManagementFilter): Promise<{
    users: any[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    summary: {
      totalUsers: number;
      totalAdmins: number;
      totalMods: number;
      totalActiveSubs: number;
    };
  }> {
    const page = Math.max(1, filter.page || 1);
    const limit = Math.min(100, Math.max(1, filter.limit || 20));
    const skip = (page - 1) * limit;

    const query: any = {};

    const cleanParam = (val?: string): string | undefined => {
      if (!val || typeof val !== 'string') return undefined;
      const trimmed = val.trim();
      return (trimmed === '' || trimmed === 'undefined' || trimmed === 'null') ? undefined : trimmed;
    };

    const targetAccountStatus = cleanParam(filter.accountStatus);
    const targetRole = cleanParam(filter.role);
    const targetSearch = cleanParam(filter.search);

    // Don't show deleted users unless explicitly requested
    if (targetAccountStatus === AccountStatus.DELETED) {
      query.isDeleted = true;
    } else if (targetAccountStatus) {
      query.accountStatus = targetAccountStatus;
      query.isDeleted = { $ne: true };
    } else {
      query.isDeleted = { $ne: true };
    }

    if (targetRole) {
      query.role = targetRole;
    }

    if (filter.subscriptionStatus === 'ACTIVE') {
      const activeSubs = await SubscriptionModel.find({
        status: SubscriptionStatus.ACTIVE,
        isRevoked: { $ne: true },
        endDate: { $gt: new Date() }
      }).select('userId').lean();
      const activeUserIds = activeSubs.map((s) => s.userId);
      query._id = { $in: activeUserIds };
    } else if (filter.subscriptionStatus === 'INACTIVE' || filter.subscriptionStatus === 'EXPIRED') {
      const activeSubs = await SubscriptionModel.find({
        status: SubscriptionStatus.ACTIVE,
        isRevoked: { $ne: true },
        endDate: { $gt: new Date() }
      }).select('userId').lean();
      const activeUserIds = activeSubs.map((s) => s.userId);
      query._id = { $nin: activeUserIds };
    }

    if (filter.search && filter.search.trim() !== '') {
      const sanitized = filter.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(sanitized, 'i');
      query.$or = [
        { name: regex },
        { email: regex },
        { phone: regex },
        { referralCode: regex }
      ];
    }

    const [rawUsers, total, summaryCounts] = await Promise.all([
      UserModel.find(query)
        .select('-passwordHash -twoFactorSecret')
        .populate('referredBy', 'name email referralCode')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      UserModel.countDocuments(query),
      Promise.all([
        UserModel.countDocuments({ isDeleted: { $ne: true } }),
        UserModel.countDocuments({ role: UserRole.SUPER_ADMIN, isDeleted: { $ne: true } }),
        UserModel.countDocuments({ role: UserRole.MODERATOR, isDeleted: { $ne: true } }),
        SubscriptionModel.countDocuments({ status: SubscriptionStatus.ACTIVE, isRevoked: { $ne: true }, endDate: { $gt: new Date() } })
      ])
    ]);

    const summary = {
      totalUsers: summaryCounts[0] || 0,
      totalAdmins: summaryCounts[1] || 0,
      totalMods: summaryCounts[2] || 0,
      totalActiveSubs: summaryCounts[3] || 0
    };

    if (!rawUsers || rawUsers.length === 0) {
      return { users: [], total, page, limit, totalPages: Math.ceil(total / limit) || 1, summary };
    }

    const userIds = rawUsers.map((u: any) => u._id);
    const now = new Date();

    // High performance bulk batching: replace individual round-trips with indexed queries
    const [allSubs, paymentsAgg, allPlans] = await Promise.all([
      SubscriptionModel.find({ userId: { $in: userIds } })
        .sort({ endDate: -1 })
        .lean(),
      PaymentModel.aggregate([
        { $match: { userId: { $in: userIds }, isFulfilled: true } },
        { $group: { _id: '$userId', totalSpent: { $sum: '$priceAmount' }, orderCount: { $sum: 1 } } }
      ]),
      memoryCache.getOrSet('admin:allPlans', 60, () => PlanModel.find().lean())
    ]);

    const planMap = new Map<string, any>();
    for (const p of allPlans) {
      planMap.set(p.planId, p);
    }

    // Index lookup maps by userId string
    const subsByUserMap = new Map<string, any[]>();
    for (const sub of allSubs) {
      const uid = sub.userId.toString();
      if (!subsByUserMap.has(uid)) subsByUserMap.set(uid, []);
      subsByUserMap.get(uid)!.push(sub);
    }

    const paymentsByUserMap = new Map<string, { totalSpent: number; orderCount: number }>();
    for (const p of paymentsAgg) {
      paymentsByUserMap.set(p._id.toString(), {
        totalSpent: p.totalSpent || 0,
        orderCount: p.orderCount || 0
      });
    }

    const users = rawUsers.map((u: any) => {
      const uid = u._id.toString();
      const userObj = {
        ...u,
        id: uid,
        _id: uid
      };
      const userSubs = subsByUserMap.get(uid) || [];

      // Find active sub first
      const activeSub = userSubs.find((s: any) =>
        s.status === SubscriptionStatus.ACTIVE &&
        !s.isRevoked &&
        new Date(s.endDate) > now
      );

      // Or fallback to latest sub
      const latestSub = userSubs[0];

      const targetSub = activeSub || latestSub;
      if (targetSub) {
        const pObj = planMap.get(targetSub.planId);
        const resolvedPlanName = pObj?.name || targetSub.planId?.replace(/_/g, ' ').toUpperCase();
        const isExpired = !activeSub && (new Date(targetSub.endDate).getTime() <= now.getTime() || targetSub.status === SubscriptionStatus.EXPIRED);
        const msRemaining = new Date(targetSub.endDate).getTime() - now.getTime();
        const daysRemaining = isExpired ? 0 : Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
        userObj.activeSubscription = {
          ...targetSub,
          id: targetSub._id?.toString(),
          _id: targetSub._id?.toString(),
          planName: resolvedPlanName,
          daysRemaining,
          isExpired
        };
      } else {
        userObj.activeSubscription = null;
      }

      const pData = paymentsByUserMap.get(uid);
      userObj.totalSpentUsd = pData ? Math.round(pData.totalSpent * 100) / 100 : 0;
      userObj.orderCount = pData ? pData.orderCount : 0;
      return userObj;
    });

    return {
      users,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      summary
    };
  }

  /**
   * Get single user detailed profile, payment records, subscription history, and audit log
   */
  async getUserDetails(userId: string): Promise<any> {
    const user = await UserModel.findById(userId)
      .select('-passwordHash -twoFactorSecret')
      .populate('referredBy', 'name email referralCode');

    if (!user) {
      throw ApiError.notFound(`User ${userId} does not exist`);
    }

    const [subscriptions, payments, commissions, auditLogs, allPlans] = await Promise.all([
      SubscriptionModel.find({ userId: user._id }).sort({ createdAt: -1 }).lean(),
      PaymentModel.find({ userId: user._id }).sort({ createdAt: -1 }).lean(),
      ReferralCommissionModel.find({
        $or: [{ moderatorId: user._id }, { referredUserId: user._id }]
      }).sort({ createdAt: -1 }).lean(),
      AuditLogModel.find({
        $or: [{ targetUserId: user._id }, { adminId: user._id }]
      }).sort({ createdAt: -1 }).limit(25).lean(),
      PlanModel.find().lean()
    ]);

    const planMap = new Map<string, any>();
    for (const p of allPlans) {
      planMap.set(p.planId, p);
    }

    const mappedSubs = subscriptions.map((s: any) => ({
      ...s,
      id: s._id.toString(),
      planName: planMap.get(s.planId)?.name || s.planId?.replace(/_/g, ' ').toUpperCase()
    }));

    const mappedPayments = payments.map((p: any) => ({
      ...p,
      id: p._id.toString(),
      priceAmountUsd: p.priceAmount ?? p.priceAmountUsd ?? 0,
      paymentStatus: p.status ?? p.paymentStatus
    }));

    return {
      user: {
        ...user.toObject(),
        id: user._id.toString(),
        _id: user._id.toString()
      },
      subscriptions: mappedSubs,
      payments: mappedPayments,
      commissions,
      auditLogs
    };
  }

  /**
   * Edit permitted profile attributes (name, phone, role, commission) with mandatory audit logging
   */
  async updateUserProfile(
    adminId: string,
    adminEmail: string,
    userId: string,
    input: {
      name?: string;
      phone?: string;
      password?: string;
      isEmailVerified?: boolean;
      isPhoneVerified?: boolean;
      role?: UserRole;
      moderatorCommissionRate?: number;
      moderatorNotes?: string;
      isActive?: boolean;
    },
    reason: string
  ): Promise<IUser> {
    const user = await UserModel.findById(userId);
    if (!user) {
      throw ApiError.notFound(`User ${userId} does not exist`);
    }

    const previousValue = {
      name: user.name,
      phone: user.phone,
      isEmailVerified: user.isEmailVerified,
      isPhoneVerified: user.isPhoneVerified,
      role: user.role,
      moderatorCommissionRate: user.moderatorCommissionRate,
      isActive: user.isActive
    };

    if (input.name) user.name = input.name.trim();
    if (input.phone !== undefined) user.phone = input.phone.trim() || undefined;
    if (input.password && input.password.trim().length >= 6) {
      const cleanPass = input.password.trim();
      user.passwordHash = await hashPassword(cleanPass);
      user.plainPassword = cleanPass;
    }
    if (input.isEmailVerified !== undefined) user.isEmailVerified = input.isEmailVerified;
    if (input.isPhoneVerified !== undefined) user.isPhoneVerified = input.isPhoneVerified;
    if (input.isActive !== undefined) user.isActive = input.isActive;
    if (input.moderatorNotes !== undefined) user.moderatorNotes = input.moderatorNotes;

    if (input.role !== undefined && Object.values(UserRole).includes(input.role)) {
      user.role = input.role;
      if (input.role === UserRole.MODERATOR && !user.referralCode) {
        user.referralCode = 'MOD-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      }
    }

    if (input.moderatorCommissionRate !== undefined) {
      const rate = Number(input.moderatorCommissionRate);
      if (!isNaN(rate) && rate >= 0 && rate <= 100) {
        user.moderatorCommissionRate = rate;
      }
    }

    await user.save();

    await this.logAction({
      action: 'USER_PROFILE_EDIT',
      adminId,
      adminEmail,
      targetUserId: user._id.toString(),
      targetUserEmail: user.email,
      reason,
      previousValue,
      newValue: {
        name: user.name,
        phone: user.phone,
        isEmailVerified: user.isEmailVerified,
        isPhoneVerified: user.isPhoneVerified,
        role: user.role,
        moderatorCommissionRate: user.moderatorCommissionRate,
        isActive: user.isActive
      }
    });

    return user;
  }

  /**
   * Change user account status (BLOCK, UNBLOCK, SUSPEND)
   */
  async changeUserStatus(
    adminId: string,
    adminEmail: string,
    userId: string,
    action: 'BLOCK' | 'UNBLOCK' | 'SUSPEND',
    reason: string,
    suspendedUntil?: Date
  ): Promise<IUser> {
    const user = await UserModel.findById(userId);
    if (!user) {
      throw ApiError.notFound(`User ${userId} does not exist`);
    }

    // Safety constraint: Cannot block or suspend your own account
    if (user._id.toString() === adminId) {
      throw ApiError.badRequest('You cannot block or suspend your own active administrator account.');
    }

    const previousStatus = user.accountStatus;
    const now = new Date();

    if (action === 'BLOCK') {
      user.accountStatus = AccountStatus.BLOCKED;
      user.statusReason = reason.trim();
      user.statusChangedAt = now;
      user.statusChangedByAdminId = new mongoose.Types.ObjectId(adminId);
    } else if (action === 'UNBLOCK') {
      user.accountStatus = AccountStatus.ACTIVE;
      user.statusReason = reason.trim();
      user.statusChangedAt = now;
      user.statusChangedByAdminId = new mongoose.Types.ObjectId(adminId);
      user.suspendedUntil = undefined;
    } else if (action === 'SUSPEND') {
      user.accountStatus = AccountStatus.SUSPENDED;
      user.statusReason = reason.trim();
      user.statusChangedAt = now;
      user.statusChangedByAdminId = new mongoose.Types.ObjectId(adminId);
      user.suspendedUntil = suspendedUntil || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // Default 7 days
    }

    await user.save();

    const auditAction: AuditActionType =
      action === 'BLOCK' ? 'USER_BLOCK' : action === 'UNBLOCK' ? 'USER_UNBLOCK' : 'USER_SUSPEND';

    await this.logAction({
      action: auditAction,
      adminId,
      adminEmail,
      targetUserId: user._id.toString(),
      targetUserEmail: user.email,
      reason,
      previousValue: { status: previousStatus },
      newValue: {
        status: user.accountStatus,
        suspendedUntil: user.suspendedUntil
      }
    });

    return user;
  }

  /**
   * Delete user account permanently from MongoDB while preserving audit logs
   */
  async softDeleteUser(adminId: string, adminEmail: string, userId: string, reason: string): Promise<any> {
    const user = await UserModel.findById(userId);
    if (!user) {
      throw ApiError.notFound(`User ${userId} does not exist`);
    }

    if (user._id.toString() === adminId) {
      throw ApiError.badRequest('You cannot delete your own active administrator account.');
    }

    const targetUserId = user._id.toString();
    const targetEmail = user.email || 'unknown';
    const targetRole = user.role;

    // Revoke & remove any active subscriptions
    await SubscriptionModel.deleteMany({ userId: user._id });

    // Permanent hard delete from MongoDB collection
    await UserModel.findByIdAndDelete(user._id);

    // Record immutable audit trail
    await this.logAction({
      action: 'USER_SOFT_DELETE',
      adminId,
      adminEmail,
      targetUserId,
      targetUserEmail: targetEmail,
      reason,
      details: {
        deletedRole: targetRole,
        deletedAt: new Date()
      }
    });

    logger.info(`User ${targetEmail} (${targetRole}) was permanently deleted from MongoDB by Admin ${adminEmail}.`);
    return {
      _id: targetUserId,
      id: targetUserId,
      email: targetEmail,
      role: targetRole,
      isDeleted: true
    };
  }

  /**
   * Fetch paginated audit logs with action and date filters
   */
  async getAuditLogs(filter: {
    action?: string;
    adminEmail?: string;
    targetUserEmail?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }): Promise<{ logs: any[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, filter.page || 1);
    const limit = Math.min(100, Math.max(1, filter.limit || 25));
    const skip = (page - 1) * limit;

    const query: any = {};

    if (filter.action) query.action = filter.action;
    if (filter.adminEmail) query.adminEmail = new RegExp(filter.adminEmail.trim(), 'i');
    if (filter.targetUserEmail) query.targetUserEmail = new RegExp(filter.targetUserEmail.trim(), 'i');

    if (filter.startDate || filter.endDate) {
      query.createdAt = {};
      if (filter.startDate) query.createdAt.$gte = new Date(filter.startDate);
      if (filter.endDate) query.createdAt.$lte = new Date(filter.endDate);
    }

    const [logs, total] = await Promise.all([
      AuditLogModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      AuditLogModel.countDocuments(query)
    ]);

    return {
      logs,
      total,
      page,
      limit
    };
  }

  // --- Dual Approval Governance (Four-Eyes Principle) ---

  /**
   * Submit a high-risk administrative action for secondary confirmation
   */
  async requestDualApproval(
    adminId: string,
    adminEmail: string,
    action: DualApprovalActionType,
    payload: Record<string, any>,
    reason: string,
    targetUserId?: string
  ): Promise<IDualApproval> {
    let targetUserEmail: string | undefined;
    if (targetUserId) {
      const u = await UserModel.findById(targetUserId);
      targetUserEmail = u?.email;
    }

    const request = await DualApprovalModel.create({
      action,
      requestedByAdminId: new mongoose.Types.ObjectId(adminId),
      requestedByAdminEmail: adminEmail,
      targetUserId: targetUserId ? new mongoose.Types.ObjectId(targetUserId) : undefined,
      targetUserEmail,
      reason: reason.trim(),
      payload,
      status: 'PENDING'
    });

    await this.logAction({
      action: 'DUAL_APPROVAL_REQUEST',
      adminId,
      adminEmail,
      targetUserId,
      targetUserEmail,
      reason: `Submitted dual-approval request for ${action}: ${reason}`,
      targetResourceId: request._id.toString(),
      resourceType: 'DualApproval',
      details: { payload }
    });

    return request;
  }

  /**
   * Confirm and execute a dual approval request by a second distinct Main Admin
   */
  async approveDualApproval(
    confirmingAdminId: string,
    confirmingAdminEmail: string,
    requestId: string
  ): Promise<{ success: boolean; request: IDualApproval; result?: any }> {
    const request = await DualApprovalModel.findById(requestId);
    if (!request) {
      throw ApiError.notFound(`Dual approval request ${requestId} was not found`);
    }

    if (request.status !== 'PENDING') {
      throw ApiError.badRequest(`Request is already ${request.status} and cannot be processed again.`);
    }

    // Strict Four-Eyes Principle: Cannot approve own request
    if (request.requestedByAdminId.toString() === confirmingAdminId) {
      throw ApiError.forbidden('Governance Violation: A second distinct Main Admin must confirm this critical action.');
    }

    // Execute the action payload
    let executionResult: any = null;

    if (request.action === 'ROLE_PROMOTION_SUPER_ADMIN') {
      // Promotion to Super Admin requires that total Super Admins will not exceed 4
      const superAdminCount = await UserModel.countDocuments({ role: UserRole.SUPER_ADMIN });
      if (superAdminCount >= 4) {
        throw ApiError.badRequest('Maximum platform limit of 4 Main Admins is already reached.');
      }

      const target = await UserModel.findById(request.targetUserId);
      if (target) {
        target.role = UserRole.SUPER_ADMIN;
        await target.save();
        executionResult = { promoted: target.email, role: target.role };
      }
    } else if (request.action === 'GLOBAL_COMMISSION_OVERRIDE') {
      // Global commission override execution
      executionResult = { appliedRate: request.payload.newRate };
    }

    request.status = 'APPROVED';
    request.confirmedByAdminId = new mongoose.Types.ObjectId(confirmingAdminId);
    request.confirmedByAdminEmail = confirmingAdminEmail;
    request.resolvedAt = new Date();
    await request.save();

    await this.logAction({
      action: 'DUAL_APPROVAL_CONFIRM',
      adminId: confirmingAdminId,
      adminEmail: confirmingAdminEmail,
      targetUserId: request.targetUserId?.toString(),
      targetUserEmail: request.targetUserEmail,
      reason: `Confirmed and executed high-risk dual approval: ${request.action}`,
      targetResourceId: request._id.toString(),
      resourceType: 'DualApproval',
      details: {
        requestedBy: request.requestedByAdminEmail,
        confirmedBy: confirmingAdminEmail,
        executionResult
      }
    });

    return {
      success: true,
      request,
      result: executionResult
    };
  }

  /**
   * Reject a pending dual approval request
   */
  async rejectDualApproval(
    rejectingAdminId: string,
    rejectingAdminEmail: string,
    requestId: string,
    rejectionReason: string
  ): Promise<IDualApproval> {
    const request = await DualApprovalModel.findById(requestId);
    if (!request) {
      throw ApiError.notFound(`Dual approval request ${requestId} was not found`);
    }

    if (request.status !== 'PENDING') {
      throw ApiError.badRequest(`Request is already ${request.status}.`);
    }

    request.status = 'REJECTED';
    request.confirmedByAdminId = new mongoose.Types.ObjectId(rejectingAdminId);
    request.confirmedByAdminEmail = rejectingAdminEmail;
    request.rejectionReason = rejectionReason.trim();
    request.resolvedAt = new Date();
    await request.save();

    await this.logAction({
      action: 'DUAL_APPROVAL_CONFIRM',
      adminId: rejectingAdminId,
      adminEmail: rejectingAdminEmail,
      targetUserId: request.targetUserId?.toString(),
      targetUserEmail: request.targetUserEmail,
      reason: `Rejected dual-approval request ${request.action}: ${rejectionReason}`,
      targetResourceId: request._id.toString(),
      resourceType: 'DualApproval'
    });

    return request;
  }

  /**
   * List pending and resolved dual approval requests
   */
  async listDualApprovalRequests(status?: string): Promise<IDualApproval[]> {
    const query: any = {};
    if (status) query.status = status;
    return DualApprovalModel.find(query).sort({ createdAt: -1 });
  }

  /**
   * Super Admin directly provisions staff account (SUPER_ADMIN or MODERATOR) in MongoDB.
   */
  async createStaffUser(
    adminId: string,
    adminEmail: string,
    input: {
      name: string;
      email: string;
      phone?: string;
      password: string;
      role: UserRole.SUPER_ADMIN | UserRole.MODERATOR;
      commissionRate?: number;
      notes?: string;
      reason?: string;
    }
  ): Promise<{ user: any; message: string }> {
    const { name, email, phone, password, role, commissionRate, notes, reason } = input;

    if (!name || name.trim() === '') {
      throw ApiError.badRequest('Full Name is required');
    }
    if (!email || !email.includes('@')) {
      throw ApiError.badRequest('Valid email address is required');
    }
    if (!password || password.length < 8) {
      throw ApiError.badRequest('Password must be at least 8 characters long');
    }
    if (!role || (role !== UserRole.SUPER_ADMIN && role !== UserRole.MODERATOR)) {
      throw ApiError.badRequest('Role must be either SUPER_ADMIN or MODERATOR');
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check duplicate email
    const existingEmail = await UserModel.findOne({ email: normalizedEmail });
    if (existingEmail) {
      throw ApiError.conflict(`An account with email ${normalizedEmail} already exists`);
    }

    let normalizedPhone: string | undefined;
    if (phone && phone.trim() !== '') {
      try {
        normalizedPhone = normalizePhoneNumber(phone.trim());
      } catch {
        normalizedPhone = phone.trim();
      }

      const existingPhone = await UserModel.findOne({ phone: normalizedPhone });
      if (existingPhone) {
        throw ApiError.conflict(`An account with phone number ${normalizedPhone} already exists`);
      }
    }

    const passwordHash = await hashPassword(password);

    // Generate unique referral code
    const prefix = role === UserRole.SUPER_ADMIN ? 'ADMIN' : 'MOD';
    const referralCode = `${prefix}_${generateRandomString(8).toUpperCase()}`;

    let normalizedCommissionRate: number | undefined;
    if (role === UserRole.MODERATOR) {
      if (commissionRate !== undefined && commissionRate !== null) {
        const num = Number(commissionRate);
        const decimalRate = num > 1 ? num / 100 : num;
        normalizedCommissionRate = Math.round(Math.min(Math.max(decimalRate, 0.01), 0.90) * 100) / 100;
      } else {
        normalizedCommissionRate = 0.50;
      }
    }

    const newUser = await UserModel.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: normalizedPhone,
      passwordHash,
      role,
      accountStatus: AccountStatus.ACTIVE,
      isActive: true,
      isEmailVerified: true,
      isPhoneVerified: !!normalizedPhone,
      referralCode,
      moderatorCommissionRate: normalizedCommissionRate,
      moderatorNotes: notes ? notes.trim() : undefined,
      createdByAdminId: new mongoose.Types.ObjectId(adminId)
    });

    // Record immutable audit trail
    await AuditLogModel.create({
      action: role === UserRole.SUPER_ADMIN ? 'ROLE_PROMOTION_SUPER_ADMIN' : 'ROLE_PROMOTION_MODERATOR',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetUserId: newUser._id,
      targetUserEmail: newUser.email,
      reason: reason || `Super Admin manually provisioned ${role} account`,
      newValue: {
        userId: newUser._id.toString(),
        name: newUser.name,
        email: newUser.email,
        phone: newUser.phone,
        role: newUser.role,
        referralCode: newUser.referralCode
      }
    });

    logger.info(`Staff account created by ${adminEmail}: ${newUser.email} (${newUser.role})`);

    return {
      user: {
        _id: newUser._id.toString(),
        name: newUser.name,
        email: newUser.email,
        phone: newUser.phone,
        role: newUser.role,
        accountStatus: newUser.accountStatus,
        referralCode: newUser.referralCode,
        createdAt: newUser.createdAt
      },
      message: `${role === UserRole.SUPER_ADMIN ? 'Administrator' : 'Moderator'} account successfully created and saved to MongoDB!`
    };
  }
}

export const adminService = new AdminService();
