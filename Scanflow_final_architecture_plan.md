# ScanFlow — Final Backend Architecture Plan

This is the final, verified migration plan for the ScanFlow backend
(Express + Mongoose → Fastify + Mongoose + Redis/BullMQ), reviewed against
the actual product requirements:

- High-performance barcode scan ingestion (scanning/decoding happens on the
  frontend; backend only stores + notifies).
- Multi-tenant admin panel: Super Admin manages Organizations, each
  Organization's Admin manages their own Operators (sub-users).
- Subscription with a fixed scan-count limit, pooled at the organization
  level.
- Webhook response sent to each organization's external backend after a
  scan — must never block the scan API.
- Target: 1k+ users, burst-tolerant.

This supersedes the original migration prompt where the two disagree —
specifically, it reinstates scan-quota **tracking** (not full billing) as a
required feature, since it's core to the product, not "overengineering."

---

## 1. Final Architecture Diagram

```
Scanner Frontend (decodes barcode locally)
        |
        | POST /api/scans  { clientScanId, barcode, barcodeType, deviceId, scannedAt }
        v
+---------------------------+
|       Fastify API         |
|  JWT -> { userId, orgId,  |
|           role }          |
+-------------+--------------+
              |
              |--1--> Redis: INCR org:{orgId}:scans:{period}   (atomic counter, tracking only for now)
              |
              |--2--> MongoDB: persist scan (idempotent on organizationId+clientScanId)
              |
              |--3--> Return 202 immediately (frontend never waits past this)
              |
              '--4--> BullMQ: enqueue { eventId, scanId, organizationId }
                              |
                              v
                    +-------------------+
                    |  Webhook Worker   |  (separate process, configurable concurrency)
                    +---------+---------+
                              |  loads webhook_config for org, builds payload,
                              |  timeout + retry/backoff, isolated per-org
                              v
                    Organization's External Backend
```

Async reconciliation job (every 30-60s, non-blocking): flushes Redis
`org:{orgId}:scans:{period}` counters into `organizations.scanUsage` in
Mongo for durability/reporting — same non-blocking pattern as the batched
scan-write buffer used for scan persistence itself.

**Critical rule (unchanged from the original plan):** the Scan API never
awaits webhook delivery. Steps 1-3 above are all that stand between the
client's request and its response; webhook delivery is fully decoupled via
BullMQ and can be moved to a separate service later without touching the
Scan API.

---

## 2. Multi-tenant model

```
Super Admin (you)
    |
    +-- creates --> Organization  (name, contact, subscription/quota fields)
    |                    |
    |                    '-- creates --> Organization Admin (first login for the org)
    |
    Organization Admin
         |
         '-- creates --> Operator, Operator, Operator ...  (actual scanners)
```

Confirmed decisions:

- **Organization provisioning is Super-Admin-only.** `POST /api/auth/register`
  is removed from public routes entirely. Account creation becomes:
  - `POST /api/organizations` (Super Admin) — creates an Organization and
    its first Organization Admin.
  - `POST /api/operators` (Organization Admin) — creates Operators scoped
    to `req.user.organizationId`. Organization Admins can never create
    accounts outside their own org.
- OTP + JWT flow (`send-otp`, `verify-otp`, `refresh-tokens`, `logout`,
  `me`) stays exactly as in the current implementation — only *who can
  create accounts* changes, not the login mechanism.
- Authorization is always derived from `organizationId` in the JWT/auth
  context — never trusted from the request body. An Organization Admin's
  API calls are implicitly scoped to their own `organizationId`; a
  malicious `organizationId` in the payload is ignored/rejected.

---

## 3. Organization model (updated)

```
organizations
  _id
  name
  email
  contactNumber
  status                    // active | inactive
  scanQuota: {
    limit: Number,          // fixed scan count for the period
    period: String,         // e.g. "monthly" — reset cadence
    periodStart: Date       // anchor for the current counting window
  }
  scanUsage: {
    count: Number,          // reconciled periodically from Redis
    lastSyncedAt: Date
  }
  createdAt / updatedAt / createdBy / modifiedBy
```

`scanQuota` and `scanUsage` exist so the Redis counter has something to
compare against and somewhere durable to land. **No rejection/blocking
logic is implemented yet** — this phase only tracks usage. What happens
when quota is exceeded (hard block vs. soft overage) is an explicit
follow-up decision, deferred on purpose so it doesn't hold up the rest of
the migration.

New endpoint: `GET /api/organizations/:id/usage` (Super Admin, or that
org's own Admin) — returns current period scan count for visibility.

---

## 4. User / Operator model

Unchanged from the original plan:

```
users
  _id
  organizationId
  firstName
  lastName
  email
  contactNumber
  password
  role            // SUPER_ADMIN | ORGANIZATION_ADMIN | OPERATOR
  status
  isSuperAdmin
  isEmailVerified
  createdBy
  modifiedBy
  createdAt / updatedAt
```

Migration mapping for existing dev data:

| Old | New |
|---|---|
| `SUPER_ADMIN` | `SUPER_ADMIN` |
| `USER_ADMIN` | `ORGANIZATION_ADMIN` |
| `USER` | `OPERATOR` |

The 3 existing dev users have no `organizationId` today — they need a
controlled default-organization assignment as part of the migration
script (do not invent ownership silently; document old→new mapping and
affected record count before running).

Old `is_sub_user` / `parent_id` fields are retired in favor of
`organizationId` as the authorization boundary, per the reasoning in
section 12 of the original plan.

---

## 5. Scan model + API flow

```
scans
  _id
  organizationId
  userId
  deviceId
  clientScanId     // mandatory, for idempotency
  barcode
  barcodeType
  scannedAt
  createdAt
  updatedAt
```

Indexes: unique `organizationId + clientScanId`; `organizationId + scannedAt`;
`organizationId + userId + scannedAt`.

`POST /api/scans` flow:

1. Authenticate — JWT gives `organizationId`, `userId` (never trust these
   from the request body).
2. Validate request shape (`clientScanId`, `barcode`, `barcodeType`,
   `deviceId`, `scannedAt`).
3. `Redis INCR org:{orgId}:scans:{currentPeriod}` — atomic, sub-millisecond,
   record only (no gate yet).
4. Check idempotency on `clientScanId` and persist the scan (batched Mongo
   write, same non-blocking pattern used in the load-test rig).
5. Enqueue a minimal webhook job: `{ eventId, scanId, organizationId }`.
6. Respond `202` immediately. Steps 3-5 never wait on external systems;
   the frontend gets its response as soon as persistence + enqueue are
   underway.

---

## 6. Webhook architecture

No changes from the original plan — it was already correct for this
product's needs:

- Isolated worker process (`src/modules/webhook/`), separate entry point
  from the API (`src/worker.ts`).
- `webhook_configs` collection per organization: `endpointUrl`, `secret`
  (never exposed in API responses), `enabled`, `timeoutMs`, `batchSize`,
  `retryLimit`.
- Configurable timeout (default 5000ms), BullMQ retry with exponential
  backoff (configurable attempt count).
- Per-organization job isolation — a dead/slow organization's webhook
  never blocks another organization's deliveries or the Scan API.
- Configurable worker concurrency (`WEBHOOK_WORKER_CONCURRENCY`).
- **New in this revision:** `webhook_deliveries` is now a tracked
  collection, not optional — needed for support/debugging visibility on a
  paid product ("did my webhook fire?"). Fields: `eventId, organizationId,
  attempts, lastAttemptAt, deliveredAt, lastError, status
  (pending|processing|delivered|failed)`.

---

## 7. Implementation phases

| Phase | Scope |
|---|---|
| 0 | Inspect existing repo end-to-end; confirm dev-data migration mapping (3 existing users → assign to a default org); document old→new field mapping before running anything destructive |
| 1 | Fastify migration — bootstrap, plugins, JWT auth, centralized error handling, Pino logging, `/api/health` + `/api/health/ready` |
| 2 | Organization model + Super-Admin-only CRUD + org-scoped authorization |
| 3 | User/Operator model, Organization Admin CRUD for Operators, RBAC (`SUPER_ADMIN` / `ORGANIZATION_ADMIN` / `OPERATOR`) |
| 4 | Scan model + `POST /api/scans`, idempotency, indexes |
| 5 | Redis + BullMQ wiring: queue producer, worker skeleton, configurable concurrency |
| 6 | Webhook delivery: config CRUD, timeout, retry/backoff, `webhook_deliveries` tracking |
| **6.5 (new)** | Redis-based scan-quota **counter** — tracking only, no block/reject logic yet |
| 7 | Load testing (`--organizations --users-per-organization --scans-per-user --concurrency --mode=burst`), failure testing (dead/slow/500/success webhooks simultaneously), performance tuning |

Quota **enforcement** (hard block vs. soft overage once the limit is hit)
is intentionally deferred past phase 6.5 — the counter infrastructure will
already exist, so wiring in the actual gate later is a small, contained
change rather than a redesign.

---

## 8. Environment variables (additions)

```
REDIS_URL=
WEBHOOK_WORKER_CONCURRENCY=100
WEBHOOK_TIMEOUT_MS=5000
WEBHOOK_BATCH_SIZE=100
WEBHOOK_RETRY_LIMIT=3
SCAN_QUOTA_PERIOD=monthly       # reset cadence for the Redis counter window
```

---

## 9. What stays unchanged from the original migration prompt

Everything not called out above stands as originally specified:

- Fastify-native rule — no wrapping Express inside Fastify.
- JWT strategy avoids loading the full user document on every request;
  lightweight identity + targeted lookups only where role/status
  validation is required.
- MongoDB persistence and webhook delivery remain fully independent —
  batching only affects the webhook side, never scan persistence.
- Response envelope conventions (`{status, message, data}` success,
  `{code, message}` error) stay as-is for frontend compatibility.
- Security posture: rate limiting, CORS, security headers, Mongo query
  sanitization, no trusting client-supplied `organizationId`/`userId`/`role`.
- Testing checklist (auth, OTP, JWT, org isolation, RBAC, scan idempotency,
  queue creation, webhook success/timeout/retry/failure, concurrent
  ingestion) — add org-quota-counter accuracy as one more test case.
- "Do not overengineer" still applies to everything except the quota
  counter itself: no Kafka, no RabbitMQ, no Kubernetes, no separate
  billing/payment service at this stage.

---

## 10. Open item for a future pass

- Quota-exceeded behavior (hard block vs. soft overage) — deliberately
  deferred. Revisit once ready; only affects step 3 of the scan flow in
  section 5 above plus a new `402`/`403` response case — nothing else in
  this plan needs to change to support either choice later.
---

## 11. Current implementation state (superset, not the Fastify migration)

This plan's **features** were implemented in the existing Express backend
(`scanFlow_api`), not as the Fastify migration described above. The Fastify
migration remains a documented option for a future pass; every functional
requirement below is delivered against the current Express app:

- **Multi-tenant orgs**: `POST /api/organizations` (superadmin, `manageOrganizations`)
  creates an organization + first `ORGANIZATION_ADMIN` user in one transaction.
  Non-superadmins are always forced to their own `organizationId`; a
  superadmin may pass `organizationId` in body/query.
- **Operators**: `/api/operators` org-scoped CRUD; role guard `ORGANIZATION_ADMIN`
  or `OPERATOR`; client-supplied `organizationId` is ignored for non-superadmins.
- **Scan ingestion**: `POST /api/scans` → find-then-create on
  `(organizationId, clientScanId)` unique index with 11000 race fallback →
  `202` on create / `200` on idempotent duplicate; Redis `INCR` quota counter
  (`quota.service.ts`) per period window (daily/monthly).
- **Quota counters**: period window computed from org `scanQuota.periodStart`
  (logical clock). A reconcile pass (worker every 30s + startup) syncs Redis
  `periodCount` back into `organization.scanUsage`.
- **Webhooks**: `POST /api/webhooks/config` (upsert, secret stored with
  `select:false`), BullMQ `webhook-delivery` queue + worker with HMAC
  SHA-256 `x-scanflow-signature`, per-request timeout, exponential backoff
  retries (`attempts = retryLimit`), and `webhook_delivery` status
  transitions `pending → processing → delivered/failed`. Deliveries list at
  `GET /api/webhooks/deliveries`.
- **Usage endpoint**: `GET /api/organizations/:organizationId/usage`
  (`manageScans`) → Redis `periodCount` + `quotaLimit`/`quotaPeriod`.
- **Ops**: docker-compose `redis` (redis:7-alpine) + `worker`
  (`node dist/worker.js`) services; `npm run dev:worker` for local worker.
  New env: `REDIS_URL`, `WEBHOOK_*`, `SCAN_QUOTA_PERIOD`.

Deviations worth knowing: quota-exceeded blocking is still intentionally
deferred (section 10 above); the worker runs via `tsx watch src/worker.ts`
locally; SMTP was left empty in local `.env` so OTPs fall back to the
console (`[EMAIL-CONSOLE]`) instead of sending via Gmail. `PORT_REDIS`
stray line in `.env` was removed (unused; compose uses `REDIS_PORT`).
