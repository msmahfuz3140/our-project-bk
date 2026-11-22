import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { supportTicketService } from '../services/supportTicket.service';
import { securityService } from '../services/security.service';
import { toolAdminService } from '../services/toolAdmin.service';
import { aiAssistantService } from '../services/aiAssistant.service';
import { NotificationModel } from '../models/Notification';
import { EmailNotificationModel } from '../models/EmailNotification';
import { UserModel } from '../models/User';
import { SubscriptionModel } from '../models/Subscription';
import { AuditLogModel } from '../models/AuditLog';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import { transactionalEmailService } from '../services/transactionalEmail.service';
import mongoose from 'mongoose';

export class AdminExtendedController {
  // --- Support Tickets ---
  async getTickets(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { status, priority, category, search, page, limit } = req.query;
      const result = await supportTicketService.getTickets({
        status: status as string,
        priority: priority as string,
        category: category as string,
        search: search as string,
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 20
      });
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async getTicketDetails(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawId = req.params.ticketId;
      const ticketId = Array.isArray(rawId) ? rawId[0] : (rawId || '');
      const ticket = await supportTicketService.getTicketById(ticketId);
      res.status(200).json({ success: true, data: ticket });
    } catch (error) {
      next(error);
    }
  }

  async replyTicket(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawId = req.params.ticketId;
      const ticketId = Array.isArray(rawId) ? rawId[0] : (rawId || '');
      const { message, isInternalNote } = req.body;

      if (!message || message.trim().length < 2) {
        throw ApiError.badRequest('Reply message is required.');
      }

      const updated = await supportTicketService.addReply({
        ticketId,
        senderId: req.user!.id,
        senderEmail: req.user!.email || 'admin@rouletteaccuracy.com',
        senderRole: req.user!.role,
        message,
        isInternalNote: !!isInternalNote
      });

      res.status(200).json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }

  async updateTicketStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawId = req.params.ticketId;
      const ticketId = Array.isArray(rawId) ? rawId[0] : (rawId || '');
      const { status, reason } = req.body;

      if (!['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].includes(status)) {
        throw ApiError.badRequest('Invalid ticket status');
      }

      const updated = await supportTicketService.updateStatus(
        ticketId,
        status,
        req.user!.email || 'admin@rouletteaccuracy.com',
        req.user!.id,
        reason
      );

      res.status(200).json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }

  async assignTicket(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawId = req.params.ticketId;
      const ticketId = Array.isArray(rawId) ? rawId[0] : (rawId || '');
      const { adminId } = req.body;

      if (!adminId) {
        throw ApiError.badRequest('adminId is required');
      }

      const updated = await supportTicketService.assignAdmin(
        ticketId,
        adminId,
        req.user!.email || 'admin@rouletteaccuracy.com'
      );

      res.status(200).json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }

  // --- Security Operations Center ---
  async getSecurityOverview(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const overview = await securityService.getSecurityOverview();
      res.status(200).json({ success: true, data: overview });
    } catch (error) {
      next(error);
    }
  }

  async getSecurityAlerts(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const alerts = await securityService.getSecurityAlerts();
      res.status(200).json({ success: true, data: alerts });
    } catch (error) {
      next(error);
    }
  }

  async revokeUserSessions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawId = req.params.userId;
      const userId = Array.isArray(rawId) ? rawId[0] : (rawId || '');
      const { reason } = req.body;

      if (!reason || reason.trim().length < 3) {
        throw ApiError.badRequest('A mandatory reason is required to revoke user sessions.');
      }

      const result = await securityService.revokeUserSessions(
        req.user!.id,
        req.user!.email || 'admin@rouletteaccuracy.com',
        userId,
        reason
      );

      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  // --- Tool Telemetry ---
  async getToolTelemetry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const telemetry = await toolAdminService.getToolTelemetry();
      res.status(200).json({ success: true, data: telemetry });
    } catch (error) {
      next(error);
    }
  }

  // --- AI Admin Assistant ---
  async queryAiAssistant(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { query } = req.body;
      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        throw ApiError.badRequest('Query text is required.');
      }

      const result = await aiAssistantService.processQuery(query);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  // --- Notifications Management & Telemetry ---
  async getNotificationMetrics(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const [totalCount, unreadCount, recentNotifications] = await Promise.all([
        NotificationModel.countDocuments(),
        NotificationModel.countDocuments({ isRead: false }),
        NotificationModel.find().sort({ createdAt: -1 }).limit(30)
      ]);

      res.status(200).json({
        success: true,
        data: {
          totalCount,
          unreadCount,
          readRatePercent: totalCount > 0 ? Math.round(((totalCount - unreadCount) / totalCount) * 100) : 100,
          recentNotifications
        }
      });
    } catch (error) {
      next(error);
    }
  }

  async sendTargetedNotification(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { title, message, targetType, targetUserId, link } = req.body;

      if (!title || !message) {
        throw ApiError.badRequest('Title and message are required.');
      }

      let recipientUserIds: any[] = [];

      if (targetType === 'SINGLE_USER' && targetUserId) {
        recipientUserIds = [targetUserId];
      } else if (targetType === 'PREMIUM_ONLY') {
        const activeSubs = await SubscriptionModel.find({
          status: 'ACTIVE',
          isRevoked: { $ne: true },
          endDate: { $gt: new Date() }
        }).select('userId');
        recipientUserIds = activeSubs.map(s => s.userId);
      } else if (targetType === 'EXPIRING_SOON') {
        const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const expiringSubs = await SubscriptionModel.find({
          status: 'ACTIVE',
          isRevoked: { $ne: true },
          endDate: { $gte: new Date(), $lte: in7Days }
        }).select('userId');
        recipientUserIds = expiringSubs.map(s => s.userId);
      } else {
        const allUsers = await UserModel.find({ isDeleted: { $ne: true } }).select('_id');
        recipientUserIds = allUsers.map(u => u._id);
      }

      const docs = recipientUserIds.map(uid => ({
        userId: uid,
        type: 'PLATFORM_ANNOUNCEMENT',
        title: title.trim(),
        message: message.trim(),
        link: link || undefined,
        isRead: false,
        createdAt: new Date(),
        updatedAt: new Date()
      }));

      if (docs.length > 0) {
        await NotificationModel.insertMany(docs);
      }

      logger.info(`Targeted announcement sent to ${docs.length} recipients by ${req.user?.email}`);

      res.status(200).json({
        success: true,
        data: {
          recipientsCount: docs.length,
          deliveredAt: new Date().toISOString()
        }
      });
    } catch (error) {
      next(error);
    }
  }

  // --- Transactional Email Delivery Monitoring ---
  async getEmailNotificationMetrics(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const metrics = await transactionalEmailService.getMetrics();
      res.status(200).json({ success: true, data: metrics });
    } catch (error) {
      next(error);
    }
  }

  async listEmailNotifications(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { status, templateKey, search, page, limit } = req.query;
      const result = await transactionalEmailService.listForAdmin({
        status: status as string,
        templateKey: templateKey as string,
        search: search as string,
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 25
      });
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  async retryEmailNotification(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await transactionalEmailService.retryById(id, {
        id: req.user!.id,
        email: req.user?.email || 'admin'
      });

      await AuditLogModel.create({
        action: 'EMAIL_NOTIFICATION_RETRY',
        adminId: new mongoose.Types.ObjectId(req.user!.id),
        adminEmail: req.user?.email || 'admin',
        targetResourceId: id,
        resourceType: 'EmailNotification',
        reason: 'Administrator requested a transactional email retry',
        newValue: { status: result.status, attempts: result.attempts }
      }).catch(() => null);

      res.status(200).json({
        success: true,
        message:
          result.status === 'SENT'
            ? 'Email delivered successfully'
            : result.status === 'PENDING'
              ? 'Email queued for retry'
              : 'Email could not be delivered',
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async getEmailNotificationDetails(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw ApiError.badRequest('Invalid email notification id');
      }
      const record = await EmailNotificationModel.findById(id)
        .select('-htmlBody -textBody -metadata')
        .lean();
      if (!record) throw ApiError.notFound('Email notification was not found');
      res.status(200).json({ success: true, data: record });
    } catch (error) {
      next(error);
    }
  }
}

export const adminExtendedController = new AdminExtendedController();
