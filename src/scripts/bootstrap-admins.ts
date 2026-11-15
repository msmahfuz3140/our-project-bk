import { db } from '../database/connection';
import { UserModel } from '../models/User';
import { AuditLogModel } from '../models/AuditLog';
import { UserRole } from '../shared/roles';
import { hashPassword, generateRandomString } from '../utils/crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export async function bootstrapMainAdmins(shouldDisconnect = require.main === module): Promise<void> {
  logger.info('Checking Main Admin bootstrap status...');
  await db.connect();

  // Check existing SUPER_ADMIN count
  const existingSuperAdmins = await UserModel.find({ role: UserRole.SUPER_ADMIN });

  if (existingSuperAdmins.length >= 4) {
    logger.warn(`Bootstrap procedure is permanently disabled. Exactly ${existingSuperAdmins.length} Main Admin accounts are already initialized.`);
    if (shouldDisconnect) {
      await db.disconnect();
    }
    return;
  }

  const designatedEmails = env.MAIN_ADMINS.slice(0, 4);
  logger.info(`Initializing ${designatedEmails.length} designated Main Admin accounts...`);

  const initialPassword = (process.env.INITIAL_ADMIN_PASSWORD || '').trim();
  if (initialPassword.length < 12 || /^change_this/i.test(initialPassword)) {
    throw new Error(
      'INITIAL_ADMIN_PASSWORD must be set to a strong non-placeholder value (12+ characters) before bootstrap. Passwords are never generated or printed to logs.'
    );
  }

  for (let i = 0; i < designatedEmails.length; i++) {
    const email = designatedEmails[i].toLowerCase().trim();
    const existing = await UserModel.findOne({ email });

    if (existing) {
      if (existing.role !== UserRole.SUPER_ADMIN) {
        existing.role = UserRole.SUPER_ADMIN;
        existing.isEmailVerified = true;
        existing.isActive = true;
        await existing.save();

        await AuditLogModel.create({
          action: 'MAIN_ADMIN_BOOTSTRAP',
          adminId: existing._id,
          adminEmail: email,
          targetUserId: existing._id,
          targetUserEmail: email,
          reason: 'Initial bootstrap promotion to SUPER_ADMIN',
          details: { designatedEmailIndex: i + 1 }
        }).catch((err) => logger.error('Audit log failed during bootstrap promotion', err));

        logger.info(`Promoted designated account to SUPER_ADMIN: ${email}`);
      }
      continue;
    }

    // High-entropy passwords are supplied by the operator via environment.
    // Never generate or print credentials to logs.
    const passwordHash = await hashPassword(initialPassword);

    const newAdmin = await UserModel.create({
      name: `Main Admin ${i + 1}`,
      email,
      passwordHash,
      role: UserRole.SUPER_ADMIN,
      isEmailVerified: true,
      isActive: true,
      referralCode: `ADMIN${i + 1}_${generateRandomString(4).toUpperCase()}`
    });

    await AuditLogModel.create({
      action: 'MAIN_ADMIN_BOOTSTRAP',
      adminId: newAdmin._id,
      adminEmail: email,
      targetUserId: newAdmin._id,
      targetUserEmail: email,
      reason: 'First-time owner bootstrap account creation',
      details: { designatedEmailIndex: i + 1, seatNumber: i + 1 }
    }).catch((err) => logger.error('Audit log failed during bootstrap account creation', err));

    logger.info(`Main Admin ${i + 1} initialized: ${email}`);
  }

  logger.info('First-time owner bootstrap procedure completed successfully. Bootstrap is now disabled.');
  if (shouldDisconnect) {
    await db.disconnect();
  }
}

if (require.main === module) {
  bootstrapMainAdmins()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Bootstrap failed', err);
      process.exit(1);
    });
}
