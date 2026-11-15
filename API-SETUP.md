# Dealer Signature API — Secure Setup

This project uses a backend proxy for every Dealer Signature API call. The
browser never receives or stores the Server SK Key.

## 1. Configure from the Admin Panel

1. Sign in as a `SUPER_ADMIN`.
2. Open **Admin Console → Roulette Tool → API Settings**, or go directly to:

   ```
   /heda/settings?tab=api
   ```

3. Enter:
   - **Main Public API URL** — for example `https://api.yourdomain.com`
     (a trailing `/api` or `/api/v1` is normalized automatically)
   - **Main Server SK Key** — `sk_live_...` (a server key, not a browser key)
4. Click **Save Configuration**.
5. Click **Test API Connection**.

If the provider key is in **DOMAIN mode**, the backend automatically forwards
the browser's exact `Origin` as `x-client-origin`. For server-side/admin jobs
without a browser request it falls back to `PUBLIC_WEBSITE_URL` (or the first
`CORS_ORIGIN` entry). The forwarded origin must exactly match the scheme, host
and port configured on the provider key. If you see `ORIGIN_REQUIRED` or
`ORIGIN_NOT_ALLOWED`, check that exact match — do not use a different `www` or
`http`/`https` variant.

The test performs two signed requests through the backend:

- `GET /api/v1/status`
- `GET /api/v1/tables?limit=5`

It reports credentials, status, feed and `tables.list` permission checks, plus
the last request ID and latency.

A blank key field means **keep the existing key**. The plaintext key is never
returned by any admin endpoint. Use **Remove Stored Key** to delete it.

## 2. Required provider permissions

The Server SK Key needs at least:

- `status`
- `tables.list`
- `tables.prediction`

`tables.read`, `tables.pattern` and `tables.history` are optional for additional
admin views.

## 3. Server-side encryption

Provider credentials are encrypted with AES-256-GCM before being stored in
MongoDB. Set a dedicated secret in the backend environment:

```env
DS_CONFIG_ENCRYPTION_KEY=replace_with_a_long_random_secret
```

If it is omitted, `JWT_SECRET` is used as the key source. Do not change this
value after saving a key unless you re-enter the provider key (the old
ciphertext cannot be decrypted with a new secret).

Legacy plaintext keys are transparently migrated to encrypted values the first
time they are read.

## 4. Backend proxy routes

All routes below require a signed-in user with an active subscription (or an
administrative role). Errors preserve meaningful upstream status codes.

```
GET  /api/v1/ds/config
GET  /api/v1/ds/status
GET  /api/v1/ds/tables
GET  /api/v1/ds/tables/:tableId
GET  /api/v1/ds/tables/:tableId/prediction?direction=CW|CCW&window=25
GET  /api/v1/ds/tables/:tableId/travel-chart?direction=CW|CCW&window=25
GET  /api/v1/ds/tables/:tableId/pattern?direction=CW|CCW&window=25
GET  /api/v1/ds/tables/:tableId/history
POST /api/v1/ds/scanner
```

Admin-only routes:

```
GET   /api/v1/admin/tool/settings
PATCH /api/v1/admin/tool/settings
GET   /api/v1/admin/tool/ds-config
GET   /api/v1/admin/tool/ds-diagnostics
POST  /api/v1/admin/tool/ds-test
```

## 5. Live updates and rate limits

- The tool polls the prediction endpoint every 6 seconds while the tab is
  visible. The response already contains `travel_chart`, so no duplicate
  travel-chart request is made.
- Polling pauses while the browser tab is hidden and resumes immediately on
  focus.
- Identical in-flight GET requests are deduplicated in the browser. The backend
  also keeps a short shared cache (4 seconds) so multiple users watching the
  same table do not multiply upstream requests.
- A `429 RATE_LIMITED` response triggers a bounded 15-second client backoff.
  The last valid prediction stays on screen.
- Network failures and 5xx responses are retried once on the backend, never
  infinitely.
- The provider default key limit is 60 requests/minute. For many concurrent
  users/tables, raise the key quota in the provider admin panel or deploy an
  additional server-key rotation layer.

## 6. Security rules enforced by this codebase

- The SK key is accepted only by an authenticated `SUPER_ADMIN` endpoint.
- The key is encrypted at rest and decrypted only inside the backend proxy.
- The key is never placed in `localStorage`, browser JavaScript, HTML, public
  API responses, or audit logs.
- Admin settings responses contain only `dsApiKeyConfigured` and a masked
  `sk_live_••••••••1234` representation.
- The legacy demo prediction and public mock lobby endpoints no longer return
  fabricated numbers.

## 7. Hosting notes

- Deploy the backend and frontend over HTTPS.
- Set `CORS_ORIGIN` on the backend to the exact frontend origin(s).
- Set `NEXT_PUBLIC_API_URL` on the frontend to the backend `/api/v1` base.
- If the backend runs on a serverless platform, ensure outbound HTTPS to the
  provider URL is allowed and that the function timeout is greater than the
  proxy timeout (12 seconds).
- MongoDB must be reachable from the backend; Tool Settings store the encrypted
  provider credentials.
- The backend must have a stable clock (NTP). HMAC timestamps must be within
  ±5 minutes of the provider clock.
