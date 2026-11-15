import mongoose, { Schema, Document } from 'mongoose';

export interface IReferralClick extends Document {
  referralCode: string;
  moderatorId?: mongoose.Types.ObjectId;
  landingPath: string;
  referrer?: string;
  ipHash?: string;
  userAgent?: string;
  createdAt: Date;
}

const ReferralClickSchema = new Schema<IReferralClick>({
  referralCode: {
    type: String,
    required: true,
    uppercase: true,
    trim: true,
    index: true
  },
  moderatorId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    sparse: true
  },
  landingPath: {
    type: String,
    required: true,
    maxlength: 500
  },
  referrer: {
    type: String,
    maxlength: 1000
  },
  ipHash: {
    type: String,
    index: true
  },
  userAgent: {
    type: String,
    maxlength: 500
  },
  createdAt: {
    type: Date,
    default: Date.now,
    // Affiliate click telemetry is retained for 180 days.
    expires: 60 * 60 * 24 * 180
  }
});

ReferralClickSchema.index({ moderatorId: 1, createdAt: -1 });
ReferralClickSchema.index({ referralCode: 1, createdAt: -1 });

export const ReferralClickModel =
  mongoose.models.ReferralClick || mongoose.model<IReferralClick>('ReferralClick', ReferralClickSchema);
