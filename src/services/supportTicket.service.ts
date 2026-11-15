import mongoose from 'mongoose';
import {
  SupportTicketModel,
  ISupportTicket,
  TicketCategory,
  TicketPriority,
  TicketStatus
} from '../models/SupportTicket';
import { UserModel } from '../models/User';
import { AuditLogModel } from '../models/AuditLog';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';

export interface TicketListFilter {
  status?: string;
  priority?: string;
  category?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export class SupportTicketService {
  /**
   * Create a new support ticket (User or Admin initiated)
   */
  async createTicket(params: {
    userId: string;
    subject: string;
    description: string;
    category?: TicketCategory;
    priority?: TicketPriority;
    relatedPaymentId?: string;
    relatedSubscriptionId?: string;
  }): Promise<ISupportTicket> {
    const user = await UserModel.findById(params.userId);
    if (!user) {
      throw ApiError.notFound('User not found');
    }

    const count = await SupportTicketModel.countDocuments();
    const ticketNumber = `TCK-${1000 + count + 1}`;

    const ticket = await SupportTicketModel.create({
      ticketNumber,
      userId: user._id,
      userName: user.name || 'Member',
      userEmail: user.email || user.phone || 'customer@rouletteaccuracy.com',
      subject: params.subject.trim(),
      description: params.description.trim(),
      category: params.category || 'OTHER',
      priority: params.priority || 'MEDIUM',
      status: 'OPEN',
      relatedPaymentId: params.relatedPaymentId ? new mongoose.Types.ObjectId(params.relatedPaymentId) : undefined,
      relatedSubscriptionId: params.relatedSubscriptionId ? new mongoose.Types.ObjectId(params.relatedSubscriptionId) : undefined,
      messages: [
        {
          senderId: user._id,
          senderEmail: user.email || user.phone || 'customer@rouletteaccuracy.com',
          senderRole: user.role,
          message: params.description.trim(),
          isInternalNote: false,
          createdAt: new Date()
        }
      ]
    });

    logger.info(`Support ticket created: ${ticket.ticketNumber} for ${user.email}`);
    return ticket;
  }

  /**
   * List tickets with pagination, filters, and full text search
   */
  async getTickets(filter: TicketListFilter): Promise<{ tickets: ISupportTicket[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, filter.page || 1);
    const limit = Math.min(100, Math.max(1, filter.limit || 20));
    const skip = (page - 1) * limit;

    const query: any = {};

    if (filter.status && filter.status !== 'ALL') {
      query.status = filter.status;
    }

    if (filter.priority && filter.priority !== 'ALL') {
      query.priority = filter.priority;
    }

    if (filter.category && filter.category !== 'ALL') {
      query.category = filter.category;
    }

    if (filter.search && filter.search.trim() !== '') {
      const sanitized = filter.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(sanitized, 'i');
      query.$or = [
        { ticketNumber: regex },
        { subject: regex },
        { userEmail: regex },
        { userName: regex }
      ];
    }

    const [tickets, total] = await Promise.all([
      SupportTicketModel.find(query)
        .populate('assignedToAdminId', 'name email')
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit),
      SupportTicketModel.countDocuments(query)
    ]);

    return { tickets, total, page, limit };
  }

  /**
   * Get single ticket by ID
   */
  async getTicketById(ticketId: string): Promise<ISupportTicket> {
    const ticket = await SupportTicketModel.findById(ticketId)
      .populate('userId', 'name email phone role accountStatus')
      .populate('assignedToAdminId', 'name email')
      .populate('relatedPaymentId')
      .populate('relatedSubscriptionId');

    if (!ticket) {
      throw ApiError.notFound(`Ticket ${ticketId} not found`);
    }

    return ticket;
  }

  /**
   * Add a reply or internal note to a ticket
   */
  async addReply(params: {
    ticketId: string;
    senderId: string;
    senderEmail: string;
    senderRole: string;
    message: string;
    isInternalNote?: boolean;
  }): Promise<ISupportTicket> {
    const ticket = await SupportTicketModel.findById(params.ticketId);
    if (!ticket) {
      throw ApiError.notFound('Ticket not found');
    }

    const isInternal = !!params.isInternalNote;

    ticket.messages.push({
      senderId: new mongoose.Types.ObjectId(params.senderId),
      senderEmail: params.senderEmail,
      senderRole: params.senderRole,
      message: params.message.trim(),
      isInternalNote: isInternal,
      createdAt: new Date()
    });

    ticket.lastRepliedAt = new Date();

    // If staff replies and status was OPEN, update to IN_PROGRESS
    if (params.senderRole === 'SUPER_ADMIN' && ticket.status === 'OPEN' && !isInternal) {
      ticket.status = 'IN_PROGRESS';
    }

    await ticket.save();

    logger.info(`Reply added to ticket ${ticket.ticketNumber} by ${params.senderEmail} (internal: ${isInternal})`);
    return ticket;
  }

  /**
   * Update ticket status (OPEN, IN_PROGRESS, RESOLVED, CLOSED)
   */
  async updateStatus(ticketId: string, status: TicketStatus, adminEmail: string, adminId: string, reason?: string): Promise<ISupportTicket> {
    const ticket = await SupportTicketModel.findById(ticketId);
    if (!ticket) {
      throw ApiError.notFound('Ticket not found');
    }

    const prevStatus = ticket.status;
    ticket.status = status;
    const now = new Date();

    if (status === 'RESOLVED') {
      ticket.resolvedAt = now;
    } else if (status === 'CLOSED') {
      ticket.closedAt = now;
    }

    await ticket.save();

    await AuditLogModel.create({
      action: 'ADMIN_SETTING_CHANGE',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetResourceId: ticket._id.toString(),
      resourceType: 'SUPPORT_TICKET',
      reason: reason || `Updated ticket status from ${prevStatus} to ${status}`,
      previousValue: { status: prevStatus },
      newValue: { status }
    }).catch(err => logger.error('Audit log failed for ticket status change', err));

    return ticket;
  }

  /**
   * Assign ticket to an admin
   */
  async assignAdmin(ticketId: string, assignedAdminId: string, assigningAdminEmail: string): Promise<ISupportTicket> {
    const ticket = await SupportTicketModel.findById(ticketId);
    if (!ticket) {
      throw ApiError.notFound('Ticket not found');
    }

    const admin = await UserModel.findById(assignedAdminId);
    if (!admin) {
      throw ApiError.notFound('Assigned admin not found');
    }

    ticket.assignedToAdminId = admin._id;
    ticket.assignedToAdminEmail = admin.email;
    await ticket.save();

    logger.info(`Ticket ${ticket.ticketNumber} assigned to ${admin.email} by ${assigningAdminEmail}`);
    return ticket;
  }
}

export const supportTicketService = new SupportTicketService();
