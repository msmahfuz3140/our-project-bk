import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { UserModel, AccountStatus, IUser } from '../models/User';
import { AdminTwoFactorModel, IAdminTwoFactor } from '../models/AdminTwoFactor';
import { AdminRecoveryCodeModel } from '../models/AdminRecoveryCode';
import {
  AdminTwoFactorChallengeModel,
  Admin2FAChallengePurpose
} from '../models/AdminTwoFactorChallenge';
import { AuditLogModel, AuditActionType } from '../models/AuditLog';
import { UserRole } from '../shared/roles';
import { ApiError } from '../utils/apiError';
import { comparePassword } from '../utils/crypto';
import { logger } from '../utils/logger';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  safeHashEqual
} from '../utils/twoFactorCrypto';
import { generateTotpSecret, totpProvisioningUri, verifyTotpAndGetStep } from '../utils/totp';
import { signAccessToken, signAdmin2FAChallenge } from '../utils/sessionToken';
import { transactionalEmailService } from './transactionalEmail.service';
import { adminSecurityNotice } from './emailTemplates';
import { notificationService } from './notification.service';

const CHALLENGE_GRACE_MS = 5_000;

export interface Admin2FASetupData {
  otpauthUrl: string;
  manualKey: string;
  issuer: string;
  accountName: string;
  expiresAt: string;
}

export interface Admin2FAChallengeResult {
  mode: 'SETUP' | 'VERIFY' | 'REPLACE';
  challengeToken: string;
  expiresAt: string;
  setup?: Admin2FASetupData;
}

export interface Admin2FAStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
  recoveryCodesGeneratedAt?: string;
  lastVerifiedAt?: string;
  lockedUntil?: string;
}

export interface Admin2FAVerificationResult {
  user: IUser;
  token: string;
  recoveryCodes?: string[];
  recoveryCodeUsed?: boolean;
}

function challengePurposeLabel(purpose: Admin2FAChallengePurpose): string {
  if (purpose === 'SETUP') return 'Authenticator setup';
  if (purpose === 'REPLACE') return 'Authenticator replacement';
  return 'Admin login';
}

export class AdminTwoFactorService {
  private assertAdmin(user: IUser): void {
    if (user.role !== UserRole.SUPER_ADMIN) {
      throw ApiError.forbidden('Two-factor authentication management is restricted to Main Admins');
    }
    if (user.isDeleted || user.accountStatus !== AccountStatus.ACTIVE || !user.isActive) {
      throw ApiError.forbidden('This administrator account is not active');
    }
  }

  private async getOrCreateRecord(userId: string | mongoose.Types.ObjectId): Promise<IAdminTwoFactor> {
    const objectId = new mongoose.Types.ObjectId(userId.toString());
    const record = await AdminTwoFactorModel.findOneAndUpdate(
      { userId: objectId },
      {
        $setOnInsert: {
          userId: objectId,
          enabled: false,
          failedAttempts: 0
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).select('+secretEncrypted +pendingSecretEncrypted');
    return record!;
  }

  private async findRecordWithSecrets(userId: string): Promise<IAdminTwoFactor | null> {
    return AdminTwoFactorModel.findOne({ userId: new mongoose.Types.ObjectId(userId) }).select(
      '+secretEncrypted +pendingSecretEncrypted'
    );
  }

  private async logAudit(params: {
    user: Pick<IUser, '_id' | 'email'>;
    action: AuditActionType;
    reason: string;
    details?: Record<string, unknown>;
    targetUserId?: string;
    targetUserEmail?: string;
  }): Promise<void> {
    try {
      await AuditLogModel.create({
        action: params.action,
        adminId: params.user._id,
        adminEmail: params.user.email || 'admin@rouletteaccuracy.com',
        targetUserId: params.targetUserId
          ? new mongoose.Types.ObjectId(params.targetUserId)
          : params.user._id,
        targetUserEmail: params.targetUserEmail || params.user.email,
        targetResourceId: params.targetUserId || params.user._id.toString(),
        resourceType: 'AdminTwoFactor',
        reason: params.reason,
        details: params.details
      });
    } catch (error) {
      logger.error('Failed to write admin 2FA audit event', { error: String(error) });
    }
  }

  private async sendSecurityNotice(params: {
    user: Pick<IUser, '_id' | 'name' | 'email'>;
    eventKey: string;
    title: string;
    message: string;
  }): Promise<void> {
    if (!params.user.email) return;

    try {
      const rendered = adminSecurityNotice({
        name: params.user.name,
        title: params.title,
        message: params.message,
        occurredAt: new Date(),
        supportUrl: `${env.PUBLIC_FRONTEND_URL.replace(/\/$/, '')}/contact`
      });
      await transactionalEmailService.send({
        idempotencyKey: `admin-2fa:${params.eventKey}:${params.user._id}`,
        userId: params.user._id,
        toEmail: params.user.email,
        templateKey: 'ADMIN_2FA_SECURITY_NOTICE',
        rendered,
        metadata: { event: params.eventKey, title: params.title }
      });
    } catch (error: any) {
      logger.error('Admin 2FA security notice could not be queued', {
        userId: params.user._id.toString(),
        eventKey: params.eventKey,
        error: error?.message
      });
    }

    await notificationService
      .createNotification(
        params.user._id,
        'SECURITY_ALERT',
        `Admin Security: ${params.title}`,
        params.message,
        '/heda/security'
      )
      .catch(() => null);
  }

  private async createChallenge(params: {
    userId: string;
    purpose: Admin2FAChallengePurpose;
    ip?: string;
    userAgent?: string;
  }): Promise<{ challengeToken: string; expiresAt: Date }> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.max(60, env.ADMIN_2FA_CHALLENGE_TTL_SECONDS) * 1000);

    // Invalidate older outstanding challenges for the same purpose.
    await AdminTwoFactorChallengeModel.updateMany(
      {
        userId: new mongoose.Types.ObjectId(params.userId),
        purpose: params.purpose,
        usedAt: { $exists: false }
      },
      { $set: { usedAt: now } }
    );

    const challengeId = new mongoose.Types.ObjectId().toString();
    await AdminTwoFactorChallengeModel.create({
      challengeId,
      userId: new mongoose.Types.ObjectId(params.userId),
      purpose: params.purpose,
      expiresAt,
      attempts: 0,
      ip: params.ip,
      userAgent: params.userAgent?.slice(0, 500)
    });

    return {
      challengeToken: signAdmin2FAChallenge({
        userId: params.userId,
        challengeId,
        purpose: params.purpose
      }),
      expiresAt
    };
  }

  private async loadChallenge(challengeToken: string, expectedPurpose: Admin2FAChallengePurpose) {
    let decoded: any;
    try {
      decoded = jwt.verify(String(challengeToken || ''), env.JWT_SECRET);
    } catch {
      throw ApiError.unauthorized(
        'The verification challenge is invalid or expired. Please sign in again.',
        'ADMIN_2FA_CHALLENGE_EXPIRED'
      );
    }

    if (
      !decoded ||
      decoded.scope !== 'admin_2fa_challenge' ||
      decoded.purpose !== expectedPurpose ||
      !decoded.userId ||
      !decoded.challengeId
    ) {
      throw ApiError.unauthorized(
        'The verification challenge is invalid. Please sign in again.',
        'ADMIN_2FA_CHALLENGE_INVALID'
      );
    }

    const challenge = await AdminTwoFactorChallengeModel.findOne({
      challengeId: String(decoded.challengeId),
      userId: new mongoose.Types.ObjectId(String(decoded.userId)),
      purpose: expectedPurpose
    });

    if (!challenge) {
      throw ApiError.unauthorized(
        'The verification challenge was not found. Please sign in again.',
        'ADMIN_2FA_CHALLENGE_INVALID'
      );
    }

    if (challenge.usedAt) {
      throw ApiError.unauthorized(
        'This verification challenge has already been used. Please sign in again.',
        'ADMIN_2FA_CHALLENGE_USED'
      );
    }

    if (challenge.expiresAt.getTime() + CHALLENGE_GRACE_MS <= Date.now()) {
      throw ApiError.unauthorized(
        'This verification challenge has expired. Please sign in again.',
        'ADMIN_2FA_CHALLENGE_EXPIRED'
      );
    }

    if (challenge.attempts >= env.ADMIN_2FA_MAX_ATTEMPTS) {
      throw ApiError.tooManyRequests(
        'Too many invalid verification attempts. Please sign in again.',
        Math.ceil((challenge.expiresAt.getTime() - Date.now()) / 1000)
      );
    }

    const user = await UserModel.findById(challenge.userId);
    if (!user) {
      throw ApiError.unauthorized('Administrator account not found.');
    }
    this.assertAdmin(user);

    return { decoded, challenge, user };
  }

  private async markChallengeUsed(challengeId: string): Promise<void> {
    const result = await AdminTwoFactorChallengeModel.findOneAndUpdate(
      { challengeId, usedAt: { $exists: false } },
      { $set: { usedAt: new Date() } },
      { new: true }
    );
    if (!result) {
      throw ApiError.unauthorized(
        'This verification challenge has already been used. Please sign in again.',
        'ADMIN_2FA_CHALLENGE_USED'
      );
    }
  }

  private async recordFailedAttempt(params: {
    user: IUser;
    challenge?: any;
    reason: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    const record = await this.getOrCreateRecord(params.user._id);
    const attempts = record.failedAttempts + 1;
    const shouldLock = attempts >= Math.max(3, env.ADMIN_2FA_MAX_ATTEMPTS);

    await AdminTwoFactorModel.updateOne(
      { userId: record.userId },
      {
        $set: {
          failedAttempts: attempts,
          ...(shouldLock
            ? { lockedUntil: new Date(Date.now() + Math.max(1, env.ADMIN_2FA_LOCK_MINUTES) * 60 * 1000) }
            : {})
        }
      }
    );

    if (params.challenge) {
      await AdminTwoFactorChallengeModel.updateOne(
        { _id: params.challenge._id },
        {
          $inc: { attempts: 1 },
          ...(attempts >= env.ADMIN_2FA_MAX_ATTEMPTS ? { $set: { usedAt: new Date() } } : {})
        }
      ).catch(() => null);
    }

    await this.logAudit({
      user: params.user,
      action: 'ADMIN_2FA_FAILED',
      reason: params.reason,
      details: {
        attempts,
        locked: shouldLock,
        ip: params.ip,
        userAgent: params.userAgent?.slice(0, 300)
      }
    });
  }

  private async assertNotLocked(record: IAdminTwoFactor): Promise<void> {
    if (record.lockedUntil && record.lockedUntil.getTime() > Date.now()) {
      const remaining = Math.ceil((record.lockedUntil.getTime() - Date.now()) / 1000);
      throw ApiError.tooManyRequests(
        'Too many failed authenticator attempts. This admin login is temporarily locked.',
        remaining
      );
    }
  }

  private async claimTimeStep(userId: string, timeStep: number): Promise<boolean> {
    const updated = await AdminTwoFactorModel.findOneAndUpdate(
      {
        userId: new mongoose.Types.ObjectId(userId),
        $or: [
          { lastUsedTimeStep: { $exists: false } },
          { lastUsedTimeStep: { $lt: timeStep } }
        ]
      },
      {
        $set: {
          lastUsedTimeStep: timeStep,
          lastVerifiedAt: new Date(),
          failedAttempts: 0
        },
        $unset: { lockedUntil: '' }
      },
      { new: true }
    );
    return Boolean(updated);
  }

  /** Starts the challenge returned after a successful password check. */
  async startChallenge(user: IUser, ip?: string, userAgent?: string): Promise<Admin2FAChallengeResult> {
    this.assertAdmin(user);
    const record = await this.getOrCreateRecord(user._id);
    await this.assertNotLocked(record);

    if (record.enabled) {
      const challenge = await this.createChallenge({
        userId: user._id.toString(),
        purpose: 'LOGIN',
        ip,
        userAgent
      });
      return {
        mode: 'VERIFY',
        challengeToken: challenge.challengeToken,
        expiresAt: challenge.expiresAt.toISOString()
      };
    }

    // First login after rollout: create a pending secret that is not active
    // until the admin proves possession by entering a valid code.
    const secret = generateTotpSecret();
    const pendingExpiresAt = new Date(
      Date.now() + Math.max(60, env.ADMIN_2FA_CHALLENGE_TTL_SECONDS) * 1000
    );
    await AdminTwoFactorModel.updateOne(
      { userId: record.userId },
      {
        $set: {
          enabled: false,
          pendingSecretEncrypted: encryptTotpSecret(secret),
          pendingExpiresAt,
          failedAttempts: 0
        },
        $unset: { lockedUntil: '' }
      }
    );

    const challenge = await this.createChallenge({
      userId: user._id.toString(),
      purpose: 'SETUP',
      ip,
      userAgent
    });

    const accountName = user.email || user.name || user._id.toString();
    await this.logAudit({
      user,
      action: 'ADMIN_2FA_SETUP_STARTED',
      reason: 'Administrator began mandatory authenticator setup',
      details: { ip, userAgent: userAgent?.slice(0, 300) }
    });

    return {
      mode: 'SETUP',
      challengeToken: challenge.challengeToken,
      expiresAt: challenge.expiresAt.toISOString(),
      setup: {
        otpauthUrl: totpProvisioningUri(accountName, secret),
        manualKey: secret,
        issuer: env.ADMIN_2FA_ISSUER,
        accountName,
        expiresAt: pendingExpiresAt.toISOString()
      }
    };
  }

  private async issueVerifiedSession(
    user: IUser,
    recovered: boolean
  ): Promise<{ token: string }> {
    user.lastLoginAt = new Date();
    await user.save();
    if (recovered && user.email) {
      await this.sendSecurityNotice({
        user,
        eventKey: `recovery-code-used-${Date.now()}`,
        title: 'Recovery Code Used',
        message:
          'A one-time recovery code was used to sign in to your admin account. If this was not you, reset your authenticator immediately and contact the platform owner.'
      });
    }
    return {
      token: signAccessToken(user._id.toString(), {
        adminTwoFactorVerified: true,
        twoFactorVerifiedAt: new Date()
      })
    };
  }

  async verifyChallenge(params: {
    challengeToken: string;
    code?: string;
    recoveryCode?: string;
    ip?: string;
    userAgent?: string;
    allowedPurposes?: Admin2FAChallengePurpose[];
  }): Promise<Admin2FAVerificationResult> {
    let decoded: any;
    try {
      decoded = jwt.verify(String(params.challengeToken || ''), env.JWT_SECRET);
    } catch {
      throw ApiError.unauthorized(
        'The verification challenge is invalid or expired. Please sign in again.',
        'ADMIN_2FA_CHALLENGE_EXPIRED'
      );
    }

    const purpose = decoded?.purpose as Admin2FAChallengePurpose;
    if (purpose !== 'SETUP' && purpose !== 'LOGIN' && purpose !== 'REPLACE') {
      throw ApiError.unauthorized('Invalid verification challenge purpose.');
    }
    if (params.allowedPurposes && !params.allowedPurposes.includes(purpose)) {
      throw ApiError.unauthorized(
        'This verification challenge cannot be used on this endpoint.',
        'ADMIN_2FA_CHALLENGE_INVALID'
      );
    }

    const { challenge, user } = await this.loadChallenge(params.challengeToken, purpose);
    const record = await this.findRecordWithSecrets(user._id.toString());
    if (!record) {
      throw ApiError.badRequest('Administrator 2FA state was not found. Please sign in again.');
    }
    await this.assertNotLocked(record);

    if (purpose === 'SETUP' || purpose === 'REPLACE') {
      if (!record.pendingSecretEncrypted || !record.pendingExpiresAt) {
        throw ApiError.badRequest('No authenticator setup is pending. Please sign in again.');
      }
      if (record.pendingExpiresAt.getTime() <= Date.now()) {
        throw ApiError.badRequest('The authenticator setup window has expired. Please sign in again.');
      }

      const secret = decryptTotpSecret(record.pendingSecretEncrypted);
      if (!secret) {
        throw ApiError.badRequest('The pending authenticator secret could not be read. Please start setup again.');
      }

      const timeStep = verifyTotpAndGetStep(secret, String(params.code || ''));
      if (timeStep === null) {
        await this.recordFailedAttempt({
          user,
          challenge,
          reason: 'Invalid authenticator code during setup',
          ip: params.ip,
          userAgent: params.userAgent
        });
        throw ApiError.badRequest('Invalid authenticator code. Please try again.', 'ADMIN_2FA_INVALID_CODE');
      }

      const now = new Date();
      const updated = await AdminTwoFactorModel.findOneAndUpdate(
        {
          userId: user._id,
          pendingSecretEncrypted: record.pendingSecretEncrypted,
          pendingExpiresAt: { $gt: now }
        },
        {
          $set: {
            enabled: true,
            secretEncrypted: record.pendingSecretEncrypted,
            lastVerifiedAt: now,
            lastUsedTimeStep: timeStep,
            failedAttempts: 0,
            recoveryCodesGeneratedAt: now
          },
          $unset: {
            pendingSecretEncrypted: '',
            pendingExpiresAt: '',
            lockedUntil: ''
          }
        },
        { new: true }
      );

      if (!updated) {
        throw ApiError.conflict('Authenticator setup could not be completed. Please start again.');
      }

      const recoveryCodes = await this.replaceRecoveryCodes(user._id.toString());
      await this.markChallengeUsed(challenge.challengeId);

      await this.logAudit({
        user,
        action: purpose === 'REPLACE' ? 'ADMIN_2FA_DEVICE_REPLACED' : 'ADMIN_2FA_ENABLED',
        reason:
          purpose === 'REPLACE'
            ? 'Administrator replaced the authenticator device after verifying a new TOTP secret'
            : 'Administrator enabled mandatory authenticator-app 2FA',
        details: {
          recoveryCodesIssued: recoveryCodes.length,
          ip: params.ip,
          userAgent: params.userAgent?.slice(0, 300)
        }
      });

      await this.sendSecurityNotice({
        user,
        eventKey:
          purpose === 'REPLACE' ? `device-replaced-${Date.now()}` : `enabled-${Date.now()}`,
        title: purpose === 'REPLACE' ? 'Authenticator Device Replaced' : 'Two-Step Verification Enabled',
        message:
          purpose === 'REPLACE'
            ? 'Your admin authenticator device was replaced and new recovery codes were generated.'
            : 'Authenticator-app two-step verification is now required for your admin account.'
      });

      // Enrollment/replacement is a security boundary: invalidate any sessions
      // created before the new authenticator was proven. The fresh token below
      // is issued after this timestamp (with the existing 5s JWT grace window).
      user.sessionsRevokedAt = new Date();
      await user.save();

      const { token } = await this.issueVerifiedSession(user, false);

      return {
        user,
        token,
        recoveryCodes
      };
    }

    // Regular login challenge.
    if (!record.enabled || !record.secretEncrypted) {
      throw ApiError.badRequest('Administrator 2FA is not configured. Please sign in again to set it up.');
    }

    const now = new Date();
    if (params.recoveryCode && params.recoveryCode.trim()) {
      const used = await this.consumeRecoveryCode(user._id.toString(), params.recoveryCode, params.ip);
      if (!used) {
        await this.recordFailedAttempt({
          user,
          challenge,
          reason: 'Invalid recovery code',
          ip: params.ip,
          userAgent: params.userAgent
        });
        throw ApiError.badRequest('Invalid or already used recovery code.', 'ADMIN_2FA_RECOVERY_INVALID');
      }

      await AdminTwoFactorModel.updateOne(
        { userId: user._id },
        {
          $set: {
            lastVerifiedAt: now,
            failedAttempts: 0
          },
          $unset: { lockedUntil: '' }
        }
      );
      await this.markChallengeUsed(challenge.challengeId);
      await this.logAudit({
        user,
        action: 'ADMIN_2FA_RECOVERY_CODE_USED',
        reason: 'Administrator used a one-time recovery code to complete login',
        details: { ip: params.ip, userAgent: params.userAgent?.slice(0, 300) }
      });
      const { token } = await this.issueVerifiedSession(user, true);
      return { user, token, recoveryCodeUsed: true };
    }

    const secret = decryptTotpSecret(record.secretEncrypted);
    if (!secret) {
      throw ApiError.badRequest('The authenticator secret is unavailable. Use a recovery code or contact the owner.');
    }

    const timeStep = verifyTotpAndGetStep(secret, String(params.code || ''));
    if (timeStep === null) {
      await this.recordFailedAttempt({
        user,
        challenge,
        reason: 'Invalid authenticator code during admin login',
        ip: params.ip,
        userAgent: params.userAgent
      });
      throw ApiError.badRequest(
        'Invalid authenticator code. Open your authenticator app and try again.',
        'ADMIN_2FA_INVALID_CODE'
      );
    }

    const claimed = await this.claimTimeStep(user._id.toString(), timeStep);
    if (!claimed) {
      await this.recordFailedAttempt({
        user,
        challenge,
        reason: 'Replayed authenticator code rejected',
        ip: params.ip,
        userAgent: params.userAgent
      });
      throw ApiError.badRequest(
        'This authenticator code was already used. Wait for the next code and try again.',
        'ADMIN_2FA_REPLAYED_CODE'
      );
    }

    await this.markChallengeUsed(challenge.challengeId);
    await this.logAudit({
      user,
      action: 'ADMIN_2FA_LOGIN_SUCCESS',
      reason: 'Administrator completed password + authenticator verification',
      details: { ip: params.ip, userAgent: params.userAgent?.slice(0, 300) }
    });

    const { token } = await this.issueVerifiedSession(user, false);
    return { user, token };
  }

  private async replaceRecoveryCodes(userId: string): Promise<string[]> {
    const generated = generateRecoveryCodes();
    await AdminRecoveryCodeModel.deleteMany({ userId: new mongoose.Types.ObjectId(userId), usedAt: { $exists: false } });
    await AdminRecoveryCodeModel.insertMany(
      generated.hashedCodes.map((codeHash) => ({
        userId: new mongoose.Types.ObjectId(userId),
        codeHash
      }))
    );
    await AdminTwoFactorModel.updateOne(
      { userId: new mongoose.Types.ObjectId(userId) },
      { $set: { recoveryCodesGeneratedAt: new Date() } }
    );
    return generated.plainCodes;
  }

  private async consumeRecoveryCode(userId: string, rawCode: string, ip?: string): Promise<boolean> {
    const hash = hashRecoveryCode(rawCode);
    const codes = await AdminRecoveryCodeModel.find({
      userId: new mongoose.Types.ObjectId(userId),
      usedAt: { $exists: false }
    }).select('+codeHash');

    for (const candidate of codes) {
      if (safeHashEqual(candidate.codeHash, hash)) {
        const claimed = await AdminRecoveryCodeModel.findOneAndUpdate(
          { _id: candidate._id, usedAt: { $exists: false } },
          { $set: { usedAt: new Date(), usedIp: ip } },
          { new: true }
        );
        return Boolean(claimed);
      }
    }
    return false;
  }

  async getStatus(userId: string): Promise<Admin2FAStatus> {
    const record = await this.getOrCreateRecord(userId);
    const recoveryCodesRemaining = await AdminRecoveryCodeModel.countDocuments({
      userId: new mongoose.Types.ObjectId(userId),
      usedAt: { $exists: false }
    });

    return {
      enabled: record.enabled,
      recoveryCodesRemaining,
      recoveryCodesGeneratedAt: record.recoveryCodesGeneratedAt?.toISOString(),
      lastVerifiedAt: record.lastVerifiedAt?.toISOString(),
      lockedUntil: record.lockedUntil?.toISOString()
    };
  }

  /** Strong re-authentication used by sensitive 2FA management actions. */
  async assertCurrentTotp(userId: string, code: string): Promise<void> {
    const record = await this.findRecordWithSecrets(userId);
    if (!record || !record.enabled || !record.secretEncrypted) {
      throw ApiError.badRequest('Admin 2FA is not enabled.');
    }
    await this.assertNotLocked(record);

    const secret = decryptTotpSecret(record.secretEncrypted);
    if (!secret) throw ApiError.badRequest('The authenticator secret is unavailable.');

    const timeStep = verifyTotpAndGetStep(secret, code);
    if (timeStep === null) {
      const updated = await AdminTwoFactorModel.findOneAndUpdate(
        { userId: new mongoose.Types.ObjectId(userId) },
        { $inc: { failedAttempts: 1 } },
        { new: true }
      );
      const attempts = updated?.failedAttempts || 1;
      if (attempts >= Math.max(3, env.ADMIN_2FA_MAX_ATTEMPTS)) {
        await AdminTwoFactorModel.updateOne(
          { userId: new mongoose.Types.ObjectId(userId) },
          {
            $set: {
              lockedUntil: new Date(Date.now() + Math.max(1, env.ADMIN_2FA_LOCK_MINUTES) * 60 * 1000)
            }
          }
        );
      }
      throw ApiError.badRequest('Invalid authenticator code.', 'ADMIN_2FA_INVALID_CODE');
    }

    const claimed = await this.claimTimeStep(userId, timeStep);
    if (!claimed) {
      throw ApiError.badRequest(
        'This authenticator code was already used. Wait for the next code and try again.',
        'ADMIN_2FA_REPLAYED_CODE'
      );
    }
  }

  async regenerateRecoveryCodes(
    user: IUser,
    code: string,
    ip?: string
  ): Promise<{ recoveryCodes: string[] }> {
    this.assertAdmin(user);
    await this.assertCurrentTotp(user._id.toString(), code);
    const recoveryCodes = await this.replaceRecoveryCodes(user._id.toString());
    await this.logAudit({
      user,
      action: 'ADMIN_2FA_RECOVERY_CODES_REGENERATED',
      reason: 'Administrator regenerated recovery codes after TOTP re-authentication',
      details: { count: recoveryCodes.length, ip }
    });
    await this.sendSecurityNotice({
      user,
      eventKey: `recovery-regenerated-${Date.now()}`,
      title: 'Recovery Codes Regenerated',
      message: 'New one-time recovery codes were generated for your admin account. Older unused codes are now invalid.'
    });
    return { recoveryCodes };
  }

  async startReplacement(
    user: IUser,
    currentCode: string,
    ip?: string,
    userAgent?: string
  ): Promise<Admin2FAChallengeResult> {
    this.assertAdmin(user);
    await this.assertCurrentTotp(user._id.toString(), currentCode);

    const secret = generateTotpSecret();
    const pendingExpiresAt = new Date(
      Date.now() + Math.max(60, env.ADMIN_2FA_CHALLENGE_TTL_SECONDS) * 1000
    );
    await AdminTwoFactorModel.updateOne(
      { userId: user._id },
      {
        $set: {
          pendingSecretEncrypted: encryptTotpSecret(secret),
          pendingExpiresAt
        }
      }
    );

    const challenge = await this.createChallenge({
      userId: user._id.toString(),
      purpose: 'REPLACE',
      ip,
      userAgent
    });

    const accountName = user.email || user.name || user._id.toString();
    await this.logAudit({
      user,
      action: 'ADMIN_2FA_SETUP_STARTED',
      reason: 'Administrator started authenticator device replacement',
      details: { ip, userAgent: userAgent?.slice(0, 300), replacement: true }
    });

    return {
      mode: 'REPLACE',
      challengeToken: challenge.challengeToken,
      expiresAt: challenge.expiresAt.toISOString(),
      setup: {
        otpauthUrl: totpProvisioningUri(accountName, secret),
        manualKey: secret,
        issuer: env.ADMIN_2FA_ISSUER,
        accountName,
        expiresAt: pendingExpiresAt.toISOString()
      }
    };
  }

  async disable(user: IUser, password: string, code: string, ip?: string): Promise<void> {
    this.assertAdmin(user);
    const passwordOk = await comparePassword(password || '', user.passwordHash);
    if (!passwordOk) {
      throw ApiError.unauthorized('Current password is incorrect.');
    }
    await this.assertCurrentTotp(user._id.toString(), code);

    await AdminTwoFactorModel.updateOne(
      { userId: user._id },
      {
        $set: { enabled: false, failedAttempts: 0 },
        $unset: {
          secretEncrypted: '',
          pendingSecretEncrypted: '',
          pendingExpiresAt: '',
          lastUsedTimeStep: '',
          lockedUntil: ''
        }
      }
    );
    await AdminRecoveryCodeModel.deleteMany({ userId: user._id });
    await AdminTwoFactorChallengeModel.updateMany(
      { userId: user._id, usedAt: { $exists: false } },
      { $set: { usedAt: new Date() } }
    );

    await this.logAudit({
      user,
      action: 'ADMIN_2FA_DISABLED',
      reason: 'Administrator disabled 2FA after password and TOTP re-authentication',
      details: { ip }
    });
    await this.sendSecurityNotice({
      user,
      eventKey: `disabled-${Date.now()}`,
      title: 'Two-Step Verification Disabled',
      message: 'Two-step verification was disabled for your admin account. You must set it up again on your next login.'
    });
  }

  async resetByOwner(params: {
    actor: IUser;
    targetUserId: string;
    actorCode: string;
    reason: string;
    ip?: string;
  }): Promise<{ targetEmail?: string }> {
    this.assertAdmin(params.actor);
    if (params.actor._id.toString() === params.targetUserId) {
      throw ApiError.badRequest('Use your own 2FA settings to disable your authenticator.');
    }
    if (!params.reason || params.reason.trim().length < 5) {
      throw ApiError.badRequest('A clear recovery reason is required.');
    }

    await this.assertCurrentTotp(params.actor._id.toString(), params.actorCode);

    const target = await UserModel.findById(params.targetUserId);
    if (!target || target.role !== UserRole.SUPER_ADMIN) {
      throw ApiError.notFound('Target administator was not found.');
    }

    await AdminTwoFactorModel.deleteOne({ userId: target._id });
    await AdminRecoveryCodeModel.deleteMany({ userId: target._id });
    await AdminTwoFactorChallengeModel.updateMany(
      { userId: target._id, usedAt: { $exists: false } },
      { $set: { usedAt: new Date() } }
    );

    await this.logAudit({
      user: params.actor,
      targetUserId: target._id.toString(),
      targetUserEmail: target.email,
      action: 'ADMIN_2FA_RESET',
      reason: params.reason.trim(),
      details: {
        targetUserId: target._id.toString(),
        targetEmail: target.email,
        ip: params.ip,
        method: 'owner_recovery_api'
      }
    });

    if (target.email) {
      await this.sendSecurityNotice({
        user: target,
        eventKey: `owner-reset-${Date.now()}`,
        title: 'Admin 2FA Reset',
        message: `An authorized Main Admin reset the authenticator for your admin account. Reason: ${params.reason.trim()}. You must set up 2FA again on your next login.`
      });
    }

    return { targetEmail: target.email };
  }

  async hasEnabled2FA(userId: string): Promise<boolean> {
    const record = await AdminTwoFactorModel.findOne({
      userId: new mongoose.Types.ObjectId(userId)
    }).select('enabled').lean<any>();
    return Boolean(record?.enabled);
  }

  async markOwnerRecoveryAudit(params: {
    targetUser: IUser;
    reason: string;
    source: string;
  }): Promise<void> {
    await AuditLogModel.create({
      action: 'ADMIN_2FA_OWNER_RECOVERY',
      adminId: params.targetUser._id,
      adminEmail: 'server-owner@localhost',
      targetUserId: params.targetUser._id,
      targetUserEmail: params.targetUser.email,
      targetResourceId: params.targetUser._id.toString(),
      resourceType: 'AdminTwoFactor',
      reason: params.reason,
      details: { source: params.source }
    }).catch(() => null);
  }
}

export const adminTwoFactorService = new AdminTwoFactorService();
