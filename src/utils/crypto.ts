import 'dotenv/config';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateOtpCode(length = 6): string {
  const digits = '0123456789';
  let otp = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    otp += digits[bytes[i] % 10];
  }
  return otp;
}

export function generateRandomString(length = 32): string {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

export function generateSecretActivationCode(): string {
  const hex1 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const hex2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `VIP-${hex1}-${hex2}`;
}

/* --------------------------------------------------------------------------
 * Secret-at-rest helpers
 * --------------------------------------------------------------------------
 * Provider API keys (for example the Dealer Signature sk_live_... key) are
 * never sent to the browser in plaintext. They are encrypted with AES-256-GCM
 * before being persisted, and only the backend proxy decrypts them in memory.
 * ------------------------------------------------------------------------ */

const SECRET_PREFIX = 'enc:v1:';

function secretEncryptionKey(): Buffer {
  const secret =
    process.env.DS_CONFIG_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    '';
  if (!secret) {
    throw new Error('No server-side encryption secret is configured for provider credentials');
  }
  // A fixed-length AES key derived from the server secret.
  return crypto.createHash('sha256').update(`ds-config:${secret}`).digest();
}

export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX);
}

export function encryptSecret(plainText: string): string {
  const value = (plainText || '').trim();
  if (!value) return '';
  if (isEncryptedSecret(value)) return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${SECRET_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(value: string | null | undefined): string {
  const stored = (value || '').trim();
  if (!stored) return '';
  if (!isEncryptedSecret(stored)) {
    // Backwards compatibility for credentials saved before encryption-at-rest
    // was introduced. They are transparently re-encrypted on the next save.
    return stored;
  }

  try {
    const [ivPart, tagPart, payloadPart] = stored.slice(SECRET_PREFIX.length).split('.');
    if (!ivPart || !tagPart || !payloadPart) return '';
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      secretEncryptionKey(),
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

export function maskSecret(value: string | null | undefined): string {
  const secret = (value || '').trim();
  if (!secret) return '';
  if (secret.length <= 8) return '••••••••';
  return `${secret.slice(0, 7)}••••••••${secret.slice(-4)}`;
}

