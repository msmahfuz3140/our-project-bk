import mongoose from 'mongoose';
import { NotificationModel, NotificationType, INotification } from '../models/Notification';
import { UserModel } from '../models/User';
import { AuditLogModel } from '../models/AuditLog';
import { ApiError } from '../utils/apiError';
import { UserRole } from '../shared/roles';
import { logger } from '../utils/logger';

export class NotificationService {
  /**
   * Create an in-app notification for a user
   */
  async createNotification(
    userId: string | mongoose.Types.ObjectId,
    type: NotificationType,
    title: string,
    message: string,
    link?: string,
    metadata?: Record<string, any>
  ): Promise<INotification> {
    try {
      const notif = await NotificationModel.create({
        userId: new mongoose.Types.ObjectId(userId.toString()),
        type,
        title,
        message,
        link,
        metadata
      });
      return notif;
    } catch (err) {
      logger.error('Failed to create notification', { userId, type, error: err });
      throw err;
    }
  }

  /**
   * Fetch paginated notifications for authenticated user
   */
  async getUserNotifications(
    userId: string,
    options: { page?: number; limit?: number; unreadOnly?: boolean } = {}
  ): Promise<{
    notifications: INotification[];
    total: number;
    unreadCount: number;
    page: number;
    totalPages: number;
  }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(50, Math.max(1, options.limit || 15));
    const skip = (page - 1) * limit;

    const query: Record<string, any> = {
      userId: new mongoose.Types.ObjectId(userId)
    };

    if (options.unreadOnly) {
      query.isRead = false;
    }

    const [notifications, total, unreadCount] = await Promise.all([
      NotificationModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      NotificationModel.countDocuments(query),
      NotificationModel.countDocuments({
        userId: new mongoose.Types.ObjectId(userId),
        isRead: false
      })
    ]);

    return {
      notifications,
      total,
      unreadCount,
      page,
      totalPages: Math.ceil(total / limit) || 1
    };
  }

  /**
   * Mark a single notification as read
   */
  async markAsRead(userId: string, notificationId: string): Promise<INotification> {
    const notif = await NotificationModel.findOne({
      _id: notificationId,
      userId: new mongoose.Types.ObjectId(userId)
    });

    if (!notif) {
      throw ApiError.notFound('Notification not found');
    }

    if (!notif.isRead) {
      notif.isRead = true;
      notif.readAt = new Date();
      await notif.save();
    }

    return notif;
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<{ modifiedCount: number }> {
    const res = await NotificationModel.updateMany(
      {
        userId: new mongoose.Types.ObjectId(userId),
        isRead: false
      },
      {
        $set: {
          isRead: true,
          readAt: new Date()
        }
      }
    );

    return { modifiedCount: res.modifiedCount };
  }

  /**
   * Broadcast announcement from Main Admin to platform users
   */
  async broadcastAnnouncement(
    adminId: string,
    adminEmail: string,
    title: string,
    message: string,
    targetRole?: UserRole
  ): Promise<{ recipientCount: number }> {
    const admin = await UserModel.findById(adminId);
    if (!admin || admin.role !== UserRole.SUPER_ADMIN) {
      throw ApiError.forbidden('Only authorized Main Admins can broadcast announcements');
    }

    if (!title || title.trim() === '') {
      throw ApiError.badRequest('Announcement title is required');
    }
    if (!message || message.trim() === '') {
      throw ApiError.badRequest('Announcement message is required');
    }

    const query: Record<string, any> = { isDeleted: false };
    if (targetRole) {
      query.role = targetRole;
    }

    const users = await UserModel.find(query).select('_id');
    const docs = users.map((u) => ({
      userId: u._id,
      type: 'PLATFORM_ANNOUNCEMENT' as NotificationType,
      title: title.trim(),
      message: message.trim(),
      isRead: false
    }));

    if (docs.length > 0) {
      await NotificationModel.insertMany(docs);
    }

    await AuditLogModel.create({
      action: 'BROADCAST_ANNOUNCEMENT',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      reason: `Broadcast announcement sent to ${docs.length} users (${targetRole || 'ALL'})`,
      details: { title, recipientCount: docs.length, targetRole }
    });

    logger.info(`Main Admin ${adminEmail} broadcast announcement "${title}" to ${docs.length} recipients`);
    return { recipientCount: docs.length };
  }
}

export const notificationService = new NotificationService();
