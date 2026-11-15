import mongoose, { Schema, Document } from 'mongoose';
import { OtpPurpose } from '../shared/auth';

export interface IOtpVerification extends Document {
  target: string; // email or normalized phone
  codeHash: string; // SHA-256 / hashed code for secure storage
  rawCodeDev?: string; // Only stored in development mode for automated tests
  purpose: OtpPurpose;
  expiresAt: Date;
  lastSentAt: Date;
  isUsed: boolean;
  attempts: number;
  ip?: string;
  createdAt: Date;
}

const OtpVerificationSchema = new Schema<IOtpVerification>({
  target: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  codeHash: {
    type: String,
    required: true
  },
  rawCodeDev: {
    type: String
  },
  purpose: {
    type: String,
    enum: Object.values(OtpPurpose),
    required: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 } // TTL index automatically cleans expired records
  },
  lastSentAt: {
    type: Date,
    default: Date.now
  },
  isUsed: {
    type: Boolean,
    default: false
  },
  attempts: {
    type: Number,
    default: 0
  },
  ip: {
    type: String
  }
}, {
  timestamps: { createdAt: true, updatedAt: false }
});

// Compound index for quick active lookup
OtpVerificationSchema.index({ target: 1, purpose: 1, isUsed: 1 });

export const OtpVerificationModel = mongoose.models.OtpVerification || mongoose.model<IOtpVerification>('OtpVerification', OtpVerificationSchema);
