import { Request, Response } from 'express';
import { db } from '../database/connection';

export function getHealth(req: Request, res: Response): void {
  const dbHealth = db.getHealth();
  const isHealthy = dbHealth.isConnected || process.env.NODE_ENV !== 'production';

  res.status(isHealthy ? 200 : 503).json({
    success: true,
    data: {
      status: 'UP',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      environment: process.env.NODE_ENV || 'development',
      version: '1.0.0',
      database: dbHealth
    }
  });
}
