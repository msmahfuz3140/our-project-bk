import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { app } from '../app';
import { UserModel } from '../models/User';
import { UserRole } from '../shared/roles';
import { hashPassword } from '../utils/crypto';
import { seedPlansIfEmpty } from '../models/Plan';

const PORT = 5080;
let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}`, detail ?? '');
    failed++;
  }
}

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await seedPlansIfEmpty();

  await UserModel.create({
    name: 'Audit Admin',
    email: 'audit.admin@example.com',
    passwordHash: await hashPassword('AuditPass123!'),
    role: UserRole.SUPER_ADMIN,
    isEmailVerified: true,
    isActive: true,
    accountStatus: 'ACTIVE'
  });
  await UserModel.create({
    name: 'Audit Member',
    email: 'audit.member@example.com',
    passwordHash: await hashPassword('MemberPass123!'),
    role: UserRole.USER,
    isEmailVerified: true,
    isActive: true,
    accountStatus: 'ACTIVE'
  });

  const server = app.listen(PORT);
  const base = `http://127.0.0.1:${PORT}`;
  const allowedOrigin = 'http://localhost:3000';

  try {
    console.log('\n[1. Health payload minimization]');
    for (const path of ['/health', '/api/v1/health']) {
      const res = await fetch(`${base}${path}`);
      const body: any = await res.json();
      const keys = Object.keys(body.data || {}).sort();
      assert(res.status === 200, `${path} returns 200`);
      assert(
        JSON.stringify(keys) === JSON.stringify(['ready', 'status', 'timestamp']),
        `${path} exposes only status, ready, timestamp`,
        keys
      );
    }

    console.log('\n[2. CORS crash protection]');
    const evil = await fetch(`${base}/api/v1/admin/users`, {
      headers: { Origin: 'https://evil.example' }
    });
    const evilBody: any = await evil.json().catch(() => ({}));
    assert(evil.status === 403, 'disallowed origin receives 403 (not 500)', evil.status);
    assert(
      evilBody?.error?.code === 'CORS_ORIGIN_REJECTED',
      'disallowed origin error code is CORS_ORIGIN_REJECTED',
      evilBody
    );
    const malformed = await fetch(`${base}/api/v1/admin/users`, {
      headers: { Origin: 'not a url' }
    });
    assert(malformed.status === 403, 'malformed origin receives 403 (not 500)', malformed.status);

    const lookalike = await fetch(`${base}/api/v1/admin/users`, {
      headers: { Origin: 'https://accuracy-evil.vercel.app' }
    });
    assert(lookalike.status === 403, 'lookalike Vercel origin is not trusted', lookalike.status);

    console.log('\n[3. Malformed JSON handling]');
    const badJson = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { Origin: allowedOrigin, 'Content-Type': 'application/json' },
      body: '{"identifier":'
    });
    const badJsonBody: any = await badJson.json().catch(() => ({}));
    assert(badJson.status === 400, 'malformed JSON returns 400', badJson.status);
    assert(badJsonBody?.error?.code === 'INVALID_JSON', 'malformed JSON has INVALID_JSON code', badJsonBody);

    console.log('\n[4. HttpOnly session cookie flow]');
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        Origin: allowedOrigin,
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'same-origin'
      },
      body: JSON.stringify({
        identifier: 'audit.member@example.com',
        password: 'MemberPass123!',
        turnstileToken: 'test_mock_turnstile_token'
      })
    });
    const loginBody: any = await login.json();
    const rawSetCookie = login.headers.get('set-cookie') || '';
    assert(login.status === 200, 'login succeeds', login.status);
    assert(
      !JSON.stringify(loginBody).includes('mustChangePassword'),
      'login response omits mustChangePassword from the public payload'
    );
    assert(rawSetCookie.includes('sloot_token='), 'login sets sloot_token cookie');
    assert(/HttpOnly/i.test(rawSetCookie), 'session cookie is HttpOnly', rawSetCookie);
    assert(/SameSite=Strict/i.test(rawSetCookie), 'session cookie is SameSite=Strict', rawSetCookie);
    assert(rawSetCookie.includes('sloot_auth=1'), 'non-secret session hint cookie is set');

    const cookie = rawSetCookie
      .split(/,(?=[^;]+=)/)
      .map((part) => part.split(';')[0].trim())
      .filter((part) => part.startsWith('sloot_'))
      .join('; ');

    const me = await fetch(`${base}/api/v1/auth/me`, { headers: { Cookie: cookie } });
    const meBody: any = await me.json();
    assert(me.status === 200, 'cookie-authenticated /auth/me succeeds', me.status);
    assert(meBody?.data?.email === 'audit.member@example.com', '/auth/me returns the cookie user');

    const rbac = await fetch(`${base}/api/v1/admin/users`, {
      headers: { Cookie: cookie, Origin: allowedOrigin }
    });
    assert(rbac.status === 403, 'normal member is forbidden from admin users API', rbac.status);

    const cookieWrite = await fetch(`${base}/api/v1/auth/profile`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        Origin: allowedOrigin,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'Audit Member Updated' })
    });
    assert(cookieWrite.status === 200, 'same-origin cookie write is accepted', cookieWrite.status);

    const csrf = await fetch(`${base}/api/v1/auth/profile`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        Origin: 'https://evil.example',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'Should Not Apply' })
    });
    assert(csrf.status === 403, 'cross-site cookie write is blocked by CSRF guard', csrf.status);

    const logout = await fetch(`${base}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: allowedOrigin }
    });
    const logoutCookie = logout.headers.get('set-cookie') || '';
    assert(logout.status === 200, 'logout succeeds', logout.status);
    assert(
      /sloot_token=;|sloot_token=;|Expires=Thu, 01 Jan 1970/i.test(logoutCookie),
      'logout clears the session cookie',
      logoutCookie
    );

    console.log('\n[5. Login rate limit returns 429]');
    let rateStatus = 0;
    let rateBody: any = null;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { Origin: allowedOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'rate.limit@example.com',
          password: 'WrongPassword123!',
          turnstileToken: 'test_mock_turnstile_token'
        })
      });
      rateStatus = res.status;
      rateBody = await res.json().catch(() => null);
    }
    assert(rateStatus === 429, '11th login attempt is rate limited with 429', rateStatus);
    assert(rateBody?.error?.code === 'RATE_LIMIT_EXCEEDED', 'rate-limit error code', rateBody);

    console.log('\n[6. Uniform login response]');
    const unknown = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { Origin: allowedOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: 'missing.user@example.com',
        password: 'Whatever123!',
        turnstileToken: 'test_mock_turnstile_token'
      })
    });
    const unknownBody: any = await unknown.json().catch(() => null);
    assert(unknown.status === 401, 'unknown account receives 401', unknown.status);
    assert(
      unknownBody?.error?.message === 'Invalid email/phone or password',
      'unknown account gets the same generic message',
      unknownBody
    );

    console.log('\n[7. Protected endpoint and validation smoke checks]');
    const unauthenticatedOrder = await fetch(`${base}/api/v1/payments/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: 'PLAN_1_MONTH' })
    });
    assert(
      unauthenticatedOrder.status === 401,
      'payment order creation requires authentication',
      unauthenticatedOrder.status
    );

    const unauthenticatedStaff = await fetch(`${base}/api/v1/admin/users/create-staff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-a-real-admin@example.com' })
    });
    assert(
      unauthenticatedStaff.status === 401,
      'staff creation requires authentication',
      unauthenticatedStaff.status
    );

    const invalidRegister = await fetch(`${base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: allowedOrigin },
      body: JSON.stringify({ email: 1 })
    });
    const invalidRegisterBody: any = await invalidRegister.json().catch(() => null);
    assert(invalidRegister.status === 400, 'invalid registration returns 400, not a crash', invalidRegister.status);
    assert(
      invalidRegisterBody?.error?.code === 'VALIDATION_ERROR',
      'invalid registration returns a validation error',
      invalidRegisterBody
    );

    console.log('\n[8. Forgot-password response uniformity]');
    const forgotReal = await fetch(`${base}/api/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: allowedOrigin },
      body: JSON.stringify({
        target: 'audit.member@example.com',
        turnstileToken: 'test_mock_turnstile_token'
      })
    });
    const forgotRealBody = await forgotReal.text();
    const forgotFake = await fetch(`${base}/api/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: allowedOrigin },
      body: JSON.stringify({
        target: 'missing.user@example.com',
        turnstileToken: 'test_mock_turnstile_token'
      })
    });
    const forgotFakeBody = await forgotFake.text();
    assert(
      forgotReal.status === 200 && forgotFake.status === 200,
      'forgot-password returns 200 for both real and unknown accounts',
      { real: forgotReal.status, fake: forgotFake.status }
    );
    assert(
      forgotRealBody === forgotFakeBody,
      'forgot-password responses are byte-identical for real and unknown accounts'
    );
  } finally {
    server.close();
    await mongoose.disconnect().catch(() => null);
    await mongod.stop().catch(() => null);
  }

  console.log(`\nSECURITY AUDIT RESULTS: ${passed} PASSED, ${failed} FAILED\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => null);
  process.exit(1);
});
