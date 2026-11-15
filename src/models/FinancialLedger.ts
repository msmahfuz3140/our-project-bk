import mongoose, { Schema, Document } from 'mongoose';

export interface IFinancialLedger extends Document {
  userId: mongoose.Types.ObjectId;
  orderId: string;
  paymentId: string;
  subscriptionId?: mongoose.Types.ObjectId;
  planId: string;
  type: 'SUBSCRIPTION_PURCHASE' | 'REFUND' | 'ADJUSTMENT';
  amountCents: number;
  amountUsd: number;
  payAmount?: number;
  actuallyPaid?: number;
  payCurrency: string;
  status: 'SETTLED' | 'PENDING' | 'FAILED';
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const FinancialLedgerSchema = new Schema<IFinancialLedger>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  orderId: {
    type: String,
    required: true,
    index: true
  },
  paymentId: {
    type: String,
    required: true,
    index: true
  },
  subscriptionId: {
    type: Schema.Types.ObjectId,
    ref: 'Subscription'
  },
  planId: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['SUBSCRIPTION_PURCHASE', 'REFUND', 'ADJUSTMENT'],
    default: 'SUBSCRIPTION_PURCHASE',
    required: true
  },
  amountCents: {
    type: Number,
    required: true
  },
  amountUsd: {
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
    required: true
  },
  status: {
    type: String,
    enum: ['SETTLED', 'PENDING', 'FAILED'],
    default: 'SETTLED',
    required: true,
    index: true
  },
  notes: {
    type: String
  }
}, {
  timestamps: true
});

export const FinancialLedgerModel =
  mongoose.models.FinancialLedger || mongoose.model<IFinancialLedger>('FinancialLedger', FinancialLedgerSchema);
