import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  calculatePlanExpiration,
  formatCentsToUsd,
  SUBSCRIPTION_PLANS,
  PLANS_ARRAY
} from '../shared/plans';
import { subscriptionService } from '../services/subscription.service';
import { paymentService } from '../services/payment.service';
import { UserModel } from '../models/User';
import { PlanModel } from '../models/Plan';
import { PaymentModel } from '../models/Payment';
import { UserRole } from '../shared/roles';
import { hashPassword } from '../utils/crypto';

let mongod: MongoMemoryServer;

async function setupTestDb() {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  console.log('Phase 3 Test in-memory MongoDB connected.');
}

async function teardownTestDb() {
  await mongoose.disconnect();
  await mongod.stop();
  console.log('Phase 3 Test in-memory MongoDB stopped.');
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

async function runPhase3Tests() {
  console.log('\n=============================================');
  console.log('  STARTING PHASE 3 TEST SUITE');
  console.log('=============================================\n');

  try {
    await setupTestDb();

    // -------------------------------------------------------------
    // SUITE 1: Calendar-Month Precision & Leap-Year Edge Cases
    // -------------------------------------------------------------
    console.log('[Suite 1: Calendar-Month Precision & Leap-Year Arithmetic]');

    // Edge case 1: Jan 31 + 1 month in non-leap year (2026) -> Feb 28
    const jan31_2026 = new Date(Date.UTC(2026, 0, 31, 12, 0, 0));
    const expiryFeb2026 = calculatePlanExpiration(jan31_2026, { unit: 'MONTHS', value: 1 });
    assert(
      expiryFeb2026.getUTCFullYear() === 2026 &&
      expiryFeb2026.getUTCMonth() === 1 &&
      expiryFeb2026.getUTCDate() === 28,
      'Jan 31 + 1 month in non-leap year (2026) resolves to Feb 28, 2026 without month-overflow'
    );

    // Edge case 2: Jan 31 + 1 month in leap year (2028) -> Feb 29
    const jan31_2028 = new Date(Date.UTC(2028, 0, 31, 12, 0, 0));
    const expiryFeb2028 = calculatePlanExpiration(jan31_2028, { unit: 'MONTHS', value: 1 });
    assert(
      expiryFeb2028.getUTCFullYear() === 2028 &&
      expiryFeb2028.getUTCMonth() === 1 &&
      expiryFeb2028.getUTCDate() === 29,
      'Jan 31 + 1 month in leap year (2028) resolves to Feb 29, 2028 accurately'
    );

    // Edge case 3: March 31 + 1 month -> April 30
    const mar31 = new Date(Date.UTC(2026, 2, 31, 12, 0, 0));
    const expiryApr = calculatePlanExpiration(mar31, { unit: 'MONTHS', value: 1 });
    assert(
      expiryApr.getUTCMonth() === 3 && expiryApr.getUTCDate() === 30,
      'March 31 + 1 month resolves to April 30 without overflowing into May'
    );

    // Edge case 4: 15 Days Pass
    const start15 = new Date(Date.UTC(2026, 5, 10, 12, 0, 0));
    const expiry15 = calculatePlanExpiration(start15, { unit: 'DAYS', value: 15 });
    assert(
      expiry15.getUTCDate() === 25 && expiry15.getUTCMonth() === 5,
      '15 Days pass calculates exact 15 calendar days'
    );

    // Edge case 5: 1 Year (12 calendar months) from Feb 29, 2028 leap year -> Feb 28, 2029
    const leapDay = new Date(Date.UTC(2028, 1, 29, 12, 0, 0));
    const expiry1Year = calculatePlanExpiration(leapDay, { unit: 'MONTHS', value: 12 });
    assert(
      expiry1Year.getUTCFullYear() === 2029 &&
      expiry1Year.getUTCMonth() === 1 &&
      expiry1Year.getUTCDate() === 28,
      'Feb 29 (leap year) + 12 calendar months resolves accurately to Feb 28 of following year'
    );

    // -------------------------------------------------------------
    // SUITE 2: Decimal-Safe Monetary Arithmetic & Pricing Tiers
    // -------------------------------------------------------------
    console.log('\n[Suite 2: Decimal-Safe Pricing & Integer Cents]');
    assert(SUBSCRIPTION_PLANS.PLAN_15_DAYS.priceCents === 15000, 'PLAN_15_DAYS is exactly 15,000 cents ($150)');
    assert(SUBSCRIPTION_PLANS.PLAN_1_MONTH.priceCents === 20000, 'PLAN_1_MONTH is exactly 20,000 cents ($200)');
    assert(SUBSCRIPTION_PLANS.PLAN_3_MONTHS.priceCents === 45000, 'PLAN_3_MONTHS is exactly 45,000 cents ($450)');
    assert(SUBSCRIPTION_PLANS.PLAN_6_MONTHS.priceCents === 70000, 'PLAN_6_MONTHS is exactly 70,000 cents ($700)');
    assert(SUBSCRIPTION_PLANS.PLAN_1_YEAR.priceCents === 100000, 'PLAN_1_YEAR is exactly 100,000 cents ($1,000)');

    assert(formatCentsToUsd(15000) === '$150', 'Formats 15000 cents to "$150"');
    assert(formatCentsToUsd(100000) === '$1,000', 'Formats 100000 cents to "$1,000"');
    assert(formatCentsToUsd(499) === '$4.99', 'Formats fractional cents correctly without float distortion');

    // -------------------------------------------------------------
    // SUITE 3: Dynamic Plan Management & Auto-Seeding
    // -------------------------------------------------------------
    console.log('\n[Suite 3: Dynamic Plan Management & Database Seeding]');
    const publicPlans = await subscriptionService.getPublicPlans();
    assert(publicPlans.length === 5, 'Auto-seeds exactly 5 public plans into MongoDB');

    const dbPlanCount = await PlanModel.countDocuments();
    assert(dbPlanCount === 5, '5 plan documents persisted in MongoDB collection');

    // Super Admin updates plan price and features
    const updatedPlan = await subscriptionService.updatePlan('PLAN_15_DAYS', {
      priceCents: 16000,
      description: 'Updated 15 days starter pass'
    });
    assert(updatedPlan.priceCents === 16000, 'Super admin successfully updated plan price in cents to 16,000');
    assert(updatedPlan.priceUsd === 160, 'Derived priceUsd matches 160');

    // Validation: reject negative or invalid price
    let invalidPriceRejected = false;
    try {
      await subscriptionService.updatePlan('PLAN_15_DAYS', {
        priceCents: -500
      });
    } catch {
      invalidPriceRejected = true;
    }
    assert(invalidPriceRejected, 'Rejects invalid or negative price in cents');

    // Reset back to standard $150
    await subscriptionService.updatePlan('PLAN_15_DAYS', {
      priceCents: 15000
    });

    // -------------------------------------------------------------
    // SUITE 4: Purchase Flow, Order Snapshotting & Immutability
    // -------------------------------------------------------------
    console.log('\n[Suite 4: Purchase Order Snapshotting & Immutability Guarantee]');
    const passwordHash = await hashPassword('TestPassword123!');
    const testUser = await UserModel.create({
      name: 'Purchaser User',
      email: 'purchaser@example.com',
      passwordHash,
      role: UserRole.USER,
      isActive: true,
      isEmailVerified: true
    });

    // Create purchase order for 1 Month Pro ($200 / 20,000 cents)
    const order = await paymentService.createPurchaseOrder(testUser._id.toString(), 'PLAN_1_MONTH');
    assert(order.orderId.startsWith('ORD_'), 'Generates unique ORD_ order identifier');
    assert(order.priceCents === 20000, 'Snapshots exact price in cents (20,000)');
    assert(order.status === 'WAITING', 'Order status initialized to WAITING');

    // Now simulate an Admin updating the plan price afterwards to $250 / 25,000 cents
    await subscriptionService.updatePlan('PLAN_1_MONTH', {
      priceCents: 25000
    });

    // Retrieve previous order: must remain at original 20,000 cents!
    const retrievedOrder = await paymentService.getOrder(order.orderId, testUser._id.toString(), false);
    assert(
      retrievedOrder.priceCents === 20000,
      'Immutable snapshot guarantee: existing order remains at 20,000 cents after subsequent plan price increase'
    );

    // Reset plan price back to 20,000 cents
    await subscriptionService.updatePlan('PLAN_1_MONTH', {
      priceCents: 20000
    });

    // -------------------------------------------------------------
    // SUITE 5: Order Authorization Security
    // -------------------------------------------------------------
    console.log('\n[Suite 5: Order Authorization Privacy]');
    const secondUser = await UserModel.create({
      name: 'Other User',
      email: 'other@example.com',
      passwordHash,
      role: UserRole.USER,
      isActive: true,
      isEmailVerified: true
    });

    let unauthorizedOrderAccessBlocked = false;
    try {
      // Second user tries to access first user's order
      await paymentService.getOrder(order.orderId, secondUser._id.toString(), false);
    } catch (err: any) {
      if (err.statusCode === 403) {
        unauthorizedOrderAccessBlocked = true;
      }
    }
    assert(unauthorizedOrderAccessBlocked, 'User cannot access another user purchase order (403 Forbidden)');

    // Super Admin CAN inspect any order
    const adminInspected = await paymentService.getOrder(order.orderId, secondUser._id.toString(), true);
    assert(adminInspected.orderId === order.orderId, 'Super Admin can inspect orders across the platform');

  } finally {
    await teardownTestDb();
  }

  console.log('\n=============================================');
  console.log(`  PHASE 3 RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('=============================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPhase3Tests().catch((err) => {
  console.error('Phase 3 test failed with error:', err);
  process.exit(1);
});
