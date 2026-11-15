import express, { Request, Response } from 'express';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env';
import { apiRoutes } from './routes';
import { errorHandler } from './middleware/error.middleware';
import { getHealth } from './controllers/health.controller';
import { logger } from './utils/logger';

export const app = express();

// Security & Parsing Middlewares
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = env.CORS_ORIGIN.split(',').map(o => o.trim().replace(/\/$/, ''));
    const cleanOrigin = origin.replace(/\/$/, '');
    if (
      allowed.includes(cleanOrigin) ||
      cleanOrigin.includes('rouletteaccuracy.com') ||
      cleanOrigin.endsWith('.vercel.app') ||
      cleanOrigin.includes('localhost') ||
      env.NODE_ENV === 'development'
    ) {
      return callback(null, true);
    }
    return callback(new Error(`CORS policy blocked access from origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));
app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));

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
      await db.connect();
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

