import mongoose from 'mongoose';
import { env, validatePaymentEnvironment, isProductionRuntime } from '../config/env';
import { PaymentModel, IPayment } from '../models/Payment';
import { PaymentEventModel } from '../models/PaymentEvent';
import { SubscriptionModel, ISubscription } from '../models/Subscription';
import { UserModel, AccountStatus } from '../models/User';
import { FinancialLedgerModel } from '../models/FinancialLedger';
import { CommissionPolicyModel } from '../models/CommissionPolicy';
import { AuditLogModel } from '../models/AuditLog';
import { subscriptionService } from './subscription.service';
import { websiteSettingsService } from './websiteSettings.service';
import { commissionService, normalizeCommissionRate } from './commission.service';
import { nowPaymentsService, NowPaymentsApiError } from './nowpayments.service';
import { notificationService } from './notification.service';
import { getPaymentIndexStatus } from '../database/ensureIndexes';
import {
  PaymentStatus,
  SubscriptionStatus,
  NowPaymentsIpnPayload,
  AdminPaymentFilterInput,
  AdminPaymentSummary,
  PaymentHistoryDTO
} from '../shared/subscriptions';
import { calculatePlanExpiration, formatCentsToUsd } from '../shared/plans';
import { generateRandomString } from '../utils/crypto';
import { cacheKeys, invalidatePaymentCaches, memoryCache } from '../utils/cache';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import { UserRole } from '../shared/roles';

export interface CreateOrderResult {
  orderId: string;
  paymentId: string;
  providerPaymentId?: string;
  providerInvoiceId?: string;
  planId: string;
  planName: string;
  priceUsd: number;
  priceCents: number;
  status: PaymentStatus;
  checkoutUrl: string;
  payAddress?: string;
  payAmount?: number;
  payCurrency: string;
  network?: string;
  paymentMode: 'LIVE' | 'SANDBOX' | 'SIMULATION';
  simulated: boolean;
  expiresAt?: string;
  createdAt: string;
}

export interface ProcessIpnResult {
  success: boolean;
  orderId?: string;
  paymentId?: string;
  providerPaymentId?: string;
  eventId?: string;
  status: PaymentStatus;
  isFulfilled: boolean;
  duplicate?: boolean;
  ignored?: boolean;
  providerVerified?: boolean;
  subscriptionId?: string;
  message: string;
}

const PROVIDER_STATUS_MAP: Record<string, PaymentStatus> = {
  waiting: PaymentStatus.WAITING,
  confirming: PaymentStatus.CONFIRMING,
  confirmed: PaymentStatus.CONFIRMED,
  sending: PaymentStatus.SENDING,
  partially_paid: PaymentStatus.PARTIALLY_PAID,
  finished: PaymentStatus.FINISHED,
  failed: PaymentStatus.FAILED,
  expired: PaymentStatus.EXPIRED,
  refunded: PaymentStatus.REFUNDED
};

const PROCESSING_LOCK_MS = 2 * 60 * 1000;
const PRICE_TOLERANCE_USD = 0.05;
const PAY_AMOUNT_TOLERANCE = 0.005; // 0.5% blockchain rounding tolerance
const MAX_IPN_HISTORY = 100;

function appendOrderId(baseUrl: string, orderId: string): string {
  try {
    const url = new URL(baseUrl);
    if (!url.searchParams.has('orderId')) {
      url.searchParams.set('orderId', orderId);
    }
    return url.toString();
  } catch {
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}orderId=${encodeURIComponent(orderId)}`;
  }
}

function asFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export class PaymentService {
  /**
   * Create a purchase order and initialize a NOWPayments hosted invoice.
   *
   * SECURITY: price and duration are always read from the database plan. The
   * frontend only supplies a plan identifier and an optional preferred coin.
   */
  async createPurchaseOrder(userId: string, planId: string, payCurrency = 'USDTTRC20'): Promise<CreateOrderResult> {
    const plan = await subscriptionService.getPlanById(planId);
    if (!plan) {
      throw ApiError.notFound(`Plan with id ${planId} does not exist`);
    }

    if (!plan.isActive) {
      throw ApiError.badRequest(`Plan ${plan.name} is currently inactive and cannot be purchased`);
    }

    const { minPlanPriceCents } = await websiteSettingsService.getPaymentSettings();
    if (plan.priceCents < minPlanPriceCents) {
      throw new ApiError(
        400,
        `This plan is below the platform minimum of ${formatCentsToUsd(minPlanPriceCents)}. Please contact support or choose another plan.`,
        'PLAN_BELOW_MINIMUM'
      );
    }

    const normalizedPayCurrency = String(payCurrency || 'USDTTRC20')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');

    if (!/^[A-Z0-9]{2,20}$/.test(normalizedPayCurrency)) {
      throw ApiError.badRequest('Invalid cryptocurrency payment currency');
    }

    const orderId = `ORD_${Date.now()}_${generateRandomString(6).toUpperCase()}`;
    const isProduction = isProductionRuntime;

    // Server-side referral attribution snapshotting. Never trust client codes.
    let referredByModeratorId: mongoose.Types.ObjectId | undefined;
    let referralCodeSnapshot: string | undefined;
    let commissionRateSnapshot: number | undefined;
    let referralCommissionTypeSnapshot: 'ONE_TIME' | 'LIFETIME' | undefined;
    let referralCommissionEligibleSnapshot = false;

    const userDoc = await UserModel.findById(userId);
    if (userDoc && userDoc.referredBy) {
      const referrerDoc = await UserModel.findById(userDoc.referredBy);
      if (
        referrerDoc &&
        referrerDoc.accountStatus === AccountStatus.ACTIVE &&
        referrerDoc.referralEligible !== false &&
        !referrerDoc.isDeleted
      ) {
        const activePolicy = await CommissionPolicyModel.getActivePolicy();
        if (activePolicy.referralEnabled !== false) {
          const isModerator = referrerDoc.role === UserRole.MODERATOR;
          referredByModeratorId = referrerDoc._id;
          referralCodeSnapshot = userDoc.referralCodeUsed || referrerDoc.referralCode;
          referralCommissionTypeSnapshot =
            referrerDoc.referralCommissionType || (isModerator ? 'LIFETIME' : 'ONE_TIME');
          commissionRateSnapshot =
            referrerDoc.referralCommissionRate !== undefined
              ? normalizeCommissionRate(referrerDoc.referralCommissionRate)
              : normalizeCommissionRate(
                  isModerator
                    ? referrerDoc.moderatorCommissionRate ??
                      activePolicy.moderatorRate ??
                      activePolicy.defaultRate ??
                      0.5
                    : activePolicy.normalUserRate ?? 0.3
                );
          referralCommissionEligibleSnapshot = true;
        }
      }
    }

    const successUrl = appendOrderId(env.PAYMENT_SUCCESS_URL, orderId);
    const cancelUrl = appendOrderId(env.PAYMENT_CANCEL_URL, orderId);
    const pendingUrl = appendOrderId(env.PAYMENT_PENDING_URL, orderId);

    let checkoutUrl = pendingUrl;
    let paymentId = `NP_PENDING_${Date.now()}_${generateRandomString(8).toUpperCase()}`;
    let providerInvoiceId: string | undefined;
    let providerPaymentId: string | undefined;
    let payAddress: string | undefined;
    let payAmount: number | undefined;
    let network: string | undefined;
    let invoicePayCurrency = normalizedPayCurrency;
    let paymentMode: CreateOrderResult['paymentMode'] = 'SIMULATION';
    let simulated = false;
    let expiresAt: Date | undefined;

    if (!nowPaymentsService.isConfigured) {
      if (isProduction) {
        throw new ApiError(
          503,
          'Cryptocurrency payments are not configured on this server. Please contact support.',
          'PAYMENT_PROVIDER_NOT_CONFIGURED'
        );
      }

      // Development/test-only safe simulation. It can never activate Premium:
      // a valid HMAC-signed IPN plus all server-side validation is still required.
      simulated = true;
      paymentMode = 'SIMULATION';
      payAddress = 'TSimulatedTetherDepositAddressForTest12345';
      payAmount = plan.priceUsd;
      network = 'trx';
      logger.warn('NOWPayments API key is not configured. Creating a development-only simulated order.', {
        orderId
      });
    } else {
      try {
        let npPayment: any = null;
        let invoice: any = null;
        let lastError: any = null;

        // 1. Direct crypto payment creation for in-app modal deposit & QR code
        try {
          npPayment = await nowPaymentsService.createPayment({
            priceAmount: plan.priceUsd,
            priceCurrency: 'USD',
            payCurrency: normalizedPayCurrency.toLowerCase(),
            ipnCallbackUrl: env.PAYMENT_IPN_CALLBACK_URL,
            orderId,
            orderDescription: `Roulette Accuracy — ${plan.name} (${plan.durationDays} Days Access)`
          });
        } catch (paymentErr: any) {
          lastError = paymentErr;
          const errMsg = String(paymentErr?.providerBody || paymentErr?.message || '').toLowerCase();
          logger.warn('Direct NOWPayments createPayment failed', {
            orderId,
            statusCode: paymentErr?.statusCode,
            message: paymentErr?.message,
            providerBody: paymentErr?.providerBody
          });

          // If payment was rejected because the order amount is below provider minimum
          if (paymentErr?.statusCode === 400 && errMsg.includes('minimal')) {
            throw new ApiError(
              400,
              `Minimum deposit limit for ${normalizedPayCurrency} is higher than $${plan.priceUsd}. Please select another cryptocurrency (such as TRX or LTC, which support payments from $0.20) or choose a higher tier plan.`,
              'PAYMENT_BELOW_MINIMUM'
            );
          }
        }

        // 2. Also create hosted invoice as alternative checkoutUrl option
        try {
          invoice = await nowPaymentsService.createInvoice({
            priceAmount: plan.priceUsd,
            priceCurrency: 'USD',
            orderId,
            orderDescription: `Roulette Accuracy — ${plan.name} (${plan.durationDays} Days Access)`,
            ipnCallbackUrl: env.PAYMENT_IPN_CALLBACK_URL,
            successUrl,
            cancelUrl,
            partiallyPaidUrl: pendingUrl
          });
        } catch (invoiceErr: any) {
          if (!lastError) lastError = invoiceErr;
          logger.warn('NOWPayments createInvoice fallback encountered error', {
            orderId,
            statusCode: invoiceErr?.statusCode,
            message: invoiceErr?.message
          });
        }

        if (!npPayment && !invoice) {
          throw lastError || new NowPaymentsApiError(502, 'NOWPayments was unable to initialize payment');
        }

        if (!npPayment && (!invoice || !invoice.pay_address)) {
          throw lastError || new ApiError(
            400,
            `Unable to generate a direct deposit address for ${normalizedPayCurrency}. Please select another cryptocurrency (such as TRX or LTC).`,
            'PAYMENT_DIRECT_UNAVAILABLE'
          );
        }

        if (invoice) {
          const invoiceUrl = invoice?.invoice_url || invoice?.invoiceUrl;
          if (invoiceUrl && typeof invoiceUrl === 'string') {
            checkoutUrl = invoiceUrl;
          }
          providerInvoiceId = invoice?.id !== undefined ? String(invoice.id) : undefined;
        }

        if (npPayment) {
          providerPaymentId = String(npPayment.payment_id || '');
          paymentId = providerPaymentId || providerInvoiceId || paymentId;
          payAddress = typeof npPayment.pay_address === 'string' ? npPayment.pay_address : undefined;
          payAmount = asFiniteNumber(npPayment.pay_amount);
          invoicePayCurrency = String(npPayment.pay_currency || normalizedPayCurrency).toUpperCase();
          network = typeof npPayment.network === 'string' ? npPayment.network : undefined;

          const expiryCandidate = npPayment.expiration_estimate_date || npPayment.valid_until;
          if (expiryCandidate && !Number.isNaN(new Date(expiryCandidate).getTime())) {
            expiresAt = new Date(expiryCandidate);
          }
        } else if (invoice) {
          paymentId = providerInvoiceId || paymentId;
          payAddress = typeof invoice?.pay_address === 'string' ? invoice.pay_address : undefined;
          payAmount = asFiniteNumber(invoice?.pay_amount);
          invoicePayCurrency = String(invoice?.pay_currency || normalizedPayCurrency).toUpperCase();

          const expiryCandidate = invoice?.expiration_estimate_date || invoice?.expires_at;
          if (expiryCandidate && !Number.isNaN(new Date(expiryCandidate).getTime())) {
            expiresAt = new Date(expiryCandidate);
          }
        }

        paymentMode = env.NOWPAYMENTS_ENV === 'sandbox' ? 'SANDBOX' : 'LIVE';
      } catch (error: any) {
        logger.error('Failed to create NOWPayments payment/invoice', {
          orderId,
          statusCode: error?.statusCode,
          message: error?.message
        });

        // Development/test convenience: an invalid local API key must not break
        // the whole test suite. This branch is impossible in production and
        // still cannot activate Premium without a valid signed IPN.
        if (!isProduction && [401, 403].includes(Number(error?.statusCode))) {
          simulated = true;
          paymentMode = 'SIMULATION';
          payAddress = 'TSimulatedTetherDepositAddressForTest12345';
          payAmount = plan.priceUsd;
          network = 'trx';
          logger.warn('NOWPayments rejected the configured API key. Using development-only simulated checkout.', {
            orderId
          });
        } else {
          if (error instanceof ApiError) throw error;

          if (Number(error?.statusCode) === 503) {
            throw new ApiError(
              503,
              error?.message || 'Live payments are currently disabled.',
              'PAYMENT_LIVE_DISABLED'
            );
          }

          // Surface provider configuration errors clearly (e.g. invalid key)
          // without leaking provider response bodies to the client.
          if ([401, 403, 404].includes(Number(error?.statusCode))) {
            throw new ApiError(
              503,
              'The cryptocurrency payment provider rejected the server credentials. Please contact support.',
              'PAYMENT_PROVIDER_AUTH_ERROR'
            );
          }

          throw new ApiError(
            502,
            'Unable to initialize cryptocurrency checkout. Please try again shortly.',
            'PAYMENT_PROVIDER_ERROR'
          );
        }
      }
    }

    // Persist the immutable purchase order snapshot only after the provider
    // has accepted the request (or in explicit development simulation mode).
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
      payCurrency: invoicePayCurrency,
      payCurrencyLocked: false,
      paymentId,
      orderId,
      provider: 'NOWPAYMENTS',
      providerInvoiceId,
      providerPaymentId,
      network,
      providerStatus: simulated ? 'simulation' : 'waiting',
      status: PaymentStatus.WAITING,
      isFulfilled: false,
      fulfillmentStatus: 'NONE',
      payAddress,
      checkoutUrl,
      expiresAt,
      signatureVerified: false,
      providerVerified: false,
      verified: false,
      webhookEventCount: 0,
      referredByModeratorId,
      referralCodeSnapshot,
      commissionRateSnapshot,
      referralCommissionTypeSnapshot,
      referralCommissionEligibleSnapshot,
      ipnHistory: []
    });

    logger.info('Purchase order created', {
      orderId: payment.orderId,
      planId: plan.id,
      amountUsd: plan.priceUsd,
      paymentMode,
      simulated
    });

    invalidatePaymentCaches(userId);
    memoryCache.del(cacheKeys.userDashboard(userId));

    return {
      orderId: payment.orderId,
      paymentId: payment.paymentId,
      providerInvoiceId: payment.providerInvoiceId,
      providerPaymentId: payment.providerPaymentId,
      planId: payment.planId,
      planName: payment.planName,
      priceUsd: payment.priceAmount,
      priceCents: payment.priceCents,
      status: payment.status,
      checkoutUrl: payment.checkoutUrl || checkoutUrl,
      payAddress: payment.payAddress,
      payAmount: payment.payAmount,
      payCurrency: payment.payCurrency,
      network: payment.network,
      expiresAt: payment.expiresAt ? payment.expiresAt.toISOString() : undefined,
      paymentMode,
      simulated,
      createdAt: payment.createdAt.toISOString()
    };
  }

  /**
   * Process and verify NOWPayments IPN webhook callbacks.
   *
   * Security layers:
   *  1. HMAC-SHA512 signature over recursively sorted JSON (timing-safe).
   *  2. Unique PaymentEvent idempotency key (concurrent replay safe).
   *  3. Server-side amount/currency validation against the stored order.
   *  4. Independent GET /payments/{id} provider verification before activation.
   *  5. Atomic payment claim before subscription creation.
   *  6. Unique subscription per payment + non-downgrade state machine.
   */
  async processIpnCallback(
    payload: NowPaymentsIpnPayload,
    signature: string | undefined,
    customSecret?: string
  ): Promise<ProcessIpnResult> {
    const secret = (customSecret ?? env.NOWPAYMENTS_IPN_SECRET).trim();
    if (!secret) {
      throw new ApiError(
        503,
        'NOWPayments IPN secret is not configured on this server',
        'PAYMENT_WEBHOOK_NOT_CONFIGURED'
      );
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw ApiError.badRequest('Invalid NOWPayments IPN payload');
    }

    const recordRejectedWebhook = async (reason: string, eventType: string) => {
      try {
        const orderId = String((payload as any).order_id || '').trim();
        const providerPaymentId = String((payload as any).payment_id || '').trim();
        const relatedPayment = (
          orderId || providerPaymentId
            ? await PaymentModel.findOne({
                $or: [
                  ...(orderId ? [{ orderId }] : []),
                  ...(providerPaymentId ? [{ providerPaymentId }, { paymentId: providerPaymentId }] : [])
                ]
              })
                .select('_id')
                .lean()
            : null
        ) as { _id?: mongoose.Types.ObjectId } | null;

        const eventId = `rejected:${eventType}:${nowPaymentsService.buildEventId(
          payload as Record<string, unknown>
        )}`;

        await PaymentEventModel.findOneAndUpdate(
          { providerEventId: eventId },
          {
            $set: {
              provider: 'NOWPAYMENTS',
              providerEventId: eventId,
              paymentId: relatedPayment?._id,
              providerPaymentId: providerPaymentId || undefined,
              orderId: orderId || undefined,
              eventType,
              processingStatus: 'REJECTED',
              signatureValid: false,
              errorMessage: reason,
              receivedAt: new Date(),
              processedAt: new Date(),
              rawPayload: payload
            }
          },
          { upsert: true }
        );
      } catch {
        // Diagnostics must never mask the original security rejection.
      }
    };

    if (!signature || signature.trim() === '') {
      await recordRejectedWebhook('Missing x-nowpayments-sig signature header', 'missing_signature');
      logger.warn('NOWPayments IPN rejected: missing x-nowpayments-sig header');
      throw ApiError.unauthorized('Missing x-nowpayments-sig signature header');
    }

    if (!nowPaymentsService.verifyIpnSignature(payload, signature, secret)) {
      await recordRejectedWebhook('Invalid IPN signature', 'invalid_signature');
      logger.warn('NOWPayments IPN rejected: signature mismatch', {
        orderId: payload.order_id,
        paymentId: payload.payment_id
      });
      throw ApiError.unauthorized('Invalid IPN signature. Request origin cannot be verified.');
    }

    const orderId = String(payload.order_id || '').trim();
    const providerPaymentId = String(payload.payment_id || '').trim();
    const providerInvoiceId = payload.invoice_id !== undefined ? String(payload.invoice_id).trim() : undefined;
    const receivedStatus = String(payload.payment_status || '').toLowerCase().trim();
    const mappedStatus = PROVIDER_STATUS_MAP[receivedStatus];

    if (!orderId || !providerPaymentId || !receivedStatus) {
      throw ApiError.badRequest('NOWPayments IPN is missing payment_id, order_id, or payment_status');
    }

    // ---------------------------------------------------------------------
    // 1. Webhook event idempotency
    // ---------------------------------------------------------------------
    const eventId = nowPaymentsService.buildEventId(payload as Record<string, unknown>);
    const existingEvent = await PaymentEventModel.findOne({ providerEventId: eventId });

    if (existingEvent) {
      const isFreshProcessing = ['RECEIVED', 'PROCESSING'].includes(existingEvent.processingStatus)
        && Date.now() - existingEvent.receivedAt.getTime() < PROCESSING_LOCK_MS;

      if (isFreshProcessing) {
        const currentPayment = await PaymentModel.findOne({
          $or: [{ orderId }, { providerPaymentId }, { paymentId: providerPaymentId }]
        }).select('status isFulfilled subscriptionId').lean();
        return {
          success: true,
          orderId,
          providerPaymentId,
          eventId,
          status: (currentPayment as any)?.status || mappedStatus || PaymentStatus.WAITING,
          isFulfilled: Boolean((currentPayment as any)?.isFulfilled),
          duplicate: true,
          subscriptionId: (currentPayment as any)?.subscriptionId?.toString(),
          message: 'Duplicate webhook is already being processed'
        };
      }

      if (['PROCESSED', 'IGNORED', 'DUPLICATE'].includes(existingEvent.processingStatus)) {
        const currentPayment = await PaymentModel.findOne({
          $or: [{ orderId }, { providerPaymentId }, { paymentId: providerPaymentId }]
        }).select('status isFulfilled subscriptionId').lean();
        return {
          success: true,
          orderId,
          providerPaymentId,
          eventId,
          status: (currentPayment as any)?.status || mappedStatus || PaymentStatus.WAITING,
          isFulfilled: Boolean((currentPayment as any)?.isFulfilled),
          duplicate: true,
          subscriptionId: (currentPayment as any)?.subscriptionId?.toString(),
          message: 'Duplicate webhook already processed'
        };
      }

      existingEvent.processingStatus = 'RECEIVED';
      existingEvent.errorMessage = undefined;
      await existingEvent.save();
    } else {
      try {
        await PaymentEventModel.create({
          provider: 'NOWPAYMENTS',
          providerEventId: eventId,
          providerPaymentId,
          orderId,
          eventType: receivedStatus,
          processingStatus: 'RECEIVED',
          signatureValid: true,
          receivedAt: new Date(),
          rawPayload: payload
        });
      } catch (error: any) {
        if (error?.code === 11000) {
          return {
            success: true,
            orderId,
            providerPaymentId,
            eventId,
            status: mappedStatus || PaymentStatus.WAITING,
            isFulfilled: false,
            duplicate: true,
            message: 'Concurrent duplicate webhook detected'
          };
        }
        throw error;
      }
    }

    const event = await PaymentEventModel.findOne({ providerEventId: eventId });
    if (event) {
      event.processingStatus = 'PROCESSING';
      event.paymentId = undefined;
      event.orderId = orderId;
      event.providerPaymentId = providerPaymentId;
      event.eventType = receivedStatus;
      event.signatureValid = true;
      await event.save();
    }

    const finishEvent = async (
      status: 'PROCESSED' | 'IGNORED' | 'DUPLICATE' | 'REJECTED' | 'FAILED',
      errorMessage?: string
    ) => {
      if (!event) return;
      event.processingStatus = status;
      event.processedAt = new Date();
      event.errorMessage = errorMessage;
      await event.save().catch(() => null);
    };

    // ---------------------------------------------------------------------
    // 2. Order matching
    // ---------------------------------------------------------------------
    const lookup: Record<string, unknown>[] = [{ orderId }];
    if (providerPaymentId) {
      lookup.push({ providerPaymentId }, { paymentId: providerPaymentId });
    }
    if (providerInvoiceId) {
      lookup.push({ providerInvoiceId }, { paymentId: providerInvoiceId });
    }

    let payment = await PaymentModel.findOne({ $or: lookup });

    if (!payment) {
      await finishEvent('IGNORED', `Unknown order reference: ${orderId}`);
      logger.warn('NOWPayments IPN ignored: unknown order', { orderId, providerPaymentId });
      return {
        success: false,
        orderId,
        providerPaymentId,
        eventId,
        status: PaymentStatus.FAILED,
        isFulfilled: false,
        ignored: true,
        message: 'Order reference was not found on this platform'
      };
    }

    if (event) {
      event.paymentId = payment._id as mongoose.Types.ObjectId;
      await event.save().catch(() => null);
    }

    if (!Array.isArray(payment.ipnHistory)) {
      payment.ipnHistory = [];
    }

    const rejectForReview = async (reason: string, eventStatus: 'IGNORED' | 'REJECTED' = 'IGNORED') => {
      if (!payment!.isFulfilled) {
        payment!.status = PaymentStatus.REVIEW_REQUIRED;
        payment!.failureReason = reason;
        payment!.verified = false;
      }
      payment!.lastWebhookAt = new Date();
      payment!.webhookEventCount = (payment!.webhookEventCount || 0) + 1;
      payment!.rawIpnData = payload;
      payment!.ipnHistory.push({
        receivedAt: new Date(),
        paymentStatus: receivedStatus,
        actuallyPaid: asFiniteNumber(payload.actually_paid),
        rawPayload: payload
      });
      if (payment!.ipnHistory.length > MAX_IPN_HISTORY) {
        payment!.ipnHistory = payment!.ipnHistory.slice(-MAX_IPN_HISTORY);
      }
      await payment!.save();
      await finishEvent(eventStatus, reason);
      logger.error('NOWPayments IPN security validation failed', {
        orderId: payment!.orderId,
        providerPaymentId,
        reason
      });

      return {
        success: false,
        orderId: payment!.orderId,
        paymentId: payment!.paymentId,
        providerPaymentId,
        eventId,
        status: payment!.status,
        isFulfilled: payment!.isFulfilled,
        ignored: true,
        message: reason
      };
    };

    // ---------------------------------------------------------------------
    // 3. Identity / amount / currency validation
    // ---------------------------------------------------------------------
    if (payment.providerPaymentId && payment.providerPaymentId !== providerPaymentId) {
      return rejectForReview(
        `Provider payment id mismatch: stored ${payment.providerPaymentId}, received ${providerPaymentId}`
      );
    }

    if (payment.providerInvoiceId && providerInvoiceId && payment.providerInvoiceId !== providerInvoiceId) {
      // The direct payment and hosted-invoice flows can expose different
      // provider invoice references for the same order. The signed payment_id,
      // order_id, amount and currency remain authoritative; do not force a
      // valid settled payment into manual review solely on invoice metadata.
      logger.warn('Provider invoice reference differs from stored invoice; continuing with signed payment validation', {
        orderId: payment.orderId,
        storedInvoiceId: payment.providerInvoiceId,
        receivedInvoiceId: providerInvoiceId
      });
    }

    const duplicateProviderPayment = await PaymentModel.findOne({
      provider: 'NOWPAYMENTS',
      providerPaymentId,
      _id: { $ne: payment._id }
    }).select('_id orderId').lean();

    if (duplicateProviderPayment) {
      const duplicateOrderId = String((duplicateProviderPayment as any).orderId || '');
      if (duplicateOrderId && duplicateOrderId === payment.orderId) {
        logger.warn('Duplicate local payment document for the same order; continuing with authoritative order validation', {
          orderId: payment.orderId,
          providerPaymentId
        });
      } else {
        return rejectForReview(
          `Provider payment id ${providerPaymentId} is already linked to order ${duplicateOrderId || 'another order'}`
        );
      }
    }

    const reportedPriceAmount = asFiniteNumber(payload.price_amount);
    if (reportedPriceAmount === undefined) {
      return rejectForReview('IPN payload is missing a valid price_amount');
    }

    if (Math.abs(reportedPriceAmount - payment.priceAmount) > PRICE_TOLERANCE_USD) {
      return rejectForReview(
        `Price amount mismatch: expected $${payment.priceAmount}, received $${reportedPriceAmount}`
      );
    }

    if (
      payload.price_currency &&
      String(payload.price_currency).toUpperCase() !== payment.priceCurrency.toUpperCase()
    ) {
      return rejectForReview(
        `Price currency mismatch: expected ${payment.priceCurrency}, received ${payload.price_currency}`
      );
    }

    const receivedPayCurrency = payload.pay_currency ? String(payload.pay_currency).toUpperCase() : undefined;
    if (payment.payCurrencyLocked && receivedPayCurrency && receivedPayCurrency !== payment.payCurrency.toUpperCase()) {
      return rejectForReview(
        `Pay currency mismatch: expected ${payment.payCurrency}, received ${receivedPayCurrency}`
      );
    }

    // Store provider linkage only after identity checks pass.
    payment.providerPaymentId = providerPaymentId;
    payment.provider = 'NOWPAYMENTS';
    payment.providerStatus = receivedStatus;
    payment.paymentMethod = receivedPayCurrency || payment.paymentMethod;
    if (providerInvoiceId) payment.providerInvoiceId = providerInvoiceId;
    if (!payment.payCurrencyLocked && receivedPayCurrency) {
      payment.payCurrency = receivedPayCurrency;
    }

    const reportedPayAmount = asFiniteNumber(payload.pay_amount);
    if (payment.payAmount === undefined && reportedPayAmount !== undefined) {
      payment.payAmount = reportedPayAmount;
    }

    const reportedActuallyPaid = asFiniteNumber(payload.actually_paid);
    if (reportedActuallyPaid !== undefined) {
      payment.actuallyPaid = reportedActuallyPaid;
    }

    const transactionId =
      (typeof payload.payin_hash === 'string' && payload.payin_hash) ||
      (typeof payload.outcome_hash === 'string' && payload.outcome_hash) ||
      (typeof payload.burn_hash === 'string' && payload.burn_hash) ||
      (typeof payload.txid === 'string' && payload.txid) ||
      undefined;
    if (transactionId) payment.transactionId = transactionId;
    if (payload.pay_address && typeof payload.pay_address === 'string') {
      payment.payAddress = payload.pay_address;
    }

    // ---------------------------------------------------------------------
    // 4. Non-downgrade guard for already fulfilled orders
    // ---------------------------------------------------------------------
    if (payment.isFulfilled) {
      if (receivedStatus === 'refunded') {
        await this.processRefund(payment, providerPaymentId);
        await finishEvent('PROCESSED');
        return {
          success: true,
          orderId: payment.orderId,
          paymentId: payment.paymentId,
          providerPaymentId,
          eventId,
          status: PaymentStatus.REFUNDED,
          isFulfilled: true,
          providerVerified: payment.providerVerified,
          message: 'Refund recorded and linked subscription revoked'
        };
      }

      if (payment.status === PaymentStatus.REFUNDED) {
        await finishEvent('DUPLICATE', 'Refunded order cannot be reactivated');
        return {
          success: true,
          orderId: payment.orderId,
          paymentId: payment.paymentId,
          providerPaymentId,
          eventId,
          status: PaymentStatus.REFUNDED,
          isFulfilled: true,
          duplicate: true,
          providerVerified: payment.providerVerified,
          message: 'Refunded order ignored; Premium remains revoked'
        };
      }

      payment.lastWebhookAt = new Date();
      payment.webhookEventCount = (payment.webhookEventCount || 0) + 1;
      payment.providerStatus = receivedStatus;
      payment.ipnHistory.push({
        receivedAt: new Date(),
        paymentStatus: receivedStatus,
        actuallyPaid: reportedActuallyPaid,
        rawPayload: payload
      });
      if (payment.ipnHistory.length > MAX_IPN_HISTORY) {
        payment.ipnHistory = payment.ipnHistory.slice(-MAX_IPN_HISTORY);
      }
      await payment.save();
      await finishEvent('DUPLICATE', 'Order already fulfilled; state not downgraded');
      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        providerPaymentId,
        eventId,
        status: PaymentStatus.FINISHED,
        isFulfilled: true,
        duplicate: true,
        providerVerified: payment.providerVerified,
        subscriptionId: payment.subscriptionId?.toString(),
        message: 'Order was already fulfilled; duplicate callback processed safely'
      };
    }

    // ---------------------------------------------------------------------
    // 5. Terminal / in-flight status handling (finished is the ONLY unlock)
    // ---------------------------------------------------------------------
    if (payment.status === PaymentStatus.REFUNDED && receivedStatus !== 'refunded') {
      payment.lastWebhookAt = new Date();
      payment.webhookEventCount = (payment.webhookEventCount || 0) + 1;
      payment.providerStatus = receivedStatus;
      await payment.save();
      await finishEvent('IGNORED', 'Order was already refunded; later statuses cannot re-activate Premium');
      return {
        success: false,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        providerPaymentId,
        eventId,
        status: PaymentStatus.REFUNDED,
        isFulfilled: false,
        ignored: true,
        message: 'Refunded order cannot be activated by a later status'
      };
    }

    if (receivedStatus === 'refunded') {
      await this.processRefund(payment, providerPaymentId);
      await finishEvent('PROCESSED');
      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        providerPaymentId,
        eventId,
        status: PaymentStatus.REFUNDED,
        isFulfilled: false,
        message: 'Refund recorded; no premium access granted'
      };
    }

    if (receivedStatus === 'failed') {
      payment.status = PaymentStatus.FAILED;
      payment.failureReason = 'Payment failed on the blockchain';
      payment.lastWebhookAt = new Date();
      payment.webhookEventCount = (payment.webhookEventCount || 0) + 1;
      payment.rawIpnData = payload;
      payment.ipnHistory.push({
        receivedAt: new Date(),
        paymentStatus: receivedStatus,
        actuallyPaid: reportedActuallyPaid,
        rawPayload: payload
      });
      await payment.save();
      await finishEvent('PROCESSED');

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
        providerPaymentId,
        eventId,
        status: PaymentStatus.FAILED,
        isFulfilled: false,
        message: 'Order marked as FAILED based on provider callback'
      };
    }

    if (receivedStatus === 'expired') {
      payment.status = PaymentStatus.EXPIRED;
      payment.failureReason = 'Payment window expired before full receipt';
      payment.lastWebhookAt = new Date();
      payment.webhookEventCount = (payment.webhookEventCount || 0) + 1;
      payment.rawIpnData = payload;
      payment.ipnHistory.push({
        receivedAt: new Date(),
        paymentStatus: receivedStatus,
        actuallyPaid: reportedActuallyPaid,
        rawPayload: payload
      });
      await payment.save();
      await finishEvent('PROCESSED');
      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        providerPaymentId,
        eventId,
        status: PaymentStatus.EXPIRED,
        isFulfilled: false,
        message: 'Order marked as EXPIRED'
      };
    }

    if (receivedStatus === 'partially_paid') {
      payment.status = PaymentStatus.PARTIALLY_PAID;
      payment.failureReason = `Underpayment received: actually paid ${reportedActuallyPaid ?? 'unknown'} ${payment.payCurrency}`;
      payment.lastWebhookAt = new Date();
      payment.webhookEventCount = (payment.webhookEventCount || 0) + 1;
      payment.rawIpnData = payload;
      payment.ipnHistory.push({
        receivedAt: new Date(),
        paymentStatus: receivedStatus,
        actuallyPaid: reportedActuallyPaid,
        rawPayload: payload
      });
      await payment.save();
      await finishEvent('PROCESSED');
      logger.warn('Underpayment detected for order', { orderId: payment.orderId });
      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        providerPaymentId,
        eventId,
        status: PaymentStatus.PARTIALLY_PAID,
        isFulfilled: false,
        message: 'Order underpaid; held in PARTIALLY_PAID status without activation'
      };
    }

    if (receivedStatus === 'confirmed') {
      // Confirmation is not final settlement. Premium access must wait for
      // the provider's final `finished` status.
      payment.status = PaymentStatus.CONFIRMED;
      payment.lastWebhookAt = new Date();
      payment.webhookEventCount = (payment.webhookEventCount || 0) + 1;
      payment.rawIpnData = payload;
      payment.ipnHistory.push({
        receivedAt: new Date(),
        paymentStatus: receivedStatus,
        actuallyPaid: reportedActuallyPaid,
        rawPayload: payload
      });
      await payment.save();
      await finishEvent('PROCESSED');
      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        providerPaymentId,
        eventId,
        status: PaymentStatus.CONFIRMED,
        isFulfilled: false,
        message: 'Blockchain confirmation recorded; premium activates only after final finished status'
      };
    }

    if (['waiting', 'confirming', 'sending'].includes(receivedStatus)) {
      if (payment.status !== PaymentStatus.REVIEW_REQUIRED) {
        payment.status = mappedStatus;
      }
      payment.lastWebhookAt = new Date();
      payment.webhookEventCount = (payment.webhookEventCount || 0) + 1;
      payment.rawIpnData = payload;
      payment.ipnHistory.push({
        receivedAt: new Date(),
        paymentStatus: receivedStatus,
        actuallyPaid: reportedActuallyPaid,
        rawPayload: payload
      });
      await payment.save();
      await finishEvent('PROCESSED');
      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        providerPaymentId,
        eventId,
        status: payment.status,
        isFulfilled: false,
        message: `Status ${receivedStatus} recorded; awaiting final successful settlement`
      };
    }

    if (receivedStatus !== 'finished') {
      return rejectForReview(`Unsupported NOWPayments payment status: ${receivedStatus}`);
    }

    // ---------------------------------------------------------------------
    // 6. Final `finished` validation — underpayment / overpayment
    // ---------------------------------------------------------------------
    if (payment.payAmount && payment.payAmount > 0 && payment.actuallyPaid !== undefined) {
      const minimumAccepted = payment.payAmount * (1 - PAY_AMOUNT_TOLERANCE);
      if (payment.actuallyPaid < minimumAccepted) {
        return rejectForReview(
          `Underpayment: expected ${payment.payAmount} ${payment.payCurrency}, received ${payment.actuallyPaid}`
        );
      }

      if (payment.actuallyPaid > payment.payAmount * 1.05) {
        payment.overpaymentAmount = Number((payment.actuallyPaid - payment.payAmount).toFixed(10));
      }
    }

    // ---------------------------------------------------------------------
    // 7. Independent provider verification (fail closed)
    // ---------------------------------------------------------------------
    let providerVerified = false;

    if (nowPaymentsService.isConfigured && env.NOWPAYMENTS_REQUIRE_API_VERIFICATION) {
      let providerPayment: any;
      try {
        providerPayment = await nowPaymentsService.getPayment(providerPaymentId);
      } catch (error: any) {
        const statusCode = error instanceof NowPaymentsApiError ? error.statusCode : 0;
        if (statusCode === 404) {
          return rejectForReview('NOWPayments could not find the provided payment id');
        }

        // Provider outage / auth issue: fail closed and ask NOWPayments to retry.
        await finishEvent('FAILED', `Provider verification failed with status ${statusCode || 'unknown'}`);
        throw new ApiError(
          502,
          'Unable to independently verify the payment with NOWPayments. The webhook will be retried.',
          'PAYMENT_PROVIDER_VERIFICATION_FAILED'
        );
      }

      if (String(providerPayment?.payment_id ?? '') !== providerPaymentId) {
        return rejectForReview('Provider verification returned a different payment id');
      }

      if (String(providerPayment?.order_id ?? '') !== payment.orderId) {
        return rejectForReview('Provider verification returned a different order id');
      }

      if (String(providerPayment?.payment_status || '').toLowerCase() !== 'finished') {
        const providerStatus = String(providerPayment?.payment_status || 'unknown').toLowerCase();
        payment.providerStatus = providerStatus;
        payment.status = PROVIDER_STATUS_MAP[providerStatus] || PaymentStatus.REVIEW_REQUIRED;
        payment.failureReason = `Provider reports status ${providerStatus}; premium remains locked`;
        await payment.save();
        await finishEvent('IGNORED', `Provider status is ${providerStatus}, not finished`);
        return {
          success: false,
          orderId: payment.orderId,
          paymentId: payment.paymentId,
          providerPaymentId,
          eventId,
          status: payment.status,
          isFulfilled: false,
          providerVerified: false,
          ignored: true,
          message: 'Provider has not reached the final successful status'
        };
      }

      const providerPrice = asFiniteNumber(providerPayment?.price_amount);
      if (providerPrice === undefined || Math.abs(providerPrice - payment.priceAmount) > PRICE_TOLERANCE_USD) {
        return rejectForReview('Provider price amount does not match the stored order');
      }

      if (
        providerPayment?.price_currency &&
        String(providerPayment.price_currency).toUpperCase() !== payment.priceCurrency.toUpperCase()
      ) {
        return rejectForReview('Provider price currency does not match the stored order');
      }

      const providerPayCurrency = providerPayment?.pay_currency
        ? String(providerPayment.pay_currency).toUpperCase()
        : undefined;
      if (payment.payCurrencyLocked && providerPayCurrency && providerPayCurrency !== payment.payCurrency.toUpperCase()) {
        return rejectForReview('Provider pay currency does not match the stored order');
      }
      if (!payment.payCurrencyLocked && providerPayCurrency) {
        payment.payCurrency = providerPayCurrency;
      }

      const providerActuallyPaid = asFiniteNumber(providerPayment?.actually_paid);
      const providerPayAmount = asFiniteNumber(providerPayment?.pay_amount);
      if (providerPayAmount !== undefined && payment.payAmount === undefined) {
        payment.payAmount = providerPayAmount;
      }
      if (providerActuallyPaid !== undefined) {
        payment.actuallyPaid = providerActuallyPaid;
      }

      if (
        payment.payAmount &&
        payment.payAmount > 0 &&
        payment.actuallyPaid !== undefined &&
        payment.actuallyPaid < payment.payAmount * (1 - PAY_AMOUNT_TOLERANCE)
      ) {
        return rejectForReview('Provider reports an underpaid amount');
      }

      const providerTxHash =
        (typeof providerPayment?.payin_hash === 'string' && providerPayment.payin_hash) ||
        (typeof providerPayment?.outcome_hash === 'string' && providerPayment.outcome_hash) ||
        (typeof providerPayment?.burn_hash === 'string' && providerPayment.burn_hash) ||
        undefined;
      if (providerTxHash) payment.transactionId = providerTxHash;

      providerVerified = true;
      payment.providerVerified = true;
      payment.verifiedAt = new Date();
    }

    payment.signatureVerified = true;
    payment.verified = true;
    payment.providerStatus = 'finished';

    let fulfillResult;
    try {
      fulfillResult = await this.fulfillVerifiedPayment({
        payment,
        providerPaymentId,
        providerVerified,
        signatureVerified: true,
        source: 'IPN',
        payload: payload as Record<string, unknown>
      });
    } catch (error) {
      await finishEvent('FAILED', error instanceof Error ? error.message : 'Unknown activation error');
      throw error;
    }

    if (fulfillResult.outcome === 'REFUNDED') {
      await finishEvent('IGNORED', 'Refund arrived during activation; subscription revoked');
      return {
        success: false,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        providerPaymentId,
        eventId,
        status: PaymentStatus.REFUNDED,
        isFulfilled: true,
        providerVerified,
        subscriptionId: fulfillResult.subscriptionId,
        message: 'Payment was refunded before activation completed; Premium remains revoked'
      };
    }

    if (fulfillResult.outcome !== 'FULFILLED') {
      await finishEvent('DUPLICATE', 'Payment was already processed or is currently locked');
      return {
        success: true,
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        providerPaymentId,
        eventId,
        status: fulfillResult.status,
        isFulfilled: fulfillResult.isFulfilled,
        duplicate: true,
        providerVerified,
        subscriptionId: fulfillResult.subscriptionId,
        message: 'Payment is already being processed or fulfilled'
      };
    }

    await finishEvent('PROCESSED');

    return {
      success: true,
      orderId: payment.orderId,
      paymentId: payment.paymentId,
      providerPaymentId,
      eventId,
      status: PaymentStatus.FINISHED,
      isFulfilled: true,
      providerVerified,
      subscriptionId: fulfillResult.subscriptionId,
      message: 'Payment verified and subscription activated'
    };
  }
  /**
   * Shared, idempotent fulfillment path used by both the signed IPN webhook and
   * authorized manual approval. Manual approval may only reach this method after
   * the provider has been independently verified.
   */
  private async fulfillVerifiedPayment(input: {
    payment: IPayment;
    providerPaymentId: string;
    providerVerified: boolean;
    signatureVerified: boolean;
    source: 'IPN' | 'MANUAL';
    payload?: Record<string, unknown>;
    adminId?: string;
    adminEmail?: string;
    reason?: string;
  }): Promise<{
    outcome: 'FULFILLED' | 'DUPLICATE' | 'PROCESSING' | 'REFUNDED';
    subscriptionId?: string;
    status: PaymentStatus;
    isFulfilled: boolean;
  }> {
    const payment = input.payment;
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PROCESSING_LOCK_MS);

    const claimUpdate: Record<string, any> = {
      $set: {
        fulfillmentStatus: 'PROCESSING',
        processingStartedAt: now,
        providerStatus: 'finished',
        provider: 'NOWPAYMENTS',
        providerPaymentId: input.providerPaymentId,
        verified: true,
        signatureVerified: input.signatureVerified,
        providerVerified: input.providerVerified,
        verifiedAt: payment.verifiedAt || now,
        activationSource: input.source,
        ...(input.source === 'IPN' ? { lastWebhookAt: now } : {}),
        ...(input.source === 'MANUAL'
          ? {
              manualReviewStatus: 'APPROVED',
              reviewedByAdminId: input.adminId,
              reviewedByAdminEmail: input.adminEmail,
              reviewedAt: now,
              reviewReason: input.reason
            }
          : {})
      }
    };
    if (input.source === 'IPN') {
      claimUpdate.$inc = { webhookEventCount: 1 };
    }

    const claimedPayment = await PaymentModel.findOneAndUpdate(
      {
        _id: payment._id,
        isFulfilled: false,
        status: { $nin: [PaymentStatus.REFUNDED, PaymentStatus.REJECTED] },
        $or: [
          { fulfillmentStatus: { $ne: 'PROCESSING' } },
          { processingStartedAt: { $lt: staleBefore } }
        ]
      },
      claimUpdate,
      { new: true }
    );

    if (!claimedPayment) {
      const current = await PaymentModel.findById(payment._id);
      return {
        outcome: current?.isFulfilled ? 'DUPLICATE' : 'PROCESSING',
        subscriptionId: current?.subscriptionId?.toString(),
        status: current?.status || PaymentStatus.FINISHED,
        isFulfilled: Boolean(current?.isFulfilled)
      };
    }

    try {
      // Crash recovery: reuse an existing subscription for this payment.
      let subscription = await SubscriptionModel.findOne({ paymentId: claimedPayment._id });

      if (!subscription) {
        const existingActiveSub = await SubscriptionModel.findOne({
          userId: claimedPayment.userId,
          status: SubscriptionStatus.ACTIVE,
          isRevoked: { $ne: true },
          endDate: { $gt: now }
        }).sort({ endDate: -1 });

        const subscriptionStartDate = now;
        const subscriptionEndDate = calculatePlanExpiration(
          existingActiveSub ? existingActiveSub.endDate : now,
          claimedPayment.duration
        );

        subscription = await SubscriptionModel.create({
          userId: claimedPayment.userId,
          planId: claimedPayment.planId,
          orderId: claimedPayment.orderId,
          status: SubscriptionStatus.ACTIVE,
          startDate: subscriptionStartDate,
          endDate: subscriptionEndDate,
          paymentId: claimedPayment._id,
          provider: 'NOWPAYMENTS',
          providerPaymentId: input.providerPaymentId,
          autoRenew: false,
          isManualGrant: false,
          isApprovedByAdmin: true,
          approvedAt: now,
          isSecretCodeClaimed: true,
          secretCodeClaimedAt: now
        });

        logger.info('Subscription activated from verified NOWPayments payment', {
          orderId: claimedPayment.orderId,
          subscriptionId: subscription._id.toString(),
          source: input.source,
          startDate: subscriptionStartDate.toISOString(),
          endDate: subscriptionEndDate.toISOString()
        });
      }

      const paymentUpdate: Record<string, any> = {
        status: PaymentStatus.FINISHED,
        isFulfilled: true,
        fulfillmentStatus: 'FULFILLED',
        subscriptionId: subscription._id,
        paidAt: now,
        verified: true,
        signatureVerified: input.signatureVerified,
        providerVerified: input.providerVerified,
        verifiedAt: payment.verifiedAt || now,
        providerStatus: 'finished',
        actuallyPaid: payment.actuallyPaid,
        payAmount: payment.payAmount,
        payCurrency: payment.payCurrency,
        payAddress: payment.payAddress,
        paymentMethod: payment.paymentMethod,
        providerPaymentId: input.providerPaymentId,
        providerInvoiceId: payment.providerInvoiceId,
        transactionId: payment.transactionId,
        overpaymentAmount: payment.overpaymentAmount,
        activationSource: input.source,
        ...(input.source === 'MANUAL'
          ? {
              manualReviewStatus: 'APPROVED',
              reviewedByAdminId: input.adminId,
              reviewedByAdminEmail: input.adminEmail,
              reviewedAt: now,
              reviewReason: input.reason
            }
          : {}),
        ...(input.payload ? { rawIpnData: input.payload } : {})
      };

      await PaymentModel.updateOne(
        { _id: claimedPayment._id },
        {
          $set: paymentUpdate,
          ...(input.source === 'IPN' ? { $inc: { webhookEventCount: 1 } } : {})
        }
      );

      // A refund may race activation on another serverless instance.
      const latestPayment = await PaymentModel.findById(claimedPayment._id);
      if (latestPayment?.status === PaymentStatus.REFUNDED) {
        await this.processRefund(latestPayment, input.providerPaymentId);
        return {
          outcome: 'REFUNDED',
          subscriptionId: subscription._id.toString(),
          status: PaymentStatus.REFUNDED,
          isFulfilled: true
        };
      }

      const existingLedger = await FinancialLedgerModel.findOne({
        orderId: claimedPayment.orderId,
        type: 'SUBSCRIPTION_PURCHASE'
      });
      if (!existingLedger) {
        await FinancialLedgerModel.create({
          userId: claimedPayment.userId,
          orderId: claimedPayment.orderId,
          paymentId: input.providerPaymentId,
          subscriptionId: subscription._id,
          planId: claimedPayment.planId,
          type: 'SUBSCRIPTION_PURCHASE',
          amountCents: claimedPayment.priceCents,
          amountUsd: claimedPayment.priceAmount,
          payAmount: payment.payAmount,
          actuallyPaid: payment.actuallyPaid,
          payCurrency: payment.payCurrency,
          status: 'SETTLED',
          notes:
            input.source === 'MANUAL'
              ? `Subscription manually approved after NOWPayments provider verification by ${input.adminEmail || 'admin'}`
              : 'Subscription payment independently verified via NOWPayments IPN + GET /payment (finished)'
        });
      }

      await notificationService.createNotification(
        claimedPayment.userId,
        'SUBSCRIPTION_ACTIVATED',
        'Payment Confirmed & Subscription Active',
        input.source === 'MANUAL'
          ? `Your payment of $${claimedPayment.priceAmount} for ${claimedPayment.planName} was verified and approved by administration. Premium access is now active.`
          : `Your payment of $${claimedPayment.priceAmount} for ${claimedPayment.planName} has been fully settled on the blockchain. Prediction feeds are live!`,
        '/dashboard/tool'
      ).catch(() => null);

      const payingUser = await UserModel.findById(claimedPayment.userId);
      const targetReferrerId = claimedPayment.referredByModeratorId || payingUser?.referredBy;

      if (targetReferrerId) {
        // Legacy orders may not contain the referral snapshot; use the
        // permanent referredBy relationship as a safe fallback.
        if (!claimedPayment.referredByModeratorId) {
          claimedPayment.referredByModeratorId = targetReferrerId as mongoose.Types.ObjectId;
        }

        await commissionService
          .awardForPayment(claimedPayment, subscription._id.toString())
          .catch((commissionError: any) => {
            logger.error('Referral commission award failed after verified payment', {
              orderId: claimedPayment.orderId,
              error: commissionError?.message
            });
          });
      }

      const finalPayment = await PaymentModel.findById(claimedPayment._id);
      if (finalPayment?.status === PaymentStatus.REFUNDED) {
        await this.processRefund(finalPayment, input.providerPaymentId);
        return {
          outcome: 'REFUNDED',
          subscriptionId: subscription._id.toString(),
          status: PaymentStatus.REFUNDED,
          isFulfilled: true
        };
      }

      invalidatePaymentCaches(claimedPayment.userId.toString());

      return {
        outcome: 'FULFILLED',
        subscriptionId: subscription._id.toString(),
        status: PaymentStatus.FINISHED,
        isFulfilled: true
      };
    } catch (error) {
      await PaymentModel.updateOne(
        { _id: claimedPayment._id, isFulfilled: false },
        { $set: { fulfillmentStatus: 'NONE' } }
      ).catch(() => null);
      throw error;
    }
  }

  private async processRefund(payment: IPayment, providerPaymentId: string): Promise<void> {
    payment.status = PaymentStatus.REFUNDED;
    payment.refundedAt = new Date();
    payment.providerStatus = 'refunded';
    payment.failureReason = 'Payment was refunded via NOWPayments';
    await payment.save();

    if (payment.subscriptionId) {
      const subscription = await SubscriptionModel.findById(payment.subscriptionId);
      if (subscription && !subscription.isRevoked) {
        subscription.isRevoked = true;
        subscription.status = SubscriptionStatus.REVOKED;
        subscription.revokedAt = new Date();
        subscription.revocationReason = `NOWPayments refund for order ${payment.orderId}`;
        await subscription.save();
      }
    }

    await commissionService
      .reversePaymentCommissions(
        payment._id.toString(),
        `Payment refunded via NOWPayments (payment ${providerPaymentId})`
      )
      .catch((error: any) => {
        logger.error('Failed to reverse referral commissions after refund', {
          orderId: payment.orderId,
          error: error?.message
        });
      });

    const existingRefund = await FinancialLedgerModel.findOne({
      orderId: payment.orderId,
      type: 'REFUND'
    });
    if (!existingRefund) {
      await FinancialLedgerModel.create({
        userId: payment.userId,
        orderId: payment.orderId,
        paymentId: providerPaymentId,
        subscriptionId: payment.subscriptionId,
        planId: payment.planId,
        type: 'REFUND',
        amountCents: payment.priceCents,
        amountUsd: payment.priceAmount,
        payAmount: payment.payAmount,
        actuallyPaid: payment.actuallyPaid,
        payCurrency: payment.payCurrency,
        status: 'SETTLED',
        notes: 'Payment refunded via NOWPayments IPN; linked subscription revoked'
      }).catch(() => null);
    }

    await notificationService.createNotification(
      payment.userId,
      'PAYMENT_FAILED',
      'Payment Refunded',
      `Your payment for order ${payment.orderId} was refunded. The linked subscription has been revoked.`,
      '/plans'
    ).catch(() => null);

    invalidatePaymentCaches(payment.userId.toString());
  }

  /**
   * Get a single order by its public order number.
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
   * Get an order by any safe identifier: order number, provider payment id,
   * provider invoice id, or Mongo id. Ownership is always enforced.
   */
  async getOrderByIdentifier(identifier: string, userId: string, isSuperAdmin: boolean): Promise<IPayment> {
    const clean = String(identifier || '').trim();
    if (!clean) throw ApiError.badRequest('A payment or order identifier is required');

    const lookup: Record<string, unknown>[] = [
      { orderId: clean },
      { paymentId: clean },
      { providerPaymentId: clean },
      { providerInvoiceId: clean }
    ];

    if (mongoose.Types.ObjectId.isValid(clean)) {
      lookup.push({ _id: clean });
    }

    const payment = await PaymentModel.findOne({ $or: lookup });
    if (!payment) {
      throw ApiError.notFound('Payment record was not found');
    }

    if (payment.userId.toString() !== userId && !isSuperAdmin) {
      throw ApiError.forbidden('You are not authorized to view this payment record');
    }

    return payment;
  }

  /**
   * Safe payment response for the authenticated checkout UI.
   */
  async getPaymentDetails(identifier: string, userId: string, isSuperAdmin: boolean): Promise<any> {
    let order = await this.getOrderByIdentifier(identifier, userId, isSuperAdmin);

    // Live provider sync: if an order is pending, in review, or marked FINISHED
    // without fulfilment, ask NOWPayments for the authoritative status. This
    // recovers missed webhooks and transient review conditions automatically.
    if (
      order.providerPaymentId &&
      nowPaymentsService.isConfigured &&
      (
        [
          PaymentStatus.WAITING,
          PaymentStatus.CONFIRMING,
          PaymentStatus.CONFIRMED,
          PaymentStatus.SENDING,
          PaymentStatus.PARTIALLY_PAID,
          PaymentStatus.REVIEW_REQUIRED
        ].includes(order.status) ||
        (order.status === PaymentStatus.FINISHED && !order.isFulfilled)
      )
    ) {
      try {
        const npStatus = await nowPaymentsService.getPayment(order.providerPaymentId);
        if (npStatus && npStatus.payment_status) {
          const remoteStatus = String(npStatus.payment_status).toLowerCase().trim();
          const needsFulfillmentRetry =
            remoteStatus === 'finished' && !order.isFulfilled;

          if (
            remoteStatus !== (order.providerStatus || '').toLowerCase() ||
            needsFulfillmentRetry
          ) {
            if (['finished', 'confirmed', 'sending'].includes(remoteStatus)) {
              const syntheticSignature = nowPaymentsService.generateIpnSignature(
                npStatus,
                env.NOWPAYMENTS_IPN_SECRET
              );
              await this.processIpnCallback(npStatus, syntheticSignature).catch((err: any) => {
                logger.warn('Inline verification on live poll caught error:', { err: err?.message });
              });
              const refreshed = await PaymentModel.findById(order._id);
              if (refreshed) order = refreshed;
            } else {
              order.providerStatus = remoteStatus;
              if (npStatus.actually_paid) {
                order.actuallyPaid = asFiniteNumber(npStatus.actually_paid);
              }
              await order.save().catch(() => {});
            }
          }
        }
      } catch (pollErr: any) {
        logger.debug('Polling NOWPayments for payment details caught non-fatal error', {
          err: pollErr?.message
        });
      }
    }

    let subscription: any = null;

    if (order.subscriptionId) {
      const sub: any = await SubscriptionModel.findById(order.subscriptionId)
        .select('status startDate endDate isRevoked planId')
        .lean();
      if (sub) {
        subscription = {
          id: sub._id.toString(),
          status: sub.status,
          startDate: sub.startDate,
          endDate: sub.endDate,
          isRevoked: sub.isRevoked,
          planId: sub.planId
        };
      }
    }

    return {
      orderId: order.orderId,
      paymentId: order.paymentId,
      providerPaymentId: order.providerPaymentId,
      providerInvoiceId: order.providerInvoiceId,
      planId: order.planId,
      planName: order.planName,
      priceUsd: order.priceAmount,
      priceCents: order.priceCents,
      priceCurrency: order.priceCurrency,
      duration: order.duration,
      durationDays: order.durationDays,
      status: order.status,
      providerStatus: order.providerStatus,
      isFulfilled: order.isFulfilled,
      verified: order.verified,
      signatureVerified: order.signatureVerified,
      providerVerified: order.providerVerified,
      actuallyPaid: order.actuallyPaid,
      payAmount: order.payAmount,
      payCurrency: order.payCurrency,
      payAddress: order.payAddress,
      network: order.network,
      expiresAt: order.expiresAt ? order.expiresAt.toISOString() : undefined,
      paymentMethod: order.paymentMethod,
      transactionId: order.transactionId,
      checkoutUrl: order.checkoutUrl,
      failureReason: order.failureReason,
      paidAt: order.paidAt,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      subscription
    };
  }

  /**
   * Authenticated user payment history (safe fields only).
   */
  async getPaymentHistory(
    userId: string,
    page = 1,
    limit = 20
  ): Promise<{ payments: PaymentHistoryDTO[]; total: number; page: number; limit: number; totalPages: number }> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const skip = (safePage - 1) * safeLimit;
    const query = { userId: new mongoose.Types.ObjectId(userId) };

    const [docs, total] = await Promise.all([
      PaymentModel.find(query)
        .populate('subscriptionId', 'status startDate endDate')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      PaymentModel.countDocuments(query)
    ]);

    const payments = docs.map((doc: any) => this.mapPaymentToHistory(doc));

    return {
      payments,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.max(1, Math.ceil(total / safeLimit))
    };
  }

  mapPaymentToHistory(doc: any): PaymentHistoryDTO {
    const sub: any = doc.subscriptionId && typeof doc.subscriptionId === 'object' ? doc.subscriptionId : null;
    return {
      orderId: doc.orderId,
      paymentId: doc.paymentId,
      providerPaymentId: doc.providerPaymentId,
      planId: doc.planId,
      planName: doc.planName,
      priceAmount: doc.priceAmount,
      priceCurrency: doc.priceCurrency || 'USD',
      priceCents: doc.priceCents,
      payAmount: doc.payAmount,
      actuallyPaid: doc.actuallyPaid,
      payCurrency: doc.payCurrency,
      paymentMethod: doc.paymentMethod || doc.payCurrency,
      transactionId: doc.transactionId,
      status: doc.status,
      providerStatus: doc.providerStatus,
      verified: Boolean(doc.verified),
      isFulfilled: Boolean(doc.isFulfilled),
      paidAt: doc.paidAt ? new Date(doc.paidAt).toISOString() : undefined,
      createdAt: new Date(doc.createdAt).toISOString(),
      updatedAt: new Date(doc.updatedAt).toISOString(),
      subscription: sub
        ? {
            id: sub._id?.toString(),
            status: sub.status,
            startDate: sub.startDate ? new Date(sub.startDate).toISOString() : undefined,
            endDate: sub.endDate ? new Date(sub.endDate).toISOString() : undefined
          }
        : null
    };
  }

  /**
   * Server-side reconciliation fallback. This does not replace the webhook:
   * it periodically asks NOWPayments for the authoritative status of pending
   * orders so a missed/delayed IPN cannot leave a paid customer stuck forever.
   */
  async reconcilePendingPayments(options: {
    limit?: number;
    maxAgeHours?: number;
  } = {}): Promise<{
    checked: number;
    fulfilled: number;
    updated: number;
    failed: number;
    skipped: number;
  }> {
    if (!nowPaymentsService.isConfigured) {
      throw new ApiError(
        503,
        'NOWPayments API is not configured. Reconciliation cannot run.',
        'PAYMENT_PROVIDER_NOT_CONFIGURED'
      );
    }
    if (!env.NOWPAYMENTS_IPN_SECRET.trim()) {
      throw new ApiError(
        503,
        'NOWPayments IPN secret is not configured. Reconciliation cannot verify provider payloads.',
        'PAYMENT_WEBHOOK_NOT_CONFIGURED'
      );
    }

    const limit = Math.min(50, Math.max(1, options.limit || 15));
    const maxAgeHours = Math.min(24 * 14, Math.max(1, options.maxAgeHours || 72));
    const since = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);

    const candidates = await PaymentModel.find({
      provider: 'NOWPAYMENTS',
      providerPaymentId: { $exists: true, $nin: ['', null] },
      isFulfilled: false,
      createdAt: { $gte: since },
      $or: [
        {
          status: {
            $in: [
              PaymentStatus.WAITING,
              PaymentStatus.CONFIRMING,
              PaymentStatus.CONFIRMED,
              PaymentStatus.SENDING,
              PaymentStatus.PARTIALLY_PAID,
              PaymentStatus.REVIEW_REQUIRED
            ]
          }
        },
        { status: PaymentStatus.FINISHED }
      ]
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .select('_id orderId providerPaymentId providerStatus status')
      .lean();

    let checked = 0;
    let fulfilled = 0;
    let updated = 0;
    let failed = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      try {
        const remote = await nowPaymentsService.getPayment(String(candidate.providerPaymentId));
        const remoteStatus = String(remote?.payment_status || '').toLowerCase().trim();

        if (!remoteStatus) {
          skipped += 1;
          continue;
        }

        if (
          remoteStatus === String(candidate.providerStatus || '').toLowerCase() &&
          candidate.status !== PaymentStatus.FINISHED &&
          candidate.status !== PaymentStatus.REVIEW_REQUIRED
        ) {
          skipped += 1;
          continue;
        }

        checked += 1;
        const syntheticSignature = nowPaymentsService.generateIpnSignature(
          remote,
          env.NOWPAYMENTS_IPN_SECRET
        );
        const result = await this.processIpnCallback(remote as any, syntheticSignature);

        if (result.isFulfilled) {
          fulfilled += 1;
          logger.info('Pending payment auto-fulfilled by reconciliation', {
            orderId: candidate.orderId,
            providerPaymentId: candidate.providerPaymentId,
            remoteStatus
          });
        } else if (result.status !== candidate.status) {
          updated += 1;
        }
      } catch (error: any) {
        failed += 1;
        logger.warn('Pending payment reconciliation failed for one order', {
          orderId: candidate.orderId,
          providerPaymentId: candidate.providerPaymentId,
          error: error?.message
        });
      }
    }

    if (candidates.length > 0) {
      invalidatePaymentCaches();
    }

    return { checked, fulfilled, updated, failed, skipped };
  }

  /**
   * Authorized manual approval of a payment that has not been fulfilled by IPN.
   * The provider must independently report `finished`; a pending/unpaid payment
   * can never be approved from frontend data alone.
   */
  async approvePaymentManually(
    identifier: string,
    adminId: string,
    adminEmail: string,
    reason: string
  ): Promise<{ orderId: string; subscriptionId?: string; status: PaymentStatus }> {
    if (!reason || reason.trim().length < 3) {
      throw ApiError.badRequest('A clear approval reason is required');
    }

    const payment = await PaymentModel.findOne({
      $or: [
        { orderId: identifier },
        { paymentId: identifier },
        { providerPaymentId: identifier },
        ...(mongoose.Types.ObjectId.isValid(identifier) ? [{ _id: identifier }] : [])
      ]
    });

    if (!payment) {
      throw ApiError.notFound('Payment record was not found');
    }

    if (payment.isFulfilled) {
      throw ApiError.conflict('This payment has already been fulfilled. Duplicate activation is blocked.');
    }

    if ([PaymentStatus.REFUNDED, PaymentStatus.REJECTED].includes(payment.status)) {
      throw ApiError.conflict(`Cannot approve a payment with status ${payment.status}`);
    }

    if (!payment.providerPaymentId) {
      throw ApiError.conflict(
        'No NOWPayments payment ID is stored for this order, so it cannot be independently verified.'
      );
    }

    let providerVerified = false;
    let providerPayment: any = null;

    if (nowPaymentsService.isConfigured) {
      try {
        providerPayment = await nowPaymentsService.getPayment(payment.providerPaymentId);
      } catch (error: any) {
        const statusCode = error instanceof NowPaymentsApiError ? error.statusCode : 0;
        if (statusCode === 404) {
          throw ApiError.conflict('NOWPayments does not recognize this payment ID.');
        }
        throw new ApiError(
          502,
          'Unable to verify this payment with NOWPayments right now. Approval was not applied.',
          'PAYMENT_PROVIDER_VERIFICATION_FAILED'
        );
      }

      const providerStatus = String(providerPayment?.payment_status || '').toLowerCase();
      if (providerStatus !== 'finished') {
        throw ApiError.conflict(
          `NOWPayments reports status "${providerStatus || 'unknown'}". Only a verified finished payment can be approved.`
        );
      }

      if (String(providerPayment?.payment_id ?? '') !== payment.providerPaymentId) {
        throw ApiError.conflict('Provider payment ID mismatch.');
      }
      if (String(providerPayment?.order_id ?? '') !== payment.orderId) {
        throw ApiError.conflict('Provider order ID mismatch.');
      }

      const providerPrice = asFiniteNumber(providerPayment?.price_amount);
      if (providerPrice === undefined || Math.abs(providerPrice - payment.priceAmount) > PRICE_TOLERANCE_USD) {
        throw ApiError.conflict('Provider price amount does not match the stored order.');
      }
      if (
        providerPayment?.price_currency &&
        String(providerPayment.price_currency).toUpperCase() !== payment.priceCurrency.toUpperCase()
      ) {
        throw ApiError.conflict('Provider price currency does not match the stored order.');
      }

      const providerActuallyPaid = asFiniteNumber(providerPayment?.actually_paid);
      const providerPayAmount = asFiniteNumber(providerPayment?.pay_amount);
      const providerPayCurrency = providerPayment?.pay_currency
        ? String(providerPayment.pay_currency).toUpperCase()
        : undefined;

      if (payment.payCurrencyLocked && providerPayCurrency && providerPayCurrency !== payment.payCurrency.toUpperCase()) {
        throw ApiError.conflict('Provider pay currency does not match the stored order.');
      }
      if (!payment.payCurrencyLocked && providerPayCurrency) {
        payment.payCurrency = providerPayCurrency;
      }
      if (providerActuallyPaid !== undefined) payment.actuallyPaid = providerActuallyPaid;
      if (providerPayAmount !== undefined && payment.payAmount === undefined) payment.payAmount = providerPayAmount;
      if (
        payment.payAmount &&
        payment.payAmount > 0 &&
        payment.actuallyPaid !== undefined &&
        payment.actuallyPaid < payment.payAmount * (1 - PAY_AMOUNT_TOLERANCE)
      ) {
        throw ApiError.conflict('Provider reports an underpaid amount. Approval was blocked.');
      }

      const txHash =
        (typeof providerPayment?.payin_hash === 'string' && providerPayment.payin_hash) ||
        (typeof providerPayment?.outcome_hash === 'string' && providerPayment.outcome_hash) ||
        (typeof providerPayment?.burn_hash === 'string' && providerPayment.burn_hash) ||
        undefined;
      if (txHash) payment.transactionId = txHash;

      providerVerified = true;
      payment.providerVerified = true;
      payment.verified = true;
      payment.verifiedAt = new Date();
      payment.providerStatus = 'finished';
    } else if (
      payment.providerVerified &&
      payment.verified &&
      payment.status === PaymentStatus.FINISHED
    ) {
      // Reliable stored evidence from an earlier server-side provider check.
      providerVerified = true;
    } else {
      throw new ApiError(
        503,
        'NOWPayments verification is not configured on the server. Pending payments cannot be manually approved.',
        'PAYMENT_PROVIDER_NOT_CONFIGURED'
      );
    }

    await payment.save();

    const result = await this.fulfillVerifiedPayment({
      payment,
      providerPaymentId: payment.providerPaymentId,
      providerVerified,
      signatureVerified: Boolean(payment.signatureVerified),
      source: 'MANUAL',
      adminId,
      adminEmail,
      reason: reason.trim()
    });

    if (result.outcome === 'REFUNDED') {
      throw ApiError.conflict('This payment was refunded and cannot be approved.');
    }
    if (result.outcome !== 'FULFILLED') {
      throw ApiError.conflict('Payment is already fulfilled or currently processing.');
    }

    const approvedUser = await UserModel.findOne({ _id: payment.userId })
      .select('email')
      .lean<{ email?: string } | null>();

    await AuditLogModel.create({
      action: 'PAYMENT_MANUAL_APPROVE',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetUserId: payment.userId,
      targetUserEmail: approvedUser?.email,
      targetResourceId: payment.orderId,
      resourceType: 'Payment',
      reason: reason.trim(),
      previousValue: { status: payment.status, isFulfilled: payment.isFulfilled },
      newValue: {
        status: PaymentStatus.FINISHED,
        isFulfilled: true,
        subscriptionId: result.subscriptionId,
        providerVerified: true
      }
    });

    return {
      orderId: payment.orderId,
      subscriptionId: result.subscriptionId,
      status: PaymentStatus.FINISHED
    };
  }

  /**
   * Reject a payment. Rejection never deletes records and never revokes an
   * already fulfilled payment.
   */
  async rejectPaymentManually(
    identifier: string,
    adminId: string,
    adminEmail: string,
    reason: string
  ): Promise<{ orderId: string; status: PaymentStatus }> {
    if (!reason || reason.trim().length < 3) {
      throw ApiError.badRequest('A clear rejection reason is required');
    }

    const payment = await PaymentModel.findOne({
      $or: [
        { orderId: identifier },
        { paymentId: identifier },
        { providerPaymentId: identifier },
        ...(mongoose.Types.ObjectId.isValid(identifier) ? [{ _id: identifier }] : [])
      ]
    });

    if (!payment) {
      throw ApiError.notFound('Payment record was not found');
    }

    if (payment.isFulfilled) {
      throw ApiError.conflict('A fulfilled payment cannot be rejected through this action.');
    }
    if (payment.status === PaymentStatus.REJECTED) {
      throw ApiError.conflict('This payment has already been rejected.');
    }
    if (payment.status === PaymentStatus.REFUNDED) {
      throw ApiError.conflict('This payment has already been refunded.');
    }

    const previousStatus = payment.status;
    payment.status = PaymentStatus.REJECTED;
    payment.manualReviewStatus = 'REJECTED';
    payment.reviewedByAdminId = new mongoose.Types.ObjectId(adminId);
    payment.reviewedByAdminEmail = adminEmail;
    payment.reviewedAt = new Date();
    payment.reviewReason = reason.trim();
    payment.failureReason = `Manually rejected: ${reason.trim()}`;
    await payment.save();

    const rejectedUser = await UserModel.findOne({ _id: payment.userId })
      .select('email')
      .lean<{ email?: string } | null>();

    await AuditLogModel.create({
      action: 'PAYMENT_MANUAL_REJECT',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      targetUserId: payment.userId,
      targetUserEmail: rejectedUser?.email,
      targetResourceId: payment.orderId,
      resourceType: 'Payment',
      reason: reason.trim(),
      previousValue: { status: previousStatus },
      newValue: { status: PaymentStatus.REJECTED }
    });

    await notificationService.createNotification(
      payment.userId,
      'PAYMENT_FAILED',
      'Payment Rejected',
      `Your payment for order ${payment.orderId} was rejected by administration. Reason: ${reason.trim()}`,
      '/plans'
    ).catch(() => null);

    invalidatePaymentCaches(payment.userId.toString());

    return { orderId: payment.orderId, status: PaymentStatus.REJECTED };
  }

  /**
   * Admin Payment Management: view, search, and filter orders.
   */
  async getAdminOrders(filter: AdminPaymentFilterInput): Promise<{ orders: any[]; total: number; page: number; limit: number; totalPages: number }> {
    const page = Math.max(1, filter.page || 1);
    const limit = Math.min(100, Math.max(1, filter.limit || 20));
    const skip = (page - 1) * limit;

    const query: any = {};

    if (filter.status && (filter.status as string) !== 'ALL') {
      if (filter.status === 'PENDING') {
        query.$and = [
          {
            $or: [
              {
                status: {
                  $in: [
                    PaymentStatus.WAITING,
                    PaymentStatus.CONFIRMING,
                    PaymentStatus.CONFIRMED,
                    PaymentStatus.SENDING,
                    PaymentStatus.PARTIALLY_PAID,
                    PaymentStatus.REVIEW_REQUIRED
                  ]
                }
              },
              // A finished payment that was never fulfilled is a stuck order and
              // belongs in the manual review queue.
              { status: PaymentStatus.FINISHED, isFulfilled: false }
            ]
          }
        ];
      } else {
        query.status = filter.status;
      }
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
      const escaped = filter.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(escaped, 'i');
      const matchingUsers = await UserModel.find({
        $or: [{ email: searchRegex }, { name: searchRegex }, { phone: searchRegex }]
      }).select('_id');

      const userIds = matchingUsers.map((u) => u._id);

      query.$or = [
        { orderId: searchRegex },
        { paymentId: searchRegex },
        { providerPaymentId: searchRegex },
        { providerInvoiceId: searchRegex },
        { transactionId: searchRegex },
        { planName: searchRegex },
        { payAddress: searchRegex },
        { userId: { $in: userIds } }
      ];
    }

    const [orders, total] = await Promise.all([
      PaymentModel.find(query)
        .populate('userId', 'name email phone role')
        .populate('subscriptionId', 'status startDate endDate isRevoked')
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
      payAmountCrypto: o.payAmount,
      actuallyPaidAmount: o.actuallyPaid,
      premiumActivated: Boolean(o.isFulfilled && o.subscriptionId)
    }));

    return {
      orders: normalizedOrders,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit))
    };
  }

  async getAdminOrderDetails(orderId: string): Promise<any> {
    const payment = await PaymentModel.findOne({
      $or: [{ orderId }, { paymentId: orderId }, { providerPaymentId: orderId }]
    })
      .populate('userId', 'name email phone role accountStatus')
      .populate('subscriptionId', 'status startDate endDate isRevoked planId')
      .lean();

    if (!payment) {
      throw ApiError.notFound('Payment order was not found');
    }

    const events = await PaymentEventModel.find({
      paymentId: (payment as any)._id
    })
      .sort({ receivedAt: -1 })
      .limit(25)
      .select('-rawPayload')
      .lean();

    return {
      ...payment,
      paymentStatus: (payment as any).status,
      actuallyPaidAmount: (payment as any).actuallyPaid,
      premiumActivated: Boolean((payment as any).isFulfilled && (payment as any).subscriptionId),
      recentWebhookEvents: events
    };
  }

  /**
   * Admin Payment Management: high-level financial summary.
   */
  async getAdminSummary(): Promise<AdminPaymentSummary> {
    return memoryCache.getOrSet(cacheKeys.adminPaymentSummary, 10, async () => {
    const [
      totalOrders,
      completedOrders,
      pendingOrders,
      failedOrders,
      reviewRequiredOrders,
      refundedOrders,
      expiredOrders,
      rejectedOrders,
      verifiedPayments,
      grossAgg,
      lastPayment
    ] = await Promise.all([
      PaymentModel.countDocuments(),
      PaymentModel.countDocuments({ status: PaymentStatus.FINISHED }),
      PaymentModel.countDocuments({
        $or: [
          {
            status: {
              $in: [
                PaymentStatus.WAITING,
                PaymentStatus.CONFIRMING,
                PaymentStatus.CONFIRMED,
                PaymentStatus.SENDING
              ]
            }
          },
          { status: PaymentStatus.FINISHED, isFulfilled: false }
        ]
      }),
      PaymentModel.countDocuments({ status: PaymentStatus.FAILED }),
      PaymentModel.countDocuments({ status: { $in: [PaymentStatus.PARTIALLY_PAID, PaymentStatus.REVIEW_REQUIRED] } }),
      PaymentModel.countDocuments({ status: PaymentStatus.REFUNDED }),
      PaymentModel.countDocuments({ status: PaymentStatus.EXPIRED }),
      PaymentModel.countDocuments({ status: PaymentStatus.REJECTED }),
      PaymentModel.countDocuments({ verified: true, isFulfilled: true }),
      PaymentModel.aggregate([
        { $match: { isFulfilled: true } },
        { $group: { _id: null, totalUsd: { $sum: '$priceAmount' } } }
      ]),
      PaymentModel.findOne({ isFulfilled: true }).sort({ paidAt: -1, updatedAt: -1 }).select('paidAt updatedAt').lean()
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
      netRevenueUsd,
      totalTransactions: totalOrders,
      successfulPayments: completedOrders,
      pendingPayments: pendingOrders,
      failedPayments: failedOrders,
      refundedPayments: refundedOrders,
      verifiedPayments,
      expiredPayments: expiredOrders,
      rejectedPayments: rejectedOrders,
      lastPaymentAt: lastPayment
        ? new Date((lastPayment as any).paidAt || (lastPayment as any).updatedAt).toISOString()
        : null
    };
    });
  }

  /**
   * Admin health panel. Never returns API keys, IPN secrets, or full URLs with
   * embedded credentials.
   */
  async getAdminPaymentHealth(): Promise<any> {
    const config = nowPaymentsService.getConfigurationStatus();
    const issues = validatePaymentEnvironment().map((issue) => ({
      variable: issue.variable,
      severity: issue.severity,
      message: issue.message
    }));

    let providerReachable: boolean | null = null;
    let providerMessage = 'Provider not queried';
    if (nowPaymentsService.isConfigured) {
      try {
        const status = await nowPaymentsService.getStatus();
        providerReachable = true;
        providerMessage = status?.message || 'Provider reachable';
      } catch (error: any) {
        providerReachable = false;
        providerMessage = error?.message || 'Provider unreachable';
      }
    } else {
      providerReachable = false;
      providerMessage = 'API key not configured';
    }

    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [lastEvent, events24h, processed24h, failed24h] = await Promise.all([
      PaymentEventModel.findOne().sort({ receivedAt: -1 }).lean(),
      PaymentEventModel.countDocuments({ receivedAt: { $gte: last24h } }),
      PaymentEventModel.countDocuments({ receivedAt: { $gte: last24h }, processingStatus: 'PROCESSED' }),
      PaymentEventModel.countDocuments({ receivedAt: { $gte: last24h }, processingStatus: { $in: ['FAILED', 'REJECTED'] } })
    ]);

    return {
      provider: config,
      databaseConnected: mongoose.connection.readyState === 1,
      indexes: getPaymentIndexStatus(),
      webhook: {
        configured: config.ipnSecretConfigured && Boolean(config.webhookUrl),
        url: config.webhookUrl,
        canonicalPath: '/api/nowpayments/webhook',
        aliases: [
          '/api/v1/payments/nowpayments/webhook',
          '/api/payments/nowpayments/webhook',
          '/api/webhooks/nowpayments',
          '/api/v1/payments/ipn'
        ],
        lastEventAt: lastEvent ? (lastEvent as any).receivedAt : null,
        lastEventStatus: lastEvent ? (lastEvent as any).processingStatus : null,
        events24h,
        processed24h,
        failed24h
      },
      providerReachable,
      providerMessage,
      warnings: issues,
      checkedAt: new Date().toISOString()
    };
  }

  /**
   * Export reconciliation report (JSON + CSV structure).
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
      'Provider Payment ID',
      'Provider Invoice ID',
      'Transaction Hash',
      'Plan ID',
      'Plan Name',
      'Price USD',
      'Pay Currency',
      'Expected Pay Amount',
      'Actually Paid',
      'Status',
      'Signature Verified',
      'Provider Verified',
      'Premium Activated',
      'Paid At',
      'Subscription ID',
      'Failure Reason',
      'Created At'
    ];

    let totalGrossUsd = 0;

    const csvEscape = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`;

    const rows = orders.map((o: any) => {
      if (o.isFulfilled) {
        totalGrossUsd += o.priceAmount;
      }
      return [
        o.orderId,
        o.paymentId,
        o.userId?.email || 'N/A',
        csvEscape(o.userId?.name || ''),
        o.providerPaymentId || '',
        o.providerInvoiceId || '',
        o.transactionId || '',
        o.planId,
        csvEscape(o.planName),
        o.priceAmount,
        o.payCurrency,
        o.payAmount ?? '',
        o.actuallyPaid ?? '',
        o.status,
        o.signatureVerified ? 'YES' : 'NO',
        o.providerVerified ? 'YES' : 'NO',
        o.isFulfilled ? 'YES' : 'NO',
        o.paidAt ? new Date(o.paidAt).toISOString() : '',
        o.subscriptionId?.toString() || '',
        csvEscape(o.failureReason || ''),
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
