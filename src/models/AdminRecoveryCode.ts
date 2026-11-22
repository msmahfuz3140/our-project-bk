import mongoose, { Schema, Document } from 'mongoose';

export interface IAdminRecoveryCode extends Document {
  userId: mongoose.Types.ObjectId;
  codeHash: string;
  usedAt?: Date;
  usedIp?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AdminRecoveryCodeSchema = new Schema<IAdminRecoveryCode>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    codeHash: {
      type: String,
      required: true,
      unique: true,
      select: false
    },
    usedAt: {
      type: Date
    },
    usedIp: {
      type: String
    }
  },
  { timestamps: true }
);

AdminRecoveryCodeSchema.index({ userId: 1, usedAt: 1 });

export const AdminRecoveryCodeModel =
  mongoose.models.AdminRecoveryCode ||
  mongoose.model<IAdminRecoveryCode>('AdminRecoveryCode', AdminRecoveryCodeSchema);
