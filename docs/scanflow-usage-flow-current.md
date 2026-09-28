# ScanFlow — Current Server-Side Usage/Quota Flow (Verified)

> Companion to `docs/subscription-usage-flow-verified.md` (the Saas reference baseline).
> This document describes **ScanFlow's current, verified server-side implementation** as-is
> (Express + Mongoose), then maps it against the Saas subscription/usage baseline to show
> what exists, what is partial, and what is missing.
>
> Verification date: 2026-09. Verified by reading the actual source; no code changed.

---

## 1. Current Architecture

| Aspect | Value |
|---|---|
| Framework | Express 5 + TypeScript (ESM) |
| ODM | Mongoose 9 (collections: `tbl_*`) |
| Queues | BullMQ + ioredis (webhook delivery only) |
| Counter store | Redis (`INCR`-based scan counter) |
| Processes | **API** (`src/index.ts` → `app.ts`) and **Worker** (`src/worker.ts`) |
| Global prefix | `/api` |

### Route map (`src/routes/index.ts`)
| Mount | Router | File |
|---|---|---|
| `/api/auth` | auth (send-otp / verify-otp / refresh-tokens / logout / me) | `routes/auth.route.ts` |
| `/api/organizations` | organizations (admin) | `routes/admin/organizations.route.ts` |
| `/api/operators` | operators | `routes/user/operators.route.ts` |
| `/api/scans` | scans | `routes/user/scans.route.ts` |
| `/api/webhooks` | webhooks | `routes/user/webhooks.route.ts` |

`PUBLIC_PATHS = ['/auth', '/health']` — everything else requires JWT auth.

### Global middleware chain (`src/app.ts`)
```
helmet → express.json(10mb) → mongoSanitize → compression → cors → passport('jwt')
  → /api route mount → 404 → errorConverter → errorHandler
```
- Auth is enforced centrally at `/api` (except `PUBLIC_PATHS`), then per-route role rights via `auth('right')`.
- Roles (`src/config/roles.ts`): `SUPER_ADMIN`, `ORGANIZATION_ADMIN`, `OPERATOR`.
- Dev OTP bypass via `BYPASS_EMAIL`/`BYPASS_OTP` env (`config.auth`).

---

## 2. Data Model (current)

### 2.1 `Organization` (`tbl_organization` — `models/organization.model.ts`)
```
name, email, contactNumber
status: 0|1|2            (active / ... / soft-deleted=2)
scanQuota: {
  limit:        Number   (default 0 — granted quota)
  period:       'monthly' | 'daily'
  periodStart:  Date
}
scanUsage: {
  count:          Number  (synced from Redis by worker)
  lastSyncedAt:   Date
}
created_by, modified_by
```
Note: ScanFlow's "quota" is a **single flat number per organization**. There is no
plan/feature/tier/subscription concept on the org.

### 2.2 `User` (`tbl_user` — `models/user.model.ts`)
```
first_name, last_name, email (unique)
role: SUPER_ADMIN | ORGANIZATION_ADMIN | OPERATOR
organizationId → Organization (null for super admin)
status, isEmailVerified, created_by, modified_by, password(hashed, hidden)
```

### 2.3 `Scan` (`tbl_scan` — `models/scan.model.ts`)
```
organizationId (required), userId (required), deviceId?
clientScanId (required), barcode (required), barcodeType?, scannedAt
unique index: (organizationId, clientScanId)
```
Deduplication is enforced at the DB level via that unique index (see §4).

### 2.4 Webhook (`WebhookConfig`, `WebhookDelivery`)
- Per-org config: `endpointUrl, enabled, secret, timeoutMs, batchSize, retryLimit`.
- `WebhookDelivery`: `eventId(UUID), scanId, organizationId, status(pending/progress/success/failed), retryCount...`.

---

## 3. Quota Module (current) — `src/services/quota.service.ts`

| Function | Line | Behavior |
|---|---|---|
| `periodWindow(period, date)` | :12 | Returns `{ key, start }`. Key = `YYYY-MM` (monthly) or `YYYY-MM-DD` (daily, UTC). |
| `redisScanKey(orgId, period)` | :30 | `org:{orgId}:scans:{period}:{key}` |
| `incrementScanUsage(orgId, period)` | :38 | Redis `INCR`; returns new count. **Skipped (returns 0) if Redis unconfigured.** |
| `getPeriodScanCount(orgId, period)` | :51 | Redis `GET` current period key. |
| `reconcileScanUsage()` | :63 | For every `status:1` org: read current-period Redis count → write `scanUsage: {count, lastSyncedAt}`. |
| `assertOrganizationActive(orgId)` | :82 | 400 if org missing or `status !== 1`. |

Config: `config.redis.scanQuotaPeriod = env SCAN_QUOTA_PERIOD` (`config.ts:119`) — the default
period used when constructing/granting quota.

**Counter mechanics:** the period key is derived from the date at increment time. A month key
(`org:...:scans:monthly:2026-09`) is used for all increments in that calendar month; a new key
starts automatically each month (no manual rollover). The worker syncs the current period's
count into `org.scanUsage.count`.

---

## 4. Scan Ingest Flow (current) — `services/user/scans.service.ts:16`

`POST /api/scans` (guard: `auth('manageScans')`):

```
1. resolveOrganizationScope(reqUser, body.organizationId, { required: true })
     - SUPER_ADMIN: uses explicit organizationId (400 if missing when required)
     - others: forced to reqUser.organizationId (400 if none)
2. assertOrganizationActive(orgId)                 → 400 if inactive/missing
3. findOne({ organizationId, clientScanId })       → duplicate ⇒ 200 "duplicate ignored", created:false
4. Scan.create({...})                               → persisted
5. incrementScanUsage(orgId, org.scanQuota?.period ?? 'monthly')   → Redis INCR
6. createDeliveryAndEnqueue(scan)                   → WebhookDelivery(pending) + BullMQ queue push
7. respond 202 "Scan accepted for processing." created:true
```

Duplicate fallthrough: a 11000 (unique index) race on step 4 is caught, re-queried and returned
as "duplicate ignored" (`scan.service.ts:59-69`).

`GET /api/scans`, `GET /api/scans/:scanId`:
- `listScans` scopes by org (super admin may filter by `organizationId`); user/operator filters.
- `getScanById` 404 if missing; 403 unless super admin or same org (controller wraps in `createResponse`).

---

## 5. Worker Responsibilities — `src/worker.ts`

| Job | Frequency | File ref |
|---|---|---|
| Webhook delivery (BullMQ worker) | continuous | `queues/webhook.worker.ts` |
| `reconcileScanUsage()` | on boot + every **30s** (`setInterval`) | `worker.ts:12-32`; `quota.service.ts:63` |

The worker is separate from the API process (`npm run worker` / `src/worker.ts`). It:
1. Connects to Mongo + Redis.
2. Starts the webhook worker.
3. Reconciles Redis scan counters → `org.scanUsage.count` for all active orgs, forever.

---

## 6. Verified Limitations (current implementation)

Verified against the source; ordered by impact:

1. **No quota enforcement.** `incrementScanUsage`'s returned count is ignored; a scan is always
   accepted (subject only to org-active + dedupe) even when `used ≥ scanQuota.limit`. The limit
   is only *displayed* via `GET /api/organizations/:organizationId/usage`
   (`organizations.service.ts:140-166`). There is no 4xx when over-limit.
   → Saas equivalent: `UsageLimitGuard` rejects with 403 `FORBIDDEN_QUOTA_EXCEEDED`.

2. **Partial-write on Redis failure (with REDIS configured).** In `createScan`, `Scan.create`
   then `incrementScanUsage` run inside one try/catch that only special-cases the 11000 dup.
   If Redis INCR throws (Redis down while configured), the catch rethrows → scan is persisted,
   counter not incremented, client gets 500. Without REDIS the counter is silently skipped instead.
   → Recommend guarding the counter (best-effort try/catch) after the durable write.

3. **Redis keys never expire.** `org:*:scans:...` keys are never `EXPIRE`d; old monthly/day keys
   persist forever (minor storage growth; functionally harmless because each period re-keys).

4. **No subscription / plan / feature layer.** Quota is a single flat `limit` per org. There are
   no plans, features, sections, coupons, guest leads, checkout, payments, subscription statuses,
   upgrade queue, usage rows, or windows.

5. **No API-side scheduler.** The only recurring maintenance is the worker's 30s reconcile loop.
   No promotion/purge/normalize jobs exist (nothing to promote — no subscriptions).

6. **Period flip mid-month.** Changing `org.scanQuota.period` starts counting a fresh key;
   prior-period counts remain under the old key and are not merged into the report.

---

## 7. Current Endpoint Catalog

| Method | Path | Guard right | Handler |
|---|---|---|---|
| GET  | `/api/health` | public | inline |
| POST | `/api/auth/send-otp` | public | auth.controller |
| POST | `/api/auth/verify-otp` | public | auth.controller |
| POST | `/api/auth/refresh-tokens` | public | auth.controller |
| POST | `/api/auth/logout` | public | auth.controller |
| GET  | `/api/auth/me` | auth | auth.controller |
| GET  | `/api/organizations` | manageOrganizations | listOrganizations |
| POST | `/api/organizations` | manageOrganizations | createOrganization |
| GET  | `/api/organizations/:organizationId` | manageOrganizations | getOrganization |
| PUT  | `/api/organizations/:organizationId` | manageOrganizations | updateOrganization |
| DELETE | `/api/organizations/:organizationId` | manageOrganizations | deleteOrganization |
| PATCH | `/api/organizations/:organizationId/update-status` | manageOrganizations | updateOrganizationStatus |
| GET  | `/api/organizations/:organizationId/usage` | manageScans | getOrganizationUsage |
| GET/POST | `/api/operators` (+ `/:userId` PUT/DELETE/PATCH status) | viewOperators/manageOperators | operators.controller |
| GET/POST | `/api/scans` | manageScans | listScans / createScan |
| GET  | `/api/scans/:scanId` | manageScans | getScan |
| GET/POST/DELETE | `/api/webhooks/config` | manageWebhooks | webhooks.controller |
| GET  | `/api/webhooks/deliveries` | manageWebhooks | webhooks.controller |

---

## 8. Gap Table — Saas Baseline vs ScanFlow Current

Legend: ✅ exists · 🟡 partial · ❌ missing (reference: Saas = `docs/subscription-usage-flow-verified.md`)

| Saas baseline feature | Saas reference | ScanFlow current | Status |
|---|---|---|---|
| Subscription subdoc (status active/future/expired/cancelled, single-active) | §3.1 | Organization `scanQuota` flat limit | ❌ |
| Plans / Features / Sections / Coupons | §3.2–3.4 | none | ❌ |
| Public checkout + guest leads | §5.1, §6 | none | ❌ |
| Payments (Stripe + Razorpay) + invoices | §6 | none | ❌ |
| Usage rows per feature (grant/used/limit, window, purge_after TTL) | §3.6 | Redis counter only, no rows | ❌ |
| Usage enforcement guard (403 FORBIDDEN_QUOTA_EXCEEDED) | §7.1 | none — unlimited accept | ❌ |
| Usage increment interceptor (per_request/body_array/…) | §7.2 | INCR after insert | 🟡 |
| Feature route meters cache | §7.3 | none | ❌ |
| In-memory window store / window settings | §7.4–7.5 | period key derives window | 🟡 |
| Renew/force-activate/cancel queue ops | §5.4–5.7 | none | ❌ |
| Maintenance cron (promote/purge/normalize) | §9 | worker 30s reconcile only | 🟡 |
| Usage drill-down API + admin panel | §4, §10 | GET org usage (current period only) | 🟡 |
| Idempotent scan ingestion (dedupe) | n/a | unique `(organizationId, clientScanId)` + 11000 handling | ✅ |
| Org scoping / role rights per route | n/a | `auth('right')` + `resolveOrganizationScope` | ✅ |
| Webhook config + delivery queue (BullMQ, retries) | n/a | webhook worker + deliveries | ✅ |
| No self-registration (accounts provisioned by admin) | §12 checklist | matches (send-otp/verify-otp only) | ✅ |

---

*End of current-flow baseline. Generate for ScanFlow. Reference implementation = Saas (see `subscription-usage-flow-verified.md`).*