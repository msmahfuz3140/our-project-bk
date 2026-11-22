import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { ApiError } from '../utils/apiError';
import { UserRole } from '../shared/roles';
import { UserModel, AccountStatus } from '../models/User';
import { AdminTwoFactorModel } from '../models/AdminTwoFactor';
import { SubscriptionModel } from '../models/Subscription';
import { AuthUser } from '../shared/auth';
import { cacheKeys, memoryCache } from '../utils/cache';

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

interface AuthContext {
  user: any | null;
  activeSub: any | null;
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)(?:sloot_token|token)=([^;]+)/);
    if (match) {
      token = decodeURIComponent(match[1]);
    }
  }

  if (!token) {
    next(ApiError.unauthorized('Authentication token is required'));
    return;
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as {
      userId: string;
      iat?: number;
      scope?: string;
      amr?: string[];
    };

    // Pre-authentication 2FA challenges are not full sessions and must never
    // be accepted as an authenticated admin credential.
    if (decoded.scope === 'admin_2fa_challenge') {
      next(
        ApiError.unauthorized(
          'Administrator two-step verification is not complete.',
          'ADMIN_2FA_REQUIRED'
        )
      );
      return;
    }

    // A 5-second local cache removes repeated user + subscription lookups when
    // one dashboard makes several API calls. This cache is memory-only and is
    // explicitly invalidated on role, status, profile and subscription changes.
    const context = await memoryCache.getOrSetLocal<AuthContext>(
      cacheKeys.authContext(decoded.userId),
      5,
      async () => {
        const [user, activeSub] = await Promise.all([
          UserModel.findById(decoded.userId)
            .select('name email phone role isEmailVerified isPhoneVerified isActive accountStatus suspendedUntil isDeleted sessionsRevokedAt referralCode createdAt mustChangePassword passwordChangedAt')
            .lean(),
          SubscriptionModel.findOne({
            userId: decoded.userId,
            status: 'ACTIVE',
            isRevoked: { $ne: true },
            endDate: { $gt: new Date() }
          })
            .sort({ endDate: -1 })
            .select('planId endDate status')
            .lean()
        ]);
        return { user, activeSub };
      }
    );

    const user = context.user;
    if (!user) {
      next(ApiError.unauthorized('User not found'));
      return;
    }

    if (user.isDeleted || user.accountStatus === AccountStatus.BLOCKED) {
      next(ApiError.forbidden(user.statusReason || 'This account is blocked or deleted.'));
      return;
    }

    if (
      user.accountStatus === AccountStatus.SUSPENDED &&
      (!user.suspendedUntil || new Date(user.suspendedUntil) > new Date())
    ) {
      next(ApiError.forbidden(user.statusReason || 'This account is temporarily suspended.'));
      return;
    }

    if (user.email && !user.isEmailVerified) {
      next(
        new ApiError(
          403,
          'Please verify your email address before accessing your account.',
          'EMAIL_NOT_VERIFIED',
          { target: user.email, purpose: 'REGISTRATION' }
        )
      );
      return;
    }

    if (!user.isActive) {
      next(ApiError.forbidden('This account is not active. Please verify your email or contact support.'));
      return;
    }

    if (user.sessionsRevokedAt && decoded.iat) {
      // JWT `iat` has one-second precision. Allow a short grace window so a
      // token issued immediately after an administrative reset (same second)
      // is not incorrectly treated as an older, revoked session.
      const issuedAtMs = decoded.iat * 1000;
      const revokedAtMs = new Date(user.sessionsRevokedAt).getTime();
      if (issuedAtMs + 5000 < revokedAtMs) {
        next(ApiError.unauthorized('Session has been revoked by administration. Please log in again.'));
        return;
      }
    }

    const activeSub = context.activeSub;

    let adminTwoFactorEnabled = false;
    let adminTwoFactorVerified = false;
    if (user.role === UserRole.SUPER_ADMIN) {
      const twoFactor = await AdminTwoFactorModel.findOne({ userId: user._id })
        .select('enabled')
        .lean();
      adminTwoFactorEnabled = Boolean((twoFactor as any)?.enabled);
      adminTwoFactorVerified =
        adminTwoFactorEnabled && Array.isArray(decoded.amr) && decoded.amr.includes('totp');
    }

    req.user = {
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
      hasActiveSubscription: !!activeSub || user.role === UserRole.SUPER_ADMIN || user.role === UserRole.MODERATOR,
      subscriptionPlanId: activeSub?.planId,
      subscriptionExpiresAt: activeSub?.endDate ? new Date(activeSub.endDate).toISOString() : undefined,
      adminTwoFactorEnabled,
      adminTwoFactorVerified,
      createdAt: new Date(user.createdAt).toISOString()
    };

    next();
  } catch {
    next(ApiError.unauthorized('Invalid or expired authentication token'));
  }
}

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(ApiError.unauthorized());
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      next(ApiError.forbidden('You do not have permission to access this resource'));
      return;
    }

    next();
  };
}

/**
 * Server-side enforcement for every Admin Panel request. A valid password
 * session is not enough: the admin must have enabled TOTP and the current
 * token must prove the TOTP factor was completed.
 */
export function requireAdmin2FA(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    next(ApiError.unauthorized());
    return;
  }

  if (req.user.role !== UserRole.SUPER_ADMIN) {
    next();
    return;
  }

  if (!req.user.adminTwoFactorEnabled) {
    next(
      new ApiError(
        403,
        'Authenticator-app two-step verification must be set up before accessing the Admin Panel.',
        'ADMIN_2FA_SETUP_REQUIRED'
      )
    );
    return;
  }

  if (!req.user.adminTwoFactorVerified) {
    next(
      new ApiError(
        403,
        'Two-step verification is required for Admin Panel access.',
        'ADMIN_2FA_REQUIRED'
      )
    );
    return;
  }

  next();
}

export function requirePremiumSubscription(  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    next(ApiError.unauthorized());
    return;
  }

  if (req.user.role === UserRole.SUPER_ADMIN || req.user.role === UserRole.MODERATOR) {
    next();
    return;
  }

  if (!req.user.hasActiveSubscription) {
    next(ApiError.forbidden('Active premium subscription required to access the prediction engine', 'SUBSCRIPTION_REQUIRED'));
    return;
  }

  next();
}
