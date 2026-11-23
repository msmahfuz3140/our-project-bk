import mongoose from 'mongoose';
import crypto from 'crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { authService } from '../services/auth.service';
import { paymentService } from '../services/payment.service';
import { walletService } from '../services/wallet.service';
import { adminService } from '../services/admin.service';
import { nowPaymentsService } from '../services/nowpayments.service';
import { transactionalEmailService } from '../services/transactionalEmail.service';
import { emailService } from '../services/email.service';
import { UserModel } from '../models/User';
import { PaymentModel } from '../models/Payment';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { WalletTransactionModel } from '../models/WalletTransaction';
import { WithdrawalRequestModel } from '../models/WithdrawalRequest';
import { EmailNotificationModel } from '../models/EmailNotification';
import { OtpVerificationModel } from '../models/OtpVerification';
import { OtpPurpose } from '../shared/auth';
import { UserRole } from '../shared/roles';
import { PaymentStatus } from '../shared/subscriptions';
import { hashPassword } from '../utils/crypto';
import { env } from '../config/env';
import { seedPlansIfEmpty } from '../models/Plan';
import { ensureMissingReferralCodes } from '../database/ensureIndexes';

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
  referralCode?: string;
  referredBy?: mongoose.Types.ObjectId;
  referralCommissionType?: 'ONE_TIME' | 'LIFETIME';
  referralEligible?: boolean;
}) {
  return UserModel.create({
    name: input.name,
    email: input.email,
    passwordHash: await hashPassword('WalletPass123!'),
    role: input.role || UserRole.USER,
    isEmailVerified: true,
    isActive: true,
    accountStatus: 'ACTIVE',
    referralCode:
      input.referralCode || `REF-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    referredBy: input.referredBy,
    referredAt: input.referredBy ? new Date() : undefined,
    referralCodeUsed: input.referredBy ? 'REF-TEST' : undefined,
    referralCommissionType: input.referralCommissionType,
    referralEligible: input.referralEligible !== false
  });
}

function ipnPayload(order: any, paymentId: string, status: string) {
  return {
    payment_id: Number(paymentId),
    payment_status: status,
    price_amount: order.priceUsd,
    price_currency: 'usd',
    pay_amount: order.priceUsd,
    actually_paid: order.priceUsd,
    pay_currency: order.payCurrency.toLowerCase(),
    order_id: order.orderId,
    payin_hash: `phase18_tx_${paymentId}_${status}`,
    updated_at: new Date().toISOString()
  };
}

async function processIpn(order: any, paymentId: string, status = 'finished') {
  const payload = ipnPayload(order, paymentId, status);
  const signature = nowPaymentsService.generateIpnSignature(payload, env.NOWPAYMENTS_IPN_SECRET);
  return paymentService.processIpnCallback(payload as any, signature);
}

async function registerAndVerify(input: {
  name: string;
  email: string;
  password: string;
  referralCode: string;
}) {
  const result = await authService.register(input);
  const otp = await OtpVerificationModel.findOne({
    target: input.email,
    purpose: OtpPurpose.REGISTRATION
  }).sort({ createdAt: -1 });
  const verified = await authService.verifyOtp({
    target: input.email,
    code: otp!.rawCodeDev!,
    purpose: OtpPurpose.REGISTRATION
  });
  return { registration: result, verification: verified, otp };
}

async function run() {
  console.log('\n=============================================');
  console.log('  PHASE 18 REFERRAL, OTP, EMAIL & PAYOUTS');
  console.log('=============================================\n');

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await seedPlansIfEmpty();

  const admin = await createUser({
    name: 'Phase 18 Admin',
    email: 'phase18.admin@example.com',
    role: UserRole.SUPER_ADMIN
  });

  const normalReferrer = await createUser({
    name: 'Phase 18 Normal Referrer',
    email: 'phase18.referrer@example.com',
    referralCode: 'PHASE18-REFERRER'
  });

  const moderator = await createUser({
    name: 'Phase 18 Lifetime Moderator',
    email: 'phase18.moderator@example.com',
    role: UserRole.MODERATOR,
    referralCode: 'PHASE18-MOD',
    referralCommissionType: 'LIFETIME'
  });

  console.log('\n[1. Mandatory referral validation before account creation]');
  let missingReferral = false;
  try {
    await authService.register({
      name: 'No Code',
      email: 'phase18.no-code@example.com',
      password: 'StrongPassword123!'
    } as any);
  } catch (error: any) {
    missingReferral = error?.code === 'REFERRAL_REQUIRED';
  }
  assert(missingReferral, 'registration without referral code is rejected');
  assert(
    (await UserModel.countDocuments({ email: 'phase18.no-code@example.com' })) === 0,
    'missing-code account is not created'
  );

  let invalidReferral = false;
  try {
    await authService.register({
      name: 'Bad Code',
      email: 'phase18.bad-code@example.com',
      password: 'StrongPassword123!',
      referralCode: 'NOT-A-REAL-CODE'
    });
  } catch (error: any) {
    invalidReferral = error?.code === 'INVALID_REFERRAL_CODE';
  }
  assert(invalidReferral, 'nonexistent referral code is rejected');
  assert(
    (await UserModel.countDocuments({ email: 'phase18.bad-code@example.com' })) === 0,
    'invalid-code account is not created'
  );

  const disabledReferrer = await createUser({
    name: 'Disabled Referrer',
    email: 'phase18.disabled@example.com',
    referralCode: 'PHASE18-DISABLED',
    referralEligible: false
  });
  let disabledRejected = false;
  try {
    await authService.register({
      name: 'Disabled Code Buyer',
      email: 'phase18.disabled-buyer@example.com',
      password: 'StrongPassword123!',
      referralCode: disabledReferrer.referralCode
    });
  } catch (error: any) {
    disabledRejected = error?.code === 'INVALID_REFERRAL_CODE';
  }
  assert(disabledRejected, 'disabled referral code is rejected');

  normalReferrer.phone = '+15550001111';
  await normalReferrer.save();
  let selfReferralRejected = false;
  try {
    await authService.register({
      name: 'Self Phone Attempt',
      email: 'phase18.self@example.com',
      phone: '+15550001111',
      password: 'StrongPassword123!',
      referralCode: normalReferrer.referralCode
    });
  } catch (error: any) {
    selfReferralRejected = error?.code === 'SELF_REFERRAL_NOT_ALLOWED';
  }
  assert(selfReferralRejected, 'self-referral using the referrer phone is rejected');

  console.log('\n[2. Valid registration, permanent attribution and OTP verification]');
  const buyerEmail = 'phase18.buyer@example.com';
  const registration = await authService.register({
    name: 'Phase 18 Buyer',
    email: buyerEmail,
    password: 'StrongPassword123!',
    referralCode: normalReferrer.referralCode
  });

  const registeredBuyer = await UserModel.findOne({ email: buyerEmail });
  assert(registration.requiresVerification === true, 'registration requires email verification');  assert(!registration.token, 'registration does not issue a session before verification');
  assert(registeredBuyer?.isEmailVerified === false, 'new user starts email-unverified');
  assert(registeredBuyer?.isActive === false, 'new user starts inactive');
  assert(
    registeredBuyer?.referredBy?.toString() === normalReferrer._id.toString(),
    'referrer database user id stored permanently'
  );
  assert(
    registeredBuyer?.referralCodeUsed === normalReferrer.referralCode,
    'submitted referral code stored on the account'
  );

  const adminReferrer = await createUser({
    name: 'Phase 18 Admin Referrer',
    email: 'phase18.admin-referrer@example.com',
    role: UserRole.SUPER_ADMIN,
    referralCode: 'PHASE18-ADMIN-REF'
  });
  const adminReferredRegistration = await authService.register({
    name: 'Phase 18 Admin Referred Buyer',
    email: 'phase18.admin-referred@example.com',
    password: 'StrongPassword123!',
    referralCode: adminReferrer.referralCode
  });
  const adminReferredUser = await UserModel.findOne({
    email: 'phase18.admin-referred@example.com'
  });
  assert(
    adminReferredUser?.referredBy?.toString() === adminReferrer._id.toString(),
    'a Main Admin referral code can be used to create an account'
  );
  assert(
    adminReferredRegistration.requiresVerification === true,
    'admin-referred registration still requires email verification'
  );

  const legacyAdminWithoutCode = await UserModel.create({
    name: 'Legacy Admin Without Code',
    email: 'phase18.legacy-admin@example.com',
    passwordHash: await hashPassword('AdminStrongPass123!'),
    role: UserRole.SUPER_ADMIN,
    isEmailVerified: true,
    isActive: true,
    accountStatus: 'ACTIVE'
  });
  await ensureMissingReferralCodes();
  const backfilledAdmin = await UserModel.findById(legacyAdminWithoutCode._id);
  assert(
    !!backfilledAdmin?.referralCode && backfilledAdmin.referralCode.startsWith('ADMIN-'),
    'older admin accounts without a referral code are safely backfilled'
  );

  // Immutable referral relationship check.
  const beforeReferrer = registeredBuyer!.referredBy!.toString();
  registeredBuyer!.referredBy = moderator._id;
  await registeredBuyer!.save().catch(() => null);
  const afterAttempt = await UserModel.findById(registeredBuyer!._id);
  assert(
    afterAttempt?.referredBy?.toString() === beforeReferrer,
    'referrer cannot be changed after registration'
  );

  let unverifiedLogin = false;
  try {
    await authService.login({ identifier: buyerEmail, password: 'StrongPassword123!' });
  } catch (error: any) {
    unverifiedLogin = error?.code === 'EMAIL_NOT_VERIFIED';
  }
  assert(unverifiedLogin, 'login is blocked before email verification');

  const otpRecord = await OtpVerificationModel.findOne({
    target: buyerEmail,
    purpose: OtpPurpose.REGISTRATION
  }).sort({ createdAt: -1 });
  assert(otpRecord !== null, 'registration OTP record created');
  assert(otpRecord?.rawCodeDev?.length === 6, 'test-mode OTP available only inside test database');
  assert(otpRecord?.expiresAt.getTime()! > Date.now(), 'registration OTP has a future expiration');

  const otpEmail = await EmailNotificationModel.findOne({
    idempotencyKey: `email:registration:${otpRecord?._id}`
  }).select('+htmlBody +textBody');
  assert(otpEmail?.status === 'SENT', 'verification email delivery is recorded as SENT');
  assert(!otpEmail?.htmlBody && !otpEmail?.textBody, 'verification email body/OTP is not persisted');
  assert(!otpEmail?.subject?.includes(otpRecord?.rawCodeDev || ''), 'email subject does not leak the OTP');

  const cooldownResend = await authService.resendOtp({
    target: buyerEmail,
    purpose: OtpPurpose.REGISTRATION
  });
  assert(
    cooldownResend.cooldownSeconds > 0 && cooldownResend.cooldownSeconds <= env.OTP_RESEND_COOLDOWN_SECONDS,
    'resend during cooldown returns a countdown'
  );

  let wrongOtpRejected = false;
  try {
    await authService.verifyOtp({
      target: buyerEmail,
      code: '000000',
      purpose: OtpPurpose.REGISTRATION
    });
  } catch (error: any) {
    wrongOtpRejected = error?.message?.includes('Incorrect verification code');
  }
  assert(wrongOtpRejected, 'incorrect OTP is rejected');

  const verified = await authService.verifyOtp({
    target: buyerEmail,
    code: otpRecord!.rawCodeDev!,
    purpose: OtpPurpose.REGISTRATION
  });
  const verifiedBuyer = await UserModel.findOne({ email: buyerEmail });
  assert(verified.requiresVerification === false, 'correct OTP completes verification');
  assert(!!verified.token, 'verification issues a session token');
  assert(verifiedBuyer?.isEmailVerified === true, 'email verified flag persisted');
  assert(!!verifiedBuyer?.emailVerifiedAt, 'email verification timestamp persisted');
  assert(verifiedBuyer?.isActive === true, 'account activated after email verification');

  let otpReuseRejected = false;
  try {
    await authService.verifyOtp({
      target: buyerEmail,
      code: otpRecord!.rawCodeDev!,
      purpose: OtpPurpose.REGISTRATION
    });
  } catch {
    otpReuseRejected = true;
  }
  assert(otpReuseRejected, 'used OTP cannot be reused');

  // Expired OTP rejection using an isolated target.
  const expiredHash = crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update('phase18.expired@example.com:111111')
    .digest('hex');
  await OtpVerificationModel.create({
    target: 'phase18.expired@example.com',
    codeHash: expiredHash,
    purpose: OtpPurpose.REGISTRATION,
    expiresAt: new Date(Date.now() - 60_000),
    lastSentAt: new Date(Date.now() - 120_000),
    isUsed: false,
    attempts: 0
  });
  let expiredRejected = false;
  try {
    await authService.verifyOtp({
      target: 'phase18.expired@example.com',
      code: '111111',
      purpose: OtpPurpose.REGISTRATION
    });
  } catch (error: any) {
    expiredRejected = error?.message?.includes('Invalid or expired');
  }
  assert(expiredRejected, 'expired OTP is rejected');

  const loginAfterVerify = await authService.login({
    identifier: buyerEmail,
    password: 'StrongPassword123!'
  });
  assert(loginAfterVerify.user.isEmailVerified === true, 'verified user can log in');

  console.log('\n[3. Commission: one-time, lifetime, pending/failed/expired]');
  const normalBuyer = await createUser({
    name: 'Phase 18 Normal Buyer',
    email: 'phase18.normal-buyer@example.com',
    referredBy: normalReferrer._id
  });
  const lifetimeBuyer = await createUser({
    name: 'Phase 18 Lifetime Buyer',
    email: 'phase18.lifetime-buyer@example.com',
    referredBy: moderator._id
  });

  const normalOrder1 = await paymentService.createPurchaseOrder(
    normalBuyer._id.toString(),
    'PLAN_15_DAYS',
    'TRX'
  );
  await processIpn(normalOrder1, '18001');
  const normalCommission1 = await ReferralCommissionModel.findOne({
    referredUserId: normalBuyer._id
  });
  assert(normalCommission1?.commissionType === 'ONE_TIME', 'normal purchase creates ONE_TIME commission');
  assert(normalCommission1?.commissionRate === 0.3, 'normal commission rate is 30%');
  assert(normalCommission1?.amountUsd === 45, 'normal commission is exactly $45.00');
  assert(normalCommission1?.status === 'CREDITED', 'normal commission is credited');
  assert(
    normalCommission1?.moderatorId.toString() === normalReferrer._id.toString(),
    'commission is credited to the correct referrer'
  );
  const normalWallet1 = await walletService.ensureWallet(normalReferrer._id);
  assert(normalWallet1.availableBalanceCents === 4500, 'referrer wallet receives 4500 cents');
  const commissionWalletTx = await WalletTransactionModel.findOne({
    idempotencyKey: `commission-wallet:${normalCommission1?._id}`
  });
  assert(
    commissionWalletTx?.userId.toString() === normalReferrer._id.toString() &&
      commissionWalletTx?.amountCents === 4500,
    'wallet ledger entry matches the commission and referrer'
  );

  const successEmail = await EmailNotificationModel.findOne({
    idempotencyKey: `payment-success:${normalOrder1.orderId}`
  });
  assert(successEmail?.status === 'SENT', 'verified payment queues one success email');
  assert(successEmail?.templateKey === 'PAYMENT_SUCCESS', 'success email uses the payment template');

  const normalOrder2 = await paymentService.createPurchaseOrder(
    normalBuyer._id.toString(),
    'PLAN_1_MONTH',
    'TRX'
  );
  await processIpn(normalOrder2, '18002');
  const normalCommissionCount = await ReferralCommissionModel.countDocuments({
    referredUserId: normalBuyer._id
  });
  const normalWallet2 = await walletService.ensureWallet(normalReferrer._id);
  assert(normalCommissionCount === 1, 'second purchase creates no second one-time commission');
  assert(normalWallet2.availableBalanceCents === 4500, 'second purchase does not credit the one-time referrer again');

  const lifetimeOrder1 = await paymentService.createPurchaseOrder(
    lifetimeBuyer._id.toString(),
    'PLAN_15_DAYS',
    'TRX'
  );
  await processIpn(lifetimeOrder1, '18003');
  const lifetimeOrder2 = await paymentService.createPurchaseOrder(
    lifetimeBuyer._id.toString(),
    'PLAN_1_MONTH',
    'TRX'
  );
  await processIpn(lifetimeOrder2, '18004');
  const lifetimeCommissions = await ReferralCommissionModel.find({
    referredUserId: lifetimeBuyer._id
  });
  const moderatorWallet = await walletService.ensureWallet(moderator._id);
  assert(lifetimeCommissions.length === 2, 'lifetime referrer receives commission on every purchase');
  assert(
    lifetimeCommissions.every((c) => c.commissionType === 'LIFETIME' && c.commissionRate === 0.5),
    'lifetime commissions use the 50% policy'
  );
  assert(moderatorWallet.availableBalanceCents === 17500, 'lifetime wallet total is $175.00');

  // Pending / failed / expired payments must never create commissions.
  const pendingOrder = await paymentService.createPurchaseOrder(
    normalBuyer._id.toString(),
    'PLAN_3_MONTHS',
    'TRX'
  );
  await processIpn(pendingOrder, '18005', 'waiting');
  await processIpn(pendingOrder, '18005', 'confirmed');
  await processIpn(pendingOrder, '18005', 'failed');
  const pendingPayment = await PaymentModel.findOne({ orderId: pendingOrder.orderId });
  assert(pendingPayment?.status === PaymentStatus.FAILED, 'failed payment stores FAILED status');
  assert(
    (await ReferralCommissionModel.countDocuments({ paymentId: pendingPayment?._id })) === 0,
    'failed payment creates no commission'
  );

  const expiredOrder = await paymentService.createPurchaseOrder(
    normalBuyer._id.toString(),
    'PLAN_6_MONTHS',
    'TRX'
  );
  await processIpn(expiredOrder, '18006', 'expired');
  const expiredPayment = await PaymentModel.findOne({ orderId: expiredOrder.orderId });
  assert(expiredPayment?.status === PaymentStatus.EXPIRED, 'expired payment stores EXPIRED status');
  assert(
    (await ReferralCommissionModel.countDocuments({ paymentId: expiredPayment?._id })) === 0,
    'expired payment creates no commission'
  );

  // Duplicate finished webhook must not duplicate commission or email.
  const duplicateOrder = await paymentService.createPurchaseOrder(
    lifetimeBuyer._id.toString(),
    'PLAN_15_DAYS',
    'TRX'
  );
  const duplicatePayload = ipnPayload(duplicateOrder, '18007', 'finished');
  const duplicateSig = nowPaymentsService.generateIpnSignature(duplicatePayload, env.NOWPAYMENTS_IPN_SECRET);
  await paymentService.processIpnCallback(duplicatePayload as any, duplicateSig);
  await paymentService.processIpnCallback(duplicatePayload as any, duplicateSig);
  const duplicatePayment = await PaymentModel.findOne({ orderId: duplicateOrder.orderId });
  assert(
    (await ReferralCommissionModel.countDocuments({ paymentId: duplicatePayment?._id })) === 1,
    'duplicate webhook creates exactly one commission'
  );
  assert(
    (await EmailNotificationModel.countDocuments({
      idempotencyKey: `payment-success:${duplicateOrder.orderId}`
    })) === 1,
    'duplicate webhook creates exactly one payment success email'
  );

  console.log('\n[3b. Commission wallet-credit recovery is idempotent]');
  const recoveryBuyer = await createUser({
    name: 'Phase 18 Recovery Buyer',
    email: 'phase18.recovery-buyer@example.com',
    referredBy: normalReferrer._id
  });
  const recoveryOrder = await paymentService.createPurchaseOrder(
    recoveryBuyer._id.toString(),
    'PLAN_15_DAYS',
    'TRX'
  );

  const originalWalletCredit = walletService.credit.bind(walletService);
  (walletService as any).credit = async () => {
    throw new Error('Simulated wallet outage');
  };
  try {
    await processIpn(recoveryOrder, '18008');
  } finally {
    (walletService as any).credit = originalWalletCredit;
  }

  const recoveryPayment = await PaymentModel.findOne({ orderId: recoveryOrder.orderId });
  const pendingCommission = await ReferralCommissionModel.findOne({
    paymentId: recoveryPayment?._id
  });
  assert(pendingCommission?.status === 'PENDING', 'wallet outage leaves the commission pending, not lost');

  // A changed duplicate event is processed through the already-fulfilled path,
  // which performs idempotent commission recovery.
  const recoveryRetryPayload = {
    ...ipnPayload(recoveryOrder, '18008', 'finished'),
    updated_at: new Date(Date.now() + 5_000).toISOString()
  };
  const recoveryRetrySig = nowPaymentsService.generateIpnSignature(
    recoveryRetryPayload,
    env.NOWPAYMENTS_IPN_SECRET
  );
  await paymentService.processIpnCallback(recoveryRetryPayload as any, recoveryRetrySig);

  const recoveredCommission = await ReferralCommissionModel.findById(pendingCommission?._id);
  const recoveredWallet = await walletService.ensureWallet(normalReferrer._id);
  assert(recoveredCommission?.status === 'CREDITED', 'duplicate webhook recovers a pending commission');
  assert(
    (await ReferralCommissionModel.countDocuments({ referredUserId: recoveryBuyer._id })) === 1,
    'recovery never creates a second one-time commission'
  );
  assert(
    recoveredWallet.availableBalanceCents === 9000,
    'wallet is credited exactly once after recovery',
    recoveredWallet.availableBalanceCents
  );

  console.log('\n[4. Account ban/suspension notification idempotency]');
  const banTarget = await createUser({
    name: 'Phase 18 Ban Target',
    email: 'phase18.ban-target@example.com'
  });
  await adminService.changeUserStatus(
    admin._id.toString(),
    admin.email!,
    banTarget._id.toString(),
    'BLOCK',
    'Phase 18 policy violation'
  );
  const banEmail = await EmailNotificationModel.findOne({
    templateKey: 'ACCOUNT_BANNED',
    userId: banTarget._id
  });
  assert(banEmail?.status === 'SENT', 'admin ban queues a banned-account email');
  const banEmailBody = await EmailNotificationModel.findById(banEmail?._id).select('+textBody');
  assert(
    banEmailBody?.textBody?.includes('Phase 18 policy violation'),
    'ban email includes the admin-provided reason'
  );

  await adminService.changeUserStatus(
    admin._id.toString(),
    admin.email!,
    banTarget._id.toString(),
    'BLOCK',
    'Phase 18 policy violation'
  );
  assert(
    (await EmailNotificationModel.countDocuments({ templateKey: 'ACCOUNT_BANNED', userId: banTarget._id })) === 1,
    'repeated ban action does not send a duplicate email'
  );

  await adminService.changeUserStatus(
    admin._id.toString(),
    admin.email!,
    banTarget._id.toString(),
    'UNBLOCK',
    'Appeal accepted'
  );
  assert(
    (await EmailNotificationModel.countDocuments({ templateKey: 'ACCOUNT_RESTORED', userId: banTarget._id })) === 1,
    'unban sends one account-restored email'
  );

  console.log('\n[5. Withdrawal crypto methods, emails and refunds]');
  const withdrawalUser = await createUser({
    name: 'Phase 18 Withdrawal User',
    email: 'phase18.withdrawal@example.com'
  });
  await walletService.adjustBalance({
    userId: withdrawalUser._id.toString(),
    direction: 'ADD',
    amountCents: 20000,
    reason: 'Phase 18 withdrawal funding',
    adminId: admin._id.toString(),
    adminEmail: admin.email!,
    idempotencyKey: 'phase18-fund-withdrawal-user'
  });

  let unsupportedMethodRejected = false;
  try {
    await walletService.createWithdrawal(withdrawalUser._id.toString(), {
      amountCents: 1000,
      methodId: 'DOGE_UNSUPPORTED',
      walletAddress: 'DUnsUpportedAddress123456789',
      idempotencyKey: 'phase18-bad-method'
    });
  } catch (error: any) {
    unsupportedMethodRejected = error?.code === 'UNSUPPORTED_WITHDRAWAL_METHOD';
  }
  assert(unsupportedMethodRejected, 'unsupported payout currency/network is rejected');

  let invalidAddressRejected = false;
  try {
    await walletService.createWithdrawal(withdrawalUser._id.toString(), {
      amountCents: 1000,
      methodId: 'USDT_TRC20',
      walletAddress: '0xThisIsAnEthereumAddressNotTron1234567890',
      idempotencyKey: 'phase18-bad-address'
    });
  } catch (error: any) {
    invalidAddressRejected = error?.code === 'INVALID_WITHDRAWAL_ADDRESS';
  }
  assert(invalidAddressRejected, 'address format is validated against the selected network');

  const tronAddress = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
  const withdrawal = await walletService.createWithdrawal(withdrawalUser._id.toString(), {
    amountCents: 5000,
    methodId: 'USDT_TRC20',
    walletAddress: tronAddress,
    idempotencyKey: 'phase18-withdrawal-1'
  });
  const afterReserve = await walletService.ensureWallet(withdrawalUser._id);
  assert(withdrawal.status === 'PENDING', 'valid withdrawal is created PENDING');
  assert(withdrawal.withdrawalCurrency === 'USDT', 'selected cryptocurrency stored');
  assert(withdrawal.networkId === 'USDT_TRC20', 'selected network id stored');
  assert(withdrawal.network.includes('TRC20'), 'network display label stored');
  assert(afterReserve.availableBalanceCents === 15000, 'amount reserved from available balance');
  assert(afterReserve.reservedWithdrawalCents === 5000, 'reserved amount recorded');

  const submittedEmail = await EmailNotificationModel.findOne({
    idempotencyKey: `withdrawal-submitted:${withdrawal._id}`
  }).select('+textBody');
  assert(submittedEmail?.status === 'SENT', 'withdrawal submission email is sent');
  assert(
    submittedEmail?.textBody?.includes(withdrawal.requestId),
    'submission email includes the request reference'
  );
  assert(
    !submittedEmail?.textBody?.includes(tronAddress) &&
      submittedEmail?.textBody?.includes('TXYZop…AeBf'),
    'submission email masks the destination address'
  );

  await walletService.approveWithdrawal(
    admin._id.toString(),
    admin.email!,
    withdrawal._id.toString(),
    'Phase 18 approval'
  );
  const afterApprove = await walletService.ensureWallet(withdrawalUser._id);
  assert(afterApprove.reservedWithdrawalCents === 5000, 'approval keeps the amount reserved');
  assert(
    (await EmailNotificationModel.countDocuments({
      idempotencyKey: `withdrawal-approved:${withdrawal._id}`
    })) === 1,
    'approval sends one approved email'
  );

  await walletService.rejectWithdrawal(
    admin._id.toString(),
    admin.email!,
    withdrawal._id.toString(),
    'Phase 18 rejection reason'
  );
  const afterReject = await walletService.ensureWallet(withdrawalUser._id);
  assert(afterReject.availableBalanceCents === 20000, 'rejection refunds the exact reserved amount');
  assert(afterReject.reservedWithdrawalCents === 0, 'rejection clears the reservation');
  const rejectedEmail = await EmailNotificationModel.findOne({
    idempotencyKey: `withdrawal-rejected:${withdrawal._id}`
  }).select('+textBody');
  assert(rejectedEmail?.status === 'SENT', 'rejection email is sent');
  assert(rejectedEmail?.textBody?.includes('Phase 18 rejection reason'), 'rejection email includes the reason');

  await walletService.rejectWithdrawal(
    admin._id.toString(),
    admin.email!,
    withdrawal._id.toString(),
    'Duplicate rejection attempt'
  );
  const afterDuplicateReject = await walletService.ensureWallet(withdrawalUser._id);
  assert(afterDuplicateReject.availableBalanceCents === 20000, 'duplicate rejection does not refund twice');

  const paidWithdrawal = await walletService.createWithdrawal(withdrawalUser._id.toString(), {
    amountCents: 4000,
    methodId: 'USDT_TRC20',
    walletAddress: tronAddress,
    idempotencyKey: 'phase18-withdrawal-2'
  });
  await walletService.approveWithdrawal(
    admin._id.toString(),
    admin.email!,
    paidWithdrawal._id.toString(),
    'Ready to pay'
  );

  let shortHashRejected = false;
  try {
    await walletService.markWithdrawalPaid(
      admin._id.toString(),
      admin.email!,
      paidWithdrawal._id.toString(),
      'abc'
    );
  } catch (error: any) {
    shortHashRejected = error?.statusCode === 400 || error?.code === 'BAD_REQUEST';
  }
  assert(shortHashRejected, 'marking paid requires a real transaction hash/reference');

  await walletService.markWithdrawalPaid(
    admin._id.toString(),
    admin.email!,
    paidWithdrawal._id.toString(),
    '0xphase18paidtransactionhash'
  );
  const afterPaid = await walletService.ensureWallet(withdrawalUser._id);
  assert(afterPaid.reservedWithdrawalCents === 0, 'paid withdrawal releases the reservation');
  assert(afterPaid.totalWithdrawnCents === 4000, 'paid withdrawal records the withdrawn total');
  const paidEmail = await EmailNotificationModel.findOne({
    idempotencyKey: `withdrawal-paid:${paidWithdrawal._id}`
  }).select('+textBody');
  assert(paidEmail?.status === 'SENT', 'paid withdrawal sends a completion email');
  assert(
    paidEmail?.textBody?.includes('0xphase18paidtransactionhash'),
    'completion email includes the transaction hash'
  );

  await walletService.markWithdrawalPaid(
    admin._id.toString(),
    admin.email!,
    paidWithdrawal._id.toString(),
    '0xphase18paidtransactionhash'
  );
  const afterDuplicatePaid = await walletService.ensureWallet(withdrawalUser._id);
  assert(afterDuplicatePaid.totalWithdrawnCents === 4000, 'duplicate paid completion cannot double-count');

  console.log('\n[6. SMTP failure does not corrupt withdrawal state and can be retried]');
  const originalSendEmail = emailService.sendEmail.bind(emailService);
  (emailService as any).sendEmail = async () => false;

  const failureWithdrawal = await walletService.createWithdrawal(withdrawalUser._id.toString(), {
    amountCents: 1000,
    methodId: 'USDT_TRC20',
    walletAddress: tronAddress,
    idempotencyKey: 'phase18-withdrawal-email-failure'
  });
  const afterFailureReserve = await walletService.ensureWallet(withdrawalUser._id);
  const failedEmail = await EmailNotificationModel.findOne({
    idempotencyKey: `withdrawal-submitted:${failureWithdrawal._id}`
  });
  assert(failureWithdrawal.status === 'PENDING', 'withdrawal remains PENDING when email fails');
  assert(afterFailureReserve.reservedWithdrawalCents === 1000, 'wallet reservation survives email failure');
  assert(
    failedEmail?.status === 'PENDING' || failedEmail?.status === 'FAILED',
    'failed delivery is recorded for retry',
    failedEmail?.status
  );

  (emailService as any).sendEmail = originalSendEmail;
  const retryResult = await transactionalEmailService.retryById(failedEmail!._id.toString(), {
    id: admin._id.toString(),
    email: admin.email!
  });
  assert(retryResult.status === 'SENT', 'admin retry delivers the stored business email');

  console.log('\n[7. Admin delivery telemetry and final ledger consistency]');
  const metrics = await transactionalEmailService.getMetrics();
  assert(metrics.sent >= 5, 'delivery metrics count sent transactional emails', metrics);
  assert(metrics.failed >= 0 && metrics.pending >= 0, 'delivery metrics expose pending/failed counts');
  const adminList = await transactionalEmailService.listForAdmin({ page: 1, limit: 50 });
  assert(adminList.total >= 5, 'admin can list transactional email delivery records');
  assert(
    adminList.notifications.every((item: any) => item.htmlBody === undefined && item.textBody === undefined),
    'admin listing never exposes email bodies or OTP contents'
  );

  const finalWallet = await walletService.ensureWallet(withdrawalUser._id);
  const reserveTransactions = await WalletTransactionModel.countDocuments({
    userId: withdrawalUser._id,
    type: 'WITHDRAWAL_RESERVE'
  });
  assert(
    reserveTransactions === 3,
    'each withdrawal request has exactly one reservation ledger entry',
    reserveTransactions
  );
  assert(finalWallet.availableBalanceCents >= 0, 'wallet balance never becomes negative');

  const referralTarget = await UserModel.findById(registeredBuyer!._id);
  assert(
    referralTarget?.referredBy?.toString() === normalReferrer._id.toString(),
    'referral relationship remains permanent after all financial activity'
  );

  console.log('\n=============================================');
  console.log(`  PHASE 18 RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=============================================\n');

  await mongoose.disconnect().catch(() => null);
  await mongod.stop().catch(() => null);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (error) => {
  console.error('Phase 18 crashed:', error);
  await mongoose.disconnect().catch(() => null);
  await mongod?.stop().catch(() => null);
  process.exit(1);
});
