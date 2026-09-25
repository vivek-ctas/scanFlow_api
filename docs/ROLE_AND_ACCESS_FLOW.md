# ScanFlow — Role Management & Access Flow (current implementation)

> Status: **verified against code** on 2026-09-25 (updated after the role
> cleanup removed the legacy account tier). This document describes the roles,
> permissions, hierarchy, file layout and panel gating as they exist **today**
> in the `scanFlow_api` Express backend + `scanflow_panel` React frontend.
>
> It does **not** propose a redesign. It explains the single role tree and the
> server-side `admin/` vs `user/` file separation.
>
> Related files: `Scanflow_final_architecture_plan.md` (target architecture),
> `SCANFLOW_API_CURRENT_FLOW.md` (node-level API reference, written before the
> multi-tenant superset — see §12), `Scanflow_role_cleanup_plam.md` (the cleanup
> plan that migrated away from the legacy tier).

---

## 1. TL;DR — ONE role tree

After the role cleanup (migration in `src/scripts/cleanup-role-migration.ts`),
the legacy account-tree roles (`USER_ADMIN`, `USER`, `SUB_USER`) and the
`parent_id` / `is_sub_user` hierarchy were **removed**. There is now exactly one
role tree:

```
SUPER_ADMIN ──> Organization ──> ORGANIZATION_ADMIN ──> OPERATOR
```

| Role | Purpose |
|---|---|
| `SUPER_ADMIN` | Global management: organizations, all users (operators + org admins), scans, webhooks |
| `ORGANIZATION_ADMIN` | Runs an organization: creates/manages its OPERATOR accounts ("sub-users"), scans, webhooks; scoped to own `organizationId` |
| `OPERATOR` | Read-only member of an organization: records & lists scans; no user management, no webhooks |

Server-side files are physically split by domain (mirrored in
`routes/`, `controllers/`, `services/`, `validations/`):

| Folder | Domain | Resources |
|---|---|---|
| `src/*/admin/` | SUPER_ADMIN only | `organizations` (all endpoints are `manageOrganizations`) |
| `src/*/user/` | org tier (ORGANIZATION_ADMIN + OPERATOR) | `operators`, `scans`, `webhooks` (SUPER_ADMIN also has these rights globally) |
| `src/*/` (root) | shared | `auth` routes/controller/service/validation, `common.service`, `quota.service`, `email.service`, `token.service`, `custom.validation` |

---

## 2. Current role → rights matrix (`src/config/roles.ts`)

```ts
export const allRoles = {
  SUPER_ADMIN: [
    'manageOrganizations',
    'viewOperators',
    'manageOperators',
    'manageScans',
    'manageWebhooks',
  ],
  ORGANIZATION_ADMIN: [
    'viewOperators',
    'manageOperators',
    'manageScans',
    'manageWebhooks',
  ],
  OPERATOR: ['manageScans'],
};
```

| Role | Rights | Assignable via | Scoping |
|---|---|---|---|
| `SUPER_ADMIN` | all 5 (`manageOrganizations`, `viewOperators`, `manageOperators`, `manageScans`, `manageWebhooks`) | **never** (`ORGANIZATION_ASSIGNABLE_ROLES` excludes it) | global (may pass `organizationId`) |
| `ORGANIZATION_ADMIN` | `viewOperators`, `manageOperators`, `manageScans`, `manageWebhooks` | operators API only (`ORGANIZATION_ASSIGNABLE_ROLES`) | forced to own `organizationId` |
| `OPERATOR` | `manageScans` | operators API only (`ORGANIZATION_ASSIGNABLE_ROLES`) | forced to own `organizationId` |
| `USER` | *(none)* | users/register API (`ASSIGNABLE_ROLES`) | none |

Constants exported by `roles.ts`:

```ts
SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
ASSIGNABLE_ROLES = ['USER_ADMIN', 'USER'];                        // via /users + /auth/register
ORGANIZATION_ASSIGNABLE_ROLES = ['ORGANIZATION_ADMIN', 'OPERATOR']; // via /operators
```

### How authorization is enforced

- `auth(...rights)` (`src/middlewares/auth.ts`) loads the user via the JWT
  strategy, looks up `roleRights.get(user.role)`, and requires **every**
  requested right with `.every()`. Today every route guard passes exactly one
  right, so this behaves like "user must have this right". If a multi-right
  guard is ever added, **all** of them must match.
- One deliberate bypass: `GET /users/:userId` is allowed when `userId` is the
  logged-in user's own id (self read), regardless of rights.
- Role-based helpers used across services (same logic duplicated in two files):
  - `isRequesterAdmin(reqUser)` — `src/services/admin/users.service.ts:21`
  - `isRequesterSuperAdmin(reqUser)` — `src/services/organizations.service.ts:17`
  - Both check `isSuperAdmin === true || role === 'SUPER_ADMIN'`.

---

## 3. Account model — which fields matter (`src/models/user.model.ts`)

All roles live in **one** collection, `tbl_user` (Mongoose `User` model). The
fields that define *which* family a user belongs to:

| Field | Meaning |
|---|---|
| `role` | one of the 5 roles (enum from `roles.ts`), default `'USER'` |
| `isSuperAdmin` | boolean tier companion to the `SUPER_ADMIN` role (default `false`) |
| `is_sub_user` | `true` = placed under a `parent_id` (Tier A sub-user) |
| `parent_id` | `ObjectId` ref to the parent `USER_ADMIN`/`USER` account (Tier A) |
| `organizationId` | `ObjectId` ref to `tbl_organization` — the **authorization boundary for Tier B** |
| `status` | `1` active, `0` inactive, `2` soft-deleted |
| `created_by` / `modified_by` | auditing |

Modal rule: `SUPER_ADMIN` is **never** assignable through any role API
(create-user, update-user, sub-user role, operator role all reject it).

---

## 4. Tier A — the brand/account tree (legacy)

```
SUPER_ADMIN  (manageUsers + manageSubUsers — global)
   │   creates & manages any user, any role
   └── USER_ADMIN  (manageSubUsers — scoped to own children)
          │   creates & manages their OWN sub-users only
          └── SUB_USER  (role usually 'USER', is_sub_user=true, parent_id=USER_ADMIN)
USER  = standalone account, no rights, no children API
```

### 4.1 Endpoints

Managed by SUPER_ADMIN — all require `manageUsers` (`src/routes/admin/users.route.ts`):

| Method | Path | Note |
|---|---|---|
| GET | `/api/users` / `/api/users/get-all/user` | list (search, status, role, paginated; status `2` excluded by default) |
| POST | `/api/users/create-user` | create any assignable role (`USER_ADMIN`/`USER`) |
| GET | `/api/users/:userId` | get one |
| PUT | `/api/users/admin-update/:userId` | update profile/role/status |
| PATCH | `/api/users/:userId/role` | change role (never `SUPER_ADMIN`) |
| POST | `/api/users/:userId/update-status` | activate / deactivate / toggle |
| DELETE | `/api/users/:userId` | soft delete → status `2` (owns-account guard) |

Managed by SUPER_ADMIN + USER_ADMIN — all require `manageSubUsers`
(`src/routes/user/sub-users.route.ts`):

| Method | Path | Note |
|---|---|---|
| POST | `/api/users/create-sub-user` | SUPER_ADMIN passes `parent_id`; USER_ADMIN's own id is implied |
| GET | `/api/users/get-all-sub-users` | list of `is_sub_user: true`; non-admin scoped to `parent_id = reqUser._id` |
| GET | `/api/users/sub-user/:subUserId` | one |
| PUT | `/api/users/update-sub-user/:subUserId` | edit |
| PATCH | `/api/users/sub-user-role/:subUserId` | role change |
| POST | `/api/users/sub-user-status/:subUserId` | status change |
| DELETE | `/api/users/sub-user/:subUserId` | soft delete |

### 4.2 Scoping rule (verified)

`src/services/user/sub-users.service.ts` → `resolveParentScope`:

- If the requester is a SUPER_ADMIN (`isRequesterAdmin`), `parent_id` may be
  provided; listing with no `parentId` returns all sub-users.
- Otherwise (a `USER_ADMIN`), the scope is **forced** to `reqUser._id` — a
  USER_ADMIN can only ever see/change their own sub-users.

### 4.3 Public self-registration

`POST /api/auth/register` is **public** (`src/routes/auth.route.ts:9`, included
in `PUBLIC_PATHS`). Validation restricts the assignable role to
`ASSIGNABLE_ROLES` (`USER_ADMIN`/`USER`), default `USER`
(`src/validations/auth.validation.ts`). It creates a Tier-A user and issues
tokens immediately. (The architecture plan wanted this endpoint removed in
favor of super-admin-only provisioning — see §10 gaps.)

---

## 5. Tier B — the multi-tenant organization tree (the scan product)

```
SUPER_ADMIN
   └─ POST /api/organizations ────────────────►  Organization (name/email/contact,
        (manageOrganizations)                        scanQuota{limit,period,periodStart},
                                                     scanUsage{count,lastSyncedAt}, status)
        + auto-creates the first ORGANIZATION_ADMIN user (organizationId = org._id)
                                                        │
                                      ┌─────────────────┴─────────────────┐
                     ORGANIZATION_ADMIN                          OPERATOR
                     manageOperators, manageScans,              manageScans only
                     manageWebhooks                             (records scans)
```

Both `ORGANIZATION_ADMIN` and `OPERATOR` carry `organizationId` and are managed
through the operators API. The org admin is created **with** its organization;
it is not pre-existing.

### 5.1 Endpoints

Organizations — SUPER_ADMIN only (`auth('manageOrganizations')`,
`src/routes/organizations.route.ts`), except usage which needs `manageScans`:

| Method | Path | Guard | Note |
|---|---|---|---|
| POST | `/api/organizations` | `manageOrganizations` | creates org + first `ORGANIZATION_ADMIN` in one call (`adminEmail`, `adminFirstName`, `adminLastName`, `scanQuotaLimit`, `period`) |
| GET | `/api/organizations` | `manageOrganizations` | list (search, status, paginated) |
| GET | `/api/organizations/:id` | `manageOrganizations` | one |
| PUT | `/api/organizations/:id` | `manageOrganizations` | edit name/email/contact/status/`scanQuota` |
| PATCH | `/api/organizations/:id/update-status` | `manageOrganizations` | activate / deactivate / toggle |
| DELETE | `/api/organizations/:id` | `manageOrganizations` | soft delete → status `2` |
| GET | `/api/organizations/:id/usage` | `manageScans` | org admin (own org) or SUPER_ADMIN; returns `periodCount`, `quotaLimit`, `quotaPeriod` |

Operators — `auth('manageOperators')` everywhere
(`src/routes/operators.route.ts`):

| Method | Path | Note |
|---|---|---|
| GET / POST | `/api/operators` | list (search/status/role, paginated) / create (`ORGANIZATION_ADMIN` or `OPERATOR` only) |
| GET / PUT / DELETE | `/api/operators/:operatorId` | get / update / soft delete |
| PATCH | `/api/operators/:operatorId/role` | role change (org roles only) |
| POST | `/api/operators/:operatorId/update-status` | activate / deactivate / toggle |

Scans — `auth('manageScans')` everywhere (`src/routes/scans.route.ts`):

| Method | Path | Note |
|---|---|---|
| POST | `/api/scans` | record scan → `202` new / `200` duplicate (idempotent on `organizationId + clientScanId`) |
| GET | `/api/scans` | list (filter by `barcode`, `userId`, `organizationId`, paginated) |
| GET | `/api/scans/:scanId` | one |

Webhooks — `auth('manageWebhooks')` everywhere (`src/routes/webhooks.route.ts`):

| Method | Path | Note |
|---|---|---|
| GET | `/api/webhooks/config` | one config for the org (secret never returned) |
| POST | `/api/webhooks/config` | upsert (`endpointUrl`, `secret` write-only, `enabled`, `timeoutMs`, `batchSize`, `retryLimit`) |
| DELETE | `/api/webhooks/config` | delete |
| GET | `/api/webhooks/deliveries` | tracked deliveries (status filter, paginated) |

### 5.2 Org scoping rule (verified)

`src/services/operators.service.ts` → `resolveOrgScope` and
`src/services/scans.service.ts` → `resolveScanOrg`:

- **SUPER_ADMIN**: may pass `organizationId` (body/query) and it is used.
- **Any non-superadmin** (`ORGANIZATION_ADMIN`/`OPERATOR`): the scope is **forced
  to `reqUser.organizationId`**; a client-supplied `organizationId` is ignored.
  If the user has no `organizationId`, the request fails (`400 User is not
  scoped to an organization`).
- Operator updates/detail/deletes re-check the scope on every query
  (`findOne({ _id, organizationId: orgScope })`), so org A can never touch
  org B's operators.

### 5.3 Scan ingestion flow (`POST /api/scans`)

1. Authenticate, resolve org scope, **assert the organization is active**
   (`status === 1`, `src/services/quota.service.ts` `assertOrganizationActive`).
2. Idempotency: find on `{ organizationId, clientScanId }` → if present return
   `200 { scan, created: false }`.
3. Persist the scan (unique index on `organizationId + clientScanId`), with a
   11000-race fallback → on success return `202 { scan, created: true }`.
4. `incrementScanUsage` — atomic Redis `INCR` on key
   `org:{orgId}:scans:monthly:{YYYY-MM}` (`src/services/quota.service.ts`).
5. `createDeliveryAndEnqueue` — create a `webhook_delivery` row (`pending`) and
   enqueue a BullMQ job `{ eventId, scanId, organizationId }`.

The scan API never waits on webhook delivery; the worker is a separate process
(`src/worker.ts`, `npm run dev:worker`).

### 5.4 Quota counter & reconciliation

- Key uses the **current UTC date** window (`periodWindow`, default `'monthly'`
  → `YYYY-MM`). Note: the counter key currently always uses the monthly window
  regardless of `org.scanQuota.period` (see §10).
- `reconcileScanUsage` runs at worker startup and every **30 s**
  (`src/worker.ts:30-31`): for each active org it copies the Redis count into
  `organization.scanUsage { count, lastSyncedAt }`.
- `GET /organizations/:id/usage` returns the live Redis `periodCount` +
  `quotaLimit`/`quotaPeriod` from the org doc.
- **No blocking/enforcement exists yet** — tracking only (see §10).

### 5.5 Webhook delivery (worker)

- Config is per-org; `secret` is stored with `select: false` and is **never**
  present in any API response. The worker re-selects it with
  `.select('+secret')`.
- Each delivery: `eventId` (UUID), `scanId`, `organizationId`, `attempts`,
  last attempts/delivered timestamps, `lastError`, status
  `pending → processing → delivered | failed`.
- POST to `endpointUrl` with `x-scanflow-signature: HMAC-SHA256(secret, payload)`,
  per-request timeout, exponential-backoff retries up to `retryLimit`
  (attempts counter).

---

## 6. Who manages whom

| Account | Can manage | Scoped to | Cannot |
|---|---|---|---|
| `SUPER_ADMIN` | organizations, operators (+ create org admins/operators via `/operators`), scans (record/list), webhook config + deliveries | global (may pass `organizationId`) | — (only not: being assigned via role) |
| `ORGANIZATION_ADMIN` | operators (its "sub-users"), scans (`manageScans`), webhook config + deliveries (`manageWebhooks`), own org usage | own `organizationId` | organizations |

```
SUPER_ADMIN ──> Organization ──> ORGANIZATION_ADMIN ──> OPERATOR
              (SUPER_ADMIN manages all users globally;
               ORGANIZATION_ADMIN manages the OPERATORs of its org;
               OPERATOR = read-only member, scans only)
```

---

## 7. API → role → right quick reference

| API group | Guard (right) | Roles that pass |
|---|---|---|
| `/auth/send-otp`, `/verify-otp`, `/refresh-tokens` | public | anyone |
| `/auth/me` | auth (no right) | any active user |
| `/organizations/*` (CRUD/status) | `manageOrganizations` | SUPER_ADMIN |
| `/organizations/:id/usage` | `manageScans` | SUPER_ADMIN, ORGANIZATION_ADMIN (own org), OPERATOR |
| `/operators/*` (list/create/update/role/status/delete) | `viewOperators` (GET) / `manageOperators` (writes) | SUPER_ADMIN (global), ORGANIZATION_ADMIN (own org) |
| `/scans/*` | `manageScans` | SUPER_ADMIN, ORGANIZATION_ADMIN, OPERATOR |
| `/webhooks/config`, `/webhooks/deliveries` | `manageWebhooks` | SUPER_ADMIN, ORGANIZATION_ADMIN |

> File layout: `/organizations/*` lives in `src/routes/admin/` (+ `controllers/
> admin/`, `services/admin/`, `validations/admin/`); `/operators/*`, `/scans/*`
> and `/webhooks/*` live in `src/routes/user/` (+ the corresponding `*/user/`
> folders). `GET /operators/:id` accepts an optional `?organizationId=` so
> SUPER_ADMIN can scope a single lookup; SUPER_ADMIN write calls pass an
> explicit `organizationId` (required when the caller is not org-scoped).

---

## 8. Panel gating (scanflow_panel)

Route-level (`src/configs/settingsConfig.ts` → `defaultAuth`): any authenticated
user whose `role` is in `['SUPER_ADMIN', 'ORGANIZATION_ADMIN', 'OPERATOR']` may
enter the app; otherwise they are redirected to login.

Nav-level (`src/configs/navigationConfig.ts`, per item `auth` arrays; items are
hidden when `FuseUtils.hasPermission(item.auth, user.role)` is false):

| Nav item | `auth` (`auth: [roles]`) | Visible to |
|---|---|---|
| Dashboard / Settings | `{}` empty | everyone |
| Organizations | `['SUPER_ADMIN']` | SUPER_ADMIN only |
| Operators | `['SUPER_ADMIN', 'ORGANIZATION_ADMIN']` | SUPER_ADMIN, ORGANIZATION_ADMIN |
| Scans | `['SUPER_ADMIN', 'ORGANIZATION_ADMIN', 'OPERATOR']` | SUPER_ADMIN, ORGANIZATION_ADMIN, OPERATOR |
| Webhooks | `['SUPER_ADMIN', 'ORGANIZATION_ADMIN']` | SUPER_ADMIN, ORGANIZATION_ADMIN |

> The Operators module is fully manageable by SUPER_ADMIN and ORGANIZATION_ADMIN
> (create/edit/role/status/delete). SUPER_ADMIN additionally gets an
> organization filter select on the Operators page (global scope); `OPERATOR`
> has no Operators nav item (read-only member, scans only).

Dev notes: panel dev server on `:7052` proxies to the API (`VITE_API_URL`,
default `http://localhost:3000/api`); login uses OTP with a dev bypass
(`BYPASS_EMAIL` / `BYPASS_OTP`).

---

## 9. Legacy → current mapping (cleanup executed)

The `USER_ADMIN` / `USER` / `SUB_USER` tier and the `parent_id` / `is_sub_user`
mechanism were **removed** by the role-cleanup migration. The planned rename
became a real migration:

| Old (legacy) | New (current) | Implemented? |
|---|---|---|
| `SUPER_ADMIN` | `SUPER_ADMIN` | kept |
| `USER_ADMIN` | `ORGANIZATION_ADMIN` | migrated (all legacy `USER_ADMIN` → `ORGANIZATION_ADMIN`) |
| `USER` | `OPERATOR` | migrated (legacy `USER` → `OPERATOR`) |
| `SUB_USER` (via `parent_id` / `is_sub_user`) | removed entirely | deleted (soft-deleted rows purged) |
| `USER` | `OPERATOR` | kept **both** (not renamed) |
| `is_sub_user` / `parent_id` | retired in favor of `organizationId` | kept (not retired) |

So `ORGANIZATION_ADMIN` is conceptually the org-scoped successor of the legacy
`USER_ADMIN`, and `OPERATOR` is the org-scoped successor of the legacy
`USER`/sub-user scanner. Both families now coexist; the org tier is the one
that the scan/quota/webhook product runs on.

---

## 10. Known gaps / sharp edges (honest notes)

1. **`/auth/register` is still public** and permits self-registration as
   `USER_ADMIN`/`USER`; the plan wanted super-admin-only provisioning
   (`POST /api/organizations` + `POST /api/operators`).
2. **Legacy tier can't scan**: `USER_ADMIN` / `USER` / `SUB_USER` have no
   `organizationId` and none of the `manageScans`/`manageOrganizations`/
   `manageOperators`/`manageWebhooks` rights, so they cannot use any scan,
   org, operator or webhook endpoint.
3. **`ensureSuperAdmin.ts` is dead code** — it is not mounted anywhere. The
   real superadmin checks are the `isRequesterAdmin` /
   `isRequesterSuperAdmin` service helpers.
4. **Counter period mismatch**: the Redis quota key is always built with the
   default `'monthly'` window of the current UTC date
   (`incrementScanUsage`/`reconcileScanUsage` don't read
   `org.scanQuota.period`). `scanQuota.period` is stored and returned by the
   usage endpoint, but the counter effectively counts monthly windows.
5. **Quota is tracking-only**: no hard-block / overage gate exists yet
   (explicit deferred decision, plan §10).
6. **`auth()` semantics**: `.every()` means a future multi-right guard would
   require ALL rights; today all guards use a single right.
7. Two identical helper functions exist (`isRequesterAdmin` in
   `admin/users.service.ts`, `isRequesterSuperAdmin` in
   `organizations.service.ts`) — a candidate to unify, not a functional
   difference.
8. `body.isSuperAdmin` is settable via the admin create/update endpoints —
   only reachable by SUPER_ADMIN, so no privilege escalation, but it's the
   mechanism behind the boolean tier.

---

## 11. FAQs (your original questions, answered from code)

**Q: Is `ORGANIZATION_ADMIN` basically the same as our `USER`?**
No — not the role *named* `USER`. In the legacy naming, the user that manages
sub-users wears the role `USER_ADMIN`; the plan renames exactly that role to
`ORGANIZATION_ADMIN`. The role literally named `USER` is an inert account with
no rights.

**Q: Is `OPERATOR` basically the same as our `SUB_USER`?**
Conceptually yes (the person doing the work under an admin), but implemented
as a separate mechanism: sub-users use `parent_id` + `is_sub_user` and cannot
scan (no right, no org); operators carry `organizationId` + role and *can*
record scans via `/api/scans`.

**Q: Why do we need both `USER_ADMIN` and `ORGANIZATION_ADMIN`?**
We don't "need" both long-term — it's the migration being a superset. The plan
intended `USER_ADMIN → ORGANIZATION_ADMIN`. Today `USER_ADMIN` manages the
legacy sub-user tree and `ORGANIZATION_ADMIN` manages the org tier; nothing
was renamed or removed.

**Q: What's the actual difference between User, Organization Admin, Sub-user, and Operator?**
| | User | Organization Admin | Sub-user | Operator |
|---|---|---|---|---|
| `role` | `USER` | `ORGANIZATION_ADMIN` | `USER` (typically) | `OPERATOR` |
| `organizationId` | no | yes | no | yes |
| `is_sub_user` | no | no | yes | no |
| `parent_id` | no | no | yes (parent) | no |
| can manage | — | own org's operators/scans/webhooks | — | — |
| can scan | no | yes | no | yes |

**Q: Who manages whom?**
See §6. Super admin = global. USER_ADMIN = own sub-users. ORGANIZATION_ADMIN =
own org's operators + scans + webhooks. OPERATOR = scans only. USER/SUB_USER =
managed, not managing.

**Q: How do Organizations fit into the architecture?**
Organizations are the multi-tenant boundary for the barcode product: the org
owns the scan quota (pooled limit + period), the scan records, the Redis usage
counter, and the webhook endpoint + deliveries. Super admin provisions orgs
(and their first admin); org admins provision operators; operators scan.
Organizations mostly replace the old parent/sub-user tree as the
authorization boundary.

**Q: How do scans, operators, and webhooks fit into the role structure?**
`manageScans` gates the scan APIs (record/list) and the usage endpoint —
available to SUPER_ADMIN, ORGANIZATION_ADMIN and OPERATOR. `manageOperators`
gates operator CRUD — SUPER_ADMIN and ORGANIZATION_ADMIN (org-scoped).
`manageWebhooks` gates webhook config + deliveries — SUPER_ADMIN and
ORGANIZATION_ADMIN. Operators are the "who", scans are the "what", webhooks
are the "notify", and `organizationId` is the "for which tenant".

---

### 12. See also

- `../../Scanflow_final_architecture_plan.md` — the target architecture the
  org tier was built from (and section 11 "Current implementation state").
- `../../SCANFLOW_API_CURRENT_FLOW.md` — node-level API/data reference; note
  it predates the org superset (its §4.2 still shows the old 3-role map).