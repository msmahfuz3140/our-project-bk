import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import { isProductionRuntime } from '../config/env';
import { ZodError } from 'zod';

export function errorHandler(
  err: Error | ApiError | ZodError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  // Handle Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: ((err as any).issues || (err as any).errors || []).map((e: any) => ({
          field: Array.isArray(e.path) ? e.path.join('.') : String(e.path || ''),
          message: e.message
        }))
      }
    });
    return;
  }

  // Handle custom ApiError
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code || 'API_ERROR',
        message: err.message,
        details: err.details
      }
    });
    return;
  }

  // Handle unexpected internal errors
  logger.error('Unhandled Server Error', err, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip
  });

  const errName = err?.name || '';
  const errMsg = err?.message || '';
  const isDbError =
    errName.includes('Mongo') ||
    /Could not connect to any servers|buffering timed out|ECONNREFUSED|ENOTFOUND/i.test(errMsg);

  if (isDbError) {
    res.status(503).json({
      success: false,
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'Database is currently unreachable. Please add 0.0.0.0/0 in MongoDB Atlas Network Access.'
      }
    });
    return;
  }

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: isProductionRuntime
        ? 'An unexpected error occurred. Please try again later.'
        : err.message
    }
  });
}
