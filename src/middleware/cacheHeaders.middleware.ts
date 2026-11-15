import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

const PUBLIC_CACHE_PATHS: Array<{ test: RegExp; maxAge: number; swr: number }> = [
  { test: /^\/api(?:\/v1)?\/subscriptions\/plans\/?$/, maxAge: 60, swr: 300 },
  { test: /^\/api(?:\/v1)?\/settings\/public\/?$/, maxAge: 60, swr: 300 },
  { test: /^\/api(?:\/v1)?\/tool\/status\/?$/, maxAge: 30, swr: 120 },
  { test: /^\/api(?:\/v1)?\/payments\/currencies\/?$/, maxAge: 300, swr: 600 }
];

function hasPrivateCredentials(req: Request): boolean {
  return Boolean(
    req.headers.authorization ||
    (req.headers.cookie && /(?:^|;\s*)(?:sloot_token|token|better-auth\.)/i.test(req.headers.cookie))
  );
}

/**
 * Explicit HTTP caching policy:
 * - Public catalogue/settings responses get short browser caching + ETag
 *   revalidation.
 * - Everything else under /api is private and must never be cached by shared
 *   proxies or the browser.
 */
export function apiCacheHeaders(req: Request, res: Response, next: NextFunction): void {
  const fullPath = req.originalUrl.split('?')[0];

  const publicPolicy = req.method === 'GET'
    ? PUBLIC_CACHE_PATHS.find((entry) => entry.test.test(fullPath))
    : undefined;

  if (!publicPolicy || hasPrivateCredentials(req)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return next();
  }

  res.setHeader('Cache-Control', `public, max-age=${publicPolicy.maxAge}, stale-while-revalidate=${publicPolicy.swr}`);
  res.setHeader('Vary', 'Accept-Encoding');

  const originalJson = res.json.bind(res);
  (res as any).json = (body: unknown) => {
    try {
      const serialized = JSON.stringify(body);
      const etag = `W/"${crypto.createHash('sha1').update(serialized).digest('base64url')}"`;
      res.setHeader('ETag', etag);

      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch === etag) {
        res.status(304).end();
        return res;
      }
    } catch {
      // If serialization fails, let Express handle the response normally.
    }
    return originalJson(body);
  };

  next();
}
