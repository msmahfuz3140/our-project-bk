import mongoose, { Schema, Document } from 'mongoose';
import { PlanDuration, SubscriptionPlan, SUBSCRIPTION_PLANS, PLANS_ARRAY } from '../shared/plans';

export interface IPlanDocument extends Document {
  planId: string;
  name: string;
  badge?: string;
  description: string;
  priceCents: number;
  duration: PlanDuration;
  durationDays: number;
  features: string[];
  isPopular: boolean;
  isActive: boolean;
  isVisible: boolean;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const PlanSchema = new Schema<IPlanDocument>({
  planId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  badge: {
    type: String
  },
  description: {
    type: String,
    required: true
  },
  priceCents: {
    type: Number,
    required: true,
    min: 100 // At least $1.00
  },
  duration: {
    unit: {
      type: String,
      enum: ['DAYS', 'MONTHS'],
      required: true
    },
    value: {
      type: Number,
      required: true,
      min: 1
    }
  },
  durationDays: {
    type: Number,
    required: true
  },
  features: {
    type: [String],
    default: []
  },
  isPopular: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  isVisible: {
    type: Boolean,
    default: true,
    index: true
  },
  displayOrder: {
    type: Number,
    default: 0,
    index: true
  }
}, {
  timestamps: true
});

PlanSchema.index({ isVisible: 1, isActive: 1, displayOrder: 1 });

export const PlanModel = mongoose.models.Plan || mongoose.model<IPlanDocument>('Plan', PlanSchema);

let plansSeeded = false;

/**
 * Ensures initial 5 authoritative plans exist in the database.
 * Only executes query once per process lifetime.
 */
export async function seedPlansIfEmpty(): Promise<void> {
  if (plansSeeded) return;
  const count = await PlanModel.countDocuments();
  if (count === 0) {
    let order = 0;
    for (const plan of PLANS_ARRAY) {
      await PlanModel.create({
        planId: plan.id,
        name: plan.name,
        badge: plan.badge,
        description: plan.description,
        priceCents: plan.priceCents,
        duration: plan.duration,
        durationDays: plan.durationDays,
        features: plan.features,
        isPopular: !!plan.isPopular,
        isActive: plan.isActive,
        isVisible: plan.isVisible,
        displayOrder: order++
      });
    }
  }
  plansSeeded = true;
}

