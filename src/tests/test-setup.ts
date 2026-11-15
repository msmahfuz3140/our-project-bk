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

export {};
