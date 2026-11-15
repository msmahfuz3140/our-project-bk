import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { app } from '../app';
import { env } from '../config/env';
import { nowPaymentsService } from '../services/nowpayments.service';
import { paymentService } from '../services/payment.service';
import { UserModel } from '../models/User';
import { PaymentModel } from '../models/Payment';
import { PaymentEventModel } from '../models/PaymentEvent';
import { SubscriptionModel } from '../models/Subscription';
import { UserRole } from '../shared/roles';
import { PaymentStatus, SubscriptionStatus } from '../shared/subscriptions';
import { hashPassword } from '../utils/crypto';

let mongod: MongoMemoryServer;
let server: any;
let baseUrl = '';
let passedTests = 0;
let failedTests = 0;

const TEST_SECRET = env.NOWPAYMENTS_IPN_SECRET;

function assert(condition: boolean, testName: string, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`  ✗ FAIL: ${testName}`, detail ?? '');
    failedTests++;
  }
}

function sign(payload: Record<string, unknown>): string {
  return nowPaymentsService.generateIpnSignature(payload, TEST_SECRET);
}

function tokenFor(userId: string): string {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: '1h' });
}

async function postWebhook(
  path: string,
  payload: Record<string, unknown>,
  signature?: string
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature ? { 'x-nowpayments-sig': signature } : {})
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function get(path: string, token?: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function finishedPayload(order: any, paymentId: number) {
  return {
    payment_id: paymentId,
    payment_status: 'finished',
    price_amount: order.priceUsd,
    price_currency: 'usd',
    pay_amount: order.priceUsd,
    actually_paid: order.priceUsd,
    pay_currency: 'usdttrc20',
    order_id: order.orderId,
    order_description: `Roulette Accuracy — ${order.planName}`,
    pay_address: 'TX_TEST_ADDRESS',
    payin_hash: `txhash_${paymentId}`,
    updated_at: new Date().toISOString()
  };
}

async function newOrder(userId: string, planId = 'PLAN_1_MONTH') {
  return paymentService.createPurchaseOrder(userId, planId, 'USDTTRC20');
}

async function run() {
  console.log('\n=============================================');
  console.log('  PHASE 10 NOWPayments WEBHOOK INTEGRATION');
  console.log('=============================================\n');

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const buyer = await UserModel.create({
    name: 'Webhook Buyer',
    email: 'webhook.buyer@example.com',
    passwordHash: await hashPassword('BuyerPass123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true
  });

  const attacker = await UserModel.create({
    name: 'Other Buyer',
    email: 'other.buyer@example.com',
    passwordHash: await hashPassword('BuyerPass123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true
  });

  const buyerToken = tokenFor(buyer._id.toString());
  const attackerToken = tokenFor(attacker._id.toString());

  // -------------------------------------------------------------------
  console.log('[1. Missing / invalid signature]');
  const orderA = await newOrder(buyer._id.toString());
  const payloadA = finishedPayload(orderA, 5010001);

  const missing = await postWebhook('/api/v1/payments/nowpayments/webhook', payloadA);
  assert(missing.status === 401, 'Missing signature returns HTTP 401', missing);

  const invalid = await postWebhook('/api/v1/payments/nowpayments/webhook', payloadA, 'deadbeef');
  assert(invalid.status === 401, 'Invalid signature returns HTTP 401', invalid);

  let storedA = await PaymentModel.findOne({ orderId: orderA.orderId });
  assert(storedA?.status === PaymentStatus.WAITING, 'Unverified webhooks did not change order status');
  assert((await SubscriptionModel.countDocuments({ userId: buyer._id })) === 0, 'Unverified webhooks did not activate Premium');

  // -------------------------------------------------------------------
  console.log('\n[2. Non-final statuses do not activate]');
  const waiting = await postWebhook(
    '/api/v1/payments/nowpayments/webhook',
    { ...payloadA, payment_status: 'waiting', actually_paid: 0, payin_hash: undefined },
    sign({ ...payloadA, payment_status: 'waiting', actually_paid: 0, payin_hash: undefined })
  );
  assert(waiting.status === 200 && waiting.body?.data?.status === PaymentStatus.WAITING, 'waiting status recorded', waiting);

  const confirmedPayload = { ...payloadA, payment_status: 'confirmed' };
  const confirmed = await postWebhook(
    '/api/v1/payments/nowpayments/webhook',
    confirmedPayload,
    sign(confirmedPayload)
  );
  assert(confirmed.status === 200, 'confirmed webhook accepted', confirmed);
  storedA = await PaymentModel.findOne({ orderId: orderA.orderId });
  assert(storedA?.status === PaymentStatus.CONFIRMED, 'confirmed status is CONFIRMED, not FINISHED');
  assert(storedA?.isFulfilled === false, 'confirmed status did not fulfil the order');
  assert((await SubscriptionModel.countDocuments({ userId: buyer._id })) === 0, 'confirmed status did not activate Premium');

  // -------------------------------------------------------------------
  console.log('\n[3. Final finished status activates Premium]');
  const finished = await postWebhook(
    '/api/v1/payments/nowpayments/webhook',
    payloadA,
    sign(payloadA)
  );
  assert(finished.status === 200, 'finished webhook accepted', finished);
  assert(finished.body?.data?.isFulfilled === true, 'finished webhook fulfilled order', finished);

  storedA = await PaymentModel.findOne({ orderId: orderA.orderId });
  assert(storedA?.status === PaymentStatus.FINISHED, 'payment marked FINISHED');
  assert(storedA?.isFulfilled === true, 'payment marked fulfilled');
  assert(storedA?.verified === true, 'payment marked verified');
  assert(storedA?.signatureVerified === true, 'signature verification recorded');
  assert(storedA?.providerPaymentId === '5010001', 'provider payment id stored');
  assert(storedA?.transactionId === 'txhash_5010001', 'transaction hash stored');

  const subsAfterFinish = await SubscriptionModel.countDocuments({ userId: buyer._id });
  assert(subsAfterFinish === 1, 'exactly one subscription created', subsAfterFinish);

  const activeSub = await SubscriptionModel.findOne({ userId: buyer._id });
  assert(activeSub?.status === SubscriptionStatus.ACTIVE, 'subscription is ACTIVE');
  assert(activeSub?.paymentId?.toString() === storedA?._id.toString(), 'subscription linked to payment');
  assert(Boolean(activeSub?.endDate && activeSub.endDate > new Date()), 'subscription has a future expiration date');

  // -------------------------------------------------------------------
  console.log('\n[4. Duplicate webhook protection]');
  const duplicateExact = await postWebhook(
    '/api/v1/payments/nowpayments/webhook',
    payloadA,
    sign(payloadA)
  );
  assert(duplicateExact.status === 200, 'duplicate webhook returns HTTP 200', duplicateExact);
  assert(duplicateExact.body?.data?.duplicate === true, 'duplicate webhook flagged as duplicate');
  assert(
    (await SubscriptionModel.countDocuments({ userId: buyer._id })) === 1,
    'exact duplicate did not create another subscription'
  );

  const duplicateChangedTimestamp = {
    ...payloadA,
    updated_at: new Date(Date.now() + 5000).toISOString()
  };
  const duplicateChanged = await postWebhook(
    '/api/v1/payments/nowpayments/webhook',
    duplicateChangedTimestamp,
    sign(duplicateChangedTimestamp)
  );
  assert(duplicateChanged.status === 200, 'changed duplicate accepted', duplicateChanged);
  assert(
    (await SubscriptionModel.countDocuments({ userId: buyer._id })) === 1,
    'same finished status with new timestamp did not double-extend'
  );

  // -------------------------------------------------------------------
  console.log('\n[5. Concurrent duplicate webhooks]');
  const orderB = await newOrder(buyer._id.toString(), 'PLAN_15_DAYS');
  const payloadB = finishedPayload(orderB, 5010002);
  const signatureB = sign(payloadB);

  const concurrentResults = await Promise.all(
    Array.from({ length: 6 }).map(() =>
      postWebhook('/api/v1/payments/nowpayments/webhook', payloadB, signatureB)
    )
  );
  assert(concurrentResults.every((r) => r.status === 200), 'all concurrent retries return HTTP 200');
  assert(
    (await SubscriptionModel.countDocuments({ userId: buyer._id })) === 2,
    'concurrent duplicates created exactly one additional subscription',
    await SubscriptionModel.countDocuments({ userId: buyer._id })
  );
  assert(
    (await PaymentEventModel.countDocuments({ providerPaymentId: '5010002' })) === 1,
    'concurrent duplicate webhooks created one PaymentEvent'
  );

  // -------------------------------------------------------------------
  console.log('\n[6. Amount and currency tampering]');
  const orderC = await newOrder(buyer._id.toString(), 'PLAN_1_YEAR');
  const wrongAmount = {
    ...finishedPayload(orderC, 5010003),
    price_amount: 10
  };
  const wrongAmountResult = await postWebhook(
    '/api/v1/payments/nowpayments/webhook',
    wrongAmount,
    sign(wrongAmount)
  );
  assert(wrongAmountResult.status === 200, 'wrong amount webhook is acknowledged', wrongAmountResult);
  assert(wrongAmountResult.body?.data?.success === false, 'wrong amount is rejected');
  let storedC = await PaymentModel.findOne({ orderId: orderC.orderId });
  assert(storedC?.status === PaymentStatus.REVIEW_REQUIRED, 'wrong amount flagged REVIEW_REQUIRED');
  assert(storedC?.isFulfilled === false, 'wrong amount did not fulfil order');

  const wrongCurrency = {
    ...finishedPayload(orderC, 5010004),
    price_currency: 'eur'
  };
  const wrongCurrencyResult = await postWebhook(
    '/api/v1/payments/nowpayments/webhook',
    wrongCurrency,
    sign(wrongCurrency)
  );
  assert(wrongCurrencyResult.body?.data?.success === false, 'wrong currency is rejected');
  storedC = await PaymentModel.findOne({ orderId: orderC.orderId });
  assert(storedC?.status === PaymentStatus.REVIEW_REQUIRED, 'wrong currency flagged REVIEW_REQUIRED');
  assert(storedC?.isFulfilled === false, 'wrong currency did not fulfil order');

  // -------------------------------------------------------------------
  console.log('\n[7. Failed / expired / partially paid / unknown]');
  const orderD = await newOrder(buyer._id.toString(), 'PLAN_1_MONTH');
  for (const status of ['failed', 'expired', 'partially_paid']) {
    const payload = {
      payment_id: 5010100 + ['failed', 'expired', 'partially_paid'].indexOf(status),
      payment_status: status,
      price_amount: orderD.priceUsd,
      price_currency: 'usd',
      pay_amount: orderD.priceUsd,
      actually_paid: status === 'partially_paid' ? 5 : 0,
      pay_currency: 'usdttrc20',
      order_id: orderD.orderId
    };
    const result = await postWebhook('/api/v1/payments/nowpayments/webhook', payload, sign(payload));
    assert(result.status === 200, `${status} webhook accepted`, result);
    const stored = await PaymentModel.findOne({ orderId: orderD.orderId });
    assert(stored?.isFulfilled === false, `${status} did not activate Premium`);
  }

  const unknownPayload = {
    payment_id: 5999999,
    payment_status: 'finished',
    price_amount: 200,
    price_currency: 'usd',
    pay_amount: 200,
    actually_paid: 200,
    pay_currency: 'usdttrc20',
    order_id: 'ORD_DOES_NOT_EXIST_999'
  };
  const unknown = await postWebhook(
    '/api/v1/payments/nowpayments/webhook',
    unknownPayload,
    sign(unknownPayload)
  );
  assert(unknown.status === 200, 'unknown order returns HTTP 200 (no provider retry storm)', unknown);
  assert(unknown.body?.data?.ignored === true, 'unknown order is ignored safely');

  // -------------------------------------------------------------------
  console.log('\n[8. Refund after fulfillment]');
  const refundPayload = {
    payment_id: 5010001,
    payment_status: 'refunded',
    price_amount: orderA.priceUsd,
    price_currency: 'usd',
    pay_amount: orderA.priceUsd,
    actually_paid: orderA.priceUsd,
    pay_currency: 'usdttrc20',
    order_id: orderA.orderId,
    updated_at: new Date().toISOString()
  };
  const refund = await postWebhook(
    '/api/v1/payments/nowpayments/webhook',
    refundPayload,
    sign(refundPayload)
  );
  assert(refund.status === 200, 'refund webhook accepted', refund);
  storedA = await PaymentModel.findOne({ orderId: orderA.orderId });
  assert(storedA?.status === PaymentStatus.REFUNDED, 'payment marked REFUNDED');
  const refundedSub = await SubscriptionModel.findById(activeSub?._id);
  assert(refundedSub?.isRevoked === true, 'linked subscription revoked after refund');
  assert(refundedSub?.status === SubscriptionStatus.REVOKED, 'subscription status is REVOKED');

  // -------------------------------------------------------------------
  console.log('\n[9. API aliases, ownership and history]');
  const orderE = await newOrder(buyer._id.toString(), 'PLAN_1_MONTH');
  const payloadE = finishedPayload(orderE, 5010005);
  const aliasResult = await postWebhook('/api/nowpayments/webhook', payloadE, sign(payloadE));
  assert(aliasResult.status === 200, 'POST /api/nowpayments/webhook alias works', aliasResult);
  assert(aliasResult.body?.data?.isFulfilled === true, 'alias route activates after finished');

  const orderE2 = await newOrder(buyer._id.toString(), 'PLAN_1_MONTH');
  const payloadE2 = finishedPayload(orderE2, 5010009);
  const specAlias = await postWebhook('/api/payments/nowpayments/webhook', payloadE2, sign(payloadE2));
  assert(specAlias.status === 200, 'POST /api/payments/nowpayments/webhook alias works', specAlias);
  assert(specAlias.body?.data?.isFulfilled === true, 'specification alias activates after finished');

  const orderE3 = await newOrder(buyer._id.toString(), 'PLAN_1_MONTH');
  const payloadE3 = finishedPayload(orderE3, 5010010);
  const webhooksAlias = await postWebhook('/api/webhooks/nowpayments', payloadE3, sign(payloadE3));
  assert(webhooksAlias.status === 200, 'POST /api/webhooks/nowpayments alias works', webhooksAlias);
  assert(webhooksAlias.body?.data?.isFulfilled === true, 'webhooks alias activates after finished');

  const history = await get('/api/payments/history', buyerToken);
  assert(history.status === 200, 'authenticated payment history works', history);
  assert(Array.isArray(history.body?.data?.payments), 'payment history returns an array');
  assert(
    history.body.data.payments.every((p: any) => p.orderId.startsWith('ORD_')),
    'history contains only payment records'
  );
  assert(
    history.body.data.payments.every((p: any) => p.userId === undefined),
    'history does not leak another user identifier'
  );

  const createAliasResponse = await fetch(`${baseUrl}/api/payments/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${buyerToken}`
    },
    body: JSON.stringify({ planId: 'PLAN_1_MONTH' })
  });
  const createAliasBody = await createAliasResponse.json().catch(() => ({}));
  assert(createAliasResponse.status === 201, 'POST /api/payments/create alias works', createAliasBody);
  assert(createAliasBody?.data?.priceUsd === 200, 'alias uses server-authoritative plan price');

  const ownPayment = await get(`/api/payments/${orderE.orderId}`, buyerToken);
  assert(ownPayment.status === 200, 'owner can read payment status', ownPayment);

  const foreignPayment = await get(`/api/payments/${orderE.orderId}`, attackerToken);
  assert(foreignPayment.status === 403, 'another user cannot read the payment', foreignPayment);

  const unauthenticated = await get('/api/payments/history');
  assert(unauthenticated.status === 401, 'unauthenticated history request is rejected', unauthenticated);

  const subscriptionsMe = await get('/api/subscriptions/me', buyerToken);
  assert(subscriptionsMe.status === 200, 'GET /api/subscriptions/me works', subscriptionsMe);
  assert(
    subscriptionsMe.body?.data?.active?.status === SubscriptionStatus.ACTIVE,
    'current subscription returned'
  );

  // -------------------------------------------------------------------
  console.log('\n[10. Independent provider verification]');
  const originalGetPayment = (nowPaymentsService as any).getPayment;
  const originalApiKey = env.NOWPAYMENTS_API_KEY;
  const originalRequireVerification = env.NOWPAYMENTS_REQUIRE_API_VERIFICATION;

  const orderF = await newOrder(buyer._id.toString(), 'PLAN_1_MONTH');
  const payloadF = finishedPayload(orderF, 5010006);
  let providerVerifiedPayment: any = {
    payment_id: 5010006,
    order_id: orderF.orderId,
    payment_status: 'finished',
    price_amount: orderF.priceUsd,
    price_currency: 'usd',
    pay_amount: orderF.priceUsd,
    actually_paid: orderF.priceUsd,
    pay_currency: 'usdttrc20'
  };

  try {
    env.NOWPAYMENTS_API_KEY = 'test-provider-key';
    env.NOWPAYMENTS_REQUIRE_API_VERIFICATION = true;
    (nowPaymentsService as any).getPayment = async () => providerVerifiedPayment;

    const verifiedResult = await postWebhook(
      '/api/v1/payments/nowpayments/webhook',
      payloadF,
      sign(payloadF)
    );
    assert(verifiedResult.status === 200, 'provider-verified finished webhook accepted', verifiedResult);
    assert(verifiedResult.body?.data?.providerVerified === true, 'provider verification flag returned');
    const verifiedStored = await PaymentModel.findOne({ orderId: orderF.orderId });
    assert(verifiedStored?.isFulfilled === true, 'provider-verified payment fulfilled');
    assert(verifiedStored?.providerVerified === true, 'providerVerified stored on payment');

    const orderG = await newOrder(buyer._id.toString(), 'PLAN_1_MONTH');
    const payloadG = finishedPayload(orderG, 5010007);
    providerVerifiedPayment = {
      ...providerVerifiedPayment,
      payment_id: 5010007,
      order_id: orderG.orderId,
      payment_status: 'confirmed'
    };
    const notFinalProvider = await postWebhook(
      '/api/v1/payments/nowpayments/webhook',
      payloadG,
      sign(payloadG)
    );
    assert(notFinalProvider.status === 200, 'provider non-final response acknowledged', notFinalProvider);
    const notFinalStored = await PaymentModel.findOne({ orderId: orderG.orderId });
    assert(notFinalStored?.isFulfilled === false, 'provider non-final response did not activate Premium');

    const orderH = await newOrder(buyer._id.toString(), 'PLAN_1_MONTH');
    const payloadH = finishedPayload(orderH, 5010008);
    providerVerifiedPayment = {
      ...providerVerifiedPayment,
      payment_id: 5010008,
      order_id: 'ORD_MISMATCHED_PROVIDER_ORDER',
      payment_status: 'finished'
    };
    const mismatchedProvider = await postWebhook(
      '/api/v1/payments/nowpayments/webhook',
      payloadH,
      sign(payloadH)
    );
    assert(mismatchedProvider.status === 200, 'mismatched provider order acknowledged', mismatchedProvider);
    assert(mismatchedProvider.body?.data?.success === false, 'mismatched provider order rejected');
    const mismatchedStored = await PaymentModel.findOne({ orderId: orderH.orderId });
    assert(mismatchedStored?.isFulfilled === false, 'mismatched provider order did not activate Premium');
    assert(mismatchedStored?.status === PaymentStatus.REVIEW_REQUIRED, 'mismatched provider order flagged for review');
  } finally {
    (nowPaymentsService as any).getPayment = originalGetPayment;
    env.NOWPAYMENTS_API_KEY = originalApiKey;
    env.NOWPAYMENTS_REQUIRE_API_VERIFICATION = originalRequireVerification;
  }

  // -------------------------------------------------------------------
  console.log('\n[11. Production live-mode gate]');
  const gateApiKey = env.NOWPAYMENTS_API_KEY;
  const gateEnv = env.NOWPAYMENTS_ENV;
  const gateLive = env.NOWPAYMENTS_LIVE_ENABLED;
  try {
    env.NOWPAYMENTS_ENV = 'production';
    env.NOWPAYMENTS_LIVE_ENABLED = false;
    env.NOWPAYMENTS_API_KEY = 'test-provider-key';

    let liveBlocked = false;
    try {
      await newOrder(buyer._id.toString(), 'PLAN_1_MONTH');
    } catch (error: any) {
      liveBlocked = Number(error?.statusCode) === 503;
    }
    assert(liveBlocked, 'production checkout is blocked while NOWPAYMENTS_LIVE_ENABLED=false');
  } finally {
    env.NOWPAYMENTS_API_KEY = gateApiKey;
    env.NOWPAYMENTS_ENV = gateEnv;
    env.NOWPAYMENTS_LIVE_ENABLED = gateLive;
  }

  // -------------------------------------------------------------------
  console.log('\n=============================================');
  console.log(`  PHASE 10 RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('=============================================\n');
}

run()
  .catch((error) => {
    console.error('Unhandled Phase 10 test failure:', error);
    failedTests++;
  })
  .finally(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    await mongoose.disconnect().catch(() => null);
    await mongod?.stop().catch(() => null);
    process.exit(failedTests > 0 ? 1 : 0);
  });
