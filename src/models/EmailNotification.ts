import mongoose, { Schema, Document } from 'mongoose';

export type EmailTemplateKey =
  | 'VERIFICATION_OTP'
  | 'PASSWORD_RESET_OTP'
  | 'PAYMENT_SUCCESS'
  | 'ACCOUNT_BANNED'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_RESTORED'
  | 'WITHDRAWAL_SUBMITTED'
  | 'WITHDRAWAL_APPROVED'
  | 'WITHDRAWAL_PAID'
  | 'WITHDRAWAL_REJECTED'
  | 'ADMIN_2FA_SECURITY_NOTICE';

export type EmailDeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface IEmailNotification extends Document {
  idempotencyKey: string;
  userId?: mongoose.Types.ObjectId;
  toEmail: string;
  templateKey: EmailTemplateKey;
  subject: string;
  status: EmailDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt?: Date;
  sentAt?: Date;
  nextAttemptAt?: Date;
  lastError?: string;
  providerMessageId?: string;
  metadata?: Record<string, unknown>;
  /** Stored only for non-OTP business notifications so they can be retried. */
  htmlBody?: string;
  textBody?: string;
  createdAt: Date;
  updatedAt: Date;
}

const EmailNotificationSchema = new Schema<IEmailNotification>(
  {
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true
    },
    toEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true
    },
    templateKey: {
      type: String,
      enum: [
        'VERIFICATION_OTP',
        'PASSWORD_RESET_OTP',
        'PAYMENT_SUCCESS',
        'ACCOUNT_BANNED',
        'ACCOUNT_SUSPENDED',
        'ACCOUNT_RESTORED',
        'WITHDRAWAL_SUBMITTED',
        'WITHDRAWAL_APPROVED',
        'WITHDRAWAL_PAID',
        'WITHDRAWAL_REJECTED',
        'ADMIN_2FA_SECURITY_NOTICE'
      ],
      required: true,
      index: true
    },
    subject: {
      type: String,
      required: true,
      maxlength: 300
    },
    status: {
      type: String,
      enum: ['PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED'],
      default: 'PENDING',
      index: true
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0
    },
    maxAttempts: {
      type: Number,
      default: 3,
      min: 1
    },
    lastAttemptAt: { type: Date },
    sentAt: { type: Date },
    nextAttemptAt: { type: Date, index: true },
    lastError: { type: String, maxlength: 2000 },
    providerMessageId: { type: String, maxlength: 500 },
    metadata: { type: Schema.Types.Mixed },
    htmlBody: { type: String, select: false },
    textBody: { type: String, select: false }
  },
  { timestamps: true }
);

EmailNotificationSchema.index({ status: 1, nextAttemptAt: 1 });
EmailNotificationSchema.index({ createdAt: -1 });
EmailNotificationSchema.index({ templateKey: 1, createdAt: -1 });

export const EmailNotificationModel =
  mongoose.models.EmailNotification ||
  mongoose.model<IEmailNotification>('EmailNotification', EmailNotificationSchema);
