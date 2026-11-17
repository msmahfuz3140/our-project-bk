import { Request, Response } from 'express';
import { db } from '../database/connection';
import { validateCoreEnvironment, validatePaymentEnvironment } from '../config/env';

/**
 * Public liveness/readiness endpoint.
 *
 * Only non-sensitive operational state is exposed. Detailed configuration,
 * database topology, payment provider settings and diagnostics are available
 * exclusively through the authenticated admin system-health endpoint.
 */
export async function getHealth(req: Request, res: Response): Promise<void> {
  if (db.getHealth().readyState === 0) {
    try {
      await db.connect();
    } catch {
      // Reported through db.getHealth() below.
    }
  }

  const dbHealth = db.getHealth();
  const coreIssues = validateCoreEnvironment();
  const paymentIssues = validatePaymentEnvironment();

  const coreErrors = coreIssues.filter((issue) => issue.severity === 'ERROR');
  const configurationReady = [...coreIssues, ...paymentIssues].every(
    (issue) => issue.severity !== 'ERROR'
  );
  const isHealthy = dbHealth.isConnected && coreErrors.length === 0;

  res.status(isHealthy ? 200 : 503).json({
    success: true,
    data: {
      status: isHealthy ? 'UP' : 'DOWN',
      ready: isHealthy && configurationReady,
      timestamp: new Date().toISOString()
    }
  });
}
