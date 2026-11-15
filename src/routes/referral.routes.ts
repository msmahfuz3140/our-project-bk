import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { ReferralClickModel } from '../models/ReferralClick';
import { UserModel } from '../models/User';
import { UserRole } from '../shared/roles';
import { env } from '../config/env';
import { rateLimit } from '../middleware/rateLimit.middleware';
import { logger } from '../utils/logger';
import { cacheKeys, memoryCache } from '../utils/cache';

const ClickSchema = z.object({
  referralCode: z.string().min(3).max(80),
  path: z.string().max(500).optional(),
  referrer: z.string().max(1000).optional()
});

const router = Router();

router.post('/click', rateLimit(60, 15, 'referral_click'), async (req, res, next) => {
  try {
    const parsed = ClickSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(202).json({ success: true });
      return;
    }

    const referralCode = parsed.data.referralCode.trim().toUpperCase();
    const moderator: any = await UserModel.findOne({
      referralCode,
      role: UserRole.MODERATOR,
      isDeleted: { $ne: true }
    }).select('_id').lean();

    // Do not reveal whether a referral code is valid to anonymous callers.
    if (!moderator) {
      res.status(202).json({ success: true });
      return;
    }

    const ip = String(req.ip || req.headers['x-forwarded-for'] || '');
    const ipHash = ip
      ? crypto.createHash('sha256').update(`${env.JWT_SECRET}:${ip}`).digest('hex').slice(0, 32)
      : undefined;

    await ReferralClickModel.create({
      referralCode,
      moderatorId: moderator._id,
      landingPath: parsed.data.path || '/gerister',
      referrer: parsed.data.referrer,
      ipHash,
      userAgent: req.get('user-agent')?.slice(0, 500)
    });

    memoryCache.delByPrefix('moderator:');
    memoryCache.del(cacheKeys.adminSystemHealth);

    res.status(201).json({ success: true });
  } catch (error) {
    logger.debug('Referral click tracking failed', { error: String(error) });
    // Click tracking must never block registration.
    res.status(202).json({ success: true });
  }
});

export const referralRoutes = router;
