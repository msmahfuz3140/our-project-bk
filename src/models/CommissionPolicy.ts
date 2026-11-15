import mongoose, { Schema, Document } from 'mongoose';

export interface ICommissionPolicy extends Document {
  defaultRate: number;              // Initial 50% = 0.50
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
      commissionableBasis: 'GROSS_CONFIRMED_SUBSCRIPTION_SALES_USD',
      description:
        'Commission base is exactly 50% of qualifying paid subscription purchases confirmed on-chain. Commissionable revenue excludes failed payments, unconfirmed transactions, refunded/reversed sales, and complimentary manual grants.',
      effectiveFrom: new Date(),
      auditReason: 'System initialization baseline'
    });
  }
  return policy;
};

export const CommissionPolicyModel =
  (mongoose.models.CommissionPolicy as CommissionPolicyModelType) ||
  mongoose.model<ICommissionPolicy, CommissionPolicyModelType>('CommissionPolicy', CommissionPolicySchema);
