import mongoose, { Schema, Document } from 'mongoose';

export type WalletTransactionType =
  | 'REFERRAL_COMMISSION'
  | 'COMMISSION_REVERSAL'
  | 'MANUAL_BALANCE_ADD'
  | 'MANUAL_BALANCE_DEDUCT'
  | 'WITHDRAWAL_RESERVE'
  | 'WITHDRAWAL_REFUND'
  | 'WITHDRAWAL_PAID'
  | 'WITHDRAWAL_APPROVED'
  | 'ADJUSTMENT';

export type WalletTransactionStatus = 'PENDING' | 'COMPLETED' | 'REJECTED' | 'REVERSED' | 'FAILED';

export interface IWalletTransaction extends Document {
  transactionId: string;
  idempotencyKey: string;
  userId: mongoose.Types.ObjectId;
  type: WalletTransactionType;
  amountCents: number;
  currency: string;
  previousAvailableCents: number;
  newAvailableCents: number;
  previousReservedCents: number;
  newReservedCents: number;
  status: WalletTransactionStatus;
  relatedUserId?: mongoose.Types.ObjectId;
  relatedPaymentId?: mongoose.Types.ObjectId;
  relatedSubscriptionId?: mongoose.Types.ObjectId;
  relatedCommissionId?: mongoose.Types.ObjectId;
  relatedWithdrawalId?: mongoose.Types.ObjectId;
  adminId?: mongoose.Types.ObjectId;
  adminEmail?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const WalletTransactionSchema = new Schema<IWalletTransaction>(
  {
    transactionId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    type: {
      type: String,
      enum: [
        'REFERRAL_COMMISSION',
        'COMMISSION_REVERSAL',
        'MANUAL_BALANCE_ADD',
        'MANUAL_BALANCE_DEDUCT',
        'WITHDRAWAL_RESERVE',
        'WITHDRAWAL_REFUND',
        'WITHDRAWAL_PAID',
        'WITHDRAWAL_APPROVED',
        'ADJUSTMENT'
      ],
      required: true,
      index: true
    },
    amountCents: {
      type: Number,
      required: true,
      validate: { validator: Number.isInteger, message: 'Transaction amount must be integer cents.' }
    },
    currency: {
      type: String,
      default: 'USD'
    },
    previousAvailableCents: {
      type: Number,
      required: true,
      default: 0
    },
    newAvailableCents: {
      type: Number,
      required: true,
      default: 0
    },
    previousReservedCents: {
      type: Number,
      required: true,
      default: 0
    },
    newReservedCents: {
      type: Number,
      required: true,
      default: 0
    },
    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'REJECTED', 'REVERSED', 'FAILED'],
      default: 'COMPLETED',
      index: true
    },
    relatedUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    relatedPaymentId: { type: Schema.Types.ObjectId, ref: 'Payment', index: true },
    relatedSubscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', index: true },
    relatedCommissionId: { type: Schema.Types.ObjectId, ref: 'ReferralCommission', index: true },
    relatedWithdrawalId: { type: Schema.Types.ObjectId, ref: 'WithdrawalRequest', index: true },
    adminId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    adminEmail: { type: String },
    reason: { type: String, maxlength: 1000 },
    metadata: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

WalletTransactionSchema.index({ userId: 1, createdAt: -1 });
WalletTransactionSchema.index({ type: 1, createdAt: -1 });
WalletTransactionSchema.index({ status: 1, createdAt: -1 });

export const WalletTransactionModel =
  (mongoose.models.WalletTransaction as mongoose.Model<IWalletTransaction>) ||
  mongoose.model<IWalletTransaction>('WalletTransaction', WalletTransactionSchema);
