import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { authService } from '../services/auth.service';
import { UserModel } from '../models/User';
import { OtpVerificationModel } from '../models/OtpVerification';
import { OtpPurpose } from '../shared/auth';
import { UserRole } from '../shared/roles';
import { normalizePhoneNumber, isValidE164 } from '../utils/phone';
import { bootstrapMainAdmins } from '../scripts/bootstrap-admins';

let mongod: MongoMemoryServer;

async function setupTestDb() {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  console.log('Test in-memory MongoDB connected.');
}

async function teardownTestDb() {
  await mongoose.disconnect();
  await mongod.stop();
  console.log('Test in-memory MongoDB stopped.');
}

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, errorDetail?: any) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`  ✗ FAIL: ${testName}`, errorDetail || '');
    failedTests++;
  }
}

async function runAuthTests() {
  console.log('\n=============================================');
  console.log('  STARTING COMPREHENSIVE AUTH TEST SUITE');
  console.log('=============================================\n');

  try {
    await setupTestDb();

    // -------------------------------------------------------------
    // TEST 1: Phone Normalization (E.164)
    // -------------------------------------------------------------
    console.log('[Suite 1: Phone Normalization & Validation]');
    const normalizedUS = normalizePhoneNumber('+1 (800) 555-0199');
    assert(normalizedUS === '+18005550199', 'Normalizes formatted US phone to E.164 format (+18005550199)');
    assert(isValidE164(normalizedUS), 'Recognizes +18005550199 as valid E.164');

    let invalidPhoneFailed = false;
    try {
      normalizePhoneNumber('invalid-phone');
    } catch {
      invalidPhoneFailed = true;
    }
    assert(invalidPhoneFailed, 'Rejects invalid phone number strings with validation error');

    // -------------------------------------------------------------
    // TEST 2: Email Registration
    // -------------------------------------------------------------
    console.log('\n[Suite 2: Email Registration Flow]');
    const regRes = await authService.register({
      name: 'Roulette Player',
      email: 'player@example.com',
      password: 'StrongPassword123!'
    });

    assert(regRes.requiresVerification === true, 'Registration requires verification');
    assert(regRes.verificationTarget === 'player@example.com', 'Verification target matches email');
    assert(regRes.user.role === UserRole.USER, 'Assigned role is strictly USER');
    assert(regRes.user.isEmailVerified === false, 'isEmailVerified starts false');

    const createdUser = await UserModel.findOne({ email: 'player@example.com' });
    assert(createdUser !== null, 'User saved in database');
    assert(createdUser?.passwordHash !== 'StrongPassword123!', 'Password is cryptographically hashed');

    // Duplicate email registration prevention
    let duplicateEmailBlocked = false;
    try {
      await authService.register({
        name: 'Another Player',
        email: 'player@example.com',
        password: 'Password123!'
      });
    } catch (err: any) {
      if (err.statusCode === 409 || err.message.includes('already exists')) {
        duplicateEmailBlocked = true;
      }
    }
    assert(duplicateEmailBlocked, 'Rejects duplicate email registration with 409 Conflict');

    // -------------------------------------------------------------
    // TEST 3: Phone Registration
    // -------------------------------------------------------------
    console.log('\n[Suite 3: Phone Registration Flow]');
    const phoneRegRes = await authService.register({
      name: 'Mobile Bettor',
      phone: '+1 (555) 012-3456',
      password: 'MobilePassword99!'
    });

    assert(phoneRegRes.verificationTarget === '+15550123456', 'Normalizes phone input to E.164 (+15550123456)');
    assert(phoneRegRes.user.role === UserRole.USER, 'Role is strictly USER');
    assert(phoneRegRes.user.isPhoneVerified === false, 'isPhoneVerified starts false');

    // Duplicate phone registration prevention
    let duplicatePhoneBlocked = false;
    try {
      await authService.register({
        name: 'Another Mobile',
        phone: '+1 555 012 3456',
        password: 'AnotherPassword1!'
      });
    } catch (err: any) {
      if (err.statusCode === 409 || err.message.includes('already exists')) {
        duplicatePhoneBlocked = true;
      }
    }
    assert(duplicatePhoneBlocked, 'Rejects duplicate phone registration regardless of whitespace/formatting');

    // -------------------------------------------------------------
    // TEST 4: OTP Verification & Attempt Limits (Brute-Force Guard)
    // -------------------------------------------------------------
    console.log('\n[Suite 4: OTP Verification & Brute-Force Rate Limiting]');
    const otpRecord = await OtpVerificationModel.findOne({
      target: 'player@example.com',
      purpose: OtpPurpose.REGISTRATION
    });
    assert(otpRecord !== null, 'OTP verification record exists in DB');
    const validDevCode = otpRecord?.rawCodeDev;
    assert(typeof validDevCode === 'string' && validDevCode.length === 6, 'Generated 6-digit cryptographic OTP');

    // Attempt 1-4 with invalid code
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await authService.verifyOtp({
          target: 'player@example.com',
          code: '000000',
          purpose: OtpPurpose.REGISTRATION
        });
      } catch (err: any) {
        // expected failure
      }
    }
    const recordAfter4 = await OtpVerificationModel.findById(otpRecord?._id);
    assert(recordAfter4?.attempts === 4, 'Failed attempts properly incremented to 4');
    assert(recordAfter4?.isUsed === false, 'Code still active before 5th attempt');

    // Attempt 5 (exceeding maximum 5 attempts)
    try {
      await authService.verifyOtp({
        target: 'player@example.com',
        code: '000000',
        purpose: OtpPurpose.REGISTRATION
      });
    } catch (err: any) {
      // expected failure
    }
    const recordAfter5 = await OtpVerificationModel.findById(otpRecord?._id);
    assert(recordAfter5?.attempts === 5, 'Attempts reached 5');

    // 6th attempt should fail with maximum attempts exceeded and invalidate code
    let maxAttemptsLocked = false;
    try {
      await authService.verifyOtp({
        target: 'player@example.com',
        code: validDevCode!,
        purpose: OtpPurpose.REGISTRATION
      });
    } catch (err: any) {
      if (err.message.includes('Maximum verification attempts exceeded') || err.message.includes('Invalid or expired')) {
        maxAttemptsLocked = true;
      }
    }
    assert(maxAttemptsLocked, 'Max attempts lock invalidated the code even against valid code submission');

    // -------------------------------------------------------------
    // TEST 5: Resend OTP Cooldown
    // -------------------------------------------------------------
    console.log('\n[Suite 5: Resend OTP Cooldown]');

    let cooldownBlocked = false;
    try {
      // Requesting resend immediately after registration (< 60s cooldown)
      await authService.resendOtp({
        target: 'player@example.com',
        purpose: OtpPurpose.REGISTRATION
      });
    } catch (err: any) {
      if (err.message.includes('Please wait') && err.message.includes('seconds')) {
        cooldownBlocked = true;
      }
    }
    assert(cooldownBlocked, 'Resend request within 60s cooldown is rejected');

    // Simulate 61 seconds elapsed
    const freshRecord = await OtpVerificationModel.findOne({
      target: 'player@example.com',
      purpose: OtpPurpose.REGISTRATION
    }).sort({ createdAt: -1 });

    freshRecord!.lastSentAt = new Date(Date.now() - 65 * 1000);
    await freshRecord!.save();

    const allowedResend = await authService.resendOtp({
      target: 'player@example.com',
      purpose: OtpPurpose.REGISTRATION
    });
    assert(allowedResend.success === true, 'Resend succeeds after 60-second cooldown expires');

    // Now verify with new valid code
    const latestOtp = await OtpVerificationModel.findOne({
      target: 'player@example.com',
      purpose: OtpPurpose.REGISTRATION
    }).sort({ createdAt: -1 });

    const verifySuccess = await authService.verifyOtp({
      target: 'player@example.com',
      code: latestOtp!.rawCodeDev!,
      purpose: OtpPurpose.REGISTRATION
    });
    assert(verifySuccess.requiresVerification === false, 'Account successfully verified and activated');
    assert(verifySuccess.user.isEmailVerified === true, 'User isEmailVerified updated to true');

    // Replay attack prevention (single-use enforcement)
    let reuseBlocked = false;
    try {
      await authService.verifyOtp({
        target: 'player@example.com',
        code: latestOtp!.rawCodeDev!,
        purpose: OtpPurpose.REGISTRATION
      });
    } catch (err: any) {
      reuseBlocked = true;
    }
    assert(reuseBlocked, 'Re-using the same OTP code is blocked (single-use enforcement)');

    // -------------------------------------------------------------
    // TEST 6: Login Flow (Email and Phone)
    // -------------------------------------------------------------
    console.log('\n[Suite 6: Multi-Identifier Login Flow]');
    // Email login
    const emailLoginRes = await authService.login({
      identifier: 'player@example.com',
      password: 'StrongPassword123!'
    });
    assert(emailLoginRes.user.email === 'player@example.com', 'Login via email successful');
    assert(typeof emailLoginRes.token === 'string' && emailLoginRes.token.length > 20, 'JWT token returned on email login');

    // Phone login with unformatted identifier
    // First verify phone user
    const phoneOtp = await OtpVerificationModel.findOne({
      target: '+15550123456',
      purpose: OtpPurpose.REGISTRATION
    }).sort({ createdAt: -1 });

    await authService.verifyOtp({
      target: '+15550123456',
      code: phoneOtp!.rawCodeDev!,
      purpose: OtpPurpose.REGISTRATION
    });

    const phoneLoginRes = await authService.login({
      identifier: '1-555-012-3456', // formatted input
      password: 'MobilePassword99!'
    });
    assert(phoneLoginRes.user.phone === '+15550123456', 'Login via formatted phone number successful');

    // Invalid password rejection
    let wrongPasswordBlocked = false;
    try {
      await authService.login({
        identifier: 'player@example.com',
        password: 'IncorrectPassword'
      });
    } catch (err: any) {
      if (err.statusCode === 401) {
        wrongPasswordBlocked = true;
      }
    }
    assert(wrongPasswordBlocked, 'Incorrect password rejected with 401 Unauthorized');

    // -------------------------------------------------------------
    // TEST 7: Password Reset Flow & Account Enumeration Protection
    // -------------------------------------------------------------
    console.log('\n[Suite 7: Password Reset Flow & Account Enumeration Guard]');
    // Existing user
    const existingForgot = await authService.forgotPassword({ target: 'player@example.com' });
    // Non-existing user
    const nonExistingForgot = await authService.forgotPassword({ target: 'nonexistent@example.com' });
    assert(
      existingForgot.message === nonExistingForgot.message,
      'Generic response prevents account enumeration for nonexistent users'
    );

    // Reset password with code
    const resetOtpRecord = await OtpVerificationModel.findOne({
      target: 'player@example.com',
      purpose: OtpPurpose.PASSWORD_RESET
    }).sort({ createdAt: -1 });

    const resetRes = await authService.resetPassword({
      target: 'player@example.com',
      code: resetOtpRecord!.rawCodeDev!,
      newPassword: 'BrandNewPassword2026!'
    });
    assert(resetRes.success === true, 'Password reset succeeded with valid OTP');

    // Old password should fail
    let oldPasswordRejected = false;
    try {
      await authService.login({
        identifier: 'player@example.com',
        password: 'StrongPassword123!'
      });
    } catch {
      oldPasswordRejected = true;
    }
    assert(oldPasswordRejected, 'Old password is no longer valid');

    // New password should work
    const newPasswordLogin = await authService.login({
      identifier: 'player@example.com',
      password: 'BrandNewPassword2026!'
    });
    assert(newPasswordLogin.user.email === 'player@example.com', 'Login succeeds with newly set password');

    // -------------------------------------------------------------
    // TEST 8: First-Time Owner Bootstrap & Main Admin Security
    // -------------------------------------------------------------
    console.log('\n[Suite 8: Designated Main Admin Bootstrap]');
    await bootstrapMainAdmins(false);
    const adminCount = await UserModel.countDocuments({ role: UserRole.SUPER_ADMIN });
    assert(adminCount >= 1, 'Designated Main Admin account initialized in database');

    // Second execution must be permanently disabled
    await bootstrapMainAdmins(false);
    const adminCountAfterSecond = await UserModel.countDocuments({ role: UserRole.SUPER_ADMIN });
    assert(adminCountAfterSecond === adminCount, 'Bootstrap procedure is locked and maintains Main Admin');

    // -------------------------------------------------------------
    // TEST 9: Update Profile (Name & Phone) Immediate DB Save
    // -------------------------------------------------------------
    console.log('\n[Suite 9: Update Profile (Name & Phone)]');
    const playerUser = await UserModel.findOne({ email: 'player@example.com' });
    assert(playerUser !== null, 'Player user found for profile update');
    if (playerUser) {
      const updatedProfile = await authService.updateProfile(playerUser._id.toString(), {
        name: 'Mahfuzul Pro Player',
        phone: '+18005550888'
      });
      assert(updatedProfile.name === 'Mahfuzul Pro Player', 'Profile name saved to database');
      assert(updatedProfile.phone === '+18005550888', 'Profile phone saved to database');

      // Verify directly in DB
      const freshUser = await UserModel.findById(playerUser._id);
      assert(freshUser?.name === 'Mahfuzul Pro Player', 'Direct DB verification: name updated');
      assert(freshUser?.phone === '+18005550888', 'Direct DB verification: phone updated');
    }

  } finally {
    await teardownTestDb();
  }

  console.log('\n=============================================');
  console.log(`  TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('=============================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAuthTests().catch((err) => {
  console.error('Test execution failed with fatal error:', err);
  process.exit(1);
});
