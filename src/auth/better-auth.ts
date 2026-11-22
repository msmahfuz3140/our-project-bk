import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { bearer } from 'better-auth/plugins';
import mongoose from 'mongoose';
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
    'https://our-project-fn.vercel.app',
    'https://our-project-bk.vercel.app',
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
      enabled: false,
      requireEmailVerification: true
    },
    plugins: [
      bearer()
    ]
  });
}
