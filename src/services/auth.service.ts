import crypto from 'crypto';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { userRepository } from '../repositories/user.repository';
import { subscriptionRepository } from '../repositories/subscription.repository';
import { OtpVerificationModel } from '../models/OtpVerification';
import { UserModel, AccountStatus } from '../models/User';
import { SecurityLogModel } from '../models/SecurityLog';
import { AuditLogModel } from '../models/AuditLog';
import { hashPassword, comparePassword, generateOtpCode, generateRandomString } from '../utils/crypto';
import { normalizePhoneNumber } from '../utils/phone';
import { smsService } from './sms.service';
import { transactionalEmailService } from './transactionalEmail.service';
import { verificationOtp, passwordResetOtp } from './emailTemplates';
import { ApiError } from '../utils/apiError';
import {
  RegisterInput,
  LoginInput,
  VerifyOtpInput,
  ResendOtpInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  ChangePasswordInput,
  AuthResponse,
  AuthUser,
  OtpPurpose
} from '../shared/auth';
import { UserRole } from '../shared/roles';
import { logger } from '../utils/logger';
import { cacheKeys, memoryCache } from '../utils/cache';
import { adminTwoFactorService } from './adminTwoFactor.service';
import { signAccessToken } from '../utils/sessionToken';

const INVALID_REFERRAL_MESSAGE = 'Please enter a valid referral code.';

function normalizeReferralCode(value?: string): string {
  return String(value || '').trim().toUpperCase();
}

export class AuthService {
  /**
   * A valid bcrypt hash used to equalize the cost of a login attempt for an
   * unknown identifier, preventing account existence from being inferred by
   * response timing.
   */
  private static readonly DUMMY_PASSWORD_HASH =
    '$2b$12$C4Cpxafn.IjR4DqM9oKE1O50kzNTJqA1/HB/dnK86mUQFcRFhyN2G';

  private hashOtp(code: string, target: string): string {
    return crypto
      .createHmac('sha256', env.JWT_SECRET)
      .update(`${target.toLowerCase().trim()}:${code.trim()}`)
      .digest('hex');
  }

  private async logSecurityEvent(params: {
    userId?: string | mongoose.Types.ObjectId;
    email?: string;
    eventType: 'LOGIN_SUCCESS' | 'LOGIN_FAILED' | 'LOGIN_BLOCKED' | 'ACCOUNT_REGISTERED' | 'PASSWORD_RESET' | 'PASSWORD_CHANGED';
    success: boolean;
    ip?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await SecurityLogModel.create({
        userId: params.userId,
        email: params.email?.toLowerCase().trim(),
        eventType: params.eventType,
        success: params.success,
        ip: params.ip,
        userAgent: params.userAgent?.slice(0, 500),
        metadata: params.metadata
      });
    } catch (error) {
      logger.debug('Failed to persist security event', { error: String(error) });
    }
  }

  private async generateUniqueReferralCode(): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = generateRandomString(8).toUpperCase();
      const exists = await UserModel.exists({ referralCode: candidate });
      if (!exists) return candidate;
    }
    return `REF${Date.now().toString(36).toUpperCase()}${generateRandomString(4).toUpperCase()}`;
  }

  private isSelfReferral(
    referrer: { email?: string; phone?: string },
    email: string,
    phone?: string
  ): boolean {
    const normalizeEmail = (value: string) =>
      value.toLowerCase().trim().replace(/\+.*@/, '@');
    const isSelfEmail = Boolean(
      referrer.email && normalizeEmail(email) === normalizeEmail(referrer.email)
    );
    const isSelfPhone = Boolean(phone && referrer.phone && phone === referrer.phone);
    return isSelfEmail || isSelfPhone;
  }

  /**
   * Resolve a submitted referral code to an eligible, active referrer.
   * Invalid, disabled, suspended, deleted or non-referring accounts are
   * rejected with the same message so the exact reason cannot be enumerated.
   */
  private async resolveEligibleReferrer(code: string, email: string, phone?: string) {
    const cleanCode = normalizeReferralCode(code);
    if (!cleanCode || !/^[A-Z0-9_-]{3,64}$/.test(cleanCode)) {
      throw ApiError.badRequest(INVALID_REFERRAL_MESSAGE, 'INVALID_REFERRAL_CODE');
    }

    const referrer = await userRepository.findByReferralCode(cleanCode);
    const eligible = Boolean(
      referrer &&
      !referrer.isDeleted &&
      referrer.isActive &&
      referrer.accountStatus === AccountStatus.ACTIVE &&
      referrer.referralEligible !== false &&
      [UserRole.USER, UserRole.MODERATOR, UserRole.SUPER_ADMIN].includes(referrer.role) &&
      (!referrer.email || referrer.isEmailVerified)
    );

    if (!referrer || !eligible) {
      throw ApiError.badRequest(INVALID_REFERRAL_MESSAGE, 'INVALID_REFERRAL_CODE');
    }

    if (this.isSelfReferral(referrer, email, phone)) {
      await AuditLogModel.create({
        action: 'REFERRAL_FRAUD_FLAG',
        adminId: referrer._id,
        adminEmail: referrer.email || 'moderator@rouletteaccuracy.com',
        reason: 'Self-referral attempt detected during account registration',
        details: {
          referralCode: cleanCode,
          referrerId: referrer._id.toString(),
          candidateEmail: email
        }
      }).catch((error) => logger.error('Failed to log referral fraud audit', error));

      throw ApiError.badRequest('You cannot use your own referral code.', 'SELF_REFERRAL_NOT_ALLOWED');
    }

    return referrer;
  }

  private async createOtpRecord(params: {
    target: string;
    purpose: OtpPurpose;
    ip?: string;
  }): Promise<{ recordId: string; rawOtp: string }> {
    const cleanTarget = params.target.toLowerCase().trim();
    const now = new Date();

    // Invalidate every prior unused code for this target and purpose.
    await OtpVerificationModel.updateMany(
      { target: cleanTarget, purpose: params.purpose, isUsed: false },
      { $set: { isUsed: true } }
    );

    const rawOtp = generateOtpCode(6);
    const codeHash = this.hashOtp(rawOtp, cleanTarget);
    const expiresAt = new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60 * 1000);

    const record = await OtpVerificationModel.create({
      target: cleanTarget,
      codeHash,
      rawCodeDev: env.NODE_ENV === 'test' ? rawOtp : undefined,
      purpose: params.purpose,
      expiresAt,
      lastSentAt: now,
      ip: params.ip
    });

    return { recordId: record._id.toString(), rawOtp };
  }

  private async deliverEmailOtp(params: {
    to: string;
    name?: string;
    rawOtp: string;
    purpose: OtpPurpose;
    recordId: string;
    userId?: string;
  }): Promise<{ delivered: boolean; pending: boolean }> {
    const expiresAt = new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();
    try {
      const rendered =
        params.purpose === OtpPurpose.PASSWORD_RESET
          ? passwordResetOtp({
              code: params.rawOtp,
              expiryMinutes: env.OTP_EXPIRY_MINUTES,
              siteUrl: env.PUBLIC_FRONTEND_URL
            })
          : verificationOtp({
              name: params.name,
              code: params.rawOtp,
              expiryMinutes: env.OTP_EXPIRY_MINUTES,
              siteUrl: env.PUBLIC_FRONTEND_URL
            });

      const result = await transactionalEmailService.send({
        idempotencyKey: `email:${params.purpose.toLowerCase()}:${params.recordId}`,
        userId: params.userId,
        toEmail: params.to,
        templateKey:
          params.purpose === OtpPurpose.PASSWORD_RESET ? 'PASSWORD_RESET_OTP' : 'VERIFICATION_OTP',
        rendered,
        metadata: { expiresAt, purpose: params.purpose }
      });

      return {
        delivered: result.status === 'SENT',
        pending: result.status !== 'SENT'
      };
    } catch (error: any) {
      logger.error('Verification email delivery failed', { error: error?.message });
      return { delivered: false, pending: true };
    }
  }

  async register(input: RegisterInput, ip?: string, userAgent?: string): Promise<AuthResponse> {
    const { name, email, password, referralCode, phone } = input;

    if (!email || !email.trim()) {
      throw ApiError.badRequest('A valid email address is required for registration');
    }

    const normalizedEmail = email.toLowerCase().trim();
    const cleanReferralCode = normalizeReferralCode(referralCode);

    if (!cleanReferralCode) {
      throw ApiError.badRequest('Please enter a valid referral code.', 'REFERRAL_REQUIRED');
    }

    let normalizedPhone: string | undefined;
    if (phone && phone.trim() !== '') {
      try {
        normalizedPhone = normalizePhoneNumber(phone.trim());
      } catch {
        throw ApiError.badRequest('Please provide a valid phone number in international format.');
      }
    }

    // Resolve the referral relationship BEFORE creating any account. An
    // account is never created first and linked later.
    const referrer = await this.resolveEligibleReferrer(
      cleanReferralCode,
      normalizedEmail,
      normalizedPhone
    );

    // Duplicate account conflict checks
    const existingEmail = await userRepository.findByEmail(normalizedEmail);
    if (existingEmail) {
      throw ApiError.conflict('An account with this email address already exists');
    }

    if (normalizedPhone) {
      const existingPhone = await userRepository.findByPhone(normalizedPhone);
      if (existingPhone) {
        throw ApiError.conflict('An account with this phone number already exists');
      }
    }

    const passwordHash = await hashPassword(password);
    const newReferralCode = await this.generateUniqueReferralCode();

    let user;
    try {
      user = await userRepository.create({
        name: (name && name.trim()) || 'Member',
        email: normalizedEmail,
        phone: normalizedPhone,
        passwordHash,
        role: UserRole.USER,
        isEmailVerified: false,
        isPhoneVerified: false,
        isActive: false,
        referralCode: newReferralCode,
        referredBy: new mongoose.Types.ObjectId(referrer._id),
        referredAt: new Date(),
        referralCodeUsed: normalizeReferralCode(referrer.referralCode || cleanReferralCode),
        registrationIp: ip
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        throw ApiError.conflict('An account with these details already exists');
      }
      throw error;
    }

    await AuditLogModel.create({
      action: 'REFERRAL_ATTRIBUTION',
      adminId: referrer._id,
      adminEmail: 'attribution@system.rouletteaccuracy.com',
      targetUserId: user._id,
      targetUserEmail: user.email,
      reason: 'Customer permanently attributed to referrer via validated referral code',
      details: {
        referrerId: referrer._id.toString(),
        referralCode: user.referralCodeUsed,
        customerId: user._id.toString()
      }
    }).catch((error) => logger.error('Failed to log referral attribution audit', error));

    // Issue the verification OTP only after the account and permanent referral
    // relationship exist, so there is no window where an account lacks a code.
    const otp = await this.createOtpRecord({
      target: normalizedEmail,
      purpose: OtpPurpose.REGISTRATION,
      ip
    });
    const delivery = await this.deliverEmailOtp({
      to: normalizedEmail,
      name: user.name,
      rawOtp: otp.rawOtp,
      purpose: OtpPurpose.REGISTRATION,
      recordId: otp.recordId,
      userId: user._id.toString()
    });

    await this.logSecurityEvent({
      userId: user._id,
      email: user.email,
      eventType: 'ACCOUNT_REGISTERED',
      success: true,
      ip,
      userAgent,
      metadata: {
        referralApplied: true,
        referrerId: referrer._id.toString(),
        requiresVerification: true
      }
    });

    memoryCache.del(cacheKeys.adminDashboard);
    memoryCache.del(cacheKeys.adminSystemHealth);
    memoryCache.del(cacheKeys.adminUserSummary);

    return {
      user: this.mapToAuthUser(user, false),
      requiresVerification: true,
      verificationTarget: normalizedEmail,
      verificationPurpose: OtpPurpose.REGISTRATION,
      emailDeliveryPending: delivery.pending
    };
  }

  async login(input: LoginInput, ip?: string, userAgent?: string): Promise<AuthResponse> {
    const { identifier, password } = input;
    const cleanId = identifier.trim();

    let lookupTarget = cleanId;
    if (!cleanId.includes('@')) {
      try {
        lookupTarget = normalizePhoneNumber(cleanId);
      } catch {
        lookupTarget = cleanId;
      }
    }

    const user = await userRepository.findByIdentifier(lookupTarget, cleanId);

    // Always perform a bcrypt comparison, even for unknown identifiers, so
    // response timing does not reveal whether an account exists.
    const isMatch = await comparePassword(
      password,
      user?.passwordHash || AuthService.DUMMY_PASSWORD_HASH
    );

    if (!user) {
      await this.logSecurityEvent({
        email: cleanId,
        eventType: 'LOGIN_FAILED',
        success: false,
        ip,
        userAgent,
        metadata: { reason: 'UNKNOWN_IDENTIFIER' }
      });
      throw ApiError.unauthorized('Invalid email/phone or password');
    }

    if (!isMatch) {
      await this.logSecurityEvent({
        userId: user._id,
        email: user.email,
        eventType: 'LOGIN_FAILED',
        success: false,
        ip,
        userAgent,
        metadata: { reason: 'INVALID_PASSWORD' }
      });
      throw ApiError.unauthorized('Invalid email/phone or password');
    }

    if (
      user.isDeleted ||
      user.accountStatus === AccountStatus.BLOCKED ||
      (user.accountStatus === AccountStatus.SUSPENDED &&
        (!user.suspendedUntil || user.suspendedUntil > new Date()))
    ) {
      await this.logSecurityEvent({
        userId: user._id,
        email: user.email,
        eventType: 'LOGIN_BLOCKED',
        success: false,
        ip,
        userAgent,
        metadata: { accountStatus: user.accountStatus }
      });
      throw ApiError.forbidden(
        user.statusReason || 'This account is currently blocked or suspended. Please contact support.'
      );
    }

    // Email verification is mandatory before normal account access. No
    // auto-verification shortcut is allowed here.
    const requiresEmailVerification = Boolean(user.email) && !user.isEmailVerified;
    if (requiresEmailVerification || !user.isActive) {
      await this.logSecurityEvent({
        userId: user._id,
        email: user.email,
        eventType: 'LOGIN_BLOCKED',
        success: false,
        ip,
        userAgent,
        metadata: { reason: 'EMAIL_NOT_VERIFIED' }
      });
      throw new ApiError(
        403,
        'Please verify your email address before signing in.',
        'EMAIL_NOT_VERIFIED',
        {
          target: user.email,
          purpose: OtpPurpose.REGISTRATION
        }
      );
    }

    // Ensure every active account has a usable referral code. Older admin
    // accounts created before referral codes were mandatory may otherwise have
    // no code to share.
    if (!user.referralCode) {
      user.referralCode = await this.generateUniqueReferralCode();
      await user.save();
    }

    // Admin Panel login requires a second factor. Never create a full admin
    // session from the password alone.
    if (user.role === UserRole.SUPER_ADMIN) {
      const challenge = await adminTwoFactorService.startChallenge(user, ip, userAgent);
      await this.logSecurityEvent({
        userId: user._id,
        email: user.email,
        eventType: 'LOGIN_SUCCESS',
        success: true,
        ip,
        userAgent,
        metadata: {
          passwordVerified: true,
          adminTwoFactorMode: challenge.mode,
          requiresAdmin2FA: true
        }
      });

      return {
        user: this.mapToAuthUser(user, false, {
          enabled: challenge.mode === 'VERIFY',
          verified: false
        }),
        requiresVerification: false,
        requiresAdmin2FA: true,
        adminTwoFactorMode: challenge.mode,
        adminTwoFactorChallengeToken: challenge.challengeToken,
        adminTwoFactorExpiresAt: challenge.expiresAt,
        adminTwoFactorSetup: challenge.setup
      };
    }

    user.lastLoginAt = new Date();
    await user.save();

    const activeSub = await subscriptionRepository.findActiveByUserId(user._id);

    const token = signAccessToken(user._id.toString());

    await this.logSecurityEvent({
      userId: user._id,
      email: user.email,
      eventType: 'LOGIN_SUCCESS',
      success: true,
      ip,
      userAgent
    });

    return {
      user: this.mapToAuthUser(user, !!activeSub),
      token,
      requiresVerification: false
    };
  }

  async verifyOtp(input: VerifyOtpInput): Promise<AuthResponse> {
    const { target, code, purpose } = input;
    const cleanTarget = target.toLowerCase().trim();
    const now = new Date();

    const record = await OtpVerificationModel.findOne({
      target: cleanTarget,
      purpose,
      isUsed: false,
      expiresAt: { $gt: now }
    }).sort({ createdAt: -1 });

    if (!record) {
      throw ApiError.badRequest('Invalid or expired verification code. Please request a new one.');
    }

    if (record.attempts >= env.OTP_MAX_ATTEMPTS) {
      record.isUsed = true;
      await record.save();
      throw ApiError.badRequest(
        'Maximum verification attempts exceeded. Code has been invalidated. Please request a new code.'
      );
    }

    const providedHash = this.hashOtp(code, cleanTarget);
    if (record.codeHash !== providedHash) {
      record.attempts += 1;
      await record.save();
      const remaining = Math.max(0, env.OTP_MAX_ATTEMPTS - record.attempts);
      throw ApiError.badRequest(`Incorrect verification code. ${remaining} attempt(s) remaining.`);
    }

    // Mark as consumed immediately (single-use enforcement).
    record.isUsed = true;
    await record.save();

    const user = await userRepository.findByIdentifier(cleanTarget);
    if (!user) {
      throw ApiError.notFound('Account associated with this verification target was not found.');
    }

    const isEmail = cleanTarget.includes('@');
    if (isEmail) {
      user.isEmailVerified = true;
      user.emailVerifiedAt = new Date();
    } else {
      user.isPhoneVerified = true;
    }

    // Only an account whose status is ACTIVE may be re-activated. A banned or
    // suspended account must never become usable through OTP verification.
    if (user.accountStatus === AccountStatus.ACTIVE) {
      user.isActive = true;
    }

    await user.save();

    const activeSub = await subscriptionRepository.findActiveByUserId(user._id);

    const token = signAccessToken(user._id.toString());

    await this.logSecurityEvent({
      userId: user._id,
      email: user.email,
      eventType: 'LOGIN_SUCCESS',
      success: true,
      metadata: { verification: isEmail ? 'EMAIL' : 'PHONE' }
    });

    return {
      user: this.mapToAuthUser(user, !!activeSub),
      token,
      requiresVerification: false
    };
  }

  async verifyAdminTwoFactor(input: {
    challengeToken: string;
    code?: string;
    recoveryCode?: string;
    ip?: string;
    userAgent?: string;
    allowedPurposes?: Array<'SETUP' | 'LOGIN' | 'REPLACE'>;
  }): Promise<AuthResponse> {
    const result = await adminTwoFactorService.verifyChallenge(input);
    const activeSub = await subscriptionRepository.findActiveByUserId(result.user._id);

    return {
      user: this.mapToAuthUser(result.user, !!activeSub, { enabled: true, verified: true }),
      token: result.token,
      requiresVerification: false,
      requiresAdmin2FA: false,
      recoveryCodes: result.recoveryCodes,
      recoveryCodeUsed: result.recoveryCodeUsed
    };
  }

  async getAdminTwoFactorStatus(userId: string) {
    return adminTwoFactorService.getStatus(userId);
  }

  async regenerateAdminRecoveryCodes(userId: string, code: string, ip?: string) {
    const user = await userRepository.findById(userId);
    if (!user) throw ApiError.unauthorized('User not found.');
    return adminTwoFactorService.regenerateRecoveryCodes(user, code, ip);
  }

  async startAdminTwoFactorReplacement(
    userId: string,
    currentCode: string,
    ip?: string,
    userAgent?: string
  ) {
    const user = await userRepository.findById(userId);
    if (!user) throw ApiError.unauthorized('User not found.');
    return adminTwoFactorService.startReplacement(user, currentCode, ip, userAgent);
  }

  async disableAdminTwoFactor(userId: string, password: string, code: string, ip?: string) {
    const user = await userRepository.findById(userId);
    if (!user) throw ApiError.unauthorized('User not found.');
    await adminTwoFactorService.disable(user, password, code, ip);
    memoryCache.del(cacheKeys.authContext(userId));
    return { success: true };
  }

  async resendOtp(input: ResendOtpInput, ip?: string): Promise<{ success: boolean; cooldownSeconds: number }> {    const { target, purpose } = input;
    const cleanTarget = target.toLowerCase().trim();
    const now = new Date();

    const user = await userRepository.findByIdentifier(cleanTarget);

    // Generic response prevents account enumeration. For a nonexistent or
    // already-verified account nothing is sent.
    if (!user) {
      return { success: true, cooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS };
    }

    if (purpose === OtpPurpose.REGISTRATION && (!user.email || user.isEmailVerified)) {
      return { success: true, cooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS };
    }

    const latest = await OtpVerificationModel.findOne({
      target: cleanTarget,
      purpose
    }).sort({ createdAt: -1 });

    if (latest && latest.lastSentAt) {
      const elapsedMs = now.getTime() - new Date(latest.lastSentAt).getTime();
      const cooldownMs = env.OTP_RESEND_COOLDOWN_SECONDS * 1000;
      if (elapsedMs < cooldownMs) {
        return {
          success: true,
          cooldownSeconds: Math.max(1, Math.ceil((cooldownMs - elapsedMs) / 1000))
        };
      }
    }

    const hourlyCount = await OtpVerificationModel.countDocuments({
      target: cleanTarget,
      purpose,
      createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) }
    });
    if (hourlyCount >= env.OTP_MAX_RESENDS_PER_HOUR) {
      return { success: true, cooldownSeconds: 60 * 60 };
    }

    const otp = await this.createOtpRecord({
      target: cleanTarget,
      purpose,
      ip
    });

    if (cleanTarget.includes('@')) {
      await this.deliverEmailOtp({
        to: cleanTarget,
        name: user.name,
        rawOtp: otp.rawOtp,
        purpose,
        recordId: otp.recordId,
        userId: user._id.toString()
      });
    } else {
      await smsService.sendVerificationOtp(cleanTarget, otp.rawOtp).catch((error: any) => {
        logger.error('Verification SMS delivery failed', { error: error?.message });
      });
    }

    return { success: true, cooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS };
  }

  async forgotPassword(input: ForgotPasswordInput, ip?: string): Promise<{ message: string }> {
    const cleanTarget = input.target.toLowerCase().trim();
    const user = await userRepository.findByIdentifier(cleanTarget);

    // Generic response to prevent account enumeration
    if (!user) {
      return { message: 'If an account exists with this email or phone number, a verification code has been dispatched.' };
    }

    const otp = await this.createOtpRecord({
      target: cleanTarget,
      purpose: OtpPurpose.PASSWORD_RESET,
      ip
    });

    if (cleanTarget.includes('@')) {
      await this.deliverEmailOtp({
        to: cleanTarget,
        name: user.name,
        rawOtp: otp.rawOtp,
        purpose: OtpPurpose.PASSWORD_RESET,
        recordId: otp.recordId,
        userId: user._id.toString()
      });
    } else {
      await smsService.sendPasswordResetOtp(cleanTarget, otp.rawOtp).catch((error: any) => {
        logger.error('Password reset SMS delivery failed', { error: error?.message });
      });
    }

    return { message: 'If an account exists with this email or phone number, a verification code has been dispatched.' };
  }

  async resetPassword(input: ResetPasswordInput, ip?: string, userAgent?: string): Promise<{ success: boolean; message: string }> {
    const { target, code, newPassword } = input;
    const cleanTarget = target.toLowerCase().trim();
    const now = new Date();

    const record = await OtpVerificationModel.findOne({
      target: cleanTarget,
      purpose: OtpPurpose.PASSWORD_RESET,
      isUsed: false,
      expiresAt: { $gt: now }
    }).sort({ createdAt: -1 });

    if (!record) {
      throw ApiError.badRequest('Invalid or expired password reset code.');
    }

    if (record.attempts >= env.OTP_MAX_ATTEMPTS) {
      record.isUsed = true;
      await record.save();
      throw ApiError.badRequest('Maximum attempts exceeded. Please request a new password reset code.');
    }

    const providedHash = this.hashOtp(code, cleanTarget);
    if (record.codeHash !== providedHash) {
      record.attempts += 1;
      await record.save();
      throw ApiError.badRequest('Incorrect verification code.');
    }

    record.isUsed = true;
    await record.save();

    const user = await userRepository.findByIdentifier(cleanTarget);
    if (!user) {
      throw ApiError.notFound('Account not found.');
    }

    user.passwordHash = await hashPassword(newPassword);
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date();
    user.sessionsRevokedAt = new Date();
    await user.save();

    await this.logSecurityEvent({
      userId: user._id,
      email: user.email,
      eventType: 'PASSWORD_RESET',
      success: true,
      ip,
      userAgent
    });

    return { success: true, message: 'Password has been successfully reset. You can now login.' };
  }

  async changePassword(userId: string, input: ChangePasswordInput, ip?: string, userAgent?: string): Promise<{ success: boolean }> {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw ApiError.unauthorized('User not found.');
    }

    const isMatch = await comparePassword(input.oldPassword, user.passwordHash);
    if (!isMatch) {
      throw ApiError.badRequest('Current password is incorrect.');
    }

    user.passwordHash = await hashPassword(input.newPassword);
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date();
    await user.save();

    memoryCache.del(cacheKeys.authContext(user._id.toString()));
    memoryCache.del(cacheKeys.userDashboard(user._id.toString()));

    await this.logSecurityEvent({
      userId: user._id,
      email: user.email,
      eventType: 'PASSWORD_CHANGED',
      success: true,
      ip,
      userAgent
    });

    return { success: true };
  }

  async updateProfile(userId: string, input: { name?: string; phone?: string }): Promise<AuthUser> {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw ApiError.unauthorized('User not found.');
    }

    if (input.name !== undefined) {
      const cleanName = input.name.trim();
      if (!cleanName || cleanName.length < 2) {
        throw ApiError.badRequest('Name must be at least 2 characters long.');
      }
      user.name = cleanName;
    }

    if (input.phone !== undefined) {
      const cleanPhone = input.phone.trim();
      if (cleanPhone && cleanPhone !== user.phone) {
        let normalizedPhone = cleanPhone;
        try {
          normalizedPhone = normalizePhoneNumber(cleanPhone);
        } catch {
          normalizedPhone = cleanPhone;
        }
        const existing = await userRepository.findByPhone(normalizedPhone);
        if (existing && existing._id.toString() !== user._id.toString()) {
          throw ApiError.badRequest('Phone number is already associated with another account.');
        }
        user.phone = normalizedPhone;
      }
    }

    await user.save();
    memoryCache.del(cacheKeys.userDashboard(user._id.toString()));
    memoryCache.del(cacheKeys.authContext(user._id.toString()));
    const activeSub = await subscriptionRepository.findActiveByUserId(user._id);
    return this.mapToAuthUser(user, !!activeSub);
  }

  private mapToAuthUser(
    user: any,
    hasActiveSub: boolean,
    adminTwoFactor?: { enabled: boolean; verified: boolean }
  ): AuthUser {
    return {
      id: user._id.toString(),
      name: user.name || 'Member',
      email: user.email,
      phone: user.phone,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
      isPhoneVerified: user.isPhoneVerified,
      isActive: user.isActive,
      mustChangePassword: Boolean(user.mustChangePassword),
      passwordChangedAt: user.passwordChangedAt ? new Date(user.passwordChangedAt).toISOString() : undefined,
      referralCode: user.referralCode,
      hasActiveSubscription: hasActiveSub || user.role === UserRole.SUPER_ADMIN || user.role === UserRole.MODERATOR,
      adminTwoFactorEnabled: adminTwoFactor?.enabled,
      adminTwoFactorVerified: adminTwoFactor?.verified,
      createdAt: user.createdAt.toISOString()
    };
  }
}

export const authService = new AuthService();
