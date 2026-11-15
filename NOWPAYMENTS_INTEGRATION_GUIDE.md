# NOWPayments Production Integration & Lifecycle Guide

## 1. Executive Summary & Policy Compliance
The Roulette Prediction Platform integrates with **NOWPayments** for non-custodial cryptocurrency subscription purchases.
- **Strict Non-Custodial Architecture**: The platform functions strictly as a subscription SaaS.
- **NO WITHDRAWAL FEATURE**: In accordance with platform governance and security mandates, **no withdrawal feature exists or will be implemented**. All customer payments are non-refundable subscription settlements, and all moderator referral earnings are tracked on an accounting ledger without on-platform custodial withdrawal endpoints.
- **Cryptographic Webhook Verification**: Client redirects are never treated as proof of payment. Tool access is unlocked exclusively after server-side HMAC-SHA512 IPN signature verification and state qualification (`finished` or `confirmed`).

---

## 2. NOWPayments Account Configuration

### A. Production Account Setup
1. Register an account at [NOWPayments.io](https://nowpayments.io).
2. Complete KYC/KYB if required by your operating jurisdiction.
3. Add your outcome payout wallet address (e.g. USDT-TRC20, BTC, or ETH) under **Store Settings → Payout Settings**.
4. Generate an **API Key** under **Store Settings → API Keys**.
5. Generate an **IPN Secret Key** under **Store Settings → Instant Payment Notifications (IPN)**.

### B. Sandbox Account Setup (for Staging / Integration Testing)
- URL: [sandbox.nowpayments.io](https://sandbox.nowpayments.io)
- Generate sandbox API Key and IPN Secret.
- Sandbox endpoint: `https://api-sandbox.nowpayments.io/v1`
- Production endpoint: `https://api.nowpayments.io/v1`

---

## 3. Environment Variables Configuration

Set these variables in `roulette-accuracy-backend/.env`:

```env
# NOWPayments Credentials
NOWPAYMENTS_API_KEY=your_nowpayments_api_key_here
NOWPAYMENTS_IPN_SECRET=your_nowpayments_ipn_secret_here
NOWPAYMENTS_API_URL=https://api.nowpayments.io/v1

# Platform URL Settings (Used for IPN callback & checkout redirects)
PORT=5050
CORS_ORIGIN=http://localhost:3000
PUBLIC_API_URL=https://api.yourdomain.com/api/v1
```

*Note: In development, if `NOWPAYMENTS_API_KEY` is empty, the platform automatically runs in safe simulation mode.*

---

## 4. IPN Callback URL Setup

### Webhook Endpoint Details
- **HTTP Method**: `POST`
- **Path**: `/api/v1/payments/ipn`
- **Full Production URL**: `https://api.yourdomain.com/api/v1/payments/ipn`
- **Authentication**: Verified via `x-nowpayments-sig` header (HMAC-SHA512).

### Callback Flow Diagram
```
Customer Browser           Platform Backend                 NOWPayments Gateway
       |                          |                                   |
       |--- 1. Selects Plan ----->|                                   |
       |                          |--- 2. POST /v1/invoice ---------->|
       |<-- 3. Checkout URL ------|<-- 4. Returns Invoice/PayAddr ----|
       |                          |                                   |
       |--- 5. Sends Crypto on Blockchain --------------------------->|
       |                          |                                   |
       |                          |<-- 6. POST /api/v1/payments/ipn --|
       |                          |    (Header: x-nowpayments-sig)    |
       |                          |                                   |
       |                          |--- 7. Verify HMAC-SHA512 Sig      |
       |                          |--- 8. Verify Amount & Currency    |
       |                          |--- 9. Check Idempotency           |
       |                          |--- 10. Activate Subscription      |
       |                          |--- 11. Record Financial Ledger    |
       |                          |--- 12. Credit Moderator (50%)    |
       |                          |                                   |
       |                          |--- 13. HTTP 200 OK Response ----->|
       |                          |                                   |
       |<-- 14. Polling unlocks --|                                   |
```

---

## 5. Local Webhook Testing

Because NOWPayments IPN requires a publicly accessible webhook URL, use one of the following methods for local testing:

### Option 1: Ngrok Tunnel
1. Start your backend: `npm run dev` in `roulette-accuracy-backend` (port 5050).
2. Run ngrok:
   ```bash
   ngrok http 5050
   ```
3. Copy the forwarding HTTPS URL (e.g. `https://abc123xyz.ngrok-free.app`).
4. Set the IPN URL in your NOWPayments dashboard or in the invoice creation payload:
   `https://abc123xyz.ngrok-free.app/api/v1/payments/ipn`

### Option 2: Automated In-Memory Test Suite (Mocked)
Run the automated test suite without external dependencies:
```bash
npm run test:phase5
```
This tests the full IPN signature calculation, idempotency, underpayment guard, renewal rules, and admin export.

---

## 6. Authoritative Plan Pricing (Decimal-Safe Integer Cents)

| Plan ID | Display Name | Duration | Price USD | Price Cents |
| :--- | :--- | :--- | :--- | :--- |
| `PLAN_15_DAYS` | 15 Days Pass | 15 Days | $150.00 | `15000` |
| `PLAN_1_MONTH` | 1 Month Pro | 1 Month | $200.00 | `20000` |
| `PLAN_3_MONTHS` | 3 Months Master | 3 Months | $450.00 | `45000` |
| `PLAN_6_MONTHS` | 6 Months Elite | 6 Months | $700.00 | `70000` |
| `PLAN_1_YEAR` | 1 Year VIP Annual | 12 Months | $1,000.00 | `100000` |

*Security Rule: Prices are snapshot from the database upon order creation. The client cannot send custom prices.*

---

## 7. Payment States & Transition Matrix

| NOWPayments Status | Internal PaymentStatus | Action Taken by Platform |
| :--- | :--- | :--- |
| `waiting` | `WAITING` | Order created; awaiting customer transfer. |
| `confirming` | `CONFIRMING` | Detected on mempool/blockchain; awaiting block confirmations. |
| `confirmed` | `CONFIRMED` | Required confirmations met; qualifies for activation if configured. |
| `sending` | `SENDING` | Provider routing funds to merchant custody. |
| `finished` | `FINISHED` | **Qualifying State**: Subscription activated, ledger booked, commission credited. |
| `partially_paid` | `PARTIALLY_PAID` | **Underpayment Alert**: Status held in `PARTIALLY_PAID`; subscription NOT activated. |
| `failed` | `FAILED` | Transaction failed; marked terminal; no access granted. |
| `expired` | `EXPIRED` | Deposit window lapsed; marked terminal; no access granted. |
| `refunded` | `REFUNDED` | Funds refunded; associated subscription revoked if previously granted. |

---

## 8. Webhook Security & Idempotency Rules

1. **HMAC-SHA512 Signature**:
   - Signature algorithm sorts all JSON keys recursively in alphabetical order.
   - Computes `crypto.createHmac('sha512', secret).update(jsonString).digest('hex')`.
   - Compares with `crypto.timingSafeEqual` against `x-nowpayments-sig`.
2. **Idempotency Guard**:
   - If an order has `isFulfilled: true`, subsequent webhooks log an audit notice and return HTTP 200 without creating a duplicate subscription or duplicate ledger entries.
3. **Price & Currency Mismatch Guard**:
   - If `payload.price_amount` deviates from `payment.priceAmount` by more than $0.05, or if `payload.price_currency` does not match, the order is placed into `REVIEW_REQUIRED` and subscription activation is halted.
4. **Renewal Rule**:
   - If a subscriber already has an active subscription, the new subscription's expiration date is calculated starting from the **existing active subscription's expiration date** (unbroken coverage). If lapsed, it starts from the current activation time.

---

## 9. Admin Payment Management & Reconciliation

### Admin Endpoints (Main Admins only)
- `GET /api/v1/payments/admin/orders`: Search by user email, payment ID, order ID, filter by status or date range with pagination.
- `GET /api/v1/payments/admin/summary`: Real-time summary of gross sales (USD), total orders, completed, pending, and failed.
- `GET /api/v1/payments/admin/export?format=csv`: Download full financial reconciliation report as CSV.

---

## 10. Supported Currencies & Limitations
- **Recommended Default**: `USDTTRC20` (Tether on Tron) — Near-instant confirmation, sub-dollar network fees.
- **Supported Stablecoins**: `USDTTRC20`, `USDTERC20`, `USDTBEP20`, `USDC`.
- **Supported Cryptocurrencies**: `BTC`, `ETH`, `TRX`, `SOL`, `LTC`, `DOGE`.
- **Provider Limitations**:
  - Minimum payment amounts vary per coin (e.g. BTC requires larger minimums than USDT-TRC20).
  - Network confirmation times depend on blockchain congestion (e.g. Bitcoin ~10-60 mins, Tron ~1-3 mins).
