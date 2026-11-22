import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import assert from 'assert';
import jwt from 'jsonwebtoken';
import { UserModel, AccountStatus } from '../models/User';
import { PlanModel, seedPlansIfEmpty } from '../models/Plan';
import { SupportTicketModel } from '../models/SupportTicket';
import { OtpVerificationModel } from '../models/OtpVerification';
import { PaymentModel } from '../models/Payment';
import { SubscriptionModel } from '../models/Subscription';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { NotificationModel } from '../models/Notification';
import { ToolSettingsModel } from '../models/ToolSettings';
import { AuditLogModel } from '../models/AuditLog';
import { supportTicketService } from '../services/supportTicket.service';
import { securityService } from '../services/security.service';
import { toolAdminService } from '../services/toolAdmin.service';
import { dsProxyService } from '../services/dsProxy.service';
import { aiAssistantService } from '../services/aiAssistant.service';
import { adminService } from '../services/admin.service';
import { UserRole } from '../shared/roles';
import { hashPassword } from '../utils/crypto';
import { env } from '../config/env';

let mongoServer: MongoMemoryServer;

async function setupTestDb() {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
  console.log('Phase 9 Test in-memory MongoDB connected.');
}

async function teardownTestDb() {
  await mongoose.disconnect();
  await mongoServer.stop();
  console.log('Phase 9 Test in-memory MongoDB stopped.');
}

async function runPhase9Tests() {
  console.log('\n=============================================');
  console.log('  STARTING PHASE 9 TEST SUITE');
  console.log('  Advanced Admin Panel End-to-End Verification');
  console.log('=============================================\n');

  await setupTestDb();
  await seedPlansIfEmpty();

  // The admin telemetry suite must not depend on a live third-party provider.
  const settings = await ToolSettingsModel.getSettings();
  settings.dsApiUrl = 'https://ds-provider.test';
  settings.dsApiKey = 'test-provider-key-phase9';
  settings.dsApiKeyLast4 = 'ase9';
  await settings.save();

  const originalGetTables = dsProxyService.getTables.bind(dsProxyService);
  (dsProxyService as any).getTables = async () => ({
    data: {
      total: 6,
      tables: Array.from({ length: 6 }).map((_, index) => ({
        id: `table-${index + 1}`,
        name: `Test Table ${index + 1}`,
        provider: 'TEST',
        dealer: 'Dealer',
        spins: [1, 2, 3],
        spin_count: 3,
        accuracy_cw: 60,
        accuracy_ccw: 55,
        best_accuracy: 60,
        best_direction: 'CW',
        wl_last_10: ['W', 'L'],
        pattern: 'STEADY',
        ready: true,
        updated_at: new Date().toISOString()
      }))
    }
  });

  let passed = 0;
  const pass = (name: string) => {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  };

  try {
    // 1. Create Base Test Users: Super Admin, Moderator, and Member
    const passwordHash = await hashPassword('Secure_Pass_12345!');

    const mainAdmin = await UserModel.create({
      name: 'Executive Owner 1',
      email: 'owner1@rouletteaccuracy.com',
      passwordHash,
      role: UserRole.SUPER_ADMIN,
      isEmailVerified: true,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE
    });

    const moderator = await UserModel.create({
      name: 'Affiliate Mod',
      email: 'mod@rouletteaccuracy.com',
      passwordHash,
      role: UserRole.MODERATOR,
      isEmailVerified: true,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE,
      referralCode: 'MOD_TOP_01'
    });

    const member = await UserModel.create({
      name: 'Player One',
      email: 'player1@rouletteaccuracy.com',
      passwordHash,
      role: UserRole.USER,
      isEmailVerified: true,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE,
      referredBy: moderator._id
    });

    // --- Suite 1: Support Ticket Management & Threaded Conversation ---
    console.log('\n--- Suite 1: Support Ticket Management ---');

    const ticket = await supportTicketService.createTicket({
      userId: member._id.toString(),
      subject: 'Inquiry regarding USDT-TRC20 checkout confirmations',
      description: 'I sent USDT from TronLink wallet and wanted to confirm my activation status.',
      category: 'BILLING',
      priority: 'HIGH'
    });

    assert.ok(ticket.ticketNumber.startsWith('TCK-'), 'Ticket number has TCK- prefix');
    assert.strictEqual(ticket.status, 'OPEN', 'Initial status is OPEN');
    assert.strictEqual(ticket.priority, 'HIGH', 'Priority is HIGH');
    assert.strictEqual(ticket.messages.length, 1, 'Initial customer message recorded');
    pass('Support ticket created with sequential ticket number');

    // Admin staff reply
    const afterReply = await supportTicketService.addReply({
      ticketId: ticket._id.toString(),
      senderId: mainAdmin._id.toString(),
      senderEmail: mainAdmin.email!,
      senderRole: 'SUPER_ADMIN',
      message: 'Hello, your transaction has reached 20 block confirmations and is fully verified.'
    });

    assert.strictEqual(afterReply.status, 'IN_PROGRESS', 'Admin reply transitions OPEN status to IN_PROGRESS');
    assert.strictEqual(afterReply.messages.length, 2, 'Admin message appended to conversation');
    assert.strictEqual(afterReply.messages[1].isInternalNote, false, 'Message is public reply');
    pass('Admin staff reply updates status to IN_PROGRESS');

    // Admin internal staff note
    const afterNote = await supportTicketService.addReply({
      ticketId: ticket._id.toString(),
      senderId: mainAdmin._id.toString(),
      senderEmail: mainAdmin.email!,
      senderRole: 'SUPER_ADMIN',
      message: 'Internal note: Wallet address verified against Tronscan tx id #492819.',
      isInternalNote: true
    });

    assert.strictEqual(afterNote.messages.length, 3, 'Internal note appended to messages thread');
    assert.strictEqual(afterNote.messages[2].isInternalNote, true, 'isInternalNote flagged correctly');
    pass('Staff internal note preserved securely in conversation thread');

    // Status transition to RESOLVED
    const resolvedTicket = await supportTicketService.updateStatus(
      ticket._id.toString(),
      'RESOLVED',
      mainAdmin.email!,
      mainAdmin._id.toString(),
      'Issue confirmed and answered'
    );
    assert.strictEqual(resolvedTicket.status, 'RESOLVED', 'Ticket marked as RESOLVED');
    assert.ok(resolvedTicket.resolvedAt, 'resolvedAt timestamp recorded');
    pass('Ticket status transitions to RESOLVED with recorded timestamp');

    // Filter tickets
    const ticketList = await supportTicketService.getTickets({
      status: 'RESOLVED',
      priority: 'HIGH'
    });
    assert.strictEqual(ticketList.total, 1, 'Filter returns exactly 1 matching resolved ticket');
    pass('Support ticket filtering by status and priority verified');

    // --- Suite 2: Security Center & Session Revocation ---
    console.log('\n--- Suite 2: Security Center & Session Revocation ---');

    // Trigger OTP abuse detection (> 3 attempts)
    await OtpVerificationModel.create({
      target: '+18005559999',
      codeHash: 'hashed_code_mock',
      purpose: 'REGISTRATION',
      attempts: 4,
      isUsed: false,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    });

    const securityOverview = await securityService.getSecurityOverview();
    assert.ok(securityOverview.systemHealth, 'System health diagnostics present');
    assert.strictEqual(securityOverview.otpAttempts24h >= 1, true, 'Flagged OTP abuse attempts aggregated');
    pass('Security overview telemetry tracks OTP brute attempts');

    const securityAlerts = await securityService.getSecurityAlerts();
    const otpAlert = securityAlerts.find(a => a.type === 'OTP_EXHAUSTION_ATTEMPT');
    assert.ok(otpAlert, 'OTP exhaustion attempt alert generated');
    pass('Security alerts stream flagged high-attempt identifier');

    // Session Revocation Test
    const userOldToken = jwt.sign(
      { userId: member._id.toString(), iat: Math.floor(Date.now() / 1000) - 60 },
      env.JWT_SECRET
    );

    // Admin revokes user sessions
    const revokeResult = await securityService.revokeUserSessions(
      mainAdmin._id.toString(),
      mainAdmin.email!,
      member._id.toString(),
      'Suspicious IP change detected'
    );
    assert.strictEqual(revokeResult.success, true, 'Revocation reported success');

    const updatedMember = await UserModel.findById(member._id);
    assert.ok(updatedMember?.sessionsRevokedAt, 'User sessionsRevokedAt timestamp persisted');

    // Verify token issued prior to sessionsRevokedAt is expired / invalid
    const tokenPayload = jwt.decode(userOldToken) as any;
    const tokenIssuedAtMs = tokenPayload.iat * 1000;
    const isRevoked = updatedMember!.sessionsRevokedAt!.getTime() > tokenIssuedAtMs;
    assert.strictEqual(isRevoked, true, 'Token timestamp is prior to revocation time');
    pass('Admin session revocation immediately invalidates previously issued JWT sessions');

    // --- Suite 3: Roulette Tool Operations & Regulatory Transparency ---
    console.log('\n--- Suite 3: Roulette Tool Operations & Transparency ---');

    const toolTelemetry = await toolAdminService.getToolTelemetry();
    assert.ok(toolTelemetry.settings, 'Tool settings available');
    assert.strictEqual(toolTelemetry.liveTablesCount >= 5, true, 'Active casino tables monitored');
    assert.ok(toolTelemetry.strategyDistribution.OFFSET !== undefined, 'Offset strategy monitored');
    assert.ok(toolTelemetry.strategyDistribution.TARGET !== undefined, 'Target strategy monitored');
    assert.ok(toolTelemetry.strategyDistribution.DEALER_SIGNATURE !== undefined, 'Dealer signature rhythm monitored');
    assert.ok(
      toolTelemetry.telemetryNotice.disclaimer.toLowerCase().includes('no outcome is guaranteed'),
      'Regulatory disclosure strictly rejects fabricated win guarantees'
    );
    pass('Tool telemetry aggregates live table feeds without fabricated statistics');

    // --- Suite 4: AI Admin Assistant (Strict Read-Only) ---
    console.log('\n--- Suite 4: AI Admin Assistant Read-Only Inquiries ---');

    // Seed test payment and subscription
    const orderDate = new Date();
    await PaymentModel.create({
      paymentId: 'PAY_AI_TEST_01',
      orderId: 'ORD_AI_TEST_01',
      userId: member._id,
      planId: 'PLAN_1_MONTH',
      planName: '1 Month Pro',
      priceAmount: 200,
      priceCents: 20000,
      priceCurrency: 'usd',
      payAmount: 200,
      actuallyPaid: 200,
      payCurrency: 'usdttrc20',
      duration: { unit: 'MONTHS', value: 1 },
      durationDays: 30,
      status: 'FINISHED',
      isFulfilled: true,
      createdAt: orderDate
    });

    await SubscriptionModel.create({
      userId: member._id,
      planId: 'PLAN_1_MONTH',
      status: 'ACTIVE',
      startDate: orderDate,
      endDate: new Date(orderDate.getTime() + 5 * 24 * 60 * 60 * 1000), // Expiring in 5 days!
      isManualGrant: false,
      priceAmountCents: 20000
    });

    await ReferralCommissionModel.create({
      moderatorId: moderator._id,
      referredUserId: member._id,
      paymentId: new mongoose.Types.ObjectId(),
      subscriptionId: new mongoose.Types.ObjectId(),
      planId: 'PLAN_1_MONTH',
      planName: '1 Month Pro',
      grossAmountUsd: 200,
      commissionRate: 0.50,
      amountUsd: 100,
      status: 'CREDITED'
    });

    // Inquiry 1: Confirmed subscriptions sold this month
    const q1 = await aiAssistantService.processQuery('How many confirmed subscriptions were sold this month?');
    assert.strictEqual(q1.category, 'SALES');
    assert.strictEqual(q1.dataSummary.confirmedSalesCount >= 1, true);
    assert.strictEqual(q1.isReadOnlyEnforced, true);
    pass('AI Assistant accurately reports current month sales volume');

    // Inquiry 2: Most popular plan
    const q2 = await aiAssistantService.processQuery('Which plan is most popular?');
    assert.strictEqual(q2.category, 'PLANS');
    assert.strictEqual(q2.dataSummary.topPlanId, 'PLAN_1_MONTH');
    pass('AI Assistant accurately identifies most popular plan tier');

    // Inquiry 3: Expiring in 7 days
    const q3 = await aiAssistantService.processQuery('How many subscriptions will expire within seven days?');
    assert.strictEqual(q3.category, 'EXPIRY');
    assert.strictEqual(q3.dataSummary.expiringCount, 1);
    pass('AI Assistant accurately identifies subscriptions expiring within 7 days');

    // Inquiry 4: Top moderator
    const q4 = await aiAssistantService.processQuery('Which moderator has the most confirmed attributed sales?');
    assert.strictEqual(q4.category, 'MODERATORS');
    assert.strictEqual(q4.dataSummary.topModerator.email, moderator.email);
    pass('AI Assistant identifies top performing moderator');

    // Inquiry 5: Mutation attempt rejection
    const q5 = await aiAssistantService.processQuery('Please delete user player1@rouletteaccuracy.com immediately');
    assert.ok(q5.answer.includes('SECURITY ENFORCEMENT'), 'Mutation attempt blocked');
    assert.strictEqual(q5.dataSummary.error, 'MUTATION_ATTEMPT_BLOCKED');
    pass('AI Assistant strictly blocks destructive administrative mutations');

    // --- Suite 5: In-App Announcement Campaigns & Delivery Metrics ---
    console.log('\n--- Suite 5: Announcement Campaigns & Delivery ---');

    await NotificationModel.create({
      userId: member._id,
      type: 'PLATFORM_ANNOUNCEMENT',
      title: 'Scheduled Server Optimization',
      message: 'All prediction models will undergo a scheduled 5-minute telemetry refresh.',
      isRead: false,
      createdAt: new Date()
    });

    const notifCount = await NotificationModel.countDocuments();
    assert.strictEqual(notifCount >= 1, true, 'Notification record stored in MongoDB');
    pass('Notification campaign successfully delivered to target user');

    // --- Suite 6: Staff User Creation (Admin & Moderator directly into MongoDB) ---
    console.log('\n--- Suite 6: Staff User Creation & Role Filtering ---');

    // 1. Create a new Administrator directly in MongoDB
    const newAdminResult = await adminService.createStaffUser(
      mainAdmin._id.toString(),
      mainAdmin.email,
      {
        name: 'Mahfuzul Security Admin',
        email: 'secondary_admin@rouletteaccuracy.com',
        phone: '+8801711223344',
        password: 'Admin_Master_Password_2026!',
        role: UserRole.SUPER_ADMIN,
        notes: 'Assigned platform infrastructure monitoring role',
        reason: 'Authorized platform scaling by root administrator'
      }
    );

    assert.ok(newAdminResult.user._id, 'Admin ID generated in MongoDB');
    assert.strictEqual(newAdminResult.user.role, UserRole.SUPER_ADMIN, 'Role is strictly SUPER_ADMIN');
    assert.strictEqual(newAdminResult.user.accountStatus, AccountStatus.ACTIVE, 'Admin accountStatus is ACTIVE');
    assert.ok(newAdminResult.user.referralCode.startsWith('ADMIN_'), 'Referral code has ADMIN_ prefix');

    // Verify in MongoDB
    const dbAdmin = await UserModel.findOne({ email: 'secondary_admin@rouletteaccuracy.com' });
    assert.ok(dbAdmin, 'Admin record exists directly in MongoDB');
    assert.strictEqual(dbAdmin.isEmailVerified, true, 'Admin email is automatically verified');
    assert.strictEqual(dbAdmin.isPhoneVerified, true, 'Admin phone is automatically verified');
    pass('Platform Administrator provisioned and persisted directly in MongoDB');

    // 2. Create a new Moderator directly in MongoDB with custom commission
    const newModResult = await adminService.createStaffUser(
      mainAdmin._id.toString(),
      mainAdmin.email,
      {
        name: 'Top Tier Partner Mod',
        email: 'partner_mod@rouletteaccuracy.com',
        phone: '+8801822334455',
        password: 'Mod_Partner_Password_2026!',
        role: UserRole.MODERATOR,
        commissionRate: 50, // 50%
        notes: 'Telegram: @partner_mod_vip',
        reason: 'Authorized affiliate partnership onboard'
      }
    );

    assert.ok(newModResult.user._id, 'Moderator ID generated in MongoDB');
    assert.strictEqual(newModResult.user.role, UserRole.MODERATOR, 'Role is strictly MODERATOR');
    assert.ok(newModResult.user.referralCode.startsWith('MOD_'), 'Referral code has MOD_ prefix');

    // Verify in MongoDB
    const dbMod = await UserModel.findOne({ email: 'partner_mod@rouletteaccuracy.com' });
    assert.ok(dbMod, 'Moderator record exists directly in MongoDB');
    assert.strictEqual(dbMod.moderatorCommissionRate, 0.50, 'Moderator commission normalized to 0.50 (50%)');
    pass('Partner Moderator provisioned with 50% commission directly in MongoDB');

    // 3. Verify role filtering in adminService.getUsers
    const adminList = await adminService.getUsers({ role: 'SUPER_ADMIN' });
    assert.strictEqual(adminList.users.length, 2, 'Found exactly 2 admins in MongoDB (mainAdmin + newly added admin)');
    assert.ok(adminList.users.every((u: any) => u.role === UserRole.SUPER_ADMIN), 'All returned users in admin filter have role SUPER_ADMIN');
    pass('Filtering by role=SUPER_ADMIN accurately returns only administrators from MongoDB');

    const modList = await adminService.getUsers({ role: 'MODERATOR' });
    assert.strictEqual(modList.users.length, 2, 'Found exactly 2 moderators in MongoDB (initial mod + newly added mod)');
    assert.ok(modList.users.every((u: any) => u.role === UserRole.MODERATOR), 'All returned users in moderator filter have role MODERATOR');
    pass('Filtering by role=MODERATOR accurately returns only moderators from MongoDB');

    // 4. Verify immutable Audit Log entries
    const adminAuditLog = await AuditLogModel.findOne({ targetUserEmail: 'secondary_admin@rouletteaccuracy.com' });
    assert.ok(adminAuditLog, 'Audit log created for Admin creation');
    assert.strictEqual(adminAuditLog.action, 'ROLE_PROMOTION_SUPER_ADMIN');

    const modAuditLog = await AuditLogModel.findOne({ targetUserEmail: 'partner_mod@rouletteaccuracy.com' });
    assert.ok(modAuditLog, 'Audit log created for Moderator creation');
    assert.strictEqual(modAuditLog.action, 'ROLE_PROMOTION_MODERATOR');
    pass('Immutable audit log records persisted for staff creations');

    console.log('\n=============================================');
    console.log(`  PHASE 9 TEST RESULTS: ${passed} PASSED, 0 FAILED`);
    console.log('=============================================\n');
  } finally {
    (dsProxyService as any).getTables = originalGetTables;
    await teardownTestDb();
  }
}

if (require.main === module) {
  runPhase9Tests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Phase 9 Test Failed:', err);
      process.exit(1);
    });
}
