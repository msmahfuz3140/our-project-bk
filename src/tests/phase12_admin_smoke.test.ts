import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { app } from '../app';
import { env } from '../config/env';
import { UserModel } from '../models/User';
import { AdminTwoFactorModel } from '../models/AdminTwoFactor';
import { PaymentModel } from '../models/Payment';
import { SubscriptionModel } from '../models/Subscription';
import { ContactMessageModel } from '../models/ContactMessage';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { UserRole } from '../shared/roles';
import { SubscriptionStatus } from '../shared/subscriptions';
import { hashPassword } from '../utils/crypto';
import { seedPlansIfEmpty } from '../models/Plan';

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
  return jwt.sign({ userId, scope: 'access', amr: ['pwd', 'totp'] }, env.JWT_SECRET, { expiresIn: '1h' });
}

async function get(path: string, token: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function patch(path: string, token: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, body: data };
}

async function run() {
  console.log('\n=============================================');
  console.log('  PHASE 12 ADMIN PANEL API SMOKE TEST');
  console.log('=============================================\n');

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await seedPlansIfEmpty();

  const admin = await UserModel.create({
    name: 'Admin Smoke',
    email: 'admin.smoke@example.com',
    passwordHash: await hashPassword('AdminSmokePassword123!'),
    role: UserRole.SUPER_ADMIN,
    isEmailVerified: true,
    isActive: true
  });
  await AdminTwoFactorModel.create({ userId: admin._id, enabled: true });

  const member = await UserModel.create({
    name: 'Member Smoke',
    email: 'member.smoke@example.com',
    passwordHash: await hashPassword('MemberSmokePassword123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true,
    referredBy: admin._id
  });

  const now = new Date();
  const subscription = await SubscriptionModel.create({
    userId: member._id,
    planId: 'PLAN_1_MONTH',
    status: SubscriptionStatus.ACTIVE,
    startDate: now,
    endDate: new Date(now.getTime() + 30 * 86400000),
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
    paymentId: 'NP_ADMIN_SMOKE',
    orderId: 'ORD_ADMIN_SMOKE',
    status: 'FINISHED',
    isFulfilled: true,
    fulfillmentStatus: 'FULFILLED',
    subscriptionId: subscription._id,
    verified: true,
    signatureVerified: true,
    providerVerified: true,
    paidAt: now
  });

  await ReferralCommissionModel.create({
    moderatorId: admin._id,
    referredUserId: member._id,
    paymentId: new mongoose.Types.ObjectId(),
    amountUsd: 100,
    commissionRate: 0.5,
    status: 'CREDITED',
    subscriptionPlan: 'PLAN_1_MONTH',
    originalPurchaseAmount: 200
  });

  const contact = await ContactMessageModel.create({
    name: 'Contact Smoke',
    email: 'contact.smoke@example.com',
    subject: 'Admin smoke message',
    message: 'This message is used by the admin smoke test.',
    status: 'NEW'
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const adminToken = tokenFor(admin._id.toString());
  const memberToken = tokenFor(member._id.toString());

  const endpoints = [
    ['/api/v1/admin/dashboard-metrics', 'dashboard metrics'],
    ['/api/v1/admin/system/health', 'system health'],
    ['/api/v1/admin/users?page=1&limit=10', 'user management'],
    ['/api/v1/admin/users/' + member._id.toString(), 'user details'],
    ['/api/v1/payments/admin/orders?page=1&limit=10', 'payment orders'],
    ['/api/v1/payments/admin/summary', 'payment summary'],
    ['/api/v1/payments/admin/health', 'payment health'],
    ['/api/v1/subscriptions/admin/list?page=1&limit=10', 'subscription management'],
    ['/api/v1/admin/reports/summary', 'reports summary'],
    ['/api/v1/admin/tickets?page=1&limit=10', 'support tickets'],
    ['/api/v1/admin/security/overview', 'security overview'],
    ['/api/v1/admin/security/alerts', 'security alerts'],
    ['/api/v1/admin/audit-logs?page=1&limit=10', 'audit logs'],
    ['/api/v1/admin/settings', 'website settings'],
    ['/api/v1/admin/tool/settings', 'tool settings'],
    ['/api/v1/admin/plans', 'plan catalogue'],
    ['/api/v1/admin/moderators?page=1&limit=10', 'moderator management'],
    ['/api/v1/admin/referrals/overview', 'referral overview'],
    ['/api/v1/contact/admin/messages?page=1&limit=10', 'contact messages']
  ];

  for (const [path, label] of endpoints) {
    const result = await get(path, adminToken);
    assert(result.status === 200, `${label} endpoint returns 200`, { path, status: result.status, body: result.body });
  }

  const reports = await get('/api/v1/admin/reports/summary', adminToken);
  assert(
    Array.isArray(reports.body?.data?.subscriptions?.planDistribution),
    'reports use a database-driven plan distribution array'
  );

  const messageUpdate = await patch(`/api/v1/contact/admin/messages/${contact._id}`, adminToken, {
    status: 'RESOLVED',
    reason: 'Phase 12 admin smoke verification'
  });
  assert(messageUpdate.status === 200, 'contact message status update works', messageUpdate);
  const resolved = await ContactMessageModel.findById(contact._id);
  assert(resolved?.status === 'RESOLVED', 'contact message status persists');

  const forbidden = await get('/api/v1/admin/system/health', memberToken);
  assert(forbidden.status === 403, 'normal member is forbidden from admin system health');

  const paymentsForbidden = await get('/api/v1/payments/admin/orders', memberToken);
  assert(paymentsForbidden.status === 403, 'normal member is forbidden from admin payment orders');

  console.log('\n=============================================');
  console.log(`  PHASE 12 RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=============================================\n');
}

run()
  .catch((error) => {
    console.error('Unhandled Phase 12 failure:', error);
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
