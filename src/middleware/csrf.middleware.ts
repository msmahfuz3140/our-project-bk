import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/apiError';
import { isOriginAllowed, normalizeOrigin } from '../utils/origin';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cookie-authenticated mutating requests must originate from an allowed
 * frontend origin. Bearer-token requests are inherently CSRF-resistant and are
 * allowed. Server-to-server webhooks carry no browser cookie and are allowed.
 *
 * This complements SameSite session cookies without introducing a second auth
 * system or breaking the existing authentication flow.
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

  const originHeader = req.get('origin');
  const refererHeader = req.get('referer');
  const requestOrigin = normalizeOrigin(originHeader || refererHeader || '');

  if (!requestOrigin || !isOriginAllowed(requestOrigin)) {
    return next(
      ApiError.forbidden(
        'Cross-site request blocked. Please use the official application origin.',
        'CSRF_ORIGIN_REJECTED'
      )
    );
  }

  next();
}
