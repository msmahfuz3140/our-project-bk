import { Request, Response } from 'express';
import { env, isProductionRuntime } from '../config/env';

export const AUTH_COOKIE_NAME = 'sloot_token';
export const AUTH_HINT_COOKIE_NAME = 'sloot_auth';

type SameSiteValue = 'strict' | 'none';

function tokenMaxAgeMs(): number {
  const raw = String(env.JWT_EXPIRES_IN || '7d').trim();
  const match = raw.match(/^(\d+)\s*([smhd])$/i);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * multiplier;
}

/**
 * SameSite is selected from the browser's own request metadata:
 * - same-origin / same-site requests (including the Next.js `/api/v1` proxy)
 *   receive `Strict`, which is the strongest practical setting for an SPA.
 * - genuine cross-site API calls receive `None` so the session still works,
 *   with the server-side CSRF origin guard as the additional control.
 */
function resolveSameSite(req: Request): SameSiteValue {
  if (!isProductionRuntime) return 'strict';
  return req.get('sec-fetch-site') === 'cross-site' ? 'none' : 'strict';
}

export function setAuthCookies(req: Request, res: Response, token: string): void {
  const maxAge = tokenMaxAgeMs();
  const secure = isProductionRuntime || req.secure;
  const sameSite = resolveSameSite(req);

  // The JWT itself is never readable by client-side JavaScript.
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
    maxAge
  });

  // A non-secret presence hint lets the SPA distinguish authenticated from
  // anonymous cache partitions without exposing the credential.
  res.cookie(AUTH_HINT_COOKIE_NAME, '1', {
    httpOnly: false,
    secure,
    sameSite,
    path: '/',
    maxAge
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
  res.clearCookie('token', { path: '/' });
  res.clearCookie(AUTH_HINT_COOKIE_NAME, { path: '/' });
}
