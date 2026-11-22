import { Request, Response, NextFunction } from 'express';
import { walletService } from '../services/wallet.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { ApiError } from '../utils/apiError';
import { publicWithdrawalMethods } from '../shared/withdrawalMethods';

function parseAmountCents(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.round(numeric * 100);
}

export class WalletController {
  async getMyWallet(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = req.query.page ? Number(req.query.page) : 1;
      const limit = req.query.limit ? Number(req.query.limit) : 25;
      const data = await walletService.getSummary(req.user!.id, {
        transactionPage: page,
        transactionLimit: limit
      });
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getMyTransactions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await walletService.listTransactions(req.user!.id, {
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 25,
        type: req.query.type as string,
        status: req.query.status as string
      });
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async getMyWithdrawals(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await walletService.listUserWithdrawals(
        req.user!.id,
        req.query.page ? Number(req.query.page) : 1,
        req.query.limit ? Number(req.query.limit) : 20
      );
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async requestWithdrawal(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { amountUsd, amountCents, methodId, walletAddress, network, idempotencyKey } = req.body || {};
      if (!walletAddress) {
        throw ApiError.badRequest('A receiving wallet address is required');
      }
      if (!methodId && !network) {
        throw ApiError.badRequest('Select a supported cryptocurrency and network');
      }
      const withdrawal = await walletService.createWithdrawal(req.user!.id, {
        amountUsd: amountUsd !== undefined ? Number(amountUsd) : undefined,
        amountCents: amountCents !== undefined ? Number(amountCents) : parseAmountCents(amountUsd),
        methodId: methodId ? String(methodId) : undefined,
        walletAddress: String(walletAddress),
        network: network ? String(network) : undefined,
        idempotencyKey: idempotencyKey ? String(idempotencyKey) : undefined
      });
      res.status(201).json({
        success: true,
        message: 'Withdrawal request submitted for admin review',
        data: withdrawal
      });
    } catch (error) {
      next(error);
    }
  }

  async getWithdrawalMethods(_req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({
        success: true,
        data: { methods: publicWithdrawalMethods() }
      });
    } catch (error) {
      next(error);
    }
  }

  // --- Admin ---

  async adminListWallets(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await walletService.adminListWallets({
        search: req.query.search as string,
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 25
      });
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async adminWalletStats(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await walletService.getAdminWalletStats();
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async adminAdjustBalance(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId, direction, amountUsd, amountCents, reason, idempotencyKey } = req.body || {};
      if (!userId) throw ApiError.badRequest('userId is required');
      if (!['ADD', 'DEDUCT'].includes(direction)) {
        throw ApiError.badRequest('direction must be ADD or DEDUCT');
      }
      if (!reason || String(reason).trim().length < 3) {
        throw ApiError.badRequest('A clear adjustment reason is required');
      }

      const cents = amountCents !== undefined ? Number(amountCents) : parseAmountCents(amountUsd);
      if (!cents || cents <= 0) throw ApiError.badRequest('Adjustment amount must be greater than zero');

      const transaction = await walletService.adjustBalance({
        userId: String(userId),
        direction,
        amountCents: cents,
        reason: String(reason),
        adminId: req.user!.id,
        adminEmail: req.user!.email || 'admin',
        idempotencyKey: idempotencyKey ? String(idempotencyKey) : undefined
      });

      res.status(201).json({
        success: true,
        message: `Wallet ${direction === 'ADD' ? 'credited' : 'debited'} successfully`,
        data: transaction
      });
    } catch (error) {
      next(error);
    }
  }

  async adminListWithdrawals(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await walletService.adminListWithdrawals({
        status: req.query.status as string,
        search: req.query.search as string,
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 25
      });
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async adminApproveWithdrawal(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const withdrawal = await walletService.approveWithdrawal(
        req.user!.id,
        req.user!.email || 'admin',
        req.params.id as string,
        req.body?.note
      );
      res.status(200).json({ success: true, message: 'Withdrawal approved', data: withdrawal });
    } catch (error) {
      next(error);
    }
  }

  async adminRejectWithdrawal(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const reason = req.body?.reason || req.body?.note;
      if (!reason) throw ApiError.badRequest('Rejection reason is required');
      const withdrawal = await walletService.rejectWithdrawal(
        req.user!.id,
        req.user!.email || 'admin',
        req.params.id as string,
        String(reason)
      );
      res.status(200).json({
        success: true,
        message: 'Withdrawal rejected and amount refunded to available balance',
        data: withdrawal
      });
    } catch (error) {
      next(error);
    }
  }

  async adminMarkWithdrawalPaid(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const withdrawal = await walletService.markWithdrawalPaid(
        req.user!.id,
        req.user!.email || 'admin',
        req.params.id as string,
        req.body?.transactionHash
      );
      res.status(200).json({
        success: true,
        message: 'Withdrawal marked as paid/completed',
        data: withdrawal
      });
    } catch (error) {
      next(error);
    }
  }

  async adminListTransactions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await walletService.adminListTransactions({
        search: req.query.search as string,
        type: req.query.type as string,
        status: req.query.status as string,
        userId: req.query.userId as string,
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 25
      });
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
}

export const walletController = new WalletController();
