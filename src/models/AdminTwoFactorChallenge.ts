import mongoose, { Schema, Document } from 'mongoose';

export type Admin2FAChallengePurpose = 'SETUP' | 'LOGIN' | 'REPLACE';

export interface IAdminTwoFactorChallenge extends Document {
  challengeId: string;
  userId: mongoose.Types.ObjectId;
  purpose: Admin2FAChallengePurpose;
  expiresAt: Date;
  usedAt?: Date;
  attempts: number;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
}

const AdminTwoFactorChallengeSchema = new Schema<IAdminTwoFactorChallenge>(
  {
    challengeId: {
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
    purpose: {
      type: String,
      enum: ['SETUP', 'LOGIN', 'REPLACE'],
      required: true,
      index: true
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }
    },
    usedAt: {
      type: Date
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0
    },
    ip: {
      type: String
    },
    userAgent: {
      type: String
    }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AdminTwoFactorChallengeSchema.index({ userId: 1, purpose: 1, createdAt: -1 });

export const AdminTwoFactorChallengeModel =
  mongoose.models.AdminTwoFactorChallenge ||
  mongoose.model<IAdminTwoFactorChallenge>('AdminTwoFactorChallenge', AdminTwoFactorChallengeSchema);
