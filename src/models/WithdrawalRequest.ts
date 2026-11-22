import mongoose, { Schema, Document } from 'mongoose';

export type WithdrawalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAID';

export interface IWithdrawalRequest extends Document {
  requestId: string;
  idempotencyKey: string;
  userId: mongoose.Types.ObjectId;
  amountCents: number;
  currency: string;
  withdrawalCurrency?: string;
  networkId?: string;
  walletAddress: string;
  network: string;
  status: WithdrawalStatus;
  adminNote?: string;
  rejectionReason?: string;
  transactionHash?: string;
  reviewedByAdminId?: mongoose.Types.ObjectId;
  reviewedByAdminEmail?: string;
  reviewedAt?: Date;
  paidAt?: Date;
  rejectedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const WithdrawalRequestSchema = new Schema<IWithdrawalRequest>(
  {
    requestId: {
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
    amountCents: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: 'Withdrawal amount must be integer cents.' }
    },
    currency: {
      type: String,
      default: 'USD',
      required: true
    },
    withdrawalCurrency: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 20
    },
    networkId: {
      type: String,
      trim: true,
      maxlength: 40,
      index: true
    },
    walletAddress: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300
    },
    network: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80
    },
    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'REJECTED', 'PAID'],
      default: 'PENDING',
      index: true
    },
    adminNote: {
      type: String,
      maxlength: 1000
    },
    rejectionReason: {
      type: String,
      maxlength: 1000
    },
    transactionHash: {
      type: String,
      trim: true,
      maxlength: 300
    },
    reviewedByAdminId: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    reviewedByAdminEmail: {
      type: String
    },
    reviewedAt: { type: Date },
    paidAt: { type: Date },
    rejectedAt: { type: Date }
  },
  { timestamps: true }
);

WithdrawalRequestSchema.index({ userId: 1, createdAt: -1 });
WithdrawalRequestSchema.index({ status: 1, createdAt: -1 });

export const WithdrawalRequestModel =
  (mongoose.models.WithdrawalRequest as mongoose.Model<IWithdrawalRequest>) ||
  mongoose.model<IWithdrawalRequest>('WithdrawalRequest', WithdrawalRequestSchema);
