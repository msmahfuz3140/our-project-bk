import mongoose from 'mongoose';
import { env } from '../config/env';
import { PaymentModel, IPayment } from '../models/Payment';
import { SubscriptionModel, ISubscription } from '../models/Subscription';
import { UserModel, AccountStatus } from '../models/User';
import { FinancialLedgerModel } from '../models/FinancialLedger';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { CommissionPolicyModel } from '../models/CommissionPolicy';
import { subscriptionService } from './subscription.service';
import { nowPaymentsService } from './nowpayments.service';
import { notificationService } from './notification.service';
import {
  PaymentStatus,
  SubscriptionStatus,
  NowPaymentsIpnPayload,
  AdminPaymentFilterInput,
  AdminPaymentSummary
} from '../shared/subscriptions';
import { calculatePlanExpiration } from '../shared/plans';
import { generateRandomString } from '../utils/crypto';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import { UserRole } from '../shared/roles';

export interface CreateOrderResult {
  orderId: string;
  paymentId: string;
  planId: string;
  planName: string;
  priceUsd: number;
  priceCents: number;
  status: PaymentStatus;
  checkoutUrl: string;
  payAddress?: string;
  payAmount?: number;
  payCurrency: string;
  createdAt: string;
}

export interface ProcessIpnResult {
  success: boolean;
  orderId?: string;
  paymentId?: string;
  status: PaymentStatus;
  isFulfilled: boolean;
  duplicate?: boolean;
  subscriptionId?: string;
  message: string;
}

export class PaymentService {
  /**
   * Create a purchase order and initialize a NOWPayments invoice
   */
  async createPurchaseOrder(userId: string, planId: string, payCurrency = 'USDTTRC20'): Promise<CreateOrderResult> {
    const plan = await subscriptionService.getPlanById(planId);
    if (!plan) {
      throw ApiError.notFound(`Plan with id ${planId} does not exist`);
    }

    if (!plan.isActive) {
      throw ApiError.badRequest(`Plan ${plan.name} is currently inactive and cannot be purchased`);
    }

    const orderId = `ORD_${Date.now()}_${generateRandomString(6).toUpperCase()}`;
    let paymentId = `NP_${Date.now()}_${generateRandomString(8).toUpperCase()}`;
    const frontendUrl = env.PUBLIC_FRONTEND_URL;
    let checkoutUrl = `${frontendUrl}/checkout/pending?orderId=${orderId}`;
    let payAddress: string | undefined;
    let payAmount: number | undefined;

    // Contact NOWPayments API if API key is present
    if (env.NOWPAYMENTS_API_KEY && env.NOWPAYMENTS_API_KEY.trim() !== '') {
      try {
        const ipnUrl = env.NOWPAYMENTS_IPN_CALLBACK_URL || (env.BACKEND_URL ? `${env.BACKEND_URL}/api/v1/payments/ipn` : `http://localhost:${env.PORT}/api/v1/payments/ipn`);
        const invoice = await nowPaymentsService.createInvoice({
          priceAmount: plan.priceUsd,
          priceCurrency: 'USD',
          payCurrency: payCurrency.toLowerCase(),
          orderId,
          orderDescription: `Roulette Accuracy — ${plan.name} (${plan.durationDays} Days Access)`,
          ipnCallbackUrl: ipnUrl,
          successUrl: `${frontendUrl}/checkout/pending?orderId=${orderId}`,
          cancelUrl: `${frontendUrl}/plans`
        });

        if (invoice) {
          paymentId = String(invoice.id || invoice.payment_id || paymentId);
          if (invoice.invoice_url) {
            checkoutUrl = invoice.invoice_url;
          }
          if (invoice.pay_address) {
            payAddress = invoice.pay_address;
          }
          if (invoice.pay_amount) {
            payAmount = Number(invoice.pay_amount);
          }
        }
      } catch (err: any) {
        logger.error('Failed to create NOWPayments invoice, proceeding with order record', { error: err?.message });
      }
    }

    // Server-side referral attribution snapshotting (Never trust client-supplied codes)
    let referredByModeratorId: mongoose.Types.ObjectId | undefined;
    let referralCodeSnapshot: string | undefined;
    let commissionRateSnapshot: number | undefined;

    const userDoc = await UserModel.findById(userId);
    if (userDoc && userDoc.referredBy) {
      const moderatorDoc = await UserModel.findById(userDoc.referredBy);
      if (
        moderatorDoc &&
        moderatorDoc.role === UserRole.MODERATOR &&
        moderatorDoc.accountStatus === AccountStatus.ACTIVE &&
        !moderatorDoc.isDeleted
      ) {
        referredByModeratorId = moderatorDoc._id;
        referralCodeSnapshot = userDoc.referralCodeUsed || moderatorDoc.referralCode;
        const activePolicy = await CommissionPolicyModel.getActivePolicy();
        commissionRateSnapshot = moderatorDoc.moderatorCommissionRate ?? activePolicy.defaultRate ?? 0.50;
      }
    }

    // Persist immutable purchase order snapshot
    const payment = await PaymentModel.create({
      userId: new mongoose.Types.ObjectId(userId),
      planId: plan.id,
      planName: plan.name,
      priceCents: plan.priceCents,
      priceAmount: plan.priceUsd,
      priceCurrency: 'USD',
      duration: plan.duration,
      durationDays: plan.durationDays,
      payAmount,
      payCurrency: payCurrency.toUpperCase(),
      paymentId,
      orderId,
      status: PaymentStatus.WAITING,
      isFulfilled: false,
      payAddress,
      checkoutUrl,
      referredByModeratorId,
      referralCodeSnapshot,
      commissionRateSnapshot,
      ipnHistory: []
    });

    logger.info(`Purchase order created: ${orderId} for user ${userId} (Plan: ${plan.id}, Amount: $${plan.priceUsd})`);

    return {
      orderId: payment.orderId,
      paymentId: payment.paymentId,
      planId: payment.planId,
      planName: payment.planName,
      priceUsd: payment.priceAmount,
      priceCents: payment.priceCents,
      status: payment.status,
      checkoutUrl: payment.checkoutUrl || checkoutUrl,
      payAddress: payment.payAddress,
      payAmount: payment.payAmount,
      payCurrency: payment.payCurrency,
      createdAt: payment.createdAt.toISOString()
    };
  }

  /**
   * Process and verify NOWPayments IPN webhook callbacks
   */
  async processIpnCallback(
    payload: NowPaymentsIpnPayload,
    signature: string | undefined,
    customSecret?: string
  ): Promise<ProcessIpnResult> {
    if (!signature || signature.trim() === '') {
      logger.warn('IPN Callback rejected: Missing x-nowpayments-sig header');
      throw ApiError.unauthorized('Missing x-nowpayments-sig signature header');
    }

    // 1. Signature Verification
    const isValidSignature = nowPaymentsService.verifyIpnSignature(payload, signature, customSecret);
    if (!isValidSignature) {
      logger.warn('IPN Callback rejected: Cryptographic signature mismatch', {
        orderId: payload.order_id,
        paymentId: payload.payment_id
      });
      throw ApiError.unauthorized('Invalid IPN signature. Request origin cannot be verified.');
    }

    // 2. Order Matching
    const orderId = payload.order_id;
    const paymentId = String(payload.payment_id);

    const payment = await PaymentModel.findOne({
      $or: [{ orderId }, { paymentId }]
    });

    if (!payment) {
      logger.warn(`IPN Callback received for unknown order: ${orderId} (paymentId: ${paymentId})`);
      return {
        success: false,
        status: PaymentStatus.FAILED,
        isFulfilled: false,
        message: `Order reference ${orderId} was not found on this platform`
      };
    }

    // 3. Record Audit History
    const receivedStatus = (payload.payment_status || '').toLowerCase().trim();
    const actuallyPaid = payload.actually_paid !== undefined ? Number(payload.actually_paid) : payment.actuallyPaid;

    payment.ipnHistory.push({
      receivedAt: new Date(),
      paymentStatus: receivedStatus,
      actuallyPaid,
      rawPayload: payload
    });
    payment.rawIpnData = payload;
    payment.actuallyPaid = actuallyPaid;

    // 4. Server-Side Amount and Currency Validation
    const expectedAmount = payment.priceAmount;
    const reportedPriceAmount = Number(payload.price_amount);

    if (reportedPriceAmount && Math.abs(reportedPriceAmount - expectedAmount) > 0.05) {
      payment.status = PaymentStatus.REVIEW_REQUIRED;
      payment.failureReason = `Price amount mismatch: expected $${expectedAmount}, reported $${reportedPriceAmount}`;
      await payment.save();
      logger.error(`IPN Security Alert: Price mismatch on order ${payment.orderId}`, {
        expected: expectedAmount,
        reported: reportedPriceAmount
      });
      return {
        success: false,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        status: payment.status,
        isFulfilled: false,
        message: 'Security validation failed: Price amount mismatch'
      };
    }

    if (payload.price_currency && payload.price_currency.toUpperCase() !== payment.priceCurrency) {
      payment.status = PaymentStatus.REVIEW_REQUIRED;
      payment.failureReason = `Currency mismatch: expected ${payment.priceCurrency}, reported ${payload.price_currency}`;
      await payment.save();
      logger.error(`IPN Security Alert: Currency mismatch on order ${payment.orderId}`);
      return {
        success: false,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        status: payment.status,
        isFulfilled: false,
        message: 'Security validation failed: Price currency mismatch'
      };
    }

    // 5. Handle Terminal or Failure States
    if (receivedStatus === 'failed') {
      payment.status = PaymentStatus.FAILED;
      payment.failureReason = 'Payment failed on the blockchain';
      await payment.save();

      await notificationService.createNotification(
        payment.userId,
        'PAYMENT_FAILED',
        'Payment Failed',
        `Payment order ${payment.orderId} failed on the blockchain.`,
        '/plans'
      ).catch(() => null);
      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        status: PaymentStatus.FAILED,
        isFulfilled: false,
        message: 'Order marked as FAILED based on provider callback'
      };
    }

    if (receivedStatus === 'expired') {
      payment.status = PaymentStatus.EXPIRED;
      payment.failureReason = 'Payment window expired before full receipt';
      await payment.save();
      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        status: PaymentStatus.EXPIRED,
        isFulfilled: false,
        message: 'Order marked as EXPIRED'
      };
    }

    if (receivedStatus === 'refunded') {
      payment.status = PaymentStatus.REFUNDED;
      payment.failureReason = 'Payment was refunded';
      await payment.save();

      // Reverse any associated moderator commission
      await ReferralCommissionModel.updateMany(
        { paymentId: payment._id, status: { $ne: 'REVERSED' } },
        {
          status: 'REVERSED',
          reversalDetails: {
            reversedAt: new Date(),
            reason: 'Payment refunded via NOWPayments gateway IPN'
          }
        }
      );

      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        status: PaymentStatus.REFUNDED,
        isFulfilled: false,
        message: 'Order marked as REFUNDED'
      };
    }

    if (receivedStatus === 'partially_paid') {
      payment.status = PaymentStatus.PARTIALLY_PAID;
      payment.failureReason = `Underpayment received: actually paid ${actuallyPaid} ${payment.payCurrency}`;
      await payment.save();
      logger.warn(`Underpayment detected for order ${payment.orderId}`);
      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        status: PaymentStatus.PARTIALLY_PAID,
        isFulfilled: false,
        message: 'Order underpaid; held in PARTIALLY_PAID status without activation'
      };
    }

    // 6. Map In-Flight States
    if (receivedStatus === 'confirming') {
      payment.status = PaymentStatus.CONFIRMING;
      await payment.save();
      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        status: PaymentStatus.CONFIRMING,
        isFulfilled: false,
        message: 'Payment confirming on blockchain'
      };
    }

    if (receivedStatus === 'waiting') {
      payment.status = PaymentStatus.WAITING;
      await payment.save();
      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        status: PaymentStatus.WAITING,
        isFulfilled: false,
        message: 'Payment waiting for funds'
      };
    }

    // 7. Qualifying Payment States: 'finished' or 'confirmed'
    const isQualifyingState = receivedStatus === 'finished' || receivedStatus === 'confirmed';

    if (!isQualifyingState) {
      payment.status = PaymentStatus.WAITING;
      await payment.save();
      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        status: payment.status,
        isFulfilled: false,
        message: `Status ${receivedStatus} recorded; awaiting final qualifying state`
      };
    }

    // 8. Idempotency Check: Prevent duplicate activations
    if (payment.isFulfilled) {
      logger.info(`Duplicate IPN event for already fulfilled order ${payment.orderId}`);
      payment.status = PaymentStatus.FINISHED;
      await payment.save();
      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        status: PaymentStatus.FINISHED,
        isFulfilled: true,
        duplicate: true,
        subscriptionId: payment.subscriptionId?.toString(),
        message: 'Order was already fulfilled; duplicate callback processed safely without double-extension'
      };
    }

    // 9. Authoritative Subscription Activation & Renewal Rule
    const now = new Date();

    // Check if user currently has an ACTIVE subscription
    const existingActiveSub = await SubscriptionModel.findOne({
      userId: payment.userId,
      status: SubscriptionStatus.ACTIVE,
      isRevoked: { $ne: true },
      endDate: { $gt: now }
    }).sort({ endDate: -1 });

    let subscriptionStartDate: Date;
    let subscriptionEndDate: Date;

    if (existingActiveSub) {
      // RENEWAL RULE: Extend from the existing active subscription's expiry date
      subscriptionStartDate = existingActiveSub.endDate;
      subscriptionEndDate = calculatePlanExpiration(existingActiveSub.endDate, payment.duration);

      // Extend the existing active record so current session remains unbroken
      existingActiveSub.endDate = subscriptionEndDate;
      existingActiveSub.extendedAt = now;
      existingActiveSub.extensionReason = `Renewed via payment order ${payment.orderId}`;
      await existingActiveSub.save();

      logger.info(`Subscription renewed for user ${payment.userId}. Extended from ${subscriptionStartDate.toISOString()} to ${subscriptionEndDate.toISOString()}`);
    } else {
      // First-time or lapsed activation: Starts immediately from now
      subscriptionStartDate = now;
      subscriptionEndDate = calculatePlanExpiration(now, payment.duration);
    }

    // Record the paid subscription document
    const newSubscription = await SubscriptionModel.create({
      userId: payment.userId,
      planId: payment.planId,
      status: SubscriptionStatus.ACTIVE,
      startDate: subscriptionStartDate,
      endDate: subscriptionEndDate,
      paymentId: payment._id,
      providerPaymentId: payment.paymentId,
      isManualGrant: false,
      isApprovedByAdmin: true,
      approvedAt: now,
      isSecretCodeClaimed: true,
      secretCodeClaimedAt: now
    });

    // Mark payment as fulfilled
    payment.status = PaymentStatus.FINISHED;
    payment.isFulfilled = true;
    payment.subscriptionId = newSubscription._id as mongoose.Types.ObjectId;
    await payment.save();

    await notificationService.createNotification(
      payment.userId,
      'SUBSCRIPTION_ACTIVATED',
      'Payment Confirmed & Subscription Active',
      `Your payment of $${payment.priceAmount} for ${payment.planName} has been confirmed on the blockchain. Prediction feeds are live!`,
      '/dashboard/tool'
    ).catch(() => null);

    // 10. Record Immutable Financial Ledger Entry
    await FinancialLedgerModel.create({
      userId: payment.userId,
      orderId: payment.orderId,
      paymentId: payment.paymentId,
      subscriptionId: newSubscription._id,
      planId: payment.planId,
      type: 'SUBSCRIPTION_PURCHASE',
      amountCents: payment.priceCents,
      amountUsd: payment.priceAmount,
      payAmount: payment.payAmount,
      actuallyPaid,
      payCurrency: payment.payCurrency,
      status: 'SETTLED',
      notes: `Subscription payment confirmed via NOWPayments IPN (${receivedStatus})`
    });

    // 11. Moderator Referral Commission Attribution (Idempotent & Snapshot Guaranteed)
    const payingUser = await UserModel.findById(payment.userId);
    const targetModeratorId = payment.referredByModeratorId || (payingUser && payingUser.referredBy);

    if (targetModeratorId) {
      const moderatorUser = await UserModel.findById(targetModeratorId);
      if (
        moderatorUser &&
        moderatorUser.role === UserRole.MODERATOR &&
        moderatorUser.accountStatus === AccountStatus.ACTIVE &&
        !moderatorUser.isDeleted
      ) {
        // Safe check for duplicate webhooks
        const existingCommission = await ReferralCommissionModel.findOne({ paymentId: payment._id });
        if (!existingCommission) {
          const activePolicy = await CommissionPolicyModel.getActivePolicy();
          const rate = payment.commissionRateSnapshot ?? moderatorUser.moderatorCommissionRate ?? activePolicy.defaultRate ?? 0.50;
          const commissionableAmount = payment.priceAmount;
          const commissionAmountUsd = Math.round((commissionableAmount * rate) * 100) / 100;

          await ReferralCommissionModel.create({
            moderatorId: moderatorUser._id,
            referredUserId: payingUser!._id,
            subscriptionId: newSubscription._id,
            paymentId: payment._id,
            purchaseId: payment.orderId,
            subscriptionPlan: payment.planId,
            originalPurchaseAmount: payment.priceAmount,
            commissionableAmount,
            commissionRate: rate,
            amountUsd: commissionAmountUsd,
            status: 'CREDITED'
          });
          logger.info(`Moderator ${moderatorUser._id} credited $${commissionAmountUsd} (${rate * 100}%) commission for order ${payment.orderId}`);
        }
      }
    }

    logger.info(`Order ${payment.orderId} fulfilled successfully. Subscription ${newSubscription._id} active through ${subscriptionEndDate.toISOString()}`);

    return {
      success: true,
      orderId: payment.orderId,
      paymentId: payment.paymentId,
      status: PaymentStatus.FINISHED,
      isFulfilled: true,
      subscriptionId: newSubscription._id.toString(),
      message: 'Subscription successfully activated'
    };
  }

  /**
   * Get single order by orderId
   */
  async getOrder(orderId: string, userId: string, isSuperAdmin: boolean): Promise<IPayment> {
    const payment = await PaymentModel.findOne({ orderId });
    if (!payment) {
      throw ApiError.notFound(`Order ${orderId} was not found`);
    }

    if (payment.userId.toString() !== userId && !isSuperAdmin) {
      throw ApiError.forbidden('You are not authorized to view this purchase order');
    }

    return payment;
  }

  /**
   * Admin Payment Management: View, search, and filter orders
   */
  async getAdminOrders(filter: AdminPaymentFilterInput): Promise<{ orders: any[]; total: number; page: number; limit: number; totalPages: number }> {
    const page = Math.max(1, filter.page || 1);
    const limit = Math.min(100, Math.max(1, filter.limit || 20));
    const skip = (page - 1) * limit;

    const query: any = {};

    if (filter.status && (filter.status as string) !== 'ALL') {
      query.status = filter.status;
    }

    if (filter.planId && filter.planId !== 'ALL') {
      query.planId = filter.planId;
    }

    if (filter.startDate || filter.endDate) {
      query.createdAt = {};
      if (filter.startDate) query.createdAt.$gte = new Date(filter.startDate);
      if (filter.endDate) query.createdAt.$lte = new Date(filter.endDate);
    }

    if (filter.search && filter.search.trim() !== '') {
      const searchRegex = new RegExp(filter.search.trim(), 'i');
      const matchingUsers = await UserModel.find({
        $or: [{ email: searchRegex }, { name: searchRegex }, { phone: searchRegex }]
      }).select('_id');

      const userIds = matchingUsers.map(u => u._id);

      query.$or = [
        { orderId: searchRegex },
        { paymentId: searchRegex },
        { planName: searchRegex },
        { payAddress: searchRegex },
        { userId: { $in: userIds } }
      ];
    }

    const [orders, total] = await Promise.all([
      PaymentModel.find(query)
        .populate('userId', 'name email phone role')
        .populate('subscriptionId', 'status startDate endDate')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PaymentModel.countDocuments(query)
    ]);

    const normalizedOrders = orders.map((o: any) => ({
      ...o,
      paymentStatus: o.status,
      priceAmountUsd: o.priceAmount,
      payAmountCrypto: o.payAmount
    }));

    return {
      orders: normalizedOrders,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit))
    };
  }

  /**
   * Admin Payment Management: High-level financial summary
   */
  async getAdminSummary(): Promise<AdminPaymentSummary> {
    const [totalOrders, completedOrders, pendingOrders, failedOrders, reviewRequiredOrders, grossAgg] = await Promise.all([
      PaymentModel.countDocuments(),
      PaymentModel.countDocuments({ status: PaymentStatus.FINISHED }),
      PaymentModel.countDocuments({ status: { $in: [PaymentStatus.WAITING, PaymentStatus.CONFIRMING, PaymentStatus.SENDING] } }),
      PaymentModel.countDocuments({ status: { $in: [PaymentStatus.FAILED, PaymentStatus.EXPIRED] } }),
      PaymentModel.countDocuments({ status: { $in: [PaymentStatus.PARTIALLY_PAID, PaymentStatus.REVIEW_REQUIRED] } }),
      PaymentModel.aggregate([
        { $match: { isFulfilled: true } },
        { $group: { _id: null, totalUsd: { $sum: '$priceAmount' } } }
      ])
    ]);

    const totalGrossUsd = grossAgg.length > 0 ? grossAgg[0].totalUsd : 0;
    const paymentFeesUsd = Math.round(totalGrossUsd * 0.01 * 100) / 100;

    const commAgg = await PaymentModel.aggregate([
      { $match: { isFulfilled: true, referredByModeratorId: { $exists: true, $ne: null } } },
      { $group: { _id: null, totalUsd: { $sum: '$priceAmount' } } }
    ]);
    const eligibleReferredUsd = commAgg.length > 0 ? commAgg[0].totalUsd : 0;
    const commissionLiabilitiesUsd = Math.round(eligibleReferredUsd * 0.5 * 100) / 100;
    const netRevenueUsd = Math.max(0, Math.round((totalGrossUsd - paymentFeesUsd - commissionLiabilitiesUsd) * 100) / 100);

    return {
      totalGrossUsd,
      totalOrders,
      completedOrders,
      pendingOrders,
      failedOrders,
      reviewRequiredOrders,
      grossSalesUsd: totalGrossUsd,
      confirmedCount: completedOrders,
      pendingCount: pendingOrders,
      failedCount: failedOrders,
      paymentFeesUsd,
      outstandingCommissionLiabilitiesUsd: commissionLiabilitiesUsd,
      netRevenueUsd
    };
  }

  /**
   * Admin Payment Management: Export reconciliation report (JSON + CSV structure)
   */
  async exportAdminReport(startDate?: string, endDate?: string): Promise<{ csv: string; count: number; totalGrossUsd: number }> {
    const query: any = {};
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const orders = await PaymentModel.find(query)
      .populate('userId', 'name email')
      .sort({ createdAt: -1 });

    const headers = [
      'Order ID',
      'Payment ID',
      'Customer Email',
      'Customer Name',
      'Plan ID',
      'Plan Name',
      'Price USD',
      'Pay Currency',
      'Actually Paid',
      'Status',
      'Is Fulfilled',
      'Subscription ID',
      'Failure Reason',
      'Created At'
    ];

    let totalGrossUsd = 0;

    const rows = orders.map((o: any) => {
      if (o.isFulfilled) {
        totalGrossUsd += o.priceAmount;
      }
      return [
        o.orderId,
        o.paymentId,
        o.userId?.email || 'N/A',
        `"${(o.userId?.name || '').replace(/"/g, '""')}"`,
        o.planId,
        `"${o.planName.replace(/"/g, '""')}"`,
        o.priceAmount,
        o.payCurrency,
        o.actuallyPaid !== undefined ? o.actuallyPaid : '',
        o.status,
        o.isFulfilled ? 'YES' : 'NO',
        o.subscriptionId?.toString() || '',
        `"${(o.failureReason || '').replace(/"/g, '""')}"`,
        o.createdAt.toISOString()
      ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');

    return {
      csv,
      count: orders.length,
      totalGrossUsd
    };
  }
}

export const paymentService = new PaymentService();

