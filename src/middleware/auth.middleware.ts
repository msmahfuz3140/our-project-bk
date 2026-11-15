import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { ApiError } from '../utils/apiError';
import { UserRole } from '../shared/roles';
import { userRepository } from '../repositories/user.repository';
import { subscriptionRepository } from '../repositories/subscription.repository';
import { AuthUser } from '../shared/auth';

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
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
  } else if (req.query && typeof req.query.token === 'string' && req.query.token.trim() !== '') {
    token = req.query.token.trim();
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
    const decoded = jwt.verify(token, env.JWT_SECRET) as { userId: string; iat?: number };
    const user = await userRepository.findById(decoded.userId);

    if (!user) {
      next(ApiError.unauthorized('User not found'));
      return;
    }

    if (user.sessionsRevokedAt && decoded.iat && (decoded.iat * 1000) < user.sessionsRevokedAt.getTime()) {
      next(ApiError.unauthorized('Session has been revoked by administration. Please log in again.'));
      return;
    }

    const activeSub = await subscriptionRepository.findActiveByUserId(user._id);

    req.user = {
      id: user._id.toString(),
      name: user.name || 'Member',
      email: user.email,
      phone: user.phone,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
      isPhoneVerified: user.isPhoneVerified,
      isActive: user.isActive,
      referralCode: user.referralCode,
      hasActiveSubscription: !!activeSub || user.role === UserRole.SUPER_ADMIN || user.role === UserRole.MODERATOR,
      subscriptionPlanId: activeSub?.planId,
      subscriptionExpiresAt: activeSub?.endDate?.toISOString(),
      createdAt: user.createdAt.toISOString()
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

export function requirePremiumSubscription(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    next(ApiError.unauthorized());
    return;
  }

  // Main Admins and Moderators have full access by role
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
