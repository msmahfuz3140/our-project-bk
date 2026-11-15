import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { paymentService } from '../services/payment.service';
import { nowPaymentsService } from '../services/nowpayments.service';
import { subscriptionAccessService } from '../services/subscriptionAccess.service';
import { UserModel } from '../models/User';
import { PaymentModel } from '../models/Payment';
import { SubscriptionModel } from '../models/Subscription';
import { FinancialLedgerModel } from '../models/FinancialLedger';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { UserRole } from '../shared/roles';
import { PaymentStatus, SubscriptionStatus } from '../shared/subscriptions';
import { calculatePlanExpiration } from '../shared/plans';
import { hashPassword } from '../utils/crypto';

let mongod: MongoMemoryServer;

const TEST_IPN_SECRET = 'test_ipn_secret_nowpayments_mock_secure_hash_key_12345';

async function setupTestDb() {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  console.log('Phase 5 Test in-memory MongoDB connected.');
}

async function teardownTestDb() {
  await mongoose.disconnect();
  await mongod.stop();
  console.log('Phase 5 Test in-memory MongoDB stopped.');
}

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, errorDetail?: any) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`  ✗ FAIL: ${testName}`, errorDetail || '');
    failedTests++;
  }
}

async function runPhase5Tests() {
  console.log('\n=============================================');
  console.log('  STARTING PHASE 5 TEST SUITE');
  console.log('  NOWPayments Production Integration & IPN');
  console.log('=============================================\n');

  try {
    await setupTestDb();

    // -------------------------------------------------------------
    // Base Users Setup
    // -------------------------------------------------------------
    const superAdmin = await UserModel.create({
      name: 'Super Admin PayManager',
      email: 'superadmin_pay@rouletteaccuracy.com',
      passwordHash: await hashPassword('AdminPass123!'),
      role: UserRole.SUPER_ADMIN,
      isEmailVerified: true
    });

    const moderator = await UserModel.create({
      name: 'Partner Mod Affiliate',
      email: 'affiliate_mod@rouletteaccuracy.com',
      passwordHash: await hashPassword('ModPass123!'),
      role: UserRole.MODERATOR,
      referralCode: 'MOD_REF_PARTNER_01',
      isEmailVerified: true
    });

    const standardBuyer = await UserModel.create({
      name: 'Crypto Payer One',
      email: 'buyer1@example.com',
      passwordHash: await hashPassword('BuyerPass123!'),
      role: UserRole.USER,
      isEmailVerified: true
    });

    const referredBuyer = await UserModel.create({
      name: 'Referred Crypto Payer',
      email: 'buyer_referred@example.com',
      passwordHash: await hashPassword('BuyerPass123!'),
      role: UserRole.USER,
      referredBy: moderator._id,
      isEmailVerified: true
    });

    const renewingBuyer = await UserModel.create({
      name: 'Renewing Subscriber',
      email: 'renewing@example.com',
      passwordHash: await hashPassword('BuyerPass123!'),
      role: UserRole.USER,
      isEmailVerified: true
    });

    // -------------------------------------------------------------
    // SUITE 1: Purchase Order Creation & Snapshotting
    // -------------------------------------------------------------
    console.log('[Suite 1: Purchase Order Creation & Snapshotting]');

    const order1 = await paymentService.createPurchaseOrder(standardBuyer._id.toString(), 'PLAN_1_MONTH', 'USDTTRC20');
    assert(order1.orderId.startsWith('ORD_'), 'Generates standard ORD_ prefix orderId');
    assert(order1.priceUsd === 200, 'Authoritative plan priceUsd snapshot is $200');
    assert(order1.priceCents === 20000, 'Authoritative plan priceCents snapshot is 20,000');
    assert(order1.status === PaymentStatus.WAITING, 'Order initialized to WAITING status');
    assert(Boolean(order1.checkoutUrl), 'Checkout URL generated for client redirection');

    // -------------------------------------------------------------
    // SUITE 2: Successful Qualifying Payment & Subscription Activation
    // -------------------------------------------------------------
    console.log('\n[Suite 2: Qualifying Payment & Subscription Activation]');

    const ipnPayloadSuccess = {
      payment_id: 1000101,
      payment_status: 'finished',
      pay_address: 'TX_USDT_TRC20_WALLET_ADDRESS_DEMO_01',
      price_amount: 200,
      price_currency: 'usd',
      pay_amount: 200,
      actually_paid: 200,
      pay_currency: 'usdttrc20',
      order_id: order1.orderId,
      order_description: 'Roulette Accuracy — 1 Month Pro',
      purchase_id: 'PURCHASE_1001'
    };

    const sigSuccess = nowPaymentsService.generateIpnSignature(ipnPayloadSuccess, TEST_IPN_SECRET);
    const resultSuccess = await paymentService.processIpnCallback(ipnPayloadSuccess, sigSuccess, TEST_IPN_SECRET);

    assert(resultSuccess.success === true, 'processIpnCallback returns success: true');
    assert(resultSuccess.status === PaymentStatus.FINISHED, 'Payment status updated to FINISHED');
    assert(resultSuccess.isFulfilled === true, 'Order marked as fulfilled');
    assert(Boolean(resultSuccess.subscriptionId), 'Subscription created and linked to payment');

    // Verify database state for fulfilled payment
    const dbPayment = await PaymentModel.findOne({ orderId: order1.orderId });
    assert(dbPayment?.status === PaymentStatus.FINISHED, 'Database payment status is FINISHED');
    assert(dbPayment?.isFulfilled === true, 'Database payment isFulfilled flag is true');
    assert(dbPayment?.subscriptionId?.toString() === resultSuccess.subscriptionId, 'Database subscriptionId reference matches');

    // Verify Financial Ledger Entry
    const ledgerEntry = await FinancialLedgerModel.findOne({ orderId: order1.orderId });
    assert(ledgerEntry !== null, 'Immutable Financial Ledger entry was created');
    assert(ledgerEntry?.amountCents === 20000, 'Ledger recorded exactly 20,000 cents');
    assert(ledgerEntry?.status === 'SETTLED', 'Ledger status recorded as SETTLED');

    // Verify user now has live tool access
    const buyer1Access = await subscriptionAccessService.checkAccess(standardBuyer._id.toString());
    assert(buyer1Access.hasAccess === true, 'Buyer now has confirmed active subscription access');
    assert(buyer1Access.code === 'ACCESS_GRANTED', 'Access code is ACCESS_GRANTED');
    assert(buyer1Access.status === SubscriptionStatus.ACTIVE, 'Access status is ACTIVE');

    // -------------------------------------------------------------
    // SUITE 3: Active Subscription Renewal Rule (Continuous Extension)
    // -------------------------------------------------------------
    console.log('\n[Suite 3: Active Subscription Renewal Rule]');

    // Setup user with existing subscription that expires in 15 days
    const now = new Date();
    const existingExpiry = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000); // +15 days

    const preExistingSub = await SubscriptionModel.create({
      userId: renewingBuyer._id,
      planId: 'PLAN_15_DAYS',
      status: SubscriptionStatus.ACTIVE,
      startDate: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      endDate: existingExpiry,
      isManualGrant: false
    });

    // User purchases 3 Months Master plan ($450)
    const renewalOrder = await paymentService.createPurchaseOrder(renewingBuyer._id.toString(), 'PLAN_3_MONTHS', 'USDTTRC20');

    const ipnPayloadRenewal = {
      payment_id: 1000102,
      payment_status: 'finished',
      price_amount: 450,
      price_currency: 'usd',
      pay_amount: 450,
      actually_paid: 450,
      pay_currency: 'usdttrc20',
      order_id: renewalOrder.orderId
    };

    const sigRenewal = nowPaymentsService.generateIpnSignature(ipnPayloadRenewal, TEST_IPN_SECRET);
    const resultRenewal = await paymentService.processIpnCallback(ipnPayloadRenewal, sigRenewal, TEST_IPN_SECRET);

    assert(resultRenewal.success === true, 'Renewal IPN callback processed successfully');
    assert(resultRenewal.isFulfilled === true, 'Renewal order fulfilled');

    // The new subscription end date must extend from preExistingSub.endDate, NOT from now!
    const expectedRenewalEnd = calculatePlanExpiration(existingExpiry, { unit: 'MONTHS', value: 3 });
    const renewingBuyerAccess = await subscriptionAccessService.checkAccess(renewingBuyer._id.toString());

    assert(
      renewingBuyerAccess.hasAccess === true,
      'Renewing user maintains active access'
    );
    assert(
      Math.abs(new Date(renewingBuyerAccess.endDate!).getTime() - expectedRenewalEnd.getTime()) < 10000,
      'Renewal rule: Expiry extended seamlessly from pre-existing expiry date (not from today)'
    );

    // -------------------------------------------------------------
    // SUITE 4: Idempotency & Duplicate Webhook Event Protection
    // -------------------------------------------------------------
    console.log('\n[Suite 4: Idempotency & Duplicate Webhook Protection]');

    const subCountBefore = await SubscriptionModel.countDocuments({ userId: standardBuyer._id });
    const ledgerCountBefore = await FinancialLedgerModel.countDocuments({ orderId: order1.orderId });

    // Send the exact same webhook again
    const resultDuplicate = await paymentService.processIpnCallback(ipnPayloadSuccess, sigSuccess, TEST_IPN_SECRET);

    assert(resultDuplicate.success === true, 'Duplicate webhook returns success: true without error');
    assert(resultDuplicate.duplicate === true, 'Duplicate webhook identifies duplicate: true');
    assert(resultDuplicate.isFulfilled === true, 'Duplicate webhook maintains fulfilled state');

    const subCountAfter = await SubscriptionModel.countDocuments({ userId: standardBuyer._id });
    const ledgerCountAfter = await FinancialLedgerModel.countDocuments({ orderId: order1.orderId });

    assert(subCountAfter === subCountBefore, 'Duplicate webhook did NOT create duplicate subscription');
    assert(ledgerCountAfter === ledgerCountBefore, 'Duplicate webhook did NOT duplicate financial ledger entry');

    // -------------------------------------------------------------
    // SUITE 5: Cryptographic Webhook Signature Enforcement
    // -------------------------------------------------------------
    console.log('\n[Suite 5: Cryptographic Webhook Signature Enforcement]');

    let signatureRejected = false;
    try {
      await paymentService.processIpnCallback(ipnPayloadSuccess, 'invalid_fake_tampered_signature_hex', TEST_IPN_SECRET);
    } catch (err: any) {
      if (err.statusCode === 401) signatureRejected = true;
    }
    assert(signatureRejected === true, 'Invalid cryptographic signature rejected with HTTP 401 Unauthorized');

    let missingSignatureRejected = false;
    try {
      await paymentService.processIpnCallback(ipnPayloadSuccess, undefined, TEST_IPN_SECRET);
    } catch (err: any) {
      if (err.statusCode === 401) missingSignatureRejected = true;
    }
    assert(missingSignatureRejected === true, 'Missing signature header rejected with HTTP 401 Unauthorized');

    // -------------------------------------------------------------
    // SUITE 6: Security Validation (Amount & Currency Mismatch Guard)
    // -------------------------------------------------------------
    console.log('\n[Suite 6: Security Validation (Amount & Currency Tampering)]');

    const orderTamper = await paymentService.createPurchaseOrder(standardBuyer._id.toString(), 'PLAN_1_YEAR', 'USDTTRC20'); // $1,000

    // Tampered amount: Attacker tries to confirm a $1,000 plan by sending $10
    const ipnTamperedAmount = {
      payment_id: 1000103,
      payment_status: 'finished',
      price_amount: 10, // Tampered! Expected 1,000
      price_currency: 'usd',
      order_id: orderTamper.orderId
    };

    const sigTamperedAmount = nowPaymentsService.generateIpnSignature(ipnTamperedAmount, TEST_IPN_SECRET);
    const resultTamperedAmount = await paymentService.processIpnCallback(ipnTamperedAmount, sigTamperedAmount, TEST_IPN_SECRET);

    assert(resultTamperedAmount.success === false, 'Tampered amount callback returns success: false');
    assert(resultTamperedAmount.isFulfilled === false, 'Tampered amount did NOT fulfill order');
    assert(resultTamperedAmount.status === PaymentStatus.REVIEW_REQUIRED, 'Order flagged as REVIEW_REQUIRED');

    // Tampered currency: Attacker sends EUR instead of USD
    const orderTamperCurr = await paymentService.createPurchaseOrder(standardBuyer._id.toString(), 'PLAN_6_MONTHS', 'USDTTRC20');

    const ipnTamperedCurr = {
      payment_id: 1000104,
      payment_status: 'finished',
      price_amount: 700,
      price_currency: 'eur', // Tampered! Expected USD
      order_id: orderTamperCurr.orderId
    };

    const sigTamperedCurr = nowPaymentsService.generateIpnSignature(ipnTamperedCurr, TEST_IPN_SECRET);
    const resultTamperedCurr = await paymentService.processIpnCallback(ipnTamperedCurr, sigTamperedCurr, TEST_IPN_SECRET);

    assert(resultTamperedCurr.success === false, 'Tampered currency callback returns success: false');
    assert(resultTamperedCurr.status === PaymentStatus.REVIEW_REQUIRED, 'Order flagged as REVIEW_REQUIRED');

    // -------------------------------------------------------------
    // SUITE 7: Underpayment Handling (partially_paid)
    // -------------------------------------------------------------
    console.log('\n[Suite 7: Underpayment Handling (partially_paid)]');

    const orderUnderpay = await paymentService.createPurchaseOrder(standardBuyer._id.toString(), 'PLAN_1_MONTH', 'USDTTRC20');

    const ipnUnderpay = {
      payment_id: 1000105,
      payment_status: 'partially_paid',
      price_amount: 200,
      price_currency: 'usd',
      pay_amount: 200,
      actually_paid: 120, // Only $120 of $200 sent
      pay_currency: 'usdttrc20',
      order_id: orderUnderpay.orderId
    };

    const sigUnderpay = nowPaymentsService.generateIpnSignature(ipnUnderpay, TEST_IPN_SECRET);
    const resultUnderpay = await paymentService.processIpnCallback(ipnUnderpay, sigUnderpay, TEST_IPN_SECRET);

    assert(resultUnderpay.status === PaymentStatus.PARTIALLY_PAID, 'Order marked as PARTIALLY_PAID');
    assert(resultUnderpay.isFulfilled === false, 'Underpaid order was NOT fulfilled');

    // -------------------------------------------------------------
    // SUITE 8: Terminal Failure & Expiration States
    // -------------------------------------------------------------
    console.log('\n[Suite 8: Failure & Expiration States]');

    const orderFail = await paymentService.createPurchaseOrder(standardBuyer._id.toString(), 'PLAN_15_DAYS', 'USDTTRC20');

    const ipnFail = {
      payment_id: 1000106,
      payment_status: 'failed',
      price_amount: 150,
      price_currency: 'usd',
      order_id: orderFail.orderId
    };

    const sigFail = nowPaymentsService.generateIpnSignature(ipnFail, TEST_IPN_SECRET);
    const resultFail = await paymentService.processIpnCallback(ipnFail, sigFail, TEST_IPN_SECRET);

    assert(resultFail.status === PaymentStatus.FAILED, 'Failed payment marked as FAILED');
    assert(resultFail.isFulfilled === false, 'Failed payment does not activate subscription');

    const orderExp = await paymentService.createPurchaseOrder(standardBuyer._id.toString(), 'PLAN_15_DAYS', 'USDTTRC20');

    const ipnExp = {
      payment_id: 1000107,
      payment_status: 'expired',
      price_amount: 150,
      price_currency: 'usd',
      order_id: orderExp.orderId
    };

    const sigExp = nowPaymentsService.generateIpnSignature(ipnExp, TEST_IPN_SECRET);
    const resultExp = await paymentService.processIpnCallback(ipnExp, sigExp, TEST_IPN_SECRET);

    assert(resultExp.status === PaymentStatus.EXPIRED, 'Expired payment marked as EXPIRED');
    assert(resultExp.isFulfilled === false, 'Expired payment does not activate subscription');

    // -------------------------------------------------------------
    // SUITE 9: Unknown Order ID Safe Handling
    // -------------------------------------------------------------
    console.log('\n[Suite 9: Unknown Order Handling]');

    const ipnUnknown = {
      payment_id: 9999999,
      payment_status: 'finished',
      price_amount: 200,
      price_currency: 'usd',
      order_id: 'ORD_NONEXISTENT_99999'
    };

    const sigUnknown = nowPaymentsService.generateIpnSignature(ipnUnknown, TEST_IPN_SECRET);
    const resultUnknown = await paymentService.processIpnCallback(ipnUnknown, sigUnknown, TEST_IPN_SECRET);

    assert(resultUnknown.success === false, 'Unknown order returns success: false');
    assert(resultUnknown.isFulfilled === false, 'Unknown order is not fulfilled');

    // -------------------------------------------------------------
    // SUITE 10: Moderator Referral Commission Attribution (50%)
    // -------------------------------------------------------------
    console.log('\n[Suite 10: Moderator Commission Attribution (50%)]');

    const referredOrder = await paymentService.createPurchaseOrder(referredBuyer._id.toString(), 'PLAN_1_MONTH', 'USDTTRC20'); // $200

    const ipnReferred = {
      payment_id: 1000108,
      payment_status: 'finished',
      price_amount: 200,
      price_currency: 'usd',
      order_id: referredOrder.orderId
    };

    const sigReferred = nowPaymentsService.generateIpnSignature(ipnReferred, TEST_IPN_SECRET);
    await paymentService.processIpnCallback(ipnReferred, sigReferred, TEST_IPN_SECRET);

    const commission = await ReferralCommissionModel.findOne({ orderId: referredOrder.orderId });
    // Or matched by referredUserId
    const modCommission = await ReferralCommissionModel.findOne({ referredUserId: referredBuyer._id });

    assert(modCommission !== null, 'Moderator referral commission record was created');
    assert(modCommission?.moderatorId.toString() === moderator._id.toString(), 'Commission assigned to correct Moderator');
    assert(modCommission?.amountUsd === 100, 'Commission is exactly 50% ($100 on $200 sale)');
    assert(modCommission?.status === 'CREDITED', 'Commission status is CREDITED');

    // -------------------------------------------------------------
    // SUITE 11: Admin Payment Management & Reporting
    // -------------------------------------------------------------
    console.log('\n[Suite 11: Admin Payment Management & Reporting]');

    // 1. Search by user email
    const searchRes = await paymentService.getAdminOrders({ search: 'buyer1@example.com' });
    assert(searchRes.orders.length > 0, 'Admin can search orders by customer email');

    // 2. Filter by status
    const finishedOrders = await paymentService.getAdminOrders({ status: PaymentStatus.FINISHED });
    assert(finishedOrders.orders.every(o => o.status === PaymentStatus.FINISHED), 'Admin can filter orders by status');

    // 3. Admin Financial Summary
    const summary = await paymentService.getAdminSummary();
    assert(summary.totalOrders > 0, 'Admin summary counts total orders');
    assert(summary.completedOrders > 0, 'Admin summary counts completed orders');
    assert(summary.totalGrossUsd > 0, 'Admin summary computes total gross USD');

    // 4. Admin Export Report
    const exportData = await paymentService.exportAdminReport();
    assert(exportData.count > 0, 'Export report includes order count');
    assert(exportData.csv.includes('Order ID,Payment ID,Customer Email'), 'Export report generates standard CSV headers');
    assert(exportData.csv.includes(order1.orderId), 'Export report includes created order IDs');

    // -------------------------------------------------------------
    // Test Summary
    // -------------------------------------------------------------
    console.log('\n=============================================');
    console.log(`  PHASE 5 TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
    console.log('=============================================\n');

    if (failedTests > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('Unhandled test suite failure in Phase 5:', error);
    process.exit(1);
  } finally {
    await teardownTestDb();
  }
}

runPhase5Tests();
