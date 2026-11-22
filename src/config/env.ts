import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const booleanString = z
  .string()
  .default('false')
  .transform((value) => value === 'true' || value === '1' || value.toLowerCase() === 'yes');

const isVercelDeployment = Boolean(process.env.VERCEL) || process.env.VERCEL_ENV === 'production';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default(isVercelDeployment ? 'production' : 'development'),
  PORT: z.string().default('5000').transform(Number),
  CORS_ORIGIN: z.string().default('http://localhost:3000,http://localhost:3001,https://accuracy.tools,https://www.accuracy.tools,https://our-project-fn.vercel.app,https://our-project-bk.vercel.app,https://rouletteaccuracy.com,https://www.rouletteaccuracy.com'),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/roulette-accuracy'),
  JWT_SECRET: z.string().default('replace_with_high_entropy_cryptographic_secret_min_32_characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  BETTER_AUTH_SECRET: z.string().default('replace_with_better_auth_high_entropy_secret_min_32_chars'),
  BETTER_AUTH_URL: z.string().default(isVercelDeployment ? 'https://our-project-bk.vercel.app' : 'http://localhost:5050'),
  PUBLIC_WEBSITE_URL: z.string().default(isVercelDeployment ? 'https://www.accuracy.tools' : 'http://localhost:3000'),
  FRONTEND_URL: z.string().default(isVercelDeployment ? 'https://www.accuracy.tools' : 'http://localhost:3000'),
  BACKEND_URL: z.string().default(isVercelDeployment ? 'https://our-project-bk.vercel.app' : 'http://localhost:5050'),

  // NOWPayments — all secrets stay server-side only.
  NOWPAYMENTS_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  NOWPAYMENTS_API_KEY: z.string().default(''),
  NOWPAYMENTS_IPN_SECRET: z.string().default(''),
  NOWPAYMENTS_API_URL: z.string().default('https://api.nowpayments.io/v1'),
  NOWPAYMENTS_IPN_CALLBACK_URL: z.string().default(''),
  NOWPAYMENTS_LIVE_ENABLED: booleanString,
  NOWPAYMENTS_REQUIRE_API_VERIFICATION: z
    .string()
    .default('true')
    .transform((value) => value !== 'false' && value !== '0'),
  NOWPAYMENTS_API_TIMEOUT_MS: z.string().default('15000').transform(Number),
  // Optional shared secret for a serverless cron/uptime job that reconciles
  // pending NOWPayments orders when the provider webhook is delayed or absent.
  CRON_SECRET: z.string().default(''),

  // Optional Redis-compatible REST cache (Upstash / Vercel KV).
  // When absent, the application uses a process-local memory cache.
  UPSTASH_REDIS_REST_URL: z.string().default(''),
  UPSTASH_REDIS_REST_TOKEN: z.string().default(''),
  KV_REST_API_URL: z.string().default(''),
  KV_REST_API_TOKEN: z.string().default(''),
  CACHE_REDIS_TIMEOUT_MS: z.string().default('800').transform(Number),

  // Explicit redirect URLs (optional; safe defaults are derived below).
  PAYMENT_SUCCESS_URL: z.string().default(''),
  PAYMENT_CANCEL_URL: z.string().default(''),
  PAYMENT_PENDING_URL: z.string().default(''),
  PAYMENT_IPN_CALLBACK_URL: z.string().default(''),

  MAIN_ADMIN_EMAILS: z.string().default('mdmahfuzulhaque3140@gmail.com'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().default('587').transform(Number),
  SMTP_SECURE: z.string().default('false').transform(v => v === 'true' || v === '1'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM_EMAIL: z.string().optional(),
  SMTP_FROM_NAME: z.string().default('Roulette Accuracy'),
  EMAIL_PROVIDER_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default('Roulette Accuracy <security@rouletteaccuracy.com>'),
  // Registration / verification email behaviour. All values are safe defaults
  // and can be overridden per deployment without code changes.
  OTP_EXPIRY_MINUTES: z.string().default('10').transform(Number),
  OTP_RESEND_COOLDOWN_SECONDS: z.string().default('60').transform(Number),
  OTP_MAX_ATTEMPTS: z.string().default('5').transform(Number),
  OTP_MAX_RESENDS_PER_HOUR: z.string().default('5').transform(Number),
  // Admin Panel TOTP 2FA. The encryption key must be unique per deployment.
  ADMIN_2FA_ENCRYPTION_KEY: z.string().default(''),
  ADMIN_2FA_ISSUER: z.string().default('Roulette Accuracy Admin'),
  ADMIN_2FA_CHALLENGE_TTL_SECONDS: z.string().default('600').transform(Number),
  ADMIN_2FA_MAX_ATTEMPTS: z.string().default('5').transform(Number),
  ADMIN_2FA_LOCK_MINUTES: z.string().default('15').transform(Number),
  ADMIN_2FA_RECOVERY_CODE_COUNT: z.string().default('10').transform(Number),
  SMS_PROVIDER_API_KEY: z.string().default(''),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  LOG_LEVEL: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO'),

  // Cloudflare Turnstile Server-side Secret Key (never exposed to client)
  TURNSTILE_SECRET_KEY: z.string().default('')
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

const data = parsed.data;

/**
 * Production is true for an explicit NODE_ENV=production OR a production
 * Vercel deployment. This prevents development-only payment simulation from
 * ever running on the live domain if NODE_ENV was misconfigured.
 */
export const isProductionRuntime =
  data.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production' || Boolean(process.env.VERCEL);

function trimTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function selectPublicFrontendUrl(): string {
  const candidates = [
    data.PUBLIC_WEBSITE_URL,
    data.FRONTEND_URL,
    ...data.CORS_ORIGIN.split(',')
  ]
    .map((value) => (value || '').trim())
    .filter((value) => value.length > 0);

  const nonLocal = candidates.find((value) => !/localhost|127\.0\.0\.1/i.test(value));
  return trimTrailingSlash(nonLocal || candidates[0] || 'http://localhost:3000');
}

const publicFrontendUrl = selectPublicFrontendUrl();
const backendUrl = trimTrailingSlash(data.BACKEND_URL || 'http://localhost:5050');

/**
 * Official NOWPayments API hosts.
 * Docs: https://nowpayments.io/doc
 * - Production: https://api.nowpayments.io/v1
 * - Sandbox:    https://api-sandbox.nowpayments.io/v1
 *
 * We never invent a sandbox URL. In sandbox mode the official sandbox host is
 * authoritative, even if a production URL was left in the environment file.
 */
const officialApiUrl =
  data.NOWPAYMENTS_ENV === 'sandbox'
    ? 'https://api-sandbox.nowpayments.io/v1'
    : 'https://api.nowpayments.io/v1';

const configuredApiUrl = trimTrailingSlash(data.NOWPAYMENTS_API_URL || '');
const effectiveApiUrl = data.NOWPAYMENTS_ENV === 'sandbox'
  ? officialApiUrl
  : (configuredApiUrl || officialApiUrl);

const webhookCallbackUrl = trimTrailingSlash(
  data.PAYMENT_IPN_CALLBACK_URL ||
  data.NOWPAYMENTS_IPN_CALLBACK_URL ||
  `${backendUrl}/api/nowpayments/webhook`
);

export const env = {
  ...data,
  MAIN_ADMINS: data.MAIN_ADMIN_EMAILS.split(',').map(e => e.trim().toLowerCase()),
  PUBLIC_FRONTEND_URL: publicFrontendUrl,
  BACKEND_URL: backendUrl,
  NOWPAYMENTS_API_URL: effectiveApiUrl,
  NOWPAYMENTS_CONFIGURED_API_URL: configuredApiUrl,
  NOWPAYMENTS_API_BASE_URL: effectiveApiUrl,
  // Single authoritative sender header for every transactional email.
  EMAIL_SENDER: (() => {
    const fromEmail = (data.SMTP_FROM_EMAIL || '').trim();
    const fromName = (data.SMTP_FROM_NAME || 'Roulette Accuracy').trim();
    if (fromEmail) return `${fromName} <${fromEmail}>`;
    return data.EMAIL_FROM;
  })(),
  PAYMENT_IPN_CALLBACK_URL: webhookCallbackUrl,
  PAYMENT_SUCCESS_URL: trimTrailingSlash(data.PAYMENT_SUCCESS_URL || `${publicFrontendUrl}/checkout/success`),
  PAYMENT_CANCEL_URL: trimTrailingSlash(data.PAYMENT_CANCEL_URL || `${publicFrontendUrl}/checkout/failed`),
  PAYMENT_PENDING_URL: trimTrailingSlash(data.PAYMENT_PENDING_URL || `${publicFrontendUrl}/checkout/pending`)
};

/**
 * True when at least one email transport is configured. Never exposes any
 * credential; used by diagnostics and the transactional email service.
 */
export function isEmailTransportConfigured(): boolean {
  const hasSmtp = Boolean(
    (env.SMTP_HOST || '').trim() &&
    (env.SMTP_USER || '').trim() &&
    (env.SMTP_PASS || '').trim() &&
    !/^(user|pass|your[_-]?)/i.test((env.SMTP_USER || '').trim()) &&
    !/^(pass|your[_-]?)/i.test((env.SMTP_PASS || '').trim())
  );
  const hasProvider = Boolean((env.EMAIL_PROVIDER_API_KEY || '').trim());
  return hasSmtp || hasProvider;
}


export interface PaymentConfigIssue {
  variable: string;
  severity: 'ERROR' | 'WARNING';
  message: string;
}

/**
 * Validates payment configuration without ever printing secret values.
 * Called at startup and exposed (sanitised) by the admin health endpoint.
 */
export function validatePaymentEnvironment(): PaymentConfigIssue[] {
  const issues: PaymentConfigIssue[] = [];
  const isProduction = isProductionRuntime;

  if (!env.NOWPAYMENTS_API_KEY.trim()) {
    issues.push({
      variable: 'NOWPAYMENTS_API_KEY',
      severity: isProduction ? 'ERROR' : 'WARNING',
      message: 'NOWPayments API key is not configured. Checkout creation is disabled.'
    });
  }

  if (!env.NOWPAYMENTS_IPN_SECRET.trim()) {
    issues.push({
      variable: 'NOWPAYMENTS_IPN_SECRET',
      severity: 'ERROR',
      message: 'NOWPayments IPN secret is not configured. All webhook calls will be rejected.'
    });
  } else if (env.NOWPAYMENTS_IPN_SECRET.trim().length < 16) {
    issues.push({
      variable: 'NOWPAYMENTS_IPN_SECRET',
      severity: 'WARNING',
      message: 'The IPN secret looks unusually short. Verify it matches the NOWPayments dashboard.'
    });
  }

  if (!env.PAYMENT_IPN_CALLBACK_URL.startsWith('https://') && isProduction) {
    issues.push({
      variable: 'PAYMENT_IPN_CALLBACK_URL',
      severity: 'ERROR',
      message: 'The production IPN callback URL must be publicly reachable over HTTPS.'
    });
  }

  if (/localhost|127\.0\.0\.1/i.test(env.PAYMENT_IPN_CALLBACK_URL) && isProduction) {
    issues.push({
      variable: 'PAYMENT_IPN_CALLBACK_URL',
      severity: 'ERROR',
      message: 'The production IPN callback URL points at localhost and cannot be reached by NOWPayments.'
    });
  }

  if (data.NOWPAYMENTS_ENV === 'production' && !env.NOWPAYMENTS_LIVE_ENABLED) {
    issues.push({
      variable: 'NOWPAYMENTS_LIVE_ENABLED',
      severity: 'WARNING',
      message: 'Live payments are disabled. Set NOWPAYMENTS_LIVE_ENABLED=true only after provider eligibility and legal authorization are confirmed.'
    });
  }

  if (
    data.NOWPAYMENTS_ENV === 'sandbox' &&
    configuredApiUrl &&
    configuredApiUrl.includes('api.nowpayments.io')
  ) {
    issues.push({
      variable: 'NOWPAYMENTS_API_URL',
      severity: 'WARNING',
      message: 'NOWPAYMENTS_ENV=sandbox overrides the configured production API host with the official sandbox host.'
    });
  }

  return issues;
}

export function isLivePaymentsEnabled(): boolean {
  if (env.NOWPAYMENTS_ENV === 'sandbox') return true;
  return Boolean(env.NOWPAYMENTS_LIVE_ENABLED);
}

/**
 * Core production configuration checks. These never return secret values.
 * Called at startup and exposed sanitised by /health.
 */
export function validateCoreEnvironment(): PaymentConfigIssue[] {
  const issues: PaymentConfigIssue[] = [];

  if (isProductionRuntime) {
    if (!/^mongodb(\+srv)?:\/\//i.test(env.MONGODB_URI) || /localhost|127\.0\.0\.1/i.test(env.MONGODB_URI)) {
      issues.push({
        variable: 'MONGODB_URI',
        severity: 'ERROR',
        message: 'A production MongoDB Atlas connection URI is required. The current value is missing or points to localhost.'
      });
    }

    if (
      env.JWT_SECRET.length < 32 ||
      /^replace_with|change_this|default/i.test(env.JWT_SECRET)
    ) {
      issues.push({
        variable: 'JWT_SECRET',
        severity: 'ERROR',
        message: 'JWT_SECRET must be a strong non-placeholder secret of at least 32 characters.'
      });
    }

    if (
      env.BETTER_AUTH_SECRET.length < 32 ||
      /^replace_with|change_this|default/i.test(env.BETTER_AUTH_SECRET)
    ) {
      issues.push({
        variable: 'BETTER_AUTH_SECRET',
        severity: 'ERROR',
        message: 'BETTER_AUTH_SECRET must be a strong non-placeholder secret of at least 32 characters.'
      });
    }

    if (!env.CORS_ORIGIN.includes('accuracy.tools')) {
      issues.push({
        variable: 'CORS_ORIGIN',
        severity: 'WARNING',
        message: 'CORS_ORIGIN does not include the live accuracy.tools frontend origins.'
      });
    }

    if (/localhost|127\.0\.0\.1/i.test(env.BACKEND_URL)) {
      issues.push({
        variable: 'BACKEND_URL',
        severity: 'ERROR',
        message: 'BACKEND_URL must be the public HTTPS backend origin in production.'
      });
    }

    if (data.NODE_ENV !== 'production') {
      issues.push({
        variable: 'NODE_ENV',
        severity: 'WARNING',
        message: 'NODE_ENV is not "production" on a production deployment.'
      });
    }

    if (!isEmailTransportConfigured()) {
      issues.push({
        variable: 'SMTP_HOST / SMTP_USER / SMTP_PASS',
        severity: 'ERROR',
        message: 'No transactional email transport is configured. Registration verification and payment/withdrawal emails cannot be delivered.'
      });
    }

    if (
      !env.ADMIN_2FA_ENCRYPTION_KEY ||
      env.ADMIN_2FA_ENCRYPTION_KEY.length < 32 ||
      /^replace_with|change_this|default|your[_-]?/i.test(env.ADMIN_2FA_ENCRYPTION_KEY)
    ) {
      issues.push({
        variable: 'ADMIN_2FA_ENCRYPTION_KEY',
        severity: 'ERROR',
        message: 'A dedicated ADMIN_2FA_ENCRYPTION_KEY of at least 32 characters is required to encrypt administrator authenticator secrets at rest.'
      });
    }
  }

  return issues;
}
