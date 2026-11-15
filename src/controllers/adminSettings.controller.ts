import { Request, Response, NextFunction } from 'express';
import { toolSettingsService } from '../services/toolSettings.service';
import { websiteSettingsService } from '../services/websiteSettings.service';
import { subscriptionService } from '../services/subscription.service';
import { reportsService } from '../services/reports.service';
import { notificationService } from '../services/notification.service';
import { dsProxyService } from '../services/dsProxy.service';
import { ApiError } from '../utils/apiError';

export class AdminSettingsController {
  /**
   * GET /api/v1/tool/status
   */
  async getPublicToolStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await toolSettingsService.getPublicToolStatus();
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/tool/settings
   */
  async getAdminToolSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await toolSettingsService.getAdminToolSettings();
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/tool/settings
   */
  async updateToolSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const admin = (req as any).user;
      const {
        isToolEnabled,
        maintenanceMode,
        publicStatusMessage,
        toolVersion,
        toolAccessPolicy,
        premiumRequirements,
        dsApiKey,
        dsApiUrl,
        clearDsApiKey,
        reason
      } = req.body;

      const data = await toolSettingsService.updateToolSettings(
        admin.id,
        admin.email,
        {
          isToolEnabled,
          maintenanceMode,
          publicStatusMessage,
          toolVersion,
          toolAccessPolicy,
          premiumRequirements,
          dsApiKey,
          dsApiUrl,
          clearDsApiKey
        },
        reason
      );

      // A changed URL/key must not serve a stale signed response from the
      // short-lived proxy cache.
      await dsProxyService.invalidateCache();

      res.status(200).json({ success: true, data, message: 'Tool settings updated successfully' });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/tool/ds-test
   * Live connection test. Accepts optional unsaved form values so the admin can
   * validate credentials before saving. The key is never returned.
   */
  async testDsConnection(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { dsApiKey, dsApiUrl } = req.body || {};
      const result = await dsProxyService.testConnection(
        {
          apiKey:
            typeof dsApiKey === 'string' &&
            dsApiKey.trim() &&
            !dsApiKey.includes('•') &&
            !dsApiKey.includes('***')
              ? dsApiKey.trim()
              : undefined,
          baseUrl:
            typeof dsApiUrl === 'string' && dsApiUrl.trim()
              ? dsApiUrl.trim()
              : undefined
        },
        req.headers.origin
      );

      // The test itself ran successfully even when the provider check failed;
      // the outcome is carried in data.success so the UI can render diagnostics.
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/tool/ds-diagnostics
   */
  async getDsDiagnostics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await toolSettingsService.getDsDiagnostics();
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/settings/public
   */
  async getPublicWebsiteSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await websiteSettingsService.getPublicSettings();
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/settings
   */
  async getAdminWebsiteSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await websiteSettingsService.getAdminSettings();
      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PUT /api/v1/admin/settings
   */
  async updateWebsiteSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const admin = (req as any).user;
      const { settings, reason } = req.body;

      if (!settings) {
        throw ApiError.badRequest('Settings payload is required');
      }

      const data = await websiteSettingsService.updateSettings(
        admin.id,
        admin.email,
        settings,
        reason || 'Admin updated website configurations'
      );

      res.status(200).json({ success: true, data, message: 'Website settings updated successfully' });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/plans
   */
  async getAdminPlans(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const plans = await subscriptionService.getAllPlans();
      res.status(200).json({ success: true, data: plans });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/plans
   */
  async createAdminPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const admin = (req as any).user;
      const created = await subscriptionService.createPlan(req.body, admin.id);
      res.status(201).json({ success: true, data: created, message: 'Plan created successfully' });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/plans/:planId
   */
  async updateAdminPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const admin = (req as any).user;
      const planId = req.params.planId as string;
      const input = req.body;

      const updated = await subscriptionService.updatePlan(planId, input, admin.id);
      res.status(200).json({ success: true, data: updated, message: 'Plan updated successfully' });
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/v1/admin/plans/:planId
   */
  async deleteAdminPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const admin = (req as any).user;
      const planId = req.params.planId as string;
      const result = await subscriptionService.deletePlan(planId, admin.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/summary
   */
  async getReportsSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { startDate, endDate, planId, moderatorId, status } = req.query;
      const summary = await reportsService.getSummaryReport({
        startDate: startDate as string,
        endDate: endDate as string,
        planId: planId as string,
        moderatorId: moderatorId as string,
        status: status as string
      });

      res.status(200).json({ success: true, data: summary });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/export
   */
  async exportReportCsv(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { reportType, type: queryType, startDate, endDate, planId, moderatorId, status } = req.query;
      const validTypes = ['REGISTRATIONS', 'SUBSCRIPTIONS', 'SALES', 'MODERATORS', 'ACTIVITY'];
      const rawType = (reportType || queryType) as string;
      const type = rawType?.toUpperCase();

      if (!type || !validTypes.includes(type)) {
        throw ApiError.badRequest(`Invalid reportType. Supported: ${validTypes.join(', ')}`);
      }

      const csv = await reportsService.exportReportCsv(type as any, {
        startDate: startDate as string,
        endDate: endDate as string,
        planId: planId as string,
        moderatorId: moderatorId as string,
        status: status as string
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="report_${type.toLowerCase()}_${Date.now()}.csv"`);
      res.status(200).send(csv);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/notifications/broadcast
   */
  async broadcastAnnouncement(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const admin = (req as any).user;
      const { title, message, targetRole } = req.body;

      const result = await notificationService.broadcastAnnouncement(
        admin.id,
        admin.email,
        title,
        message,
        targetRole
      );

      res.status(200).json({ success: true, data: result, message: 'Broadcast announcement sent successfully' });
    } catch (err) {
      next(err);
    }
  }
}

export const adminSettingsController = new AdminSettingsController();
