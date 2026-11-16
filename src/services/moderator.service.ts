import mongoose from 'mongoose';
import { UserModel, IUser, AccountStatus } from '../models/User';
import { ReferralCommissionModel, IReferralCommission, CommissionStatus } from '../models/ReferralCommission';
import { CommissionPolicyModel } from '../models/CommissionPolicy';
import { AuditLogModel } from '../models/AuditLog';
import { PaymentModel } from '../models/Payment';
import { SubscriptionModel } from '../models/Subscription';
import { UserRole } from '../shared/roles';
import { hashPassword, generateRandomString } from '../utils/crypto';
import { normalizePhoneNumber } from '../utils/phone';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import { ReferralClickModel } from '../models/ReferralClick';
import { cacheKeys, memoryCache } from '../utils/cache';

export interface CreateModeratorInput {
  name: string;
  email: string;
  phone?: string;
  password: string;
  commissionRate?: number;
  notes?: string;
}

export interface ModeratorPerformanceSummary {
  moderatorId: string;
  name: string;
  email: string;
  phone?: string;
  referralCode: string;
  referralLink: string;
  accountStatus: AccountStatus;
  isActive: boolean;
  commissionRate: number;
  totalReferrals: number;
  qualifiedCustomers: number;
  totalSalesCount: number;
  totalAttributedRevenueUsd: number;
  pendingCommissionUsd: number;
  eligibleCommissionUsd: number;
  approvedCommissionUsd: number;
  reversedCommissionUsd: number;
  createdAt: Date;
}

export class ModeratorService {
  /**
   * Helper: Generate a unique, unguessable referral code for a Moderator.
   * Format: MOD_<8 random hex chars uppercase>, e.g. MOD_8F2A9C1D
   */
  async generateUniqueModeratorReferralCode(): Promise<string> {
    for (let attempts = 0; attempts < 10; attempts++) {
      const code = `MOD_${generateRandomString(8).toUpperCase()}`;
      const existing = await UserModel.findOne({ referralCode: code });
      if (!existing) {
        return code;
      }
    }
    // Fallback if collision
    return `MOD_${Date.now().toString(36).toUpperCase()}_${generateRandomString(4).toUpperCase()}`;
  }

  /**
   * Helper: Privacy mask for customer email / phone
   */
  private maskIdentifier(identifier?: string): string {
    if (!identifier) return 'Anonymous';
    if (identifier.includes('@')) {
      const [name, domain] = identifier.split('@');
      if (name.length <= 2) return `${name}***@${domain}`;
      return `${name.slice(0, 2)}***${name.slice(-1)}@${domain}`;
    }
    if (identifier.length > 5) {
      return `${identifier.slice(0, 3)}****${identifier.slice(-3)}`;
    }
    return '****';
  }

  // =========================================================================
  // MAIN ADMIN CAPABILITIES
  // =========================================================================

  /**
   * 1. Create a Moderator account
   */
  async createModerator(
    adminId: string,
    adminEmail: string,
    input: CreateModeratorInput
  ): Promise<{ moderator: Partial<IUser>; referralCode: string; temporaryPassword?: string }> {
    const { name, email, phone, password, commissionRate, notes } = input;

    if (!name || name.trim() === '') {
      throw ApiError.badRequest('Moderator name is required');
    }
    if (!email || !email.includes('@')) {
      throw ApiError.badRequest('Valid email is required');
    }
    if (!password || password.length < 8) {
      throw ApiError.badRequest('Password must be at least 8 characters long');
    }

    const normalizedEmail = email.trim().toLowerCase();
    let normalizedPhone: string | undefined;

    if (phone && phone.trim() !== '') {
      try {
        normalizedPhone = normalizePhoneNumber(phone.trim());
      } catch {
        normalizedPhone = phone.trim();
      }
    }

    // Check email uniqueness
    const existingEmail = await UserModel.findOne({ email: normalizedEmail, isDeleted: false });
    if (existingEmail) {
      throw ApiError.conflict('An account with this email address already exists');
    }

    if (normalizedPhone) {
      const existingPhone = await UserModel.findOne({ phone: normalizedPhone, isDeleted: false });
      if (existingPhone) {
        throw ApiError.conflict('An account with this phone number already exists');
      }
    }

    // Validate commission rate if custom
    let validRate: number | undefined;
    if (commissionRate !== undefined && commissionRate !== null) {
      if (commissionRate < 0.01 || commissionRate > 0.90) {
        throw ApiError.badRequest('Commission rate must be between 1% (0.01) and 90% (0.90)');
      }
      validRate = Math.round(commissionRate * 100) / 100;
    }

    const referralCode = await this.generateUniqueModeratorReferralCode();
    const passwordHash = await hashPassword(password);

    const moderator = await UserModel.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: normalizedPhone,
      passwordHash,
      role: UserRole.MODERATOR,
      isEmailVerified: true,
      isPhoneVerified: !!normalizedPhone,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE,
      referralCode,
      moderatorCommissionRate: validRate,
      moderatorNotes: notes?.trim()
    });

    await AuditLogModel.create({
      action: 'MODERATOR_CREATE',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetUserId: moderator._id,
      targetUserEmail: moderator.email,
      reason: 'Main Admin provisioned new Moderator account',
      details: {
        moderatorId: moderator._id.toString(),
        referralCode,
        commissionRate: validRate ?? 0.50,
        notes: notes?.trim()
      }
    });

    logger.info(`Main Admin ${adminEmail} created Moderator ${moderator.email} (Code: ${referralCode})`);

    return {
      moderator: {
        id: moderator._id.toString() as any,
        name: moderator.name,
        email: moderator.email,
        phone: moderator.phone,
        role: moderator.role,
        isActive: moderator.isActive,
        accountStatus: moderator.accountStatus,
        referralCode: moderator.referralCode,
        moderatorCommissionRate: moderator.moderatorCommissionRate
      },
      referralCode,
      temporaryPassword: password
    };
  }

  /**
   * 2. List all Moderators with aggregated referral performance
   */
  async listModerators(options: {
    search?: string;
    status?: string;
    page?: number;
    limit?: number;
    baseUrl?: string;
  }): Promise<{
    moderators: ModeratorPerformanceSummary[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.max(1, Math.min(100, options.limit || 20));
    const skip = (page - 1) * limit;
    const origin = options.baseUrl || 'http://localhost:3000';

    const query: Record<string, any> = {
      role: UserRole.MODERATOR,
      isDeleted: false
    };

    if (options.status && options.status !== 'ALL') {
      query.accountStatus = options.status;
    }

    if (options.search && options.search.trim() !== '') {
      const cleanSearch = options.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(cleanSearch, 'i');
      query.$or = [{ name: regex }, { email: regex }, { phone: regex }, { referralCode: regex }];
    }

    const [moderators, total] = await Promise.all([
      UserModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      UserModel.countDocuments(query)
    ]);

    const activePolicy = await CommissionPolicyModel.getActivePolicy();
    const defaultRate = activePolicy.defaultRate;
    const moderatorIds = moderators.map((mod) => mod._id);

    const [referredCounts, commissionRows] = await Promise.all([
      UserModel.aggregate([
        { $match: { referredBy: { $in: moderatorIds }, isDeleted: false } },
        { $group: { _id: '$referredBy', count: { $sum: 1 } } }
      ]),
      ReferralCommissionModel.find({ moderatorId: { $in: moderatorIds } })
        .select('moderatorId status amountUsd originalPurchaseAmount commissionableAmount commissionRate referredUserId')
        .lean()
    ]);

    const referralCountMap = new Map<string, number>();
    for (const row of referredCounts) {
      referralCountMap.set(String(row._id), row.count || 0);
    }

    const commissionsByModerator = new Map<string, any[]>();
    for (const commission of commissionRows as any[]) {
      const key = String(commission.moderatorId);
      if (!commissionsByModerator.has(key)) commissionsByModerator.set(key, []);
      commissionsByModerator.get(key)!.push(commission);
    }

    const summaries: ModeratorPerformanceSummary[] = moderators.map((mod) => {
      const modId = mod._id;
      const totalReferrals = referralCountMap.get(String(modId)) || 0;
      const commissions = commissionsByModerator.get(String(modId)) || [];

      let totalSalesCount = 0;
      let totalAttributedRevenueUsd = 0;
      let pendingCommissionUsd = 0;
      let eligibleCommissionUsd = 0;
      let approvedCommissionUsd = 0;
      let reversedCommissionUsd = 0;
      const buyerSet = new Set<string>();

      for (const c of commissions) {
        if (c.status === 'REVERSED') {
          reversedCommissionUsd += c.amountUsd;
        } else {
          totalSalesCount++;
          const rev = c.originalPurchaseAmount ?? c.commissionableAmount ?? (c.commissionRate > 0 ? c.amountUsd / c.commissionRate : c.amountUsd * 2);
          totalAttributedRevenueUsd += rev;
          buyerSet.add(c.referredUserId.toString());

          if (c.status === 'PENDING') {
            pendingCommissionUsd += c.amountUsd;
          } else if (c.status === 'ELIGIBLE') {
            eligibleCommissionUsd += c.amountUsd;
          } else if (c.status === 'APPROVED' || c.status === 'CREDITED') {
            approvedCommissionUsd += c.amountUsd;
          }
        }
      }

      return {
        moderatorId: modId.toString(),
        name: mod.name,
        email: mod.email || '',
        phone: mod.phone,
        referralCode: mod.referralCode || '',
        referralLink: `${origin}/gerister?ref=${mod.referralCode}`,
        accountStatus: mod.accountStatus,
        isActive: mod.isActive,
        commissionRate: mod.moderatorCommissionRate ?? defaultRate,
        totalReferrals,
        qualifiedCustomers: buyerSet.size,
        totalSalesCount,
        totalAttributedRevenueUsd: Math.round(totalAttributedRevenueUsd * 100) / 100,
        pendingCommissionUsd: Math.round(pendingCommissionUsd * 100) / 100,
        eligibleCommissionUsd: Math.round(eligibleCommissionUsd * 100) / 100,
        approvedCommissionUsd: Math.round(approvedCommissionUsd * 100) / 100,
        reversedCommissionUsd: Math.round(reversedCommissionUsd * 100) / 100,
        createdAt: mod.createdAt
      };
    });

    return {
      moderators: summaries,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  }

  /**
   * 3. Get detailed Moderator profile and performance
   */
  async getModeratorDetails(moderatorId: string, baseUrl?: string): Promise<any> {
    const origin = baseUrl || 'http://localhost:3000';
    const moderator = await UserModel.findOne({
      _id: moderatorId,
      role: UserRole.MODERATOR,
      isDeleted: false
    });

    if (!moderator) {
      throw ApiError.notFound('Moderator not found');
    }

    const activePolicy = await CommissionPolicyModel.getActivePolicy();
    const defaultRate = activePolicy.defaultRate;
    const rate = moderator.moderatorCommissionRate ?? defaultRate;

    // Load commissions
    const commissions = await ReferralCommissionModel.find({ moderatorId: moderator._id })
      .populate('referredUserId', 'name email phone createdAt')
      .populate('paymentId', 'orderId planId planName priceAmount status createdAt')
      .sort({ createdAt: -1 });

    // Load referred users
    const referredUsers = await UserModel.find({ referredBy: moderator._id, isDeleted: false })
      .select('name email phone accountStatus isEmailVerified isPhoneVerified createdAt')
      .sort({ createdAt: -1 })
      .limit(50);

    let totalSalesCount = 0;
    let totalAttributedRevenueUsd = 0;
    let pendingCommissionUsd = 0;
    let eligibleCommissionUsd = 0;
    let approvedCommissionUsd = 0;
    let reversedCommissionUsd = 0;
    const buyerSet = new Set<string>();

    for (const c of commissions) {
      if (c.status === 'REVERSED') {
        reversedCommissionUsd += c.amountUsd;
      } else {
        totalSalesCount++;
        const rev = c.originalPurchaseAmount ?? c.commissionableAmount ?? (c.commissionRate > 0 ? c.amountUsd / c.commissionRate : c.amountUsd * 2);
        totalAttributedRevenueUsd += rev;
        buyerSet.add(c.referredUserId ? c.referredUserId.toString() : '');

        if (c.status === 'PENDING') {
          pendingCommissionUsd += c.amountUsd;
        } else if (c.status === 'ELIGIBLE') {
          eligibleCommissionUsd += c.amountUsd;
        } else if (c.status === 'APPROVED' || c.status === 'CREDITED') {
          approvedCommissionUsd += c.amountUsd;
        }
      }
    }

    // Recent audit logs for this moderator
    const auditLogs = await AuditLogModel.find({
      $or: [{ targetUserId: moderator._id }, { adminId: moderator._id }]
    })
      .sort({ createdAt: -1 })
      .limit(20);

    return {
      moderator: {
        id: moderator._id.toString(),
        name: moderator.name,
        email: moderator.email,
        phone: moderator.phone,
        role: moderator.role,
        accountStatus: moderator.accountStatus,
        isActive: moderator.isActive,
        referralCode: moderator.referralCode,
        referralLink: `${origin}/gerister?ref=${moderator.referralCode}`,
        commissionRate: rate,
        isCustomRate: moderator.moderatorCommissionRate !== undefined,
        notes: moderator.moderatorNotes,
        createdAt: moderator.createdAt,
        lastLoginAt: moderator.lastLoginAt
      },
      metrics: {
        totalReferrals: referredUsers.length,
        qualifiedCustomers: buyerSet.size,
        totalSalesCount,
        totalAttributedRevenueUsd: Math.round(totalAttributedRevenueUsd * 100) / 100,
        pendingCommissionUsd: Math.round(pendingCommissionUsd * 100) / 100,
        eligibleCommissionUsd: Math.round(eligibleCommissionUsd * 100) / 100,
        approvedCommissionUsd: Math.round(approvedCommissionUsd * 100) / 100,
        reversedCommissionUsd: Math.round(reversedCommissionUsd * 100) / 100
      },
      commissions,
      referredUsers,
      auditLogs
    };
  }

  /**
   * 4. Update Moderator account status (Activate / Deactivate / Suspend)
   */
  async updateModeratorStatus(
    adminId: string,
    adminEmail: string,
    moderatorId: string,
    status: AccountStatus,
    reason: string,
    suspendedUntil?: Date
  ): Promise<IUser> {
    if (!reason || reason.trim() === '') {
      throw ApiError.badRequest('Audit reason is strictly required when modifying Moderator status');
    }

    const moderator = await UserModel.findOne({
      _id: moderatorId,
      role: UserRole.MODERATOR,
      isDeleted: false
    });

    if (!moderator) {
      throw ApiError.notFound('Moderator not found');
    }

    const prevStatus = moderator.accountStatus;
    moderator.accountStatus = status;
    moderator.isActive = status === AccountStatus.ACTIVE;
    moderator.statusReason = reason.trim();
    moderator.statusChangedAt = new Date();
    moderator.statusChangedByAdminId = new mongoose.Types.ObjectId(adminId);

    if (status === AccountStatus.SUSPENDED) {
      moderator.suspendedUntil = suspendedUntil || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    } else {
      moderator.suspendedUntil = undefined;
    }

    await moderator.save();

    await AuditLogModel.create({
      action: 'MODERATOR_STATUS_CHANGE',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetUserId: moderator._id,
      targetUserEmail: moderator.email,
      reason: reason.trim(),
      previousValue: { accountStatus: prevStatus },
      newValue: { accountStatus: status, suspendedUntil: moderator.suspendedUntil },
      details: { moderatorId: moderator._id.toString() }
    });

    logger.info(`Main Admin ${adminEmail} changed Moderator ${moderator.email} status to ${status}. Reason: ${reason}`);

    return moderator;
  }

  /**
   * 5. Reset Moderator access credentials
   */
  async resetModeratorPassword(
    adminId: string,
    adminEmail: string,
    moderatorId: string,
    newPassword?: string,
    reason?: string
  ): Promise<{ temporaryPassword?: string }> {
    if (!reason || reason.trim() === '') {
      throw ApiError.badRequest('Audit reason is required when resetting Moderator credentials');
    }

    const moderator = await UserModel.findOne({
      _id: moderatorId,
      role: UserRole.MODERATOR,
      isDeleted: false
    });

    if (!moderator) {
      throw ApiError.notFound('Moderator not found');
    }

    const generatedPassword = newPassword && newPassword.length >= 8
      ? newPassword
      : `Mod_Pass_${generateRandomString(10)}!`;

    moderator.passwordHash = await hashPassword(generatedPassword);
    await moderator.save();

    await AuditLogModel.create({
      action: 'MODERATOR_RESET_PASSWORD',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetUserId: moderator._id,
      targetUserEmail: moderator.email,
      reason: reason.trim(),
      details: { moderatorId: moderator._id.toString() }
    });

    logger.info(`Main Admin ${adminEmail} reset password for Moderator ${moderator.email}`);

    return { temporaryPassword: generatedPassword };
  }

  /**
   * 6. Update Moderator commission rate for FUTURE eligible sales
   * (Preserves historical snapshots; does NOT rewrite past commissions)
   */
  async updateModeratorCommissionRate(
    adminId: string,
    adminEmail: string,
    moderatorId: string,
    newRate: number,
    reason: string
  ): Promise<{ moderatorId: string; previousRate: number; newRate: number }> {
    if (!reason || reason.trim() === '') {
      throw ApiError.badRequest('Audit reason is required when changing commission rates');
    }

    const admin = await UserModel.findById(adminId);
    if (!admin || admin.role !== UserRole.SUPER_ADMIN) {
      throw ApiError.forbidden('Only authorized Main Admins can change commission rates');
    }

    if (newRate < 0.01 || newRate > 0.90) {
      throw ApiError.badRequest('Commission rate must be between 1% (0.01) and 90% (0.90)');
    }

    const moderator = await UserModel.findOne({
      _id: moderatorId,
      role: UserRole.MODERATOR,
      isDeleted: false
    });

    if (!moderator) {
      throw ApiError.notFound('Moderator not found');
    }

    const activePolicy = await CommissionPolicyModel.getActivePolicy();
    const prevRate = moderator.moderatorCommissionRate ?? activePolicy.defaultRate;
    const roundedRate = Math.round(newRate * 100) / 100;

    moderator.moderatorCommissionRate = roundedRate;
    await moderator.save();

    await AuditLogModel.create({
      action: 'COMMISSION_CONFIG_UPDATE',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetUserId: moderator._id,
      targetUserEmail: moderator.email,
      reason: reason.trim(),
      previousValue: { commissionRate: prevRate },
      newValue: { commissionRate: roundedRate },
      details: {
        moderatorId: moderator._id.toString(),
        note: 'Rate applied strictly to future eligible sales; historical snapshot preserved'
      }
    });

    logger.info(
      `Main Admin ${adminEmail} updated commission rate for Moderator ${moderator.email} from ${prevRate} to ${roundedRate}`
    );

    return {
      moderatorId: moderator._id.toString(),
      previousRate: prevRate,
      newRate: roundedRate
    };
  }

  // =========================================================================
  // REFERRALS & COMMISSIONS TELEMETRY (MAIN ADMIN)
  // =========================================================================

  /**
   * 7. Global referral performance overview
   */
  async getReferralOverview(): Promise<any> {
    const totalModerators = await UserModel.countDocuments({
      role: UserRole.MODERATOR,
      isDeleted: false
    });

    const activeModerators = await UserModel.countDocuments({
      role: UserRole.MODERATOR,
      accountStatus: AccountStatus.ACTIVE,
      isDeleted: false
    });

    const totalReferredUsers = await UserModel.countDocuments({
      referredBy: { $exists: true, $ne: null },
      isDeleted: false
    });

    const commissions = await ReferralCommissionModel.find();
    let totalAttributedOrders = 0;
    let totalAttributedRevenueUsd = 0;
    let totalPendingCommissionUsd = 0;
    let totalEligibleCommissionUsd = 0;
    let totalApprovedCommissionUsd = 0;
    let totalReversedCommissionUsd = 0;

    for (const c of commissions) {
      if (c.status === 'REVERSED') {
        totalReversedCommissionUsd += c.amountUsd;
      } else {
        totalAttributedOrders++;
        const rev = c.originalPurchaseAmount ?? c.commissionableAmount ?? (c.commissionRate > 0 ? c.amountUsd / c.commissionRate : c.amountUsd * 2);
        totalAttributedRevenueUsd += rev;

        if (c.status === 'PENDING') {
          totalPendingCommissionUsd += c.amountUsd;
        } else if (c.status === 'ELIGIBLE') {
          totalEligibleCommissionUsd += c.amountUsd;
        } else if (c.status === 'APPROVED' || c.status === 'CREDITED') {
          totalApprovedCommissionUsd += c.amountUsd;
        }
      }
    }

    const activePolicy = await CommissionPolicyModel.getActivePolicy();

    return {
      totalModerators,
      activeModerators,
      totalReferredUsers,
      totalAttributedOrders,
      totalAttributedRevenueUsd: Math.round(totalAttributedRevenueUsd * 100) / 100,
      totalPendingCommissionUsd: Math.round(totalPendingCommissionUsd * 100) / 100,
      totalEligibleCommissionUsd: Math.round(totalEligibleCommissionUsd * 100) / 100,
      totalApprovedCommissionUsd: Math.round(totalApprovedCommissionUsd * 100) / 100,
      totalReversedCommissionUsd: Math.round(totalReversedCommissionUsd * 100) / 100,
      globalCommissionPolicy: {
        defaultRate: activePolicy.defaultRate,
        normalUserRate: activePolicy.normalUserRate ?? 0.30,
        moderatorRate: activePolicy.moderatorRate ?? activePolicy.defaultRate ?? 0.50,
        referralEnabled: activePolicy.referralEnabled !== false,
        normalUserCommissionType: 'ONE_TIME',
        moderatorCommissionType: 'LIFETIME',
        commissionableBasis: activePolicy.commissionableBasis,
        description: activePolicy.description,
        effectiveFrom: activePolicy.effectiveFrom
      }
    };
  }

  /**
   * 8. List and search commissions across the platform
   */
  async listCommissions(query: {
    moderatorId?: string;
    status?: string;
    commissionType?: string;
    search?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    commissions: any[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const page = Math.max(1, query.page || 1);
    const limit = Math.max(1, Math.min(100, query.limit || 20));
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = {};

    if (query.moderatorId && query.moderatorId !== 'ALL') {
      filter.moderatorId = new mongoose.Types.ObjectId(query.moderatorId);
    }

    if (query.status && query.status !== 'ALL') {
      filter.status = query.status;
    }

    if (query.commissionType && query.commissionType !== 'ALL') {
      filter.commissionType = query.commissionType;
    }

    if (query.startDate || query.endDate) {
      filter.createdAt = {};
      if (query.startDate) filter.createdAt.$gte = new Date(query.startDate);
      if (query.endDate) filter.createdAt.$lte = new Date(query.endDate);
    }

    if (query.search && query.search.trim() !== '') {
      const cleanSearch = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(cleanSearch, 'i');
      const users = await UserModel.find({
        $or: [{ name: regex }, { email: regex }, { phone: regex }]
      })
        .select('_id')
        .lean();
      const userIds = users.map((u) => u._id);
      filter.$or = [
        { purchaseId: regex },
        { subscriptionPlan: regex },
        { moderatorId: { $in: userIds } },
        { referredUserId: { $in: userIds } }
      ];
    }

    const [commissions, total] = await Promise.all([
      ReferralCommissionModel.find(filter)
        .populate('moderatorId', 'name email referralCode role referralCommissionRate referralCommissionType')
        .populate('referredUserId', 'name email phone role')
        .populate('paymentId', 'orderId planId priceAmount status payCurrency createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      ReferralCommissionModel.countDocuments(filter)
    ]);

    return {
      commissions,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  }

  /**
   * 9. Transition Commission state (Approve, Reverse, etc.) with mandatory audit reason
   */
  async updateCommissionStatus(
    adminId: string,
    adminEmail: string,
    commissionId: string,
    newStatus: CommissionStatus,
    reason: string
  ): Promise<IReferralCommission> {
    if (!reason || reason.trim() === '') {
      throw ApiError.badRequest('Audit reason is required to adjust commission records');
    }

    const admin = await UserModel.findById(adminId);
    if (!admin || admin.role !== UserRole.SUPER_ADMIN) {
      throw ApiError.forbidden('Only authorized Main Admins can change commission status');
    }

    const commission = await ReferralCommissionModel.findById(commissionId);
    if (!commission) {
      throw ApiError.notFound('Commission record not found');
    }

    const prevStatus = commission.status as CommissionStatus;

    // Supported transitions validation
    const allowedTransitions: Record<CommissionStatus, CommissionStatus[]> = {
      PENDING: ['ELIGIBLE', 'APPROVED', 'CREDITED', 'REVERSED'],
      ELIGIBLE: ['APPROVED', 'CREDITED', 'REVERSED'],
      APPROVED: ['REVERSED'],
      CREDITED: ['REVERSED'],
      REVERSED: [] // Terminal state
    };

    if (prevStatus === 'REVERSED') {
      throw ApiError.badRequest('Reversed commission records cannot be re-activated without authorized dual approval');
    }

    if (!allowedTransitions[prevStatus] || !allowedTransitions[prevStatus].includes(newStatus)) {
      throw ApiError.badRequest(`Unsupported commission transition from ${prevStatus} to ${newStatus}`);
    }

    commission.status = newStatus;

    if (newStatus === 'REVERSED') {
      commission.reversalDetails = {
        reversedAt: new Date(),
        reversedByAdminId: new mongoose.Types.ObjectId(adminId),
        reversedByAdminEmail: adminEmail,
        reason: reason.trim()
      };
    }

    await commission.save();

    await AuditLogModel.create({
      action: 'COMMISSION_STATUS_CHANGE',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetResourceId: commission._id.toString(),
      resourceType: 'ReferralCommission',
      reason: reason.trim(),
      previousValue: { status: prevStatus },
      newValue: { status: newStatus },
      details: {
        commissionId: commission._id.toString(),
        moderatorId: commission.moderatorId.toString(),
        amountUsd: commission.amountUsd
      }
    });

    logger.info(`Main Admin ${adminEmail} transitioned Commission ${commissionId} from ${prevStatus} to ${newStatus}`);

    return commission;
  }

  /**
   * 9b. Manual Commission Adjustment (with mandatory audit reason and logging)
   */
  async adjustCommission(
    adminId: string,
    adminEmail: string,
    commissionId: string,
    input: {
      newAmountUsd?: number;
      newStatus?: CommissionStatus;
      reason: string;
      notes?: string;
    }
  ): Promise<IReferralCommission> {
    if (!input.reason || input.reason.trim() === '') {
      throw ApiError.badRequest('Audit reason is strictly required for manual commission adjustments');
    }

    const admin = await UserModel.findById(adminId);
    if (!admin || admin.role !== UserRole.SUPER_ADMIN) {
      throw ApiError.forbidden('Only authorized Main Admins can adjust commissions');
    }

    const commission = await ReferralCommissionModel.findById(commissionId);
    if (!commission) {
      throw ApiError.notFound('Commission record not found');
    }

    const prevSnapshot = {
      amountUsd: commission.amountUsd,
      status: commission.status,
      notes: commission.notes
    };

    if (input.newStatus && input.newStatus !== commission.status) {
      if (commission.status === 'REVERSED') {
        throw ApiError.badRequest('Reversed commission records cannot be re-activated without authorized dual approval');
      }
      commission.status = input.newStatus;
      if (input.newStatus === 'REVERSED') {
        commission.reversalDetails = {
          reversedAt: new Date(),
          reversedByAdminId: new mongoose.Types.ObjectId(adminId),
          reversedByAdminEmail: adminEmail,
          reason: input.reason.trim()
        };
      }
    }

    if (input.newAmountUsd !== undefined) {
      if (input.newAmountUsd < 0) {
        throw ApiError.badRequest('Commission amount cannot be negative');
      }
      commission.amountUsd = Math.round(input.newAmountUsd * 100) / 100;
    }

    if (input.notes) {
      commission.notes = input.notes.trim();
    }

    await commission.save();

    await AuditLogModel.create({
      action: 'COMMISSION_ADJUSTMENT',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetResourceId: commission._id.toString(),
      resourceType: 'ReferralCommission',
      reason: input.reason.trim(),
      previousValue: prevSnapshot,
      newValue: {
        amountUsd: commission.amountUsd,
        status: commission.status,
        notes: commission.notes
      },
      details: {
        commissionId: commission._id.toString(),
        moderatorId: commission.moderatorId.toString(),
        purchaseId: commission.purchaseId
      }
    });

    logger.info(`Main Admin ${adminEmail} adjusted Commission ${commissionId}. Reason: ${input.reason}`);
    return commission;
  }

  /**
   * 9c. Referral relationships (normal users and moderators)
   */
  async listReferralRelationships(options: {
    search?: string;
    referrerRole?: string;
    page?: number;
    limit?: number;
  }): Promise<any> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 25));
    const query: Record<string, any> = {
      referredBy: { $exists: true, $ne: null },
      isDeleted: { $ne: true }
    };

    if (options.referrerRole && options.referrerRole !== 'ALL') {
      const referrers = await UserModel.find({
        role: options.referrerRole,
        isDeleted: { $ne: true }
      })
        .select('_id')
        .lean();
      query.referredBy = { $in: referrers.map((r) => r._id) };
    }

    if (options.search && options.search.trim()) {
      const escaped = options.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      const users = await UserModel.find({
        $or: [{ name: regex }, { email: regex }, { referralCode: regex }]
      })
        .select('_id')
        .lean();
      const ids = users.map((u) => u._id);
      query.$or = [
        { _id: { $in: ids } },
        { referredBy: { $in: ids } },
        { name: regex },
        { email: regex },
        { referralCodeUsed: regex }
      ];
    }

    const [relationships, total] = await Promise.all([
      UserModel.find(query)
        .populate('referredBy', 'name email role referralCode referralCommissionRate referralCommissionType referralEligible')
        .select('name email phone role referralCodeUsed referredAt createdAt accountStatus')
        .sort({ referredAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      UserModel.countDocuments(query)
    ]);

    const userIds = relationships.map((r: any) => r._id);
    const commissions = await ReferralCommissionModel.find({ referredUserId: { $in: userIds } })
      .select('referredUserId amountUsd status commissionType paymentId')
      .lean();
    const commissionMap = new Map<string, any[]>();
    for (const commission of commissions as any[]) {
      const key = commission.referredUserId.toString();
      if (!commissionMap.has(key)) commissionMap.set(key, []);
      commissionMap.get(key)!.push(commission);
    }

    return {
      relationships: (relationships as any[]).map((relationship) => {
        const rows = commissionMap.get(relationship._id.toString()) || [];
        return {
          ...relationship,
          referredUserId: relationship._id,
          commissions: rows,
          successfulPurchases: rows.filter((row) => row.status !== 'REVERSED').length,
          commissionEarnedUsd: Math.round(
            rows
              .filter((row) => row.status === 'CREDITED' || row.status === 'APPROVED')
              .reduce((sum, row) => sum + (row.amountUsd || 0), 0) * 100
          ) / 100
        };
      }),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit))
    };
  }

  /**
   * 10. Export Commissions report to CSV
   */
  async exportCommissionsCsv(query: { moderatorId?: string; status?: string }): Promise<string> {
    const filter: Record<string, any> = {};
    if (query.moderatorId && query.moderatorId !== 'ALL') {
      filter.moderatorId = new mongoose.Types.ObjectId(query.moderatorId);
    }
    if (query.status && query.status !== 'ALL') {
      filter.status = query.status;
    }

    const commissions = await ReferralCommissionModel.find(filter)
      .populate('moderatorId', 'name email referralCode')
      .populate('referredUserId', 'email')
      .sort({ createdAt: -1 });

    const rows: string[] = [
      'Commission ID,Date,Moderator Name,Moderator Email,Customer Email,Order ID,Plan,Purchase Amount USD,Commissionable USD,Commission Rate,Commission Earned USD,Status,Reversal Reason'
    ];

    for (const c of commissions as any[]) {
      const line = [
        `"${c._id.toString()}"`,
        `"${c.createdAt ? c.createdAt.toISOString() : ''}"`,
        `"${(c.moderatorId?.name || '').replace(/"/g, '""')}"`,
        `"${c.moderatorId?.email || ''}"`,
        `"${c.referredUserId?.email || ''}"`,
        `"${c.purchaseId || ''}"`,
        `"${c.subscriptionPlan || ''}"`,
        `"${c.originalPurchaseAmount ?? 0}"`,
        `"${c.commissionableAmount ?? 0}"`,
        `"${c.commissionRate ? (c.commissionRate * 100).toFixed(0) + '%' : '50%'}"`,
        `"${c.amountUsd ?? 0}"`,
        `"${c.status}"`,
        `"${(c.reversalDetails?.reason || '').replace(/"/g, '""')}"`
      ];
      rows.push(line.join(','));
    }

    return rows.join('\n');
  }

  /**
   * 11. Update Global Commission Policy (future sales default rate)
   */
  async updateGlobalCommissionPolicy(
    adminId: string,
    adminEmail: string,
    newRate: number,
    reason: string,
    normalUserRate?: number,
    referralEnabled?: boolean
  ): Promise<any> {
    if (!reason || reason.trim() === '') {
      throw ApiError.badRequest('Audit reason required to update platform commission policy');
    }

    const admin = await UserModel.findById(adminId);
    if (!admin || admin.role !== UserRole.SUPER_ADMIN) {
      throw ApiError.forbidden('Only authorized Main Admins can change global commission policy');
    }

    if (newRate < 0.05 || newRate > 0.90) {
      throw ApiError.badRequest('Moderator default commission rate must be between 5% (0.05) and 90% (0.90)');
    }
    if (normalUserRate !== undefined && (normalUserRate < 0.01 || normalUserRate > 0.90)) {
      throw ApiError.badRequest('Normal user commission rate must be between 1% (0.01) and 90% (0.90)');
    }

    const prevPolicy = await CommissionPolicyModel.getActivePolicy();
    const roundedRate = Math.round(newRate * 100) / 100;
    const roundedNormalRate = Math.round((normalUserRate ?? prevPolicy.normalUserRate ?? 0.30) * 100) / 100;
    const enabled = referralEnabled ?? prevPolicy.referralEnabled !== false;

    const newPolicy = await CommissionPolicyModel.create({
      defaultRate: roundedRate,
      moderatorRate: roundedRate,
      normalUserRate: roundedNormalRate,
      normalUserCommissionType: 'ONE_TIME',
      moderatorCommissionType: 'LIFETIME',
      referralEnabled: enabled,
      commissionableBasis: prevPolicy.commissionableBasis,
      description: `Normal users earn ${(roundedNormalRate * 100).toFixed(0)}% one-time commission per referred customer; moderators earn ${(roundedRate * 100).toFixed(0)}% lifetime commission on every eligible confirmed purchase.`,
      updatedByAdminId: new mongoose.Types.ObjectId(adminId),
      updatedByAdminEmail: adminEmail,
      auditReason: reason.trim(),
      effectiveFrom: new Date()
    });

    await AuditLogModel.create({
      action: 'COMMISSION_POLICY_UPDATE',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      reason: reason.trim(),
      previousValue: {
        defaultRate: prevPolicy.defaultRate,
        normalUserRate: prevPolicy.normalUserRate ?? 0.30,
        referralEnabled: prevPolicy.referralEnabled !== false
      },
      newValue: {
        defaultRate: roundedRate,
        normalUserRate: roundedNormalRate,
        referralEnabled: enabled
      },
      details: { policyId: newPolicy._id.toString() }
    });

    logger.info(
      `Main Admin ${adminEmail} updated referral policy: normal ${(roundedNormalRate * 100).toFixed(0)}% one-time, moderator ${(roundedRate * 100).toFixed(0)}% lifetime, enabled=${enabled}`
    );

    return newPolicy;
  }

  /**
   * 12. Review suspected referral fraud alerts
   */
  async getReferralFraudAlerts(): Promise<any[]> {
    return AuditLogModel.find({
      action: { $in: ['REFERRAL_FRAUD_FLAG', 'MODERATOR_STATUS_CHANGE'] }
    })
      .sort({ createdAt: -1 })
      .limit(50);
  }

  // =========================================================================
  // MODERATOR DASHBOARD (MODERATOR ROLE ONLY)
  // =========================================================================

  /**
   * 13. Moderator Self-Dashboard
   */
  async getModeratorSelfDashboard(moderatorUserId: string, origin?: string): Promise<any> {
    return memoryCache.getOrSet(cacheKeys.moderatorDashboard(moderatorUserId), 15, async () => {
    const baseUrl = origin || 'http://localhost:3000';
    const moderator = await UserModel.findOne({
      _id: moderatorUserId,
      role: UserRole.MODERATOR,
      isDeleted: false
    });

    if (!moderator) {
      throw ApiError.notFound('Moderator profile not found or inactive');
    }

    const activePolicy = await CommissionPolicyModel.getActivePolicy();
    const rate = moderator.moderatorCommissionRate ?? activePolicy.defaultRate;

    // Count referred users and referral link clicks
    const [totalRegistrations, referralClicks] = await Promise.all([
      UserModel.countDocuments({
        referredBy: moderator._id,
        isDeleted: false
      }),
      ReferralClickModel.countDocuments({ moderatorId: moderator._id })
    ]);

    // Fetch commissions for calculations
    const commissions = await ReferralCommissionModel.find({ moderatorId: moderator._id })
      .sort({ createdAt: -1 });

    let successfulAttributedSales = 0;
    let totalAttributedRevenueUsd = 0;
    let pendingCommissionUsd = 0;
    let eligibleCommissionUsd = 0;
    let approvedCommissionUsd = 0;
    let reversedCommissionUsd = 0;
    const buyerSet = new Set<string>();

    for (const c of commissions) {
      if (c.status === 'REVERSED') {
        reversedCommissionUsd += c.amountUsd;
      } else {
        successfulAttributedSales++;
        const rev = c.originalPurchaseAmount ?? c.commissionableAmount ?? (c.commissionRate > 0 ? c.amountUsd / c.commissionRate : c.amountUsd * 2);
        totalAttributedRevenueUsd += rev;
        buyerSet.add(c.referredUserId.toString());

        if (c.status === 'PENDING') {
          pendingCommissionUsd += c.amountUsd;
        } else if (c.status === 'ELIGIBLE') {
          eligibleCommissionUsd += c.amountUsd;
        } else if (c.status === 'APPROVED' || c.status === 'CREDITED') {
          approvedCommissionUsd += c.amountUsd;
        }
      }
    }

    const recentCommissions = commissions.slice(0, 10).map((c) => ({
      id: c._id.toString(),
      orderId: c.purchaseId || 'N/A',
      plan: c.subscriptionPlan || 'Premium',
      originalPurchaseAmount: c.originalPurchaseAmount || (c.amountUsd / (c.commissionRate || 0.5)),
      commissionRate: c.commissionRate,
      amountUsd: c.amountUsd,
      status: c.status,
      createdAt: c.createdAt
    }));

    return {
      profile: {
        name: moderator.name,
        email: moderator.email,
        phone: moderator.phone,
        referralCode: moderator.referralCode,
        referralLink: `${baseUrl}/gerister?ref=${moderator.referralCode}`,
        commissionRate: rate,
        accountStatus: moderator.accountStatus
      },
      metrics: {
        referralRegistrations: totalRegistrations,
        referralClicks,
        qualifiedCustomers: buyerSet.size,
        successfulAttributedSales,
        totalAttributedRevenueUsd: Math.round(totalAttributedRevenueUsd * 100) / 100,
        pendingCommissionUsd: Math.round(pendingCommissionUsd * 100) / 100,
        eligibleCommissionUsd: Math.round(eligibleCommissionUsd * 100) / 100,
        approvedCommissionUsd: Math.round(approvedCommissionUsd * 100) / 100,
        reversedCommissionUsd: Math.round(reversedCommissionUsd * 100) / 100
      },
      recentCommissions,
      nonCustodialNotice:
        'Non-custodial model: the platform never holds betting stakes or player deposits. Referral commissions are tracked in your earnings wallet and may be withdrawn through the approved withdrawal workflow.'
    };
    });
  }

  /**
   * 14. Moderator Self-Commissions List (Paginated)
   */
  async getModeratorSelfCommissions(
    moderatorUserId: string,
    options: { status?: string; page?: number; limit?: number }
  ): Promise<any> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.max(1, Math.min(100, options.limit || 20));
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = {
      moderatorId: new mongoose.Types.ObjectId(moderatorUserId)
    };

    if (options.status && options.status !== 'ALL') {
      filter.status = options.status;
    }

    const [commissions, total] = await Promise.all([
      ReferralCommissionModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      ReferralCommissionModel.countDocuments(filter)
    ]);

    return {
      commissions: commissions.map((c) => ({
        id: c._id.toString(),
        orderId: c.purchaseId || 'N/A',
        plan: c.subscriptionPlan || 'Premium Plan',
        originalPurchaseAmount: c.originalPurchaseAmount || (c.amountUsd / (c.commissionRate || 0.5)),
        commissionableAmount: c.commissionableAmount || (c.amountUsd / (c.commissionRate || 0.5)),
        commissionRate: c.commissionRate,
        amountUsd: c.amountUsd,
        status: c.status,
        createdAt: c.createdAt
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  }

  /**
   * 15. Moderator Self-Referred Customers List (Privacy Masked)
   */
  async getModeratorSelfReferredUsers(
    moderatorUserId: string,
    page = 1,
    limit = 20
  ): Promise<any> {
    const cleanPage = Math.max(1, page);
    const cleanLimit = Math.max(1, Math.min(100, limit));
    const skip = (cleanPage - 1) * cleanLimit;

    const [users, total] = await Promise.all([
      UserModel.find({ referredBy: new mongoose.Types.ObjectId(moderatorUserId), isDeleted: false })
        .select('name email phone accountStatus createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(cleanLimit),
      UserModel.countDocuments({ referredBy: new mongoose.Types.ObjectId(moderatorUserId), isDeleted: false })
    ]);

    const maskedUsers = await Promise.all(
      users.map(async (u) => {
        const hasSub = await SubscriptionModel.findOne({
          userId: u._id,
          status: 'ACTIVE',
          endDate: { $gt: new Date() }
        });

        return {
          id: u._id.toString(),
          maskedName: u.name.length > 2 ? `${u.name[0]}***${u.name.slice(-1)}` : 'User',
          maskedIdentifier: this.maskIdentifier(u.email || u.phone),
          registeredAt: u.createdAt,
          hasActiveSubscription: !!hasSub,
          subscriptionPlan: hasSub ? hasSub.planId : undefined
        };
      })
    );

    return {
      customers: maskedUsers,
      total,
      page: cleanPage,
      totalPages: Math.ceil(total / cleanLimit)
    };
  }
}

export const moderatorService = new ModeratorService();
