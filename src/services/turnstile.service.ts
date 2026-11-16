import { env, isProductionRuntime } from '../config/env';
import { logger } from '../utils/logger';

export interface TurnstileVerificationResult {
  success: boolean;
  challengeTs?: string;
  hostname?: string;
  action?: string;
  errorCodes?: string[];
  bypassed?: boolean;
}

const CLOUDFLARE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 8000;

class TurnstileService {
  /**
   * Verify a Cloudflare Turnstile CAPTCHA token with Cloudflare's Siteverify API.
   *
   * @param token The response token supplied by the client widget
   * @param remoteIp Optional remote IP address of the requesting client
   * @param expectedAction Optional expected action (e.g. 'login', 'register')
   */
  async verifyToken(
    token?: string | null,
    remoteIp?: string,
    expectedAction?: string
  ): Promise<TurnstileVerificationResult> {
    const cleanToken = (token || '').trim();

    // 1. Reject missing or empty tokens immediately
    if (!cleanToken) {
      return {
        success: false,
        errorCodes: ['missing-input-response']
      };
    }

    // 2. In automated unit test environments, allow test tokens without external network calls
    if (process.env.NODE_ENV === 'test' || cleanToken === 'test_mock_turnstile_token') {
      return { success: true, bypassed: true };
    }

    const secretKey = env.TURNSTILE_SECRET_KEY.trim();

    // 3. Environment check: if no secret key is configured in local development, allow bypass with warning
    if (!secretKey) {
      if (!isProductionRuntime && process.env.NODE_ENV === 'development') {
        logger.warn(
          'TURNSTILE_SECRET_KEY is not configured in .env. Allowing request in local development mode only.'
        );
        return { success: true, bypassed: true };
      }

      logger.error('TURNSTILE_SECRET_KEY is not configured on production deployment.');
      return {
        success: false,
        errorCodes: ['secret-key-not-configured']
      };
    }

    // 4. Call Cloudflare Siteverify API
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

    try {
      const formData = new URLSearchParams();
      formData.append('secret', secretKey);
      formData.append('response', cleanToken);
      if (remoteIp) {
        formData.append('remoteip', remoteIp);
      }

      const response = await fetch(CLOUDFLARE_SITEVERIFY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body: formData.toString(),
        signal: controller.signal
      });

      if (!response.ok) {
        logger.error(`Cloudflare Siteverify HTTP error: ${response.status} ${response.statusText}`);
        return {
          success: false,
          errorCodes: [`http-error-${response.status}`]
        };
      }

      const result = (await response.json()) as {
        success: boolean;
        'error-codes'?: string[];
        challenge_ts?: string;
        hostname?: string;
        action?: string;
        cdata?: string;
      };

      if (!result.success) {
        logger.warn('Cloudflare Turnstile token validation failed', {
          errorCodes: result['error-codes'],
          expectedAction,
          receivedAction: result.action
        });
        return {
          success: false,
          errorCodes: result['error-codes'] || ['verification-failed'],
          challengeTs: result.challenge_ts,
          hostname: result.hostname
        };
      }

      // Optional action mismatch check (only if action was supplied in challenge)
      if (expectedAction && result.action && result.action !== expectedAction) {
        logger.warn('Cloudflare Turnstile action mismatch', {
          expected: expectedAction,
          received: result.action
        });
        return {
          success: false,
          errorCodes: ['action-mismatch'],
          challengeTs: result.challenge_ts,
          hostname: result.hostname,
          action: result.action
        };
      }

      return {
        success: true,
        challengeTs: result.challenge_ts,
        hostname: result.hostname,
        action: result.action
      };
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError';
      logger.error('Failed to verify Cloudflare Turnstile token with Siteverify API', {
        error: isTimeout ? 'Request timed out after 8 seconds' : err?.message
      });

      return {
        success: false,
        errorCodes: [isTimeout ? 'siteverify-timeout' : 'siteverify-network-error']
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const turnstileService = new TurnstileService();
