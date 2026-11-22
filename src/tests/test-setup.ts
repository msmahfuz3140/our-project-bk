/**
 * Preloaded before every backend test suite.
 *
 * Tests must never call a real NOWPayments account, never use production
 * credentials from the developer's local .env, and must have a deterministic
 * IPN secret. dotenv does not override variables that already exist, so these
 * values win over .env.
 */
process.env.NODE_ENV = 'test';
process.env.NOWPAYMENTS_ENV = 'sandbox';
process.env.NOWPAYMENTS_API_KEY = '';
process.env.NOWPAYMENTS_IPN_SECRET = 'test_ipn_secret_nowpayments_mock_secure_hash_key_12345';
process.env.NOWPAYMENTS_REQUIRE_API_VERIFICATION = 'false';
process.env.NOWPAYMENTS_LIVE_ENABLED = 'true';
process.env.PAYMENT_IPN_CALLBACK_URL = 'https://our-project-bk.vercel.app/api/nowpayments/webhook';
process.env.PAYMENT_SUCCESS_URL = 'https://accuracy.tools/checkout/success';
process.env.PAYMENT_CANCEL_URL = 'https://accuracy.tools/checkout/failed';
process.env.LOG_LEVEL = 'ERROR';
process.env.SMTP_HOST = '';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.SMTP_FROM_EMAIL = '';
process.env.EMAIL_PROVIDER_API_KEY = '';
process.env.OTP_EXPIRY_MINUTES = '10';
process.env.OTP_RESEND_COOLDOWN_SECONDS = '60';
process.env.OTP_MAX_ATTEMPTS = '5';
process.env.OTP_MAX_RESENDS_PER_HOUR = '5';
process.env.ADMIN_2FA_ENCRYPTION_KEY = 'test_admin_2fa_encryption_key_64_characters_long_deterministic_value_1234567890';
process.env.ADMIN_2FA_ISSUER = 'Roulette Accuracy Admin Test';
process.env.ADMIN_2FA_CHALLENGE_TTL_SECONDS = '600';
process.env.ADMIN_2FA_MAX_ATTEMPTS = '5';
process.env.ADMIN_2FA_LOCK_MINUTES = '15';
process.env.ADMIN_2FA_RECOVERY_CODE_COUNT = '10';
// Deterministic admin bootstrap for the in-memory test suites.
process.env.MAIN_ADMIN_EMAILS =
  'admin1@rouletteaccuracy.com,admin2@rouletteaccuracy.com,admin3@rouletteaccuracy.com,admin4@rouletteaccuracy.com';
process.env.INITIAL_ADMIN_PASSWORD = 'TestBootstrapPassword123!';

export {};
