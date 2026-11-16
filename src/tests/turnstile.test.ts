import { turnstileService } from '../services/turnstile.service';

let passed = 0;
let failed = 0;

function assert(condition: boolean, desc: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${desc}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${desc}`);
    failed++;
  }
}

async function runTurnstileTests() {
  console.log('\n=============================================');
  console.log('  STARTING CLOUDFLARE TURNSTILE TEST SUITE');
  console.log('=============================================\n');

  // Test 1: Missing token rejection
  console.log('[Suite 1: Missing Token Handling]');
  const missingRes = await turnstileService.verifyToken('');
  assert(missingRes.success === false, 'Rejects empty token');
  assert(missingRes.errorCodes?.includes('missing-input-response') === true, 'Returns missing-input-response error code');

  const nullRes = await turnstileService.verifyToken(null as any);
  assert(nullRes.success === false, 'Rejects null token');

  // Test 2: Test mock token handling
  console.log('\n[Suite 2: Mock Token Handling]');
  const mockRes = await turnstileService.verifyToken('test_mock_turnstile_token');
  assert(mockRes.success === true, 'Accepts test mock token in test mode');
  assert(mockRes.bypassed === true, 'Marks mock token as bypassed');

  console.log(`\nTurnstile Tests Completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

void runTurnstileTests();
