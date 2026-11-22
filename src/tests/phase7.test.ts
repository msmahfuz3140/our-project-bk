import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import assert from 'assert';
import { UserModel, AccountStatus } from '../models/User';
import { PaymentModel } from '../models/Payment';
import { SubscriptionModel } from '../models/Subscription';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { CommissionPolicyModel } from '../models/CommissionPolicy';
import { AuditLogModel } from '../models/AuditLog';
import { authService } from '../services/auth.service';
import { paymentService } from '../services/payment.service';
import { nowPaymentsService } from '../services/nowpayments.service';
import { moderatorService } from '../services/moderator.service';
import { UserRole } from '../shared/roles';
import { hashPassword } from '../utils/crypto';
import { PaymentStatus } from '../shared/subscriptions';

const TEST_IPN_SECRET = 'test_ipn_secret_nowpayments_mock_secure_hash_key_12345';

async function simulateIpnCallback(paymentDoc: any, status: string = 'finished', actuallyPaid: number = 200) {
  const ipnPayload = {
    payment_id: paymentDoc.paymentId,
    payment_status: status,
    pay_address: 'TX_USDT_TRC20_WALLET_ADDRESS_DEMO_01',
    price_amount: paymentDoc.priceAmount,
    price_currency: 'usd',
    pay_amount: paymentDoc.payAmount || paymentDoc.priceAmount,
    actually_paid: actuallyPaid,
    pay_currency: 'usdttrc20',
    order_id: paymentDoc.orderId,
    order_description: `Roulette Accuracy — ${paymentDoc.planName}`,
    purchase_id: paymentDoc.orderId
  };
  const signature = nowPaymentsService.generateIpnSignature(ipnPayload, TEST_IPN_SECRET);
  return await paymentService.processIpnCallback(ipnPayload, signature, TEST_IPN_SECRET);
}

let mongoServer: MongoMemoryServer;

async function setupTestDb() {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
  console.log('Phase 7 Test in-memory MongoDB connected.');
}

async function teardownTestDb() {
  await mongoose.disconnect();
  await mongoServer.stop();
  console.log('Phase 7 Test in-memory MongoDB stopped.');
}

async function runPhase7Tests() {
  console.log('\n=============================================');
  console.log('  STARTING PHASE 7 TEST SUITE');
  console.log('  Moderator Management & Referral Attribution');
  console.log('=============================================\n');

  await setupTestDb();

  let passed = 0;
  let failed = 0;

  function testAssert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${msg}`);
      failed++;
      throw new Error(`Test assertion failed: ${msg}`);
    }
  }

  try {
    // -----------------------------------------------------------------------
    // Setup Super Admin Actor
    // -----------------------------------------------------------------------
    const superAdmin = await UserModel.create({
      name: 'Owner Admin 1',
      email: 'owner1@rouletteaccuracy.com',
      passwordHash: await hashPassword('AdminPass123!'),
      role: UserRole.SUPER_ADMIN,
      isEmailVerified: true,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE
    });

    // --- Suite 1: Moderator Provisioning & Unguessable Code Generation ---
    console.log('\n--- Suite 1: Moderator Provisioning & Unique Code Generation ---');

    const modResult = await moderatorService.createModerator(
      superAdmin._id.toString(),
      superAdmin.email,
      {
        name: 'VIP Affiliate Partner',
        email: 'affiliate1@roulette.partners',
        phone: '+8801811223344',
        password: 'PartnerSecurePass123!',
        commissionRate: 0.50,
        notes: 'Signed tier 1 streaming affiliate contract'
      }
    );

    testAssert(modResult.moderator.role === UserRole.MODERATOR, 'Created user role is strictly MODERATOR');
    testAssert(modResult.referralCode.startsWith('MOD_'), 'Unique referral code has MOD_ prefix');
    testAssert(modResult.referralCode.length >= 10, 'Referral code is unguessable and sufficiently random');
    testAssert(modResult.moderator.accountStatus === AccountStatus.ACTIVE, 'Moderator account status is ACTIVE');

    // Duplicate email check
    let dupEmailCaught = false;
    try {
      await moderatorService.createModerator(
        superAdmin._id.toString(),
        superAdmin.email,
        {
          name: 'Duplicate Affiliate',
          email: 'affiliate1@roulette.partners',
          password: 'PartnerSecurePass123!'
        }
      );
    } catch {
      dupEmailCaught = true;
    }
    testAssert(dupEmailCaught, 'Rejects duplicate moderator email registration');

    // Audit log check
    const createAudit = await AuditLogModel.findOne({
      action: 'MODERATOR_CREATE',
      targetUserEmail: 'affiliate1@roulette.partners'
    });
    testAssert(createAudit !== null, 'MODERATOR_CREATE audit log recorded');
    testAssert(createAudit?.adminId.toString() === superAdmin._id.toString(), 'Audit log tracks initiating Super Admin');

    const moderatorUser = await UserModel.findById(modResult.moderator.id);
    assert(moderatorUser, 'Moderator user must exist');

    // --- Suite 2: Referral Code Attribution & Anti-Fraud Checks ---
    console.log('\n--- Suite 2: Referral Attribution & Anti-Fraud Protection ---');

    // Test 2.1: Valid customer registration with moderator code
    const customer1Reg = await authService.register({
      name: 'Referred Customer One',
      email: 'customer1@casino.com',
      password: 'CustomerPass123!',
      referralCode: moderatorUser.referralCode
    });

    const customer1 = await UserModel.findOne({ email: 'customer1@casino.com' });
    testAssert(customer1?.referredBy?.toString() === moderatorUser._id.toString(), 'Customer successfully attributed to Moderator');
    testAssert(customer1?.referredAt !== undefined, 'Referral attribution timestamp recorded');
    testAssert(customer1?.referralCodeUsed === moderatorUser.referralCode, 'Referral code snapshot stored on customer');

    const attributionAudit = await AuditLogModel.findOne({
      action: 'REFERRAL_ATTRIBUTION',
      targetUserId: customer1?._id
    });
    testAssert(attributionAudit !== null, 'REFERRAL_ATTRIBUTION audit log recorded');

    // Test 2.1b: Invalid non-existent referral code must reject registration
    let invalidCodeRejected = false;
    try {
      await authService.register({
        name: 'Buyer with Invalid Code',
        email: 'buyer.invalid.code@test.com',
        password: 'Pass12345678!',
        referralCode: 'MOD_DOES_NOT_EXIST_XYZ'
      });
    } catch (err: any) {
      invalidCodeRejected = err?.code === 'INVALID_REFERRAL_CODE' || err?.statusCode === 400;
    }
    assert(invalidCodeRejected, 'Invalid referral code rejects registration');
    assert(
      (await UserModel.findOne({ email: 'buyer.invalid.code@test.com' })) === null,
      'Invalid referral code creates no account'
    );

    // Test 2.2: Self-referral prevention (Moderator attempts to register with own phone)
    let selfReferralRejected = false;
    try {
      await authService.register({
        name: 'Fraud Self Attempt',
        email: 'affiliate1@roulette.partners.duplicate.com',
        phone: '+8801811223344', // Moderator's phone!
        password: 'Pass12345678!',
        referralCode: moderatorUser.referralCode
      });
    } catch (err: any) {
      selfReferralRejected = err?.code === 'SELF_REFERRAL_NOT_ALLOWED';
    }
    assert(selfReferralRejected, 'Self-referral registration is rejected');
    assert(
      (await UserModel.findOne({ email: 'affiliate1@roulette.partners.duplicate.com' })) === null,
      'Self-referral attempt creates no account'
    );

    const selfAudit = await AuditLogModel.findOne({
      action: 'REFERRAL_FRAUD_FLAG'
    });
    assert(selfAudit !== null, 'Self-referral attempt detected and flagged in audit log');

    // Test 2.3: Normal user referral code is now a valid one-time referrer
    const normalUser = await UserModel.create({
      name: 'Normal User',
      email: 'normal@user.com',
      passwordHash: await hashPassword('UserPass123!'),
      role: UserRole.USER,
      referralCode: 'USER_CODE_XYZ',
      isEmailVerified: true,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE,
      referralEligible: true
    });

    await authService.register({
      name: 'Buyer Under Normal User',
      email: 'buyer.under.user@test.com',
      password: 'Pass12345678!',
      referralCode: normalUser.referralCode
    });

    const buyerUnderUser = await UserModel.findOne({ email: 'buyer.under.user@test.com' });
    testAssert(
      buyerUnderUser?.referredBy?.toString() === normalUser._id.toString(),
      'Normal user referral code grants permanent referral attribution'
    );

    // Test 2.4: Suspended moderator code rejected
    await moderatorService.updateModeratorStatus(
      superAdmin._id.toString(),
      superAdmin.email,
      moderatorUser._id.toString(),
      AccountStatus.SUSPENDED,
      'Investigation into promotional materials'
    );

    let suspendedCodeRejected = false;
    try {
      await authService.register({
        name: 'Buyer Under Suspended Mod',
        email: 'buyer.suspended@test.com',
        password: 'Pass12345678!',
        referralCode: moderatorUser.referralCode
      });
    } catch (err: any) {
      suspendedCodeRejected = err?.code === 'INVALID_REFERRAL_CODE' || err?.statusCode === 400;
    }
    assert(suspendedCodeRejected, 'Suspended moderator referral code is rejected');
    assert(
      (await UserModel.findOne({ email: 'buyer.suspended@test.com' })) === null,
      'Suspended referral code creates no account'
    );

    // Restore moderator to ACTIVE
    await moderatorService.updateModeratorStatus(
      superAdmin._id.toString(),
      superAdmin.email,
      moderatorUser._id.toString(),
      AccountStatus.ACTIVE,
      'Investigation cleared'
    );

    // --- Suite 3: Purchase Order Snapshotting & Webhook Protection ---
    console.log('\n--- Suite 3: Server-Side Purchase Order Referral Snapshotting ---');

    // Activate customer 1
    customer1!.isActive = true;
    customer1!.isEmailVerified = true;
    await customer1!.save();

    // Customer creates purchase order for PLAN_1_MONTH ($200)
    const orderResult = await paymentService.createPurchaseOrder(
      customer1!._id.toString(),
      'PLAN_1_MONTH',
      'USDTTRC20'
    );

    const paymentDoc = await PaymentModel.findOne({ orderId: orderResult.orderId });
    testAssert(paymentDoc !== null, 'Payment order created');
    testAssert(
      paymentDoc?.referredByModeratorId?.toString() === moderatorUser._id.toString(),
      'Payment order snapshots referredByModeratorId server-side'
    );
    testAssert(
      paymentDoc?.referralCodeSnapshot === moderatorUser.referralCode,
      'Payment order snapshots referralCodeSnapshot'
    );
    testAssert(
      paymentDoc?.commissionRateSnapshot === 0.50,
      'Payment order snapshots authoritative commission rate (50%)'
    );

    // --- Suite 3b: Prevention of Commissions on Registrations & Unconfirmed Payments ---
    console.log('\n--- Suite 3b: Commission Guardrails on Registrations & Unconfirmed Payments ---');

    // 1. Ensure registration alone generates ZERO commission
    const preOrderCommissions = await ReferralCommissionModel.countDocuments({ referredUserId: customer1!._id });
    testAssert(preOrderCommissions === 0, 'Zero commission created merely from customer registration');

    // 2. Unconfirmed payment callback: WAITING status
    await simulateIpnCallback(paymentDoc!, 'waiting', 0);
    const waitingCommissions = await ReferralCommissionModel.countDocuments({ paymentId: paymentDoc!._id });
    testAssert(waitingCommissions === 0, 'Zero commission created for WAITING (unconfirmed) payments');

    // 3. Unsettled blockchain callback: CONFIRMING status
    await simulateIpnCallback(paymentDoc!, 'confirming', 200);
    const confirmingCommissions = await ReferralCommissionModel.countDocuments({ paymentId: paymentDoc!._id });
    testAssert(confirmingCommissions === 0, 'Zero commission created for CONFIRMING (unsettled) payments');

    // --- Suite 4: Commission Calculation & Idempotency Guarantee ---
    console.log('\n--- Suite 4: Commission Calculation & Idempotent Fulfillment ---');

    // Fulfill payment via verified IPN
    await simulateIpnCallback(paymentDoc!, 'finished', 200);

    const commissionDoc = await ReferralCommissionModel.findOne({ paymentId: paymentDoc!._id });
    testAssert(commissionDoc !== null, 'Commission record created on confirmed payment');
    testAssert(commissionDoc?.moderatorId.toString() === moderatorUser._id.toString(), 'Commission credited to correct Moderator');
    testAssert(commissionDoc?.referredUserId.toString() === customer1!._id.toString(), 'Commission links to customer');
    testAssert(commissionDoc?.originalPurchaseAmount === 200, 'Original purchase amount stored ($200.00)');
    testAssert(commissionDoc?.commissionableAmount === 200, 'Commissionable amount stored ($200.00)');
    testAssert(commissionDoc?.commissionRate === 0.50, 'Commission rate snapshot is exactly 50%');
    testAssert(commissionDoc?.amountUsd === 100, 'Decimal-safe commission calculation: $100.00 (50% of $200.00)');
    testAssert(commissionDoc?.status === 'CREDITED', 'Commission status initialized to CREDITED');

    // Duplicate webhook test: ensure NO duplicate commission is created
    await simulateIpnCallback(paymentDoc!, 'finished', 200);
    const totalCommissionsForOrder = await ReferralCommissionModel.countDocuments({ paymentId: paymentDoc!._id });
    testAssert(totalCommissionsForOrder === 1, 'Duplicate payment webhook does NOT duplicate commission');

    // --- Suite 5: Commission Rate Immutability & Future Sales Policy ---
    console.log('\n--- Suite 5: Commission Rate Immutability & Future Adjustments ---');

    // Main Admin updates Moderator's future commission rate to 40% (0.40)
    await moderatorService.updateModeratorCommissionRate(
      superAdmin._id.toString(),
      superAdmin.email,
      moderatorUser._id.toString(),
      0.40,
      'Tier 2 contract adjustment for future sales'
    );

    // Verify historical commission remains UNCHANGED at $100.00 (50%)
    const historicalComm = await ReferralCommissionModel.findById(commissionDoc!._id);
    testAssert(historicalComm?.commissionRate === 0.50, 'Historical commission rate snapshot is strictly preserved (50%)');
    testAssert(historicalComm?.amountUsd === 100, 'Historical commission amount is strictly preserved ($100.00)');

    // Customer creates a second purchase order for PLAN_1_MONTH ($200) under the new 40% rate
    const orderResult2 = await paymentService.createPurchaseOrder(
      customer1!._id.toString(),
      'PLAN_1_MONTH',
      'USDTTRC20'
    );
    const paymentDoc2 = await PaymentModel.findOne({ orderId: orderResult2.orderId });
    testAssert(paymentDoc2?.commissionRateSnapshot === 0.40, 'New order snapshots updated 40% commission rate');

    await simulateIpnCallback(paymentDoc2!, 'finished', 200);
    const commissionDoc2 = await ReferralCommissionModel.findOne({ paymentId: paymentDoc2!._id });
    testAssert(commissionDoc2?.commissionRate === 0.40, 'Second commission recorded at new 40% rate');
    testAssert(commissionDoc2?.amountUsd === 80, 'Second commission decimal-safe calculation: $80.00 (40% of $200.00)');

    // --- Suite 6: Commission State Transitions & Refund Handling ---
    console.log('\n--- Suite 6: Safe Commission Transitions & Refund Reversals ---');

    // Customer order 2 is refunded via IPN
    await simulateIpnCallback(paymentDoc2!, 'refunded', 200);

    const reversedComm = await ReferralCommissionModel.findById(commissionDoc2!._id);
    testAssert(reversedComm?.status === 'REVERSED', 'Refunded payment transitions commission to REVERSED');
    testAssert(reversedComm?.reversalDetails?.reason !== undefined, 'Commission reversal records audit reason');

    // Manual admin status transition with mandatory reason
    await moderatorService.updateCommissionStatus(
      superAdmin._id.toString(),
      superAdmin.email,
      commissionDoc!._id.toString(),
      'REVERSED',
      'Affiliate breach investigation correction'
    );

    const manuallyReversedComm = await ReferralCommissionModel.findById(commissionDoc!._id);
    testAssert(manuallyReversedComm?.status === 'REVERSED', 'Admin manual commission reversal executed');

    // Terminal state protection: REVERSED cannot be randomly transitioned without dual approval
    let terminalErrorCaught = false;
    try {
      await moderatorService.updateCommissionStatus(
        superAdmin._id.toString(),
        superAdmin.email,
        commissionDoc!._id.toString(),
        'APPROVED',
        'Attempt re-activation'
      );
    } catch {
      terminalErrorCaught = true;
    }
    testAssert(terminalErrorCaught, 'Terminal state protection: Cannot transition directly out of REVERSED');

    // --- Suite 6b: Unauthorized Commission Changes Protection ---
    console.log('\n--- Suite 6b: Unauthorized Commission Changes Protection ---');

    let unauthorizedRateCaught = false;
    try {
      await moderatorService.updateModeratorCommissionRate(
        normalUser._id.toString(),
        normalUser.email!,
        moderatorUser._id.toString(),
        0.30,
        'Unauthorized attempt by normal user'
      );
    } catch (err: any) {
      unauthorizedRateCaught = err.statusCode === 403;
    }
    testAssert(unauthorizedRateCaught, 'Rejects unauthorized commission rate modification by non-admin');

    let unauthorizedStatusCaught = false;
    try {
      await moderatorService.updateCommissionStatus(
        normalUser._id.toString(),
        normalUser.email!,
        commissionDoc!._id.toString(),
        'APPROVED',
        'Unauthorized status change by normal user'
      );
    } catch (err: any) {
      unauthorizedStatusCaught = err.statusCode === 403;
    }
    testAssert(unauthorizedStatusCaught, 'Rejects unauthorized commission status modification by non-admin');

    let noReasonCaught = false;
    try {
      await moderatorService.adjustCommission(
        superAdmin._id.toString(),
        superAdmin.email,
        commissionDoc!._id.toString(),
        {
          newAmountUsd: 90,
          reason: '   ' // Missing reason
        }
      );
    } catch (err: any) {
      noReasonCaught = err.statusCode === 400;
    }
    testAssert(noReasonCaught, 'Rejects commission adjustment without mandatory audit reason');

    // --- Suite 6c: Audited Manual Commission Adjustments ---
    console.log('\n--- Suite 6c: Audited Manual Commission Adjustments ---');

    const adjustedCommission = await moderatorService.adjustCommission(
      superAdmin._id.toString(),
      superAdmin.email,
      commissionDoc2!._id.toString(),
      {
        newAmountUsd: 75.50,
        notes: 'Adjusted for payment processing network gas fee deduction',
        reason: 'Authorized manual reconciliation correction'
      }
    );
    testAssert(adjustedCommission.amountUsd === 75.50, 'Manual commission amount adjustment applied ($75.50)');
    testAssert(adjustedCommission.notes?.includes('gas fee') === true, 'Adjustment notes persisted');

    const adjustmentAudit = await AuditLogModel.findOne({
      action: 'COMMISSION_ADJUSTMENT',
      targetResourceId: commissionDoc2!._id.toString()
    });
    testAssert(adjustmentAudit !== null, 'COMMISSION_ADJUSTMENT audit log recorded');
    testAssert(adjustmentAudit?.adminId.toString() === superAdmin._id.toString(), 'Audit log tracks initiating Main Admin');
    testAssert(adjustmentAudit?.reason === 'Authorized manual reconciliation correction', 'Audit log records mandatory reason');
    testAssert(adjustmentAudit?.previousValue?.amountUsd === 80, 'Audit log preserves previous commission amount ($80.00)');
    testAssert(adjustmentAudit?.newValue?.amountUsd === 75.50, 'Audit log records new adjusted commission amount ($75.50)');

    // --- Suite 7: Moderator Self-Dashboard & Non-Custodial Integrity ---
    console.log('\n--- Suite 7: Moderator Self-Dashboard & Non-Custodial Policy ---');

    const modDashboard = await moderatorService.getModeratorSelfDashboard(moderatorUser._id.toString());
    testAssert(modDashboard.profile.referralCode === moderatorUser.referralCode, 'Dashboard displays correct referral code');
    testAssert(modDashboard.profile.referralLink.includes(moderatorUser.referralCode), 'Dashboard formats full referral link');
    testAssert(modDashboard.metrics.referralRegistrations >= 1, 'Dashboard counts referral registrations');
    testAssert(
      modDashboard.nonCustodialNotice.toLowerCase().includes('non-custodial') &&
        modDashboard.nonCustodialNotice.toLowerCase().includes('withdrawn'),
      'Dashboard displays updated non-custodial earnings/withdrawal policy'
    );

    // Privacy masking check for referred users list
    const maskedUsers = await moderatorService.getModeratorSelfReferredUsers(moderatorUser._id.toString());
    testAssert(maskedUsers.customers.length >= 1, 'Returns referred customers list');
    testAssert(maskedUsers.customers[0].maskedIdentifier.includes('***'), 'Customer email/phone is privacy-masked');

    // --- Suite 8: Main Admin Referral Telemetry & CSV Export ---
    console.log('\n--- Suite 8: Main Admin Telemetry & Export ---');

    const adminOverview = await moderatorService.getReferralOverview();
    testAssert(adminOverview.totalModerators >= 1, 'Admin overview counts total moderators');
    testAssert(adminOverview.globalCommissionPolicy.defaultRate === 0.50, 'Admin overview includes authoritative policy baseline');

    const csvData = await moderatorService.exportCommissionsCsv({});
    testAssert(csvData.includes('Commission ID,Date,Moderator Name'), 'CSV report includes standard headers');
    testAssert(csvData.includes(moderatorUser.email!), 'CSV report includes moderator data rows');

    // Admin updates global default policy
    const newPolicy = await moderatorService.updateGlobalCommissionPolicy(
      superAdmin._id.toString(),
      superAdmin.email,
      0.55,
      'Board-approved marketing campaign rate increase'
    );
    testAssert(newPolicy.defaultRate === 0.55, 'Updated platform default rate to 55%');

    const policyAudit = await AuditLogModel.findOne({ action: 'COMMISSION_POLICY_UPDATE' });
    testAssert(policyAudit !== null, 'COMMISSION_POLICY_UPDATE audit log recorded');

  } finally {
    await teardownTestDb();
  }

  console.log('\n=============================================');
  console.log(`  PHASE 7 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=============================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase7Tests().catch((err) => {
  console.error('Phase 7 Test execution failed with error:', err);
  process.exit(1);
});
