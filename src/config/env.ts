import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const booleanString = z
  .string()
  .default('false')
  .transform((value) => value === 'true' || value === '1' || value.toLowerCase() === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('5000').transform(Number),
  CORS_ORIGIN: z.string().default('http://localhost:3000,http://localhost:3001,https://accuracy.tools,https://www.accuracy.tools,https://rouletteaccuracy.com,https://www.rouletteaccuracy.com'),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/roulette-accuracy'),
  JWT_SECRET: z.string().default('replace_with_high_entropy_cryptographic_secret_min_32_characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  BETTER_AUTH_SECRET: z.string().default('replace_with_better_auth_high_entropy_secret_min_32_chars'),
  BETTER_AUTH_URL: z.string().default('http://localhost:5050'),
  PUBLIC_WEBSITE_URL: z.string().default('http://localhost:3000'),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  BACKEND_URL: z.string().default('http://localhost:5050'),

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
  EMAIL_PROVIDER_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default('Roulette Accuracy <security@rouletteaccuracy.com>'),
  SMS_PROVIDER_API_KEY: z.string().default(''),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  LOG_LEVEL: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO')
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
  data.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';

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
  PAYMENT_IPN_CALLBACK_URL: webhookCallbackUrl,
  PAYMENT_SUCCESS_URL: trimTrailingSlash(data.PAYMENT_SUCCESS_URL || `${publicFrontendUrl}/checkout/success`),
  PAYMENT_CANCEL_URL: trimTrailingSlash(data.PAYMENT_CANCEL_URL || `${publicFrontendUrl}/checkout/failed`),
  PAYMENT_PENDING_URL: trimTrailingSlash(data.PAYMENT_PENDING_URL || `${publicFrontendUrl}/checkout/pending`)
};

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
