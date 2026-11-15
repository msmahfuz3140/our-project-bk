import { Request, Response } from 'express';
import { db } from '../database/connection';
import { env } from '../config/env';
import { nowPaymentsService } from '../services/nowpayments.service';

export function getHealth(req: Request, res: Response): void {
  const dbHealth = db.getHealth();
  const isHealthy = dbHealth.isConnected || process.env.NODE_ENV !== 'production';
  const paymentConfig = nowPaymentsService.getConfigurationStatus();

  res.status(isHealthy ? 200 : 503).json({
    success: true,
    data: {
      status: isHealthy ? 'UP' : 'DEGRADED',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      environment: process.env.NODE_ENV || 'development',
      version: '1.0.0',
      database: dbHealth,
      payments: {
        provider: paymentConfig.provider,
        mode: paymentConfig.mode,
        apiKeyConfigured: paymentConfig.apiKeyConfigured,
        ipnSecretConfigured: paymentConfig.ipnSecretConfigured,
        liveEnabled: paymentConfig.liveEnabled,
        webhookUrl: paymentConfig.webhookUrl,
        webhookConfigured: paymentConfig.ipnSecretConfigured && Boolean(paymentConfig.webhookUrl),
        apiHost: paymentConfig.apiHost
      },
      corsOrigins: env.CORS_ORIGIN.split(',').length
    }
  });
}
