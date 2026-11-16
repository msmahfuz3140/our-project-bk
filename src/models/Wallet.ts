import mongoose, { Schema, Document } from 'mongoose';

export interface IWallet extends Document {
  userId: mongoose.Types.ObjectId;
  currency: string;
  availableBalanceCents: number;
  reservedWithdrawalCents: number;
  lifetimeCommissionCents: number;
  totalWithdrawnCents: number;
  createdAt: Date;
  updatedAt: Date;
}

const WalletSchema = new Schema<IWallet>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true
    },
    currency: {
      type: String,
      default: 'USD',
      required: true
    },
    availableBalanceCents: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: { validator: Number.isInteger, message: 'Wallet amounts must be integer cents.' }
    },
    reservedWithdrawalCents: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: { validator: Number.isInteger, message: 'Wallet amounts must be integer cents.' }
    },
    lifetimeCommissionCents: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: { validator: Number.isInteger, message: 'Wallet amounts must be integer cents.' }
    },
    totalWithdrawnCents: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: { validator: Number.isInteger, message: 'Wallet amounts must be integer cents.' }
    }
  },
  { timestamps: true }
);

WalletSchema.index({ availableBalanceCents: -1 });
WalletSchema.index({ lifetimeCommissionCents: -1 });

export const WalletModel =
  (mongoose.models.Wallet as mongoose.Model<IWallet>) ||
  mongoose.model<IWallet>('Wallet', WalletSchema);
