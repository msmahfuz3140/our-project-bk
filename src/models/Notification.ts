import mongoose, { Schema, Document } from 'mongoose';

export type NotificationType =
  | 'SUBSCRIPTION_ACTIVATED'
  | 'PAYMENT_FAILED'
  | 'SUBSCRIPTION_EXPIRING'
  | 'SUBSCRIPTION_EXPIRED'
  | 'SUBSCRIPTION_REVOKED'
  | 'SECURITY_ALERT'
  | 'PLATFORM_ANNOUNCEMENT';

export interface INotification extends Document {
  userId: mongoose.Types.ObjectId;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  readAt?: Date;
  link?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    type: {
      type: String,
      enum: [
        'SUBSCRIPTION_ACTIVATED',
        'PAYMENT_FAILED',
        'SUBSCRIPTION_EXPIRING',
        'SUBSCRIPTION_EXPIRED',
        'SUBSCRIPTION_REVOKED',
        'SECURITY_ALERT',
        'PLATFORM_ANNOUNCEMENT'
      ],
      required: true,
      index: true
    },
    title: {
      type: String,
      required: true
    },
    message: {
      type: String,
      required: true
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true
    },
    readAt: {
      type: Date
    },
    link: {
      type: String
    },
    metadata: {
      type: Schema.Types.Mixed
    }
  },
  {
    timestamps: true
  }
);

NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

export const NotificationModel =
  mongoose.models.Notification || mongoose.model<INotification>('Notification', NotificationSchema);
