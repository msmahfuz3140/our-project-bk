import mongoose, { Schema, Document } from 'mongoose';

export type DualApprovalActionType =
  | 'ROLE_PROMOTION_SUPER_ADMIN'
  | 'GLOBAL_COMMISSION_OVERRIDE'
  | 'HIGH_VALUE_MANUAL_RECONCILIATION'
  | 'PLATFORM_OWNERSHIP_CHANGE';

export interface IDualApproval extends Document {
  action: DualApprovalActionType;
  requestedByAdminId: mongoose.Types.ObjectId;
  requestedByAdminEmail: string;
  confirmedByAdminId?: mongoose.Types.ObjectId;
  confirmedByAdminEmail?: string;
  targetUserId?: mongoose.Types.ObjectId;
  targetUserEmail?: string;
  reason: string;
  payload: Record<string, any>;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  rejectionReason?: string;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DualApprovalSchema = new Schema<IDualApproval>({
  action: {
    type: String,
    required: true,
    index: true
  },
  requestedByAdminId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  requestedByAdminEmail: {
    type: String,
    required: true
  },
  confirmedByAdminId: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  confirmedByAdminEmail: {
    type: String
  },
  targetUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  targetUserEmail: {
    type: String
  },
  reason: {
    type: String,
    required: true
  },
  payload: {
    type: Schema.Types.Mixed,
    required: true
  },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
    default: 'PENDING',
    index: true
  },
  rejectionReason: {
    type: String
  },
  resolvedAt: {
    type: Date
  }
}, {
  timestamps: true
});

export const DualApprovalModel =
  mongoose.models.DualApproval || mongoose.model<IDualApproval>('DualApproval', DualApprovalSchema);
