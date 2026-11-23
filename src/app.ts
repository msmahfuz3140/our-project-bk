import express, { Request, Response } from 'express';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env';
import { apiRoutes } from './routes';
import { paymentAliasRoutes } from './routes/paymentAlias.routes';
import { paymentController } from './controllers/payment.controller';
import { errorHandler } from './middleware/error.middleware';
import { csrfOriginGuard } from './middleware/csrf.middleware';
import { apiCacheHeaders } from './middleware/cacheHeaders.middleware';
import { performanceMiddleware } from './middleware/performance.middleware';
import { getHealth } from './controllers/health.controller';
import { validatePaymentEnvironment } from './config/env';
import { validateCoreEnvironment } from './config/env';
import { logger } from './utils/logger';
import { ApiError } from './utils/apiError';
import { isOriginAllowed } from './utils/origin';

export const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Validate payment configuration at startup without ever printing secrets.
const paymentConfigIssues = validatePaymentEnvironment();
for (const issue of paymentConfigIssues) {
  const meta = { variable: issue.variable };
  if (issue.severity === 'ERROR') {
    logger.error(`Payment configuration: ${issue.message}`, undefined, meta);
  } else {
    logger.warn(`Payment configuration: ${issue.message}`, meta);
  }
}

// Validate database/auth/core production configuration.
for (const issue of validateCoreEnvironment()) {
  const meta = { variable: issue.variable };
  if (issue.severity === 'ERROR') {
    logger.error(`Core configuration: ${issue.message}`, undefined, meta);
  } else {
    logger.warn(`Core configuration: ${issue.message}`, meta);
  }
}

// Security & Parsing Middlewares
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (isOriginAllowed(origin)) return callback(null, true);
    // Never throw here: the cors package would surface the error as a 500.
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'x-nowpayments-sig'],
  maxAge: 86400
}));

// Reject disallowed browser origins with a clean 403 on actual requests.
app.use('/api', (req, _res, next) => {
  const origin = req.get('origin');
  if (origin && !isOriginAllowed(origin)) {
    next(ApiError.forbidden('Requests from this origin are not allowed.', 'CORS_ORIGIN_REJECTED'));
    return;
  }
  next();
});
app.use(express.json({
  limit: '1mb',
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// HTTP caching policy for public vs private API responses.
app.use('/api', apiCacheHeaders);

// CSRF defense for cookie-authenticated state-changing requests.
app.use('/api', csrfOriginGuard);

// Request timing and rolling performance telemetry
app.use(performanceMiddleware);

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.debug(`${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`, {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: duration,
      ip: req.ip
    });
  });
  next();
});

// Root welcome & status endpoint
app.get(['/', '/api', '/api/index'], (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: 'Roulette Accuracy Backend REST API is live and operational.',
    version: '1.0.0',
    website: env.PUBLIC_FRONTEND_URL || 'https://www.accuracy.tools',
    health: '/health',
    apiPrefix: '/api/v1'
  });
});

// Root health check endpoint
app.get('/health', getHealth);

// Lazy Database connection middleware for Serverless runtime
let isDbInitialized = false;
app.use(async (_req, _res, next) => {
  try {
    if (!isDbInitialized) {
      const { db } = require('./database/connection');
      const { initializeAuthoritativeAdmin } = require('./database/initAdmin');
      const { ensurePaymentIndexes } = require('./database/ensureIndexes');
      const { ensureSecurityBaseline } = require('./database/ensureIndexes');
      const { ensureMissingReferralCodes } = require('./database/ensureIndexes');
      const connected = await db.connect();
      if (connected) {
        await ensurePaymentIndexes().catch((err: any) => {
          logger.error('Failed to ensure payment indexes during startup:', err);
        });
        await ensureSecurityBaseline().catch((err: any) => {
          logger.error('Failed to run security baseline migration:', err);
        });
        await ensureMissingReferralCodes().catch((err: any) => {
          logger.error('Failed to backfill missing referral codes:', err);
        });
        await initializeAuthoritativeAdmin().catch((err: any) => {
          logger.error('Failed to initialize admin during startup:', err);
        });
        isDbInitialized = true;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Better Auth endpoints
let betterAuthHandler: any = null;
app.all(['/api/auth/*', '/api/v1/auth/better/*'], (req: Request, res: Response, next) => {
  try {
    if (!betterAuthHandler) {
      const { toNodeHandler } = require('better-auth/node');
      const { getBetterAuth } = require('./auth/better-auth');
      betterAuthHandler = toNodeHandler(getBetterAuth());
    }
    return betterAuthHandler(req, res);
  } catch (err) {
    next(err);
  }
});

// API v1 prefix
app.use('/api/v1', apiRoutes);

// Exact public aliases requested by the payment integration specification
// (webhook paths, /api/payments/create, /api/payments/:id, /api/subscriptions/me).
app.use('/api', paymentAliasRoutes);

// Vercel Cron endpoint aliases (/api/cron/check-payments and /cron/check-payments)
app.all(['/api/cron/check-payments', '/cron/check-payments'], (req: Request, res: Response, next) => {
  paymentController.reconcileCronPayments(req, res, next);
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `The requested endpoint ${req.method} ${req.originalUrl} was not found on this server.`
    }
  });
});

// Global Centralized Error Handler
app.use(errorHandler);

