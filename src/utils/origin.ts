import { env } from '../config/env';

const allowlist = new Set(
  env.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

export function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

/**
 * Explicit allowlist plus first-party product domains.
 * Unknown or malformed origins are rejected without throwing, so callers can
 * return a normal 403 instead of a 500.
 */
export function isOriginAllowed(origin: string): boolean {
  if (!origin) return true;
  const cleanOrigin = normalizeOrigin(origin);
  if (!cleanOrigin) return false;
  if (allowlist.has(cleanOrigin)) return true;

  let hostname = '';
  try {
    hostname = new URL(cleanOrigin).hostname.toLowerCase();
  } catch {
    return false;
  }

  return (
    hostname === 'accuracy.tools' ||
    hostname === 'www.accuracy.tools' ||
    hostname.endsWith('.accuracy.tools') ||
    hostname === 'rouletteaccuracy.com' ||
    hostname === 'www.rouletteaccuracy.com' ||
    hostname.endsWith('.rouletteaccuracy.com') ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1'
  );
}
