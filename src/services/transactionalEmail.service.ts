import mongoose from 'mongoose';
import {
  EmailNotificationModel,
  EmailTemplateKey,
  IEmailNotification
} from '../models/EmailNotification';
import { emailService } from './email.service';
import { RenderedEmail } from './emailTemplates';
import { logger } from '../utils/logger';
import { ApiError } from '../utils/apiError';
import { isEmailTransportConfigured } from '../config/env';

const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 4;
const OTP_TEMPLATES: EmailTemplateKey[] = ['VERIFICATION_OTP', 'PASSWORD_RESET_OTP'];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1800);
  return String(error).slice(0, 1800);
}

export interface SendTransactionalEmailInput {
  idempotencyKey: string;
  userId?: string | mongoose.Types.ObjectId;
  toEmail: string;
  templateKey: EmailTemplateKey;
  rendered: RenderedEmail;
  metadata?: Record<string, unknown>;
}

export interface TransactionalEmailResult {
  id: string;
  status: 'SENT' | 'PENDING' | 'FAILED' | 'SKIPPED';
  attempts: number;
  skipped?: boolean;
}

export class TransactionalEmailService {
  private normalizeEmail(value?: string): string {
    return String(value || '').trim().toLowerCase();
  }

  /**
   * Record and deliver a transactional email exactly once per idempotency key.
   * Delivery failures never throw to the caller; they are stored for retry.
   *
   * Verification/reset OTP bodies are never persisted. Business emails are
   * persisted (select:false) so a transient SMTP outage can be retried without
   * re-running the financial event.
   */
  async send(input: SendTransactionalEmailInput): Promise<TransactionalEmailResult> {
    const toEmail = this.normalizeEmail(input.toEmail);
    if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
      logger.warn('Transactional email skipped: no valid recipient', {
        templateKey: input.templateKey,
        idempotencyKey: input.idempotencyKey
      });
      return { id: '', status: 'SKIPPED', attempts: 0, skipped: true };
    }

    let record = await EmailNotificationModel.findOne({ idempotencyKey: input.idempotencyKey });
    if (!record) {
      const isOtp = OTP_TEMPLATES.includes(input.templateKey);
      try {
        record = await EmailNotificationModel.create({
          idempotencyKey: input.idempotencyKey,
          userId: input.userId ? new mongoose.Types.ObjectId(input.userId.toString()) : undefined,
          toEmail,
          templateKey: input.templateKey,
          subject: input.rendered.subject,
          status: 'PENDING',
          attempts: 0,
          maxAttempts: MAX_ATTEMPTS,
          nextAttemptAt: new Date(),
          metadata: input.metadata,
          ...(isOtp ? {} : { htmlBody: input.rendered.html, textBody: input.rendered.text })
        });
      } catch (error: any) {
        if (error?.code === 11000) {
          record = await EmailNotificationModel.findOne({ idempotencyKey: input.idempotencyKey });
        } else {
          logger.error('Failed to persist transactional email record', {
            templateKey: input.templateKey,
            error: error?.message
          });
          return { id: '', status: 'FAILED', attempts: 0 };
        }
      }
    }

    if (!record) {
      return { id: '', status: 'FAILED', attempts: 0 };
    }

    if (record.status === 'SENT') {
      return { id: record._id.toString(), status: 'SENT', attempts: record.attempts, skipped: true };
    }

    if (record.status === 'SKIPPED') {
      return { id: record._id.toString(), status: 'SKIPPED', attempts: record.attempts, skipped: true };
    }

    // Recover a delivery attempt that crashed while marked SENDING.
    if (record.status === 'SENDING') {
      const lastAttempt = record.lastAttemptAt?.getTime() || 0;
      if (Date.now() - lastAttempt < 2 * 60 * 1000) {
        return { id: record._id.toString(), status: 'PENDING', attempts: record.attempts, skipped: true };
      }
      record.status = 'PENDING';
      record.nextAttemptAt = new Date();
      await record.save();
    }

    // Never retry an expired one-time code.
    const expiresAt = record.metadata?.expiresAt as string | undefined;
    if (expiresAt && Date.now() > new Date(expiresAt).getTime()) {
      record.status = 'SKIPPED';
      record.lastError = 'Message expired before delivery';
      record.nextAttemptAt = undefined;
      await record.save().catch(() => null);
      return { id: record._id.toString(), status: 'SKIPPED', attempts: record.attempts, skipped: true };
    }

    if (record.status === 'FAILED' && record.attempts >= record.maxAttempts) {
      return { id: record._id.toString(), status: 'FAILED', attempts: record.attempts, skipped: true };
    }

    if (record.nextAttemptAt && record.nextAttemptAt.getTime() > Date.now()) {
      return { id: record._id.toString(), status: 'PENDING', attempts: record.attempts, skipped: true };
    }

    // Always use the stored business body for retries. The freshly rendered
    // body is only needed when the first record could not be created with it.
    const body = {
      subject: record.subject,
      html: record.htmlBody || input.rendered.html,
      text: record.textBody || input.rendered.text
    };

    return this.deliver(record, body);
  }

  private async deliver(
    record: IEmailNotification,
    body: { subject: string; html: string; text: string }
  ): Promise<TransactionalEmailResult> {
    const now = new Date();
    const claimed = await EmailNotificationModel.findOneAndUpdate(
      {
        _id: record._id,
        status: { $in: ['PENDING', 'FAILED'] },
        attempts: { $lt: record.maxAttempts },
        $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }]
      },
      {
        $set: {
          status: 'SENDING',
          lastAttemptAt: now,
          nextAttemptAt: undefined,
          lastError: undefined
        }
      },
      { new: true }
    );

    if (!claimed) {
      const current = await EmailNotificationModel.findById(record._id);
      return {
        id: record._id.toString(),
        status: current?.status === 'SENT' ? 'SENT' : current?.status === 'SKIPPED' ? 'SKIPPED' : 'PENDING',
        attempts: current?.attempts ?? record.attempts,
        skipped: true
      };
    }

    let lastError = '';
    let delivered = false;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await EmailNotificationModel.updateOne({ _id: claimed._id }, { $inc: { attempts: 1 } });
        delivered = await emailService.sendEmail({
          to: claimed.toEmail,
          subject: body.subject,
          text: body.text,
          html: body.html
        });
        if (delivered) break;
        lastError = 'The configured email transport did not accept the message';
      } catch (error) {
        lastError = errorMessage(error);
      }

      if (attempt < 2) {
        await delay(600);
      }
    }

    const latest = await EmailNotificationModel.findById(claimed._id);
    const attempts = latest?.attempts ?? claimed.attempts + 1;

    if (delivered) {
      await EmailNotificationModel.updateOne(
        { _id: claimed._id },
        {
          $set: {
            status: 'SENT',
            sentAt: new Date(),
            nextAttemptAt: undefined,
            lastError: undefined
          }
        }
      );
      return { id: claimed._id.toString(), status: 'SENT', attempts };
    }

    const terminal = attempts >= claimed.maxAttempts;
    await EmailNotificationModel.updateOne(
      { _id: claimed._id },
      {
        $set: {
          status: terminal ? 'FAILED' : 'PENDING',
          lastError: lastError || 'Unknown delivery error',
          nextAttemptAt: terminal ? undefined : new Date(Date.now() + RETRY_DELAY_MS)
        }
      }
    );

    logger.error('Transactional email delivery failed', {
      templateKey: claimed.templateKey,
      recipient: claimed.toEmail,
      attempts,
      terminal,
      error: lastError
    });

    return {
      id: claimed._id.toString(),
      status: terminal ? 'FAILED' : 'PENDING',
      attempts
    };
  }

  /**
   * Re-attempt a failed business notification using its persisted body.
   * OTP bodies are never persisted, so an admin must trigger a new code instead.
   */
  async retryById(id: string, admin?: { id: string; email: string }): Promise<TransactionalEmailResult> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw ApiError.badRequest('Invalid email notification id');
    }
    const record = await EmailNotificationModel.findById(id).select('+htmlBody +textBody');
    if (!record) throw ApiError.notFound('Email notification was not found');
    if (record.status === 'SENT') {
      return { id, status: 'SENT', attempts: record.attempts, skipped: true };
    }
    if (OTP_TEMPLATES.includes(record.templateKey)) {
      throw ApiError.badRequest(
        'One-time codes are never stored and cannot be retried. Request a new verification code instead.'
      );
    }
    if (!record.htmlBody && !record.textBody) {
      throw ApiError.badRequest('This notification has no stored body and cannot be retried safely.');
    }

    record.status = 'PENDING';
    record.maxAttempts = Math.max(record.maxAttempts, record.attempts + 3);
    record.nextAttemptAt = new Date();
    record.lastError = undefined;
    await record.save();

    logger.info('Transactional email retry requested', {
      emailNotificationId: id,
      adminEmail: admin?.email
    });

    return this.deliver(record, {
      subject: record.subject,
      html: record.htmlBody || record.textBody || '',
      text: record.textBody || ''
    });
  }

  /**
   * Periodic retry for persisted business notifications that are still pending.
   * OTP codes are excluded because their body is intentionally not stored.
   */
  async processPendingRetries(limit = 25): Promise<{ checked: number; sent: number; failed: number }> {
    const staleSendingBefore = new Date(Date.now() - 2 * 60 * 1000);
    const candidates = await EmailNotificationModel.find({
      attempts: { $lt: MAX_ATTEMPTS },
      templateKey: { $nin: OTP_TEMPLATES },
      $or: [
        { status: 'PENDING', nextAttemptAt: { $lte: new Date() } },
        { status: 'SENDING', lastAttemptAt: { $lt: staleSendingBefore } }
      ],
      htmlBody: { $exists: true, $ne: '' }
    })
      .select('+htmlBody +textBody')
      .sort({ nextAttemptAt: 1 })
      .limit(Math.min(100, Math.max(1, limit)));

    let sent = 0;
    let failed = 0;

    for (const candidate of candidates) {
      try {
        if (candidate.status === 'SENDING') {
          candidate.status = 'PENDING';
          candidate.nextAttemptAt = new Date();
          await candidate.save();
        }
        const result = await this.deliver(candidate, {
          subject: candidate.subject,
          html: candidate.htmlBody || candidate.textBody || '',
          text: candidate.textBody || ''
        });
        if (result.status === 'SENT') sent += 1;
        else if (result.status === 'FAILED') failed += 1;
      } catch {
        failed += 1;
      }
    }

    return { checked: candidates.length, sent, failed };
  }

  async listForAdmin(options: {
    status?: string;
    templateKey?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    notifications: any[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 25));
    const query: Record<string, any> = {};

    if (options.status && options.status !== 'ALL') query.status = options.status;
    if (options.templateKey && options.templateKey !== 'ALL') query.templateKey = options.templateKey;
    if (options.search && options.search.trim()) {
      const escaped = options.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      query.$or = [{ toEmail: regex }, { subject: regex }, { lastError: regex }];
    }

    const [notifications, total] = await Promise.all([
      EmailNotificationModel.find(query)
        .select('-metadata -htmlBody -textBody')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      EmailNotificationModel.countDocuments(query)
    ]);

    return { notifications, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async getMetrics(): Promise<{
    total: number;
    sent: number;
    pending: number;
    failed: number;
    skipped: number;
    last24h: number;
    transportConfigured: boolean;
  }> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [total, sent, pending, failed, skipped, last24h] = await Promise.all([
      EmailNotificationModel.countDocuments(),
      EmailNotificationModel.countDocuments({ status: 'SENT' }),
      EmailNotificationModel.countDocuments({ status: { $in: ['PENDING', 'SENDING'] } }),
      EmailNotificationModel.countDocuments({ status: 'FAILED' }),
      EmailNotificationModel.countDocuments({ status: 'SKIPPED' }),
      EmailNotificationModel.countDocuments({ createdAt: { $gte: since } })
    ]);
    return {
      total,
      sent,
      pending,
      failed,
      skipped,
      last24h,
      transportConfigured: isEmailTransportConfigured()
    };
  }

  async getRecentForUser(userId: string, limit = 10): Promise<any[]> {
    if (!mongoose.Types.ObjectId.isValid(userId)) return [];
    return EmailNotificationModel.find({ userId: new mongoose.Types.ObjectId(userId) })
      .select('-metadata -htmlBody -textBody')
      .sort({ createdAt: -1 })
      .limit(Math.min(50, Math.max(1, limit)))
      .lean();
  }
}

export const transactionalEmailService = new TransactionalEmailService();
