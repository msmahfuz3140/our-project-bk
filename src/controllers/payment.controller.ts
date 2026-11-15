import { Request, Response, NextFunction } from 'express';
import { paymentService } from '../services/payment.service';
import { nowPaymentsService } from '../services/nowpayments.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { UserRole } from '../shared/roles';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';

export class PaymentController {
  /**
   * Create a new purchase order
   */
  async createOrder(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { planId, payCurrency } = req.body;
      if (!planId) {
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
   * Get single order status for the checkout screen
   */
  async getOrder(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { orderId } = req.params;
      const isSuperAdmin = req.user!.role === UserRole.SUPER_ADMIN;
      const order = await paymentService.getOrder(orderId as string, req.user!.id, isSuperAdmin);

      res.status(200).json({
        success: true,
        data: {
          orderId: order.orderId,
          paymentId: order.paymentId,
          planId: order.planId,
          planName: order.planName,
          priceUsd: order.priceAmount,
          priceCents: order.priceCents,
          duration: order.duration,
          durationDays: order.durationDays,
          status: order.status,
          isFulfilled: order.isFulfilled,
          actuallyPaid: order.actuallyPaid,
          payCurrency: order.payCurrency,
          checkoutUrl: order.checkoutUrl,
          createdAt: order.createdAt
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * NOWPayments IPN Webhook Receiver
   * Processes server-to-server callback notifications
   */
  async handleIpn(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const signature = req.headers['x-nowpayments-sig'] as string | undefined;
      const payload = req.body;

      logger.info('NOWPayments IPN callback received', {
        orderId: payload?.order_id,
        paymentId: payload?.payment_id,
        status: payload?.payment_status
      });

      const result = await paymentService.processIpnCallback(payload, signature);

      // Always respond with 200 OK so NOWPayments acknowledges receipt
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get supported crypto currencies
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
