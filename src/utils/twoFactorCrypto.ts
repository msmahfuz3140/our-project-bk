import crypto from 'crypto';
import { env } from '../config/env';

const TOTP_SECRET_PREFIX = 'totp:v1:';
const RECOVERY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function encryptionKey(): Buffer {
  const secret = env.ADMIN_2FA_ENCRYPTION_KEY || env.JWT_SECRET;
  if (!secret) {
    throw new Error('ADMIN_2FA_ENCRYPTION_KEY is not configured');
  }
  return crypto.createHash('sha256').update(`admin-2fa:${secret}`).digest();
}

export function encryptTotpSecret(secret: string): string {
  const value = String(secret || '').trim();
  if (!value) return '';
  if (value.startsWith(TOTP_SECRET_PREFIX)) return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${TOTP_SECRET_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptTotpSecret(value?: string | null): string {
  const stored = String(value || '').trim();
  if (!stored) return '';
  if (!stored.startsWith(TOTP_SECRET_PREFIX)) {
    // Defensive compatibility only. New secrets are always encrypted.
    return stored;
  }

  try {
    const [ivPart, tagPart, payloadPart] = stored.slice(TOTP_SECRET_PREFIX.length).split('.');
    if (!ivPart || !tagPart || !payloadPart) return '';
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(ivPart, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payloadPart, 'base64url')),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

export function normalizeRecoveryCode(code: string): string {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return crypto
    .createHmac('sha256', `admin-2fa-recovery:${env.ADMIN_2FA_ENCRYPTION_KEY || env.JWT_SECRET}`)
    .update(normalizeRecoveryCode(code))
    .digest('hex');
}

/** Constant-time comparison for stored recovery-code hashes. */
export function safeHashEqual(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += RECOVERY_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export interface GeneratedRecoveryCodes {
  plainCodes: string[];
  hashedCodes: string[];
}

/**
 * Generates high-entropy, human-transcribable one-time recovery codes.
 * Only the HMAC hashes are persisted; plaintext is returned exactly once.
 */
export function generateRecoveryCodes(count = env.ADMIN_2FA_RECOVERY_CODE_COUNT): GeneratedRecoveryCodes {
  const safeCount = Math.max(5, Math.min(20, Math.trunc(count) || 10));
  const plainCodes: string[] = [];
  const hashedCodes: string[] = [];

  for (let index = 0; index < safeCount; index += 1) {
    const raw = base32Encode(crypto.randomBytes(10)).slice(0, 16);
    const formatted = raw.match(/.{1,4}/g)?.join('-') || raw;
    plainCodes.push(formatted);
    hashedCodes.push(hashRecoveryCode(formatted));
  }

  return { plainCodes, hashedCodes };
}
