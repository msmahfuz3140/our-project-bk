import { UserModel, AccountStatus } from '../models/User';
import { SubscriptionModel } from '../models/Subscription';
import { UserRole } from '../shared/roles';
import { SubscriptionStatus } from '../shared/subscriptions';
import { hashPassword } from '../utils/crypto';
import { logger } from '../utils/logger';

export async function initializeAuthoritativeAdmin(): Promise<void> {
  try {
    // 1. Do not silently delete legacy/demo accounts. Removing users is a
    // destructive migration and must be performed explicitly by an operator.
    const legacyDemoAdmins = await UserModel.find({
      email: { $in: ['demo.admin@rouletteaccuracy.com', 'admin@gmail.com', 'admin1@rouletteaccuracy.com'] },
      role: UserRole.SUPER_ADMIN
    }).select('email').lean();
    if (legacyDemoAdmins.length > 0) {
      logger.warn('Legacy demo admin accounts detected. No automatic deletion was performed; review them in the admin panel.', {
        accounts: legacyDemoAdmins.map((admin) => admin.email)
      });
    }

    // 2. Check if a Super Admin already exists in the database
    const existingSuperAdmin = await UserModel.findOne({ role: UserRole.SUPER_ADMIN });
    if (existingSuperAdmin) {
      logger.info(`Super Admin verified in MongoDB. Preserving existing database records.`);
      return;
    }

    // 3. Fallback: if no Super Admin exists at all, look for configured MAIN_ADMIN_EMAILS in .env
    const envAdminEmail = (process.env.MAIN_ADMIN_EMAILS?.split(',')[0] || '').trim().toLowerCase();
    if (!envAdminEmail) {
      return;
    }

    const initialPassword = (process.env.INITIAL_ADMIN_PASSWORD || '').trim();
    if (initialPassword.length < 12 || /^change_this/i.test(initialPassword)) {
      logger.error(
        'No Super Admin exists, but INITIAL_ADMIN_PASSWORD is missing, placeholder, or shorter than 12 characters. Automatic admin creation was skipped. Set a strong INITIAL_ADMIN_PASSWORD or provision an admin explicitly.'
      );
      return;
    }

    const passwordHash = await hashPassword(initialPassword);

    const admin = await UserModel.create({
      name: 'Super Admin',
      email: envAdminEmail,
      passwordHash,
      role: UserRole.SUPER_ADMIN,
      isEmailVerified: true,
      isPhoneVerified: true,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE,
      referralCode: 'ADMIN_CHIEF'
    });

    const now = new Date();
    const oneYearLater = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    await SubscriptionModel.create({
      userId: admin._id,

      planId: 'PLAN_1_YEAR',
      status: SubscriptionStatus.ACTIVE,
      startDate: now,
      endDate: oneYearLater,
      isManualGrant: true,
      isSecretCodeClaimed: true,
      isApprovedByAdmin: true,
      grantReason: 'Initial platform administrator pass'
    });

    logger.info(`Initial Super Admin provisioned from environment config.`);
  } catch (err) {
    logger.error('Failed to verify authoritative admin in MongoDB', err);
  }
}
