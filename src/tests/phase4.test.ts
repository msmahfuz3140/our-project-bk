import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { subscriptionAccessService } from '../services/subscriptionAccess.service';
import { subscriptionService } from '../services/subscription.service';
import { UserModel } from '../models/User';
import { SubscriptionModel } from '../models/Subscription';
import { PaymentModel } from '../models/Payment';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { UserRole } from '../shared/roles';
import { SubscriptionStatus } from '../shared/subscriptions';
import { requireActiveSubscription } from '../middleware/subscriptionAccess.middleware';
import { hashPassword } from '../utils/crypto';
import { Request, Response, NextFunction } from 'express';

let mongod: MongoMemoryServer;

async function setupTestDb() {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  console.log('Phase 4 Test in-memory MongoDB connected.');
}

async function teardownTestDb() {
  await mongoose.disconnect();
  await mongod.stop();
  console.log('Phase 4 Test in-memory MongoDB stopped.');
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

async function runPhase4Tests() {
  console.log('\n=============================================');
  console.log('  STARTING PHASE 4 TEST SUITE');
  console.log('=============================================\n');

  try {
    await setupTestDb();

    // -------------------------------------------------------------
    // Setup Base Admin & Test Users
    // -------------------------------------------------------------
    const superAdmin = await UserModel.create({
      name: 'Super Admin One',
      email: 'superadmin1@rouletteaccuracy.com',
      passwordHash: await hashPassword('AdminPass123!'),
      role: UserRole.SUPER_ADMIN,
      isEmailVerified: true
    });

    const moderator = await UserModel.create({
      name: 'Mod Partner One',
      email: 'mod1@rouletteaccuracy.com',
      passwordHash: await hashPassword('ModPass123!'),
      role: UserRole.MODERATOR,
      isEmailVerified: true
    });

    const member1 = await UserModel.create({
      name: 'Active Member',
      email: 'active@rouletteaccuracy.com',
      passwordHash: await hashPassword('MemberPass123!'),
      role: UserRole.USER,
      isEmailVerified: true
    });

    const memberExpired = await UserModel.create({
      name: 'Expired Member',
      email: 'expired@rouletteaccuracy.com',
      passwordHash: await hashPassword('MemberPass123!'),
      role: UserRole.USER,
      isEmailVerified: true
    });

    const memberRevoked = await UserModel.create({
      name: 'Revoked Member',
      email: 'revoked@rouletteaccuracy.com',
      passwordHash: await hashPassword('MemberPass123!'),
      role: UserRole.USER,
      isEmailVerified: true
    });

    const memberNoSub = await UserModel.create({
      name: 'No Sub Member',
      email: 'nosub@rouletteaccuracy.com',
      passwordHash: await hashPassword('MemberPass123!'),
      role: UserRole.USER,
      isEmailVerified: true
    });

    // -------------------------------------------------------------
    // SUITE 1: Active Subscription Verification
    // -------------------------------------------------------------
    console.log('[Suite 1: Active Subscription Access Verification]');

    const now = new Date();
    const futureDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // +30 days

    const activeSub = await SubscriptionModel.create({
      userId: member1._id,
      planId: 'PLAN_1_MONTH',
      status: SubscriptionStatus.ACTIVE,
      startDate: new Date(now.getTime() - 24 * 60 * 60 * 1000), // started yesterday
      endDate: futureDate
    });

    const activeCheck = await subscriptionAccessService.checkAccess(member1._id.toString());
    assert(activeCheck.hasAccess === true, 'Active user receives hasAccess: true');
    assert(activeCheck.code === 'ACCESS_GRANTED', 'Active user status code is ACCESS_GRANTED');
    assert(activeCheck.status === SubscriptionStatus.ACTIVE, 'Active user status is ACTIVE');
    assert((activeCheck.daysRemaining || 0) >= 29, 'Active user daysRemaining is accurately calculated');
    assert(Boolean(activeCheck.expiresAtFormatted), 'Active user receives formatted expiration date');

    // -------------------------------------------------------------
    // SUITE 2: Dynamic Expiration Enforcement (Dynamic Check)
    // -------------------------------------------------------------
    console.log('\n[Suite 2: Dynamic Server-Side Expiry Enforcement]');

    const pastDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    const startedWayBack = new Date(now.getTime() - 32 * 24 * 60 * 60 * 1000);

    const expiredSub = await SubscriptionModel.create({
      userId: memberExpired._id,
      planId: 'PLAN_1_MONTH',
      status: SubscriptionStatus.ACTIVE, // Stored as ACTIVE before dynamic check
      startDate: startedWayBack,
      endDate: pastDate
    });

    const expiredCheck = await subscriptionAccessService.checkAccess(memberExpired._id.toString());
    assert(expiredCheck.hasAccess === false, 'Expired user access is denied (hasAccess: false)');
    assert(expiredCheck.code === 'SUBSCRIPTION_EXPIRED', 'Expired user returns SUBSCRIPTION_EXPIRED code');
    assert(expiredCheck.daysRemaining === 0, 'Expired user daysRemaining is 0');

    // Verify dynamic DB mutation to EXPIRED
    const reloadedExpiredSub = await SubscriptionModel.findById(expiredSub._id);
    assert(
      reloadedExpiredSub?.status === SubscriptionStatus.EXPIRED,
      'Subscription record status was dynamically updated to EXPIRED in the database upon check'
    );

    // -------------------------------------------------------------
    // SUITE 3: Subscription Revocation Handling
    // -------------------------------------------------------------
    console.log('\n[Suite 3: Subscription Revocation Status]');

    const subToRevoke = await SubscriptionModel.create({
      userId: memberRevoked._id,
      planId: 'PLAN_3_MONTHS',
      status: SubscriptionStatus.ACTIVE,
      startDate: now,
      endDate: futureDate
    });

    // Revoke via subscriptionAccessService
    const revokeResult = await subscriptionAccessService.revokeSubscription(superAdmin._id.toString(), {
      subscriptionId: subToRevoke._id.toString(),
      reason: 'Violation of Terms of Service - unauthorized scraping'
    });

    assert(revokeResult.status === SubscriptionStatus.REVOKED, 'Revocation sets status to REVOKED');
    assert(revokeResult.isRevoked === true, 'Revocation sets isRevoked flag to true');
    assert(
      revokeResult.revocationReason === 'Violation of Terms of Service - unauthorized scraping',
      'Revocation stores audit reason'
    );

    const revokedCheck = await subscriptionAccessService.checkAccess(memberRevoked._id.toString());
    assert(revokedCheck.hasAccess === false, 'Revoked user access is denied (hasAccess: false)');
    assert(revokedCheck.code === 'SUBSCRIPTION_REVOKED', 'Revoked user returns SUBSCRIPTION_REVOKED code');
    assert(
      revokedCheck.reason?.includes('unauthorized scraping') === true,
      'Revoked check includes the specific administrative revocation reason'
    );

    // -------------------------------------------------------------
    // SUITE 4: Missing Subscription Handling
    // -------------------------------------------------------------
    console.log('\n[Suite 4: Missing Subscription Handling]');

    const noSubCheck = await subscriptionAccessService.checkAccess(memberNoSub._id.toString());
    assert(noSubCheck.hasAccess === false, 'User with no subscriptions is denied access');
    assert(noSubCheck.code === 'SUBSCRIPTION_REQUIRED', 'Missing subscription returns SUBSCRIPTION_REQUIRED code');

    // -------------------------------------------------------------
    // SUITE 5: Role-Based Access Bypass (Main Admins & Moderators)
    // -------------------------------------------------------------
    console.log('\n[Suite 5: Role-Based Access Bypass for Admins and Moderators]');

    const adminCheck = await subscriptionAccessService.checkAccess(superAdmin._id.toString());
    assert(adminCheck.hasAccess === true, 'Super Admin receives access without personal subscription');
    assert(adminCheck.isRoleBypass === true, 'Super Admin access includes isRoleBypass: true');
    assert(adminCheck.planName === 'Main Admin Unlimited', 'Super Admin planName is Main Admin Unlimited');

    const modCheck = await subscriptionAccessService.checkAccess(moderator._id.toString());
    assert(modCheck.hasAccess === true, 'Moderator receives access without personal subscription');
    assert(modCheck.isRoleBypass === true, 'Moderator access includes isRoleBypass: true');

    // -------------------------------------------------------------
    // SUITE 6: Main Admin Manual Subscription Grant & Audit Boundary
    // -------------------------------------------------------------
    console.log('\n[Suite 6: Main Admin Manual Subscription Grant & Audit Boundary]');

    const targetUser = await UserModel.create({
      name: 'Vip Customer',
      email: 'vip@rouletteaccuracy.com',
      passwordHash: await hashPassword('VipPass123!'),
      role: UserRole.USER,
      isEmailVerified: true
    });

    const paymentCountBefore = await PaymentModel.countDocuments();
    const commissionCountBefore = await ReferralCommissionModel.countDocuments();

    const manualSub = await subscriptionAccessService.grantManualSubscription(superAdmin._id.toString(), {
      targetEmail: targetUser.email,
      planId: 'PLAN_1_YEAR',
      reason: 'Complimentary VIP partner tester pass'
    });

    assert(manualSub.isManualGrant === true, 'Manual grant sets isManualGrant: true');
    assert(manualSub.grantReason === 'Complimentary VIP partner tester pass', 'Manual grant records exact audit reason');
    assert(
      manualSub.grantedByAdminId?.toString() === superAdmin._id.toString(),
      'Manual grant records superAdmin ObjectId as grantedByAdminId'
    );
    assert(manualSub.status === SubscriptionStatus.ACTIVE, 'Manual grant is immediately ACTIVE');

    // Verify STRICT audit boundary: Zero artificial payments or moderator commissions
    const paymentCountAfter = await PaymentModel.countDocuments();
    const commissionCountAfter = await ReferralCommissionModel.countDocuments();

    assert(
      paymentCountAfter === paymentCountCountBeforeOrEqual(paymentCountBefore),
      'Manual grant created ZERO artificial payment records'
    );
    assert(
      commissionCountAfter === commissionCountBefore,
      'Manual grant created ZERO artificial moderator commissions'
    );

    const vipCheck = await subscriptionAccessService.checkAccess(targetUser._id.toString());
    assert(vipCheck.hasAccess === true, 'Target user of manual grant immediately has hasAccess: true');
    assert(vipCheck.planId === 'PLAN_1_YEAR', 'Target user has active PLAN_1_YEAR plan');

    // -------------------------------------------------------------
    // SUITE 7: Main Admin Subscription Extension
    // -------------------------------------------------------------
    console.log('\n[Suite 7: Main Admin Subscription Extension]');

    const priorEndDate = manualSub.endDate.getTime();

    const extendedSub = await subscriptionAccessService.extendSubscription(superAdmin._id.toString(), {
      subscriptionId: manualSub._id.toString(),
      extensionValue: 30,
      extensionUnit: 'DAYS',
      reason: 'Bonus 30 days loyalty extension'
    });

    assert(
      extendedSub.endDate.getTime() > priorEndDate,
      'Extension pushed subscription endDate forward into the future'
    );
    assert(
      extendedSub.extensionReason === 'Bonus 30 days loyalty extension',
      'Extension recorded extensionReason'
    );
    assert(Boolean(extendedSub.extendedAt), 'Extension recorded extendedAt timestamp');

    // -------------------------------------------------------------
    // SUITE 8: Express Middleware requireActiveSubscription
    // -------------------------------------------------------------
    console.log('\n[Suite 8: Server-Side Authorization Middleware]');

    async function testMiddleware(reqObj: any) {
      let nextCalled = false;
      let errPassed: any = null;
      await requireActiveSubscription(reqObj as any, {} as Response, ((err?: any) => {
        if (!err) nextCalled = true;
        else errPassed = err;
      }) as NextFunction);
      return { nextCalled, errPassed };
    }

    // Test active user with middleware
    const reqActive: any = { user: { id: member1._id.toString(), email: member1.email, role: member1.role } };
    const resActive = await testMiddleware(reqActive);
    assert(resActive.nextCalled === true, 'requireActiveSubscription middleware calls next() for active subscriber');
    assert(Boolean(reqActive.accessStatus), 'Middleware attaches accessStatus payload to request');

    // Test expired user with middleware
    const reqExpired: any = { user: { id: memberExpired._id.toString(), email: memberExpired.email, role: memberExpired.role } };
    const resExpired = await testMiddleware(reqExpired);
    assert(resExpired.nextCalled === false, 'requireActiveSubscription middleware blocks expired subscriber');
    assert(resExpired.errPassed?.statusCode === 403, 'Middleware passes HTTP 403 ApiError to next() for expired subscriber');
    assert(
      resExpired.errPassed?.code === 'SUBSCRIPTION_EXPIRED',
      'Middleware passes SUBSCRIPTION_EXPIRED error code'
    );

    // Test missing subscription with middleware
    const reqNoSub: any = { user: { id: memberNoSub._id.toString(), email: memberNoSub.email, role: memberNoSub.role } };
    const resNoSub = await testMiddleware(reqNoSub);
    assert(resNoSub.nextCalled === false, 'requireActiveSubscription middleware blocks user without subscription');
    assert(resNoSub.errPassed?.statusCode === 403, 'Middleware passes HTTP 403 ApiError for user without subscription');
    assert(
      resNoSub.errPassed?.code === 'SUBSCRIPTION_REQUIRED',
      'Middleware passes SUBSCRIPTION_REQUIRED error code'
    );

    // -------------------------------------------------------------
    // Test Summary
    // -------------------------------------------------------------
    console.log('\n=============================================');
    console.log(`  PHASE 4 TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
    console.log('=============================================\n');

    if (failedTests > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('Unhandled test suite failure:', error);
    process.exit(1);
  } finally {
    await teardownTestDb();
  }
}

function paymentCountCountBeforeOrEqual(val: number) {
  return val;
}

runPhase4Tests();
