import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { subscriptionAccessService } from '../services/subscriptionAccess.service';
import { adminService } from '../services/admin.service';
import { websiteSettingsService } from '../services/websiteSettings.service';
import { paymentService } from '../services/payment.service';
import { subscriptionService } from '../services/subscription.service';
import { UserModel } from '../models/User';
import { SubscriptionModel } from '../models/Subscription';
import { UserRole } from '../shared/roles';
import { SubscriptionStatus } from '../shared/subscriptions';
import { hashPassword } from '../utils/crypto';

let mongod: MongoMemoryServer;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`  ✗ FAIL: ${testName}`, detail ?? '');
    failedTests++;
  }
}

async function run() {
  console.log('\n=============================================');
  console.log('  PHASE 14 EXACT EXPIRY + COMMUNITY + ADMIN');
  console.log('=============================================\n');

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const admin = await UserModel.create({
    name: 'Phase 14 Admin',
    email: 'phase14.admin@example.com',
    passwordHash: await hashPassword('AdminPass123!'),
    role: UserRole.SUPER_ADMIN,
    isEmailVerified: true,
    isActive: true
  });

  const member = await UserModel.create({
    name: 'Exact Expiry Member',
    email: 'phase14.member@example.com',
    passwordHash: await hashPassword('MemberPass123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true
  });

  const expiredUser = await UserModel.create({
    name: 'Expired Member',
    email: 'phase14.expired@example.com',
    passwordHash: await hashPassword('MemberPass123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true
  });

  const inactiveUser = await UserModel.create({
    name: 'Inactive Member',
    email: 'phase14.inactive@example.com',
    passwordHash: await hashPassword('MemberPass123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true
  });

  // -------------------------------------------------------------------
  console.log('[1. Exact 7-day custom activation]');
  const requestedStart = new Date(Date.now() - 2_000);
  const custom = await subscriptionAccessService.grantManualSubscription(admin._id.toString(), {
    targetEmail: member.email!,
    durationValue: 7,
    durationUnit: 'DAYS',
    customPlanName: '7 Days Exact Pass',
    startDate: requestedStart.toISOString(),
    reason: 'Verify exact 7-day timestamp arithmetic'
  });

  assert(custom.planId === 'CUSTOM_ADMIN_GRANT', 'custom duration uses a custom plan identifier', custom.planId);
  assert(custom.customPlanName === '7 Days Exact Pass', 'custom plan label persisted');
  assert(
    custom.endDate.getTime() - custom.startDate.getTime() === 7 * 24 * 60 * 60 * 1000,
    '7-day subscription expires exactly 168 hours after start',
    { start: custom.startDate, end: custom.endDate }
  );
  assert(
    custom.startDate.toISOString() === requestedStart.toISOString(),
    'admin-specified start timestamp is stored exactly'
  );

  const customAccess = await subscriptionAccessService.checkAccess(member._id.toString());
  assert(customAccess.hasAccess === true, 'custom subscription grants access while inside the window');
  assert(typeof customAccess.serverTime === 'string', 'access response includes authoritative server time');
  assert(
    typeof customAccess.remainingMs === 'number' && customAccess.remainingMs > 0,
    'access response includes remaining milliseconds'
  );
  assert(
    customAccess.planName === '7 Days Exact Pass',
    'custom plan label appears in access status',
    customAccess.planName
  );

  // -------------------------------------------------------------------
  console.log('\n[2. Exact second expiration and automatic status update]');
  const almostExpired = await SubscriptionModel.create({
    userId: expiredUser._id,
    planId: 'CUSTOM_ADMIN_GRANT',
    customPlanName: 'Almost Expired Test',
    status: SubscriptionStatus.ACTIVE,
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() - 1_000)
  });

  const beforeSweep = await subscriptionAccessService.checkAccess(expiredUser._id.toString());
  assert(beforeSweep.hasAccess === false, 'expired timestamp denies access immediately');
  assert(beforeSweep.code === 'SUBSCRIPTION_EXPIRED', 'expired access returns SUBSCRIPTION_EXPIRED', beforeSweep);

  // Re-arm the record so the persistence sweep itself is exercised, rather
  // than relying on the lazy access check above.
  await SubscriptionModel.updateOne(
    { _id: almostExpired._id },
    { $set: { status: SubscriptionStatus.ACTIVE } }
  );
  const swept = await subscriptionAccessService.expireExpiredSubscriptions(new Date(), true);
  const afterSweep = await SubscriptionModel.findById(almostExpired._id);
  assert(swept >= 1, 'expiry sweep reports persisted modifications', swept);
  assert(
    afterSweep?.status === SubscriptionStatus.EXPIRED,
    'expired subscription status is automatically persisted as EXPIRED',
    afterSweep?.status
  );

  // -------------------------------------------------------------------
  console.log('\n[3. Future-dated manual activation]');
  const futureStart = new Date(Date.now() + 60 * 60 * 1000);
  const futureSub = await subscriptionAccessService.grantManualSubscription(admin._id.toString(), {
    targetEmail: inactiveUser.email!,
    planId: 'PLAN_15_DAYS',
    startDate: futureStart.toISOString(),
    reason: 'Schedule future access without cancelling current state'
  });
  assert(futureSub.status === SubscriptionStatus.ACTIVE, 'scheduled subscription record is stored as ACTIVE');
  assert(
    futureSub.startDate.toISOString() === futureStart.toISOString(),
    'future start time stored exactly'
  );
  const futureAccess = await subscriptionAccessService.checkAccess(inactiveUser._id.toString());
  assert(futureAccess.hasAccess === false, 'future-dated subscription does not grant access early');
  assert(
    futureAccess.startDate === futureStart.toISOString(),
    'future access response exposes the scheduled start time'
  );

  // -------------------------------------------------------------------
  console.log('\n[4. Subscription extension supports exact years]');
  const previousEnd = futureSub.endDate;
  const extended = await subscriptionAccessService.extendSubscription(admin._id.toString(), {
    subscriptionId: futureSub._id.toString(),
    extensionValue: 1,
    extensionUnit: 'YEARS',
    reason: 'Verify year extension is converted to 12 calendar months'
  });
  assert(extended.endDate.getTime() > previousEnd.getTime(), 'year extension increases expiry');
  assert(extended.status === SubscriptionStatus.ACTIVE, 'extended subscription remains ACTIVE');

  // -------------------------------------------------------------------
  console.log('\n[5. Admin Active / Expired / Inactive filters]');
  const activeFilter = await adminService.getUsers({
    subscriptionStatus: 'ACTIVE',
    page: 1,
    limit: 50
  } as any);
  assert(
    activeFilter.users.some((u: any) => u.email === member.email),
    'ACTIVE filter includes exact active subscriber'
  );
  assert(
    !activeFilter.users.some((u: any) => u.email === expiredUser.email),
    'ACTIVE filter excludes expired subscriber'
  );

  const expiredFilter = await adminService.getUsers({
    subscriptionStatus: 'EXPIRED',
    page: 1,
    limit: 50
  } as any);
  assert(
    expiredFilter.users.some((u: any) => u.email === expiredUser.email),
    'EXPIRED filter includes expired subscriber'
  );
  assert(
    !expiredFilter.users.some((u: any) => u.email === inactiveUser.email),
    'EXPIRED filter excludes user with no subscription history'
  );

  const inactiveFilter = await adminService.getUsers({
    subscriptionStatus: 'INACTIVE',
    page: 1,
    limit: 50
  } as any);
  assert(
    inactiveFilter.users.some((u: any) => u.email === admin.email),
    'INACTIVE filter includes user without subscription records'
  );

  // -------------------------------------------------------------------
  console.log('\n[6. Community settings persistence and sanitization]');
  const updated = await websiteSettingsService.updateSettings(
    admin._id.toString(),
    admin.email!,
    {
      community: {
        enabled: true,
        telegramName: 'Accuracy Official Telegram',
        telegramLink: '@accuracy_official',
        description: 'Join the official community <script>alert(1)</script> for alerts.',
        buttonText: 'Join Telegram Now'
      }
    } as any,
    'Phase 14 community management verification'
  );

  assert(updated.community.enabled === true, 'community enabled flag persisted');
  assert(updated.community.telegramName === 'Accuracy Official Telegram', 'community name persisted');
  assert(
    updated.community.telegramLink === 'https://t.me/accuracy_official',
    'Telegram @handle normalized to a valid t.me URL',
    updated.community.telegramLink
  );
  assert(
    !updated.community.description.includes('<script>'),
    'community description sanitizes script tags',
    updated.community.description
  );
  assert(updated.community.buttonText === 'Join Telegram Now', 'community button text persisted');

  const publicSettings = await websiteSettingsService.getPublicSettings();
  assert(
    publicSettings.community?.telegramName === 'Accuracy Official Telegram',
    'public settings expose admin-managed community content'
  );

  const unsafe = await websiteSettingsService.updateSettings(
    admin._id.toString(),
    admin.email!,
    {
      community: {
        enabled: true,
        telegramName: 'Unsafe Link Test',
        telegramLink: 'javascript:alert(1)',
        description: 'Unsafe link must be discarded',
        buttonText: 'Join'
      }
    } as any,
    'Verify unsafe community URL is rejected'
  );
  assert(unsafe.community.telegramLink === '', 'unsafe javascript Telegram link is discarded', unsafe.community.telegramLink);

  const disabled = await websiteSettingsService.updateSettings(
    admin._id.toString(),
    admin.email!,
    { community: { ...unsafe.community, enabled: false } } as any,
    'Verify community section can be disabled'
  );
  assert(disabled.community.enabled === false, 'community section can be disabled from admin settings');

  // -------------------------------------------------------------------
  console.log('\n[7. Dynamic minimum plan price and payment support settings]');
  const paymentConfigured = await websiteSettingsService.updateSettings(
    admin._id.toString(),
    admin.email!,
    {
      paymentSettings: {
        minPlanPriceCents: 1_000_000,
        paymentSupportEnabled: false,
        paymentSupportTelegram: '@phase14_support'
      }
    } as any,
    'Phase 14 payment settings verification'
  );
  assert(
    paymentConfigured.paymentSettings.minPlanPriceCents === 1_000_000,
    'admin minimum plan price persisted in cents'
  );
  assert(
    paymentConfigured.paymentSettings.paymentSupportEnabled === false,
    'payment support button can be disabled'
  );
  assert(
    paymentConfigured.paymentSettings.paymentSupportTelegram === '@phase14_support',
    'payment support Telegram handle persisted'
  );

  const publicPaymentSettings = await websiteSettingsService.getPublicSettings();
  assert(
    publicPaymentSettings.paymentSettings?.minPlanPriceCents === 1_000_000,
    'public settings expose the admin-configured minimum price'
  );

  let belowMinimumPlanRejected = false;
  try {
    await subscriptionService.createPlan(
      {
        id: 'PLAN_PHASE14_LOW',
        name: 'Below Minimum Test',
        description: 'Should be rejected by dynamic minimum',
        priceCents: 500_000,
        durationUnit: 'DAYS',
        durationValue: 1,
        features: []
      },
      admin._id.toString()
    );
  } catch (err: any) {
    belowMinimumPlanRejected = true;
  }
  assert(belowMinimumPlanRejected, 'plan creation below the configured minimum is rejected');

  let belowMinimumOrderRejected = false;
  try {
    await paymentService.createPurchaseOrder(member._id.toString(), 'PLAN_15_DAYS', 'TRX');
  } catch (err: any) {
    belowMinimumOrderRejected = err?.code === 'PLAN_BELOW_MINIMUM';
  }
  assert(belowMinimumOrderRejected, 'checkout below the configured minimum is rejected server-side');

  const paymentReset = await websiteSettingsService.updateSettings(
    admin._id.toString(),
    admin.email!,
    {
      paymentSettings: {
        minPlanPriceCents: 20,
        paymentSupportEnabled: true,
        paymentSupportTelegram: 'https://t.me/phase14_support'
      }
    } as any,
    'Restore default payment minimum after verification'
  );
  assert(paymentReset.paymentSettings.minPlanPriceCents === 20, 'minimum $0.20 can be restored');

  const lowPlan = await subscriptionService.createPlan(
    {
      id: 'PLAN_PHASE14_MINIMUM',
      name: '20 Cent Minimum Plan',
      description: 'Valid minimum plan',
      priceCents: 20,
      durationUnit: 'DAYS',
      durationValue: 1,
      features: []
    },
    admin._id.toString()
  );
  assert(lowPlan.priceCents === 20, '$0.20 plan is allowed at the default minimum');

  const allowedOrder = await paymentService.createPurchaseOrder(member._id.toString(), 'PLAN_15_DAYS', 'TRX');
  assert(Boolean(allowedOrder.orderId), 'checkout succeeds after the minimum is restored');

  console.log('\n=============================================');
  console.log(`  PHASE 14 RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('=============================================\n');

  await mongoose.disconnect().catch(() => null);
  await mongod.stop().catch(() => null);
  process.exit(failedTests > 0 ? 1 : 0);
}

run().catch(async (error) => {
  console.error('Phase 14 suite crashed:', error);
  await mongoose.disconnect().catch(() => null);
  await mongod?.stop().catch(() => null);
  process.exit(1);
});
