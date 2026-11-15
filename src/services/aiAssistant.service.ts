import { PaymentModel } from '../models/Payment';
import { SubscriptionModel } from '../models/Subscription';
import { UserModel } from '../models/User';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { AuditLogModel } from '../models/AuditLog';
import { OtpVerificationModel } from '../models/OtpVerification';
import { PLANS_ARRAY } from '../shared/plans';

export interface AiQueryResult {
  answer: string;
  category: 'SALES' | 'PLANS' | 'EXPIRY' | 'MODERATORS' | 'PAYMENTS' | 'SECURITY' | 'FINANCIAL' | 'GENERAL';
  dataSummary: Record<string, any>;
  isReadOnlyEnforced: boolean;
  generatedAt: string;
}

export class AiAssistantService {
  /**
   * Process read-only natural language business inquiries for Main Admins
   */
  async processQuery(queryText: string): Promise<AiQueryResult> {
    const q = queryText.toLowerCase().trim();

    // Strict mutation blocker
    const forbiddenMutations = ['delete', 'remove', 'revoke', 'ban', 'block', 'promote', 'approve', 'drop', 'insert', 'update', 'modify'];
    const containsMutation = forbiddenMutations.some(w => q.includes(w) && (q.includes('user') || q.includes('payment') || q.includes('sub') || q.includes('role')));

    if (containsMutation) {
      return {
        answer: 'SECURITY ENFORCEMENT: The AI Admin Assistant operates exclusively in strict read-only mode. It cannot perform mutations, approve payments, delete users, change roles, or revoke subscriptions. Please use the authorized Admin Panel consoles with dual-approval verification where required.',
        category: 'GENERAL',
        dataSummary: { error: 'MUTATION_ATTEMPT_BLOCKED' },
        isReadOnlyEnforced: true,
        generatedAt: new Date().toISOString()
      };
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // 1. Confirmed subscriptions sold this month
    if (q.includes('sold this month') || (q.includes('subscription') && q.includes('month'))) {
      const paymentsThisMonth = await PaymentModel.find({
        status: 'FINISHED',
        isFulfilled: true,
        createdAt: { $gte: startOfMonth }
      });

      const totalSalesUsd = paymentsThisMonth.reduce((sum, p) => sum + p.priceAmount, 0);

      return {
        answer: `During the current calendar month (${now.toLocaleString('default', { month: 'long', year: 'numeric' })}), exactly ${paymentsThisMonth.length} confirmed subscriptions have been fulfilled, generating $${totalSalesUsd.toFixed(2)} USD in gross sales. All purchases are backed by confirmed blockchain settlements.`,
        category: 'SALES',
        dataSummary: {
          confirmedSalesCount: paymentsThisMonth.length,
          grossSalesUsd: totalSalesUsd,
          timeframe: 'Current Calendar Month'
        },
        isReadOnlyEnforced: true,
        generatedAt: now.toISOString()
      };
    }

    // 2. Which plan is most popular?
    if (q.includes('popular') || q.includes('best selling') || q.includes('most plan')) {
      const planAgg = await SubscriptionModel.aggregate([
        { $group: { _id: '$planId', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);

      if (planAgg.length === 0) {
        return {
          answer: 'There are currently no active subscriptions recorded in the database to determine popularity.',
          category: 'PLANS',
          dataSummary: {},
          isReadOnlyEnforced: true,
          generatedAt: now.toISOString()
        };
      }

      const topPlanId = planAgg[0]._id;
      const topCount = planAgg[0].count;
      const matchingPlan = PLANS_ARRAY.find(p => p.id === topPlanId);
      const planName = matchingPlan ? matchingPlan.name : topPlanId;

      return {
        answer: `The most popular tier is "${planName}" with ${topCount} total activations recorded, followed by ${planAgg.slice(1).map(p => `${p._id} (${p.count})`).join(', ') || 'no other tiers'}.`,
        category: 'PLANS',
        dataSummary: { topPlanId, topCount, distribution: planAgg },
        isReadOnlyEnforced: true,
        generatedAt: now.toISOString()
      };
    }

    // 3. Subscriptions expiring within 7 days
    if (q.includes('expire') && (q.includes('7') || q.includes('seven') || q.includes('week') || q.includes('soon'))) {
      const expiringSubs = await SubscriptionModel.find({
        status: 'ACTIVE',
        isRevoked: { $ne: true },
        endDate: { $gte: now, $lte: in7Days }
      }).populate('userId', 'email name');

      return {
        answer: `Exactly ${expiringSubs.length} active subscription(s) will reach their expiration date within the next 7 days (by ${in7Days.toLocaleDateString()}). You can notify these users via the In-App Announcements console.`,
        category: 'EXPIRY',
        dataSummary: {
          expiringCount: expiringSubs.length,
          targetCutoff: in7Days.toISOString(),
          usersAffected: expiringSubs.map(s => (s.userId as any)?.email).filter(Boolean).slice(0, 5)
        },
        isReadOnlyEnforced: true,
        generatedAt: now.toISOString()
      };
    }

    // 4. Top moderator by confirmed sales
    if (q.includes('moderator') || q.includes('affiliate') || q.includes('referral sales')) {
      const commissions = await ReferralCommissionModel.find({ status: { $ne: 'REVERSED' } })
        .populate('moderatorId', 'name email referralCode')
        .populate('paymentId', 'priceAmount');

      const modTotals: Record<string, { name: string; email: string; totalSalesUsd: number; count: number }> = {};

      for (const c of commissions as any[]) {
        if (!c.moderatorId) continue;
        const modId = c.moderatorId._id.toString();
        if (!modTotals[modId]) {
          modTotals[modId] = {
            name: c.moderatorId.name || 'Moderator',
            email: c.moderatorId.email || 'N/A',
            totalSalesUsd: 0,
            count: 0
          };
        }
        modTotals[modId].count++;
        if (c.paymentId && c.paymentId.priceAmount) {
          modTotals[modId].totalSalesUsd += c.paymentId.priceAmount;
        }
      }

      const sortedMods = Object.values(modTotals).sort((a, b) => b.totalSalesUsd - a.totalSalesUsd);

      if (sortedMods.length === 0) {
        return {
          answer: 'No attributed referral sales have been credited to moderators yet.',
          category: 'MODERATORS',
          dataSummary: {},
          isReadOnlyEnforced: true,
          generatedAt: now.toISOString()
        };
      }

      const top = sortedMods[0];
      return {
        answer: `The top-performing moderator is ${top.name} (${top.email}) with ${top.count} attributed confirmed subscription sales totaling $${top.totalSalesUsd.toFixed(2)} USD in eligible customer volume.`,
        category: 'MODERATORS',
        dataSummary: { topModerator: top, totalModeratorsWithSales: sortedMods.length },
        isReadOnlyEnforced: true,
        generatedAt: now.toISOString()
      };
    }

    // 5. How many payments are pending?
    if (q.includes('pending') || q.includes('waiting') || q.includes('unconfirmed')) {
      const pendingCount = await PaymentModel.countDocuments({
        status: { $in: ['WAITING', 'CONFIRMING', 'SENDING'] }
      });

      const failedCount = await PaymentModel.countDocuments({
        status: { $in: ['FAILED', 'EXPIRED'] }
      });

      return {
        answer: `There are currently ${pendingCount} pending cryptocurrency payment transaction(s) awaiting blockchain confirmations or customer deposit. An additional ${failedCount} order(s) have lapsed or failed.`,
        category: 'PAYMENTS',
        dataSummary: { pendingCount, failedCount },
        isReadOnlyEnforced: true,
        generatedAt: now.toISOString()
      };
    }

    // 6. Security alerts in last 24 hours
    if (q.includes('security') || q.includes('alert') || q.includes('audit')) {
      const [otpAlerts, auditCount] = await Promise.all([
        OtpVerificationModel.countDocuments({ attempts: { $gte: 3 }, createdAt: { $gte: last24h } }),
        AuditLogModel.countDocuments({ createdAt: { $gte: last24h } })
      ]);

      return {
        answer: `In the last 24 hours, ${otpAlerts} OTP verification attempt(s) triggered repeated attempt thresholds (>= 3 attempts), and ${auditCount} administrative actions were immutably recorded in the security audit ledger.`,
        category: 'SECURITY',
        dataSummary: { otpAlertsLast24h: otpAlerts, auditLogsLast24h: auditCount },
        isReadOnlyEnforced: true,
        generatedAt: now.toISOString()
      };
    }

    // Default overview response
    const [userCount, subCount, finishedPayments] = await Promise.all([
      UserModel.countDocuments({ isDeleted: { $ne: true } }),
      SubscriptionModel.countDocuments({ status: 'ACTIVE', isRevoked: { $ne: true }, endDate: { $gt: now } }),
      PaymentModel.find({ status: 'FINISHED' })
    ]);

    const grossSalesUsd = finishedPayments.reduce((acc, p) => acc + p.priceAmount, 0);

    return {
      answer: `Platform Summary: The platform currently serves ${userCount} registered members with ${subCount} active premium subscribers. Cumulative gross confirmed sales stand at $${grossSalesUsd.toFixed(2)} USD across ${finishedPayments.length} fulfilled orders. You can ask specific questions regarding sales, expiring subscriptions, plan popularity, moderators, or security alerts.`,
      category: 'GENERAL',
      dataSummary: {
        totalUsers: userCount,
        activeSubscriptions: subCount,
        grossSalesUsd
      },
      isReadOnlyEnforced: true,
      generatedAt: now.toISOString()
    };
  }
}

export const aiAssistantService = new AiAssistantService();
