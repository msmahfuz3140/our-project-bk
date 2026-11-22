import { Router } from 'express';
import { contactController } from '../controllers/contact.controller';
import { rateLimit } from '../middleware/rateLimit.middleware';
import { requireTurnstile } from '../middleware/turnstile.middleware';
import { requireAuth, requireRole, requireAdmin2FA } from '../middleware/auth.middleware';
import { UserRole } from '../shared/roles';

const router = Router();

// Public contact form (5 inquiries per 15 minutes per IP with Cloudflare Turnstile CAPTCHA)
router.post('/', rateLimit(5, 15, 'contact'), requireTurnstile('contact'), (req, res, next) =>
  contactController.submitInquiry(req, res, next)
);

// Main Admin: persisted contact messages
router.get('/admin/messages', requireAuth, requireRole(UserRole.SUPER_ADMIN), requireAdmin2FA, (req, res, next) =>
  contactController.listMessages(req as any, res, next)
);

router.patch('/admin/messages/:id', requireAuth, requireRole(UserRole.SUPER_ADMIN), requireAdmin2FA, (req, res, next) =>
  contactController.updateMessageStatus(req as any, res, next)
);

export const contactRoutes = router;
