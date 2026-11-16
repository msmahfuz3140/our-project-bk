import { Router } from 'express';
import { paymentController } from '../controllers/payment.controller';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rateLimit.middleware';
import { UserRole } from '../shared/roles';

const router = Router();

// Public: supported cryptocurrencies list
router.get('/currencies', (req, res, next) =>
  paymentController.getCurrencies(req, res, next)
);

/**
 * Public NOWPayments IPN webhook.
 * - No user login / CSRF token: authenticity is proven by HMAC-SHA512.
 * - Rate limiting is intentionally generous so provider retries are not lost.
 */
router.post('/ipn', rateLimit(300, 1, 'np_webhook'), (req, res, next) =>
  paymentController.handleIpn(req, res, next)
);

// Task-specified canonical webhook path (inside the versioned API router).
router.post('/nowpayments/webhook', rateLimit(300, 1, 'np_webhook'), (req, res, next) =>
  paymentController.handleIpn(req, res, next)
);

// Authenticated: create purchase order (server-side authoritative price)
router.post('/create', requireAuth, rateLimit(10, 15, 'order_create'), (req, res, next) =>
  paymentController.createOrder(req, res, next)
);

// Backward-compatible alias used by the existing frontend
router.post('/create-order', requireAuth, rateLimit(10, 15, 'order_create'), (req, res, next) =>
  paymentController.createOrder(req, res, next)
);

// --- Admin Controls (Main Admins only) ---
// IMPORTANT: static admin routes must be registered before GET /:id.

router.get('/admin/orders', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  paymentController.getAdminOrders(req, res, next)
);

router.get('/admin/orders/:orderId', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  paymentController.getAdminOrderDetails(req, res, next)
);

router.get('/admin/summary', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  paymentController.getAdminSummary(req, res, next)
);

router.get('/admin/health', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  paymentController.getAdminHealth(req, res, next)
);

router.post('/admin/reconcile', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  paymentController.reconcileAdminPayments(req, res, next)
);

// Manual approval/rejection: server-side role check + provider re-verification.
router.post(
  '/admin/orders/:orderId/approve',
  requireAuth,
  requireRole(UserRole.SUPER_ADMIN),
  rateLimit(10, 15, 'payment_manual_approve'),
  (req, res, next) => paymentController.approveAdminPayment(req, res, next)
);

router.post(
  '/admin/orders/:orderId/reject',
  requireAuth,
  requireRole(UserRole.SUPER_ADMIN),
  rateLimit(10, 15, 'payment_manual_reject'),
  (req, res, next) => paymentController.rejectAdminPayment(req, res, next)
);

router.get('/admin/export', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  paymentController.exportAdminReport(req, res, next)
);

// Serverless cron / uptime reconciliation. Protected by CRON_SECRET, not a
// user session, so it can run even when no admin is logged in.
router.get('/reconcile', rateLimit(60, 1, 'payment_reconcile'), (req, res, next) =>
  paymentController.reconcileCronPayments(req, res, next)
);
router.post('/reconcile', rateLimit(60, 1, 'payment_reconcile'), (req, res, next) =>
  paymentController.reconcileCronPayments(req, res, next)
);

// Authenticated: payment history (must precede /:id)
router.get('/history', requireAuth, (req, res, next) =>
  paymentController.getHistory(req, res, next)
);

// Authenticated: get order details by order number (legacy)
router.get('/order/:orderId', requireAuth, (req, res, next) =>
  paymentController.getOrder(req, res, next)
);

// Authenticated: get payment by order number, payment id, or invoice id
router.get('/:id', requireAuth, (req, res, next) =>
  paymentController.getPaymentById(req, res, next)
);

export const paymentRoutes = router;
