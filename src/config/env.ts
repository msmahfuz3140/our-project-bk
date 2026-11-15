import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('5000').transform(Number),
  CORS_ORIGIN: z.string().default('http://localhost:3000,http://localhost:3001,https://rouletteaccuracy.com,https://www.rouletteaccuracy.com'),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/roulette-accuracy'),
  JWT_SECRET: z.string().default('replace_with_high_entropy_cryptographic_secret_min_32_characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  BETTER_AUTH_SECRET: z.string().default('replace_with_better_auth_high_entropy_secret_min_32_chars'),
  BETTER_AUTH_URL: z.string().default('http://localhost:5050'),
  PUBLIC_WEBSITE_URL: z.string().default('http://localhost:3000'),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  BACKEND_URL: z.string().default('http://localhost:5050'),
  NOWPAYMENTS_API_KEY: z.string().default(''),
  NOWPAYMENTS_IPN_SECRET: z.string().default(''),
  NOWPAYMENTS_API_URL: z.string().default('https://api.nowpayments.io/v1'),
  NOWPAYMENTS_IPN_CALLBACK_URL: z.string().default('http://localhost:5050/api/v1/payments/ipn'),
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

export const env = {
  ...parsed.data,
  MAIN_ADMINS: parsed.data.MAIN_ADMIN_EMAILS.split(',').map(e => e.trim().toLowerCase()),
  PUBLIC_FRONTEND_URL: parsed.data.PUBLIC_WEBSITE_URL || parsed.data.FRONTEND_URL || parsed.data.CORS_ORIGIN.split(',')[0].trim()
};


