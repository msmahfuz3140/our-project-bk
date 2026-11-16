import { Request, Response } from 'express';
import { db } from '../database/connection';
import { env, validateCoreEnvironment, validatePaymentEnvironment, isProductionRuntime } from '../config/env';
import { nowPaymentsService } from '../services/nowpayments.service';

export async function getHealth(req: Request, res: Response): Promise<void> {
  if (db.getHealth().readyState === 0) {
    try {
      await db.connect();
    } catch {
      // Handled by db.getHealth() below
    }
  }

  const dbHealth = db.getHealth();
  const paymentConfig = nowPaymentsService.getConfigurationStatus();
  const coreIssues = validateCoreEnvironment();
  const paymentIssues = validatePaymentEnvironment();
  const issues = [...coreIssues, ...paymentIssues];

  // A disconnected database means the API cannot serve its data endpoints.
  // In production, missing core secrets/configuration also makes the service
  // non-ready. Payment-only warnings are reported separately.
  const coreErrors = coreIssues.filter((issue) => issue.severity === 'ERROR');
  const isHealthy = dbHealth.isConnected && coreErrors.length === 0;
  const configurationReady = issues.every((issue) => issue.severity !== 'ERROR');

  res.status(isHealthy ? 200 : 503).json({
    success: true,
    data: {
      status: isHealthy ? 'UP' : 'DOWN',
      ready: isHealthy && configurationReady,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      environment: process.env.NODE_ENV || 'development',
      productionRuntime: isProductionRuntime,
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
      configuration: {
        ready: configurationReady,
        issues: issues.map((issue) => ({
          variable: issue.variable,
          severity: issue.severity,
          message: issue.message
        }))
      },
      corsOrigins: env.CORS_ORIGIN.split(',').length
    }
  });
}
