import { Router } from 'express';
import { contactController } from '../controllers/contact.controller';
import { rateLimit } from '../middleware/rateLimit.middleware';

const router = Router();

// Rate limit: 5 inquiries per 15 minutes per IP
router.post('/', rateLimit(5, 15, 'contact'), (req, res, next) =>
  contactController.submitInquiry(req, res, next)
);

export const contactRoutes = router;
