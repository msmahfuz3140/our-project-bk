import { Request, Response, NextFunction } from 'express';
import { turnstileService } from '../services/turnstile.service';
import { ApiError } from '../utils/apiError';

/**
 * Express middleware to enforce Cloudflare Turnstile CAPTCHA verification.
 *
 * Checks:
 * - req.body.turnstileToken
 * - req.body['cf-turnstile-response']
 * - req.headers['x-turnstile-token']
 *
 * @param action Optional expected action (e.g. 'login', 'register', 'forgot_password', 'contact')
 */
export function requireTurnstile(action?: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      // 1. Extract token from request body or headers
      const bodyToken =
        typeof req.body?.turnstileToken === 'string'
          ? req.body.turnstileToken
          : typeof req.body?.['cf-turnstile-response'] === 'string'
            ? req.body['cf-turnstile-response']
            : undefined;

      const headerToken =
        typeof req.headers['x-turnstile-token'] === 'string'
          ? req.headers['x-turnstile-token']
          : undefined;

      const token = (bodyToken || headerToken || '').trim();

      // 2. Reject missing token
      if (!token) {
        throw new ApiError(
          400,
          'Security verification required. Please complete the CAPTCHA before submitting.',
          'CAPTCHA_REQUIRED'
        );
      }

      // 3. Resolve client IP for siteverify telemetry
      const forwarded = req.headers['x-forwarded-for'];
      const clientIp = typeof forwarded === 'string'
        ? forwarded.split(',')[0].trim()
        : req.ip || undefined;

      // 4. Verify with Cloudflare Siteverify API
      const result = await turnstileService.verifyToken(token, clientIp, action);

      if (!result.success) {
        const errorCodes = result.errorCodes || [];
        const isExpired = errorCodes.includes('timeout-or-duplicate');

        if (isExpired) {
          throw new ApiError(
            400,
            'Security verification has expired. Please verify the CAPTCHA again.',
            'CAPTCHA_EXPIRED'
          );
        }

        throw new ApiError(
          400,
          'Security verification failed. Please complete the CAPTCHA again.',
          'CAPTCHA_FAILED'
        );
      }

      (req as any).turnstile = result;
      next();
    } catch (error) {
      next(error);
    }
  };
}
