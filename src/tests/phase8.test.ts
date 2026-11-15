import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import assert from 'assert';
import { UserModel, AccountStatus } from '../models/User';
import { PlanModel, seedPlansIfEmpty } from '../models/Plan';
import { ToolSettingsModel } from '../models/ToolSettings';
import { WebsiteSettingsModel } from '../models/WebsiteSettings';
import { NotificationModel } from '../models/Notification';
import { PaymentModel } from '../models/Payment';
import { SubscriptionModel } from '../models/Subscription';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { AuditLogModel } from '../models/AuditLog';
import { subscriptionService } from '../services/subscription.service';
import { toolSettingsService } from '../services/toolSettings.service';
import { websiteSettingsService, sanitizeHtmlContent } from '../services/websiteSettings.service';
import { reportsService, sanitizeCsvCell } from '../services/reports.service';
import { notificationService } from '../services/notification.service';
import { subscriptionAccessService } from '../services/subscriptionAccess.service';
import { paymentService } from '../services/payment.service';
import { nowPaymentsService } from '../services/nowpayments.service';
import { UserRole } from '../shared/roles';
import { hashPassword } from '../utils/crypto';
import { PaymentStatus, SubscriptionStatus } from '../shared/subscriptions';

let mongoServer: MongoMemoryServer;

const TEST_IPN_SECRET = 'test_ipn_secret_nowpayments_mock_secure_hash_key_12345';

async function setupTestDb() {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
  console.log('Phase 8 Test in-memory MongoDB connected.');
}

async function teardownTestDb() {
  await mongoose.disconnect();
  await mongoServer.stop();
  console.log('Phase 8 Test in-memory MongoDB stopped.');
}

async function simulateIpnCallback(paymentDoc: any, status: string = 'finished', actuallyPaid: number = 200) {
  const ipnPayload = {
    payment_id: paymentDoc.paymentId,
    payment_status: status,
    pay_address: 'TX_USDT_TRC20_WALLET_ADDRESS_DEMO_01',
    price_amount: paymentDoc.priceAmount,
    price_currency: 'usd',
    pay_amount: paymentDoc.payAmount || paymentDoc.priceAmount,
    actually_paid: actuallyPaid,
    pay_currency: 'usdttrc20',
    order_id: paymentDoc.orderId,
    order_description: `Roulette Accuracy — ${paymentDoc.planName}`,
    purchase_id: paymentDoc.orderId
  };
  const signature = nowPaymentsService.generateIpnSignature(ipnPayload, TEST_IPN_SECRET);
  return await paymentService.processIpnCallback(ipnPayload, signature, TEST_IPN_SECRET);
}

async function runPhase8Tests() {
  console.log('\n=============================================');
  console.log('  STARTING PHASE 8 TEST SUITE');
  console.log('  Administrative Features & Platform Operations');
  console.log('=============================================\n');

  await setupTestDb();

  let passed = 0;
  let failed = 0;

  function testAssert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${msg}`);
      failed++;
      throw new Error(`Test assertion failed: ${msg}`);
    }
  }

  try {
    // -----------------------------------------------------------------------
    // Setup Actors
    // -----------------------------------------------------------------------
    const superAdmin = await UserModel.create({
      name: 'Main Executive Admin',
      email: 'owner@rouletteaccuracy.com',
      passwordHash: await hashPassword('AdminPass123!'),
      role: UserRole.SUPER_ADMIN,
      isEmailVerified: true,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE
    });

    const regularUser = await UserModel.create({
      name: 'Standard Customer',
      email: 'customer@casino.com',
      passwordHash: await hashPassword('CustomerPass123!'),
      role: UserRole.USER,
      isEmailVerified: true,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE
    });

    // --- Suite 1: Premium Plan Management ---
    console.log('\n--- Suite 1: Premium Plan Management ---');

    await seedPlansIfEmpty();
    const initialPlans = await subscriptionService.getAllPlans();
    testAssert(initialPlans.length === 5, 'Authoritative initial 5 subscription plans present in DB');

    const plan15Days = initialPlans.find((p) => p.id === 'PLAN_15_DAYS');
    testAssert(plan15Days?.priceUsd === 150, '15 Days initial price is $150.00');

    // Admin updates price and display features for PLAN_15_DAYS
    const updatedPlan = await subscriptionService.updatePlan(
      'PLAN_15_DAYS',
      {
        priceCents: 16000, // New price: $160
        description: 'Updated 15 days starter pass with priority signal stream',
        features: ['20+ Live Tables', 'Zero Latency Webhook Feeds', 'Telegram VIP Bot'],
        displayOrder: 1,
        isPopular: false
      },
      superAdmin._id.toString()
    );

    testAssert(updatedPlan.priceUsd === 160, 'Updated price reflects safely in dollars ($160.00)');
    testAssert(updatedPlan.priceCents === 16000, 'Updated price stored safely in cents (16000)');
    testAssert(updatedPlan.features.length === 3, 'Updated plan display features list preserved');
    testAssert(updatedPlan.displayOrder === 1, 'Set plan display order to 1');

    // Verify PLAN_PRICE_UPDATE audit log
    const planAudit = await AuditLogModel.findOne({ action: 'PLAN_PRICE_UPDATE' });
    testAssert(planAudit !== null, 'PLAN_PRICE_UPDATE audit log recorded');
    testAssert(planAudit?.adminId.toString() === superAdmin._id.toString(), 'Audit log tracks initiating Main Admin');

    // Toggle plan disabled
    const disabledPlan = await subscriptionService.updatePlan(
      'PLAN_15_DAYS',
      { isActive: false },
      superAdmin._id.toString()
    );
    testAssert(disabledPlan.isActive === false, 'Main Admin can disable subscription plan');

    // Verify public plans excludes disabled plan
    const publicPlans = await subscriptionService.getPublicPlans();
    testAssert(!publicPlans.some((p) => p.id === 'PLAN_15_DAYS'), 'Disabled plan excluded from public customer catalog');

    // Re-enable plan
    await subscriptionService.updatePlan('PLAN_15_DAYS', { isActive: true }, superAdmin._id.toString());

    // --- Suite 2: Price Snapshotting & Immutability Protection ---
    console.log('\n--- Suite 2: Price Snapshotting & Immutability Protection ---');

    // User creates purchase order for PLAN_1_MONTH ($200)
    const order = await paymentService.createPurchaseOrder(
      regularUser._id.toString(),
      'PLAN_1_MONTH',
      'USDTTRC20'
    );
    const orderDoc = await PaymentModel.findOne({ orderId: order.orderId });
    testAssert(orderDoc?.priceAmount === 200, 'Purchase order snapshots plan price ($200.00)');
    testAssert(orderDoc?.priceCurrency === 'USD', 'Purchase order snapshots currency (USD)');

    // Admin updates PLAN_1_MONTH price to $250 for FUTURE sales
    await subscriptionService.updatePlan(
      'PLAN_1_MONTH',
      { priceCents: 25000 },
      superAdmin._id.toString()
    );

    // Verify existing purchase order price is UNCHANGED
    const existingOrderAfterPriceChange = await PaymentModel.findOne({ orderId: order.orderId });
    testAssert(existingOrderAfterPriceChange?.priceAmount === 200, 'Price change does NOT alter existing purchase order');

    // Subsequent new order gets the updated price ($250)
    const order2 = await paymentService.createPurchaseOrder(
      regularUser._id.toString(),
      'PLAN_1_MONTH',
      'USDTTRC20'
    );
    const orderDoc2 = await PaymentModel.findOne({ orderId: order2.orderId });
    testAssert(orderDoc2?.priceAmount === 250, 'Subsequent purchase order snapshots new updated price ($250.00)');

    // --- Suite 3: Tool Management & Maintenance Mode ---
    console.log('\n--- Suite 3: Tool Management & Maintenance Mode ---');

    // Activate subscription for regular user
    await simulateIpnCallback(orderDoc!, 'finished', 200);

    // Regular user has active access
    const initialAccess = await subscriptionAccessService.checkAccess(regularUser._id.toString());
    testAssert(initialAccess.hasAccess === true, 'Subscribed user has active tool access');

    // Admin puts tool in MAINTENANCE mode
    await toolSettingsService.updateToolSettings(
      superAdmin._id.toString(),
      superAdmin.email,
      {
        maintenanceMode: true,
        publicStatusMessage: 'Engine core firmware upgrade underway. Resuming at 04:00 UTC.'
      },
      'Scheduled infrastructure patch'
    );

    // Regular user is blocked by maintenance mode with public status message
    const maintenanceAccess = await subscriptionAccessService.checkAccess(regularUser._id.toString());
    testAssert(maintenanceAccess.hasAccess === false, 'Regular user blocked during maintenance mode');
    testAssert(maintenanceAccess.code === 'TOOL_MAINTENANCE', 'Access code is TOOL_MAINTENANCE');
    testAssert(maintenanceAccess.reason?.includes('firmware upgrade') === true, 'Public status message served to client');

    // Main Admin can still inspect system
    const adminAccess = await subscriptionAccessService.checkAccess(superAdmin._id.toString());
    testAssert(adminAccess.hasAccess === true, 'Main Admin retains inspection access during maintenance');

    // Admin completely DISABLES tool
    await toolSettingsService.updateToolSettings(
      superAdmin._id.toString(),
      superAdmin.email,
      {
        isToolEnabled: false,
        maintenanceMode: false,
        publicStatusMessage: 'The prediction tool is currently paused.'
      },
      'Emergency circuit breaker trigger'
    );

    const disabledAccess = await subscriptionAccessService.checkAccess(regularUser._id.toString());
    testAssert(disabledAccess.hasAccess === false, 'Access denied when tool is disabled');
    testAssert(disabledAccess.code === 'TOOL_DISABLED', 'Access code is TOOL_DISABLED');

    // Disabling tool must NOT erase subscription records or disable auth
    const subRecordStillExists = await SubscriptionModel.findOne({ userId: regularUser._id });
    testAssert(subRecordStillExists !== null, 'Subscription record strictly preserved when tool is disabled');
    const userStillActive = await UserModel.findById(regularUser._id);
    testAssert(userStillActive?.isActive === true, 'User authentication status strictly preserved');

    // Restore tool to live
    await toolSettingsService.updateToolSettings(
      superAdmin._id.toString(),
      superAdmin.email,
      { isToolEnabled: true, maintenanceMode: false },
      'Incident resolved'
    );
    const restoredAccess = await subscriptionAccessService.checkAccess(regularUser._id.toString());
    testAssert(restoredAccess.hasAccess === true, 'Tool access seamlessly restored for active subscribers');

    // --- Suite 4: Website Settings & XSS Sanitization ---
    console.log('\n--- Suite 4: Website Settings & XSS Sanitization ---');

    // Attempt XSS injection through content management fields
    const maliciousPayload = {
      siteName: 'Roulette Accuracy Official',
      homepageContent: {
        heroTitle: 'Edge Analytics <script>alert("xss")</script>',
        heroSubtitle: '<img src=x onerror=alert(1)> Real-time statistical pattern engine',
        announcementBanner: 'New features live! <iframe src="evil.com"></iframe>'
      },
      legalPolicies: {
        termsAndConditions: 'Standard terms <script src="http://attacker.com/malware.js"></script> applied.',
        privacyPolicy: 'Privacy policy content',
        subscriptionPolicy: 'Subscription policy content',
        referralPolicy: 'Referral policy content'
      }
    };

    const savedSettings = await websiteSettingsService.updateSettings(
      superAdmin._id.toString(),
      superAdmin.email,
      maliciousPayload as any,
      'Content updates with sanitization verification'
    );

    testAssert(!savedSettings.homepageContent.heroTitle.includes('<script>'), 'Sanitized <script> tags from heroTitle');
    testAssert(!savedSettings.homepageContent.heroSubtitle.includes('onerror='), 'Sanitized inline event handlers from heroSubtitle');
    testAssert(!savedSettings.homepageContent.announcementBanner.includes('<iframe'), 'Sanitized <iframe> tags from announcementBanner');
    testAssert(!savedSettings.legalPolicies.termsAndConditions.includes('<script'), 'Sanitized script injection from legal policies');

    const settingsAudit = await AuditLogModel.findOne({ action: 'WEBSITE_SETTINGS_UPDATE' });
    testAssert(settingsAudit !== null, 'WEBSITE_SETTINGS_UPDATE audit log recorded');

    // --- Suite 5: Reports & Financial Definitions ---
    console.log('\n--- Suite 5: Reports & Financial Definitions ---');

    const summaryReport = await reportsService.getSummaryReport();
    testAssert(summaryReport.users.totalRegistrations >= 2, 'Report tracks total user registrations');
    testAssert(summaryReport.subscriptions.totalActive >= 1, 'Report tracks active subscriptions');
    testAssert(summaryReport.subscriptions.planDistribution.length === 5, 'Report includes plan distribution breakdown');

    // Financial breakdown check
    testAssert(summaryReport.finances.grossSalesUsd >= 200, 'Report calculates gross sales');
    testAssert(summaryReport.finances.estimatedFeesUsd > 0, 'Report calculates payment fees');
    testAssert(
      summaryReport.finances.netRevenueUsd ===
        Math.round((summaryReport.finances.grossSalesUsd - summaryReport.finances.refundsUsd - summaryReport.finances.estimatedFeesUsd) * 100) / 100,
      'Net revenue equals Gross Sales minus Refunds minus Payment Fees'
    );
    testAssert(
      summaryReport.finances.disclaimer.includes('zero automated withdrawal functionality'),
      'Financial report includes explicit non-custodial and zero-withdrawal disclaimer'
    );

    // --- Suite 6: Safe CSV Export & Formula Injection Prevention ---
    console.log('\n--- Suite 6: Safe CSV Export & Formula Injection Prevention ---');

    // Test formula injection sanitizer
    testAssert(sanitizeCsvCell('=cmd|"/C calc"!A0').startsWith("\"'="), 'Formula starting with = is neutralized with single quote');
    testAssert(sanitizeCsvCell('+12345678').startsWith("\"'+"), 'Formula starting with + is neutralized with single quote');
    testAssert(sanitizeCsvCell('-@dangerous').startsWith("\"'-"), 'Formula starting with - is neutralized with single quote');
    testAssert(sanitizeCsvCell('Normal Text') === '"Normal Text"', 'Regular text correctly quoted without corruption');

    // Export Sales CSV
    const salesCsv = await reportsService.exportReportCsv('SALES');
    testAssert(salesCsv.includes('Order ID,Payment ID,Customer Email'), 'Sales CSV contains required headers');
    testAssert(!salesCsv.includes('passwordHash'), 'Sales CSV never leaks sensitive password credentials');

    // Export Registrations CSV
    const regCsv = await reportsService.exportReportCsv('REGISTRATIONS');
    testAssert(regCsv.includes('User ID,Name,Email,Phone,Role'), 'Registrations CSV contains standard headers');
    testAssert(!regCsv.includes('twoFactorSecret'), 'Registrations CSV never leaks 2FA secrets or OTPs');

    // --- Suite 7: In-App User Notifications ---
    console.log('\n--- Suite 7: In-App User Notifications ---');

    // Check notification was sent on payment fulfillment in Suite 3
    const userNotifs = await notificationService.getUserNotifications(regularUser._id.toString());
    testAssert(userNotifs.total >= 1, 'User received in-app notification upon subscription activation');
    testAssert(userNotifs.unreadCount >= 1, 'Notification unread count tracked accurately');

    const firstNotif = userNotifs.notifications[0];
    testAssert(firstNotif.type === 'SUBSCRIPTION_ACTIVATED', 'Notification type is SUBSCRIPTION_ACTIVATED');

    // User marks notification as read
    const readNotif = await notificationService.markAsRead(regularUser._id.toString(), firstNotif._id.toString());
    testAssert(readNotif.isRead === true, 'Notification marked as read');
    testAssert(readNotif.readAt !== undefined, 'Notification readAt timestamp set');

    // Main Admin broadcasts an announcement
    const broadcastResult = await notificationService.broadcastAnnouncement(
      superAdmin._id.toString(),
      superAdmin.email,
      'Platform V2.5 Rollout Complete',
      'We have upgraded European live table telemetry feeds.'
    );
    testAssert(broadcastResult.recipientCount >= 2, 'Broadcast announcement delivered to all platform users');

    const updatedUserNotifs = await notificationService.getUserNotifications(regularUser._id.toString());
    const announcement = updatedUserNotifs.notifications.find((n) => n.type === 'PLATFORM_ANNOUNCEMENT');
    testAssert(announcement !== undefined, 'User received broadcast announcement in notifications feed');

    // User marks all as read
    const markAllRes = await notificationService.markAllAsRead(regularUser._id.toString());
    testAssert(markAllRes.modifiedCount >= 1, 'Mark all notifications as read executed');

    const finalUnread = await notificationService.getUserNotifications(regularUser._id.toString(), { unreadOnly: true });
    testAssert(finalUnread.unreadCount === 0, 'Unread count is 0 after markAllAsRead');

    // --- Suite 8: Activity Logs Role-Based Restriction ---
    console.log('\n--- Suite 8: Activity Logs Role-Based Restriction ---');

    const adminLogs = await AuditLogModel.find().sort({ createdAt: -1 });
    testAssert(adminLogs.length >= 4, 'Audit logs track administrative lifecycle events');

    const actionsPresent = adminLogs.map((l) => l.action);
    testAssert(actionsPresent.includes('PLAN_PRICE_UPDATE'), 'Tracks plan price updates');
    testAssert(actionsPresent.includes('TOOL_SETTINGS_UPDATE'), 'Tracks tool settings updates');
    testAssert(actionsPresent.includes('WEBSITE_SETTINGS_UPDATE'), 'Tracks website settings updates');
    testAssert(actionsPresent.includes('BROADCAST_ANNOUNCEMENT'), 'Tracks broadcast announcements');

  } finally {
    await teardownTestDb();
  }

  console.log('\n=============================================');
  console.log(`  PHASE 8 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=============================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase8Tests().catch((err) => {
  console.error('Phase 8 Test execution failed with error:', err);
  process.exit(1);
});
