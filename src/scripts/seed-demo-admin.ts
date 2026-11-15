import { db } from '../database/connection';
import { initializeAuthoritativeAdmin } from '../database/initAdmin';

async function run(): Promise<void> {
  console.log('Connecting to database...');
  await db.connect();
  console.log('Initializing authoritative admin in MongoDB...');
  await initializeAuthoritativeAdmin();
  console.log('Done!');
  await db.disconnect();
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed to initialize admin:', err);
    process.exit(1);
  });
