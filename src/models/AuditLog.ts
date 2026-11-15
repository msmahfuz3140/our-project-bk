import mongoose, { Schema, Document } from 'mongoose';

export type AuditActionType =
  | 'USER_BLOCK'
  | 'USER_UNBLOCK'
  | 'USER_SUSPEND'
  | 'USER_PROFILE_EDIT'
  | 'USER_SOFT_DELETE'
  | 'SUBSCRIPTION_MANUAL_GRANT'
  | 'SUBSCRIPTION_EXTEND'
  | 'SUBSCRIPTION_REVOKE'
  | 'PLAN_PRICE_UPDATE'
  | 'MODERATOR_ROLE_CHANGE'
  | 'COMMISSION_CONFIG_UPDATE'
  | 'MANUAL_PAYMENT_RECONCILE'
  | 'DUAL_APPROVAL_REQUEST'
  | 'DUAL_APPROVAL_CONFIRM'
  | 'SECURITY_LOGIN'
  | 'MODERATOR_CREATE'
  | 'MODERATOR_STATUS_CHANGE'
  | 'MODERATOR_RESET_PASSWORD'
  | 'COMMISSION_POLICY_UPDATE'
  | 'COMMISSION_STATUS_CHANGE'
  | 'COMMISSION_ADJUSTMENT'
  | 'REFERRAL_ATTRIBUTION'
  | 'REFERRAL_FRAUD_FLAG'
  | 'TOOL_SETTINGS_UPDATE'
  | 'WEBSITE_SETTINGS_UPDATE'
  | 'PLAN_CONFIG_UPDATE'
  | 'BROADCAST_ANNOUNCEMENT'
  | 'FINANCIAL_PAYOUT'
  | 'MAIN_ADMIN_BOOTSTRAP';

export interface IAuditLog extends Document {
  action: AuditActionType;
  adminId: mongoose.Types.ObjectId;
  adminEmail: string;
  targetUserId?: mongoose.Types.ObjectId;
  targetUserEmail?: string;
  targetResourceId?: string;
  resourceType?: string;
  reason: string;
  previousValue?: any;
  newValue?: any;
  details?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>({
  action: {
    type: String,
    required: true,
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
  targetUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  targetUserEmail: {
    type: String
  },
  targetResourceId: {
    type: String,
    index: true
  },
  resourceType: {
    type: String
  },
  reason: {
    type: String,
    required: true
  },
  previousValue: {
    type: Schema.Types.Mixed
  },
  newValue: {
    type: Schema.Types.Mixed
  },
  details: {
    type: Schema.Types.Mixed
  },
  ipAddress: {
    type: String
  },
  userAgent: {
    type: String
  }
}, {
  timestamps: { createdAt: true, updatedAt: false } // Immutable: no updates allowed
});

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });
AuditLogSchema.index({ targetUserId: 1, createdAt: -1 });
AuditLogSchema.index({ adminId: 1, createdAt: -1 });

// Guard against tampering / modification
AuditLogSchema.pre('save', function (next) {
  if (!this.isNew) {
    next(new Error('Audit log entries are immutable and cannot be updated once created.'));
    return;
  }
  next();
});

AuditLogSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace'], function (next) {
  next(new Error('Audit log entries are immutable and cannot be updated.'));
});

export const AuditLogModel = mongoose.models.AuditLog || mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);
