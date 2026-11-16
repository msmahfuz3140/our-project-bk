import { Request, Response, NextFunction } from 'express';
import { paymentService } from '../services/payment.service';
import { nowPaymentsService } from '../services/nowpayments.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { UserRole } from '../shared/roles';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';

export class PaymentController {
  /**
   * Create a new purchase order (server-authoritative plan price).
   */
  async createOrder(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { planId, payCurrency } = req.body || {};
      if (!planId || typeof planId !== 'string') {
        throw ApiError.badRequest('planId is required to create a purchase order');
      }

      const result = await paymentService.createPurchaseOrder(req.user!.id, planId, payCurrency);
      res.status(201).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get a single order status by order number (legacy checkout route).
   */
  async getOrder(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { orderId } = req.params;
      const isSuperAdmin = req.user!.role === UserRole.SUPER_ADMIN;
      const order = await paymentService.getPaymentDetails(orderId as string, req.user!.id, isSuperAdmin);

      res.status(200).json({
        success: true,
        data: order
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get payment status by order number, provider payment id, or invoice id.
   */
  async getPaymentById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const isSuperAdmin = req.user!.role === UserRole.SUPER_ADMIN;
      const payment = await paymentService.getPaymentDetails(id as string, req.user!.id, isSuperAdmin);

      res.status(200).json({
        success: true,
        data: payment
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Authenticated user's own payment history.
   */
  async getHistory(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = req.query.page ? Number(req.query.page) : 1;
      const limit = req.query.limit ? Number(req.query.limit) : 20;
      const result = await paymentService.getPaymentHistory(req.user!.id, page, limit);

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * NOWPayments IPN Webhook Receiver.
   *
   * Public by design: NOWPayments cannot supply a user session. The request is
   * authenticated cryptographically through x-nowpayments-sig instead.
   */
  async handleIpn(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const signatureHeader = req.headers['x-nowpayments-sig'];
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
      const payload = req.body;

      logger.info('NOWPayments IPN callback received', {
        orderId: payload?.order_id,
        paymentId: payload?.payment_id,
        status: payload?.payment_status,
        hasSignature: Boolean(signature),
        ip: req.ip
      });

      const result = await paymentService.processIpnCallback(payload, signature);

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      // Invalid signatures and malformed payloads are handled centrally and
      // return 4xx without exposing internals. Provider/network failures
      // return 5xx so NOWPayments retries the notification.
      next(error);
    }
  }

  /**
   * Get supported crypto currencies.
   */
  async getCurrencies(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const currencies = await nowPaymentsService.getCurrencies();
      res.status(200).json({
        success: true,
        data: currencies
      });
    } catch (error) {
      next(error);
    }
  }

  // --- Admin Payment Controls (Main Admins only) ---

  async getAdminOrders(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { search, status, planId, startDate, endDate, page, limit } = req.query;

      const result = await paymentService.getAdminOrders({
        search: search as string,
        status: status as any,
        planId: planId as string,
        startDate: startDate as string,
        endDate: endDate as string,
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 20
      });

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async getAdminOrderDetails(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { orderId } = req.params;
      const result = await paymentService.getAdminOrderDetails(orderId as string);
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async getAdminSummary(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const summary = await paymentService.getAdminSummary();
      res.status(200).json({
        success: true,
        data: summary
      });
    } catch (error) {
      next(error);
    }
  }

  async getAdminHealth(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const health = await paymentService.getAdminPaymentHealth();
      res.status(200).json({
        success: true,
        data: health
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Manual approval of a pending payment. The service independently re-verifies
   * the payment with NOWPayments before activating Premium and blocks duplicate
   * or unpaid activations.
   */
  async approveAdminPayment(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { orderId } = req.params;
      const { reason } = req.body || {};
      if (!reason || typeof reason !== 'string') {
        throw ApiError.badRequest('A reason is required when manually approving a payment');
      }

      const result = await paymentService.approvePaymentManually(
        orderId as string,
        req.user!.id,
        req.user!.email || 'admin',
        reason
      );

      res.status(200).json({
        success: true,
        message: 'Payment verified and Premium subscription activated',
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Manual rejection of a pending payment. Records the admin, reason and audit
   * trail; never deletes the payment record.
   */
  async rejectAdminPayment(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { orderId } = req.params;
      const { reason } = req.body || {};
      if (!reason || typeof reason !== 'string') {
        throw ApiError.badRequest('A reason is required when rejecting a payment');
      }

      const result = await paymentService.rejectPaymentManually(
        orderId as string,
        req.user!.id,
        req.user!.email || 'admin',
        reason
      );

      res.status(200).json({
        success: true,
        message: 'Payment rejected and audit record created',
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async exportAdminReport(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { startDate, endDate, format } = req.query;
      const report = await paymentService.exportAdminReport(startDate as string, endDate as string);

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="payments-report-${Date.now()}.csv"`);
        res.status(200).send(report.csv);
        return;
      }

      res.status(200).json({
        success: true,
        data: report
      });
    } catch (error) {
      next(error);
    }
  }
}

export const paymentController = new PaymentController();
