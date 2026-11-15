import mongoose, { Schema, Document } from 'mongoose';

export type SecurityEventType =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILED'
  | 'LOGIN_BLOCKED'
  | 'ACCOUNT_REGISTERED'
  | 'PASSWORD_RESET'
  | 'PASSWORD_CHANGED'
  | 'SESSION_REVOKED'
  | 'ACCOUNT_BLOCKED'
  | 'ACCOUNT_UNBLOCKED'
  | 'ROLE_CHANGED'
  | 'SUSPICIOUS_REQUEST';

export interface ISecurityLog extends Document {
  userId?: mongoose.Types.ObjectId;
  email?: string;
  eventType: SecurityEventType;
  success: boolean;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const SecurityLogSchema = new Schema<ISecurityLog>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    sparse: true
  },
  email: {
    type: String,
    lowercase: true,
    trim: true,
    index: true
  },
  eventType: {
    type: String,
    enum: [
      'LOGIN_SUCCESS',
      'LOGIN_FAILED',
      'LOGIN_BLOCKED',
      'ACCOUNT_REGISTERED',
      'PASSWORD_RESET',
      'PASSWORD_CHANGED',
      'SESSION_REVOKED',
      'ACCOUNT_BLOCKED',
      'ACCOUNT_UNBLOCKED',
      'ROLE_CHANGED',
      'SUSPICIOUS_REQUEST'
    ],
    required: true,
    index: true
  },
  success: {
    type: Boolean,
    default: true,
    index: true
  },
  ip: {
    type: String
  },
  userAgent: {
    type: String,
    maxlength: 500
  },
  metadata: {
    type: Schema.Types.Mixed
  },
  createdAt: {
    type: Date,
    default: Date.now,
    // Security history is retained for 180 days, then automatically pruned.
    expires: 60 * 60 * 24 * 180
  }
});

SecurityLogSchema.index({ createdAt: -1 });
SecurityLogSchema.index({ eventType: 1, createdAt: -1 });
SecurityLogSchema.index({ email: 1, createdAt: -1 });

export const SecurityLogModel =
  mongoose.models.SecurityLog || mongoose.model<ISecurityLog>('SecurityLog', SecurityLogSchema);
