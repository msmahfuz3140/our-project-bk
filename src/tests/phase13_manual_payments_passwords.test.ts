import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { app } from '../app';
import { env } from '../config/env';
import { nowPaymentsService } from '../services/nowpayments.service';
import { paymentService } from '../services/payment.service';
import { UserModel } from '../models/User';
import { PaymentModel } from '../models/Payment';
import { SubscriptionModel } from '../models/Subscription';
import { AuditLogModel } from '../models/AuditLog';
import { UserRole } from '../shared/roles';
import { PaymentStatus, SubscriptionStatus } from '../shared/subscriptions';
import { hashPassword, comparePassword } from '../utils/crypto';

let mongod: MongoMemoryServer;
let server: any;
let baseUrl = '';
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

function tokenFor(userId: string): string {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: '1h' });
}

async function request(
  path: string,
  options: { method?: string; token?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function makeOrder(userId: string) {
  return paymentService.createPurchaseOrder(userId, 'PLAN_1_MONTH', 'USDTTRC20');
}

async function run() {
  console.log('\n=============================================');
  console.log('  PHASE 13 MANUAL PAYMENTS + PASSWORD FLOW');
  console.log('=============================================\n');

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const admin = await UserModel.create({
    name: 'Manual Review Admin',
    email: 'manual.admin@example.com',
    passwordHash: await hashPassword('AdminPass123!'),
    role: UserRole.SUPER_ADMIN,
    isEmailVerified: true,
    isActive: true
  });

  const buyer = await UserModel.create({
    name: 'Manual Buyer',
    email: 'manual.buyer@example.com',
    passwordHash: await hashPassword('BuyerPass123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true
  });

  const attacker = await UserModel.create({
    name: 'Unprivileged User',
    email: 'manual.attacker@example.com',
    passwordHash: await hashPassword('AttackerPass123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true
  });

  const directBuyer = await UserModel.create({
    name: 'Direct Webhook Buyer',
    email: 'direct.webhook.buyer@example.com',
    passwordHash: await hashPassword('DirectBuyer123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true
  });

  const adminToken = tokenFor(admin._id.toString());
  const buyerToken = tokenFor(buyer._id.toString());
  const attackerToken = tokenFor(attacker._id.toString());

  // Orders must be created while the provider key is empty (simulation), then
  // provider IDs are attached so manual review can exercise provider checks.
  const approveOrder = await makeOrder(buyer._id.toString());
  const rejectOrder = await makeOrder(buyer._id.toString());
  const noProviderOrder = await makeOrder(buyer._id.toString());
  const directWebhookOrder = await makeOrder(directBuyer._id.toString());

  await PaymentModel.updateOne(
    { orderId: approveOrder.orderId },
    { $set: { providerPaymentId: '77001', paymentId: '77001', payCurrency: 'USDTTRC20' } }
  );
  await PaymentModel.updateOne(
    { orderId: rejectOrder.orderId },
    { $set: { providerPaymentId: '77002', paymentId: '77002', payCurrency: 'USDTTRC20' } }
  );

  const originalKey = env.NOWPAYMENTS_API_KEY;
  (env as any).NOWPAYMENTS_API_KEY = 'test_manual_provider_key';

  const providerPayload = (order: any, paymentId: string, status: string) => ({
    payment_id: Number(paymentId),
    payment_status: status,
    price_amount: order.priceUsd,
    price_currency: 'usd',
    pay_amount: order.priceUsd,
    actually_paid: status === 'finished' ? order.priceUsd : 0,
    pay_currency: 'usdttrc20',
    order_id: order.orderId,
    payin_hash: status === 'finished' ? `manual_tx_${paymentId}` : undefined,
    updated_at: new Date().toISOString()
  });

  let approveProviderStatus = 'waiting';
  (nowPaymentsService as any).getPayment = async (paymentId: string) => {
    if (paymentId === '77001') return providerPayload(approveOrder, '77001', approveProviderStatus);
    if (paymentId === '77002') return providerPayload(rejectOrder, '77002', 'waiting');
    throw new Error('Unknown provider payment id in test');
  };

  console.log('[0. First-event finished IPN persists settlement data]');
  const directPayload = {
    payment_id: 77003,
    payment_status: 'finished',
    price_amount: directWebhookOrder.priceUsd,
    price_currency: 'usd',
    pay_amount: directWebhookOrder.priceUsd,
    actually_paid: directWebhookOrder.priceUsd,
    pay_currency: 'usdttrc20',
    order_id: directWebhookOrder.orderId,
    payin_hash: 'direct_tx_77003',
    updated_at: new Date().toISOString()
  };
  const directSignature = nowPaymentsService.generateIpnSignature(
    directPayload,
    env.NOWPAYMENTS_IPN_SECRET
  );
  const directWebhook = await request('/api/v1/payments/nowpayments/webhook', {
    method: 'POST',
    body: directPayload,
    headers: { 'x-nowpayments-sig': directSignature }
  });
  assert(directWebhook.status === 200, 'first-event finished webhook is accepted', directWebhook);
  assert(directWebhook.body?.data?.isFulfilled === true, 'first-event finished webhook fulfils the order', directWebhook.body);

  const storedDirect = await PaymentModel.findOne({ orderId: directWebhookOrder.orderId });
  assert(storedDirect?.status === PaymentStatus.FINISHED, 'direct webhook payment is FINISHED');
  assert(storedDirect?.providerPaymentId === '77003', 'direct webhook persisted provider payment id');
  assert(storedDirect?.transactionId === 'direct_tx_77003', 'direct webhook persisted transaction hash');
  assert(
    storedDirect?.actuallyPaid === directWebhookOrder.priceUsd,
    'direct webhook persisted actually_paid amount'
  );
  assert(
    storedDirect?.payCurrency === 'USDTTRC20',
    'direct webhook persisted pay currency'
  );
  assert(
    (await SubscriptionModel.countDocuments({ userId: directBuyer._id })) === 1,
    'direct webhook activated exactly one subscription'
  );

  console.log('[1. Authorization and verification gates]');
  const buyerApprove = await request(
    `/api/v1/payments/admin/orders/${approveOrder.orderId}/approve`,
    { method: 'POST', token: buyerToken, body: { reason: 'Trying to self-activate Premium' } }
  );
  assert(buyerApprove.status === 403, 'non-admin cannot approve a payment', buyerApprove);

  const missingReason = await request(
    `/api/v1/payments/admin/orders/${approveOrder.orderId}/approve`,
    { method: 'POST', token: adminToken, body: {} }
  );
  assert(missingReason.status === 400, 'approval without audit reason is rejected', missingReason);

  const waitingApproval = await request(
    `/api/v1/payments/admin/orders/${approveOrder.orderId}/approve`,
    { method: 'POST', token: adminToken, body: { reason: 'Provider still reports waiting' } }
  );
  assert(waitingApproval.status === 409, 'unpaid/waiting provider payment cannot be approved', waitingApproval);
  assert(
    (await SubscriptionModel.countDocuments({ userId: buyer._id })) === 0,
    'blocked manual approval did not activate Premium'
  );

  const noProvider = await request(
    `/api/v1/payments/admin/orders/${noProviderOrder.orderId}/approve`,
    { method: 'POST', token: adminToken, body: { reason: 'No provider payment id stored' } }
  );
  assert(noProvider.status === 409, 'order without provider payment id cannot be approved', noProvider);

  console.log('\n[2. Verified manual approval]');
  approveProviderStatus = 'finished';
  const approved = await request(
    `/api/v1/payments/admin/orders/${approveOrder.orderId}/approve`,
    { method: 'POST', token: adminToken, body: { reason: 'Provider confirms finished settlement' } }
  );
  assert(approved.status === 200, 'admin approves a provider-verified finished payment', approved);
  assert(approved.body?.data?.status === PaymentStatus.FINISHED, 'approval response reports FINISHED', approved.body);

  const storedApproved = await PaymentModel.findOne({ orderId: approveOrder.orderId });
  assert(storedApproved?.status === PaymentStatus.FINISHED, 'payment persisted as FINISHED');
  assert(storedApproved?.isFulfilled === true, 'payment persisted as fulfilled');
  assert(storedApproved?.providerVerified === true, 'provider verification evidence stored');
  assert(storedApproved?.activationSource === 'MANUAL', 'activation source recorded as MANUAL');
  assert(
    storedApproved?.reviewedByAdminEmail === admin.email,
    'reviewing administrator email recorded on payment'
  );
  assert(Boolean(storedApproved?.reviewedAt), 'manual review timestamp recorded');

  const approvedSub = await SubscriptionModel.findOne({ userId: buyer._id });
  assert(Boolean(approvedSub), 'manual approval created a subscription');
  assert(approvedSub?.status === SubscriptionStatus.ACTIVE, 'manually approved subscription is ACTIVE');
  assert(approvedSub?.endDate && approvedSub.endDate > new Date(), 'manually approved subscription has a future expiry');
  assert(
    approvedSub?.paymentId?.toString() === storedApproved?._id.toString(),
    'subscription is linked to the approved payment'
  );

  const approveAudit = await AuditLogModel.findOne({
    action: 'PAYMENT_MANUAL_APPROVE',
    targetUserId: buyer._id
  });
  assert(Boolean(approveAudit), 'manual approval wrote an immutable audit log');
  assert(approveAudit?.adminEmail === admin.email, 'audit log records the approving administrator');

  console.log('\n[3. Duplicate approval protection]');
  const duplicateApprove = await request(
    `/api/v1/payments/admin/orders/${approveOrder.orderId}/approve`,
    { method: 'POST', token: adminToken, body: { reason: 'Duplicate attempt' } }
  );
  assert(duplicateApprove.status === 409, 'duplicate manual approval is blocked', duplicateApprove);
  assert(
    (await SubscriptionModel.countDocuments({ userId: buyer._id })) === 1,
    'duplicate approval did not create a second subscription'
  );

  console.log('\n[4. Manual rejection]');
  const rejected = await request(
    `/api/v1/payments/admin/orders/${rejectOrder.orderId}/reject`,
    { method: 'POST', token: adminToken, body: { reason: 'Provider never settled this invoice' } }
  );
  assert(rejected.status === 200, 'admin rejects a pending payment', rejected);

  const storedRejected = await PaymentModel.findOne({ orderId: rejectOrder.orderId });
  assert(storedRejected?.status === PaymentStatus.REJECTED, 'payment persisted as REJECTED');
  assert(storedRejected?.isFulfilled === false, 'rejected payment is not fulfilled');
  assert(storedRejected?.manualReviewStatus === 'REJECTED', 'rejection review status stored');
  assert(
    storedRejected?.reviewedByAdminEmail === admin.email,
    'rejecting administrator email recorded on payment'
  );
  assert(
    (await SubscriptionModel.countDocuments({ userId: buyer._id })) === 1,
    'rejection did not activate or duplicate a subscription'
  );

  const rejectAudit = await AuditLogModel.findOne({
    action: 'PAYMENT_MANUAL_REJECT',
    targetUserId: buyer._id
  });
  assert(Boolean(rejectAudit), 'manual rejection wrote an audit log');

  const duplicateReject = await request(
    `/api/v1/payments/admin/orders/${rejectOrder.orderId}/reject`,
    { method: 'POST', token: adminToken, body: { reason: 'Duplicate rejection' } }
  );
  assert(duplicateReject.status === 409, 'duplicate rejection is blocked', duplicateReject);

  const approveRejected = await request(
    `/api/v1/payments/admin/orders/${rejectOrder.orderId}/approve`,
    { method: 'POST', token: adminToken, body: { reason: 'Trying to approve a rejected payment' } }
  );
  assert(approveRejected.status === 409, 'rejected payment cannot be approved later', approveRejected);

  console.log('\n[5. Admin password update and login]');
  const tempPassword = 'TempPass123!';
  const passwordUpdate = await request(`/api/v1/admin/users/${buyer._id.toString()}/profile`, {
    method: 'PATCH',
    token: adminToken,
    body: {
      password: tempPassword,
      confirmPassword: tempPassword,
      mustChangePassword: true,
      reason: 'Administrator issued a temporary password for support verification'
    }
  });
  assert(passwordUpdate.status === 200, 'admin can set a user password', passwordUpdate);
  assert(passwordUpdate.body?.data?.passwordHash === undefined, 'API response never returns passwordHash');
  assert(
    passwordUpdate.body?.data?.mustChangePassword === true,
    'temporary password flag saved in the database response'
  );

  const hashedUser = await UserModel.findById(buyer._id);
  assert(hashedUser?.passwordHash !== tempPassword, 'password is not stored in plaintext');
  assert(Boolean(hashedUser?.passwordHash?.startsWith('$2')), 'password stored as a bcrypt hash');
  assert(
    Boolean(hashedUser?.passwordHash && (await comparePassword(tempPassword, hashedUser.passwordHash))),
    'stored hash verifies the temporary password'
  );

  const resetAudit = await AuditLogModel.findOne({
    action: 'USER_PASSWORD_RESET',
    targetUserId: buyer._id
  });
  assert(Boolean(resetAudit), 'admin password reset wrote an audit log');
  assert(
    !JSON.stringify(resetAudit).includes(tempPassword),
    'password audit log never contains the plaintext password'
  );

  const tempLogin = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { identifier: buyer.email, password: tempPassword }
  });
  assert(tempLogin.status === 200, 'temporary password works for login', tempLogin);
  assert(
    tempLogin.body?.data?.user?.mustChangePassword === true,
    'login response requires a password change'
  );

  const tempToken = tempLogin.body?.data?.token;

  console.log('\n[6. Forced password change and old-password rejection]');
  const newPassword = 'NewPrivatePass456!';
  const changed = await request('/api/v1/auth/change-password', {
    method: 'POST',
    token: tempToken,
    body: { oldPassword: tempPassword, newPassword }
  });
  assert(changed.status === 200, 'user can replace the temporary password', changed);

  const changedUser = await UserModel.findById(buyer._id);
  assert(changedUser?.mustChangePassword === false, 'forced change flag cleared after password change');
  assert(
    Boolean(changedUser?.passwordHash && (await comparePassword(newPassword, changedUser.passwordHash))),
    'new password verifies against the stored hash'
  );

  const oldLogin = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { identifier: buyer.email, password: tempPassword }
  });
  assert(oldLogin.status === 401, 'old temporary password is rejected after change', oldLogin);

  const newLogin = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { identifier: buyer.email, password: newPassword }
  });
  assert(newLogin.status === 200, 'new password works for login', newLogin);
  assert(
    newLogin.body?.data?.user?.mustChangePassword === false,
    'new login no longer requires a password change'
  );

  console.log('\n[7. Password isolation and validation]');
  const unauthorizedReset = await request(`/api/v1/admin/users/${buyer._id.toString()}/profile`, {
    method: 'PATCH',
    token: attackerToken,
    body: { password: 'AttackerChosen123!', confirmPassword: 'AttackerChosen123!', reason: 'Unauthorized attempt' }
  });
  assert(unauthorizedReset.status === 403, 'non-admin cannot change another user password', unauthorizedReset);

  const afterAttacker = await UserModel.findById(buyer._id);
  assert(
    Boolean(afterAttacker?.passwordHash && (await comparePassword(newPassword, afterAttacker.passwordHash))),
    'unauthorized request did not modify the target password'
  );

  const mismatch = await request(`/api/v1/admin/users/${buyer._id.toString()}/profile`, {
    method: 'PATCH',
    token: adminToken,
    body: {
      password: 'MismatchPass123!',
      confirmPassword: 'DifferentPass123!',
      mustChangePassword: true,
      reason: 'Validation test'
    }
  });
  assert(mismatch.status === 400, 'mismatched password confirmation is rejected', mismatch);

  const afterMismatch = await UserModel.findById(buyer._id);
  assert(
    Boolean(afterMismatch?.passwordHash && (await comparePassword(newPassword, afterMismatch.passwordHash))),
    'failed validation left the existing password unchanged'
  );

  (env as any).NOWPAYMENTS_API_KEY = originalKey;

  console.log('\n=============================================');
  console.log(`  PHASE 13 RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('=============================================\n');

  try {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    await mongoose.disconnect().catch(() => null);
    await mongod?.stop().catch(() => null);
    process.exit(failedTests > 0 ? 1 : 0);
  } catch {
    process.exit(1);
  }
}

run().catch(async (error) => {
  console.error('Phase 13 suite crashed:', error);
  (env as any).NOWPAYMENTS_API_KEY = '';
  await mongoose.disconnect().catch(() => null);
  await mongod?.stop().catch(() => null);
  process.exit(1);
});
