import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { financialService } from '../services/financial.service';

export class FinancialController {
  async getSummary(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const summary = await financialService.getSummary();
      res.status(200).json({ success: true, data: summary });
    } catch (err) {
      next(err);
    }
  }

  async listTransactions(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { type, search, startDate, endDate, page, limit } = req.query;
      const result = await financialService.listTransactions({
        type: type as string,
        search: search as string,
        startDate: startDate as string,
        endDate: endDate as string,
        page: page && !Number.isNaN(Number(page)) ? Number(page) : 1,
        limit: limit && !Number.isNaN(Number(limit)) ? Number(limit) : 25
      });
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async createPayout(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { amountUsd, amountCents, description, method, reference, idempotencyKey } =
        req.body || {};

      const result = await financialService.createPayout(
        req.user!.id,
        req.user!.email || 'admin@rouletteaccuracy.com',
        {
          amountUsd,
          amountCents,
          description,
          method,
          reference,
          idempotencyKey
        }
      );

      res.status(result.duplicate ? 200 : 201).json({
        success: true,
        data: result,
        message: result.duplicate
          ? 'This payout was already recorded; the existing transaction was returned.'
          : 'Payout recorded successfully.'
      });
    } catch (err) {
      next(err);
    }
  }
}

export const financialController = new FinancialController();
