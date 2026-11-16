import { paymentService } from '../services/payment.service';
import { logger } from '../utils/logger';

const INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;

/**
 * Long-running deployment fallback for missed/delayed provider webhooks.
 * Serverless deployments should also configure the /api/v1/payments/reconcile
 * cron endpoint with CRON_SECRET.
 */
export function startPaymentReconciliationJob(): void {
  if (timer) return;

  const run = () => {
    paymentService
      .reconcilePendingPayments({ limit: 10, maxAgeHours: 72 })
      .then((result) => {
        if (result.fulfilled > 0 || result.updated > 0 || result.failed > 0) {
          logger.info('Payment reconciliation sweep completed', result);
        }
      })
      .catch((error) => {
        logger.warn('Payment reconciliation sweep skipped/failed', {
          error: error?.message
        });
      });
  };

  run();
  timer = setInterval(run, INTERVAL_MS);
  timer.unref?.();
  logger.info('Payment reconciliation job started', { intervalMs: INTERVAL_MS });
}
