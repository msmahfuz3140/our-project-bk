import { db } from '../../src/database/connection';
import { paymentService } from '../../src/services/payment.service';
import { env } from '../../src/config/env';
import crypto from 'crypto';

/**
 * Dedicated Vercel Serverless Function for Cron payment checking.
 * Endpoint: /api/cron/check-payments
 */
export default async function handler(req: any, res: any) {
  try {
    const configuredSecret = (env.CRON_SECRET || '').trim();
    const authorization = String(req.headers.authorization || '');
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : authorization.trim();
    const headerSecret = String(req.headers['x-cron-secret'] || '').trim();
    const supplied = bearer || headerSecret;

    const isVercelCron = String(req.headers['user-agent'] || '').toLowerCase().includes('vercel-cron');

    if (configuredSecret) {
      const valid =
        supplied.length === configuredSecret.length &&
        crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(configuredSecret));

      if (!valid && !isVercelCron) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized: Invalid reconciliation secret'
        });
      }
    }

    await db.connect();
    const result = await paymentService.reconcilePendingPayments({ limit: 25 });

    return res.status(200).json({
      success: true,
      message: `Reconciliation complete: ${result.fulfilled} activated, ${result.updated} updated, ${result.failed} failed.`,
      data: result
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Payment reconciliation failed'
    });
  }
}
