import { Router } from 'express';
import { paymentController } from '../controllers/payment.controller';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rateLimit.middleware';
import { UserRole } from '../shared/roles';

const router = Router();

// Public: Supported cryptocurrencies list
router.get('/currencies', (req, res, next) =>
  paymentController.getCurrencies(req, res, next)
);

// Public webhook: NOWPayments IPN callback (validates x-nowpayments-sig)
router.post('/ipn', (req, res, next) =>
  paymentController.handleIpn(req, res, next)
);

// Authenticated: Create purchase order (rate limited to 10 per 15 minutes)
router.post('/create-order', requireAuth, rateLimit(10, 15, 'order_create'), (req, res, next) =>
  paymentController.createOrder(req, res, next)
);

// Authenticated: Get order details by orderId
router.get('/order/:orderId', requireAuth, (req, res, next) =>
  paymentController.getOrder(req, res, next)
);

// --- Admin Controls (Main Admins only) ---

router.get('/admin/orders', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  paymentController.getAdminOrders(req, res, next)
);

router.get('/admin/summary', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  paymentController.getAdminSummary(req, res, next)
);

router.get('/admin/export', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  paymentController.exportAdminReport(req, res, next)
);

export const paymentRoutes = router;
