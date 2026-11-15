import mongoose, { Schema, Document } from 'mongoose';

export type CommissionStatus = 'PENDING' | 'ELIGIBLE' | 'APPROVED' | 'CREDITED' | 'REVERSED';

export interface IReversalDetails {
  reversedAt: Date;
  reversedByAdminId?: mongoose.Types.ObjectId;
  reversedByAdminEmail?: string;
  reason: string;
}

export interface IReferralCommission extends Document {
  moderatorId: mongoose.Types.ObjectId;
  referredUserId: mongoose.Types.ObjectId;
  subscriptionId?: mongoose.Types.ObjectId;
  paymentId: mongoose.Types.ObjectId;
  purchaseId?: string;                     // e.g. ORD_...
  subscriptionPlan?: string;               // e.g. PLAN_1_MONTH
  originalPurchaseAmount?: number;         // e.g. $200.00
  commissionableAmount?: number;           // e.g. $200.00 (explicit basis excluding refunds/fees)
  commissionRate: number;                  // Snapshot at purchase time (e.g. 0.50)
  amountUsd: number;                       // Final commission amount in USD
  status: CommissionStatus;
  reversalDetails?: IReversalDetails;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ReferralCommissionSchema = new Schema<IReferralCommission>({
  moderatorId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  referredUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  subscriptionId: {
    type: Schema.Types.ObjectId,
    ref: 'Subscription',
    required: false,
    index: true
  },
  paymentId: {
    type: Schema.Types.ObjectId,
    ref: 'Payment',
    required: true,
    index: true
  },
  purchaseId: {
    type: String,
    index: true
  },
  subscriptionPlan: {
    type: String,
    index: true
  },
  originalPurchaseAmount: {
    type: Number
  },
  commissionableAmount: {
    type: Number
  },
  amountUsd: {
    type: Number,
    required: true
  },
  commissionRate: {
    type: Number,
    required: true,
    default: 0.50
  },
  status: {
    type: String,
    enum: ['PENDING', 'ELIGIBLE', 'APPROVED', 'CREDITED', 'REVERSED'],
    default: 'CREDITED',
    index: true
  },
  reversalDetails: {
    reversedAt: { type: Date },
    reversedByAdminId: { type: Schema.Types.ObjectId, ref: 'User' },
    reversedByAdminEmail: { type: String },
    reason: { type: String }
  },
  notes: {
    type: String
  }
}, {
  timestamps: true
});

ReferralCommissionSchema.index({ moderatorId: 1, createdAt: -1 });
ReferralCommissionSchema.index({ moderatorId: 1, status: 1 });
ReferralCommissionSchema.index({ status: 1, createdAt: -1 });

export const ReferralCommissionModel =
  mongoose.models.ReferralCommission ||
  mongoose.model<IReferralCommission>('ReferralCommission', ReferralCommissionSchema);
