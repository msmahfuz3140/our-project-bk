import { Router } from 'express';
import { paymentController } from '../controllers/payment.controller';
import { subscriptionController } from '../controllers/subscription.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rateLimit.middleware';

/**
 * Public API aliases requested by the integration specification.
 *
 * The canonical versioned API remains /api/v1. These aliases exist so the
 * exact paths in the payment specification (and NOWPayments dashboard) work
 * without duplicating business logic.
 */
const router = Router();

// POST /api/payments/create
router.post('/payments/create', requireAuth, rateLimit(10, 15, 'order_create'), (req, res, next) =>
  paymentController.createOrder(req, res, next)
);

// POST /api/nowpayments/webhook
router.post('/nowpayments/webhook', rateLimit(300, 1, 'np_webhook'), (req, res, next) =>
  paymentController.handleIpn(req, res, next)
);

// POST /api/payments/nowpayments/webhook
router.post('/payments/nowpayments/webhook', rateLimit(300, 1, 'np_webhook'), (req, res, next) =>
  paymentController.handleIpn(req, res, next)
);

// POST /api/webhooks/nowpayments
router.post('/webhooks/nowpayments', rateLimit(300, 1, 'np_webhook'), (req, res, next) =>
  paymentController.handleIpn(req, res, next)
);

// GET /api/subscriptions/me
router.get('/subscriptions/me', requireAuth, (req, res, next) =>
  subscriptionController.getMySubscription(req, res, next)
);

// GET /api/payments/history (before /payments/:id)
router.get('/payments/history', requireAuth, (req, res, next) =>
  paymentController.getHistory(req, res, next)
);

// GET /api/payments/:id
router.get('/payments/:id', requireAuth, (req, res, next) =>
  paymentController.getPaymentById(req, res, next)
);

export const paymentAliasRoutes = router;
