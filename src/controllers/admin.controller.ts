import { Response, NextFunction } from 'express';
import { adminService } from '../services/admin.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { ApiError } from '../utils/apiError';

export class AdminController {
  async getDashboardMetrics(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const metrics = await adminService.getDashboardMetrics();
      res.status(200).json({
        success: true,
        data: metrics
      });
    } catch (error) {
      next(error);
    }
  }

  async getUsers(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { search, role, accountStatus, status, subscriptionStatus, hasActiveSubscription, sub, page, limit } = req.query;

      const cleanString = (val: any): string | undefined => {
        if (!val || typeof val !== 'string') return undefined;
        const trimmed = val.trim();
        return (trimmed === '' || trimmed === 'undefined' || trimmed === 'null') ? undefined : trimmed;
      };

      const resolvedAccountStatus = cleanString(accountStatus) || cleanString(status);
      const resolvedRole = cleanString(role);
      const resolvedSearch = cleanString(search);

      let resolvedSubStatus: string | undefined = undefined;
      const rawSub = cleanString(subscriptionStatus) || cleanString(hasActiveSubscription) || cleanString(sub);
      if (rawSub) {
        if (rawSub === 'ACTIVE' || rawSub === 'true' || rawSub === 'active') {
          resolvedSubStatus = 'ACTIVE';
        } else if (rawSub === 'INACTIVE' || rawSub === 'false' || rawSub === 'EXPIRED' || rawSub === 'expired' || rawSub === 'none') {
          resolvedSubStatus = 'INACTIVE';
        } else {
          resolvedSubStatus = rawSub.toUpperCase();
        }
      }

      const result = await adminService.getUsers({
        search: resolvedSearch,
        role: resolvedRole,
        accountStatus: resolvedAccountStatus,
        subscriptionStatus: resolvedSubStatus,
        page: page && !isNaN(Number(page)) ? Math.max(1, Number(page)) : 1,
        limit: limit && !isNaN(Number(limit)) ? Math.min(100, Math.max(1, Number(limit))) : 20
      });

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async getUserDetails(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId } = req.params;
      const result = await adminService.getUserDetails(userId as string);
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async updateUserProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId } = req.params;
      const {
        name,
        phone,
        password,
        confirmPassword,
        mustChangePassword,
        isEmailVerified,
        isPhoneVerified,
        role,
        moderatorCommissionRate,
        moderatorNotes,
        isActive,
        referralCommissionRate,
        referralCommissionType,
        referralEligible,
        reason
      } = req.body;

      if (password !== undefined && password !== null && String(password).length > 0) {
        if (String(password).length < 8) {
          throw ApiError.badRequest('Password must be at least 8 characters long');
        }
        if (confirmPassword !== undefined && String(password) !== String(confirmPassword)) {
          throw ApiError.badRequest('Password and confirmation password do not match');
        }
      }

      const auditReason = (reason && reason.trim().length >= 3) ? reason.trim() : 'Administrative profile or password modification';

      const updated = await adminService.updateUserProfile(
        req.user!.id,
        req.user?.email || 'admin@rouletteaccuracy.com',
        userId as string,
        {
          name,
          phone,
          password,
          mustChangePassword: mustChangePassword === true,
          isEmailVerified,
          isPhoneVerified,
          role,
          moderatorCommissionRate,
          moderatorNotes,
          isActive,
          referralCommissionRate,
          referralCommissionType,
          referralEligible
        },
        auditReason
      );

      res.status(200).json({
        success: true,
        message: updated.passwordChanged
          ? 'Password updated successfully. The user must use the new password on their next login.'
          : 'User profile updated successfully',
        data: updated
      });
    } catch (error) {
      next(error);
    }
  }

  async changeUserStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId } = req.params;
      const { action, reason, suspendedUntil } = req.body;

      if (!action || !['BLOCK', 'UNBLOCK', 'SUSPEND'].includes(action)) {
        throw ApiError.badRequest('Action must be one of BLOCK, UNBLOCK, or SUSPEND');
      }

      if (!reason || reason.trim().length < 3) {
        throw ApiError.badRequest('A mandatory reason is required for administrative status changes');
      }

      const parsedDate = suspendedUntil ? new Date(suspendedUntil) : undefined;
      const result = await adminService.changeUserStatus(
        req.user!.id,
        req.user?.email || 'admin@rouletteaccuracy.com',
        userId as string,
        action,
        reason,
        parsedDate
      );

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async softDeleteUser(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId } = req.params;
      const { reason } = req.body;

      if (!reason || reason.trim().length < 3) {
        throw ApiError.badRequest('A detailed reason is required for account deletion');
      }

      const result = await adminService.softDeleteUser(
        req.user!.id,
        req.user?.email || 'admin@rouletteaccuracy.com',
        userId as string,
        reason
      );

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async getAuditLogs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { action, adminEmail, targetUserEmail, startDate, endDate, page, limit } = req.query;
      const result = await adminService.getAuditLogs({
        action: action as string,
        adminEmail: adminEmail as string,
        targetUserEmail: targetUserEmail as string,
        startDate: startDate as string,
        endDate: endDate as string,
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 25
      });

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  // --- Dual Approval Governance ---

  async listDualApprovals(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { status } = req.query;
      const result = await adminService.listDualApprovalRequests(status as string);
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async requestDualApproval(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { action, payload, reason, targetUserId } = req.body;
      if (!action || !payload || !reason) {
        throw ApiError.badRequest('Action, payload, and reason are required for dual approval request');
      }

      const result = await adminService.requestDualApproval(
        req.user!.id,
        req.user?.email || 'admin@rouletteaccuracy.com',
        action,
        payload,
        reason,
        targetUserId
      );

      res.status(201).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async approveDualApproval(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { requestId } = req.params;
      const result = await adminService.approveDualApproval(
        req.user!.id,
        req.user?.email || 'admin@rouletteaccuracy.com',
        requestId as string
      );

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async rejectDualApproval(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { requestId } = req.params;
      const { reason } = req.body;
      if (!reason) {
        throw ApiError.badRequest('Rejection reason is required');
      }

      const result = await adminService.rejectDualApproval(
        req.user!.id,
        req.user?.email || 'admin@rouletteaccuracy.com',
        requestId as string,
        reason
      );

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async createStaffUser(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const adminId = req.user!.id;
      const adminEmail = req.user?.email || 'admin@rouletteaccuracy.com';
      const result = await adminService.createStaffUser(adminId, adminEmail, req.body);
      res.status(201).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
}

export const adminController = new AdminController();
