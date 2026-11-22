import { transactionalEmailService } from '../services/transactionalEmail.service';
import { logger } from '../utils/logger';

const RETRY_INTERVAL_MS = 5 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

/**
 * Retries persisted transactional emails after a transient SMTP/provider
 * outage. One-time codes are never persisted, so they are intentionally
 * excluded; the user can request a fresh code instead.
 */
export function startEmailRetryJob(): void {
  if (timer) return;

  const sweep = () => {
    transactionalEmailService
      .processPendingRetries(25)
      .then((result) => {
        if (result.checked > 0) {
          logger.info('Transactional email retry sweep completed', result);
        }
      })
      .catch((error) => logger.error('Transactional email retry sweep failed', error));
  };

  timer = setInterval(sweep, RETRY_INTERVAL_MS);
  timer.unref?.();
  logger.info('Transactional email retry job started', { intervalMs: RETRY_INTERVAL_MS });
}
