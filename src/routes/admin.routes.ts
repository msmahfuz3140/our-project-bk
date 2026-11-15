import { Router } from 'express';
import { adminController } from '../controllers/admin.controller';
import { moderatorController } from '../controllers/moderator.controller';
import { adminSettingsController } from '../controllers/adminSettings.controller';
import { financialController } from '../controllers/financial.controller';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { UserRole } from '../shared/roles';

const router = Router();

// Enforce strict server-side authorization for ALL admin endpoints
router.use(requireAuth);
router.use(requireRole(UserRole.SUPER_ADMIN));

// Dashboard Metrics
router.get('/dashboard-metrics', (req, res, next) =>
  adminController.getDashboardMetrics(req, res, next)
);

// User Management
router.get('/users', (req, res, next) =>
  adminController.getUsers(req, res, next)
);

router.get('/users/:userId', (req, res, next) =>
  adminController.getUserDetails(req, res, next)
);

router.patch('/users/:userId/profile', (req, res, next) =>
  adminController.updateUserProfile(req, res, next)
);

router.put('/users/:userId/profile', (req, res, next) =>
  adminController.updateUserProfile(req, res, next)
);

router.post('/users/:userId/status', (req, res, next) =>
  adminController.changeUserStatus(req, res, next)
);

router.delete('/users/:userId', (req, res, next) =>
  adminController.softDeleteUser(req, res, next)
);

// Create Staff User (Super Admin or Moderator) directly into DB
router.post('/users/create-staff', (req, res, next) =>
  adminController.createStaffUser(req, res, next)
);

router.post('/users', (req, res, next) =>
  adminController.createStaffUser(req, res, next)
);

// Moderator Management
router.post('/moderators', (req, res, next) =>
  moderatorController.createModerator(req, res, next)
);

router.get('/moderators', (req, res, next) =>
  moderatorController.listModerators(req, res, next)
);

router.get('/moderators/:moderatorId', (req, res, next) =>
  moderatorController.getModeratorDetails(req, res, next)
);

router.patch('/moderators/:moderatorId/status', (req, res, next) =>
  moderatorController.updateModeratorStatus(req, res, next)
);

router.post('/moderators/:moderatorId/reset-password', (req, res, next) =>
  moderatorController.resetModeratorPassword(req, res, next)
);

router.patch('/moderators/:moderatorId/commission-rate', (req, res, next) =>
  moderatorController.updateModeratorCommissionRate(req, res, next)
);

// Referral & Commission Management
router.get('/referrals/overview', (req, res, next) =>
  moderatorController.getReferralOverview(req, res, next)
);

router.get('/referrals/commissions', (req, res, next) =>
  moderatorController.listCommissions(req, res, next)
);

router.post('/referrals/commissions/:commissionId/status', (req, res, next) =>
  moderatorController.updateCommissionStatus(req, res, next)
);

router.patch('/referrals/commissions/:commissionId/adjust', (req, res, next) =>
  moderatorController.adjustCommission(req, res, next)
);

router.get('/referrals/export', (req, res, next) =>
  moderatorController.exportCommissionsCsv(req, res, next)
);

router.get('/referrals/policy', (req, res, next) =>
  moderatorController.getCommissionPolicy(req, res, next)
);

router.post('/referrals/policy', (req, res, next) =>
  moderatorController.updateGlobalCommissionPolicy(req, res, next)
);

router.get('/referrals/fraud-alerts', (req, res, next) =>
  moderatorController.getFraudAlerts(req, res, next)
);

// Audit Logs
router.get('/audit-logs', (req, res, next) =>
  adminController.getAuditLogs(req, res, next)
);

// Dual Approval Governance
router.get('/dual-approvals', (req, res, next) =>
  adminController.listDualApprovals(req, res, next)
);

router.post('/dual-approvals/request', (req, res, next) =>
  adminController.requestDualApproval(req, res, next)
);

router.post('/dual-approvals/:requestId/approve', (req, res, next) =>
  adminController.approveDualApproval(req, res, next)
);

router.post('/dual-approvals/:requestId/reject', (req, res, next) =>
  adminController.rejectDualApproval(req, res, next)
);

// ─── Financial Accounting & Payouts ────────────────────────────────
router.get('/financial/summary', (req, res, next) =>
  financialController.getSummary(req as any, res, next)
);

router.get('/financial/transactions', (req, res, next) =>
  financialController.listTransactions(req as any, res, next)
);

router.post('/financial/payouts', (req, res, next) =>
  financialController.createPayout(req as any, res, next)
);

// Subscription Plans Management
router.get('/plans', (req, res, next) =>
  adminSettingsController.getAdminPlans(req, res, next)
);

router.post('/plans', (req, res, next) =>
  adminSettingsController.createAdminPlan(req, res, next)
);

router.patch('/plans/:planId', (req, res, next) =>
  adminSettingsController.updateAdminPlan(req, res, next)
);

router.delete('/plans/:planId', (req, res, next) =>
  adminSettingsController.deleteAdminPlan(req, res, next)
);

// Tool Management & Maintenance Mode
router.get('/tool/settings', (req, res, next) =>
  adminSettingsController.getAdminToolSettings(req, res, next)
);

router.patch('/tool/settings', (req, res, next) =>
  adminSettingsController.updateToolSettings(req, res, next)
);

// Dedicated API Settings actions (secure server-side connection testing)
router.post('/tool/ds-test', (req, res, next) =>
  adminSettingsController.testDsConnection(req, res, next)
);

router.get('/tool/ds-diagnostics', (req, res, next) =>
  adminSettingsController.getDsDiagnostics(req, res, next)
);

// Website CMS & Branding Settings
router.get('/settings', (req, res, next) =>
  adminSettingsController.getAdminWebsiteSettings(req, res, next)
);

router.put('/settings', (req, res, next) =>
  adminSettingsController.updateWebsiteSettings(req, res, next)
);

// Platform Reports & Safe CSV Exports
router.get('/reports/summary', (req, res, next) =>
  adminSettingsController.getReportsSummary(req, res, next)
);

router.get('/reports/export', (req, res, next) =>
  adminSettingsController.exportReportCsv(req, res, next)
);

router.get('/audit-logs/export', (req, res, next) => {
  req.query.reportType = 'ACTIVITY';
  adminSettingsController.exportReportCsv(req, res, next);
});

// Broadcast In-App Announcements
router.post('/notifications/broadcast', (req, res, next) =>
  adminSettingsController.broadcastAnnouncement(req, res, next)
);

// --- Extended Admin Features ---
import { adminExtendedController } from '../controllers/adminExtended.controller';

// Support Tickets
router.get('/tickets', (req, res, next) => adminExtendedController.getTickets(req, res, next));
router.get('/tickets/:ticketId', (req, res, next) => adminExtendedController.getTicketDetails(req, res, next));
router.post('/tickets/:ticketId/reply', (req, res, next) => adminExtendedController.replyTicket(req, res, next));
router.patch('/tickets/:ticketId/status', (req, res, next) => adminExtendedController.updateTicketStatus(req, res, next));
router.patch('/tickets/:ticketId/assign', (req, res, next) => adminExtendedController.assignTicket(req, res, next));

// Security Operations Center
router.get('/security/overview', (req, res, next) => adminExtendedController.getSecurityOverview(req, res, next));
router.get('/security/alerts', (req, res, next) => adminExtendedController.getSecurityAlerts(req, res, next));
router.post('/security/revoke-sessions/:userId', (req, res, next) => adminExtendedController.revokeUserSessions(req, res, next));

// Roulette Tool Management & Telemetry
router.get('/tool/telemetry', (req, res, next) => adminExtendedController.getToolTelemetry(req, res, next));

// DS API Configuration (admin view with masked key — never plaintext)
router.get('/tool/ds-config', async (req, res, next) => {
  try {
    const { toolSettingsService } = require('../services/toolSettings.service');
    const view = await toolSettingsService.getAdminToolSettings();
    res.json({
      success: true,
      data: {
        dsApiKey: view.dsApiKeyMasked,
        dsApiKeyConfigured: view.dsApiKeyConfigured,
        dsApiUrl: view.dsApiUrl || '',
        configured: !!(view.dsApiKeyConfigured && view.dsApiUrl),
        lastTestAt: view.dsLastTestAt,
        lastTestSuccess: view.dsLastTestSuccess,
        lastTestMessage: view.dsLastTestMessage,
        lastRequestAt: view.dsLastRequestAt,
        lastSuccessAt: view.dsLastSuccessAt,
        lastErrorAt: view.dsLastErrorAt,
        lastError: view.dsLastError,
        lastStatusCode: view.dsLastStatusCode,
        lastRequestId: view.dsLastRequestId
      }
    });
  } catch (err) {
    next(err);
  }
});

// AI Admin Assistant (Strict Read-Only)
router.post('/ai-assistant/query', (req, res, next) => adminExtendedController.queryAiAssistant(req, res, next));

// Notifications Telemetry & Targeted Delivery
router.get('/notifications/metrics', (req, res, next) => adminExtendedController.getNotificationMetrics(req, res, next));
router.post('/notifications/targeted', (req, res, next) => adminExtendedController.sendTargetedNotification(req, res, next));

export const adminRoutes = router;
