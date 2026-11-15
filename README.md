# Roulette Accuracy — API Backend (`roulette-accuracy-backend`)

Production-ready Express.js REST API with TypeScript, MongoDB Atlas connection management, Better Auth / JWT authentication, Zod validation, role-based access control, NOWPayments crypto integration, and immutable dual-approval audit logging.

---

## 📑 Table of Contents
1. [Project Architecture](#-project-architecture)
2. [Prerequisites](#-prerequisites)
3. [Installation & Setup](#-installation--setup)
4. [Development Commands](#-development-commands)
5. [Environment Variables Reference](#-environment-variables-reference)
6. [Database Setup (MongoDB Atlas)](#-database-setup-mongodb-atlas)
7. [Authentication & Security Architecture](#-authentication--security-architecture)
8. [Email & SMS Delivery Provider Setup](#-email--sms-delivery-provider-setup)
9. [NOWPayments Integration](#-nowpayments-integration)
10. [Initial Main Admin Initialization](#-initial-main-admin-initialization)
11. [Moderator Referral System (Non-Custodial)](#-moderator-referral-system-non-custodial)
12. [Production Deployment Steps](#-production-deployment-steps)
13. [Troubleshooting](#-troubleshooting)
14. [Backup & Recovery](#-backup--recovery)
15. [Security Recommendations](#-security-recommendations)

--

## 🏛️ Project Architecture

```
                  ┌──────────────────────────────────────────────┐
                  │          Vercel Serverless Edge              │
                  │   Next.js 16 (App Router) + React 19 UI      │
                  │        https://rouletteaccuracy.com                │
                  └──────────────────────┬───────────────────────┘
                                         │ HTTPS / REST API
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │       Dedicated Node.js Hosting Container    │
                  │      (Render / Railway / AWS / VPS)          │
                  │        Express.js 4 + TypeScript             │
                  │       https://api.rouletteaccuracy.com             │
                  └───┬──────────────────┬───────────────────┬───┘
                      │                  │                   │
                      ▼                  ▼                   ▼
     ┌──────────────────────┐ ┌────────────────────┐ ┌─────────────────────┐
     │    MongoDB Atlas     │ │    NOWPayments     │ │  Resend & Twilio    │
     │  Multi-Region M10+   │ │ Crypto Gateway IPN │ │ Delivery Providers  │
     │  Replica Set Cluster │ │  HMAC-SHA512 Webhk │ │ (Transactional Auth)│
     └──────────────────────┘ └────────────────────┘ └─────────────────────┘
```

- **Clean Layered Separation**:
  - `src/controllers/`: Express handlers with status codes and response formatting.
  - `src/services/`: Pure business logic, accounting rules, cryptographic validations, and audit dispatch.
  - `src/models/`: Mongoose schemas with strict TypeScript typing, validation, and compound indexes.
  - `src/middleware/`: Authentication (`requireAuth`, Bearer/Cookie/Query parsing), Role-based authorization (`requireRole`), Rate limiting, Input sanitization, and Global error handling.
  - `src/database/`: Resilient MongoDB driver with connection pooling (`minPoolSize: 5`, `maxPoolSize: 50`) and graceful SIGTERM teardown.
  - `src/utils/`: Cryptographic hashing (Bcryptjs, HMAC-SHA512), JWT generation, structured JSON logger with `LOG_LEVEL` thresholding, and CSV formula-injection sanitization.

---

## 📋 Prerequisites
- **Node.js**: v20.x or v22.x LTS
- **npm**: v10.x or later
- **MongoDB**: Managed MongoDB Atlas replica set (or local MongoDB >= 7.0 for development)
- **External Accounts**:
  - [NOWPayments](https://nowpayments.io) account (API Key + IPN Secret)
  - [Resend](https://resend.com) or transactional SMTP email service
  - [Twilio](https://twilio.com) account for SMS verification OTPs

---

## 🚀 Installation & Setup

1. **Clone & Navigate**:
   ```bash
   git clone <repository_url>
   cd "Roulette Accuracy/backend"
   ```

2. **Install Dependencies**:
   ```bash
   npm install --legacy-peer-deps
   ```

3. **Configure Environment Variables**:
   ```bash
   cp .env.example .env
   ```
   *Edit `.env` with your development or staging credentials. Never commit `.env` to Git.*

4. **Local Database**:
   - `.env` ships with `MONGODB_URI=mongodb://127.0.0.1:27017/roulette-accuracy`.
   - If no MongoDB server is running, the backend starts an embedded MongoDB automatically and stores data in `.dev-db/`.
   - The first request provisions a Super Admin from `MAIN_ADMIN_EMAILS` using `INITIAL_ADMIN_PASSWORD` (default in `.env`). Change both before production.

---

## ⚡ Development Commands

| Command | Description |
| :--- | :--- |
| `npm run dev` | Starts development server with live reload via `tsx watch src/index.ts` on port **5050**. |
| `npm run typecheck` | Validates TypeScript types across all source files without emitting artifacts (`tsc --noEmit`). |
| `npm run build` | Compiles clean production JavaScript into `dist/` directory (`tsc`). |
| `npm start` | Runs the compiled production bundle with Node (`node dist/index.js`). |
| `npm test` | Runs all 9 sequential test suites (Auth, Phase 3–9) via isolated in-memory MongoDB. |
| `npm run bootstrap:admins` | Initializes the 4 designated Main Admin accounts from `MAIN_ADMIN_EMAILS`. |
| `npm audit` | Audits third-party dependencies for known security vulnerabilities (0 vulnerabilities). |

---

## 🔑 Environment Variables Reference

See [.env.example](.env.example) for placeholder definitions.

| Variable | Required | Description | Example / Default |
| :--- | :---: | :--- | :--- |
| `NODE_ENV` | Yes | Environment stage (`development`, `production`, `test`) | `production` |
| `PORT` | Yes | Listening port for the Express application | `5000` |
| `CORS_ORIGIN` | Yes | Allowed frontend origin(s) for browser requests | `https://accuracy.tools,https://www.accuracy.tools` |
| `MONGODB_URI` | Yes | MongoDB Atlas connection URI with replica set | `mongodb+srv://user:pass@cluster.mongodb.net/platform?retryWrites=true&w=majority` |
| `JWT_SECRET` | Yes | High-entropy string for signing user session tokens (min 32 chars) | `openssl rand -base64 48` |
| `JWT_EXPIRES_IN` | Yes | Token validity duration | `7d` |
| `BETTER_AUTH_SECRET` | No | Cryptographic secret for Better Auth internal state | `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | No | Base API URL exposed to Better Auth clients | `https://our-project-bk.vercel.app` |
| `PUBLIC_WEBSITE_URL` | Yes | Primary public frontend URL for email/SMS links | `https://accuracy.tools` |
| `FRONTEND_URL` | Yes | Internal/customer redirect URL after payment completion | `https://accuracy.tools` |
| `BACKEND_URL` | Yes | Fully qualified public URL for this backend API instance | `https://our-project-bk.vercel.app` |
| `NOWPAYMENTS_ENV` | Yes | `sandbox` or `production` (selects the official API host) | `sandbox` |
| `NOWPAYMENTS_API_KEY` | Yes | Sandbox or production API key from NOWPayments Store Settings | `your_api_key_here` |
| `NOWPAYMENTS_IPN_SECRET` | Yes | Shared secret for HMAC-SHA512 webhook verification | `your_ipn_secret_here` |
| `NOWPAYMENTS_API_URL` | Yes | NOWPayments REST endpoint | `https://api-sandbox.nowpayments.io/v1` |
| `NOWPAYMENTS_LIVE_ENABLED` | Yes | Explicit production live-transaction gate | `false` |
| `NOWPAYMENTS_REQUIRE_API_VERIFICATION` | Yes | Re-fetch each finished payment before activation | `true` |
| `PAYMENT_IPN_CALLBACK_URL` | Yes | Fully qualified public IPN endpoint | `https://our-project-bk.vercel.app/api/nowpayments/webhook` |
| `PAYMENT_SUCCESS_URL` | Yes | Checkout success redirect | `https://accuracy.tools/checkout/success` |
| `PAYMENT_CANCEL_URL` | Yes | Checkout cancel redirect | `https://accuracy.tools/checkout/failed` |
| `PAYMENT_PENDING_URL` | Yes | Pending/partially-paid redirect | `https://accuracy.tools/checkout/pending` |
| `UPSTASH_REDIS_REST_URL` | No | Optional Redis REST cache endpoint | `https://...upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | No | Optional Redis REST bearer token | `your-token` |
| `CACHE_REDIS_TIMEOUT_MS` | No | Redis REST timeout before memory fallback | `800` |
| `INITIAL_ADMIN_PASSWORD` | Bootstrap only | 12+ character first-time admin password; never logged | `use_a_secret_manager` |
| `MAIN_ADMIN_EMAILS` | Yes | Comma-separated list of exactly 4 designated owner emails | `admin1@rouletteaccuracy.com,admin2@rouletteaccuracy.com,admin3@rouletteaccuracy.com,admin4@rouletteaccuracy.com` |
| `EMAIL_PROVIDER_API_KEY` | Yes | Transactional email provider API key (Resend / SendGrid) | `re_xxxxxxxxxxxxxxxxxxxx` |
| `EMAIL_FROM` | Yes | Verified RFC-compliant sender address | `Roulette Accuracy <security@rouletteaccuracy.com>` |
| `SMS_PROVIDER_API_KEY` | No | SMS gateway token (Twilio Auth Token) | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `TWILIO_ACCOUNT_SID` | No | Twilio Account SID | `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `TWILIO_FROM_NUMBER` | No | E.164 Twilio phone number | `+18005550199` |
| `LOG_LEVEL` | Yes | Severity filter (`DEBUG`, `INFO`, `WARN`, `ERROR`) | `INFO` |

---

## 🗄️ Database Setup (MongoDB Atlas)

1. **Create an Atlas Cluster**:
   - Provision an M10 or higher cluster on AWS or GCP in the same cloud region as your backend server.
2. **Configure Database User**:
   - Under **Database Access**, create a user with `readWrite` privileges to the `roulette-platform` database.
   - Use a strong, generated password (URL-encode special characters like `@` or `:` if present).
3. **Configure Network Security (IP Access List)**:
   - Under **Network Access**, add the static IP addresses of your Node.js backend servers.
   - If using a container platform with dynamic outbound IPs (e.g., Render, Railway), allow `0.0.0.0/0` protected strictly by user credentials and TLS/SSL enforcement.
4. **Copy Connection String**:
   - Select **Connect → Drivers (Node.js)** and configure:
     ```
     mongodb+srv://<db_user>:<db_password>@cluster0.xxxxx.mongodb.net/roulette-platform?retryWrites=true&w=majority&appName=RouletteTools
     ```
5. **Connection Resilience**:
   - The connection manager (`src/database/connection.ts`) automatically configures:
     - `serverSelectionTimeoutMS: 10000` (10 seconds)
     - `connectTimeoutMS: 10000`
     - `socketTimeoutMS: 45000`
     - `maxPoolSize: 50`
     - `minPoolSize: 5`

---

## 🔐 Authentication & Security Architecture

### Multi-Identifier Registration & Verification
- **Dual Credential Support**: Users can register with either an **Email Address** or an **E.164 Phone Number**.
- **Cryptographic OTPs**: 6-digit numeric codes generated via `crypto.randomInt(100000, 1000000)` and stored as SHA-256 hashes with 10-minute automated TTL expiration.
- **Single-Use Enforcement**: Codes are invalidated immediately upon verification or after 5 incorrect attempts.
- **Cooldown & Rate Limiting**: 60-second cooldown on resend requests; IP and identifier rate limiters prevent brute-force attacks.
- **Enumeration-Safe**: Password reset responses never reveal whether an account exists.
- **Direct CSV Downloads**: The `requireAuth` middleware securely supports `Authorization: Bearer <token>`, `?token=...` query parameters, and `sloot_token` cookies for seamless browser CSV exports.

---

## 📨 Email & SMS Delivery Provider Setup

### 1. Resend (Email Provider)
- Create an account at [resend.com](https://resend.com).
- Under **Domains**, add your domain (e.g. `rouletteaccuracy.com`) and add the provided SPF, DKIM, and DMARC DNS records.
- Generate an API Key with "Sending Access".
- Set `EMAIL_PROVIDER_API_KEY=re_...` and `EMAIL_FROM=Roulette Accuracy <security@rouletteaccuracy.com>`.
- In development mode, if the API key is omitted, verification codes are logged to the backend console.

### 2. Twilio (SMS Provider)
- Create a Twilio account and register a verified 10DLC or Toll-Free number capable of SMS delivery.
- Set `TWILIO_ACCOUNT_SID=AC...`, `SMS_PROVIDER_API_KEY=<auth_token>`, and `TWILIO_FROM_NUMBER=+18005550199`.
- Verify recipient phone numbers if running on a Twilio trial account.

---

## 💳 NOWPayments Integration

### Cryptographic Webhook Flow
1. Client selects one of 5 subscription tiers (`PLAN_15_DAYS`, `PLAN_1_MONTH`, `PLAN_3_MONTHS`, `PLAN_6_MONTHS`, `PLAN_1_YEAR`).
2. Backend generates a `PurchaseOrder` with an immutable price snapshot in integer cents.
3. Backend calls NOWPayments `POST /v1/invoice` with `ipn_callback_url: env.PAYMENT_IPN_CALLBACK_URL` and success/cancel URLs from `PAYMENT_SUCCESS_URL` / `PAYMENT_CANCEL_URL`.
4. Client pays on blockchain using USDT (TRC-20 / ERC-20), BTC, ETH, or supported coins.
5. NOWPayments dispatches IPN callback with HTTP header `x-nowpayments-sig`.
6. Backend computes HMAC-SHA512 over the recursively sorted JSON payload, verifies with `crypto.timingSafeEqual`, then validates amount, currency, order and provider payment ID.
7. For `finished` only, the backend independently re-fetches the payment from NOWPayments, atomically claims the order, fulfills the subscription, books the ledger entry, and credits the referring moderator 50% commission. `confirmed` alone never unlocks Premium.
8. **Security Mandate**: Subscriptions are never activated by frontend client redirects.

---

## 👑 Initial Main Admin Initialization

### Automatic local bootstrap

On the first authenticated request, if the database has no `SUPER_ADMIN`, the backend can create one from:

```env
MAIN_ADMIN_EMAILS=owner@your-domain.com
INITIAL_ADMIN_PASSWORD=use_a_12_plus_character_secret_from_your_secret_manager
```

The fallback is fail-closed: if `INITIAL_ADMIN_PASSWORD` is missing, placeholder text, or shorter than 12 characters, no admin is created and an error is logged. Passwords are never printed to logs.

The seeded admin is also given a one-year manual subscription. Change the password after first login.

### Optional multi-admin bootstrap

For a production owner team, set one or more designated emails:

```env
MAIN_ADMIN_EMAILS=admin1@rouletteaccuracy.com,admin2@rouletteaccuracy.com
```

Then run:

```bash
npm run bootstrap:admins
```

The script creates the `SUPER_ADMIN` accounts using `INITIAL_ADMIN_PASSWORD` from the environment, logs a `MAIN_ADMIN_BOOTSTRAP` audit record for each, and never prints the password. Share credentials only through a secure channel.

---

## 🤝 Moderator Referral System (Non-Custodial)

- **Attribution**: Users registering with a referral code (e.g. `MOD123`) have their `referredBy` field permanently linked.
- **Commission**: When a referred user completes a subscription purchase, the moderator is automatically credited **50% of the net transaction** on an internal accounting ledger.
- **Strict Non-Custodial Architecture**:
  - The platform **does not hold user custodial crypto balances** and **has NO on-platform withdrawal feature**.
  - Moderator commissions are tracked for accounting and affiliate reconciliation.
  - Manual commission adjustments require an authoritative Main Admin audit reason.
  - Financial reports and CSV exports display explicit non-custodial disclaimers.

---

## 🚢 Production Deployment Steps

### Step 1: Deploy Backend (Vercel — `our-project-bk`)
1. Import the backend as a Vercel project.
2. Set `NODE_ENV=production`, `BACKEND_URL=https://our-project-bk.vercel.app`, and all payment variables from `.env.example`.
3. Deploy. Verify `${BACKEND_URL}/health` returns 200.
4. Set the NOWPayments IPN URL to `https://our-project-bk.vercel.app/api/nowpayments/webhook`.

### Step 2: Deploy Frontend (Vercel — `accuracy.tools`)
1. Import the frontend project into Vercel.
2. Set Environment Variables:
   - `NEXT_PUBLIC_API_URL=https://our-project-bk.vercel.app/api/v1`
   - `NEXT_PUBLIC_APP_URL=https://accuracy.tools`
   - `BACKEND_URL=https://our-project-bk.vercel.app` (only needed for the optional frontend webhook proxy)
3. Deploy. Add the custom domain `accuracy.tools` with SSL.
4. Ensure backend `CORS_ORIGIN` includes `https://accuracy.tools` and `PUBLIC_WEBSITE_URL=https://accuracy.tools`.

### Step 3: Run Database Initialization & Verification
1. Access the backend host container terminal (or run locally with production DB URI):
   ```bash
   npm run bootstrap:admins
   ```
2. Verify `/health` returns `{ "status": "ok" }`.

---

## 🔧 Troubleshooting

| Symptom | Cause | Solution |
| :--- | :--- | :--- |
| `CORS Error: Origin not allowed` | `CORS_ORIGIN` does not match the frontend domain | Update backend `CORS_ORIGIN` to exact frontend HTTPS URL without trailing slash. |
| `IPN Signature Mismatch (401)` | Wrong `NOWPAYMENTS_IPN_SECRET` or payload modified by proxy | Verify IPN secret in NOWPayments dashboard. Ensure the raw JSON body is received without proxy modification. |
| `MongoDB Server Selection Timeout` | Atlas IP Access List blocking connection | Add backend outbound IP addresses or `0.0.0.0/0` in MongoDB Atlas Network Access. |
| `CSV Export Unauthorized` | Session token missing from download link | Pass `?token=<jwt>` in the export URL; the backend `requireAuth` middleware automatically inspects query parameters. |

---

## 💾 Backup & Recovery

- **Automated Atlas Backups**: Enable Continuous Cloud Backups (Point-in-Time Recovery) in MongoDB Atlas under Cluster Backup Settings.
- **Manual Snapshot**:
  ```bash
  mongodump --uri="<MONGODB_URI>" --out="/backup/$(date +%Y%m%d)"
  ```
- **Disaster Restoration**:
  ```bash
  mongorestore --uri="<TARGET_MONGODB_URI>" --drop /backup/20261027/
  ```

---

## 🛡️ Security Recommendations

1. **HTTPS Enforcement**: Always terminate TLS 1.3 at your edge load balancer or reverse proxy.
2. **Secrets Storage**: Never commit `.env` files. Use cloud key vaults (AWS Secrets Manager, Vercel Environment Variables).
3. **Database Safeguards**: Rotate Atlas database user passwords periodically. Enable MongoDB IP access restrictions.
4. **Audit Log Immutability**: Platform activity and dual approvals are permanently retained in the `AuditLog` collection.
