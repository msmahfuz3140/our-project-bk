import mongoose, { Schema, Document } from 'mongoose';
import { PaymentStatus } from '../shared/subscriptions';
import { PlanDuration } from '../shared/plans';

export type FulfillmentStatus = 'NONE' | 'PROCESSING' | 'FULFILLED' | 'FAILED';

export interface IipnEvent {
  receivedAt: Date;
  paymentStatus: string;
  actuallyPaid?: number;
  rawPayload: Record<string, unknown>;
}

/**
 * Existing platform model for a purchase order + its provider payment.
 *
 * The project already used a single collection for both the order snapshot
 * (orderId / plan / price) and the provider payment record. We deliberately
 * extend it rather than creating a duplicate `orders` collection. This keeps
 * all existing admin, ledger, referral and subscription relationships intact.
 */
export interface IPayment extends Document {
  userId: mongoose.Types.ObjectId;
  planId: string;
  planName: string;
  priceCents: number;      // Decimal-safe integer cents snapshot
  priceAmount: number;     // USD dollar value snapshot
  priceCurrency: string;
  duration: PlanDuration;  // Snapshot of duration unit and value
  durationDays: number;
  payAmount?: number;
  actuallyPaid?: number;
  payCurrency: string;
  paymentId: string;       // Provider reference shown to the user (invoice/payment id)
  orderId: string;         // Human-readable order number

  // NOWPayments provider linkage
  provider: string;
  providerInvoiceId?: string;
  providerPaymentId?: string;
  providerStatus?: string;
  paymentMethod?: string;
  transactionId?: string;
  payCurrencyLocked: boolean;

  status: PaymentStatus;
  isFulfilled: boolean;
  fulfillmentStatus: FulfillmentStatus;
  processingStartedAt?: Date;
  subscriptionId?: mongoose.Types.ObjectId;
  failureReason?: string;
  payAddress?: string;
  checkoutUrl?: string;
  network?: string;

  // Verification / lifecycle evidence
  signatureVerified: boolean;
  providerVerified: boolean;
  verified: boolean;
  verifiedAt?: Date;
  paidAt?: Date;
  expiresAt?: Date;
  refundedAt?: Date;
  overpaymentAmount?: number;
  webhookEventCount: number;
  lastWebhookAt?: Date;

  // Manual admin review / activation provenance
  activationSource?: 'IPN' | 'MANUAL' | 'SYSTEM';
  manualReviewStatus?: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewedByAdminId?: mongoose.Types.ObjectId;
  reviewedByAdminEmail?: string;
  reviewedAt?: Date;
  reviewReason?: string;

  referredByModeratorId?: mongoose.Types.ObjectId;
  referralCodeSnapshot?: string;
  commissionRateSnapshot?: number;
  referralCommissionTypeSnapshot?: 'ONE_TIME' | 'LIFETIME';
  referralCommissionEligibleSnapshot?: boolean;
  rawIpnData?: Record<string, unknown>;
  ipnHistory: IipnEvent[];
  createdAt: Date;
  updatedAt: Date;
}

const PaymentSchema = new Schema<IPayment>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  planId: {
    type: String,
    required: true,
    index: true
  },
  planName: {
    type: String,
    required: true
  },
  priceCents: {
    type: Number,
    required: true
  },
  priceAmount: {
    type: Number,
    required: true
  },
  priceCurrency: {
    type: String,
    default: 'USD'
  },
  duration: {
    unit: {
      type: String,
      enum: ['DAYS', 'MONTHS'],
      required: true
    },
    value: {
      type: Number,
      required: true
    }
  },
  durationDays: {
    type: Number,
    required: true
  },
  payAmount: {
    type: Number
  },
  actuallyPaid: {
    type: Number
  },
  payCurrency: {
    type: String,
    default: 'USDTTRC20'
  },
  paymentId: {
    type: String,
    required: true,
    unique: true
  },
  orderId: {
    type: String,
    required: true,
    unique: true
  },
  provider: {
    type: String,
    default: 'NOWPAYMENTS',
    index: true
  },
  providerInvoiceId: {
    type: String,
    index: true,
    sparse: true
  },
  providerPaymentId: {
    type: String,
    sparse: true
  },
  providerStatus: {
    type: String,
    index: true
  },
  paymentMethod: {
    type: String
  },
  transactionId: {
    type: String,
    index: true,
    sparse: true
  },
  payCurrencyLocked: {
    type: Boolean,
    default: false
  },
  status: {
    type: String,
    enum: Object.values(PaymentStatus),
    default: PaymentStatus.WAITING,
    index: true
  },
  isFulfilled: {
    type: Boolean,
    default: false,
    index: true
  },
  fulfillmentStatus: {
    type: String,
    enum: ['NONE', 'PROCESSING', 'FULFILLED', 'FAILED'],
    default: 'NONE',
    index: true
  },
  processingStartedAt: {
    type: Date
  },
  subscriptionId: {
    type: Schema.Types.ObjectId,
    ref: 'Subscription',
    index: true
  },
  failureReason: {
    type: String
  },
  payAddress: {
    type: String
  },
  checkoutUrl: {
    type: String
  },
  network: {
    type: String
  },
  signatureVerified: {
    type: Boolean,
    default: false
  },
  providerVerified: {
    type: Boolean,
    default: false
  },
  verified: {
    type: Boolean,
    default: false,
    index: true
  },
  verifiedAt: {
    type: Date
  },
  paidAt: {
    type: Date,
    index: true
  },
  expiresAt: {
    type: Date,
    index: true
  },
  refundedAt: {
    type: Date
  },
  overpaymentAmount: {
    type: Number
  },
  webhookEventCount: {
    type: Number,
    default: 0
  },
  lastWebhookAt: {
    type: Date
  },
  activationSource: {
    type: String,
    enum: ['IPN', 'MANUAL', 'SYSTEM'],
    index: true
  },
  manualReviewStatus: {
    type: String,
    enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED'],
    default: 'NONE',
    index: true
  },
  reviewedByAdminId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  reviewedByAdminEmail: {
    type: String
  },
  reviewedAt: {
    type: Date
  },
  reviewReason: {
    type: String,
    maxlength: 1000
  },
  referredByModeratorId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  referralCodeSnapshot: {
    type: String
  },
  commissionRateSnapshot: {
    type: Number
  },
  referralCommissionTypeSnapshot: {
    type: String,
    enum: ['ONE_TIME', 'LIFETIME']
  },
  referralCommissionEligibleSnapshot: {
    type: Boolean
  },
  rawIpnData: {
    type: Schema.Types.Mixed
  },
  ipnHistory: [{
    receivedAt: {
      type: Date,
      default: Date.now
    },
    paymentStatus: {
      type: String,
      required: true
    },
    actuallyPaid: {
      type: Number
    },
    rawPayload: {
      type: Schema.Types.Mixed
    }
  }]
}, {
  timestamps: true
});

PaymentSchema.index({ userId: 1, createdAt: -1 });
PaymentSchema.index({ userId: 1, isFulfilled: 1, priceAmount: 1 });
PaymentSchema.index({ status: 1, isFulfilled: 1 });
PaymentSchema.index({ isFulfilled: 1, createdAt: -1 });
PaymentSchema.index({ referredByModeratorId: 1, status: 1 });
PaymentSchema.index({ createdAt: -1 });
PaymentSchema.index({ userId: 1, orderId: 1 });
PaymentSchema.index(
  { provider: 1, providerPaymentId: 1 },
  { unique: true, partialFilterExpression: { providerPaymentId: { $type: 'string' } } }
);

export const PaymentModel = mongoose.models.Payment || mongoose.model<IPayment>('Payment', PaymentSchema);
