# NOWPayments Integration — Complete Setup, Webhook & Operations Guide

Last updated: 2026-11-16

This document describes the production integration that is actually implemented in this repository. It does not contain credentials.

---

## 1. Architecture Summary

| Layer | Technology | Location |
| :--- | :--- | :--- |
| Frontend | Next.js (App Router) | `frontend/` |
| Backend | Express.js + TypeScript | `backend/` |
| Database | MongoDB + Mongoose | `backend/src/models/` |
| Auth | Existing JWT / Better Auth session | `backend/src/middleware/auth.middleware.ts` |
| Provider | NOWPayments hosted invoice + signed IPN | `backend/src/services/nowpayments.service.ts` |
| Payment orchestration | Server-authoritative plans, orders, webhook, subscriptions | `backend/src/services/payment.service.ts` |

The existing `Payment` collection already represented both the order snapshot and the provider payment. It was extended with provider/verification fields instead of creating a duplicate `orders` collection. Existing users, plans, subscriptions, referral commissions, financial ledger, admin screens and authentication were preserved.

---

## 2. Production URLs

| Purpose | URL |
| :--- | :--- |
| Frontend | `https://accuracy.tools` |
| Backend | `https://our-project-bk.vercel.app` |
| **Canonical NOWPayments IPN URL** | **`https://our-project-bk.vercel.app/api/nowpayments/webhook`** |
| Frontend proxy alias (optional) | `https://accuracy.tools/api/nowpayments/webhook` |
| Versioned alias | `https://our-project-bk.vercel.app/api/v1/payments/nowpayments/webhook` |
| Specification alias | `https://our-project-bk.vercel.app/api/payments/nowpayments/webhook` |
| Legacy alias | `https://our-project-bk.vercel.app/api/v1/payments/ipn` |

Set the canonical URL in the NOWPayments dashboard. All aliases call the same verified handler.

> The frontend domain cannot directly run Express code. The optional Next.js route at `frontend/src/app/api/nowpayments/webhook/route.ts` forwards the raw body and `x-nowpayments-sig` header to the backend, where the signature is verified. The backend URL is recommended because it removes one network hop.

---

## 3. Environment Variables

Add these to the backend deployment (Vercel Project Settings → Environment Variables). Never add secrets to the frontend.

```env
# Provider mode: sandbox | production
NOWPAYMENTS_ENV=sandbox

# Sandbox credentials from https://sandbox.nowpayments.io
# Production credentials from https://account.nowpayments.io
NOWPAYMENTS_API_KEY=your_sandbox_api_key
NOWPAYMENTS_IPN_SECRET=your_sandbox_ipn_secret

# Official hosts. In sandbox mode the backend always uses the official sandbox host.
NOWPAYMENTS_API_URL=https://api-sandbox.nowpayments.io/v1

# Live transactions are blocked until these are explicitly enabled.
NOWPAYMENTS_LIVE_ENABLED=false
NOWPAYMENTS_REQUIRE_API_VERIFICATION=true
NOWPAYMENTS_API_TIMEOUT_MS=15000

# Public HTTPS webhook
PAYMENT_IPN_CALLBACK_URL=https://our-project-bk.vercel.app/api/nowpayments/webhook

# Checkout redirects
PAYMENT_SUCCESS_URL=https://accuracy.tools/checkout/success
PAYMENT_CANCEL_URL=https://accuracy.tools/checkout/failed
PAYMENT_PENDING_URL=https://accuracy.tools/checkout/pending

# Public site/backend configuration
PUBLIC_WEBSITE_URL=https://accuracy.tools
FRONTEND_URL=https://accuracy.tools
BACKEND_URL=https://our-project-bk.vercel.app
CORS_ORIGIN=https://accuracy.tools,https://www.accuracy.tools
```

Frontend-only server variable, required only if you use the optional proxy alias:

```env
BACKEND_URL=https://our-project-bk.vercel.app
```

Do not add `NOWPAYMENTS_API_KEY` or `NOWPAYMENTS_IPN_SECRET` to the frontend.

### Sandbox vs production

- Sandbox API: `https://api-sandbox.nowpayments.io/v1`
- Production API: `https://api.nowpayments.io/v1`
- Sandbox and production credentials are not interchangeable.
- Production orders are blocked while `NOWPAYMENTS_LIVE_ENABLED=false`.
- Do not enable live transactions until provider eligibility and legal authorization are confirmed.

---

## 4. Authoritative Plans

Prices are read from the database/plan catalogue on the server. The frontend sends only a `planId`. Never trust a client-supplied amount.

| Plan ID | Name | Duration | Price |
| :--- | :--- | :--- | :--- |
| `PLAN_15_DAYS` | 15 Days Pass | 15 days | $150 |
| `PLAN_1_MONTH` | 1 Month Pro | 1 calendar month | $200 |
| `PLAN_3_MONTHS` | 3 Months Master | 3 calendar months | $450 |
| `PLAN_6_MONTHS` | 6 Months Elite | 6 calendar months | $700 |
| `PLAN_1_YEAR` | 1 Year VIP Annual | 12 calendar months | $1,000 |

---

## 5. Webhook Signature Verification

NOWPayments signs the IPN body with HMAC-SHA512 using the IPN secret.

Implementation (`backend/src/services/nowpayments.service.ts`):

1. Recursively sort every object key alphabetically.
2. Serialize the sorted object with `JSON.stringify`.
3. Compute `HMAC-SHA512(secret, serializedPayload)` and hex-encode it.
4. Compare it to the `x-nowpayments-sig` header using `crypto.timingSafeEqual`.
5. Reject missing, malformed, non-hex, or mismatched signatures with HTTP 401.

The IPN secret is loaded only from the backend environment. It is never logged or sent to the browser.

---

## 6. Webhook Processing Pipeline

`POST /api/nowpayments/webhook`

1. Verify the HMAC signature.
2. Build a deterministic SHA-256 event ID from the canonical payload.
3. Insert/lock a `PaymentEvent` document. The unique `providerEventId` index prevents exact replays, including concurrent retries.
4. Find the order by `order_id`, provider payment ID, invoice ID, or internal payment ID.
5. Reject unknown orders safely with HTTP 200 (prevents retry storms) and record an `IGNORED` event.
6. Reject a mismatched provider payment ID, invoice ID, amount, or currency and place the order into `REVIEW_REQUIRED`.
7. Record the provider status and transaction hash.
8. For `finished` only:
   - Validate expected vs actual pay amount (0.5% rounding tolerance; overpayments do not extend access).
   - Re-fetch the payment from `GET /v1/payment/{payment_id}` when an API key is configured.
   - Require the provider to report `finished`, the same `order_id`, the same USD price/currency, and a valid paid amount.
   - Atomically claim the order (`isFulfilled: false` → `PROCESSING`).
   - Create exactly one subscription for that payment.
   - Mark the order `FINISHED` / `FULFILLED`, write the ledger entry, create the notification, and credit any existing moderator commission.
9. Invalid signatures return 401. Provider/network failures return 5xx so NOWPayments retries.
10. If the order was already fulfilled, later `waiting`, `confirming`, `sending`, `failed`, or `expired` events never downgrade or re-activate it.

### Status matrix

| NOWPayments status | Internal status | Premium access |
| :--- | :--- | :--- |
| `waiting` | `WAITING` | No |
| `confirming` | `CONFIRMING` | No |
| `confirmed` | `CONFIRMED` | **No** — awaiting final settlement |
| `sending` | `SENDING` | No |
| `partially_paid` | `PARTIALLY_PAID` | No |
| `finished` | `FINISHED` | **Yes**, after all checks |
| `failed` | `FAILED` | No |
| `expired` | `EXPIRED` | No |
| `refunded` | `REFUNDED` | Linked subscription is revoked |

---

## 7. Duplicate & Replay Protection

Three independent layers:

1. **`PaymentEvent.providerEventId`** — unique SHA-256 of the canonical payload. Exact duplicate → one event only.
2. **`Payment.fulfillmentStatus`** — atomic claim (`NONE` → `PROCESSING` → `FULFILLED`). Concurrent workers cannot both activate.
3. **Subscription lookup by `paymentId`** — if a worker crashes after creating the subscription but before marking the payment fulfilled, a retry reuses that subscription instead of creating or extending a second one.

Result: the same webhook cannot activate Premium twice or extend a subscription twice.

### Subscription extension rule

- No active subscription: starts now, expires after the purchased duration.
- Active subscription: starts now for UI purposes, but the expiry is calculated from the existing paid-through date, so no days are lost.
- Refund: only the subscription linked to the refunded payment is revoked. Other passes remain intact.

---

## 8. API Endpoints

### User

| Method | Path | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/payments/create` | Bearer | Create server-priced order + NOWPayments invoice |
| `POST` | `/api/v1/payments/create-order` | Bearer | Backward-compatible alias |
| `GET` | `/api/v1/payments/:id` | Bearer | Status by order number / payment id / invoice id |
| `GET` | `/api/v1/payments/history` | Bearer | Own payment history |
| `GET` | `/api/v1/payments/order/:orderId` | Bearer | Legacy order status |
| `GET` | `/api/v1/subscriptions/my-subscription` | Bearer | Current subscription + history |
| `GET` | `/api/v1/subscriptions/me` | Bearer | Specification alias |

Additional exact aliases: `POST /api/payments/create`, `GET /api/payments/history`, `GET /api/payments/:id`, `GET /api/subscriptions/me`.

### Webhook

| Method | Path | Auth |
| :--- | :--- | :--- |
| `POST` | `/api/nowpayments/webhook` | HMAC signature |
| `POST` | `/api/payments/nowpayments/webhook` | HMAC signature |
| `POST` | `/api/webhooks/nowpayments` | HMAC signature |
| `POST` | `/api/v1/payments/nowpayments/webhook` | HMAC signature |
| `POST` | `/api/v1/payments/ipn` | HMAC signature |

No login, cookie, or CSRF token is required.

### Admin (Super Admin only)

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/v1/payments/admin/orders` | Search / filter / paginate all transactions |
| `GET` | `/api/v1/payments/admin/orders/:orderId` | Full transaction details + webhook events |
| `GET` | `/api/v1/payments/admin/summary` | Revenue and status counts |
| `GET` | `/api/v1/payments/admin/health` | Provider/webhook configuration health (no secrets) |
| `GET` | `/api/v1/payments/admin/export?format=csv` | Reconciliation CSV |

Manual subscription grant, extension, revocation and unban remain at `/api/v1/subscriptions/admin/*` and are audit-logged.

---

## 9. Database Changes

### `payments` (extended)

Provider fields: `provider`, `providerInvoiceId`, `providerPaymentId`, `providerStatus`, `paymentMethod`, `transactionId`, `payCurrencyLocked`.

Verification fields: `signatureVerified`, `providerVerified`, `verified`, `verifiedAt`, `paidAt`, `expiresAt`, `refundedAt`, `overpaymentAmount`, `webhookEventCount`, `lastWebhookAt`.

Idempotency fields: `fulfillmentStatus`, `processingStartedAt`.

Indexes include unique `orderId`, unique `paymentId`, a unique compound partial index on `provider + providerPaymentId`, and search/status/date indexes.

### `payment_events` (new)

`provider`, unique `providerEventId`, `paymentId`, `providerPaymentId`, `orderId`, `eventType`, `processingStatus`, `signatureValid`, `errorMessage`, `receivedAt`, `processedAt`, `rawPayload`.

### `subscriptions` (extended)

Added `orderId`, `provider`, `autoRenew`; `providerPaymentId` already existed. Indexes added for `paymentId` and `orderId`.

No duplicate `users` collection was created.

---

## 10. Testing

From `backend/`:

```bash
npm run typecheck
npm run test:phase5        # existing payment lifecycle
npm run test:nowpayments   # webhook security + idempotency end-to-end
npm test                   # full regression suite
```

`test:nowpayments` uses an in-memory MongoDB and a fixed test-only IPN secret. It never calls a real NOWPayments account.

Covered scenarios:

- Missing signature → 401
- Invalid signature → 401
- `waiting` / `confirmed` do not activate
- `finished` activates exactly once
- Duplicate exact webhook
- Same status with a changed timestamp
- Six concurrent duplicate webhooks
- Wrong amount
- Wrong currency
- Unknown order
- Failed / expired / partially paid
- Refund revokes the linked subscription
- API aliases
- Unauthenticated access and cross-user access attempts

### Manual signature test (PowerShell)

Never paste your real secret into a shared terminal history. Run this only on a trusted machine with a test secret:

```powershell
$body = '{"payment_id":123,"payment_status":"waiting","price_amount":200,"price_currency":"usd","order_id":"ORD_TEST"}'
$secret = 'YOUR_TEST_IPN_SECRET'
$sorted = $body | ConvertFrom-Json | ConvertTo-Json -Compress
$hmac = [System.Security.Cryptography.HMACSHA512]::new([Text.Encoding]::UTF8.GetBytes($secret))
$sig = -join ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($sorted)) | ForEach-Object { $_.ToString('x2') })
Invoke-WebRequest -Uri 'https://our-project-bk.vercel.app/api/nowpayments/webhook' -Method POST -ContentType 'application/json' -Headers @{ 'x-nowpayments-sig' = $sig } -Body $sorted
```

Note: this simplified test only works if the serialized key order matches the backend canonicalization. The automated test suite is authoritative.

### Real sandbox payment test

1. Set `NOWPAYMENTS_ENV=sandbox` and use sandbox API key + IPN secret in the backend deployment.
2. Set `NOWPAYMENTS_LIVE_ENABLED=false` for sandbox. This flag only gates production mode; sandbox checkout works without it.
3. Set `PAYMENT_IPN_CALLBACK_URL=https://our-project-bk.vercel.app/api/nowpayments/webhook`.
4. Redeploy the backend.
5. Open the admin Payments page and confirm:
   - Provider API key: configured
   - IPN secret: configured
   - Provider reachable: yes
   - Webhook URL correct
6. Log in as a normal user, choose a plan, complete the sandbox invoice.
7. Watch `payments`, `payment_events`, and `subscriptions` update:
   - `waiting` → no subscription
   - `confirmed` → no subscription
   - `finished` → one ACTIVE subscription
8. Replay the same IPN with the same signature → duplicate, still one subscription.

---

## 11. Deployment Checklist

- [ ] Set `NODE_ENV=production` in the backend Vercel project. The currently deployed `/health` endpoint has previously reported `environment: development`; correct this so the production live-mode guard and database index policy behave as intended.
- [ ] Backend Vercel environment variables updated (sandbox or production set consistently).
- [ ] API key and IPN secret belong to the same NOWPayments environment as `NOWPAYMENTS_ENV`.
- [ ] `PAYMENT_IPN_CALLBACK_URL` is public HTTPS and not localhost.
- [ ] NOWPayments dashboard IPN URL set to `https://our-project-bk.vercel.app/api/nowpayments/webhook`.
- [ ] MongoDB indexes deployed. The backend calls `ensurePaymentIndexes()` on startup (including serverless cold starts) to create the critical unique indexes; verify the admin health panel reports `Indexes: ready`.
- [ ] Frontend `NEXT_PUBLIC_API_URL=https://our-project-bk.vercel.app/api/v1`.
- [ ] Frontend `CORS_ORIGIN` includes `https://accuracy.tools`.
- [ ] Frontend `BACKEND_URL` set if the proxy alias is used.
- [ ] `NOWPAYMENTS_LIVE_ENABLED=false` until eligibility/legal review is complete.
- [ ] Admin health panel shows API key, IPN secret, provider reachability and webhook URL as healthy.
- [ ] Test one sandbox payment end-to-end before enabling live mode.

---

## 12. Security Notes

- Secrets remain backend-only.
- Webhook processing is fail-closed: if provider re-verification is required and unavailable, Premium is not granted and NOWPayments is asked to retry.
- Frontend redirects never activate Premium.
- Every user payment lookup enforces ownership; admin access requires `SUPER_ADMIN`.
- Amount, currency, order ID, provider payment ID, and transaction hash are validated server-side.
- Webhook payloads are stored for audit, but secrets and API keys are never stored or logged.
- Provider credentials are never returned by the admin health endpoint.
