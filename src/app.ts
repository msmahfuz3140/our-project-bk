import express, { Request, Response } from 'express';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env';
import { apiRoutes } from './routes';
import { paymentAliasRoutes } from './routes/paymentAlias.routes';
import { errorHandler } from './middleware/error.middleware';
import { csrfOriginGuard } from './middleware/csrf.middleware';
import { apiCacheHeaders } from './middleware/cacheHeaders.middleware';
import { performanceMiddleware } from './middleware/performance.middleware';
import { getHealth } from './controllers/health.controller';
import { validatePaymentEnvironment } from './config/env';
import { validateCoreEnvironment } from './config/env';
import { isProductionRuntime } from './config/env';
import { logger } from './utils/logger';

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
    const allowed = env.CORS_ORIGIN.split(',').map(o => o.trim().replace(/\/$/, ''));
    const cleanOrigin = origin.replace(/\/$/, '');
    let hostname = '';
    try {
      hostname = new URL(cleanOrigin).hostname.toLowerCase();
    } catch {
      return callback(new Error(`CORS policy blocked malformed origin: ${origin}`));
    }

    const isAllowedHost =
      hostname === 'accuracy.tools' ||
      hostname === 'www.accuracy.tools' ||
      hostname === 'rouletteaccuracy.com' ||
      hostname === 'www.rouletteaccuracy.com' ||
      hostname.endsWith('.rouletteaccuracy.com') ||
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      (hostname.endsWith('.vercel.app') && hostname.includes('our-project-bk'));

    if (
      allowed.includes(cleanOrigin) ||
      isAllowedHost ||
      (!isProductionRuntime && env.NODE_ENV === 'development')
    ) {
      return callback(null, true);
    }
    return callback(new Error(`CORS policy blocked access from origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'x-nowpayments-sig']
}));
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

// Lazy Database connection middleware for Serverless runtime
let isDbInitialized = false;
app.use(async (_req, _res, next) => {
  try {
    if (!isDbInitialized) {
      const { db } = require('./database/connection');
      const { initializeAuthoritativeAdmin } = require('./database/initAdmin');
      const { ensurePaymentIndexes } = require('./database/ensureIndexes');
      const { ensureSecurityBaseline } = require('./database/ensureIndexes');
      await db.connect();
      await ensurePaymentIndexes().catch((err: any) => {
        logger.error('Failed to ensure payment indexes during startup:', err);
      });
      await ensureSecurityBaseline().catch((err: any) => {
        logger.error('Failed to run security baseline migration:', err);
      });
      await initializeAuthoritativeAdmin().catch((err: any) => {
        logger.error('Failed to initialize admin during startup:', err);
      });
      isDbInitialized = true;
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Root welcome & status endpoint
app.get(['/', '/api', '/api/index'], (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: 'Roulette Accuracy Backend REST API is live and operational.',
    version: '1.0.0',
    website: 'https://rouletteaccuracy.com',
    health: '/health',
    apiPrefix: '/api/v1'
  });
});

// Root health check endpoint
app.get('/health', getHealth);

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

