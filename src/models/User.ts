import mongoose, { Schema, Document } from 'mongoose';
import { UserRole } from '../shared/roles';

export enum AccountStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  BLOCKED = 'BLOCKED',
  DELETED = 'DELETED'
}

export interface IUser extends Document {
  name: string;
  email?: string;
  phone?: string;
  passwordHash: string;
  plainPassword?: string;
  role: UserRole;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  isActive: boolean;
  accountStatus: AccountStatus;
  suspendedUntil?: Date;
  statusReason?: string;
  statusChangedAt?: Date;
  statusChangedByAdminId?: mongoose.Types.ObjectId;
  isDeleted: boolean;
  deletedAt?: Date;
  deletionReason?: string;
  twoFactorEnabled: boolean;
  twoFactorSecret?: string;
  referralCode?: string;
  referredBy?: mongoose.Types.ObjectId;
  referredAt?: Date;
  referralCodeUsed?: string;
  moderatorCommissionRate?: number;
  moderatorNotes?: string;
  registrationIp?: string;
  lastLoginAt?: Date;
  sessionsRevokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>({
  name: {
    type: String,
    required: true,
    trim: true,
    default: 'Member'
  },
  email: {
    type: String,
    lowercase: true,
    trim: true,
    unique: true,
    sparse: true,
    index: true
  },
  phone: {
    type: String,
    trim: true,
    unique: true,
    sparse: true,
    index: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  plainPassword: {
    type: String,
    trim: true
  },
  role: {
    type: String,
    enum: Object.values(UserRole),
    default: UserRole.USER,
    index: true
  },
  isEmailVerified: {
    type: Boolean,
    default: false
  },
  isPhoneVerified: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: false // Activated after OTP verification
  },
  accountStatus: {
    type: String,
    enum: Object.values(AccountStatus),
    default: AccountStatus.ACTIVE,
    index: true
  },
  suspendedUntil: {
    type: Date
  },
  statusReason: {
    type: String
  },
  statusChangedAt: {
    type: Date
  },
  statusChangedByAdminId: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  isDeleted: {
    type: Boolean,
    default: false,
    index: true
  },
  deletedAt: {
    type: Date
  },
  deletionReason: {
    type: String
  },
  twoFactorEnabled: {
    type: Boolean,
    default: false
  },
  twoFactorSecret: {
    type: String
  },
  referralCode: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  referredBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  referredAt: {
    type: Date
  },
  referralCodeUsed: {
    type: String,
    index: true
  },
  moderatorCommissionRate: {
    type: Number,
    min: 0.0,
    max: 1.0
  },
  moderatorNotes: {
    type: String
  },
  registrationIp: {
    type: String
  },
  lastLoginAt: {
    type: Date
  },
  sessionsRevokedAt: {
    type: Date
  }
}, {
  timestamps: true
});

UserSchema.index({ isDeleted: 1, accountStatus: 1, isActive: 1 });
UserSchema.index({ role: 1, isDeleted: 1 });
UserSchema.index({ role: 1, accountStatus: 1 });
UserSchema.index({ isDeleted: 1, accountStatus: 1, role: 1, createdAt: -1 });
UserSchema.index({ createdAt: -1 });
UserSchema.index({ isDeleted: 1, createdAt: -1 });
UserSchema.index({ referredBy: 1, isDeleted: 1 });

export const UserModel = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
