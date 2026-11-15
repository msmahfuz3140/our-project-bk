import { db } from '../database/connection';
import { UserModel, AccountStatus } from '../models/User';
import { SubscriptionModel } from '../models/Subscription';
import { UserRole } from '../shared/roles';
import { SubscriptionStatus } from '../shared/subscriptions';
import { hashPassword } from '../utils/crypto';
import { calculatePlanExpiration, SUBSCRIPTION_PLANS } from '../shared/plans';
import { logger } from '../utils/logger';

export async function seedTestUsers(shouldDisconnect = true): Promise<void> {
  console.log('Connecting to database to seed designated testing accounts...');
  await db.connect();

  const rawPassword = '31403140';
  const passwordHash = await hashPassword(rawPassword);

  // Clean up any old demo admin accounts
  await UserModel.deleteMany({
    email: { $in: ['admin@gmail.com', 'demo.admin@rouletteaccuracy.com', 'admin1@rouletteaccuracy.com'] }
  });

  const accounts = [
    {
      name: 'Moderator Partner',
      email: 'mod@gmail.com',
      role: UserRole.MODERATOR,
      referralCode: 'MOD_TEST',
      commissionRate: 0.50,
      hasActiveSubscription: false
    },
    {
      name: 'Normal Member',
      email: 'normal@gmail.com',
      role: UserRole.USER,
      referralCode: 'USER_TEST',
      commissionRate: undefined,
      hasActiveSubscription: true
    }
  ];

  for (const acc of accounts) {
    let user = await UserModel.findOne({ email: acc.email });

    if (user) {
      user.name = acc.name;
      user.passwordHash = passwordHash;
      user.role = acc.role;
      user.isEmailVerified = true;
      user.isPhoneVerified = true;
      user.isActive = true;
      user.accountStatus = AccountStatus.ACTIVE;
      if (acc.commissionRate !== undefined) {
        user.moderatorCommissionRate = acc.commissionRate;
      }
      user.sessionsRevokedAt = undefined;
      await user.save();
      console.log(`[UPDATED] ${acc.email} -> Role: ${acc.role}`);
    } else {
      user = await UserModel.create({
        name: acc.name,
        email: acc.email,
        passwordHash,
        role: acc.role,
        isEmailVerified: true,
        isPhoneVerified: true,
        isActive: true,
        accountStatus: AccountStatus.ACTIVE,
        referralCode: acc.referralCode,
        moderatorCommissionRate: acc.commissionRate
      });
      console.log(`[CREATED] ${acc.email} -> Role: ${acc.role}`);
    }

    // If account has active subscription (Normal user gets 1 Month Pro)
    if (acc.hasActiveSubscription) {
      let sub = await SubscriptionModel.findOne({
        userId: user._id,
        status: SubscriptionStatus.ACTIVE
      });

      const now = new Date();
      const planId = 'PLAN_1_MONTH';
      const plan = SUBSCRIPTION_PLANS[planId];
      const endDate = calculatePlanExpiration(now, plan.duration);

      if (sub) {
        sub.planId = planId;
        sub.startDate = now;
        sub.endDate = endDate;
        sub.status = SubscriptionStatus.ACTIVE;
        sub.isSecretCodeClaimed = true;
        sub.isApprovedByAdmin = true;
        await sub.save();
      } else {
        await SubscriptionModel.create({
          userId: user._id,
          planId,
          status: SubscriptionStatus.ACTIVE,
          startDate: now,
          endDate,
          isManualGrant: true,
          isSecretCodeClaimed: true,
          isApprovedByAdmin: true,
          grantReason: 'Initial setup testing active pass'
        });
      }
      console.log(`[PASS GRANTED] ${plan.name} (${plan.durationDays} days) linked for ${acc.email}`);
    }
  }

  console.log('\n================================================================');
  console.log('       TEST ACCOUNTS SEEDED SUCCESSFULLY (ADMIN REMAINS IN DB)   ');
  console.log('================================================================');
  console.log(' 1. MODERATOR:   mod@gmail.com    -> Access /moredator');
  console.log(' 2. USER:        normal@gmail.com -> Access /dashboard & /dashboard/tool');
  console.log('================================================================\n');

  if (shouldDisconnect) {
    await db.disconnect();
  }
}

if (require.main === module) {
  seedTestUsers(true)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Failed to seed test users:', err);
      process.exit(1);
    });
}
