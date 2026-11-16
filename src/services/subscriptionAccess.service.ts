import mongoose from 'mongoose';
import { SubscriptionModel, ISubscription } from '../models/Subscription';
import { UserModel, AccountStatus } from '../models/User';
import { PlanModel } from '../models/Plan';
import { UserRole } from '../shared/roles';
import {
  SubscriptionStatus,
  AccessStatusResponse,
  GrantManualSubscriptionInput,
  ExtendSubscriptionInput,
  RevokeSubscriptionInput
} from '../shared/subscriptions';
import { calculatePlanExpiration, SUBSCRIPTION_PLANS, SubscriptionPlan } from '../shared/plans';
import { subscriptionService } from './subscription.service';
import { notificationService } from './notification.service';
import { ToolSettingsModel } from '../models/ToolSettings';
import { AuditLogModel } from '../models/AuditLog';
import { emailService } from './email.service';
import { generateSecretActivationCode } from '../utils/crypto';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';

export class SubscriptionAccessService {
  private lastExpirySweepAt = 0;
  private expirySweepInFlight: Promise<number> | null = null;

  /**
   * Persist EXPIRED status for every ACTIVE subscription whose exact
   * timestamp has passed. Access checks still compare endDate directly, so a
   * delayed sweep can never grant access.
   */
  async expireExpiredSubscriptions(referenceDate: Date = new Date(), force = false): Promise<number> {
    if (!force && Date.now() - this.lastExpirySweepAt < 15_000) return 0;
    if (this.expirySweepInFlight) return this.expirySweepInFlight;

    this.expirySweepInFlight = (async () => {
      const result = await SubscriptionModel.updateMany(
        {
          status: SubscriptionStatus.ACTIVE,
          isRevoked: { $ne: true },
          endDate: { $lte: referenceDate }
        },
        { $set: { status: SubscriptionStatus.EXPIRED } }
      );
      this.lastExpirySweepAt = Date.now();
      if (result.modifiedCount > 0) {
        logger.info(`Auto-expired ${result.modifiedCount} subscription(s) at ${referenceDate.toISOString()}`);
      }
      return result.modifiedCount || 0;
    })().finally(() => {
      this.expirySweepInFlight = null;
    });

    return this.expirySweepInFlight;
  }

  /**
   * Public authoritative access check. The returned serverTime lets the UI
   * calculate a tamper-resistant countdown without trusting the device clock.
   */
  async checkAccess(userId: string): Promise<AccessStatusResponse> {
    await this.expireExpiredSubscriptions().catch(() => null);
    const result = await this.evaluateAccess(userId);
    return {
      ...result,
      serverTime: new Date().toISOString()
    };
  }

  private async evaluateAccess(userId: string): Promise<AccessStatusResponse> {
    const user = await UserModel.findById(userId);
    if (!user) {
      return {
        hasAccess: false,
        code: 'UNAUTHENTICATED',
        reason: 'User account not found'
      };
    }

    // Check Global Tool Operational Settings & Maintenance Mode
    if (mongoose.connection.readyState === 1) {
      const toolSettings = await ToolSettingsModel.getSettings();
      if (!toolSettings.isToolEnabled) {
        return {
          hasAccess: false,
          code: 'TOOL_DISABLED',
          reason: toolSettings.publicStatusMessage || 'The prediction engine is currently disabled by system administration.'
        };
      }

      if (toolSettings.maintenanceMode && user.role !== UserRole.SUPER_ADMIN) {
        return {
          hasAccess: false,
          code: 'TOOL_MAINTENANCE',
          reason: toolSettings.publicStatusMessage || 'Scheduled system maintenance is currently underway. Please check back shortly.'
        };
      }
    }

    // Check account-level administrative suspension or block
    if (user.accountStatus === 'BLOCKED' || user.isDeleted) {
      return {
        hasAccess: false,
        code: 'SUBSCRIPTION_REVOKED',
        reason: user.statusReason || 'User account has been suspended or blocked by platform administration'
      };
    }

    if (user.accountStatus === 'SUSPENDED' && (!user.suspendedUntil || user.suspendedUntil > new Date())) {
      return {
        hasAccess: false,
        code: 'SUBSCRIPTION_REVOKED',
        reason: user.statusReason || 'User account is temporarily suspended'
      };
    }

    // Prefer a genuinely active subscription; otherwise inspect the latest one
    // to report the correct expired/scheduled/revoked state.
    const now = new Date();
    const activeSub = await SubscriptionModel.findOne({
      userId: user._id,
      status: SubscriptionStatus.ACTIVE,
      isRevoked: { $ne: true },
      startDate: { $lte: now },
      endDate: { $gt: now }
    }).sort({ endDate: -1 });

    const sub = activeSub || await SubscriptionModel.findOne({ userId: user._id }).sort({ endDate: -1 });

    if (!sub) {
      // Main Admins and Moderators have full role-based access fallback if no individual subscription exists
      if (user.role === UserRole.SUPER_ADMIN || user.role === UserRole.MODERATOR) {
        return {
          hasAccess: true,
          code: 'ACCESS_GRANTED',
          isRoleBypass: true,
          planName: user.role === UserRole.SUPER_ADMIN ? 'Main Admin Unlimited' : 'Moderator Partner Desk',
          reason: 'Authorized access via administrative platform role'
        };
      }

      return {
        hasAccess: false,
        code: 'SUBSCRIPTION_REQUIRED',
        reason: 'No active subscription found. Please choose a subscription tier.'
      };
    }

    // Check revocation
    if (sub.isRevoked || sub.status === SubscriptionStatus.REVOKED) {
      return {
        hasAccess: false,
        code: 'SUBSCRIPTION_REVOKED',
        planId: sub.planId,
        status: SubscriptionStatus.REVOKED,
        reason: sub.revocationReason || 'Subscription access was revoked by platform administration'
      };
    }

    // Check start date (not yet active)
    if (now < sub.startDate) {
      return {
        hasAccess: false,
        code: 'SUBSCRIPTION_REQUIRED',
        planId: sub.planId,
        status: SubscriptionStatus.PENDING,
        startDate: sub.startDate.toISOString(),
        endDate: sub.endDate.toISOString(),
        reason: 'Subscription scheduled period has not yet started'
      };
    }

    // Dynamic Server-Side Expiration Check
    if (now > sub.endDate) {
      if (sub.status !== SubscriptionStatus.EXPIRED) {
        sub.status = SubscriptionStatus.EXPIRED;
        await sub.save();
        logger.info(`Subscription ${sub._id} for user ${user._id} marked as EXPIRED dynamically upon access check.`);
      }

      return {
        hasAccess: false,
        code: 'SUBSCRIPTION_EXPIRED',
        planId: sub.planId,
        status: SubscriptionStatus.EXPIRED,
        startDate: sub.startDate.toISOString(),
        endDate: sub.endDate.toISOString(),
        expiresAtFormatted: sub.endDate.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        }),
        daysRemaining: 0,
        reason: `Subscription expired on ${sub.endDate.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })}. Please renew your plan.`
      };
    }

    // Active within valid time boundaries
    if (sub.status === SubscriptionStatus.ACTIVE) {
      const plan = await subscriptionService.getPlanById(sub.planId);
      const msRemaining = sub.endDate.getTime() - now.getTime();
      const daysRemaining = Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));

      // Secret Code Lock Check: User must enter their secret code to unlock the tool if code was issued
      if (sub.secretCode && !sub.isSecretCodeClaimed) {
        return {
          hasAccess: false,
          code: 'SECRET_CODE_REQUIRED',
          needsSecretCode: true,
          isApproved: sub.isApprovedByAdmin !== false,
          planId: sub.planId,
          planName: plan?.name || sub.customPlanName || sub.planId,
          status: SubscriptionStatus.ACTIVE,
          startDate: sub.startDate.toISOString(),
          endDate: sub.endDate.toISOString(),
          expiresAtFormatted: sub.endDate.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),
          daysRemaining,
          remainingMs: Math.max(0, msRemaining),
          reason: sub.isApprovedByAdmin !== false
            ? 'Your VIP subscription is active! Enter the Secret Activation Code sent to your email to unlock the tool.'
            : 'Your subscription purchase is pending admin approval. Your Secret Code will be dispatched upon approval.'
        };
      }

      return {
        hasAccess: true,
        code: 'ACCESS_GRANTED',
        planId: sub.planId,
        planName: plan?.name || sub.customPlanName || sub.planId,
        status: SubscriptionStatus.ACTIVE,
        startDate: sub.startDate.toISOString(),
        endDate: sub.endDate.toISOString(),
        expiresAtFormatted: sub.endDate.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        }),
        daysRemaining,
        remainingMs: Math.max(0, msRemaining),
        needsSecretCode: false,
        isApproved: true,
        reason: 'Active premium subscription confirmed'
      };
    }

    return {
      hasAccess: false,
      code: 'SUBSCRIPTION_REQUIRED',
      status: sub.status,
      reason: `Subscription status is ${sub.status}`
    };
  }

  /**
   * Main Admin manual subscription grant.
   * Records manual grant with admin audit metadata and explicitly does NOT create sales/commissions.
   */
  async grantManualSubscription(adminId: string, input: GrantManualSubscriptionInput): Promise<ISubscription> {
    const targetUser = await UserModel.findOne({ email: input.targetEmail.toLowerCase().trim() });
    if (!targetUser) {
      throw ApiError.notFound(`User with email ${input.targetEmail} was not found`);
    }

    const plan = input.planId ? await subscriptionService.getPlanById(input.planId) : undefined;
    if (input.planId && !plan) {
      throw ApiError.notFound(`Plan ${input.planId} does not exist`);
    }

    const duration =
      input.durationUnit && input.durationValue
        ? { unit: input.durationUnit, value: input.durationValue }
        : plan?.duration;

    if (!duration) {
      throw ApiError.badRequest('A plan or custom duration is required for manual activation');
    }

    const now = new Date();
    const startDate = input.startDate ? new Date(input.startDate) : now;
    if (Number.isNaN(startDate.getTime())) {
      throw ApiError.badRequest('Invalid subscription start date/time');
    }

    const endDate = calculatePlanExpiration(startDate, duration);
    if (endDate.getTime() <= startDate.getTime()) {
      throw ApiError.badRequest('Subscription expiration must be after its start time');
    }

    // A future-dated grant must not cancel the user's current access. An
    // immediate grant replaces older ACTIVE records to avoid ambiguity.
    if (startDate.getTime() <= now.getTime()) {
      await SubscriptionModel.updateMany(
        {
          userId: targetUser._id,
          status: SubscriptionStatus.ACTIVE,
          isRevoked: { $ne: true }
        },
        { $set: { status: SubscriptionStatus.CANCELLED } }
      );
    }

    const planId = plan?.id || 'CUSTOM_ADMIN_GRANT';
    const customPlanName = plan ? undefined : input.customPlanName || `Custom ${duration.value} ${duration.unit}`;
    const planName = plan?.name || customPlanName || 'Custom Admin Grant';
    const secretCode = generateSecretActivationCode();

    const subscription = await SubscriptionModel.create({
      userId: targetUser._id,
      planId,
      customPlanName,
      status: SubscriptionStatus.ACTIVE,
      startDate,
      endDate,
      secretCode,
      isSecretCodeClaimed: true,
      secretCodeClaimedAt: now,
      isApprovedByAdmin: true,
      approvedByAdminId: new mongoose.Types.ObjectId(adminId),
      approvedAt: now,
      isManualGrant: true,
      grantReason: input.reason.trim(),
      grantedByAdminId: new mongoose.Types.ObjectId(adminId)
    });

    const admin = await UserModel.findById(adminId);
    await AuditLogModel.create({
      action: 'SUBSCRIPTION_MANUAL_GRANT',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail: admin?.email || 'admin@rouletteaccuracy.com',
      targetUserId: targetUser._id,
      targetUserEmail: targetUser.email,
      reason: input.reason.trim(),
      newValue: {
        subscriptionId: subscription._id,
        planId,
        customPlanName,
        duration,
        secretCode,
        startDate,
        endDate,
        isManualGrant: true
      }
    });

    logger.info(
      `Main Admin ${adminId} manually granted ${planId} (${duration.value} ${duration.unit}) to ${input.targetEmail}, ${startDate.toISOString()} → ${endDate.toISOString()}.`
    );

    if (targetUser.email) {
      await emailService.sendVipSecretCodeEmail({
        to: targetUser.email,
        name: targetUser.name || 'Member',
        planName,
        durationDays: Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86_400_000)),
        secretCode
      }).catch((err) => logger.error('Failed to dispatch secret code email on manual grant', err));
    }

    await notificationService.createNotification(
      targetUser._id,
      'SUBSCRIPTION_ACTIVATED',
      '🎉 VIP Subscription Activated',
      startDate.getTime() > now.getTime()
        ? `Your ${planName} subscription has been scheduled from ${startDate.toISOString()} until ${endDate.toISOString()}. Your Secret Code is ${secretCode}.`
        : `Your subscription has been activated until ${endDate.toISOString()}. Your Secret Code is ${secretCode}. Enter it on the Tool page to unlock.`,
      '/dashboard/tool'
    ).catch(() => null);

    return subscription;
  }

  /**
   * Main Admin subscription extension.
   */
  async extendSubscription(adminId: string, input: ExtendSubscriptionInput): Promise<ISubscription> {
    const sub = await SubscriptionModel.findById(input.subscriptionId);
    if (!sub) {
      throw ApiError.notFound(`Subscription ${input.subscriptionId} was not found`);
    }

    if (sub.isRevoked) {
      throw ApiError.badRequest('Cannot extend a revoked subscription. Grant a new subscription instead.');
    }

    const now = new Date();
    const baseDate = sub.endDate > now ? sub.endDate : now;
    const extensionUnit = input.extensionUnit === 'YEARS' ? 'MONTHS' : input.extensionUnit;
    const extensionValue = input.extensionUnit === 'YEARS' ? input.extensionValue * 12 : input.extensionValue;
    const newEndDate = calculatePlanExpiration(baseDate, {
      unit: extensionUnit,
      value: extensionValue
    });

    const previousEndDate = sub.endDate;
    sub.endDate = newEndDate;
    sub.status = SubscriptionStatus.ACTIVE;
    sub.extendedAt = now;
    sub.extensionReason = input.reason.trim();
    await sub.save();

    const admin = await UserModel.findById(adminId);
    const targetUser = await UserModel.findById(sub.userId);
    await AuditLogModel.create({
      action: 'SUBSCRIPTION_EXTEND',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail: admin?.email || 'admin@rouletteaccuracy.com',
      targetUserId: sub.userId,
      targetUserEmail: targetUser?.email,
      reason: input.reason.trim(),
      previousValue: { endDate: previousEndDate },
      newValue: {
        endDate: newEndDate,
        extension: `${input.extensionValue} ${input.extensionUnit}`
      }
    });

    logger.info(`Main Admin ${adminId} extended subscription ${sub._id} by ${input.extensionValue} ${input.extensionUnit}. New expiry: ${newEndDate.toISOString()}`);

    await notificationService.createNotification(
      sub.userId,
      'SUBSCRIPTION_ACTIVATED',
      'Subscription Extended',
      `Your subscription has been extended by ${input.extensionValue} ${input.extensionUnit.toLowerCase()}.`,
      '/dashboard/tool'
    ).catch(() => null);

    return sub;
  }

  /**
   * Main Admin subscription revocation.
   */
  async revokeSubscription(adminId: string, input: RevokeSubscriptionInput): Promise<ISubscription> {
    const sub = await SubscriptionModel.findById(input.subscriptionId);
    if (!sub) {
      throw ApiError.notFound(`Subscription ${input.subscriptionId} was not found`);
    }

    const previousStatus = sub.status;
    sub.status = SubscriptionStatus.REVOKED;
    sub.isRevoked = true;
    sub.revokedAt = new Date();
    sub.revocationReason = input.reason.trim();
    await sub.save();

    const admin = await UserModel.findById(adminId);
    const targetUser = await UserModel.findById(sub.userId);
    await AuditLogModel.create({
      action: 'SUBSCRIPTION_REVOKE',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail: admin?.email || 'admin@rouletteaccuracy.com',
      targetUserId: sub.userId,
      targetUserEmail: targetUser?.email,
      reason: input.reason.trim(),
      previousValue: { status: previousStatus },
      newValue: { status: SubscriptionStatus.REVOKED, isRevoked: true }
    });

    logger.info(`Main Admin ${adminId} revoked subscription ${sub._id}. Reason: ${input.reason}`);

    await notificationService.createNotification(
      sub.userId,
      'SUBSCRIPTION_REVOKED',
      'Subscription Access Revoked',
      `Your subscription access has been revoked: ${input.reason}`,
      '/plans'
    ).catch(() => null);

    return sub;
  }

  /**
   * Main Admin unban / lift tool access ban on a subscription
   */
  async unbanSubscription(adminId: string, input: { subscriptionId: string; reason?: string; extensionDays?: number }): Promise<ISubscription> {
    const sub = await SubscriptionModel.findById(input.subscriptionId);
    if (!sub) {
      throw ApiError.notFound(`Subscription ${input.subscriptionId} was not found`);
    }

    const previousStatus = sub.status;
    sub.status = SubscriptionStatus.ACTIVE;
    sub.isRevoked = false;
    sub.revocationReason = undefined;
    sub.revokedAt = undefined;

    const now = new Date();
    // If the subscription had expired or was expiring while banned, restore validity
    if (new Date(sub.endDate) <= now) {
      const days = input.extensionDays && input.extensionDays > 0 ? input.extensionDays : 15;
      sub.startDate = now;
      sub.endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      sub.extendedAt = now;
      sub.extensionReason = input.reason || 'Restored active access via administrative unban';
    }

    await sub.save();

    // If target user's account was marked suspended or blocked, restore them to ACTIVE
    const targetUser = await UserModel.findById(sub.userId);
    if (targetUser && (targetUser.accountStatus === AccountStatus.SUSPENDED || targetUser.accountStatus === AccountStatus.BLOCKED || !targetUser.isActive)) {
      targetUser.accountStatus = AccountStatus.ACTIVE;
      targetUser.isActive = true;
      targetUser.suspendedUntil = undefined;
      await targetUser.save();
    }

    const admin = await UserModel.findById(adminId);
    await AuditLogModel.create({
      action: 'SUBSCRIPTION_UNBAN' as any,
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail: admin?.email || 'admin@rouletteaccuracy.com',
      targetUserId: sub.userId,
      targetUserEmail: targetUser?.email,
      reason: input.reason?.trim() || 'Admin lifted ban and restored tool access',
      previousValue: { status: previousStatus, isRevoked: true },
      newValue: { status: SubscriptionStatus.ACTIVE, isRevoked: false }
    }).catch(() => null);

    logger.info(`Main Admin ${adminId} unbanned subscription ${sub._id}.`);

    await notificationService.createNotification(
      sub.userId,
      'SUBSCRIPTION_ACTIVATED',
      'Tool Access Restored',
      'Your subscription and live prediction tool access have been unbanned and restored by administration.',
      '/dashboard/tool'
    ).catch(() => null);

    return sub;
  }

  /**
   * Ban tool access for user by userId
   */
  async banUserToolAccess(adminId: string, userId: string, reason?: string): Promise<ISubscription> {
    const cleanReason = (reason && reason.trim()) || 'Administrative tool access shutoff / ban';
    let sub = await SubscriptionModel.findOne({ userId, status: SubscriptionStatus.ACTIVE, isRevoked: { $ne: true } }).sort({ createdAt: -1 });
    if (!sub) {
      sub = await SubscriptionModel.findOne({ userId }).sort({ createdAt: -1 });
    }
    if (!sub) {
      sub = await SubscriptionModel.create({
        userId,
        planId: '15_days',
        status: SubscriptionStatus.REVOKED,
        isRevoked: true,
        revokedAt: new Date(),
        revocationReason: cleanReason,
        startDate: new Date(),
        endDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
        isManualGrant: true,
        grantReason: 'Administrative access ban placeholder'
      });
      return sub;
    }
    return this.revokeSubscription(adminId, { subscriptionId: sub._id.toString(), reason: cleanReason });
  }

  /**
   * Unban tool access for user by userId
   */
  async unbanUserToolAccess(adminId: string, userId: string, reason?: string): Promise<ISubscription> {
    let sub = await SubscriptionModel.findOne({ userId, isRevoked: true }).sort({ createdAt: -1 });
    if (!sub) {
      sub = await SubscriptionModel.findOne({ userId }).sort({ createdAt: -1 });
    }
    if (sub) {
      return this.unbanSubscription(adminId, { subscriptionId: sub._id.toString(), reason });
    }
    const targetUser = await UserModel.findById(userId);
    if (!targetUser || !targetUser.email) {
      throw ApiError.notFound(`User ${userId} not found`);
    }
    return this.grantManualSubscription(adminId, {
      targetEmail: targetUser.email,
      planId: '15_days',
      reason: reason || 'Tool access restored & granted by administration'
    });
  }

  /**
   * List platform subscriptions for Main Admin overview with filtering and pagination.
   */
  async listAllSubscriptions(options?: {
    status?: string;
    planId?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ subscriptions: any[]; total: number; page: number; totalPages: number }> {
    const page = options?.page ? Math.max(1, options.page) : 1;
    const limit = options?.limit ? Math.min(100, Math.max(1, options.limit)) : 50;
    const query: any = {};
    const now = new Date();

    // Persist EXPIRED for all passes whose exact end timestamp has passed.
    try {
      await this.expireExpiredSubscriptions(now, true);
    } catch {
      // Access checks still enforce endDate directly if the sweep fails.
    }

    if (options?.status && options.status !== 'ALL') {
      if (options.status === 'ACTIVE') {
        query.status = SubscriptionStatus.ACTIVE;
        query.endDate = { $gt: now };
        query.isRevoked = { $ne: true };
      } else if (options.status === 'EXPIRED') {
        query.$or = [
          { status: SubscriptionStatus.EXPIRED },
          { endDate: { $lte: now } }
        ];
      } else if (options.status === 'REVOKED') {
        query.$or = [
          { status: SubscriptionStatus.REVOKED },
          { isRevoked: true }
        ];
      } else if (options.status === 'INACTIVE') {
        query.status = {
          $in: [SubscriptionStatus.CANCELLED, SubscriptionStatus.REVOKED, SubscriptionStatus.PENDING]
        };
      } else if (options.status === 'CLAIM_PENDING') {
        query.status = SubscriptionStatus.ACTIVE;
        query.endDate = { $gt: now };
        query.isRevoked = { $ne: true };
        query.isSecretCodeClaimed = { $ne: true };
      } else {
        query.status = options.status;
      }
    }

    if (options?.planId && options.planId !== 'ALL') {
      query.planId = options.planId;
    }

    if (options?.search && options.search.trim() !== '') {
      const searchClean = options.search.trim();
      const searchRegex = new RegExp(searchClean, 'i');
      const users = await UserModel.find({
        $or: [
          { email: searchRegex },
          { name: searchRegex },
          { phone: searchRegex }
        ]
      }).select('_id').lean();
      const userIds = users.map((u) => u._id);

      const searchConditions: any[] = [
        { planId: searchRegex },
        { customPlanName: searchRegex },
        { secretCode: searchRegex },
        { grantReason: searchRegex },
        { userId: { $in: userIds } }
      ];

      if (mongoose.Types.ObjectId.isValid(searchClean)) {
        searchConditions.push({ _id: new mongoose.Types.ObjectId(searchClean) });
      }

      if (query.$or) {
        query.$and = [{ $or: query.$or }, { $or: searchConditions }];
        delete query.$or;
      } else {
        query.$or = searchConditions;
      }
    }

    const [total, rawSubscriptions, allDbPlans] = await Promise.all([
      SubscriptionModel.countDocuments(query),
      SubscriptionModel.find(query)
        .populate('userId', 'name email phone role accountStatus')
        .populate('grantedByAdminId', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      PlanModel.find().lean()
    ]);

    const planMap = new Map<string, any>();
    Object.values(SUBSCRIPTION_PLANS).forEach((p: SubscriptionPlan) => {
      planMap.set(p.id.toLowerCase(), p);
    });
    allDbPlans.forEach((p: any) => {
      planMap.set(p.planId?.toLowerCase(), p);
      if (p.id) planMap.set(p.id.toLowerCase(), p);
    });

    const subscriptions = rawSubscriptions.map((s: any) => {
      const msRemaining = s.endDate ? new Date(s.endDate).getTime() - now.getTime() : 0;
      const matchedPlan = s.planId ? planMap.get(s.planId.toLowerCase()) : null;
      const isExpired = msRemaining <= 0 || s.status === SubscriptionStatus.EXPIRED;
      return {
        ...s,
        planName:
          matchedPlan?.name ||
          s.customPlanName ||
          s.planId.replace(/_/g, ' '),
        planPriceUsd: matchedPlan?.priceUsd || (matchedPlan?.priceCents ? matchedPlan.priceCents / 100 : undefined),
        daysRemaining: Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24))),
        remainingMs: Math.max(0, msRemaining),
        isExpired,
        expiresAtFormatted: s.endDate ? new Date(s.endDate).toLocaleString('en-US') : null
      };
    });

    return {
      subscriptions,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit))
    };
  }

  /**
   * Unlock prediction tool using customer's secret activation code
   */
  async unlockToolWithSecretCode(userId: string, enteredCode: string): Promise<{ success: boolean; message: string }> {
    const cleanCode = enteredCode.trim().toUpperCase();
    if (!cleanCode || cleanCode.length < 3) {
      throw ApiError.badRequest('Please enter a valid secret activation code');
    }

    const now = new Date();
    const sub = await SubscriptionModel.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      status: SubscriptionStatus.ACTIVE,
      isRevoked: { $ne: true },
      endDate: { $gt: now }
    }).sort({ endDate: -1 });

    if (!sub) {
      throw ApiError.badRequest('No active approved subscription found for this account. Please verify your purchase.');
    }

    if (sub.isSecretCodeClaimed) {
      return {
        success: true,
        message: 'Your prediction engine is already unlocked and active!'
      };
    }

    if (!sub.secretCode || sub.secretCode.trim().toUpperCase() !== cleanCode) {
      throw ApiError.badRequest('Invalid Secret Activation Code. Please check the code sent to your email.');
    }

    sub.isSecretCodeClaimed = true;
    sub.secretCodeClaimedAt = new Date();
    await sub.save();

    await AuditLogModel.create({
      action: 'TOOL_SECRET_CODE_UNLOCKED',
      targetUserId: sub.userId,
      reason: 'Customer successfully unlocked tool with secret code',
      details: {
        subscriptionId: sub._id.toString(),
        secretCode: sub.secretCode
      }
    }).catch((e) => logger.error('Failed to log audit for tool unlock', e));

    return {
      success: true,
      message: 'VIP Prediction Engine successfully unlocked! Enjoy full real-time intelligence.'
    };
  }

  /**
   * Admin: Approve subscription and dispatch secret code email to user
   */
  async approveSubscriptionAndSendSecretCode(
    adminId: string,
    adminEmail: string,
    subscriptionId: string
  ): Promise<{ subscription: ISubscription; secretCode: string }> {
    const sub = await SubscriptionModel.findById(subscriptionId);
    if (!sub) {
      throw ApiError.notFound(`Subscription ${subscriptionId} not found`);
    }

    if (!sub.secretCode) {
      sub.secretCode = generateSecretActivationCode();
    }

    sub.isApprovedByAdmin = true;
    sub.approvedByAdminId = new mongoose.Types.ObjectId(adminId);
    sub.approvedAt = new Date();
    sub.status = SubscriptionStatus.ACTIVE;
    await sub.save();

    const user = await UserModel.findById(sub.userId);
    const plan = await subscriptionService.getPlanById(sub.planId);
    const planName = plan?.name || sub.planId;
    const durationDays = plan?.durationDays || 30;

    if (user && user.email) {
      await emailService.sendVipSecretCodeEmail({
        to: user.email,
        name: user.name || 'Member',
        planName,
        durationDays,
        secretCode: sub.secretCode
      }).catch((err) => logger.error('Failed to dispatch secret code email', err));
    }

    await notificationService.createNotification(
      user!._id,
      'SUBSCRIPTION_ACTIVATED',
      '🎉 VIP Secret Activation Code Issued',
      `Your subscription is approved! Secret Code: ${sub.secretCode}. Enter it on the Tool page to unlock.`,
      '/dashboard/tool'
    ).catch(() => null);

    await AuditLogModel.create({
      action: 'SUBSCRIPTION_APPROVED_SECRET_CODE_SENT',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetUserId: sub.userId,
      targetUserEmail: user?.email,
      reason: 'Admin approved VIP subscription and dispatched secret activation code',
      details: {
        subscriptionId: sub._id.toString(),
        secretCode: sub.secretCode,
        planId: sub.planId
      }
    }).catch((e) => logger.error('Failed to log audit for subscription approval', e));

    return {
      subscription: sub,
      secretCode: sub.secretCode
    };
  }

  /**
   * Admin: Manually unlock tool for a subscription without requiring user to enter code
   */
  async manuallyUnlockToolForSubscription(
    adminId: string,
    adminEmail: string,
    subscriptionId: string
  ): Promise<ISubscription> {
    const sub = await SubscriptionModel.findById(subscriptionId);
    if (!sub) {
      throw ApiError.notFound(`Subscription ${subscriptionId} not found`);
    }

    sub.isApprovedByAdmin = true;
    sub.isSecretCodeClaimed = true;
    sub.secretCodeClaimedAt = new Date();
    sub.status = SubscriptionStatus.ACTIVE;
    await sub.save();

    await AuditLogModel.create({
      action: 'TOOL_MANUALLY_UNLOCKED_BY_ADMIN',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetUserId: sub.userId,
      reason: 'Admin manually unlocked prediction tool access for user'
    }).catch(() => null);

    return sub;
  }
}

export const subscriptionAccessService = new SubscriptionAccessService();
