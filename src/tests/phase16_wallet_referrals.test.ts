import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { paymentService } from '../services/payment.service';
import { walletService } from '../services/wallet.service';
import { commissionService } from '../services/commission.service';
import { moderatorService } from '../services/moderator.service';
import { nowPaymentsService } from '../services/nowpayments.service';
import { CommissionPolicyModel } from '../models/CommissionPolicy';
import { UserModel } from '../models/User';
import { PaymentModel } from '../models/Payment';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { WalletModel } from '../models/Wallet';
import { WalletTransactionModel } from '../models/WalletTransaction';
import { WithdrawalRequestModel } from '../models/WithdrawalRequest';
import { UserRole } from '../shared/roles';
import { PaymentStatus } from '../shared/subscriptions';
import { hashPassword } from '../utils/crypto';
import { env } from '../config/env';
import { seedPlansIfEmpty } from '../models/Plan';

let mongod: MongoMemoryServer | undefined;
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

async function createUser(input: {
  name: string;
  email: string;
  role?: UserRole;
  referredBy?: mongoose.Types.ObjectId;
  referralCode?: string;
}) {
  return UserModel.create({
    name: input.name,
    email: input.email,
    passwordHash: await hashPassword('WalletPass123!'),
    role: input.role || UserRole.USER,
    isEmailVerified: true,
    isActive: true,
    accountStatus: 'ACTIVE',
    referralCode: input.referralCode || `REF-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    referredBy: input.referredBy,
    referredAt: input.referredBy ? new Date() : undefined,
    referralCodeUsed: input.referredBy ? 'REF-TEST' : undefined
  });
}

function finishedPayload(order: any, paymentId: string, status = 'finished') {
  return {
    payment_id: Number(paymentId),
    payment_status: status,
    price_amount: order.priceUsd,
    price_currency: 'usd',
    pay_amount: order.priceUsd,
    actually_paid: status === 'finished' ? order.priceUsd : order.priceUsd,
    pay_currency: order.payCurrency.toLowerCase(),
    order_id: order.orderId,
    payin_hash: `wallet_tx_${paymentId}_${status}`,
    updated_at: new Date().toISOString()
  };
}

async function processFinished(order: any, paymentId: string) {
  const payload = finishedPayload(order, paymentId);
  const signature = nowPaymentsService.generateIpnSignature(payload, env.NOWPAYMENTS_IPN_SECRET);
  return paymentService.processIpnCallback(payload as any, signature);
}

async function run() {
  console.log('\n=============================================');
  console.log('  PHASE 16 REFERRALS, WALLET & WITHDRAWALS');
  console.log('=============================================\n');

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await seedPlansIfEmpty();

  const admin = await createUser({
    name: 'Wallet Admin',
    email: 'wallet.admin@example.com',
    role: UserRole.SUPER_ADMIN
  });

  const normalReferrer = await createUser({
    name: 'Normal Referrer',
    email: 'normal.referrer@example.com'
  });
  const normalBuyer = await createUser({
    name: 'Normal Buyer',
    email: 'normal.buyer@example.com',
    referredBy: normalReferrer._id
  });

  const overrideReferrer = await createUser({
    name: 'Override Referrer',
    email: 'override.referrer@example.com'
  });
  overrideReferrer.referralCommissionRate = 0.4;
  overrideReferrer.referralCommissionType = 'ONE_TIME';
  await overrideReferrer.save();
  const overrideBuyer = await createUser({
    name: 'Override Buyer',
    email: 'override.buyer@example.com',
    referredBy: overrideReferrer._id
  });

  const moderator = await createUser({
    name: 'Lifetime Moderator',
    email: 'lifetime.moderator@example.com',
    role: UserRole.MODERATOR
  });
  const moderatorBuyer = await createUser({
    name: 'Moderator Buyer',
    email: 'moderator.buyer@example.com',
    referredBy: moderator._id
  });

  console.log('[1. Normal user: 30% one-time commission]');
  const normalOrder1 = await paymentService.createPurchaseOrder(
    normalBuyer._id.toString(),
    'PLAN_15_DAYS',
    'TRX'
  );
  await processFinished(normalOrder1, '71001');

  const normalCommission1 = await ReferralCommissionModel.findOne({
    referredUserId: normalBuyer._id
  });
  assert(normalCommission1?.commissionType === 'ONE_TIME', 'normal commission type is ONE_TIME');
  assert(normalCommission1?.commissionRate === 0.3, 'normal commission rate is 30%', normalCommission1?.commissionRate);
  assert(normalCommission1?.amountUsd === 45, 'normal first purchase earns $45 (30% of $150)', normalCommission1?.amountUsd);
  assert(normalCommission1?.status === 'CREDITED', 'normal commission is CREDITED');

  const normalWallet1 = await walletService.ensureWallet(normalReferrer._id);
  assert(normalWallet1.availableBalanceCents === 4500, 'normal referrer wallet credited $45');
  assert(normalWallet1.lifetimeCommissionCents === 4500, 'lifetime commission total updated');

  const normalOrder2 = await paymentService.createPurchaseOrder(
    normalBuyer._id.toString(),
    'PLAN_1_MONTH',
    'TRX'
  );
  await processFinished(normalOrder2, '71002');
  const normalCommissions = await ReferralCommissionModel.find({ referredUserId: normalBuyer._id });
  const normalWallet2 = await walletService.ensureWallet(normalReferrer._id);
  assert(normalCommissions.length === 1, 'normal user receives only one commission');
  assert(normalWallet2.availableBalanceCents === 4500, 'second purchase does not credit normal referrer again');

  console.log('\n[2. Moderator: 50% lifetime commission]');
  const modOrder1 = await paymentService.createPurchaseOrder(
    moderatorBuyer._id.toString(),
    'PLAN_15_DAYS',
    'TRX'
  );
  await processFinished(modOrder1, '72001');
  const modOrder2 = await paymentService.createPurchaseOrder(
    moderatorBuyer._id.toString(),
    'PLAN_1_MONTH',
    'TRX'
  );
  await processFinished(modOrder2, '72002');
  const modOrder3 = await paymentService.createPurchaseOrder(
    moderatorBuyer._id.toString(),
    'PLAN_15_DAYS',
    'TRX'
  );
  await processFinished(modOrder3, '72003');

  const modCommissions = await ReferralCommissionModel.find({
    referredUserId: moderatorBuyer._id
  });
  const modWallet = await walletService.ensureWallet(moderator._id);
  assert(modCommissions.length === 3, 'moderator receives commission on every purchase', modCommissions.length);
  assert(modCommissions.every((c) => c.commissionType === 'LIFETIME'), 'moderator commissions are LIFETIME');
  assert(modCommissions.every((c) => c.commissionRate === 0.5), 'moderator rate is 50%');
  assert(modWallet.availableBalanceCents === 25000, 'moderator wallet has $250 from three purchases', modWallet.availableBalanceCents);

  console.log('\n[3. Individual override and eligibility]');
  const overrideOrder = await paymentService.createPurchaseOrder(
    overrideBuyer._id.toString(),
    'PLAN_15_DAYS',
    'TRX'
  );
  await processFinished(overrideOrder, '73001');
  const overrideCommission = await ReferralCommissionModel.findOne({
    referredUserId: overrideBuyer._id
  });
  assert(overrideCommission?.commissionRate === 0.4, 'individual 40% override applied');
  assert(overrideCommission?.amountUsd === 60, 'individual override amount is $60');

  normalReferrer.referralEligible = false;
  await normalReferrer.save();
  const ineligibleOrder = await paymentService.createPurchaseOrder(
    normalBuyer._id.toString(),
    'PLAN_3_MONTHS',
    'TRX'
  );
  await processFinished(ineligibleOrder, '73002');
  const ineligibleCommissions = await ReferralCommissionModel.find({
    referredUserId: normalBuyer._id
  });
  assert(ineligibleCommissions.length === 1, 'ineligible referrer earns no further commission');

  console.log('\n[4. Duplicate webhook protection]');
  const duplicateOrder = await paymentService.createPurchaseOrder(
    moderatorBuyer._id.toString(),
    'PLAN_15_DAYS',
    'TRX'
  );
  const duplicatePayload = finishedPayload(duplicateOrder, '74001');
  const duplicateSig = nowPaymentsService.generateIpnSignature(duplicatePayload, env.NOWPAYMENTS_IPN_SECRET);
  await paymentService.processIpnCallback(duplicatePayload as any, duplicateSig);
  await paymentService.processIpnCallback(duplicatePayload as any, duplicateSig);
  const duplicateCommissions = await ReferralCommissionModel.find({
    paymentId: (await PaymentModel.findOne({ orderId: duplicateOrder.orderId }))?._id
  });
  assert(duplicateCommissions.length === 1, 'duplicate webhook generates one commission');

  console.log('\n[5. Refund reverses commission and wallet credit]');
  const refundOrder = await paymentService.createPurchaseOrder(
    moderatorBuyer._id.toString(),
    'PLAN_15_DAYS',
    'TRX'
  );
  await processFinished(refundOrder, '75001');
  const beforeRefundWallet = await walletService.ensureWallet(moderator._id);
  const refundPayment = await PaymentModel.findOne({ orderId: refundOrder.orderId });
  const refundCommission = await ReferralCommissionModel.findOne({ paymentId: refundPayment?._id });
  assert(refundCommission?.status === 'CREDITED', 'refund test commission initially credited');
  const refundPayload = {
    ...finishedPayload(refundOrder, '75001'),
    payment_status: 'refunded',
    actually_paid: refundOrder.priceUsd
  };
  const refundSig = nowPaymentsService.generateIpnSignature(refundPayload, env.NOWPAYMENTS_IPN_SECRET);
  await paymentService.processIpnCallback(refundPayload as any, refundSig);
  const reversedCommission = await ReferralCommissionModel.findById(refundCommission?._id);
  const afterRefundWallet = await walletService.ensureWallet(moderator._id);
  assert(reversedCommission?.status === 'REVERSED', 'refund reverses commission');
  assert(
    afterRefundWallet.availableBalanceCents === beforeRefundWallet.availableBalanceCents - 7500,
    'refund debits the commission from available wallet balance',
    { before: beforeRefundWallet.availableBalanceCents, after: afterRefundWallet.availableBalanceCents }
  );

  console.log('\n[6. Withdrawal reservation, rejection and refund]');
  const withdrawer = await createUser({ name: 'Withdraw User', email: 'withdraw.user@example.com' });
  await walletService.adjustBalance({
    userId: withdrawer._id.toString(),
    direction: 'ADD',
    amountCents: 5000,
    reason: 'Phase 16 test funding',
    adminId: admin._id.toString(),
    adminEmail: admin.email!,
    idempotencyKey: 'phase16-fund-withdrawer'
  });

  const withdrawal = await walletService.createWithdrawal(withdrawer._id.toString(), {
    amountCents: 2000,
    walletAddress: 'TWalletAddressPhase16Testing123456',
    network: 'USDT_TRC20',
    idempotencyKey: 'phase16-withdrawal-1'
  });
  const afterReserve = await walletService.ensureWallet(withdrawer._id);
  assert(withdrawal.status === 'PENDING', 'withdrawal request created PENDING');
  assert(afterReserve.availableBalanceCents === 3000, 'withdrawal amount reserved from available balance');
  assert(afterReserve.reservedWithdrawalCents === 2000, 'reserved withdrawal balance recorded');

  const duplicateWithdrawal = await walletService.createWithdrawal(withdrawer._id.toString(), {
    amountCents: 2000,
    walletAddress: 'TWalletAddressPhase16Testing123456',
    network: 'USDT_TRC20',
    idempotencyKey: 'phase16-withdrawal-1'
  });
  assert(duplicateWithdrawal._id.toString() === withdrawal._id.toString(), 'same idempotency key returns original request');
  assert(
    (await WalletTransactionModel.countDocuments({
      userId: withdrawer._id,
      type: 'WITHDRAWAL_RESERVE'
    })) === 1,
    'duplicate submission reserves balance only once'
  );

  const rejected = await walletService.rejectWithdrawal(
    admin._id.toString(),
    admin.email!,
    withdrawal._id.toString(),
    'Test rejection refund'
  );
  const afterReject = await walletService.ensureWallet(withdrawer._id);
  assert(rejected.status === 'REJECTED', 'withdrawal status becomes REJECTED');
  assert(afterReject.availableBalanceCents === 5000, 'rejected withdrawal refunds exact amount');
  assert(afterReject.reservedWithdrawalCents === 0, 'reserved balance returns to zero');

  await walletService.rejectWithdrawal(
    admin._id.toString(),
    admin.email!,
    withdrawal._id.toString(),
    'Duplicate reject attempt'
  );
  const afterDuplicateReject = await walletService.ensureWallet(withdrawer._id);
  assert(afterDuplicateReject.availableBalanceCents === 5000, 'duplicate rejection does not refund twice');

  console.log('\n[7. Withdrawal approval and paid completion]');
  const approvedWithdrawal = await walletService.createWithdrawal(withdrawer._id.toString(), {
    amountCents: 3000,
    walletAddress: 'TWalletAddressPhase16Testing123456',
    network: 'USDT_TRC20',
    idempotencyKey: 'phase16-withdrawal-2'
  });
  const approved = await walletService.approveWithdrawal(
    admin._id.toString(),
    admin.email!,
    approvedWithdrawal._id.toString(),
    'Approved for test'
  );
  const afterApprove = await walletService.ensureWallet(withdrawer._id);
  assert(approved.status === 'APPROVED', 'withdrawal approved');
  assert(afterApprove.availableBalanceCents === 2000, 'approval keeps amount reserved');
  assert(afterApprove.reservedWithdrawalCents === 3000, 'approval does not refund');

  const paid = await walletService.markWithdrawalPaid(
    admin._id.toString(),
    admin.email!,
    approvedWithdrawal._id.toString(),
    '0xphase16txhash'
  );
  const afterPaid = await walletService.ensureWallet(withdrawer._id);
  assert(paid.status === 'PAID', 'withdrawal marked PAID');
  assert(afterPaid.availableBalanceCents === 2000, 'paid completion does not deduct available balance again');
  assert(afterPaid.reservedWithdrawalCents === 0, 'paid completion releases reserved balance');
  assert(afterPaid.totalWithdrawnCents === 3000, 'total withdrawn amount recorded');

  await walletService.markWithdrawalPaid(
    admin._id.toString(),
    admin.email!,
    approvedWithdrawal._id.toString(),
    '0xphase16txhash'
  );
  const afterDuplicatePaid = await walletService.ensureWallet(withdrawer._id);
  assert(afterDuplicatePaid.totalWithdrawnCents === 3000, 'duplicate paid completion does not double-count');

  console.log('\n[8. Concurrent withdrawals cannot overspend]');
  const concurrentUser = await createUser({ name: 'Concurrent User', email: 'concurrent.user@example.com' });
  await walletService.adjustBalance({
    userId: concurrentUser._id.toString(),
    direction: 'ADD',
    amountCents: 2500,
    reason: 'Concurrent funding',
    adminId: admin._id.toString(),
    adminEmail: admin.email!,
    idempotencyKey: 'phase16-concurrent-funding'
  });
  const results = await Promise.allSettled([
    walletService.createWithdrawal(concurrentUser._id.toString(), {
      amountCents: 2000,
      walletAddress: 'ConcurrentWalletAddressOne123',
      network: 'BTC',
      idempotencyKey: 'phase16-concurrent-1'
    }),
    walletService.createWithdrawal(concurrentUser._id.toString(), {
      amountCents: 2000,
      walletAddress: 'ConcurrentWalletAddressTwo456',
      network: 'BTC',
      idempotencyKey: 'phase16-concurrent-2'
    })
  ]);
  const concurrentWallet = await walletService.ensureWallet(concurrentUser._id);
  assert(
    results.filter((r) => r.status === 'fulfilled').length === 1,
    'only one concurrent withdrawal can reserve the available balance',
    results.map((r) => r.status)
  );
  assert(concurrentWallet.availableBalanceCents === 500, 'concurrent attempt cannot create negative balance');
  assert(concurrentWallet.reservedWithdrawalCents === 2000, 'exactly one withdrawal is reserved');

  console.log('\n[9. Manual adjustments and immutable ledger]');
  const adjustUser = await createUser({ name: 'Adjust User', email: 'adjust.user@example.com' });
  await walletService.adjustBalance({
    userId: adjustUser._id.toString(),
    direction: 'ADD',
    amountCents: 1000,
    reason: 'Promotional reward',
    adminId: admin._id.toString(),
    adminEmail: admin.email!,
    idempotencyKey: 'phase16-adjust-add'
  });
  await walletService.adjustBalance({
    userId: adjustUser._id.toString(),
    direction: 'DEDUCT',
    amountCents: 500,
    reason: 'Balance correction',
    adminId: admin._id.toString(),
    adminEmail: admin.email!,
    idempotencyKey: 'phase16-adjust-deduct'
  });
  const adjustWallet = await walletService.ensureWallet(adjustUser._id);
  const adjustTxs = await WalletTransactionModel.find({
    userId: adjustUser._id,
    type: { $in: ['MANUAL_BALANCE_ADD', 'MANUAL_BALANCE_DEDUCT'] }
  }).sort({ createdAt: 1 });

  assert(adjustWallet.availableBalanceCents === 500, 'manual add/deduct produces expected balance');
  assert(adjustTxs.length === 2, 'both manual adjustments have ledger records');
  assert(adjustTxs[0].newAvailableCents === 1000, 'addition ledger records new balance');
  assert(adjustTxs[1].previousAvailableCents === 1000, 'deduction ledger records previous balance');
  assert(adjustTxs[1].newAvailableCents === 500, 'deduction ledger records new balance');
  assert(adjustTxs[1].adminEmail === admin.email, 'manual adjustment records administrator');

  let overDeductRejected = false;
  try {
    await walletService.adjustBalance({
      userId: adjustUser._id.toString(),
      direction: 'DEDUCT',
      amountCents: 10000,
      reason: 'Over deduction attempt',
      adminId: admin._id.toString(),
      adminEmail: admin.email!,
      idempotencyKey: 'phase16-adjust-over'
    });
  } catch {
    overDeductRejected = true;
  }
  assert(overDeductRejected, 'wallet deduction cannot exceed available balance');
  assert((await walletService.ensureWallet(adjustUser._id)).availableBalanceCents === 500, 'failed deduction leaves balance unchanged');

  console.log('\n[10. Global policy settings]');
  const policy = await CommissionPolicyModel.getActivePolicy();
  assert(policy.normalUserRate === 0.3, 'default normal user policy is 30%');
  assert((policy.moderatorRate ?? policy.defaultRate) === 0.5, 'default moderator policy is 50%');
  assert(policy.referralEnabled !== false, 'referral program enabled by default');

  const updatedPolicy = await moderatorService.updateGlobalCommissionPolicy(
    admin._id.toString(),
    admin.email!,
    0.55,
    'Phase 16 policy update test',
    0.35,
    true
  );
  const policyAfter = await CommissionPolicyModel.getActivePolicy();
  assert(updatedPolicy.defaultRate === 0.55, 'admin can update moderator lifetime rate');
  assert(policyAfter.normalUserRate === 0.35, 'admin can update normal user one-time rate');
  assert(policyAfter.referralEnabled === true, 'admin can enable/disable referral program');

  console.log('\n=============================================');
  console.log(`  PHASE 16 RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=============================================\n');

  await mongoose.disconnect().catch(() => null);
  await mongod.stop().catch(() => null);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (error) => {
  console.error('Phase 16 crashed:', error);
  await mongoose.disconnect().catch(() => null);
  await mongod?.stop().catch(() => null);
  process.exit(1);
});
