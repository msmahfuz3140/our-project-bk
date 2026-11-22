import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env';

export interface AccessTokenOptions {
  adminTwoFactorVerified?: boolean;
  twoFactorVerifiedAt?: Date;
}

/**
 * Issues a fresh full-access token. The token is only created after all
 * required authentication factors (including admin TOTP) have succeeded.
 * A unique jti ensures every successful 2FA login produces a new session ID.
 */
export function signAccessToken(userId: string, options: AccessTokenOptions = {}): string {
  const payload: Record<string, unknown> = {
    userId,
    scope: 'access',
    jti: crypto.randomBytes(16).toString('hex')
  };

  if (options.adminTwoFactorVerified) {
    payload.amr = ['pwd', 'totp'];
    payload.twoFactorVerifiedAt = (options.twoFactorVerifiedAt || new Date()).toISOString();
  }

  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn']
  });
}

export function signAdmin2FAChallenge(payload: {
  userId: string;
  challengeId: string;
  purpose: 'SETUP' | 'LOGIN' | 'REPLACE';
}): string {
  return jwt.sign(
    {
      userId: payload.userId,
      challengeId: payload.challengeId,
      purpose: payload.purpose,
      scope: 'admin_2fa_challenge'
    },
    env.JWT_SECRET,
    { expiresIn: `${Math.max(60, env.ADMIN_2FA_CHALLENGE_TTL_SECONDS)}s` }
  );
}
