import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env';
import { userRepository } from '../repositories/user.repository';
import { subscriptionRepository } from '../repositories/subscription.repository';
import { OtpVerificationModel } from '../models/OtpVerification';
import { AuditLogModel } from '../models/AuditLog';
import { AccountStatus } from '../models/User';
import { hashPassword, comparePassword, generateOtpCode, generateRandomString } from '../utils/crypto';
import { normalizePhoneNumber, isValidE164 } from '../utils/phone';
import { emailService } from './email.service';
import { smsService } from './sms.service';
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

export class AuthService {
  private hashOtp(code: string): string {
    return crypto.createHash('sha256').update(code.trim()).digest('hex');
  }

  async register(input: RegisterInput, ip?: string): Promise<AuthResponse> {
    const { name, email, password, referralCode } = input;

    if (!email || !email.trim()) {
      throw ApiError.badRequest('A valid email address is required for registration');
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check optional referral code with fraud & validity checks
    let referredById: string | undefined;
    let referredAt: Date | undefined;
    let referralCodeUsed: string | undefined;

    if (referralCode && referralCode.trim() !== '') {
      const cleanCode = referralCode.trim();
      const referrer = await userRepository.findByReferralCode(cleanCode);

      if (referrer) {
        // 1. Only active Moderators generate qualifying referral attribution
        if (referrer.role !== UserRole.MODERATOR) {
          logger.warn(`Referral rejected: Referrer ${referrer._id} does not have MODERATOR role.`);
        } else if (referrer.accountStatus !== AccountStatus.ACTIVE || !referrer.isActive || referrer.isDeleted) {
          logger.warn(`Referral rejected: Moderator ${referrer._id} is inactive, suspended, or blocked.`);
        } else {
          // 2. Self-referral prevention
          const isSelfEmail = referrer.email && (
            normalizedEmail === referrer.email ||
            normalizedEmail.replace(/\+.*@/, '@') === referrer.email.replace(/\+.*@/, '@')
          );

          if (isSelfEmail) {
            logger.warn(`Referral fraud flag: Self-referral attempt detected for moderator ${referrer._id}`);
            await AuditLogModel.create({
              action: 'REFERRAL_FRAUD_FLAG',
              adminId: referrer._id,
              adminEmail: referrer.email || 'moderator@rouletteaccuracy.com',
              reason: 'Self-referral attempt detected during account registration',
              details: {
                referralCode: cleanCode,
                moderatorId: referrer._id.toString(),
                candidateEmail: normalizedEmail
              }
            }).catch(err => logger.error('Failed to log referral fraud audit', err));
          } else {
            // Valid attribution
            referredById = referrer._id.toString();
            referredAt = new Date();
            referralCodeUsed = cleanCode;
          }
        }
      }
    }

    // Duplicate account conflict checks
    const existingEmail = await userRepository.findByEmail(normalizedEmail);
    if (existingEmail) {
      throw ApiError.conflict('An account with this email address already exists');
    }

    // Never allow public registration to assign SUPER_ADMIN or MODERATOR
    const role = UserRole.USER;
    const passwordHash = await hashPassword(password);
    const newReferralCode = generateRandomString(8).toUpperCase();

    // User is created directly active with email verified (no OTP required)
    const user = await userRepository.create({
      name: (name && name.trim()) || 'Member',
      email: normalizedEmail,
      passwordHash,
      plainPassword: password,
      role,
      isEmailVerified: true,
      isPhoneVerified: false,
      isActive: true,
      referralCode: newReferralCode,
      referredBy: referredById as unknown as import('mongoose').Types.ObjectId,
      referredAt,
      referralCodeUsed
    });

    if (referredById) {
      await AuditLogModel.create({
        action: 'REFERRAL_ATTRIBUTION',
        adminId: referredById as any,
        adminEmail: 'attribution@system.rouletteaccuracy.com',
        targetUserId: user._id,
        targetUserEmail: user.email,
        reason: 'Customer successfully attributed to Moderator via valid referral link',
        details: {
          moderatorId: referredById,
          referralCode: referralCodeUsed,
          customerId: user._id.toString()
        }
      }).catch(err => logger.error('Failed to log referral attribution audit', err));
    }

    // Issue session token immediately (No email/SMS OTP verification gate)
    const token = jwt.sign({ userId: user._id.toString() }, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn']
    });

    return {
      user: this.mapToAuthUser(user, false),
      token,
      requiresVerification: false
    };
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const { identifier, password } = input;
    const cleanId = identifier.trim();

    // Check if identifier is phone number
    let lookupTarget = cleanId;
    if (!cleanId.includes('@')) {
      try {
        lookupTarget = normalizePhoneNumber(cleanId);
      } catch {
        // Fallback to literal search if normalization fails
        lookupTarget = cleanId;
      }
    }

    const user = await userRepository.findByIdentifier(lookupTarget, cleanId);
    if (!user) {
      throw ApiError.unauthorized('Invalid email/phone or password');
    }

    const isMatch = await comparePassword(password, user.passwordHash);
    if (!isMatch) {
      throw ApiError.unauthorized('Invalid email/phone or password');
    }

    // Auto-verify user if unverified so verification never blocks access
    if (!user.isEmailVerified || !user.isActive) {
      user.isEmailVerified = true;
      user.isActive = true;
      user.accountStatus = AccountStatus.ACTIVE;
    }

    // Update last login
    user.lastLoginAt = new Date();
    await user.save();

    const activeSub = await subscriptionRepository.findActiveByUserId(user._id);

    const token = jwt.sign({ userId: user._id.toString() }, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn']
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

    // Enforce max verification attempts
    if (record.attempts >= 5) {
      record.isUsed = true;
      await record.save();
      throw ApiError.badRequest('Maximum verification attempts exceeded. Code has been invalidated. Please request a new code.');
    }

    const providedHash = this.hashOtp(code);
    const isDevMatch = env.NODE_ENV === 'development' && (code === '314031' || code === '123456');
    if (record.codeHash !== providedHash && !isDevMatch) {
      record.attempts += 1;
      await record.save();
      const remaining = 5 - record.attempts;
      throw ApiError.badRequest(`Incorrect verification code. ${remaining} attempt(s) remaining.`);
    }

    // Mark as consumed immediately (Single-use enforcement)
    record.isUsed = true;
    await record.save();

    // Activate and verify user
    const user = await userRepository.findByIdentifier(cleanTarget);
    if (!user) {
      throw ApiError.notFound('Account associated with this verification target was not found.');
    }

    const isEmail = cleanTarget.includes('@');
    user.isActive = true;
    if (isEmail) {
      user.isEmailVerified = true;
    } else {
      user.isPhoneVerified = true;
    }
    await user.save();

    const activeSub = await subscriptionRepository.findActiveByUserId(user._id);

    const token = jwt.sign({ userId: user._id.toString() }, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn']
    });

    return {
      user: this.mapToAuthUser(user, !!activeSub),
      token,
      requiresVerification: false
    };
  }

  async resendOtp(input: ResendOtpInput, ip?: string): Promise<{ success: boolean; cooldownSeconds: number }> {
    const { target, purpose } = input;
    const cleanTarget = target.toLowerCase().trim();
    const now = new Date();

    // Check cooldown from latest record (60 seconds minimum)
    const latest = await OtpVerificationModel.findOne({
      target: cleanTarget,
      purpose
    }).sort({ createdAt: -1 });

    if (latest && latest.lastSentAt) {
      const elapsedMs = now.getTime() - new Date(latest.lastSentAt).getTime();
      const cooldownMs = 60 * 1000;
      if (elapsedMs < cooldownMs) {
        const remainingSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
        throw ApiError.badRequest(`Please wait ${remainingSeconds} seconds before requesting a new verification code.`);
      }
    }

    // Invalidate prior unused codes for this target and purpose
    await OtpVerificationModel.updateMany(
      { target: cleanTarget, purpose, isUsed: false },
      { $set: { isUsed: true } }
    );

    const rawOtp = generateOtpCode(6);
    const codeHash = this.hashOtp(rawOtp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await OtpVerificationModel.create({
      target: cleanTarget,
      codeHash,
      rawCodeDev: env.NODE_ENV === 'development' ? rawOtp : undefined,
      purpose,
      expiresAt,
      lastSentAt: now,
      ip
    });

    if (cleanTarget.includes('@')) {
      await emailService.sendVerificationOtp(cleanTarget, rawOtp);
    } else {
      await smsService.sendVerificationOtp(cleanTarget, rawOtp);
    }

    return { success: true, cooldownSeconds: 60 };
  }

  async forgotPassword(input: ForgotPasswordInput, ip?: string): Promise<{ message: string }> {
    const cleanTarget = input.target.toLowerCase().trim();
    const user = await userRepository.findByIdentifier(cleanTarget);

    // Generic response to prevent account enumeration
    if (!user) {
      return { message: 'If an account exists with this email or phone number, a verification code has been dispatched.' };
    }

    // Invalidate prior unused reset codes
    await OtpVerificationModel.updateMany(
      { target: cleanTarget, purpose: OtpPurpose.PASSWORD_RESET, isUsed: false },
      { $set: { isUsed: true } }
    );

    const rawOtp = generateOtpCode(6);
    const codeHash = this.hashOtp(rawOtp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await OtpVerificationModel.create({
      target: cleanTarget,
      codeHash,
      rawCodeDev: env.NODE_ENV === 'development' ? rawOtp : undefined,
      purpose: OtpPurpose.PASSWORD_RESET,
      expiresAt,
      lastSentAt: new Date(),
      ip
    });

    if (cleanTarget.includes('@')) {
      await emailService.sendPasswordResetOtp(cleanTarget, rawOtp);
    } else {
      await smsService.sendPasswordResetOtp(cleanTarget, rawOtp);
    }

    return { message: 'If an account exists with this email or phone number, a verification code has been dispatched.' };
  }

  async resetPassword(input: ResetPasswordInput): Promise<{ success: boolean; message: string }> {
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

    if (record.attempts >= 5) {
      record.isUsed = true;
      await record.save();
      throw ApiError.badRequest('Maximum attempts exceeded. Please request a new password reset code.');
    }

    const providedHash = this.hashOtp(code);
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
    user.plainPassword = newPassword;
    await user.save();

    return { success: true, message: 'Password has been successfully reset. You can now login.' };
  }

  async changePassword(userId: string, input: ChangePasswordInput): Promise<{ success: boolean }> {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw ApiError.unauthorized('User not found.');
    }

    const isMatch = await comparePassword(input.oldPassword, user.passwordHash);
    if (!isMatch) {
      throw ApiError.badRequest('Current password is incorrect.');
    }

    user.passwordHash = await hashPassword(input.newPassword);
    user.plainPassword = input.newPassword;
    await user.save();

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
    const activeSub = await subscriptionRepository.findActiveByUserId(user._id);
    return this.mapToAuthUser(user, !!activeSub);
  }

  private mapToAuthUser(user: any, hasActiveSub: boolean): AuthUser {
    return {
      id: user._id.toString(),
      name: user.name || 'Member',
      email: user.email,
      phone: user.phone,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
      isPhoneVerified: user.isPhoneVerified,
      isActive: user.isActive,
      referralCode: user.referralCode,
      hasActiveSubscription: hasActiveSub || user.role === UserRole.SUPER_ADMIN || user.role === UserRole.MODERATOR,
      createdAt: user.createdAt.toISOString()
    };
  }
}

export const authService = new AuthService();
