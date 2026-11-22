import { authenticator } from 'otplib';
import { env } from '../config/env';

// RFC 6238 compatible: 6 digits, 30-second steps, ±1 step clock drift.
authenticator.options = {
  digits: 6,
  step: 30,
  window: 1
};

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function totpProvisioningUri(accountName: string, secret: string): string {
  return authenticator.keyuri(accountName, env.ADMIN_2FA_ISSUER, secret);
}

/**
 * Returns the accepted TOTP time step (for replay protection) or null when the
 * code is malformed or does not match within the allowed clock-drift window.
 */
export function verifyTotpAndGetStep(secret: string, code: string): number | null {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return null;

  const delta = authenticator.checkDelta(clean, secret);
  if (delta === null || !Number.isFinite(delta)) return null;

  return Math.floor(Date.now() / 30_000) + Number(delta);
}
