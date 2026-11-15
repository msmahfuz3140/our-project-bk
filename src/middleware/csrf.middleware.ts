import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { ApiError } from '../utils/apiError';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

/**
 * Cookie-authenticated mutating requests must originate from an allowed
 * frontend origin. Bearer-token requests are inherently CSRF-resistant and are
 * allowed. Server-to-server webhooks carry no browser cookie and are allowed.
 *
 * This complements SameSite=Lax cookies without introducing a second auth
 * system or breaking the existing Better Auth session flow.
 */
export function csrfOriginGuard(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const authorization = req.headers.authorization;
  if (authorization && authorization.startsWith('Bearer ')) {
    return next();
  }

  const hasAuthCookie = Boolean(
    req.headers.cookie && /(?:^|;\s*)(?:sloot_token|token|better-auth\.)/i.test(req.headers.cookie)
  );

  if (!hasAuthCookie) {
    // Webhooks, provider callbacks, and unauthenticated login/register calls.
    return next();
  }

  const allowed = new Set(
    [
      'https://accuracy.tools',
      'https://www.accuracy.tools',
      ...env.CORS_ORIGIN.split(',')
    ]
      .map((origin) => normalizeOrigin(origin.trim()))
      .filter(Boolean)
  );

  const originHeader = req.get('origin');
  const refererHeader = req.get('referer');
  const requestOrigin = normalizeOrigin(originHeader || refererHeader || '');

  if (!requestOrigin || !allowed.has(requestOrigin)) {
    return next(
      ApiError.forbidden(
        'Cross-site request blocked. Please use the official application origin.',
        'CSRF_ORIGIN_REJECTED'
      )
    );
  }

  next();
}
