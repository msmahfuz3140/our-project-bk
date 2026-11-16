import { subscriptionAccessService } from '../services/subscriptionAccess.service';
import { logger } from '../utils/logger';

const SWEEP_INTERVAL_MS = 30_000;
let timer: NodeJS.Timeout | null = null;

/**
 * Persists EXPIRED status for subscriptions whose exact end timestamp has
 * passed. This is a consistency job only: every protected request also
 * validates endDate against server time, so access is never extended if this
 * timer is delayed or a serverless instance is frozen.
 */
export function startSubscriptionExpiryJob(): void {
  if (timer) return;

  const sweep = () => {
    subscriptionAccessService
      .expireExpiredSubscriptions(new Date(), true)
      .catch((error) => logger.error('Subscription expiry sweep failed', error));
  };

  sweep();
  timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref?.();
  logger.info('Subscription expiry sweep job started', { intervalMs: SWEEP_INTERVAL_MS });
}
