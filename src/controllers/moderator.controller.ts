import { Request, Response, NextFunction } from 'express';
import { moderatorService } from '../services/moderator.service';
import { AccountStatus } from '../models/User';
import { CommissionStatus } from '../models/ReferralCommission';
import { env } from '../config/env';

export class ModeratorController {
  // =========================================================================
  // MAIN ADMIN ENDPOINTS
  // =========================================================================

  /**
   * POST /api/v1/admin/moderators
   */
  async createModerator(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const adminId = (req as any).user.id;
      const adminEmail = (req as any).user.email;
      const result = await moderatorService.createModerator(adminId, adminEmail, req.body);
      res.status(201).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/moderators
   */
  async listModerators(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { search, status, page, limit } = req.query;
      const origin = env.PUBLIC_FRONTEND_URL;
      const result = await moderatorService.listModerators({
        search: search as string,
        status: status as string,
        page: page ? parseInt(page as string, 10) : undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        baseUrl: origin
      });
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/moderators/:moderatorId
   */
  async getModeratorDetails(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const moderatorId = req.params.moderatorId as string;
      const origin = env.PUBLIC_FRONTEND_URL;
      const result = await moderatorService.getModeratorDetails(moderatorId, origin);
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/moderators/:moderatorId/status
   */
  async updateModeratorStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const adminId = (req as any).user.id;
      const adminEmail = (req as any).user.email;
      const moderatorId = req.params.moderatorId as string;
      const { status, reason, suspendedUntil } = req.body;

      const result = await moderatorService.updateModeratorStatus(
        adminId,
        adminEmail,
        moderatorId,
        status as AccountStatus,
        reason,
        suspendedUntil ? new Date(suspendedUntil) : undefined
      );

      res.status(200).json({
        success: true,
        data: {
          moderatorId: result._id.toString(),
          accountStatus: result.accountStatus,
          isActive: result.isActive
        }
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/moderators/:moderatorId/reset-password
   */
  async resetModeratorPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const adminId = (req as any).user.id;
      const adminEmail = (req as any).user.email;
      const moderatorId = req.params.moderatorId as string;
      const { newPassword, reason } = req.body;

      const result = await moderatorService.resetModeratorPassword(
        adminId,
        adminEmail,
        moderatorId,
        newPassword,
        reason
      );

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/moderators/:moderatorId/commission-rate
   */
  async updateModeratorCommissionRate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const adminId = (req as any).user.id;
      const adminEmail = (req as any).user.email;
      const moderatorId = req.params.moderatorId as string;
      const { commissionRate, reason } = req.body;

      const result = await moderatorService.updateModeratorCommissionRate(
        adminId,
        adminEmail,
        moderatorId,
        parseFloat(commissionRate),
        reason
      );

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/referrals/overview
   */
  async getReferralOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await moderatorService.getReferralOverview();
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/referrals/commissions
   */
  async listCommissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { moderatorId, status, commissionType, search, startDate, endDate, page, limit } = req.query;
      const result = await moderatorService.listCommissions({
        moderatorId: moderatorId as string,
        status: status as string,
        commissionType: commissionType as string,
        search: search as string,
        startDate: startDate as string,
        endDate: endDate as string,
        page: page ? parseInt(page as string, 10) : undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined
      });
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/referrals/commissions/:commissionId/status
   */
  async updateCommissionStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const adminId = (req as any).user.id;
      const adminEmail = (req as any).user.email;
      const commissionId = req.params.commissionId as string;
      const { status, reason } = req.body;

      const result = await moderatorService.updateCommissionStatus(
        adminId,
        adminEmail,
        commissionId,
        status as CommissionStatus,
        reason
      );

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/referrals/commissions/:commissionId/adjust
   */
  async adjustCommission(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const adminId = (req as any).user.id;
      const adminEmail = (req as any).user.email;
      const commissionId = req.params.commissionId as string;
      const { newAmountUsd, newStatus, reason, notes } = req.body;

      const result = await moderatorService.adjustCommission(
        adminId,
        adminEmail,
        commissionId,
        {
          newAmountUsd: newAmountUsd !== undefined ? Number(newAmountUsd) : undefined,
          newStatus: newStatus as CommissionStatus,
          reason,
          notes
        }
      );

      res.status(200).json({
        success: true,
        data: result,
        message: 'Commission record adjusted and audited successfully'
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/referrals/export
   */
  async exportCommissionsCsv(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { moderatorId, status } = req.query;
      const csv = await moderatorService.exportCommissionsCsv({
        moderatorId: moderatorId as string,
        status: status as string
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="commissions-report.csv"');
      res.status(200).send(csv);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/referrals/policy
   */
  async getCommissionPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const overview = await moderatorService.getReferralOverview();
      res.status(200).json({
        success: true,
        data: overview.globalCommissionPolicy
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/referrals/policy
   */
  async updateGlobalCommissionPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const adminId = (req as any).user.id;
      const adminEmail = (req as any).user.email;
      const { defaultRate, normalUserRate, referralEnabled, reason } = req.body;

      const result = await moderatorService.updateGlobalCommissionPolicy(
        adminId,
        adminEmail,
        parseFloat(defaultRate),
        reason,
        normalUserRate !== undefined ? parseFloat(normalUserRate) : undefined,
        referralEnabled !== undefined ? Boolean(referralEnabled) : undefined
      );

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/referrals/relationships
   */
  async listReferralRelationships(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await moderatorService.listReferralRelationships({
        search: req.query.search as string,
        referrerRole: req.query.referrerRole as string,
        page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined
      });
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/referrals/fraud-alerts
   */
  async getFraudAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await moderatorService.getReferralFraudAlerts();
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  // =========================================================================
  // MODERATOR SELF DASHBOARD ENDPOINTS (MODERATOR ONLY)
  // =========================================================================

  /**
   * GET /api/v1/moderator/dashboard
   */
  async getModeratorSelfDashboard(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const moderatorUserId = (req as any).user.id;
      const origin = env.PUBLIC_FRONTEND_URL;
      const result = await moderatorService.getModeratorSelfDashboard(moderatorUserId, origin);
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/moderator/commissions
   */
  async getModeratorSelfCommissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const moderatorUserId = (req as any).user.id;
      const { status, page, limit } = req.query;
      const result = await moderatorService.getModeratorSelfCommissions(moderatorUserId, {
        status: status as string,
        page: page ? parseInt(page as string, 10) : undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined
      });
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/moderator/referred-users
   */
  async getModeratorSelfReferredUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const moderatorUserId = (req as any).user.id;
      const { page, limit } = req.query;
      const result = await moderatorService.getModeratorSelfReferredUsers(
        moderatorUserId,
        page ? parseInt(page as string, 10) : 1,
        limit ? parseInt(limit as string, 10) : 20
      );
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }
}

export const moderatorController = new ModeratorController();
