import mongoose from 'mongoose';
import http from 'http';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { authService } from '../services/auth.service';
import { adminTwoFactorService } from '../services/adminTwoFactor.service';
import { UserModel } from '../models/User';
import { AdminTwoFactorModel } from '../models/AdminTwoFactor';
import { AdminRecoveryCodeModel } from '../models/AdminRecoveryCode';
import { AdminTwoFactorChallengeModel } from '../models/AdminTwoFactorChallenge';
import { AuditLogModel } from '../models/AuditLog';
import { UserRole } from '../shared/roles';
import { hashPassword } from '../utils/crypto';
import { decryptTotpSecret } from '../utils/twoFactorCrypto';
import { signAccessToken } from '../utils/sessionToken';
import { app } from '../app';

authenticator.options = { digits: 6, step: 30, window: 1 };

let mongod: MongoMemoryServer | undefined;
let server: http.Server | undefined;
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

function currentStep(): number {
  return Math.floor(Date.now() / 30_000);
}

async function createAdmin(email: string, password = 'AdminStrongPass123!'): Promise<any> {
  return UserModel.create({
    name: 'Phase 19 Admin',
    email,
    passwordHash: await hashPassword(password),
    role: UserRole.SUPER_ADMIN,
    isEmailVerified: true,
    isActive: true,
    accountStatus: 'ACTIVE'
  });
}

async function createNormalUser(email: string): Promise<any> {
  return UserModel.create({
    name: 'Phase 19 Member',
    email,
    passwordHash: await hashPassword('MemberStrongPass123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true,
    accountStatus: 'ACTIVE',
    referralCode: `REF-${Math.random().toString(36).slice(2, 9).toUpperCase()}`
  });
}

async function beginLogin(user: any, password = 'AdminStrongPass123!') {
  const response = await authService.login({ identifier: user.email, password });
  if (!response.requiresAdmin2FA || !response.adminTwoFactorChallengeToken) {
    throw new Error('Admin login did not return a 2FA challenge');
  }
  return response;
}

async function completeSetup(user: any, password = 'AdminStrongPass123!') {
  const challenge = await beginLogin(user, password);
  const setup = challenge.adminTwoFactorSetup!;
  const result = await authService.verifyAdminTwoFactor({
    challengeToken: challenge.adminTwoFactorChallengeToken!,
    code: authenticator.generate(setup.manualKey)
  });
  return { setup, result };
}

async function completeLoginWithTotp(user: any, password = 'AdminStrongPass123!') {
  // Allow the current time step to be accepted by moving the replay marker
  // back. Production never does this; it only makes the test fast.
  await AdminTwoFactorModel.updateOne(
    { userId: user._id },
    { $set: { lastUsedTimeStep: currentStep() - 3 } }
  );
  const challenge = await beginLogin(user, password);
  const twoFactor = await AdminTwoFactorModel.findOne({ userId: user._id }).select('+secretEncrypted');
  const secret = decryptTotpSecret(twoFactor?.secretEncrypted);
  const result = await authService.verifyAdminTwoFactor({
    challengeToken: challenge.adminTwoFactorChallengeToken!,
    code: authenticator.generate(secret)
  });
  return { challenge, secret, result };
}

async function run() {
  console.log('\n=============================================');
  console.log('  PHASE 19 ADMIN TOTP TWO-STEP VERIFICATION');
  console.log('=============================================\n');

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const admin = await createAdmin('phase19.admin@example.com');

  console.log('\n[1. Password alone never grants admin access]');
  const firstLogin = await beginLogin(admin);
  assert(firstLogin.requiresAdmin2FA === true, 'admin login requires 2FA');
  assert(!firstLogin.token, 'password-only login returns no full session token');
  assert(firstLogin.adminTwoFactorMode === 'SETUP', 'first login requires authenticator setup');
  assert(!!firstLogin.adminTwoFactorSetup?.otpauthUrl, 'setup returns an otpauth provisioning URI');
  assert(!!firstLogin.adminTwoFactorSetup?.manualKey, 'setup returns a manual fallback key');
  assert(
    firstLogin.adminTwoFactorSetup!.otpauthUrl.startsWith('otpauth://totp/'),
    'provisioning URI uses standard otpauth TOTP format'
  );

  let noTokenAdminApi = await fetch(`${base}/api/v1/admin/users?limit=1`);
  assert(noTokenAdminApi.status === 401, 'admin API rejects requests without a session', noTokenAdminApi.status);

  const challengeAsSession = await fetch(`${base}/api/v1/admin/users?limit=1`, {
    headers: { Authorization: `Bearer ${firstLogin.adminTwoFactorChallengeToken}` }
  });
  assert(
    challengeAsSession.status === 401,
    'pre-auth challenge token is rejected as an admin session',
    challengeAsSession.status
  );

  console.log('\n[2. Invalid setup code does not enable 2FA]');
  let invalidSetupRejected = false;
  try {
    await authService.verifyAdminTwoFactor({
      challengeToken: firstLogin.adminTwoFactorChallengeToken!,
      code: '123456'
    });
  } catch (error: any) {
    invalidSetupRejected = error?.code === 'ADMIN_2FA_INVALID_CODE';
  }
  const beforeSetupRecord = await AdminTwoFactorModel.findOne({ userId: admin._id });
  assert(invalidSetupRejected, 'invalid setup code is rejected');
  assert(beforeSetupRecord?.enabled === false, '2FA remains disabled after an invalid setup code');

  console.log('\n[3. Valid setup code enables 2FA and completes login]');
  // Reuse the pending secret from the first challenge, which is still valid.
  const setupCode = authenticator.generate(firstLogin.adminTwoFactorSetup!.manualKey);
  const setupResult = await authService.verifyAdminTwoFactor({
    challengeToken: firstLogin.adminTwoFactorChallengeToken!,
    code: setupCode
  });
  const setupRecord = await AdminTwoFactorModel.findOne({ userId: admin._id }).select(
    '+secretEncrypted +pendingSecretEncrypted'
  );
  const setupToken = jwt.decode(setupResult.token!) as any;

  assert(setupRecord?.enabled === true, 'valid setup code enables 2FA');
  assert(!!setupRecord?.secretEncrypted?.startsWith('totp:v1:'), 'TOTP secret is encrypted at rest');
  assert(
    decryptTotpSecret(setupRecord?.secretEncrypted) === firstLogin.adminTwoFactorSetup!.manualKey,
    'encrypted secret decrypts to the setup key for server verification'
  );
  assert(!setupResult.token?.includes(firstLogin.adminTwoFactorSetup!.manualKey), 'session token does not contain the TOTP secret');
  assert(Array.isArray(setupResult.recoveryCodes) && setupResult.recoveryCodes.length === 10, 'setup returns 10 recovery codes once');
  assert(setupToken?.scope === 'access', 'successful setup issues a full access token');
  assert(Array.isArray(setupToken?.amr) && setupToken.amr.includes('totp'), 'full token records the TOTP factor');
  assert(typeof setupToken?.jti === 'string' && setupToken.jti.length > 10, 'full token has a unique session id');

  const storedRecoveryCodes = await AdminRecoveryCodeModel.find({ userId: admin._id }).select('+codeHash');
  assert(storedRecoveryCodes.length === 10, 'recovery codes are persisted');
  assert(
    storedRecoveryCodes.every(
      (entry) => !setupResult.recoveryCodes!.includes(entry.codeHash) && /^[a-f0-9]{64}$/.test(entry.codeHash)
    ),
    'only hashed recovery codes are stored'
  );

  admin.isActive = true;
  await admin.save();

  console.log('\n[4. Admin API enforces the fully verified session]');
  const fullAdminApi = await fetch(`${base}/api/v1/admin/users?limit=1`, {
    headers: { Authorization: `Bearer ${setupResult.token}` }
  });
  assert(fullAdminApi.status === 200, 'verified admin session can access admin APIs', fullAdminApi.status);

  const passwordOnlyToken = signAccessToken(admin._id.toString());
  const passwordOnlyAdminApi = await fetch(`${base}/api/v1/admin/users?limit=1`, {
    headers: { Authorization: `Bearer ${passwordOnlyToken}` }
  });
  const passwordOnlyBody: any = await passwordOnlyAdminApi.json().catch(() => null);
  assert(
    passwordOnlyAdminApi.status === 403 &&
      passwordOnlyBody?.error?.code === 'ADMIN_2FA_REQUIRED',
    'admin session without TOTP factor is rejected by admin APIs',
    { status: passwordOnlyAdminApi.status, code: passwordOnlyBody?.error?.code }
  );

  const unenrolledAdmin = await createAdmin('phase19.unenrolled@example.com');
  const unenrolledToken = signAccessToken(unenrolledAdmin._id.toString());
  const unenrolledApi = await fetch(`${base}/api/v1/admin/users?limit=1`, {
    headers: { Authorization: `Bearer ${unenrolledToken}` }
  });
  const unenrolledBody: any = await unenrolledApi.json().catch(() => null);
  assert(
    unenrolledApi.status === 403 &&
      unenrolledBody?.error?.code === 'ADMIN_2FA_SETUP_REQUIRED',
    'admin without configured 2FA is rejected with setup-required error',
    { status: unenrolledApi.status, code: unenrolledBody?.error?.code }
  );

  console.log('\n[5. Subsequent logins require a fresh authenticator code]');
  const secondLogin = await beginLogin(admin);
  assert(secondLogin.adminTwoFactorMode === 'VERIFY', 'subsequent login asks for authenticator code');
  assert(!secondLogin.token, 'second-factor challenge does not create a full session');
  assert(!secondLogin.adminTwoFactorSetup, 'normal login does not expose setup information');

  let wrongTotpRejected = false;
  try {
    await authService.verifyAdminTwoFactor({
      challengeToken: secondLogin.adminTwoFactorChallengeToken!,
      code: '999999'
    });
  } catch (error: any) {
    wrongTotpRejected = error?.code === 'ADMIN_2FA_INVALID_CODE';
  }
  assert(wrongTotpRejected, 'correct password with an invalid TOTP code is rejected');

  // Use a new challenge because the previous failed challenge counts attempts.
  const secondLoginFresh = await beginLogin(admin);
  await AdminTwoFactorModel.updateOne(
    { userId: admin._id },
    { $set: { lastUsedTimeStep: currentStep() - 3 } }
  );
  const loginCode = authenticator.generate(firstLogin.adminTwoFactorSetup!.manualKey);
  const loginResult = await authService.verifyAdminTwoFactor({
    challengeToken: secondLoginFresh.adminTwoFactorChallengeToken!,
    code: loginCode
  });
  assert(!!loginResult.token, 'valid TOTP completes login');
  const secondToken = jwt.decode(loginResult.token!) as any;
  assert(secondToken.jti !== setupToken.jti, 'session identifier is regenerated after successful 2FA');

  console.log('\n[6. Replay and expired challenges are rejected]');
  const replayChallenge = await beginLogin(admin);
  let replayRejected = false;
  try {
    await authService.verifyAdminTwoFactor({
      challengeToken: replayChallenge.adminTwoFactorChallengeToken!,
      code: loginCode
    });
  } catch (error: any) {
    replayRejected = error?.code === 'ADMIN_2FA_REPLAYED_CODE';
  }
  assert(replayRejected, 'already accepted TOTP code is rejected within the same time step');

  const expiringChallenge = await beginLogin(admin);
  await AdminTwoFactorChallengeModel.updateOne(
    {
      challengeId: (jwt.decode(expiringChallenge.adminTwoFactorChallengeToken!) as any).challengeId
    },
    { $set: { expiresAt: new Date(Date.now() - 60_000) } }
  );
  let expiredChallengeRejected = false;
  try {
    await authService.verifyAdminTwoFactor({
      challengeToken: expiringChallenge.adminTwoFactorChallengeToken!,
      code: authenticator.generate(firstLogin.adminTwoFactorSetup!.manualKey)
    });
  } catch (error: any) {
    expiredChallengeRejected =
      error?.code === 'ADMIN_2FA_CHALLENGE_EXPIRED' || error?.message?.includes('expired');
  }
  assert(expiredChallengeRejected, 'expired pre-authentication challenge is rejected');

  console.log('\n[7. Recovery codes are one-time and isolated per admin]');
  const recoveryLogin = await beginLogin(admin);
  const recoveryResult = await authService.verifyAdminTwoFactor({
    challengeToken: recoveryLogin.adminTwoFactorChallengeToken!,
    recoveryCode: setupResult.recoveryCodes![0]
  });
  assert(recoveryResult.recoveryCodeUsed === true, 'recovery code completes admin login');
  const remainingRecovery = await AdminRecoveryCodeModel.countDocuments({
    userId: admin._id,
    usedAt: { $exists: false }
  });
  assert(remainingRecovery === 9, 'used recovery code is invalidated');
  assert(
    (await AdminTwoFactorModel.findOne({ userId: admin._id }))?.enabled === true,
    'recovery-code login does not disable 2FA'
  );

  const reuseRecoveryChallenge = await beginLogin(admin);
  let reusedRecoveryRejected = false;
  try {
    await authService.verifyAdminTwoFactor({
      challengeToken: reuseRecoveryChallenge.adminTwoFactorChallengeToken!,
      recoveryCode: setupResult.recoveryCodes![0]
    });
  } catch (error: any) {
    reusedRecoveryRejected = error?.code === 'ADMIN_2FA_RECOVERY_INVALID';
  }
  assert(reusedRecoveryRejected, 'used recovery code cannot be reused');

  const secondAdmin = await createAdmin('phase19.second-admin@example.com');
  const secondSetup = await completeSetup(secondAdmin);
  const secondAdminChallenge = await beginLogin(secondAdmin);
  let crossAdminRecoveryRejected = false;
  try {
    await authService.verifyAdminTwoFactor({
      challengeToken: secondAdminChallenge.adminTwoFactorChallengeToken!,
      recoveryCode: setupResult.recoveryCodes![1]
    });
  } catch (error: any) {
    crossAdminRecoveryRejected = error?.code === 'ADMIN_2FA_RECOVERY_INVALID';
  }
  assert(crossAdminRecoveryRejected, 'one admin cannot use another admin recovery code');

  let crossAdminTotpRejected = false;
  try {
    await authService.verifyAdminTwoFactor({
      challengeToken: secondAdminChallenge.adminTwoFactorChallengeToken!,
      code: authenticator.generate(firstLogin.adminTwoFactorSetup!.manualKey)
    });
  } catch (error: any) {
    crossAdminTotpRejected = error?.code === 'ADMIN_2FA_INVALID_CODE';
  }
  assert(crossAdminTotpRejected, 'one admin cannot use another admin authenticator secret');

  console.log('\n[8. Failed TOTP attempts lock the admin login]');
  const lockAdmin = await createAdmin('phase19.lock-admin@example.com');
  await completeSetup(lockAdmin);
  let lockHit = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const challenge = await beginLogin(lockAdmin);
      await authService.verifyAdminTwoFactor({
        challengeToken: challenge.adminTwoFactorChallengeToken!,
        code: '000000'
      });
    } catch (error: any) {
      if (error?.statusCode === 429) {
        lockHit = true;
        break;
      }
    }
  }
  assert(lockHit, 'repeated failed TOTP attempts trigger temporary lockout');

  console.log('\n[9. Authorized audited owner recovery]');
  const actor = await UserModel.findById(admin._id);
  await AdminTwoFactorModel.updateOne(
    { userId: admin._id },
    { $set: { lastUsedTimeStep: currentStep() - 3 } }
  );
  const actorCode = authenticator.generate(firstLogin.adminTwoFactorSetup!.manualKey);
  const resetResult = await adminTwoFactorService.resetByOwner({
    actor: actor!,
    targetUserId: secondAdmin._id.toString(),
    actorCode,
    reason: 'Phase 19 lost-device recovery test',
    ip: '127.0.0.1'
  });
  assert(resetResult.targetEmail === secondAdmin.email, 'owner recovery identifies the target admin');
  assert(
    (await AdminTwoFactorModel.findOne({ userId: secondAdmin._id })) === null,
    'owner recovery removes the target authenticator record'
  );
  assert(
    (await AuditLogModel.findOne({
      action: 'ADMIN_2FA_RESET',
      targetUserId: secondAdmin._id
    })) !== null,
    'owner recovery is permanently audit-logged'
  );

  let secondAdminResetLogin: any = null;
  try {
    secondAdminResetLogin = await authService.login({
      identifier: secondAdmin.email,
      password: 'AdminStrongPass123!'
    });
  } catch {
    // not expected
  }
  assert(
    secondAdminResetLogin?.requiresAdmin2FA === true && secondAdminResetLogin?.adminTwoFactorMode === 'SETUP',
    'a reset admin must set up 2FA again on next login'
  );

  console.log('\n[10. Normal user login remains unchanged]');
  const member = await createNormalUser('phase19.member@example.com');
  const memberLogin = await authService.login({
    identifier: member.email,
    password: 'MemberStrongPass123!'
  });
  assert(!!memberLogin.token, 'normal member login still returns a session token');
  assert(!memberLogin.requiresAdmin2FA, 'normal member login is not challenged for admin 2FA');
  const memberToken = jwt.decode(memberLogin.token!) as any;
  assert(!memberToken?.amr?.includes?.('totp'), 'normal member token does not claim admin TOTP');

  console.log('\n[11. Audit trail and encrypted storage checks]');
  const auditActions = await AuditLogModel.distinct('action', { targetUserId: admin._id });
  for (const action of [
    'ADMIN_2FA_SETUP_STARTED',
    'ADMIN_2FA_ENABLED',
    'ADMIN_2FA_LOGIN_SUCCESS',
    'ADMIN_2FA_FAILED',
    'ADMIN_2FA_RECOVERY_CODE_USED'
  ]) {
    assert(auditActions.includes(action), `audit records ${action}`);
  }

  const rawAdmin = await UserModel.findById(admin._id).lean<any>();
  assert(!rawAdmin?.twoFactorSecret, 'no plaintext TOTP secret is stored on the user document');
  assert(
    !JSON.stringify(rawAdmin || {}).includes(firstLogin.adminTwoFactorSetup!.manualKey),
    'manual setup key never appears in the user document'
  );

  console.log('\n=============================================');
  console.log(`  PHASE 19 RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('=============================================\n');

  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  await mongoose.disconnect().catch(() => null);
  await mongod.stop().catch(() => null);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (error) => {
  console.error('Phase 19 crashed:', error);
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve())).catch(() => null);
  }
  await mongoose.disconnect().catch(() => null);
  await mongod?.stop().catch(() => null);
  process.exit(1);
});
