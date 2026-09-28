# ScanFlow — Subscription + Scan Usage Management: Final Implementation Plan

Verified against the live ScanFlow codebase (sync pass 2026-09-27, confirmed
2026-09-28):
1. `subscription-usage-flow-verified.md` (Saas reference — business logic source of truth)
2. `scanflow-usage-flow-current.md` (ScanFlow current, verified against actual source)

The external spec text ("doc 9") was never saved as a file in the repo — it
only ever existed as a chat message — so it isn't on disk and opencode
correctly can't cite it. **This plan is the source of truth.** All test
cases from that original message are reproduced in full in §14 so nothing
from it is lost or silently reinvented.

This plan ports the Saas subscription **lifecycle** (single-active + FIFO
future queue, grant/renew/cancel/force-activate) exactly as specified, but
collapses the Saas generic multi-feature usage engine down to ScanFlow's one
real metric: **SCAN_COUNT**. No plans/sections/coupons/feature-meters/
window-store machinery is ported — only what a single counted quantity
needs.

---

## 0. Decisions finalized 2026-09-28 — nothing left open

### 0.1 Stack: Express 5 — CONFIRMED FINAL
Verified directly in code: `src/app.ts:23` is `const app = express()`,
`src/index.ts:18` boots it with `app.listen(...)`, `src/utils/catchAsync.ts`
types against `express`, `package.json` pins `express@^5.0.1`. There is no
`src/server.ts`; the entry point is `src/index.ts`. **This overrides an
earlier "it's Fastify" recollection** — re-platforming everything already
built (organizations/operators/scans/webhooks, admin/user split, role
cleanup) to Fastify just for this feature would be pure migration risk with
no benefit; the live code is Express and stays Express. Everything below is
Express-native: raw-body handling via the existing `express.json()`
`verify` callback (§6.1), `Router`-based route registration, the existing
`errorConverter`/`errorHandler` pair.

### 0.2 SUPER_ADMIN → Operators permission — CONFIRMED
`src/config/roles.ts:2-8` — `SUPER_ADMIN` already includes
`manageOperators` (alongside `manageOrganizations`, `viewOperators`,
`manageScans`, `manageWebhooks`). No reversal needed. This pass adds two new
rights: `manageSubscriptions` (SUPER_ADMIN) and `viewSubscription`
(ORGANIZATION_ADMIN, own org only) — see §9.

### 0.3 Subscription storage shape — CONFIRMED: standalone collection
Standalone `Subscription` collection (§2.3), not embedded in `Organization`.
Matches the index design in §2.3 exactly, keeps `Organization` documents
bounded regardless of renewal history, and — per §4 below — the scan hot
path doesn't even pay for this as a per-request Mongo query once the
active-subscription cache is warm.

### 0.4 Active-subscription cache — CONFIRMED: build it now, not deferred
The naive design would add a full Mongo `Subscription` lookup to every
single scan request just to read `scanLimit`/`expiresAt`, on the busiest
endpoint in a system whose entire value proposition is high-concurrency scan
throughput. That's not a hypothetical bottleneck to defer until traffic
proves it — it's a predictable one on the exact path performance most
matters for. Built into §4/§5 below from the start, not as a follow-up.

---

## 1. What ScanFlow needs vs what Saas has (scope collapse)

| Saas concept | ScanFlow equivalent | Included? |
|---|---|---|
| Subscription (single-active, FIFO future queue) | Same, ported exactly | ✅ full port |
| Plan (name, billing cycle, amount, trial days) | Same, minus `features[]`/`sections` | ✅ minimal |
| Usage rows, windowed, per-feature | One usage row per subscription, SCAN_COUNT only | ✅ minimal |
| Guest lead lifecycle | Same states, minus `purchaseLink` complexity beyond resume | ✅ full port |
| Payment (Stripe + Razorpay) | Same gateways, same statuses | ✅ full port |
| Features / Sections / Coupons / Feature-route-meters | — | ❌ not built |
| UsageLimitGuard + UsageIncrementInterceptor generic pipeline | Replaced by one atomic Redis check inline in `createScan` | ❌ not built (see §5) |
| In-memory window store (15-min sweep) | Not needed — one metric, one Redis key per period | ❌ not built |
| Separate cron app | Existing ScanFlow worker process, extended | ✅ reused |

---

## 2. Data model changes

### 2.1 `Organization` — remove the old flat quota, keep everything else
```diff
- scanQuota: { limit, period, periodStart }
- scanUsage: { count, lastSyncedAt }
```
Fully superseded by `Subscription` + `Usage` below. **Do not keep them
alongside the new model** — that's exactly the USER_ADMIN/ORGANIZATION_ADMIN
duplication mistake this project already spent a full pass cleaning up.
Migrate existing `scanQuota.limit` into an initial `Subscription` + `Plan`
during §10, then drop the fields.

### 2.2 `Plan` (new collection)
```
_id, name, billingCycle ('monthly'|'yearly'), amount, currency
trialDays        // public checkout only; 0 for admin-assigned
scanLimit        // the one metric ScanFlow meters
isActive, isPublic, createdAt / updatedAt
```

### 2.3 `Subscription` (new, standalone collection — see §0.3)
```
_id, organizationId, planId
scanLimit             // snapshotted from plan at grant time
billingCycle
status                // 'active' | 'future' | 'expired' | 'cancelled'
startedAt, expiresAt, usageResetAnchor
queuePriority         // 0 = active, 1..N = future FIFO order
planValidityDays?, cancellationReason?
createdAt / updatedAt
```
Indexes: `{ organizationId: 1, status: 1 }`, `{ organizationId: 1, queuePriority: 1 }`.
Invariant (code-enforced, exactly as Saas does it): **at most one
`status: 'active'` subscription per organization** — every mutation path
re-checks this before writing.

### 2.4 `Usage` (new, standalone collection)
```
_id, organizationId, subscriptionId
used, limit           // limit snapshotted from subscription.scanLimit
startTime / endTime, lastUsedAt, isExhausted
purgeAfter            // subscription.expiresAt + 365d — TTL index
createdAt / updatedAt
```
One row per subscription, not per scan. Only the active subscription's
Usage row is ever written by the scan path; a future subscription gets no
Usage row until promoted (a fresh row is created at promotion time, not
reused).

### 2.5 `GuestLead` (new collection)
```
_id, firstName, lastName, email, phone?, company?, planId, trialDays
status    // 'pending' -> 'initiated' -> 'success' | 'failed' | 'cancelled'
purchaseLink, createdAt / updatedAt
```
No single `name` field — the checkout form collects `firstName` + `lastName`
separately (both required), mirroring what `organizations.service.createOrganization`
needs (`adminFirstName`/`adminLastName`). Never reconstruct them from a
`name.split(' ')` at implementation time.

### 2.6 `Payment` (new collection)
```
_id, leadId, organizationId?, gateway ('stripe'|'razorpay')
amount                // normalized to currency's major unit
gatewayAmount         // raw gateway amount (paise for Razorpay)
currency
status                // 'CREATED'|'TXN_SUCCESS'|'TXN_FAILURE'|'FAILED'|'CANCELLED'
gatewayEventId        // Stripe event id / Razorpay payment id — §6.3 idempotency
successResponse / failedResponse
invoiceNumber         // 'INV-' + last 8 hex of _id
invoiceUrl, createdAt / updatedAt
```
Indexes: `{ leadId: 1 }`, `{ gatewayEventId: 1 }` unique.

---

## 3. Subscription core — one shared service, every caller routes through it

Exactly one `grantSubscription(organizationId, planId, options)`
implementation, called by: admin assign-plan, Stripe success, Razorpay
success, renew, force-activate. No entry point gets its own copy.

```
grantSubscription(organizationId, planId, { trialDays = 0, note? }):
  1. Load plan (must be isActive).
  2. expiresAt = computeExpiresAt(plan.billingCycle, trialDays, from = now or previous expiry)
  3. decideInitialStatus(organizationId):
       - no active AND no future queued AND due now → status='active', queuePriority=0, startedAt=now
       - otherwise → status='future', queuePriority = max(existing future)+1,
         startedAt = previous active's expiresAt (FIFO chain)
  4. Insert Subscription document.
  5. If status === 'active':
       a. Create Usage row (used=0, limit=plan.scanLimit, startTime=startedAt,
          endTime=expiresAt, purgeAfter=expiresAt+365d)
       b. Write the Redis active-subscription cache (§4):
          HSET org:{organizationId}:activeSub limit <scanLimit> expiresAt <epoch ms>
  6. Return the created subscription.
```
`computeExpiresAt(billingCycle, trialDays, from)` — single shared utility.
No other function computes an expiry date.

### 3.1 Queue operations (ported exactly — Saas reference §5.4)
```
getOrganizationSubscriptionQueue(organizationId)
activateEligibleSubscriptions()                       // cron: promote due future -> active
promoteEarliestFutureSubscription(organizationId)     // -> active, create Usage row, write cache (§3 step 5b)
normalizeQueuePriorities(organizationId)              // re-pack future queuePriority to 1..N
```

### 3.2 Renew (ported exactly — Saas reference §5.5)
- `renew-and-continue`: extend active `expiresAt`; **update the Redis cache's
  `expiresAt` field too** (`HSET ... expiresAt <new value>` — the cache must
  never silently go stale while the underlying subscription is still
  active). If a future queue exists, insert the renewal at front-of-queue
  (`queuePriority = 1`), pushing existing 1..N down.
- `renew-and-promote`: activate the next queued subscription immediately
  (writes the cache per §3.1's promote step).
- `cancel-and-recreate-new`: cancel active, then call `grantSubscription`
  fresh.

### 3.3 Cancel-active (ported exactly — Saas reference §5.7)
```
1. Find active subscription (404 if none).
2. status = 'cancelled', cancellationReason set.
3. Close its Usage row (retained for the 365d TTL, not deleted).
4. DEL org:{organizationId}:activeSub               // no active subscription until the next promotion
5. promoteEarliestFutureSubscription()               // re-writes the cache if a future sub exists
6. normalizeQueuePriorities()
```

### 3.4 Force-activate (ported exactly — Saas reference §5.6)
```
1. If an active subscription exists, cancel it (§3.3 steps 2-4, skip the promote).
2. Create the target plan's subscription immediately as active (queuePriority=0).
3. Fresh Usage row (used=0, limit=plan.scanLimit).
4. Write the cache (§3 step 5b).
5. normalizeQueuePriorities().
```

**Rule for every function above:** any code path that changes which
subscription is active for an organization writes or deletes
`org:{organizationId}:activeSub` in the same operation. This cache has
exactly one writer surface — the functions in this section — so there's
only one place that can ever get it wrong, and it's covered by the tests in
§14.

---

## 4. Atomic scan-quota enforcement + active-subscription cache (new code, no Saas precedent)

Saas's guard/interceptor pipeline does a plain read-then-write and is fine
there because Saas documents no single-instance concurrency requirement.
This plan explicitly rejects that pattern.

**Two problems solved in one Redis round trip:**
1. Quota check-and-increment must be atomic (no overshoot under concurrency).
2. Reading `scanLimit`/`expiresAt` must not cost a Mongo query on every scan
   (§0.4) — solved by caching them in Redis, kept in sync exclusively by §3's
   subscription-state functions.

**Cache key:** `org:{organizationId}:activeSub` — Redis hash,
`{ limit, expiresAt }` (epoch ms).

**Counter key:** unchanged shape — `org:{organizationId}:scans:{period}:{key}`.

**Atomic check (Lua, single round trip):**
```lua
-- KEYS[1] = counter key, KEYS[2] = org:{orgId}:activeSub hash
-- ARGV[1] = now (epoch ms), ARGV[2] = counter TTL seconds
local subData = redis.call('HMGET', KEYS[2], 'limit', 'expiresAt')
local limit = tonumber(subData[1])
local expiresAt = tonumber(subData[2])
if not limit or not expiresAt then
  return -2   -- cache miss: caller falls back to Mongo, populates cache, retries once
end
if expiresAt <= tonumber(ARGV[1]) then
  return -3   -- subscription expired (per cache)
end
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current + 1 > limit then
  return -1   -- quota exceeded
end
local newVal = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return newVal
```
- `-1` → 403 `FORBIDDEN_QUOTA_EXCEEDED`, no scan created.
- `-2` → **cache miss, not an error path.** Query Mongo for the active
  subscription (the *only* time the scan path touches the `Subscription`
  collection), populate the cache, retry the script once. No active
  subscription in Mongo either → 403 `NO_ACTIVE_SUBSCRIPTION`. If the
  retried script returns `-2` a second time (the subscription changed
  between the Mongo read and the retry), do not loop — treat that as 403
  `NO_ACTIVE_SUBSCRIPTION` too. A cold cache after deploy/restart costs one
  Mongo read for the first scan per org; every scan after that for that org
  is cache-only until the subscription next changes.
- `-3` → 403 `SUBSCRIPTION_EXPIRED` (enforced from the cache; the
  promote cron should already have flipped this, but the request path
  doesn't trust timing).
- positive integer → allowed, that's the new count.
- `EXPIRE` on every successful call fixes the current implementation's known
  gap of Redis counter keys never expiring — TTL set to end-of-period plus a
  small buffer, refreshed each increment.
- **Release on late-detected duplicate:** if the Mongo insert 11000s, issue
  a plain `DECR` on the counter key (not the `activeSub` hash) to release
  the reservation.

---

## 5. Scan request flow (exact order, implementation must follow verbatim)

```
POST /api/scans
1. JWT auth
2. permission check (auth('manageScans'))
3. resolveOrganizationScope(reqUser, body.organizationId, { required: true })
4. assertOrganizationActive(orgId)   → 400 if org missing/inactive; returns the org doc
5. atomic Redis reserve (§4)         → -1 quota exceeded / -2 cache miss (fall back to Mongo, populate, retry) / -3 expired / positive = allowed
6. findOne({ organizationId, clientScanId })  → duplicate? release reservation (DECR), return 200 "duplicate ignored", created:false
7. Scan.create({...})                → on 11000 race: release reservation (DECR), re-query, return 200 duplicate
8. createDeliveryAndEnqueue(scan)    → WebhookDelivery(pending) + BullMQ push (unchanged)
9. respond 202 "Scan accepted for processing.", created:true
```
Steps 6 onward are the existing, working current flow — only step 5 (cache-
backed atomic quota, replacing a live Mongo subscription check) is new, and
step 7's error path gains the release call.

**Redis-down behavior:** if Redis is unreachable at step 5, reject with a
`503`-style "temporarily unavailable" response rather than either silently
skipping enforcement or 500ing after already persisting a scan. Keep these
two failure cases separate: a reservation failure never creates a scan; a
background reconciliation failure never un-succeeds one that's already
persisted.

---

## 6. Payment gateways — fixing both known Saas bugs, not reproducing them

### 6.1 Stripe
- Checkout Session, `mode: 'payment'`, `metadata.lead_id` — same as Saas.
- **Fix (do not reproduce Saas's raw-body bug):** the app already consumes
  the body via the global `express.json({ limit: '10mb' })` in
  `src/app.ts`. Add a `verify` callback that stashes the raw buffer:
  ```ts
  app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => {
    (req as any).rawBody = buf;
  }}));
  ```
  The Stripe webhook route then uses
  `stripe.webhooks.constructEvent(req.rawBody, sig, config.stripe.webhookSecret)`.
  Normal JSON parsing is preserved for every other route.

### 6.2 Razorpay
- Order creation in paise, `receipt = leadId`.
- **Fix:** `RAZORPAY_WEBHOOK_SECRET` must actually be set — Saas's bug is a
  webhook that's code-complete but silently dead because the secret was
  never configured. Add to `.env.example` (currently has zero Stripe/
  Razorpay variables), marked required:
  ```
  STRIPE_SECRET_KEY=
  STRIPE_WEBHOOK_SECRET=   # required
  RAZORPAY_KEY_ID=
  RAZORPAY_KEY_SECRET=
  RAZORPAY_WEBHOOK_SECRET= # required
  ```
  Wire as `config.stripe` / `config.razorpay` in `src/config/config.ts`,
  following the existing `config.webhook` pattern.
- HMAC verify: `sha256(order_id + '|' + payment_id, webhook_secret)`, reject
  on mismatch before touching Payment/organization state.

### 6.3 Idempotency
- `Payment.gatewayEventId` unique index — a replayed webhook event fails the
  insert / is caught by a `findOne` check first; handler returns success
  without re-running provisioning.
- `GuestLead.status` transitions via
  `findOneAndUpdate({ _id, status: 'initiated' }, { $set: { status: 'success' } })`
  — the conditional filter on current status means a concurrent duplicate
  delivery finds zero matching documents on its second attempt and takes the
  "already handled" branch instead of provisioning twice. This gives the
  same safety as a DB transaction without requiring a replica set.
- `PaymentProcessor` (shared by both gateways) also checks for an existing
  `organizationId` on the lead before calling `createOrganization` — belt
  and suspenders alongside the guard above.

---

## 7. Public checkout + guest lead

```
POST /api/public-checkout/subscribe
  1. Create GuestLead ('pending' -> 'initiated' once a gateway session/order is created);
     the checkout form collects firstName + lastName separately (§2.5) — stored as-is,
     never split from a single name field
  2. Create Stripe Session or Razorpay Order, metadata/receipt = lead._id
  3. Return the gateway's redirect/session payload to the client

(webhook, on gateway success)
  4. Verify signature (§6.1/§6.2)
  5. Idempotency guard (§6.3)
  6. Payment.create(status: TXN_SUCCESS)
  7. Call the SAME organizations.service.createOrganization(...) function
     that /api/organizations already uses — not a second copy, and not an
     internal HTTP call (no JWT exists in a webhook context; call the
     service function directly). Map the lead into the org-admin args:
     adminEmail=lead.email, adminFirstName=lead.firstName,
     adminLastName=lead.lastName, adminContactNo=lead.phone.
     The checkout-created admin has no password (OTP-only send-otp/verify-otp),
     consistent with the current provisioning model.
  8. grantSubscription(newOrg._id, lead.planId, { trialDays: lead.trialDays })
  9. GuestLead.status = 'success' (conditional update, §6.3)
  10. Send welcome/invoice email (existing email.service pattern)

(on failure at any step)
  GuestLead.status = 'failed'; Payment.status = 'FAILED'/'TXN_FAILURE';
  no organization/subscription is created.
```

---

## 8. Admin manual subscription APIs

```
GET  /api/organizations/:organizationId/subscription
GET  /api/organizations/:organizationId/usage    (existing — rewritten to read Subscription+Usage, not the old flat quota)
POST /api/organizations/:organizationId/subscription/assign-plan
POST /api/organizations/:organizationId/subscription/renew
POST /api/organizations/:organizationId/subscription/cancel-active
POST /api/organizations/:organizationId/subscription/force-activate
```
All under `manageOrganizations` for SUPER_ADMIN; `ORGANIZATION_ADMIN` gets
read-only (`GET`) for their own org only — assign/renew/cancel/force-
activate stay SUPER_ADMIN-only (billing action).

Extend `src/routes/admin/organizations.route.ts` under
`/:organizationId/subscription`, following its existing
`auth('manageOrganizations')` + `validate(...)` + controller pattern. Add
`src/routes/public-checkout.route.ts` for §7, mounted in
`src/routes/index.ts`. Error style: `ApiError` carries `statusCode +
message` only — prefix messages with the codes (`NO_ACTIVE_SUBSCRIPTION`,
`SUBSCRIPTION_EXPIRED`, `FORBIDDEN_QUOTA_EXCEEDED`) and use **403 for all
three** statuses (uniform; a second `-2` on the §4 retry also maps to 403
`NO_ACTIVE_SUBSCRIPTION`); don't add a new error-code field.

---

## 9. Authorization

```
SUPER_ADMIN:        manageOrganizations, manageOperators, manageScans, manageWebhooks,
                     manageSubscriptions (new)
ORGANIZATION_ADMIN:  manageOperators (own org), manageScans, manageWebhooks,
                     viewSubscription (new — read own org's subscription/usage only)
OPERATOR:            manageScans only
```
`organizationId` always derives from `req.user.organizationId` for
non-super-admin callers on every subscription/usage/scan route.

---

## 10. Migration (existing orgs' flat quota → Subscription)

1. **Report first**: print every organization's current `scanQuota.limit`/`period`.
2. For each active org with a non-zero `scanQuota.limit`: create a "Migrated
   Plan" (reuse one if limits match across orgs) with that `scanLimit` and
   `billingCycle` mapped from `period`, then `grantSubscription(org._id,
   migratedPlan._id, { trialDays: 0 })` → becomes active immediately.
3. Only after confirming the dry-run report: `$unset`
   `scanQuota`/`scanUsage` on the schema and all documents.
4. Existing Redis counter keys (`org:*:scans:monthly:*`) stay valid — the new
   atomic script reads/writes the same key shape, comparing against
   `subscription.scanLimit` (via the cache) instead of `org.scanQuota.limit`.
5. Sweep the rest of the codebase so `scanQuota`/`scanUsage` hit zero outside
   the migration script:
   - `src/validations/admin/organizations.validations.ts`: remove
     `scanQuotaLimit`/`period` from `createOrganization` and the
     `scanQuota` object from `updateOrganization`.
   - Any script that sets a default `scanQuota` on backfilled orgs: update
     to call `grantSubscription(...)` or drop the field set.

---

## 11. Webhook: keep isolation, close the batching gap

Webhook worker stays fully isolated from the scan API (unchanged, already
correct) — but batching was specified from the start
(`webhook_configs.batchSize`) and was never implemented; the current worker
sends one HTTP call per scan event. Close this gap now, since performance
under many concurrent operators is an explicit goal here:

- Worker groups pending `WebhookDelivery` rows **per organization** into one
  outbound POST once either (a) the group reaches `webhookConfig.batchSize`,
  or (b) a short debounce window elapses (proposed default: 2 seconds) for
  low-traffic orgs. **This debounce value is a proposed default, not
  specified anywhere — flag if you want a different number or a config
  knob instead of a hardcoded constant.**
- Batch payload: `{ events: [ {eventId, scanId, ...}, ... ] }` — one HTTP
  call, one signature, one delivery-status update per event inside it
  (`WebhookDelivery` rows still tracked individually for retry/audit).
- Timeout/retry/backoff/per-org isolation unchanged, just applied to a batch.

---

## 12. Maintenance jobs (extend the existing worker)

The worker already runs a 30s `reconcileScanUsage()` loop with no scheduler
library — use the same `setInterval` mechanism, don't add a cron package:
```
EVERY_MINUTE (60s):  activateEligibleSubscriptions()
                     + when an active subscription expires with no future
                       successor, DEL org:{orgId}:activeSub — closes §3's
                       "every state change manages the cache" rule for the
                       natural-expiry-no-successor case
EVERY_HOUR (1h):      purge Usage rows past purgeAfter (TTL index already handles this; job is only for logging/audit)
on boot:              normalizeQueuePriorities() for every org with a future queue
```
Run only in the worker process — never duplicated into the API process.
Reconciliation of Redis → `Usage.used` works as today, targeting
`Usage.used` instead of `Organization.scanUsage.count`.

---

## 13. Clean-code requirements for this pass

- `Organization.scanQuota`/`scanUsage`: **removed**, not deprecated-and-kept.
- `quota.service.ts`'s existing functions get **refactored in place** to
  read from the active-subscription cache/Subscription doc instead of
  `org.scanQuota` — not duplicated into a parallel "v2" set.
- No generic feature/meter engine, no in-memory window store, no Sections/
  Coupons — anything not in §1's "Included" column doesn't get built.
- Repository-wide grep after implementation for `scanQuota`/`scanUsage` →
  zero hits outside the migration script itself.

---

## 14. Tests — full case list (reproduced here since the original spec text isn't on disk)

**Subscription:**
1. No active subscription → assigned plan becomes active.
2. Existing active → new plan becomes future.
3. Multiple future subscriptions preserve FIFO.
4. Expiry promotes earliest future.
5. Cancel active promotes earliest future.
6. Force activate resets usage.
7. Renew works.
8. Single-active invariant never breaks.

**Payment:**
9. Stripe success provisions organization exactly once.
10. Razorpay success provisions organization exactly once.
11. Duplicate webhook is idempotent.
12. Invalid webhook signature is rejected.
13. Failed payment does not create an active subscription.

**Usage:**
14. New active subscription starts at 0.
15. One scan increments usage by exactly 1.
16. Duplicate `clientScanId` does NOT consume usage.
17. Quota exactly at limit rejects the next scan.
18. Concurrent scans cannot overshoot quota.
19. Daily counter works.
20. Monthly counter works.
21. Subscription change uses the correct new limit.
22. Expired subscription cannot scan.
23. Future subscription cannot consume usage.
24. Redis failure has defined safe behavior.

**Auth:**
25. Organization Admin cannot access another organization.
26. Operator cannot manage subscription.
27. Super Admin can manage organization subscription.
28. Operator scans consume own organization's quota.

**Webhook:**
29. Scan persists even when webhook delivery fails.
30. Webhook retry works.
31. Webhook failure does not block the scan response.

**Cache (new — added for §4's active-subscription cache, not in the
original 31):**
32. Cache miss on a cold key falls back to Mongo, populates the cache, and
    the retried request succeeds/fails correctly (no double-charge from
    the fallback path).
33. Renew updates the cache's `expiresAt` in the same operation — a scan
    immediately after renewal does not see a stale expired-per-cache state.
34. Cancel deletes the cache; a scan immediately after cancellation gets
    `NO_ACTIVE_SUBSCRIPTION`, not stale cached quota room.

**Mandatory concurrency test:** organization at 99,900/100,000, fire 500
concurrent scan requests from multiple operators. Assert exactly 100 succeed
and 400 are rejected with `FORBIDDEN_QUOTA_EXCEEDED`, and the persisted
`Scan` collection count for that org matches the accepted count exactly (no
overshoot, no undercount).

---

## 15. Implementation order

**Phase 0 (done — nothing to repeat):** Express confirmed (§0.1), roles
confirmed (§0.2).

**Phases 1-10:** inspect → models (§2) → subscription core + cache wiring
(§3-4) → scan integration (§5) → admin APIs (§8-9) → public checkout (§7) →
payment gateways (§6) → webhook batching (§11) → maintenance worker (§12) →
tests/concurrency verification (§14), with the migration (§10) run between
phases 2 and 3 so existing organizations have a valid subscription (and a
warm cache) before quota enforcement goes live — otherwise every existing
org's next scan would hit `NO_ACTIVE_SUBSCRIPTION` the moment enforcement
ships.