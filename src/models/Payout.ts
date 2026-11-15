import mongoose, { Schema, Document } from 'mongoose';

export type PayoutStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';

export interface IPayout extends Document {
  transactionId: string;
  idempotencyKey: string;
  amountCents: number;
  amountUsd: number;
  currency: string;
  description?: string;
  method?: string;
  reference?: string;
  adminId: mongoose.Types.ObjectId;
  adminEmail: string;
  status: PayoutStatus;
  previousBalanceCents: number;
  newBalanceCents: number;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PayoutSchema = new Schema<IPayout>(
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
    amountCents: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: 'Payout amount must be stored as integer minor units (cents).'
      }
    },
    amountUsd: {
      type: Number,
      required: true,
      min: 0.01
    },
    currency: {
      type: String,
      default: 'USD',
      required: true
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500
    },
    method: {
      type: String,
      trim: true,
      maxlength: 80
    },
    reference: {
      type: String,
      trim: true,
      maxlength: 160,
      index: true
    },
    adminId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    adminEmail: {
      type: String,
      required: true
    },
    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'FAILED', 'REVERSED'],
      default: 'COMPLETED',
      index: true
    },
    previousBalanceCents: {
      type: Number,
      required: true
    },
    newBalanceCents: {
      type: Number,
      required: true
    },
    completedAt: {
      type: Date
    }
  },
  { timestamps: true }
);

PayoutSchema.index({ status: 1, createdAt: -1 });
PayoutSchema.index({ adminId: 1, createdAt: -1 });

export const PayoutModel =
  (mongoose.models.Payout as mongoose.Model<IPayout>) ||
  mongoose.model<IPayout>('Payout', PayoutSchema);
