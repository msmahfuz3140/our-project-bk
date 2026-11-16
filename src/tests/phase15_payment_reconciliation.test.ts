import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { env } from '../config/env';
import { paymentService } from '../services/payment.service';
import { nowPaymentsService } from '../services/nowpayments.service';
import { UserModel } from '../models/User';
import { PaymentModel } from '../models/Payment';
import { SubscriptionModel } from '../models/Subscription';
import { UserRole } from '../shared/roles';
import { PaymentStatus, SubscriptionStatus } from '../shared/subscriptions';
import { hashPassword } from '../utils/crypto';
import { seedPlansIfEmpty } from '../models/Plan';

let mongod: MongoMemoryServer | undefined;
let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${name}`, detail ?? '');
    failed++;
  }
}

async function run() {
  console.log('\n=============================================');
  console.log('  PHASE 15 AUTOMATIC PAYMENT RECONCILIATION');
  console.log('=============================================\n');

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await seedPlansIfEmpty();

  const buyer = await UserModel.create({
    name: 'Reconciliation Buyer',
    email: 'phase15.buyer@example.com',
    passwordHash: await hashPassword('BuyerPass123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true
  });

  const reviewOrder = await paymentService.createPurchaseOrder(buyer._id.toString(), 'PLAN_15_DAYS', 'TRX');
  const stuckFinishedOrder = await paymentService.createPurchaseOrder(
    buyer._id.toString(),
    'PLAN_1_MONTH',
    'USDTTRC20'
  );
  const confirmedOnlyOrder = await paymentService.createPurchaseOrder(
    buyer._id.toString(),
    'PLAN_3_MONTHS',
    'USDTTRC20'
  );

  await PaymentModel.updateOne(
    { orderId: reviewOrder.orderId },
    {
      $set: {
        providerPaymentId: '88001',
        paymentId: '88001',
        status: PaymentStatus.REVIEW_REQUIRED,
        providerStatus: 'finished',
        failureReason: 'Transient provider verification review'
      }
    }
  );
  await PaymentModel.updateOne(
    { orderId: stuckFinishedOrder.orderId },
    {
      $set: {
        providerPaymentId: '88002',
        paymentId: '88002',
        status: PaymentStatus.FINISHED,
        providerStatus: 'finished',
        isFulfilled: false
      }
    }
  );
  await PaymentModel.updateOne(
    { orderId: confirmedOnlyOrder.orderId },
    {
      $set: {
        providerPaymentId: '88003',
        paymentId: '88003',
        status: PaymentStatus.WAITING,
        providerStatus: 'waiting'
      }
    }
  );

  const originalKey = env.NOWPAYMENTS_API_KEY;
  (env as any).NOWPAYMENTS_API_KEY = 'phase15_mock_api_key';

  const payloadFor = (order: any, id: string, status: string) => ({
    payment_id: Number(id),
    payment_status: status,
    price_amount: order.priceUsd,
    price_currency: 'usd',
    pay_amount: order.priceUsd,
    actually_paid: status === 'finished' || status === 'confirmed' ? order.priceUsd : 0,
    pay_currency: order.payCurrency.toLowerCase(),
    order_id: order.orderId,
    payin_hash: `phase15_tx_${id}`,
    updated_at: new Date().toISOString()
  });

  (nowPaymentsService as any).getPayment = async (id: string) => {
    if (id === '88001') return payloadFor(reviewOrder, '88001', 'finished');
    if (id === '88002') return payloadFor(stuckFinishedOrder, '88002', 'finished');
    if (id === '88003') return payloadFor(confirmedOnlyOrder, '88003', 'confirmed');
    throw new Error(`Unknown provider payment ${id}`);
  };

  const result = await paymentService.reconcilePendingPayments({ limit: 20 });
  console.log('Reconciliation result:', result);

  assert(result.checked >= 3, 'reconciliation queried pending provider payments', result);
  assert(result.fulfilled >= 2, 'reconciliation auto-fulfilled finished payments', result);

  const reviewPayment = await PaymentModel.findOne({ orderId: reviewOrder.orderId });
  assert(reviewPayment?.status === PaymentStatus.FINISHED, 'REVIEW_REQUIRED payment moved to FINISHED');
  assert(reviewPayment?.isFulfilled === true, 'REVIEW_REQUIRED payment is fulfilled automatically');

  const reviewSub = await SubscriptionModel.findOne({ paymentId: reviewPayment?._id });
  assert(Boolean(reviewSub), 'review-state payment created a subscription');
  assert(reviewSub?.status === SubscriptionStatus.ACTIVE, 'review-state subscription is ACTIVE');

  const stuckPayment = await PaymentModel.findOne({ orderId: stuckFinishedOrder.orderId });
  assert(stuckPayment?.isFulfilled === true, 'FINISHED-but-unfulfilled order recovered');
  assert(
    (await SubscriptionModel.countDocuments({ paymentId: stuckPayment?._id })) === 1,
    'recovered order has exactly one subscription'
  );

  const confirmedPayment = await PaymentModel.findOne({ orderId: confirmedOnlyOrder.orderId });
  assert(
    confirmedPayment?.status === PaymentStatus.CONFIRMED,
    'provider confirmed status updated without premature activation',
    confirmedPayment?.status
  );
  assert(
    confirmedPayment?.isFulfilled === false,
    'confirmed-only payment did not activate a plan'
  );

  const duplicateRun = await paymentService.reconcilePendingPayments({ limit: 20 });
  const totalSubs = await SubscriptionModel.countDocuments({ userId: buyer._id });
  assert(totalSubs === 2, 'repeated reconciliation did not duplicate subscriptions', totalSubs);
  assert(duplicateRun.fulfilled === 0, 'second reconciliation run fulfilled nothing new', duplicateRun);

  // The user-facing status endpoint must also retry a REVIEW_REQUIRED order
  // whose provider now reports finished. This is the path used by live polling.
  const userPageOrder = await paymentService.createPurchaseOrder(
    buyer._id.toString(),
    'PLAN_1_YEAR',
    'USDTTRC20'
  );
  await PaymentModel.updateOne(
    { orderId: userPageOrder.orderId },
    {
      $set: {
        providerPaymentId: '88004',
        paymentId: '88004',
        status: PaymentStatus.REVIEW_REQUIRED,
        providerStatus: 'finished',
        failureReason: 'Transient review before provider final sync'
      }
    }
  );
  (nowPaymentsService as any).getPayment = async (id: string) => {
    if (id === '88004') return payloadFor(userPageOrder, '88004', 'finished');
    if (id === '88001') return payloadFor(reviewOrder, '88001', 'finished');
    if (id === '88002') return payloadFor(stuckFinishedOrder, '88002', 'finished');
    if (id === '88003') return payloadFor(confirmedOnlyOrder, '88003', 'confirmed');
    throw new Error(`Unknown provider payment ${id}`);
  };

  const userPageDetails = await paymentService.getPaymentDetails(
    userPageOrder.orderId,
    buyer._id.toString(),
    false
  );
  assert(userPageDetails.isFulfilled === true, 'status polling auto-fulfils a finished review order');
  assert(userPageDetails.status === PaymentStatus.FINISHED, 'status polling returns FINISHED after recovery');
  assert(
    (await SubscriptionModel.countDocuments({ userId: buyer._id })) === 3,
    'status-polling recovery created exactly one additional subscription'
  );

  // A signed, settled payment must not be forced into review only because the
  // hosted-invoice identifier differs from the direct-payment reference.
  const invoiceMismatchOrder = await paymentService.createPurchaseOrder(
    buyer._id.toString(),
    'PLAN_6_MONTHS',
    'USDTTRC20'
  );
  await PaymentModel.updateOne(
    { orderId: invoiceMismatchOrder.orderId },
    {
      $set: {
        providerPaymentId: '88005',
        paymentId: '88005',
        providerInvoiceId: 'INV-STORED-REFERENCE',
        status: PaymentStatus.WAITING
      }
    }
  );
  const invoiceMismatchPayload = {
    payment_id: 88005,
    invoice_id: 777777,
    payment_status: 'finished',
    price_amount: invoiceMismatchOrder.priceUsd,
    price_currency: 'usd',
    pay_amount: invoiceMismatchOrder.priceUsd,
    actually_paid: invoiceMismatchOrder.priceUsd,
    pay_currency: invoiceMismatchOrder.payCurrency.toLowerCase(),
    order_id: invoiceMismatchOrder.orderId,
    payin_hash: 'phase15_invoice_mismatch_tx',
    updated_at: new Date().toISOString()
  };
  const invoiceMismatchSignature = nowPaymentsService.generateIpnSignature(
    invoiceMismatchPayload,
    env.NOWPAYMENTS_IPN_SECRET
  );
  const invoiceMismatchResult = await paymentService.processIpnCallback(
    invoiceMismatchPayload as any,
    invoiceMismatchSignature
  );
  assert(
    invoiceMismatchResult.isFulfilled === true,
    'valid finished payment auto-fulfils despite hosted invoice reference difference'
  );

  (env as any).NOWPAYMENTS_API_KEY = originalKey;

  console.log('\n=============================================');
  console.log(`  PHASE 15 RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=============================================\n');

  await mongoose.disconnect().catch(() => null);
  await mongod.stop().catch(() => null);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (error) => {
  console.error('Phase 15 crashed:', error);
  (env as any).NOWPAYMENTS_API_KEY = '';
  await mongoose.disconnect().catch(() => null);
  await mongod?.stop().catch(() => null);
  process.exit(1);
});
