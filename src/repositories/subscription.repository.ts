import { SubscriptionModel, ISubscription } from '../models/Subscription';
import { SubscriptionStatus } from '../shared/subscriptions';
import mongoose from 'mongoose';

export class SubscriptionRepository {
  async findActiveByUserId(userId: string | mongoose.Types.ObjectId): Promise<ISubscription | null> {
    const now = new Date();
    return SubscriptionModel.findOne({
      userId,
      status: SubscriptionStatus.ACTIVE,
      endDate: { $gt: now }
    }).sort({ endDate: -1 });
  }

  async findByUserId(userId: string | mongoose.Types.ObjectId): Promise<ISubscription[]> {
    return SubscriptionModel.find({ userId }).sort({ createdAt: -1 });
  }

  async create(data: {
    userId: mongoose.Types.ObjectId;
    planId: string;
    status: SubscriptionStatus;
    startDate: Date;
    endDate: Date;
    paymentId?: mongoose.Types.ObjectId;
  }): Promise<ISubscription> {
    return SubscriptionModel.create(data);
  }

  async updateStatus(id: string, status: SubscriptionStatus): Promise<ISubscription | null> {
    return SubscriptionModel.findByIdAndUpdate(id, { $set: { status } }, { new: true });
  }
}

export const subscriptionRepository = new SubscriptionRepository();
