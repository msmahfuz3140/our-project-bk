import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { phoneNumber, emailOTP, bearer } from 'better-auth/plugins';
import mongoose from 'mongoose';
import { emailService } from '../services/email.service';
import { smsService } from '../services/sms.service';
import { env } from '../config/env';
import { isProductionRuntime } from '../config/env';

/**
 * Better Auth Server Configuration
 * Configured with MongoDB adapter, email OTP, phone OTP, and bearer plugins
 */
export function getBetterAuth(): any {
  const dbInstance = mongoose.connection.getClient().db();

  const secret = env.BETTER_AUTH_SECRET || env.JWT_SECRET;
  const baseURL = env.BETTER_AUTH_URL || env.BACKEND_URL || `http://localhost:${env.PORT}`;
  const trustedOrigins = Array.from(new Set([
    'https://accuracy.tools',
    'https://www.accuracy.tools',
    'https://rouletteaccuracy.com',
    'https://www.rouletteaccuracy.com',
    'http://localhost:3000',
    'http://localhost:3001',
    ...env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
  ]));

  return betterAuth({
    database: mongodbAdapter(dbInstance),
    secret,
    baseURL,
    trustedOrigins,
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24
    },
    advanced: {
      useSecureCookies: isProductionRuntime,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProductionRuntime
      }
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false
    },
    plugins: [
      bearer(),
      emailOTP({
        expiresIn: 600, // 10 minutes
        sendVerificationOTP: async ({ email, otp }) => {
          await emailService.sendVerificationOtp(email, otp);
        }
      }),
      phoneNumber({
        expiresIn: 600, // 10 minutes
        sendOTP: async ({ phoneNumber: targetPhone, code }) => {
          await smsService.sendVerificationOtp(targetPhone, code);
        }
      })
    ]
  });
}
