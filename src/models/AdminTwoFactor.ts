import mongoose, { Schema, Document } from 'mongoose';

export interface IAdminTwoFactor extends Document {
  userId: mongoose.Types.ObjectId;
  enabled: boolean;
  secretEncrypted?: string;
  pendingSecretEncrypted?: string;
  pendingExpiresAt?: Date;
  lastVerifiedAt?: Date;
  lastUsedTimeStep?: number;
  failedAttempts: number;
  lockedUntil?: Date;
  recoveryCodesGeneratedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AdminTwoFactorSchema = new Schema<IAdminTwoFactor>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true
    },
    enabled: {
      type: Boolean,
      default: false,
      index: true
    },
    secretEncrypted: {
      type: String,
      select: false
    },
    pendingSecretEncrypted: {
      type: String,
      select: false
    },
    pendingExpiresAt: {
      type: Date
    },
    lastVerifiedAt: {
      type: Date
    },
    lastUsedTimeStep: {
      type: Number
    },
    failedAttempts: {
      type: Number,
      default: 0,
      min: 0
    },
    lockedUntil: {
      type: Date
    },
    recoveryCodesGeneratedAt: {
      type: Date
    }
  },
  { timestamps: true }
);

AdminTwoFactorSchema.index({ enabled: 1, userId: 1 });

export const AdminTwoFactorModel =
  mongoose.models.AdminTwoFactor ||
  mongoose.model<IAdminTwoFactor>('AdminTwoFactor', AdminTwoFactorSchema);
