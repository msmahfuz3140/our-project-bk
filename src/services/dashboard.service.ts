import mongoose from 'mongoose';
import { UserModel } from '../models/User';
import { SubscriptionModel } from '../models/Subscription';
import { PaymentModel } from '../models/Payment';
import { NotificationModel } from '../models/Notification';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { ReferralClickModel } from '../models/ReferralClick';
import { PlanModel } from '../models/Plan';
import { seedPlansIfEmpty } from '../models/Plan';
import { UserRole } from '../shared/roles';
import { SubscriptionStatus } from '../shared/subscriptions';
import { subscriptionAccessService } from './subscriptionAccess.service';
import { toolSettingsService } from './toolSettings.service';
import { cacheKeys, memoryCache } from '../utils/cache';
import { ApiError } from '../utils/apiError';

export class DashboardService {
  /**
   * One aggregated response for the member dashboard. Replaces several
   * independent requests (profile, access, subscription, payments,
   * notifications, referrals) with one cacheable snapshot.
   */
  async getMemberDashboard(userId: string): Promise<any> {
    return memoryCache.getOrSet(cacheKeys.userDashboard(userId), 15, async () => {
      const uid = new mongoose.Types.ObjectId(userId);
      const now = new Date();
      await seedPlansIfEmpty();

      const [
        user,
        activeSubscription,
        subscriptionHistory,
        paymentAgg,
        recentPayments,
        unreadNotifications,
        recentNotifications,
        commissionsAgg,
        referralClicks,
        referredUsers,
        plans,
        access,
        toolStatus
      ]: any[] = await Promise.all([
        UserModel.findById(uid)
          .select('name email phone role isEmailVerified isPhoneVerified isActive accountStatus referralCode referredBy createdAt lastLoginAt')
          .lean(),
        SubscriptionModel.findOne({
          userId: uid,
          status: SubscriptionStatus.ACTIVE,
          isRevoked: { $ne: true },
          endDate: { $gt: now }
        }).sort({ endDate: -1 }).lean(),
        SubscriptionModel.find({ userId: uid })
          .sort({ endDate: -1 })
          .limit(10)
          .select('planId status startDate endDate isRevoked isManualGrant orderId createdAt')
          .lean(),
        PaymentModel.aggregate([
          { $match: { userId: uid } },
          {
            $group: {
              _id: null,
              totalPayments: { $sum: 1 },
              successfulPayments: {
                $sum: {
                  $cond: [
                    { $and: [{ $eq: ['$isFulfilled', true] }, { $ne: ['$status', 'REFUNDED'] }] },
                    1,
                    0
                  ]
                }
              },
              totalSpentUsd: {
                $sum: {
                  $cond: [
                    { $and: [{ $eq: ['$isFulfilled', true] }, { $ne: ['$status', 'REFUNDED'] }] },
                    '$priceAmount',
                    0
                  ]
                }
              },
              lastPaymentAt: { $max: '$createdAt' }
            }
          }
        ]),
        PaymentModel.find({ userId: uid })
          .sort({ createdAt: -1 })
          .limit(5)
          .select('orderId paymentId providerPaymentId planName planId priceAmount priceCents priceCurrency payCurrency payAmount actuallyPaid status providerStatus verified isFulfilled paidAt transactionId createdAt updatedAt')
          .lean(),
        NotificationModel.countDocuments({ userId: uid, isRead: false }),
        NotificationModel.find({ userId: uid })
          .sort({ createdAt: -1 })
          .limit(5)
          .select('type title message isRead link createdAt')
          .lean(),
        ReferralCommissionModel.aggregate([
          { $match: { moderatorId: uid } },
          {
            $group: {
              _id: '$status',
              totalUsd: { $sum: '$amountUsd' },
              count: { $sum: 1 }
            }
          }
        ]),
        ReferralClickModel.countDocuments({ moderatorId: uid }),
        UserModel.countDocuments({ referredBy: uid, isDeleted: { $ne: true } }),
        PlanModel.find().select('planId name priceCents duration durationDays').lean(),
        subscriptionAccessService.checkAccess(userId),
        toolSettingsService.getPublicToolStatus()
      ]);

      if (!user) {
        throw ApiError.notFound('Member account not found');
      }

      const planMap = new Map<string, any>();
      for (const plan of plans) {
        planMap.set(plan.planId, plan);
      }

      const commissionSummary = {
        pendingUsd: 0,
        eligibleUsd: 0,
        approvedUsd: 0,
        reversedUsd: 0,
        creditedCount: 0
      };
      for (const row of commissionsAgg) {
        const amount = Math.round((row.totalUsd || 0) * 100) / 100;
        if (row._id === 'PENDING') commissionSummary.pendingUsd = amount;
        else if (row._id === 'ELIGIBLE') commissionSummary.eligibleUsd = amount;
        else if (row._id === 'APPROVED' || row._id === 'CREDITED') {
          commissionSummary.approvedUsd += amount;
          commissionSummary.creditedCount += row.count || 0;
        } else if (row._id === 'REVERSED') commissionSummary.reversedUsd = amount;
      }

      const paymentTotals = paymentAgg[0] || {
        totalPayments: 0,
        successfulPayments: 0,
        totalSpentUsd: 0,
        lastPaymentAt: null
      };

      return {
        profile: {
          id: user._id.toString(),
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          isEmailVerified: user.isEmailVerified,
          isPhoneVerified: user.isPhoneVerified,
          isActive: user.isActive,
          accountStatus: user.accountStatus,
          referralCode: user.referralCode,
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt
        },
        access,
        subscription: activeSubscription
          ? {
              ...activeSubscription,
              id: activeSubscription._id.toString(),
              planName: planMap.get(activeSubscription.planId)?.name || activeSubscription.planId,
              daysRemaining: Math.max(
                0,
                Math.ceil((new Date(activeSubscription.endDate).getTime() - now.getTime()) / 86_400_000)
              )
            }
          : null,
        subscriptionHistory: subscriptionHistory.map((sub: any) => ({
          ...sub,
          id: sub._id.toString(),
          planName: planMap.get(sub.planId)?.name || sub.planId
        })),
        paymentSummary: {
          totalPayments: paymentTotals.totalPayments || 0,
          successfulPayments: paymentTotals.successfulPayments || 0,
          totalSpentUsd: Math.round((paymentTotals.totalSpentUsd || 0) * 100) / 100,
          lastPaymentAt: paymentTotals.lastPaymentAt || null
        },
        recentPayments: recentPayments.map((payment: any) => ({
          ...payment,
          id: payment._id.toString(),
          premiumActivated: Boolean(payment.isFulfilled)
        })),
        notifications: {
          unreadCount: unreadNotifications,
          recent: recentNotifications
        },
        referral: {
          isModerator: user.role === UserRole.MODERATOR,
          referredUsers,
          clicks: referralClicks,
          commissions: commissionSummary
        },
        tool: toolStatus,
        generatedAt: new Date().toISOString()
      };
    });
  }
}

export const dashboardService = new DashboardService();
