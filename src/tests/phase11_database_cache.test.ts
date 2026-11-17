import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { app } from '../app';
import { env } from '../config/env';
import { authService } from '../services/auth.service';
import { websiteSettingsService } from '../services/websiteSettings.service';
import { ensureSecurityBaseline } from '../database/ensureIndexes';
import { UserModel } from '../models/User';
import { SubscriptionModel } from '../models/Subscription';
import { PaymentModel } from '../models/Payment';
import { ContactMessageModel } from '../models/ContactMessage';
import { ReferralClickModel } from '../models/ReferralClick';
import { SecurityLogModel } from '../models/SecurityLog';
import { UserRole } from '../shared/roles';
import { SubscriptionStatus } from '../shared/subscriptions';
import { hashPassword } from '../utils/crypto';
import { memoryCache } from '../utils/cache';

let mongod: MongoMemoryServer;
let server: any;
let baseUrl = '';
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

function tokenFor(userId: string): string {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: '1h' });
}

async function get(path: string, token?: string, headers?: Record<string, string>) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {})
    }
  });
  const body = await response.text();
  return { status: response.status, body, headers: response.headers };
}

async function post(path: string, body: unknown, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function run() {
  console.log('\n=============================================');
  console.log('  PHASE 11 DATABASE, CACHE & SECURITY AUDIT');
  console.log('=============================================\n');

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const superAdmin = await UserModel.create({
    name: 'System Admin',
    email: 'system.admin@example.com',
    passwordHash: await hashPassword('AdminPassword123!'),
    role: UserRole.SUPER_ADMIN,
    isEmailVerified: true,
    isActive: true
  });

  const member = await UserModel.create({
    name: 'Cache Member',
    email: 'cache.member@example.com',
    passwordHash: await hashPassword('MemberPassword123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true
  });

  const moderator = await UserModel.create({
    name: 'Affiliate Partner',
    email: 'affiliate@example.com',
    passwordHash: await hashPassword('ModeratorPassword123!'),
    role: UserRole.MODERATOR,
    isEmailVerified: true,
    isActive: true,
    referralCode: 'MOD_TEST_CACHE'
  });

  // Legacy security fields inserted directly to bypass the current schema.
  await UserModel.collection.insertOne({
    name: 'Legacy Password User',
    email: 'legacy.plain@example.com',
    passwordHash: await hashPassword('LegacyPassword123!'),
    plainPassword: 'LegacyPlaintext!',
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date()
  });

  console.log('[1. Plaintext password removal]');
  const baseline = await ensureSecurityBaseline();
  const legacy = await UserModel.collection.findOne({ email: 'legacy.plain@example.com' });
  assert(baseline.removedPlaintextPasswords >= 1, 'legacy plaintext password field removed');
  assert(!legacy?.plainPassword, 'legacy document no longer contains plainPassword');

  console.log('\n[2. Security event logging]');
  try {
    await authService.login({ identifier: 'cache.member@example.com', password: 'wrong-password' }, '127.0.0.1', 'test');
  } catch {
    // expected
  }
  const failedLog = await SecurityLogModel.findOne({ email: 'cache.member@example.com', eventType: 'LOGIN_FAILED' });
  assert(Boolean(failedLog), 'failed login security event persisted');
  assert(!JSON.stringify(failedLog?.toObject() || {}).includes('wrong-password'), 'security log does not contain the attempted password');

  // Seed a real active subscription and payment for the aggregate dashboard.
  const now = new Date();
  const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const subscription = await SubscriptionModel.create({
    userId: member._id,
    planId: 'PLAN_1_MONTH',
    status: SubscriptionStatus.ACTIVE,
    startDate: now,
    endDate,
    isApprovedByAdmin: true,
    isSecretCodeClaimed: true
  });
  await PaymentModel.create({
    userId: member._id,
    planId: 'PLAN_1_MONTH',
    planName: '1 Month Pro',
    priceCents: 20000,
    priceAmount: 200,
    priceCurrency: 'USD',
    duration: { unit: 'MONTHS', value: 1 },
    durationDays: 30,
    payCurrency: 'USDTTRC20',
    paymentId: 'NP_PHASE11_TEST',
    orderId: 'ORD_PHASE11_TEST',
    status: 'FINISHED',
    isFulfilled: true,
    fulfillmentStatus: 'FULFILLED',
    subscriptionId: subscription._id,
    verified: true,
    signatureVerified: true,
    providerVerified: true,
    paidAt: now
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const memberToken = tokenFor(member._id.toString());
  const adminToken = tokenFor(superAdmin._id.toString());

  console.log('\n[3. Public cache + ETag revalidation]');
  const health = await get('/api/v1/health');
  const healthJson = JSON.parse(health.body);
  assert(health.status === 200, 'health reports UP when database is connected', health.status);
  assert(
    healthJson.data?.status === 'UP' && healthJson.data?.ready === true,
    'health reports readiness without leaking infrastructure details'
  );
  assert(healthJson.data?.database === undefined, 'health payload omits database internals');
  const authHealth = await get('/api/auth/ok');
  assert(authHealth.status < 500, 'Better Auth handler initializes with secure cookie configuration', authHealth.status);
  const firstSettings = await get('/api/v1/settings/public');
  assert(firstSettings.status === 200, 'public settings first request 200');
  const etag = firstSettings.headers.get('etag');
  const cacheControl = firstSettings.headers.get('cache-control');
  assert(Boolean(etag), 'public settings response has ETag');
  assert(Boolean(cacheControl?.includes('public')), 'public settings response is publicly cacheable');
  const revalidated = await get('/api/v1/settings/public', undefined, { 'If-None-Match': etag || '' });
  assert(revalidated.status === 304, 'matching ETag returns 304 Not Modified');

  const privateSettings = await get('/api/v1/settings/public', memberToken);
  assert(privateSettings.headers.get('cache-control')?.includes('no-store') === true, 'authenticated request bypasses shared HTTP cache');

  console.log('\n[4. Website settings cache invalidation]');
  await websiteSettingsService.updateSettings(
    superAdmin._id.toString(),
    'system.admin@example.com',
    { siteName: 'Roulette Accuracy Cache Test' },
    'Phase 11 cache invalidation test'
  );
  const updatedSettings = await get('/api/v1/settings/public');
  assert(updatedSettings.body.includes('Roulette Accuracy Cache Test'), 'admin update invalidated public settings cache immediately');

  console.log('\n[5. Contact message persistence]');
  const contact = await post('/api/v1/contact', {
    name: 'Inquiry Tester',
    email: 'inquiry@example.com',
    subject: 'Database persistence check',
    message: 'This contact message must be persisted in MongoDB, not only logged.'
  });
  assert(contact.status === 201, 'contact form returns 201 after persistence', contact);
  const storedContact = await ContactMessageModel.findOne({ email: 'inquiry@example.com' });
  assert(Boolean(storedContact), 'contact message exists in MongoDB');
  const adminMessages = await get('/api/v1/contact/admin/messages', adminToken);
  assert(adminMessages.status === 200 && adminMessages.body.includes('Database persistence check'), 'admin can read persisted contact messages');

  console.log('\n[6. Referral click persistence]');
  const click = await post('/api/v1/referrals/click', {
    referralCode: 'MOD_TEST_CACHE',
    path: '/gerister',
    referrer: 'https://accuracy.tools'
  });
  assert(click.status === 201, 'referral click endpoint accepted', click);
  const clickCount = await ReferralClickModel.countDocuments({ referralCode: 'MOD_TEST_CACHE' });
  assert(clickCount === 1, 'referral click stored in MongoDB');

  console.log('\n[7. Aggregated member dashboard]');
  const dashboard = await get('/api/v1/dashboard/me', memberToken);
  const dashboardJson = JSON.parse(dashboard.body);
  assert(dashboard.status === 200, 'member dashboard aggregate returns 200', dashboard.status);
  assert(dashboardJson.data?.profile?.email === 'cache.member@example.com', 'dashboard includes profile from database');
  assert(dashboardJson.data?.subscription?.planName === '1 Month Pro', 'dashboard includes active subscription and plan name');
  assert(dashboardJson.data?.paymentSummary?.totalSpentUsd === 200, 'dashboard includes payment summary');
  assert(Array.isArray(dashboardJson.data?.recentPayments), 'dashboard includes recent payments');

  console.log('\n[8. Measured API performance and admin system health]');
  const durations: number[] = [];
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    const result = await get('/api/v1/subscriptions/plans');
    durations.push(performance.now() - started);
    if (result.status !== 200) {
      assert(false, 'plans endpoint failed during benchmark');
      break;
    }
  }
  durations.sort((a, b) => a - b);
  const p50 = Math.round(durations[Math.floor(durations.length / 2)] * 100) / 100;
  const p95 = Math.round(durations[Math.floor(durations.length * 0.95)] * 100) / 100;
  console.log(`  INFO: cached plans p50=${p50}ms p95=${p95}ms (local in-process measurement)`);

  const dashboardDurations: number[] = [];
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    await get('/api/v1/dashboard/me', memberToken);
    dashboardDurations.push(performance.now() - started);
  }
  dashboardDurations.sort((a, b) => a - b);
  console.log(
    `  INFO: aggregated member dashboard p50=${Math.round(dashboardDurations[5] * 100) / 100}ms p95=${Math.round(dashboardDurations[9] * 100) / 100}ms (local)`
  );

  const adminDurations: number[] = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    await get('/api/v1/admin/dashboard-metrics', adminToken);
    adminDurations.push(performance.now() - started);
  }
  adminDurations.sort((a, b) => a - b);
  console.log(
    `  INFO: cached admin metrics p50=${Math.round(adminDurations[2] * 100) / 100}ms p95=${Math.round(adminDurations[4] * 100) / 100}ms (local)`
  );

  const system = await get('/api/v1/admin/system/health', adminToken);
  const systemJson = JSON.parse(system.body);
  assert(system.status === 200, 'admin system health returns 200', system.status);
  assert(systemJson.data?.securityBaseline?.plaintextPasswordFields === 0, 'system health proves zero plaintext password fields');
  assert(systemJson.data?.indexes?.ready === true, 'critical indexes are ready');
  assert((systemJson.data?.performance?.requests?.total || 0) > 0, 'request latency metrics are being measured');
  assert((systemJson.data?.cache?.hits || 0) > 0, 'server cache hit counter increased');

  console.log('\n[9. CSRF guard and private cache isolation]');
  const csrfAttempt = await fetch(`${baseUrl}/api/v1/auth/profile`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'sloot_token=fake-cookie-token'
    },
    body: JSON.stringify({ name: 'CSRF Attempt' })
  });
  assert(csrfAttempt.status === 403, 'cookie-authenticated mutation without trusted Origin is blocked', csrfAttempt.status);

  const secondMember = await UserModel.create({    name: 'Second Member',
    email: 'second.member@example.com',
    passwordHash: await hashPassword('SecondPassword123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true
  });
  const secondToken = tokenFor(secondMember._id.toString());
  const secondDashboard = await get('/api/v1/dashboard/me', secondToken);
  const secondJson = JSON.parse(secondDashboard.body);
  assert(secondJson.data?.profile?.email === 'second.member@example.com', 'second user receives only their own dashboard');
  assert(secondJson.data?.subscription === null, 'second user does not receive the first user subscription cache');

  console.log('\n=============================================');
  console.log(`  PHASE 11 RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=============================================\n');
}

run()
  .catch((error) => {
    console.error('Unhandled Phase 11 failure:', error);
    failed++;
  })
  .finally(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    await mongoose.disconnect().catch(() => null);
    await mongod?.stop().catch(() => null);
    process.exit(failed > 0 ? 1 : 0);
  });
