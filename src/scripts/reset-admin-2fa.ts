/**
 * Secure owner/offline recovery for a lost admin authenticator.
 *
 * This script must be run by a trusted server operator with direct shell and
 * database access. It never prints secrets and permanently audit-logs the
 * reset. It does NOT bypass 2FA: the admin must enroll again on next login.
 *
 * Usage:
 *   npm run admin:reset-2fa -- --email admin@example.com --reason "Lost phone and recovery codes"
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { UserModel } from '../models/User';
import { AdminTwoFactorModel } from '../models/AdminTwoFactor';
import { AdminRecoveryCodeModel } from '../models/AdminRecoveryCode';
import { AdminTwoFactorChallengeModel } from '../models/AdminTwoFactorChallenge';
import { AuditLogModel } from '../models/AuditLog';
import { UserRole } from '../shared/roles';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1].trim();
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3).trim() : undefined;
}

async function run() {
  const email = arg('email');
  const reason = arg('reason') || 'Owner-initiated offline recovery (lost authenticator and recovery codes)';

  if (!email) {
    console.error('Usage: npm run admin:reset-2fa -- --email admin@example.com --reason "Reason"');
    process.exit(1);
  }

  await mongoose.connect(env.MONGODB_URI);
  try {
    const user = await UserModel.findOne({ email: email.toLowerCase().trim() });
    if (!user || user.role !== UserRole.SUPER_ADMIN) {
      console.error('No SUPER_ADMIN account found with that email.');
      process.exit(2);
    }

    await AdminTwoFactorModel.deleteOne({ userId: user._id });
    await AdminRecoveryCodeModel.deleteMany({ userId: user._id });
    await AdminTwoFactorChallengeModel.updateMany(
      { userId: user._id, usedAt: { $exists: false } },
      { $set: { usedAt: new Date() } }
    );

    await AuditLogModel.create({
      action: 'ADMIN_2FA_OWNER_RECOVERY',
      adminId: user._id,
      adminEmail: 'server-owner@localhost',
      targetUserId: user._id,
      targetUserEmail: user.email,
      targetResourceId: user._id.toString(),
      resourceType: 'AdminTwoFactor',
      reason,
      details: {
        source: 'cli_offline_recovery',
        userAgent: 'server-shell',
        note: 'Admin must re-enroll TOTP on next login; no bypass code was created.'
      }
    });

    console.log(`2FA reset for ${user.email}. The admin must set up the authenticator again on next login.`);
    console.log('A permanent ADMIN_2FA_OWNER_RECOVERY audit record was created.');
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error('Admin 2FA reset failed:', error?.message || error);
  process.exit(1);
});
