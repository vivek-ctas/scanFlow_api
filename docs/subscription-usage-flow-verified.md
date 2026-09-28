# ScanFlow Reference — Subscription + Usage Management Flow (Verified)

> **Source of truth:** Saas platform (`saas_api` NestJS + `saas_panel` Angular).
> This document is a **read-only verification baseline** for reproducing the exact
> subscription + usage-management machinery inside ScanFlow. No redesign — mirror the
> verified behavior below.
>
> Verification date: 2026-09. Repos:
> - `/home/ctas/vivek-ctas/Projects/Saas/saas_api` (backend, NestJS + Mongoose)
> - `/home/ctas/vivek-ctas/Projects/Saas/saas_panel` (admin panel, Angular 18 Fuse)
> - `/home/ctas/vivek-ctas/Projects/Saas/saas_manage_cron/nest_cron_manage` (separate cron app)

---

## 1. High-Level Flow (End to End)

```
Public Checkout (panel/storefront)
   │  customer enters name + email (+ phone/company) → guest lead
   │  picks plan (with free trial days) → subscribe
   ▼
GuestLead created (status: PENDING → INITIATED)
   │
   ▼
PublicCheckoutService.subscribePaidPlan
   │
   ├─ Stripe Checkout Session (mode: payment, metadata.lead_id) 
   │    └─ StripeRedirectController/webhook  → Payment(TXN_SUCCESS) → subscription activate
   │
   └─ Razorpay Order → RazorpayWebhookController/webhook (HMAC verify)
        └─ Payment(TXN_SUCCESS) → subscription activate
   ▼
Payment persisted (tbl_payments) → PaymentProcessorHandler
   │
   ▼
PublicCheckoutService._createSellerAccount(leadId, paymentId)
   └─ creates Seller (User) + subscription via UsersService._grantSubscription
   ▼
Subscription created (tbl_sellers.subscription subdoc, single-active invariant)
   status = 'active' | 'future' , queue_priority 0|1..N
   ▼
Usage enforcement
   ├─ PermissionGuard → UsageLimitGuard → handler → UsageIncrementInterceptor
   ├─ usage rows created ONLY on activation/promotion (per granted feature)
   ├─ limit check = SUM(usage rows) vs feature.grant_quantity (windowed)
   └─ hit limit → 429 FORBIDDEN_QUOTA_EXCEEDED (WebErrors.WEB_1789)
   ▼
Lifecycle (cron EVERY_MINUTE + EVERY_HOUR + onModuleInit)
   ├─ promoteDueSubscriptions (future → active when started_at due)
   ├─ purgeExpiredUsageRows (TTL = expired_at + 365d)
   └─ normalizeQueuePriorities
   ▼
Renewal (manager): renew-and-continue → also renew-and-promote / cancel-and-recreate-new
   Cancellation (manager): cancel-active → promotes earliest future
```

---

## 2. Architecture / Global Wiring

- Global prefix: `v1` (`app.setGlobalPrefix('v1')`).
- Dependency injection: NestJS 11 + Mongoose, `@nestjs/schedule` cron.
- **No Redis / Bull.** All queues, feature meters and windows are **in-memory** (or cup) — single-instance assumption.
- External payment deps: `stripe@^22.1.1`, `razorpay@^2.9.6`.
- Email: `UserSubscriptionEmail` service (handlebars templates).

### Global guard/interceptor chain (order matters)

```
Request → JwtAuthGuard → PermissionGuard(@Permission(...)) → UsageLimitGuard(@Feature(..., 'per_request'))
        → handler (writes usage via UsageIncrementInterceptor) → Response
```

| Item | Purpose |
|---|---|
| `JwtAuthGuard` | AuthN; populates `req.user` (session login via `/v1/xxx/auth/session/token` + refresh, or token-based) |
| `PermissionGuard` | AuthZ; rough `@Permission('permission')` |
| `UsageLimitGuard` | Pre-check quota; attaches `usageResolveRequest` + `usageResolveContext` to request |
| `UsageIncrementInterceptor` | After handler success, increments/records consumption for the resolved feature meter |

---

## 3. Collections & Schemas

### 3.1 `tbl_sellers` — `UserSchema` (collection: sellers)
Subdocument `subscription`:

| Field | Type | Meaning |
|---|---|---|
| `_id` | ObjectId | subscription id (referenced by usage rows) |
| `plan_id` | ObjectId | ref plan |
| `scan_limit` | Number | granted global scan/usage quantity |
| `billing_cycle` | String | 'monthly' \| 'yearly' |
| `status` | String | `active` \| `future` \| `expired` \| `cancelled` |
| `started_at` | Date | |
| `expires_at` | Date | computed via `computeExpiresAt` |
| `usage_reset_anchor` | Date | anchor for monthly counter reset |
| `queue_priority` | Number | 0=active, 1..N=future queue order |
| `plan_validity_days?` | Number | optional override days |

Single-active invariant: **at most one subscription with `status='active'` per seller.**

### 3.2 `tbl_plans` — `PlanSchema`
| Field | Type |
|---|---|
| `name` | String |
| `billing_cycle` | String (`monthly`/`yearly`) |
| `amount` | Number |
| `currency` | String ('INR'/'USD') |
| `trial_days` | Number (public checkout only; admin grants = 0) |
| `features` | Array<ObjectId> (ref `tbl_features`) |
| `coupon_id`, `coupon_apply_count` | Number |
| `billing_type` | 'free' \| 'paid' |
| `is_active`, `is_public` | Boolean |

### 3.3 `tbl_features` — `FeatureSchema`
| Field | Type | Meaning |
|---|---|---|
| `name` | String | e.g. PRODUCTS, ORDERS, INVOICES |
| `key` | String | machine key |
| `meter_type` | String | `per_request`, `body_array`, `response_field`, `file_rows`, `resource_count` |
| `meter_mode` | String | `fixed` \| ... |
| `grant_quantity` | Number | default grant for this feature |
| `rollover_type` | String | window/cycle |
| `usage_window_settings` | subdoc | `type` ('fixed'\|'rolling'\|'cycle'), `duration_days` (24), `threshold_percent` (90) , `enabled` |

### 3.4 `tbl_sections` — `SectionSchema`
Top-level grouping of features for plan builder UI:
| Field | Type |
|---|---|
| `name` | String |
| `features` | Array<ObjectId> |
| `is_active` | Boolean |
| `removedComponents` | meta |

### 3.5 `tbl_guest_leads` — `PublicCheckoutGuestLeadSchema`
status lifecycle: `pending → initiated → success | failed | cancelled`
| Field | Meaning |
|---|---|
| `name`, `email` | lead identity |
| `phone`, `company` | optional |
| `plan_id` | selected plan |
| `trial_days` | at checkout time |
| `status` | lifecycle above |
| `purchaseLink` | for later resume |

### 3.6 `tbl_usages` — `UsageSchema`
| Field | Meaning |
|---|---|
| `user_id` | seller id |
| `subscription_id` | ref seller.subscription._id |
| `feature_id` | ref feature |
| `quantity` | consumed |
| `limit` | snapshot of granted limit |
| `used` | running used |
| `start_time`/`end_time` | window slice |
| `last_used_at` | |
| `purge_after` | `expired_at + USAGE_RETENTION_DAYS(365)` — TTL index |
| `is_exhausted` | when `used >= limit` |

Usage rows exist **only while subscription is active** (created on activation/promotion;
deleted on cancel/expire/force-activate).

### 3.7 `tbl_payments` — `PaymentSchema`
| Field | Meaning |
|---|---|
| `lead_id` | guest lead ref |
| `seller_id` | created-on-activation ref |
| `gateway` | `'stripe' \| 'razorpay'` |
| `amount`, `currency` | amount is **paise** for Razorpay |
| `status` | `CREATED \| TXN_SUCCESS \| TXN_FAILURE \| FAILED \| CANCELLED` |
| `success_response`/`failed_response` | gateway payload dumps |
| `invoice_number` | `'INV-' + last 8 hex of _id` (derived) |
| `invoice_url` | stored file/pdf |

### 3.8 `tbl_feature_route_meters` — `FeatureRouteMeterSchema`
Binds a route+method to a feature meter for usage interception:
| Field | Meaning |
|---|---|
| `key` | `METHOD /path` regex-ish |
| `feature_key` | feature to meter |
| `count_mode`/`meter_mode` | `per_request`, `body_array`, `response_field`, `file_rows`, `resource_count` |
| `location` | path to count (e.g. request body/specific field) |
| `unit` | unit of consumption |

---

## 4. Endpoint / API Catalog (verified)

> All under global prefix `/v1`.

### Sellers / Auth / Session
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/sellers/session/token` | exchange refresh/token → `req.user` |
| GET | `/v1/admin/xxx/users` | sellers list |
| GET | `/v1/admin/xxx/users/:id` | seller detail |
| POST | `/v1/admin/xxx/users` | create user + optional assignPlan |
| GET | `/v1/admin/xxx/users/:id/subscription` | current subscription |
| GET | `/v1/admin/xxx/users/:id/subscription/:subscriptionId` | specific sub w/ usage rows |

### Public Checkout
| Method | Path | Notes |
|---|---|---|
| POST | `/v1/xxx/public-checkout/subscribe` | create guest lead + plan intent (paid plans) |
| POST | `/v1/xxx/public-checkout/verify-nonce` | pre-verify lead exists / resume purchase |
| POST | `/v1/xxx/public-checkout/vendor-list` | availability / collect leads |

### Payments
| Method | Path | Gateway |
|---|---|---|
| POST | `/v1/xxx/payments/checkout` | create Stripe Session / Razorpay order (existing payment idempotency) |
| POST | `/v1/xxx/payments/capture` | confirm gateway success |
| POST | `/v1/xxx/payments/webhooks/stripe` | Stripe webhook → PaymentProcessor |
| POST | `/v1/xxx/payments/webhooks/razorpay` | Razorpay webhook (HMAC) |
| GET | `/v1/xxx/payments/invoice/:id` | invoice info + pdf |
| GET | `/v1/xxx/payments/invoice/:id/download` | invoice pdf download |

### Plans / Features (admin)
| Method | Path |
|---|---|
| GET/POST | `/v1/admin/plans`, `/v1/admin/plans/:id` |
| GET | `/v1/admin/plans/public` (storefront) |
| GET/POST | `/v1/admin/features`, `/v1/admin/features/:id` |
| GET/POST | `/v1/admin/sections`, `/v1/admin/sections/:id` |
| GET/POST | `/v1/admin/feature-meters`, `/v1/admin/feature-meters/:id` |
| GET | `/v1/admin/coupons` |

### Subscription Management (admin)
| Method | Path | Notes |
|---|---|---|
| POST | `/v1/admin/users/:id/assign-plan` | grant subscription w/ queue (0 trial) |
| POST | `/v1/admin/users/:id/renew` | renew-and-continue \| renew-and-promote \| cancel-and-recreate-new |
| POST | `/v1/admin/users/:id/cancel-active` | cancel active → promote earliest future |
| POST | `/v1/admin/users/:id/force-activate` | cancel active + delete usage rows + create & activate immediately |
| GET | `/v1/admin/users/:id/usage` | usage breakdown |

---

## 5. Verified Service / Controller Behaviors

### 5.1 PublicCheckoutController
- **Transactions:** creates/updates `PublicCheckoutGuestLeadSchema` records; `subscribe` returns a session/order gateway payload referencing `lead_id`. No seller is created here — subscription only on payment success.

### 5.2 PublicCheckoutService (`submitGuestCheckout`/`subscribePaidPlan`)
- `_createSellerAccount(leadId, paymentId)`:
  1. Reads lead + payment (must be `TXN_SUCCESS`).
  2. Creates `Seller` (User) record (name, email, phone, company) if not exists by email.
  3. Calls `UsersService._grantSubscription(user, plan_id, opts)` with `trial_days` from lead.
  4. Updates lead → `success` (or `failed` on error); payment `seller_id` linked.
  5. Fires `UserSubscriptionEmail` (welcome + invoice).

### 5.3 UsersService `_grantSubscription` (shared core — one implementation)
Used by `assignPlan`, `createUser`, `renew`, `forceActivate`.

Signature: `_grantSubscription(seller/user, plan, { billing_cycle?, trial_days?, note? })`
Logic:
1. Load plan + features; compute granted quantities per feature.
2. Compute `expires_at = computeExpiresAt(billing_cycle, trial_days, from=now)`.
3. `decideInitialStatus(...)`:
   - No active sub + no future in queue & plan due now → `active`, `queue_priority = 0`, `started_at = now`.
   - Not yet due (future start) → `future`, `queue_priority = next` (FIFO append).
4. Push subscription subdoc into `seller.subscription` (multi row model) — maintaining **single active**.
5. **If status = active → `createUsageRowsForGrant(seller._id, subscription._id, features)`**:
   For each feature: `used = 0`, `limit = feature.grant_quantity ?? plan-level`, `is_exhausted=false`,
   `start_time/end_time` window (`computeWindowStart`/`createWindowED` per `usage_window_settings`),
   `purge_after = expires_at + 365d`.
6. Persist seller; push `subscription_notifications` record.

### 5.4 SubscriptionQueueService (in-memory queue)
- `getQueue(sellerId)` → ordered future subs by `queue_priority` asc.
- `activateEligibleQueues(plan?... )` → promotes due future subs.
- `promoteEarliestFuture(sellerId)` → next-in-line future → active.
- `createUsageRowsForGrant(...)` → usage rows after activation.
- `normalizeQueuePriorities(sellerId?/all)` → renumber `future` subs to `1..N` compact.

### 5.5 Renew (admin)
- `renew-and-continue`: extend current active sub from `expires_at`, and if queue has next,
  insert a **front-of-queue** sub with `queue_priority = 1` (pushes existing 1..N down),
  `status = future`, `started_at = current expires_at`.
- `renew-and-promote`: activates the queued sub immediately and renews supplier edges.
- `cancel-and-recreate-new`: cancels active then creates fresh sub (queue semantics).

### 5.6 Force-Activate
`forceActivate(sellerId, planId)`:
1. If there is an active subscription → cancel it.
2. **Delete all existing usage rows** for the seller.
3. Grant the new sub immediately as `active` (calls `_grantSubscription` with immediate status) → recreation of usage rows.

### 5.7 Cancel-active
`cancelActiveSubscription(sellerId)`:
1. Current `active` sub → `status = 'cancelled'`, `queue_priority = undefined`.
2. Set `cancellation_reason`.
3. **Delete its usage rows.**
4. `promoteEarliestFuture(sellerId)` — bring next future to active (fresh usage rows).

---

## 6. Payment Flows (Verified)

### 6.1 Stripe (`stripe@^22.1.1`) — `StripeService`
- Checkout uses `mode: 'payment'` **only** (no subscriptions / no recurring).
- `success_url`/`cancel_url` point back to storefront + lead id.
- Metadata: **only `lead_id`** (no `seller_id`).
- No Stripe **Customer** record created; no idempotency key; no refunds.
- Currency from plan; amount in minor units (paise for INR).
- Webhook: `event.type = 'checkout.session.completed'` → find `session.metadata.lead_id` →
  create `Payment(lead_id=..., status=TXN_SUCCESS, success_response=session)` → `PaymentProcessorHandler`.
- **Gotcha:** webhook signature verification enabled, but raw-body parsing provider is **NOT** configured in `main.ts` ⇒ Stripe webhook currently cannot verify payloads.

### 6.2 Razorpay (`razorpay@^2.9.6`) — `RazorpayService`
- `payment.createOrder({ amount, currency, ... , receipt: lead_id })` → `razorpay_order_id`.
- Amount in **paise**.
- `capture` → validate `razorpay_payment_id` + `order_id`; verify **HMAC**:
  `sha256(order_id + '|' + payment_id, webhook_secret)`.
- Webhook `payment.captured` → HMAC-compare `razorpay_signature` →
  `Payment(status=TXN_SUCCESS,...)` → `PaymentProcessorHandler`.
- **Gotcha:** `razorpay.webhook_secret` is **not set** in config ⇒ HMAC never match — flow is implemented but effectively disabled until secret is configured.

### 6.3 PaymentProcessorHandler (shared)
- On success payment for a lead:
  - Ensure only one processing (idempotent by existing `CREATED` payment row — new order only created if none / last is stale).
  - Calls `PublicCheckoutService._createSellerAccount(leadId, paymentId)`.
- Invoice: `invoice_number = 'INV-' + String(payment._id).slice(-8)`.

---

## 7. Usage Enforcement (Verified Pipeline)

### 7.1 UsageLimitGuard
Pre-checks before handler:
1. Reads `@Feature(...)` + `@Permission(...)` metadata.
2. Resolves current `req.user` subscription (`active`) + matching feature.
3. Looks up window settings (`UsageWindowSettingCache` → defaults `enabled=true, 24h, threshold 90%`).
4. `FeatureMeterCacheService` loads route meter → determines `count_mode`.
5. If `used >= limit` → **403 `FORBIDDEN_QUOTA_EXCEEDED` (WebErrors.WEB_1789)**; otherwise attaches
   `usageResolveRequest` (used, limit, feature) + `usageResolveContext` to the request.

### 7.2 UsageIncrementInterceptor
After a successful handler response:
1. Uses `usageResolveContext` to compute consumed quantity by mode:
   - `per_request` → 1
   - `body_array` → `req.body[location]` length
   - `response_field` → count of entities in `response.data`/specified field
   - `file_rows` → parsed CSV/import row count
   - `resource_count` → total resources touched
2. `UsageService.incrementUsage(userId, subscriptionId, featureId, count)` → updates usage row (`used += count`, `is_exhausted`), bumps `last_used_at`; refreshes window (`createWindowED`).
3. Errors here are non-fatal (logged, response unaffected) except when quota re-check fails.

### 7.3 FeatureMeterCacheService / FeatureRouteMeterRepo
- Caches `FEATURE_ROUTE_METERS` sets from `tbl_feature_route_meters` by route key.
- `invalidate...()` on CRUD of meters.
- Used by guard + interceptor to decide **which feature** a route meters against.

### 7.4 UsageWindowService + WindowSettings
- `computeWindowStart(feature)` / `createWindowED` produce window `[start_time,end_time]`; `usage_reset_anchor` + month-anniversary util for monthly reset.
- Usage rows carry starting window; increments extend window endpoint.

### 7.5 InMemoryWindowStore (`window.store.ts`)
- Map: `userId|subscriptionId|featureId → array of window slices`.
- Background sweep **every 15 minutes** removes aged-out slices.
- Used for `per_request`-style burst counting between persistent increments.
- **In-memory ⇒ lost on restart; consumption restored from usage rows on next read.**

---

## 8. Expiry / Renewal / Cancellation Lifecycle

| Trigger | Behavior |
|---|---|
| `expires_at` reached (future start due) | `promoteDueSubscriptions` → `future`→`active`, `queue_priority` 1→0, usage rows created |
| `expires_at` reached (active end) | active → `expired`, usage rows kept until TTL, queue promotes next |
| Renew (continue) | extend from expiry; inserts front-of-queue `future` sub when queue exists |
| Renew (promote) | next queued sub activated immediately |
| Cancel active (admin) | → `cancelled`; delete usage rows; promote earliest future |
| Force activate | cancel active + delete ALL usage rows + immediate new grant |
| Delete user | cascade removes usage rows (and likely payments/subscriptions), purges windows |
| Manual reset | `resetMonthlyUsage` deletes rows w/ reset anchor; recalculates `limit` |
| TTL cleanup | usage rows with `purge_after <= now` removed (EVERY_HOUR) |

---

## 9. Cron Jobs (verified)

| When | Job | File |
|---|---|---|
| `EVERY_MINUTE` | `promoteDueSubscriptions` — promote due `future` subs to `active` + create usage rows | `subscription-maintenance.job.ts` |
| `EVERY_HOUR` | `purgeExpiredUsageRows` — delete usage rows past `purge_after` (expired+365d) | `subscription-maintenance.job.ts` |
| `onModuleInit` | `normalizeQueuePriorities` — recompact `1..N` after any queue mutation | `subscription-queue.service` (bootstrapped in maintenance job) |
| internal 15min | `InMemoryWindowStore` sweep | `window.store.ts` |

Constants: `USAGE_RETENTION_DAYS = 365`.

Separate cron app: `saas_manage_cron/nest_cron_manage` (standalone NestJS schedule module; keeps cron out of API process). A Go sibling `sellerbuz_manage_cron` also exists (not used in this flow).

---

## 10. Admin Panel (saas_panel) Flows

### 10.1 Core services (`app/core`)
- `user`: current seller/subscription state, session refresh.
- `auth`/`session`: login/otp/token exchange.
- `manage-plan`: aggregate plan editions.
- `public-checkout`: lead creation + purchase flow storefront-facing.
- `plan-shop`: storefront plan listing (public plans) + subscribe.
- `feature-meter`: route-meter CRUD + cache.
- `cron-management`: trigger/status of maintenance jobs.

### 10.2 Modules (`app/modules/admin`)
- `subscription`: **subscription.component.ts** with tabs:
  - **overview** — seller summary, active plan, usage totals
  - **subscription** — pick plan, period, trial days spinner, expiry preview, assign
  - **plans** — plan cards (name, period, amount, features), renewal labels
- `sellers/list` — sellers table (name, email, plan status, filters)
- `sellers/details` — seller detail + subscription + usage
- `sellers/leads` — guest lead list, status chips (pending/initiated/success/failed/cancelled)
- `sellers/subscription-users` — sub-user row management
- `manage-plan` — create/edit plans, feature picker by sections, coupons
- `plan` — individual plan CRUD
- `feature-meter` — meters CRUD for routes
- `cron-management` — job list + last-run + toggle
- `coupon` — coupon CRUD

---

## 11. Key Gotchas (reproduce exactly — do not "fix quietly")

1. **Webhooks effectively disabled** — raw-body parsing NOT configured in `main.ts`; `razorpay.webhook_secret` absent. Flows are code-complete but will 500 on real gateway events until both are configured. Keep as-is (documented, not fixed).
2. **Single-active subscription invariant** enforced in service code (not DB constraint) — every mutation must re-check.
3. **Usage rows are lifecycle-bound** — exist only while a sub is active; created on activation/promotion, deleted on cancel/expire/force-activate. Do not persist usage rows for future/cancelled subs.
4. **Queue = FIFO by `queue_priority`** with special **front-of-queue insert (priority 1)** only for renew-and-continue.
5. **Trial days apply only on public checkout**; admin assign/renew grant 0 trial.
6. **Razorpay paise** vs Stripe minor units — keep gateway-normalized `amount` in currency unit in Payment + `gateway_amount` raw.
7. **Cron in API process** (`@nestjs/schedule`) — a separate cron app exists; choose one deployment, do not run both.
8. **Coupons defined in Plan but never applied at checkout.**
9. **Invoice number derived from payment `_id`** (`INV-` + last 8 hex) — no separate numbering sequence.
10. **In-memory windows** — restart loses burst history (usage rows are the durable truth).

---

## 12. ScanFlow Reproduction Checklist

- [ ] Add `Subscription` subdoc to org/user model (single-active, queue, `usage_reset_anchor`).
- [ ] `computeExpiresAt(billingCycle, trialDays, from)` util — port as-is.
- [ ] `decideInitialStatus` + `activateEligibleQueues`/`promoteEarliestFuture` (queue service).
- [ ] `_grantSubscription` shared core (assign/create/renew/force) + `createUsageRowsForGrant`.
- [ ] Usage schema w/ `purge_after` TTL (expired + 365d), windowed `used`/`limit`/`is_exhausted`.
- [ ] Global guard chain: Jwt → Permission → **UsageLimitGuard** → handler → **UsageIncrementInterceptor**; `@Feature()` + `@Permission()` metadata.
- [ ] Feature route meters table → `FeatureMeterCacheService` (per_request/body_array/response_field/file_rows/resource_count).
- [ ] InMemory window store + 15-min sweep (or replace w/ Redis and document).
- [ ] Cron: EVERY_MINUTE promote, EVERY_HOUR purge, onModuleInit normalize.
- [ ] Stripe `mode:payment` + metadata.lead_id; Razorpay order+HMAC; PaymentProcessorHandler idempotency.
- [ ] Public checkout guest-lead lifecycle `pending→initiated→success|failed|cancelled`; `_createSellerAccount` on TXN_SUCCESS only.
- [ ] Admin panel equivalents: subscription tabs, sellers/leads/usage views, manage-plan, feature-meter, cron-management.
- [ ] Do NOT add register endpoint — accounts are provisioned via assign-plan / create-user. ✓ matches ScanFlow current state.

---

## 13. File Index (saas_api)

| Concern | Files |
|---|---|
| Public checkout | `src/seller/public-checkout/public-checkout.controller.ts`, `public-checkout.service.ts`, `guest-lead.schema.ts` |
| Payments | `src/seller/payments/stripe.service.ts`, `razorpay.service.ts`, `payments.service.ts`, `payment.schema.ts`, webhook controllers |
| Users/subs | `src/admin/users/user.schema.ts`, `users.service.ts` (`_grantSubscription`), `users.controller.ts` |
| Plan/features | `src/admin/plan/plan.schema.ts`, `src/admin/sections/feature.schema.ts`, `section.schema.ts` |
| Queue/usage core | `src/common/services/subscription-queue.service.ts`, `usage-limit.service.ts` |
| Enforcement | `src/common/guards/usage-limit.guard.ts`, `src/common/interceptors/usage-increment.interceptor.ts` |
| Meters/cache | `src/admin/feature-meter/*`, `src/common/usage-limit/feature-meter-cache.service.ts`, `tbl_feature_route_meters` schema |
| Windows/cache | `src/common/usage-limit/window.store.ts`, `usage-window.setting.cache.ts` |
| Cron | `src/common/usage-limit/subscription-maintenance.job.ts` |
| Utils | `src/common/utils/subscription-expiry.util.ts`, `month-anniversary.util.ts`, `usage-count.util.ts`, `usage-window.util.ts` |
| Email | `src/shared/UserSubscriptionEmail/UserSubscriptionEmail.service.ts` (+ templates) |
| Auth/shared | `src/shared/auth/*` (`JwtAuthGuard`, session) |
| Cron app | `saas_manage_cron/nest_cron_manage/*` |
| Panel | `saas_panel/src/app/core/{manage-plan,plan-shop,public-checkout,feature-meter,cron-management,user,auth,session}/*`, `saas_panel/src/app/modules/admin/{subscription,sellers/*,manage-plan,plan,feature-meter,cron-management,coupon}/*` |

---

*End of verified baseline. Generated for ScanFlow reproduction; reference implementation = Saas.*