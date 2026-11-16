import mongoose, { Schema, Document } from 'mongoose';

export interface ICommissionPolicy extends Document {
  defaultRate: number;              // Legacy/moderator default rate (0.50)
  normalUserRate: number;           // Normal user default one-time rate (0.30)
  moderatorRate?: number;           // Explicit moderator lifetime rate (defaults to defaultRate)
  normalUserCommissionType?: 'ONE_TIME';
  moderatorCommissionType?: 'LIFETIME';
  referralEnabled?: boolean;
  commissionableBasis: string;      // Explicit basis documentation
  description: string;
  updatedByAdminId?: mongoose.Types.ObjectId;
  updatedByAdminEmail?: string;
  auditReason?: string;
  effectiveFrom: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CommissionPolicySchema = new Schema<ICommissionPolicy>({
  defaultRate: {
    type: Number,
    required: true,
    default: 0.50,
    min: 0.0,
    max: 1.0
  },
  normalUserRate: {
    type: Number,
    default: 0.30,
    min: 0.0,
    max: 1.0
  },
  moderatorRate: {
    type: Number,
    min: 0.0,
    max: 1.0
  },
  normalUserCommissionType: {
    type: String,
    enum: ['ONE_TIME'],
    default: 'ONE_TIME'
  },
  moderatorCommissionType: {
    type: String,
    enum: ['LIFETIME'],
    default: 'LIFETIME'
  },
  referralEnabled: {
    type: Boolean,
    default: true
  },
  commissionableBasis: {
    type: String,
    required: true,
    default: 'GROSS_CONFIRMED_SUBSCRIPTION_SALES_USD'
  },
  description: {
    type: String,
    required: true,
    default:
      'Commission base is exactly 50% of qualifying paid subscription purchases confirmed on-chain. Commissionable revenue excludes failed payments, unconfirmed transactions, refunded/reversed sales, and complimentary manual grants.'
  },
  updatedByAdminId: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedByAdminEmail: {
    type: String
  },
  auditReason: {
    type: String
  },
  effectiveFrom: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

export interface CommissionPolicyModelType extends mongoose.Model<ICommissionPolicy> {
  getActivePolicy(): Promise<ICommissionPolicy>;
}

CommissionPolicySchema.statics.getActivePolicy = async function (): Promise<ICommissionPolicy> {
  let policy = await this.findOne().sort({ createdAt: -1 });
  if (!policy) {
    policy = await this.create({
      defaultRate: 0.50,
      normalUserRate: 0.30,
      moderatorRate: 0.50,
      normalUserCommissionType: 'ONE_TIME',
      moderatorCommissionType: 'LIFETIME',
      referralEnabled: true,
      commissionableBasis: 'GROSS_CONFIRMED_SUBSCRIPTION_SALES_USD',
      description:
        'Normal users earn a one-time 30% commission per referred customer; moderators earn a lifetime 50% commission on every eligible confirmed purchase. Commissionable revenue excludes failed, unconfirmed, refunded/reversed sales and complimentary manual grants.',
      effectiveFrom: new Date(),
      auditReason: 'System initialization baseline'
    });
  }
  return policy;
};

export const CommissionPolicyModel =
  (mongoose.models.CommissionPolicy as CommissionPolicyModelType) ||
  mongoose.model<ICommissionPolicy, CommissionPolicyModelType>('CommissionPolicy', CommissionPolicySchema);
