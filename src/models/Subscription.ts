import mongoose, { Schema, Document } from 'mongoose';
import { SubscriptionStatus } from '../shared/subscriptions';

export interface ISubscription extends Document {
  userId: mongoose.Types.ObjectId;
  planId: string;
  status: SubscriptionStatus;
  startDate: Date;
  endDate: Date;
  paymentId?: mongoose.Types.ObjectId;
  providerPaymentId?: string;
  secretCode?: string;
  isSecretCodeClaimed: boolean;
  secretCodeClaimedAt?: Date;
  isApprovedByAdmin: boolean;
  approvedByAdminId?: mongoose.Types.ObjectId;
  approvedAt?: Date;
  isManualGrant: boolean;
  grantReason?: string;
  grantedByAdminId?: mongoose.Types.ObjectId;
  isRevoked: boolean;
  revokedAt?: Date;
  revocationReason?: string;
  extendedAt?: Date;
  extensionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SubscriptionSchema = new Schema<ISubscription>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  planId: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: Object.values(SubscriptionStatus),
    default: SubscriptionStatus.PENDING,
    index: true
  },
  startDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  endDate: {
    type: Date,
    required: true,
    index: true
  },
  paymentId: {
    type: Schema.Types.ObjectId,
    ref: 'Payment'
  },
  providerPaymentId: {
    type: String,
    index: true
  },
  secretCode: {
    type: String,
    index: true,
    trim: true
  },
  isSecretCodeClaimed: {
    type: Boolean,
    default: false,
    index: true
  },
  secretCodeClaimedAt: {
    type: Date
  },
  isApprovedByAdmin: {
    type: Boolean,
    default: false,
    index: true
  },
  approvedByAdminId: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: {
    type: Date
  },
  isManualGrant: {
    type: Boolean,
    default: false,
    index: true
  },
  grantReason: {
    type: String
  },
  grantedByAdminId: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  isRevoked: {
    type: Boolean,
    default: false,
    index: true
  },
  revokedAt: {
    type: Date
  },
  revocationReason: {
    type: String
  },
  extendedAt: {
    type: Date
  },
  extensionReason: {
    type: String
  }
}, {
  timestamps: true
});

SubscriptionSchema.index({ userId: 1, status: 1 });
SubscriptionSchema.index({ userId: 1, endDate: -1 });
SubscriptionSchema.index({ status: 1, isRevoked: 1, endDate: -1, userId: 1 });
SubscriptionSchema.index({ planId: 1, status: 1 });
SubscriptionSchema.index({ createdAt: -1 });

export const SubscriptionModel = mongoose.models.Subscription || mongoose.model<ISubscription>('Subscription', SubscriptionSchema);
