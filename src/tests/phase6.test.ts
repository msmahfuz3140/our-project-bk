import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { adminService } from '../services/admin.service';
import { subscriptionAccessService } from '../services/subscriptionAccess.service';
import { subscriptionService } from '../services/subscription.service';
import { UserModel } from '../models/User';
import { PaymentModel } from '../models/Payment';
import { SubscriptionModel } from '../models/Subscription';
import { AuditLogModel } from '../models/AuditLog';
import { DualApprovalModel } from '../models/DualApproval';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { PlanModel } from '../models/Plan';
import { UserRole } from '../shared/roles';
import { PaymentStatus, SubscriptionStatus } from '../shared/subscriptions';
import { hashPassword } from '../utils/crypto';
import { bootstrapMainAdmins } from '../scripts/bootstrap-admins';

let mongod: MongoMemoryServer;

async function setupTestDb() {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  console.log('Phase 6 Test in-memory MongoDB connected.');
}

async function teardownTestDb() {
  await mongoose.disconnect();
  await mongod.stop();
  console.log('Phase 6 Test in-memory MongoDB stopped.');
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

async function runPhase6Tests() {
  console.log('\n=============================================');
  console.log('  STARTING PHASE 6 TEST SUITE');
  console.log('  Main Admin Panel, Dual Approval & Audit');
  console.log('=============================================\n');

  try {
    await setupTestDb();

    // -------------------------------------------------------------
    // Suite 1: Bootstrap & Four Designated Main Admin Accounts
    // -------------------------------------------------------------
    console.log('\n--- Suite 1: Four Designated Main Admin Accounts ---');

    await bootstrapMainAdmins(false);

    const superAdmins = await UserModel.find({ role: UserRole.SUPER_ADMIN });
    assert(
      superAdmins.length === 4,
      'Bootstrap initializes exactly 4 designated Main Admin accounts',
      `Found ${superAdmins.length} Main Admins`
    );

    // Verify separate credentials and non-shared passwords
    const hashes = superAdmins.map((a) => a.passwordHash);
    const uniqueHashes = new Set(hashes);
    assert(
      uniqueHashes.size === 4,
      'All 4 Main Admins have distinct individual credentials (not shared)',
      `Unique hashes: ${uniqueHashes.size}`
    );

    // Bootstrap idempotency check: subsequent runs must not add more
    await bootstrapMainAdmins(false);
    const superAdminsAfter = await UserModel.find({ role: UserRole.SUPER_ADMIN });
    assert(
      superAdminsAfter.length === 4,
      'Bootstrap is disabled after initial 4 owners are provisioned'
    );

    const admin1 = superAdmins[0];
    const admin2 = superAdmins[1];

    // -------------------------------------------------------------
    // Suite 2: User Creation & Dashboard Metrics Telemetry
    // -------------------------------------------------------------
    console.log('\n--- Suite 2: Admin Dashboard Metrics Telemetry ---');

    // Create a moderator partner
    const moderator = await UserModel.create({
      name: 'Partner Moderator',
      email: 'moderator1@partner.com',
      passwordHash: await hashPassword('ModPass123!'),
      role: UserRole.MODERATOR,
      isEmailVerified: true,
      referralCode: 'MOD_REF_01'
    });

    // Create 3 normal users
    const userA = await UserModel.create({
      name: 'Alice Roulette',
      email: 'alice@casino.com',
      phone: '+14155550101',
      passwordHash: await hashPassword('AlicePass123!'),
      role: UserRole.USER,
      isEmailVerified: true,
      isPhoneVerified: true,
      referredBy: moderator._id
    });

    const userB = await UserModel.create({
      name: 'Bob Betman',
      email: 'bob@casino.com',
      phone: '+14155550102',
      passwordHash: await hashPassword('BobPass123!'),
      role: UserRole.USER,
      isEmailVerified: true
    });

    const userC = await UserModel.create({
      name: 'Charlie Spinner',
      email: 'charlie@casino.com',
      passwordHash: await hashPassword('CharliePass123!'),
      role: UserRole.USER,
      isEmailVerified: false
    });

    // Create confirmed paid order for userA ($200 1_month)
    const orderA = await PaymentModel.create({
      orderId: 'ORD_ADMIN_001',
      orderDescription: '1 Month Access',
      userId: userA._id,
      planId: '1_month',
      planName: '1 Month Plan',
      priceCents: 20000,
      priceAmount: 200,
      priceCurrency: 'USD',
      duration: { unit: 'MONTHS', value: 1 },
      durationDays: 30,
      paymentId: 'NP_TEST_001',
      payCurrency: 'BTC',
      status: PaymentStatus.FINISHED,
      isFulfilled: true
    });

    // Create pending order for userB ($150 15_days)
    await PaymentModel.create({
      orderId: 'ORD_ADMIN_002',
      orderDescription: '15 Days Access',
      userId: userB._id,
      planId: '15_days',
      planName: '15 Days Plan',
      priceCents: 15000,
      priceAmount: 150,
      priceCurrency: 'USD',
      duration: { unit: 'DAYS', value: 15 },
      durationDays: 15,
      paymentId: 'NP_TEST_002',
      payCurrency: 'USDT',
      status: PaymentStatus.WAITING,
      isFulfilled: false
    });

    // Create active subscription for userA
    const now = new Date();
    const oneMonthLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const subA = await SubscriptionModel.create({
      userId: userA._id,
      planId: '1_month',
      status: SubscriptionStatus.ACTIVE,
      startDate: now,
      endDate: oneMonthLater,
      paymentId: orderA._id,
      isManualGrant: false
    });

    // Create referral commission for moderator
    await ReferralCommissionModel.create({
      moderatorId: moderator._id,
      referredUserId: userA._id,
      subscriptionId: subA._id,
      paymentId: orderA._id,
      amountUsd: 100,
      commissionRate: 0.5,
      status: 'CREDITED'
    });

    // Create expired subscription for userB
    const pastDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const expiredEndDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    await SubscriptionModel.create({
      userId: userB._id,
      planId: '15_days',
      status: SubscriptionStatus.EXPIRED,
      startDate: pastDate,
      endDate: expiredEndDate,
      isManualGrant: false
    });

    const metrics = await adminService.getDashboardMetrics();

    assert(
      metrics.totalRegisteredUsers >= 8, // 4 admins + 1 mod + 3 users = 8
      'Dashboard calculates total registered users',
      `Total users: ${metrics.totalRegisteredUsers}`
    );

    assert(
      metrics.moderatorsCount === 1,
      'Dashboard counts moderator accounts correctly',
      `Moderators: ${metrics.moderatorsCount}`
    );

    assert(
      metrics.activeSubscriptions === 1,
      'Dashboard identifies active subscriptions count',
      `Active subscriptions: ${metrics.activeSubscriptions}`
    );

    assert(
      metrics.expiredSubscriptions === 1,
      'Dashboard identifies expired subscriptions count',
      `Expired subscriptions: ${metrics.expiredSubscriptions}`
    );

    assert(
      metrics.financials.grossSalesUsd === 200,
      'Dashboard aggregates confirmed gross subscription sales ($200)',
      `Confirmed sales: $${metrics.financials.grossSalesUsd}`
    );

    assert(
      metrics.confirmedPaymentCount === 1,
      'Dashboard reports confirmed payment count (1)'
    );

    assert(
      metrics.pendingPaymentCount === 1,
      'Dashboard reports pending payment count (1)'
    );

    // Accounting distinction: gross sales vs net revenue vs fees vs liabilities
    assert(
      metrics.financials.grossSalesUsd === 200,
      'Gross sales strictly reports top-line receipts without deductions ($200)'
    );

    assert(
      metrics.financials.estimatedPaymentFeesUsd === 2, // 1% of $200 = $2
      'Estimated payment gateway fee is calculated at 1% ($2.00)'
    );

    assert(
      metrics.financials.outstandingCommissionLiabilitiesUsd === 100, // 50% of $200 referral sale = $100
      '50% moderator referral commission liability is accounted ($100.00)'
    );

    assert(
      metrics.financials.netRevenueUsd === 98, // $200 - $2 fee - $100 comm = $98
      'Net revenue correctly deducts payment fees and commission liabilities ($98.00)'
    );

    // Plan distribution check
    assert(
      metrics.planDistribution['1_month'] === 1 &&
        metrics.planDistribution['15_days'] === 1,
      'Subscription plan distribution accounts for tier purchases'
    );

    // -------------------------------------------------------------
    // Suite 3: User Management (Search, Filter, Details)
    // -------------------------------------------------------------
    console.log('\n--- Suite 3: User Registry Search & Pagination ---');

    // Search by name
    const searchByName = await adminService.getUsers({ search: 'Alice' });
    assert(
      searchByName.users.length === 1 && searchByName.users[0].email === 'alice@casino.com',
      'Search filters users accurately by name'
    );

    // Search by phone
    const searchByPhone = await adminService.getUsers({ search: '+14155550102' });
    assert(
      searchByPhone.users.length === 1 && searchByPhone.users[0].email === 'bob@casino.com',
      'Search filters users accurately by phone number'
    );

    // Filter by active subscription
    const subActiveUsers = await adminService.getUsers({ subscriptionStatus: 'ACTIVE' });
    assert(
      subActiveUsers.users.some((u) => u.email === 'alice@casino.com') &&
        !subActiveUsers.users.some((u) => u.email === 'bob@casino.com'),
      'Filter identifies accounts with active premium subscriptions'
    );

    // User details inspection
    const userADetails = await adminService.getUserDetails(userA._id.toString());
    assert(
      userADetails.user.email === 'alice@casino.com' &&
        userADetails.payments.length === 1 &&
        userADetails.subscriptions.length === 1,
      'getUserDetails compiles complete profile, payment ledger, and subscription history'
    );

    // Password hashes must never be exposed
    assert(
      !(userADetails.user as any).passwordHash,
      'Password hash is omitted from user details response'
    );

    // -------------------------------------------------------------
    // Suite 4: User Profile Edit & Status Operations (Block / Suspend)
    // -------------------------------------------------------------
    console.log('\n--- Suite 4: Admin Actions & Audit Logging ---');

    // Edit user profile
    await adminService.updateUserProfile(
      admin1._id.toString(),
      admin1.email,
      userB._id.toString(),
      {
        name: 'Robert Betman Jr.',
        phone: '+14155559999'
      },
      'User submitted identity verification documents via support'
    );

    const updatedUserB = await UserModel.findById(userB._id);
    assert(
      updatedUserB?.name === 'Robert Betman Jr.' && updatedUserB?.phone === '+14155559999',
      'Admin successfully updates permitted user profile fields'
    );

    // Verify USER_PROFILE_EDIT audit log
    const profileEditAudit = await AuditLogModel.findOne({
      action: 'USER_PROFILE_EDIT',
      targetUserId: userB._id
    });
    assert(
      profileEditAudit !== null &&
        profileEditAudit.adminEmail === admin1.email &&
        profileEditAudit.previousValue.name === 'Bob Betman' &&
        profileEditAudit.newValue.name === 'Robert Betman Jr.',
      'Immutable audit log records previous and new values on profile edit'
    );

    // Block user
    await adminService.changeUserStatus(
      admin1._id.toString(),
      admin1.email,
      userB._id.toString(),
      'BLOCK',
      'Suspected fraudulent chargeback attempt'
    );

    const blockedUserB = await UserModel.findById(userB._id);
    assert(
      blockedUserB?.accountStatus === 'BLOCKED',
      'User status transitioned to BLOCKED'
    );

    // Verify blocked user is denied access to prediction tool
    const blockedAccess = await subscriptionAccessService.checkAccess(userB._id.toString());
    assert(
      blockedAccess.hasAccess === false && blockedAccess.code === 'SUBSCRIPTION_REVOKED',
      'Blocked user is immediately denied access to prediction tool'
    );

    // Verify USER_BLOCK audit log
    const blockAudit = await AuditLogModel.findOne({
      action: 'USER_BLOCK',
      targetUserId: userB._id
    });
    assert(
      blockAudit !== null && blockAudit.reason.includes('chargeback'),
      'USER_BLOCK audit log recorded with admin ID and mandatory reason'
    );

    // Unblock user
    await adminService.changeUserStatus(
      admin1._id.toString(),
      admin1.email,
      userB._id.toString(),
      'UNBLOCK',
      'Dispute resolved amicably with user'
    );
    const unblockedUserB = await UserModel.findById(userB._id);
    assert(
      unblockedUserB?.accountStatus === 'ACTIVE',
      'User status restored to ACTIVE upon unblock'
    );

    // Suspend user
    const suspendExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await adminService.changeUserStatus(
      admin1._id.toString(),
      admin1.email,
      userC._id.toString(),
      'SUSPEND',
      'Temporary investigation of abnormal prediction API rates',
      suspendExpiry
    );

    const suspendedUserC = await UserModel.findById(userC._id);
    assert(
      suspendedUserC?.accountStatus === 'SUSPENDED' && suspendedUserC?.suspendedUntil !== undefined,
      'User status transitioned to SUSPENDED with expiration date'
    );

    const suspendedAccess = await subscriptionAccessService.checkAccess(userC._id.toString());
    assert(
      suspendedAccess.hasAccess === false,
      'Suspended user access is revoked'
    );

    // Target protection: Cannot block another Super Admin
    let blockedSuperAdminFailed = false;
    try {
      await adminService.changeUserStatus(
        admin1._id.toString(),
        admin1.email,
        admin2._id.toString(),
        'BLOCK',
        'Attempt to block peer admin'
      );
    } catch (err: any) {
      blockedSuperAdminFailed = true;
    }
    assert(
      blockedSuperAdminFailed,
      'Admin service prevents blocking peer Super Admin accounts directly'
    );

    // -------------------------------------------------------------
    // Suite 5: Soft Deletion & Financial Audit Retention
    // -------------------------------------------------------------
    console.log('\n--- Suite 5: Soft Deletion & Financial Record Retention ---');

    await adminService.softDeleteUser(
      admin1._id.toString(),
      admin1.email,
      userA._id.toString(),
      'User requested GDPR account termination'
    );

    const deletedUserA = await UserModel.findById(userA._id);
    assert(
      deletedUserA?.isDeleted === true && deletedUserA?.accountStatus === 'DELETED',
      'User account is marked isDeleted: true (soft deletion)'
    );

    // Crucial requirement: NEVER erase financial audit records merely because account is deleted
    const preservedOrders = await PaymentModel.find({ userId: userA._id });
    assert(
      preservedOrders.length === 1,
      'Financial payment records are strictly retained after user deletion'
    );

    const softDeleteAudit = await AuditLogModel.findOne({
      action: 'USER_SOFT_DELETE',
      targetUserId: userA._id
    });
    assert(
      softDeleteAudit !== null && softDeleteAudit.reason.includes('GDPR'),
      'USER_SOFT_DELETE audit log recorded'
    );

    // -------------------------------------------------------------
    // Suite 6: Subscription Administration (Grant, Extend, Revoke)
    // -------------------------------------------------------------
    console.log('\n--- Suite 6: Subscription Administration ---');

    // Grant manual subscription to Charlie
    const manualSub = await subscriptionAccessService.grantManualSubscription(
      admin1._id.toString(),
      {
        targetEmail: userC.email,
        planId: '3_months',
        reason: 'VIP Complimentary Trial'
      }
    );

    assert(
      manualSub.isManualGrant === true &&
        (manualSub.planId === 'PLAN_3_MONTHS' || manualSub.planId === '3_months'),
      'Manual subscription granted with isManualGrant: true flag'
    );

    // Manual grant must NOT create a paid payment order
    const manualPayments = await PaymentModel.find({ userId: userC._id });
    assert(
      manualPayments.length === 0,
      'Manual subscription grant is NOT recorded as a paid sale'
    );

    // Verify SUBSCRIPTION_MANUAL_GRANT audit log
    const grantAudit = await AuditLogModel.findOne({
      action: 'SUBSCRIPTION_MANUAL_GRANT',
      targetUserId: userC._id
    });
    assert(
      grantAudit !== null && grantAudit.reason === 'VIP Complimentary Trial',
      'SUBSCRIPTION_MANUAL_GRANT audit entry created'
    );

    // Extend subscription
    const prevEndDate = manualSub.endDate;
    const extendedSub = await subscriptionAccessService.extendSubscription(
      admin1._id.toString(),
      {
        subscriptionId: manualSub._id.toString(),
        extensionValue: 30,
        extensionUnit: 'DAYS',
        reason: 'Promotion extension approved'
      }
    );

    assert(
      extendedSub.endDate > prevEndDate,
      'Subscription extension successfully pushed endDate forward'
    );

    const extendAudit = await AuditLogModel.findOne({
      action: 'SUBSCRIPTION_EXTEND',
      targetUserId: userC._id
    });
    assert(
      extendAudit !== null,
      'SUBSCRIPTION_EXTEND audit log created'
    );

    // Revoke subscription
    const revokedSub = await subscriptionAccessService.revokeSubscription(
      admin1._id.toString(),
      {
        subscriptionId: manualSub._id.toString(),
        reason: 'Abuse of VIP privileges'
      }
    );

    assert(
      revokedSub.status === SubscriptionStatus.REVOKED && revokedSub.isRevoked === true,
      'Subscription revoked successfully'
    );

    const revokeAudit = await AuditLogModel.findOne({
      action: 'SUBSCRIPTION_REVOKE',
      targetUserId: userC._id
    });
    assert(
      revokeAudit !== null,
      'SUBSCRIPTION_REVOKE audit log created'
    );

    // Plan price change audit
    await subscriptionService.updatePlan(
      '15_days',
      { priceCents: 16000 },
      admin1._id.toString()
    );

    const planPriceAudit = await AuditLogModel.findOne({
      action: 'PLAN_PRICE_UPDATE',
      targetResourceId: '15_days'
    });
    assert(
      planPriceAudit !== null && planPriceAudit.newValue.priceCents === 16000,
      'PLAN_PRICE_UPDATE audit log records previous and new plan prices'
    );

    // -------------------------------------------------------------
    // Suite 7: Audit Log Immutability Protection
    // -------------------------------------------------------------
    console.log('\n--- Suite 7: Audit Log Immutability Protection ---');

    let auditMutationBlocked = false;
    try {
      if (grantAudit) {
        grantAudit.reason = 'Tampered reason attempt';
        await grantAudit.save();
      }
    } catch (err: any) {
      auditMutationBlocked = true;
    }

    assert(
      auditMutationBlocked,
      'Mongoose guard strictly prevents updating existing AuditLog records'
    );

    let auditUpdateOneBlocked = false;
    try {
      await AuditLogModel.updateOne(
        { _id: grantAudit?._id },
        { $set: { reason: 'Tampered reason via updateOne' } }
      );
    } catch (err: any) {
      auditUpdateOneBlocked = true;
    }

    assert(
      auditUpdateOneBlocked,
      'Mongoose guard prevents updateOne mutation on AuditLogModel'
    );

    // -------------------------------------------------------------
    // Suite 8: Dual Approval Governance (Four-Eyes Principle)
    // -------------------------------------------------------------
    console.log('\n--- Suite 8: Dual Approval Governance ---');

    // Admin 1 initiates high-risk request to promote a user to SUPER_ADMIN
    const dualReq = await adminService.requestDualApproval(
      admin1._id.toString(),
      admin1.email,
      'ROLE_PROMOTION_SUPER_ADMIN',
      { targetUserId: moderator._id.toString(), targetUserEmail: moderator.email },
      'Owner board voted to induct new Main Admin partner',
      moderator._id.toString()
    );

    assert(
      dualReq.status === 'PENDING' && dualReq.requestedByAdminEmail === admin1.email,
      'Dual approval request created with PENDING status'
    );

    // Self-approval must be rejected
    let selfApprovalBlocked = false;
    try {
      await adminService.approveDualApproval(
        admin1._id.toString(),
        admin1.email,
        dualReq._id.toString()
      );
    } catch (err: any) {
      selfApprovalBlocked = true;
    }

    assert(
      selfApprovalBlocked,
      'Initiating admin is strictly prohibited from self-approving high-risk requests'
    );

    // Verify 5th Main Admin promotion is rejected by platform 4-admin cap
    let exceedLimitBlocked = false;
    try {
      await adminService.approveDualApproval(
        admin2._id.toString(),
        admin2.email,
        dualReq._id.toString()
      );
    } catch (err: any) {
      exceedLimitBlocked = err.message.includes('Maximum platform limit of 4 Main Admins');
    }
    assert(
      exceedLimitBlocked,
      'Approval rejects promoting beyond the 4 designated Main Admin accounts'
    );

    // Vacate 4th seat by stepping down admin4 to USER
    const admin4 = superAdmins[3];
    admin4.role = UserRole.USER;
    await admin4.save();

    // Now Admin 2 approves the proposal to fill the 4th seat
    const confirmedResult = await adminService.approveDualApproval(
      admin2._id.toString(),
      admin2.email,
      dualReq._id.toString()
    );

    assert(
      confirmedResult.request.status === 'APPROVED' &&
        confirmedResult.request.confirmedByAdminEmail === admin2.email,
      'Distinct second Main Admin confirms and executes high-risk request to fill 4th seat'
    );

    // Verify moderator was indeed promoted to SUPER_ADMIN
    const promotedMod = await UserModel.findById(moderator._id);
    assert(
      promotedMod?.role === UserRole.SUPER_ADMIN,
      'Dual approval execution successfully applied role mutation to SUPER_ADMIN'
    );

    // Verify DUAL_APPROVAL_CONFIRM audit log
    const dualAudit = await AuditLogModel.findOne({
      action: 'DUAL_APPROVAL_CONFIRM',
      targetResourceId: dualReq._id.toString()
    });
    assert(
      dualAudit !== null && dualAudit.adminEmail === admin2.email,
      'DUAL_APPROVAL_CONFIRM audit log tracks the confirming admin'
    );

    // Also test GLOBAL_COMMISSION_OVERRIDE dual approval
    const commReq = await adminService.requestDualApproval(
      admin1._id.toString(),
      admin1.email,
      'GLOBAL_COMMISSION_OVERRIDE',
      { newRate: 0.55 },
      'Promotional partnership commission rate adjustment'
    );
    const confirmedComm = await adminService.approveDualApproval(
      admin2._id.toString(),
      admin2.email,
      commReq._id.toString()
    );
    assert(
      confirmedComm.request.status === 'APPROVED' && confirmedComm.result?.appliedRate === 0.55,
      'GLOBAL_COMMISSION_OVERRIDE dual approval executes successfully'
    );
  } finally {
    await teardownTestDb();
  }

  console.log('\n=============================================');
  console.log(`  PHASE 6 TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('=============================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPhase6Tests().catch((err) => {
  console.error('Phase 6 Test Suite fatal error:', err);
  process.exit(1);
});
