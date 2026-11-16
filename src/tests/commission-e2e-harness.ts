import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { app } from '../app';
import { seedPlansIfEmpty } from '../models/Plan';
import { UserModel } from '../models/User';
import { UserRole } from '../shared/roles';
import { hashPassword } from '../utils/crypto';

const PORT = 5050;

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await seedPlansIfEmpty();

  await UserModel.create({
    name: 'Wallet Admin',
    email: 'wallet.admin@example.com',
    passwordHash: await hashPassword('AdminPass123!'),
    role: UserRole.SUPER_ADMIN,
    isEmailVerified: true,
    isActive: true,
    accountStatus: 'ACTIVE'
  });

  const referrer = await UserModel.create({
    name: 'Commission Referrer',
    email: 'commission.referrer@example.com',
    passwordHash: await hashPassword('WalletPass123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true,
    accountStatus: 'ACTIVE',
    referralCode: 'REF-COMMISSION1'
  });

  await UserModel.create({
    name: 'Commission Buyer',
    email: 'commission.buyer@example.com',
    passwordHash: await hashPassword('WalletPass123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true,
    accountStatus: 'ACTIVE',
    referredBy: referrer._id,
    referredAt: new Date(),
    referralCodeUsed: referrer.referralCode
  });

  const server = app.listen(PORT, () => {
    console.log('COMMISSION_HARNESS_READY');
    console.log(JSON.stringify({ admin: 'wallet.admin@example.com', referrer: 'commission.referrer@example.com' }));
  });

  const shutdown = async () => {
    server.close();
    await mongoose.disconnect().catch(() => null);
    await mongod.stop().catch(() => null);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => null);
  process.exit(1);
});
