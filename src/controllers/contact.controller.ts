import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { ContactMessageModel } from '../models/ContactMessage';
import { AuditLogModel } from '../models/AuditLog';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import { cacheKeys, memoryCache } from '../utils/cache';

export const ContactSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters long').max(120),
  email: z.string().email('Please provide a valid email address'),
  subject: z.string().min(3, 'Subject must be at least 3 characters long').max(200),
  message: z.string().min(10, 'Message must be at least 10 characters long').max(5000)
});

const ContactStatusSchema = z.object({
  status: z.enum(['NEW', 'READ', 'RESOLVED', 'SPAM']),
  reason: z.string().min(3).max(500)
});

export class ContactController {
  async submitInquiry(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = ContactSchema.parse(req.body);

      // Persist first. A support inquiry must never be acknowledged if the
      // database write failed.
      const stored = await ContactMessageModel.create({
        ...validated,
        email: validated.email.toLowerCase().trim(),
        status: 'NEW',
        ip: req.ip,
        userAgent: req.get('user-agent')?.slice(0, 500)
      });

      logger.info('Support inquiry persisted', {
        messageId: stored._id.toString(),
        subject: validated.subject,
        ip: req.ip
      });

      memoryCache.del(cacheKeys.adminSystemHealth);

      res.status(201).json({
        success: true,
        message: 'Your inquiry has been received. Our support team will review your message and reply via email within 24 hours.',
        data: { id: stored._id.toString() }
      });
    } catch (error) {
      next(error);
    }
  }

  async listMessages(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const skip = (page - 1) * limit;
      const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : '';
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

      const query: Record<string, unknown> = {};
      if (status && status !== 'ALL') {
        query.status = status;
      }
      if (search) {
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        query.$or = [{ name: regex }, { email: regex }, { subject: regex }, { message: regex }];
      }

      const [messages, total] = await Promise.all([
        ContactMessageModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        ContactMessageModel.countDocuments(query)
      ]);

      res.status(200).json({
        success: true,
        data: {
          messages,
          total,
          page,
          limit,
          totalPages: Math.max(1, Math.ceil(total / limit))
        }
      });
    } catch (error) {
      next(error);
    }
  }

  async updateMessageStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id as string)) {
        throw ApiError.badRequest('Invalid message identifier');
      }

      const { status, reason } = ContactStatusSchema.parse(req.body);
      const message = await ContactMessageModel.findById(id);
      if (!message) {
        throw ApiError.notFound('Contact message not found');
      }

      const previousStatus = message.status;
      message.status = status;
      if (status === 'RESOLVED') {
        message.resolvedAt = new Date();
        message.resolvedByAdminId = new mongoose.Types.ObjectId(req.user!.id);
        message.resolvedByAdminEmail = req.user!.email;
      }
      await message.save();

      await AuditLogModel.create({
        action: 'CONTACT_MESSAGE_STATUS',
        adminId: new mongoose.Types.ObjectId(req.user!.id),
        adminEmail: req.user!.email || 'admin@rouletteaccuracy.com',
        targetResourceId: message._id.toString(),
        resourceType: 'ContactMessage',
        reason,
        previousValue: { status: previousStatus },
        newValue: { status: message.status }
      });

      res.status(200).json({ success: true, data: message });
    } catch (error) {
      next(error);
    }
  }
}

export const contactController = new ContactController();
