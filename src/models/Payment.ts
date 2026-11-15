import mongoose, { Schema, Document } from 'mongoose';
import { PaymentStatus } from '../shared/subscriptions';
import { PlanDuration } from '../shared/plans';

export interface IipnEvent {
  receivedAt: Date;
  paymentStatus: string;
  actuallyPaid?: number;
  rawPayload: Record<string, unknown>;
}

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
  paymentId: string;
  orderId: string;
  status: PaymentStatus;
  isFulfilled: boolean;
  subscriptionId?: mongoose.Types.ObjectId;
  failureReason?: string;
  payAddress?: string;
  checkoutUrl?: string;
  referredByModeratorId?: mongoose.Types.ObjectId;
  referralCodeSnapshot?: string;
  commissionRateSnapshot?: number;
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
    unique: true,
    index: true
  },
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true
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

export const PaymentModel = mongoose.models.Payment || mongoose.model<IPayment>('Payment', PaymentSchema);
