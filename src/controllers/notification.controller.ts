import { Request, Response, NextFunction } from 'express';
import { notificationService } from '../services/notification.service';
import { ApiError } from '../utils/apiError';

export class NotificationController {
  /**
   * GET /api/v1/notifications
   */
  async getUserNotifications(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = (req as any).user;
      if (!user) {
        throw ApiError.unauthorized('Authentication required');
      }

      const { page, limit, unreadOnly } = req.query;
      const data = await notificationService.getUserNotifications(user.id, {
        page: page ? parseInt(page as string, 10) : undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        unreadOnly: unreadOnly === 'true'
      });

      res.status(200).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/notifications/:id/read
   */
  async markAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = (req as any).user;
      if (!user) {
        throw ApiError.unauthorized('Authentication required');
      }

      const notif = await notificationService.markAsRead(user.id, req.params.id as string);
      res.status(200).json({ success: true, data: notif });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/notifications/read-all
   */
  async markAllAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = (req as any).user;
      if (!user) {
        throw ApiError.unauthorized('Authentication required');
      }

      const result = await notificationService.markAllAsRead(user.id);
      res.status(200).json({ success: true, data: result, message: 'All notifications marked as read' });
    } catch (err) {
      next(err);
    }
  }
}

export const notificationController = new NotificationController();
