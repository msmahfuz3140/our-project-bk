import { Request, Response, NextFunction } from 'express';
import { subscriptionService } from '../services/subscription.service';
import { subscriptionAccessService } from '../services/subscriptionAccess.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { ApiError } from '../utils/apiError';
import {
  GrantManualSubscriptionSchema,
  ExtendSubscriptionSchema,
  RevokeSubscriptionSchema,
  UnlockToolSchema
} from '../shared/subscriptions';

export class SubscriptionController {
  async listAllSubscriptions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { status, planId, page, limit, search } = req.query;
      const result = await subscriptionAccessService.listAllSubscriptions({
        status: status as any,
        planId: planId as string,
        search: search as string,
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

  async getPlans(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const plans = await subscriptionService.getPublicPlans();
      res.status(200).json({
        success: true,
        data: plans
      });
    } catch (error) {
      next(error);
    }
  }

  async getAllPlans(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const plans = await subscriptionService.getAllPlans();
      res.status(200).json({
        success: true,
        data: plans
      });
    } catch (error) {
      next(error);
    }
  }

  async createPlan(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const created = await subscriptionService.createPlan(req.body, req.user?.id);
      res.status(201).json({
        success: true,
        data: created
      });
    } catch (error) {
      next(error);
    }
  }

  async updatePlan(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { planId } = req.params;
      const updated = await subscriptionService.updatePlan(planId as string, req.body, req.user?.id);
      res.status(200).json({
        success: true,
        data: updated
      });
    } catch (error) {
      next(error);
    }
  }

  async deletePlan(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { planId } = req.params;
      const result = await subscriptionService.deletePlan(planId as string, req.user?.id);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  async getMySubscription(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const active = await subscriptionService.getUserActiveSubscription(req.user!.id);
      const history = await subscriptionService.getUserSubscriptions(req.user!.id);

      res.status(200).json({
        success: true,
        data: {
          active,
          history
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Real-time server-side subscription validation check
   */
  async getAccessStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = await subscriptionAccessService.checkAccess(req.user!.id);
      res.status(200).json({
        success: true,
        data: status
      });
    } catch (error) {
      next(error);
    }
  }

  // --- Admin Controls ---

  async grantManual(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = GrantManualSubscriptionSchema.parse(req.body);
      const result = await subscriptionAccessService.grantManualSubscription(req.user!.id, validated);
      res.status(201).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async extend(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = ExtendSubscriptionSchema.parse(req.body);
      const result = await subscriptionAccessService.extendSubscription(req.user!.id, validated);
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async revoke(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = RevokeSubscriptionSchema.parse(req.body);
      const result = await subscriptionAccessService.revokeSubscription(req.user!.id, validated);
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async unban(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { subscriptionId, reason, extensionDays } = req.body;
      if (!subscriptionId) {
        throw ApiError.badRequest('subscriptionId is required to unban');
      }
      const result = await subscriptionAccessService.unbanSubscription(req.user!.id, {
        subscriptionId,
        reason,
        extensionDays
      });
      res.status(200).json({
        success: true,
        data: result,
        message: 'Subscription unbanned and tool access restored successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  async banUserTool(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId, reason } = req.body;
      if (!userId) {
        throw ApiError.badRequest('userId is required');
      }
      const result = await subscriptionAccessService.banUserToolAccess(req.user!.id, userId, reason);
      res.status(200).json({
        success: true,
        data: result,
        message: 'User tool access shut off and moved to Banned Subscriptions'
      });
    } catch (error) {
      next(error);
    }
  }

  async unbanUserTool(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId, reason } = req.body;
      if (!userId) {
        throw ApiError.badRequest('userId is required');
      }
      const result = await subscriptionAccessService.unbanUserToolAccess(req.user!.id, userId, reason);
      res.status(200).json({
        success: true,
        data: result,
        message: 'User tool access unbanned and restored successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  async unlockTool(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = UnlockToolSchema.parse(req.body);
      const result = await subscriptionAccessService.unlockToolWithSecretCode(req.user!.id, validated.secretCode);
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async approveSubscription(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { subscriptionId } = req.params;
      const result = await subscriptionAccessService.approveSubscriptionAndSendSecretCode(
        req.user!.id,
        req.user?.email || 'admin@rouletteaccuracy.com',
        subscriptionId as string
      );
      res.status(200).json({
        success: true,
        message: 'Subscription approved and secret code dispatched to customer email',
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async manuallyUnlockSubscription(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { subscriptionId } = req.params;
      const result = await subscriptionAccessService.manuallyUnlockToolForSubscription(
        req.user!.id,
        req.user?.email || 'admin@rouletteaccuracy.com',
        subscriptionId as string
      );
      res.status(200).json({
        success: true,
        message: 'Tool access manually unlocked for this subscription',
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
}

export const subscriptionController = new SubscriptionController();
