# ScanFlow — Role System Cleanup: Final Plan (v2 — verified against live code + dev DB, 2026-09-25)

This is the final, verified plan to remove the legacy account-tree role
system and keep ONLY the organization-based role system. It is v2 of the
cleanup plan: every section below was re-verified against the actual
backend source (`scanFlow_api`), the frontend (`scanflow_panel`), and the
live dev database (`db_scanflow` on localhost:27017) on 2026-09-25.

It merges:

- `Scanflow_final_architecture_plan.md` (target architecture)
- `docs/ROLE_AND_ACCESS_FLOW.md` (verified current-code audit)
- The role-cleanup instructions already written for this task

into one executable checklist, with the specific bugs/dead-code found
during the code audit folded in as required fixes (not optional).

**Non-negotiable requirement for this pass: clean, minimal, production-lean
code.** No dead files, no unused imports, no duplicate helper functions, no
"just in case" compatibility aliases, no leftover legacy fields. If
something isn't used by the final 3-role architecture, it gets deleted, not
commented out or hidden behind a flag.

**Doc-only note:** this file is the synchronized plan. Code changes
happen only after the plan owner confirms execution.

---

## 0. Why this cleanup is needed (context, not instructions)

The backend currently has **two parallel role trees** doing the same job:

| Tier | Root | Middle (= "client") | Leaf (= "employee") |
|---|---|---|---|
| Legacy (remove) | `SUPER_ADMIN` | `USER_ADMIN` | `USER` / `SUB_USER` (`is_sub_user`, `parent_id`) |
| Final (keep) | `SUPER_ADMIN` | `ORGANIZATION_ADMIN` | `OPERATOR` |

`USER_ADMIN` and `ORGANIZATION_ADMIN` are the same role conceptually — the
migration was supposed to *rename* one into the other. `USER`/`SUB_USER` and
`OPERATOR` are likewise the same role conceptually. The rename never
happened; the new roles were added **on top of** the old ones as a
superset, so both systems are live in the code today. This plan finishes
the rename by deleting the old side entirely.

Verified v1 fixes folded in: the migrate-time DB snapshot was stale (§6 was
rewritten from the real 28-user / 5-org snapshot), several deletion targets
were missing (the whole `/auth/register` chain, `is_sub_user`/`parent_id`
initializers in surviving creators, the `user.model.ts` default role), the
§1.1 super-admin read-only route table was not reachable (single-GET
`/operators/:operatorId` 400s today), the org-scope resolver unification is
subtler than v1 described, the stack line wrongly said "Fastify-native"
(wrong — it is Express), and the panel scope was underspecified (authRoles,
signup flow, Dashboard, OperatorsView read-only UI, `@auth/user`).

---

## 1. Final role architecture (target — no ambiguity)

```
SUPER_ADMIN
    |
    +---- Organization  (tenant boundary, NOT a role)
              |
              +---- ORGANIZATION_ADMIN   (the client — manages their own org)
                        |
                        +---- OPERATOR    (the employee — performs scans)
                        +---- OPERATOR
                        +---- OPERATOR
```

Only these 3 roles exist anywhere in the system after this pass.

Define them **once** — the single source of truth stays in
`src/config/roles.ts`:

```ts
export const allRoles = {
  SUPER_ADMIN: ['manageOrganizations', 'viewOperators', 'manageScans', 'manageWebhooks'],
  ORGANIZATION_ADMIN: ['viewOperators', 'manageOperators', 'manageScans', 'manageWebhooks'],
  OPERATOR: ['manageScans'],
};

export const roles = Object.keys(allRoles); // ['SUPER_ADMIN', 'ORGANIZATION_ADMIN', 'OPERATOR']
```

- `roles` derives from `Object.keys(allRoles)`, so the user-model enum
  collapses automatically once the legacy keys are removed.
- Import `allRoles`/`roles` everywhere — backend model, validations, auth,
  frontend types. Do not redefine the role list independently anywhere.
- `ASSIGNABLE_ROLES` (legacy) is deleted. `SUPER_ADMIN_ROLE` and
  `ORGANIZATION_ASSIGNABLE_ROLES` are kept (still referenced —
  `OORGANIZATION_ASSIGNABLE_ROLES` in `operators.service.ts` /
  `operators.validations.ts`; `SUPER_ADMIN_ROLE` in `organizations.service.ts`).

### 1.1 Level-by-level management scope (each level manages only the one directly below it)

This is a strict rule, not a suggestion: **each level manages only the
level directly below it. A level may never write to something two levels
down — at most it can read it.**

| Level | Manages (full CRUD) | Can only read (GET) | Cannot touch at all |
|---|---|---|---|
| `SUPER_ADMIN` | Organizations + their `ORGANIZATION_ADMIN` | Operators (any org) | — |
| `ORGANIZATION_ADMIN` | Operators (own org only) | — | Organizations, other orgs' anything |
| `OPERATOR` | own scans (via `manageScans`) | — | Organizations, Operators |

Concretely for Operators: `SUPER_ADMIN` is two levels above `OPERATOR`
(`SUPER_ADMIN → Organization / ORGANIZATION_ADMIN → OPERATOR`), so
`SUPER_ADMIN` gets **read-only** access to operators — it can list/view
them for oversight, but cannot create, update, change role/status, or
delete one directly. Only `ORGANIZATION_ADMIN` (the level immediately
above `OPERATOR`) has write access. This is why the rights map above
splits the old single `manageOperators` right into two:

- `viewOperators` — read-only (`GET` routes). Given to **both**
  `SUPER_ADMIN` and `ORGANIZATION_ADMIN`.
- `manageOperators` — write (`POST`/`PUT`/`PATCH`/`DELETE` routes). Given
  **only** to `ORGANIZATION_ADMIN`.

Verified route guard mapping for `src/routes/operators.route.ts`:

| Method | Path | Guard | Who passes |
|---|---|---|---|
| GET | `/api/operators` | `viewOperators` | `SUPER_ADMIN` (any org, via query `?organizationId=`), `ORGANIZATION_ADMIN` (own org only) |
| GET | `/api/operators/:operatorId` | `viewOperators` | same as above — **requires plumbing** (see Fix 1 below) |
| POST | `/api/operators` | `manageOperators` | `ORGANIZATION_ADMIN` only |
| PUT | `/api/operators/:operatorId` | `manageOperators` | `ORGANIZATION_ADMIN` only |
| PATCH | `/api/operators/:operatorId/role` | `manageOperators` | `ORGANIZATION_ADMIN` only |
| POST | `/api/operators/:operatorId/update-status` | `manageOperators` | `ORGANIZATION_ADMIN` only |
| DELETE | `/api/operators/:operatorId` | `manageOperators` | `ORGANIZATION_ADMIN` only |

Two fixes are required to make this table actually reachable (both found
in the audit):

- **Fix 1 — single-GET is unreachable for `SUPER_ADMIN` today.**
  `getOperatorById(operatorId, reqUser, orgOverride)` already accepts an
  override, but the controller calls it with `undefined`
  (`src/controllers/operators.controller.ts` → `operatorService.getOperatorById(
  operatorIdParam(req), req.user)`), and `resolveOrgScope` throws
  `400 'organizationId is required'` for a super-admin with no
  `bodyOrgId`. So `SUPER_ADMIN GET /api/operators/:operatorId` currently
  **always 400s**. Fix: add an optional `organizationId` to the
  `getOperator` query validation, have the controller
  `pick(req.query, ['organizationId'])` and pass it through. The list
  route already picks `organizationId` correctly.
- **Fix 2 — org-scope guard split.** All seven routes currently use
  `auth('manageOperators')`. Switch the two GETs to
  `auth('viewOperators')`. No OR-logic is introduced — each route only
  ever needs exactly one right.

Organization Admin's own-org scoping is unaffected — `manageOperators`
and `viewOperators` are both still forced to `reqUser.organizationId` for
`ORGANIZATION_ADMIN` callers; only `SUPER_ADMIN` may pass an explicit
`organizationId` to *view* (never to *write*) another org's operators.

Note: `SUPER_ADMIN` keeps **full** manage rights on Organizations (and
their first `ORGANIZATION_ADMIN`) — that is the level directly below it,
so full CRUD there is correct and unchanged. This read-only restriction
applies specifically to Operators, which sit two levels down. Scans and
webhook config are unchanged (`SUPER_ADMIN` keeps
`manageScans`/`manageWebhooks`), as agreed.

---

## 2. What gets deleted (verified against current code — be specific, not vague)

### 2.1 Backend fields / concepts
- `USER_ADMIN`, `USER`, `SUB_USER` as role values
- `is_sub_user`
- `parent_id`
- `ASSIGNABLE_ROLES` constant (legacy assignable-role list)
- The `manageUsers`, `manageSubUsers` rights
- `user.model.ts` schema default `role: 'USER'` → must become `'OPERATOR'`
  (the `'USER'` default becomes invalid once the enum collapses).

### 2.2 Backend files (routes / controllers / services / validations)
- `src/routes/admin/users.route.ts`
- `src/routes/user/sub-users.route.ts`
- `src/controllers/admin/users.controller.ts`
- `src/controllers/user/sub-users.controller.ts`
- `src/services/admin/users.service.ts` — the whole CRUD is superseded by
  `organizations.service.ts` / `operators.service.ts`; its `isRequesterAdmin`
  helper is folded into the shared guard (§3)
- `src/services/user/sub-users.service.ts` (including `resolveParentScope`)
- `src/validations/admin/users.validations.ts`
- `src/validations/user/sub-users.validations.ts`
- `src/middlewares/ensureSuperAdmin.ts` — **confirmed dead code, not
  imported anywhere.** Delete outright, don't migrate its logic anywhere.

### 2.3 The `/auth/register` chain (MISSED in v1 — required so the file
deletions above don't break the build)
`src/services/auth.service.ts` imports `createUser` from the deleted
`admin/users.service.ts` (it is the only production consumer). Removing the
service therefore requires removing everything tied to registration:

- `registerUser` in `src/services/auth.service.ts:166-176` and its
  `import { createUser } from './admin/users.service.js'` (line 13)
- `register` in `src/controllers/auth.controller.ts:6`
- `register` block in `src/validations/auth.validation.ts:5`
- the `/register` route block in `src/routes/auth.route.ts`

`PUBLIC_PATHS = ['/auth', '/health']` stays as-is (login routes are
unaffected).

### 2.4 `is_sub_user` / `parent_id` initializers in surviving creators
(MISSED in v1 — the fields `$unset` by the migration are still sent by two
non-deleted services)
- `src/services/operators.service.ts:82-83` (`is_sub_user: false, parent_id: null`)
- `src/services/organizations.service.ts:56-57` (same)

Both must be removed as part of the field removal.

### 2.5 Auth middleware self-read bypass
The `GET /users/:userId` self-read bypass in `src/middlewares/auth.ts:31`
is tied to a route that is being removed — delete that branch, don't leave
orphaned logic referencing a dead route.

### 2.6 Backend endpoints (remove entirely, not just unmount)
All verified present via `src/routes/index.ts` (`/users` subUsers mount and
`/users` admin mount):

```
POST   /api/auth/register
GET    /api/users
GET    /api/users/get-all/user
POST   /api/users/create-user
GET    /api/users/:userId
PUT    /api/users/admin-update/:userId
PATCH  /api/users/:userId/role
POST   /api/users/:userId/update-status
DELETE /api/users/:userId
POST   /api/users/create-sub-user
GET    /api/users/get-all-sub-users
GET    /api/users/sub-user/:subUserId
PUT    /api/users/update-sub-user/:subUserId
PATCH  /api/users/sub-user-role/:subUserId
POST   /api/users/sub-user-status/:subUserId
DELETE /api/users/sub-user/:subUserId
```

---

## 3. Duplicate code to unify (found in audit, not yet fixed)

- `isRequesterAdmin()` (`src/services/admin/users.service.ts:21`) and
  `isRequesterSuperAdmin()` (`src/services/organizations.service.ts:17`)
  are **identical logic** (`isSuperAdmin === true || role === 'SUPER_ADMIN'`)
  duplicated in two files. The second one is already imported by
  `operators.service.ts`, `scans.service.ts`, and
  `organizations.service.ts` itself. Keep exactly one: a new shared
  `src/middlewares/guards/isSuperAdmin.ts` re-exporting the org-side helper;
  update all call sites. `isRequesterAdmin` vanishes with
  `admin/users.service.ts`.
- Centralize the org-scope resolution into **one** shared helper used by
  both operators and scans. Today `resolveOrgScope`
  (`operators.service.ts`) and `resolveScanOrg` (`scans.service.ts`) are
  two near-identical but **behaviourally different** implementations of
  the same rule:
  - `resolveOrgScope` (operators): super-admin MUST supply an org id, else
    throws `400 organizationId is required`; non-super-admin must have
    `reqUser.organizationId`, else throws `400 User is not scoped...`.
  - `resolveScanOrg` (scans): super-admin with an org id uses it, otherwise
    falls through to `reqUser.organizationId`; only throws when the caller
    has no org id at all.

  Unify as `resolveOrganizationScope(reqUser, explicitOrgId?, opts)` in the
  shared guards file with explicit semantics:
  - required mode (operator writes): super-admin must supply `explicitOrgId`
    (400 otherwise); otherwise use `reqUser.organizationId` (400 if absent).
  - optional mode (operator/scans lists): super-admin without
    `explicitOrgId` resolves to `null`/skip the org filter (whole-system
    read); otherwise as required mode.
  Both services call the shared helper; no behaviour outside the cleanup
  (scan idempotency, dedup, webhook enqueue) changes.

---

## 4. Bug fix required while touching this code (found in audit)

**Quota counter period mismatch:** `incrementScanUsage`,
`reconcileScanUsage`, and `getPeriodScanCount` (`src/services/quota.service.ts`)
always build the Redis key with a hardcoded `'monthly'` window
(`org:{orgId}:scans:monthly:{YYYY-MM}`) because `redisScanKey` defaults the
period to `'monthly'`, regardless of what `org.scanQuota.period` actually
stores. The usage endpoint returns the stored `quotaPeriod`, but the counter
doesn't honor it. Exact change set:

1. `assertOrganizationActive` (quota.service.ts:75) currently returns
   `void` — make it **return the org document** instead.
2. `incrementScanUsage(organizationId)` → accept a `period` argument;
   `createScan` (`scans.service.ts`) passes
   `org.scanQuota?.period ?? 'monthly'` from the doc it just fetched via
   `assertOrganizationActive`.
3. `reconcileScanUsage` — build each org's key from that org's
   `scanQuota?.period ?? 'monthly'` (worker.ts keeps calling it unchanged).
4. `getPeriodScanCount(organizationId)` → accept `period`;
   `getOrganizationUsage` (`organizations.service.ts`) passes
   `org.scanQuota?.period ?? 'monthly'`.
5. `redisScanKey` already supports the period in both the key and the
   window (`periodWindow`) — daily → `YYYY-MM-DD`, monthly → `YYYY-MM`.

Quota **enforcement** (block/overage) stays deferred as already decided —
this fix is only about the counter being accurate for whatever period is
configured, tracking-only. Existing `:monthly:` Redis keys remain valid.

---

## 5. Organization provisioning (confirmed decision, already implemented — verify it stays)

`POST /api/organizations` already creates an Organization + its first
`ORGANIZATION_ADMIN` in one call — keep this behavior exactly as-is, just
remove `/api/auth/register` as its public sibling so there's only one way
to create org-scoped accounts.

---

## 6. Database migration (run BEFORE removing fields; dry-run first)

### 6.1 Real dev-DB snapshot (verified 2026-09-25, `db_scanflow`)

**28 users** total, **5 organizations**.

Active org-tier (12 — untouched, all `status: 1`, all have
`organizationId`):
- 5 × `ORGANIZATION_ADMIN` (orgadmin…@scanflow.com / a…@x.com)
- 7 × `OPERATOR` (operator…@scanflow.com / x…@x.com / o…@x.com)

Global: `dev@scanflow.com` → `SUPER_ADMIN`, `status: 1`, no
`organizationId` (stays global).

Inactive legacy (2 — `status: 0`, no `organizationId`, no sub-user
relationship):

| email | current role | current status |
|---|---|---|
| vivek.ctasis.llp@gmail.com | `USER_ADMIN` | 0 |
| logtest1790063568@scanflow.com | `USER` | 0 |

Soft-deleted legacy (14 — `status: 2`): `USER_ADMIN`/`USER` accounts,
including 9 with `is_sub_user: true` and a `parent_id` (acctadmin, subone,
selfscope, devsub, plain, reguser, paneltest-parent/sub, smoke-a/b,
rm-user/admin/sub, rm-reg). All no `organizationId`.

**No `parent_id` index exists** on the user schema (verified) — the
"drop unused indexes" step in v1 is a no-op.

### 6.2 Migration steps (report first, act second)

1. **Report:** print pre-change counts of role / `is_sub_user` /
   `parent_id` (and per-role breakdown) before touching anything.
2. `dev@scanflow.com` stays `SUPER_ADMIN` and global. The 12 active
   org-tier users and 5 orgs are untouched.
3. **Delete** the 14 `status: 2` (soft-deleted) legacy rows outright.
   Confirmed intent: remove them — no legacy accounts remain needed.
4. Create one controlled **"Default Organization"** for dev/test purposes
   (status 1). Assign both inactive legacy accounts to it and **reactivate
   (`status: 1`)**, documented explicitly in the migration output as a
   test-account reconciliation:
   - `vivek.ctasis.llp@gmail.com` → `ORGANIZATION_ADMIN`
     (type-consistent: was a `USER_ADMIN`, account-level admin)
   - `logtest1790063568@scanflow.com` → `OPERATOR`
5. Only after confirming the dry-run output above: `$unset`
   `is_sub_user` + `parent_id` on all remaining docs, confirm every role
   value is now one of the 3 final roles, and record that no `parent_id`
   index needed dropping.

Do not run steps 3–5 destructively without a dry-run pass first.

---

## 7. Implementation checklist (in order)

1. Rewrite `src/config/roles.ts` to the 3-role §1 map (including the
   `viewOperators`/`manageOperators` split), delete `ASSIGNABLE_ROLES`;
   change the `user.model.ts` role default to `'OPERATOR'`.
2. Add shared `src/middlewares/guards/isSuperAdmin.ts` +
   `resolveOrganizationScope` (§3); refactor organizations / operators /
   scans services and operators controller to use them, including the
   `GET /operators/:operatorId?organizationId=` fix and the
   `viewOperators` guard split (§1.1 Fix 1/2).
3. Write + dry-run the migration script (§6.2); confirm the printed report
   before executing.
4. Delete the legacy backend files/endpoints (§2.2, §2.6), the
   `/auth/register` chain (§2.3), the surviving creators' `is_sub_user` /
   `parent_id` initializers (§2.4), and the `/users/:userId` self-read
   bypass (§2.5).
5. Fix the quota counter period bug (§4).
6. Repository-wide backend grep → **zero hits** for: `USER_ADMIN`,
   `SUB_USER`, `is_sub_user`, `parent_id`, `ASSIGNABLE_ROLES`,
   `manageUsers`, `manageSubUsers`, `ensureSuperAdmin`,
   `create-sub-user`, `get-all-sub-users`, `sub-user`. Also clean up
   now-dead imports/constants/types left by the deletions.
7. Update `scanflow_panel` per §8.
8. Build + typecheck backend (`tsc`, `eslint`, `npm run build`) and
   frontend (`tsc --noEmit`, `eslint`, `npm run build`); run existing
   tests.
9. New/updated tests: cross-org isolation (org A cannot touch org B's
   operators/scans/webhooks/usage), role-permission matrix for all 3 roles,
   the 3 legacy roles are rejected everywhere if still referenced
   anywhere; explicitly **`SUPER_ADMIN` gets `200` on both operator GETs
   but `403` on every operator write route** (create/update/role/status/
   delete).
10. Confirm end-to-end: OTP/JWT auth still works, scan ingestion still
    returns `202`/`200` correctly, Redis quota counter increments with the
    corrected period key, BullMQ webhook worker still delivers and retries.

---

## 8. Frontend (`scanflow_panel`) — full synchronised scope

Verified legacy references today:

- **Delete `src/app/(control-panel)/apps/users/`** (whole module —
  `route.tsx`, `UsersView.tsx`, `SubUsersView.tsx`, `useUsers.ts`,
  `usersApiService.ts`, `UserCell.tsx`, `userDisplay.tsx` legacy exports).
  Grep for imports of these files first; delete only after confirming no
  other feature imports them.
- **Delete the signup flow** (backend `/auth/register` is going away):
  `src/app/(public)/(auth)/route.tsx` Register child, `Register.tsx`,
  the `register` call in `src/@auth/api.ts:41`, `registerUrl` in
  `src/configs/env.ts`, and `AuthLayout.tsx` `isSignup` handling.
- **`src/@auth/authRoles.ts`**: drop `USER_ADMIN`/`USER` from all arrays;
  **rename `userAdmin` → `organizationAdmin: ['SUPER_ADMIN',
  'ORGANIZATION_ADMIN']`** (decision confirmed); `staff`/`user` loose the
  legacy roles and `user` gains `'OPERATOR'`.
- **`src/@auth/user/index.ts`**: remove `is_sub_user`/`parent_id` from the
  user interface. **`src/@auth/user/models/UserModel.ts`**: remove the
  `is_sub_user`/`parent_id` defaults.
- **`src/configs/settingsConfig.ts:52`**: `defaultAuth` →
  `['SUPER_ADMIN', 'ORGANIZATION_ADMIN', 'OPERATOR']`.
- **`src/configs/navigationConfig.ts:19`**: remove the `users` nav entry
  (its sub-items / any `sub-user` entries).
- **`src/app/(control-panel)/dashboards/analytics/Dashboard.tsx:385`**:
  the `user.role === 'USER_ADMIN'` branch → map to the 3 final roles.
- **`src/app/(control-panel)/apps/operators/components/views/OperatorsView.tsx`**:
  remove `USER_ADMIN: 'primary'` from `ROLE_COLORS` (line 60); **make the
  view read-only for `SUPER_ADMIN`** — hide "New Operator", edit, role,
  status, and delete actions for super-admin (backend now rejects those),
  and add an organization selector for super-admin listing.
- Final frontend grep for the deleted endpoint paths (`/users`,
  `users/create-user`, `sub-user`, `/auth/register`) and legacy role
  strings → zero hits.

---

## 9. What does NOT change

- Response envelope (`{status, message, data}` success / `{code, message}`
  error).
- OTP + JWT auth mechanism itself (send-otp, verify-otp, refresh-tokens,
  logout, me) — only who can call `register`-equivalent actions changes.
- The **Express-based** architecture (Express + Mongoose + Redis/BullMQ +
  Pino — not Fastify), MongoDB/Mongoose models, Redis/BullMQ queues, Pino
  logging — no rework needed here. *(v2 correction: the stack line
  previously said "Fastify-native"; the implemented backend is the Express
  superset.)*
- Scan model, webhook model, webhook worker isolation, timeout/retry
  behavior — unaffected by this role cleanup.
- Quota is still tracking-only; no enforcement logic is added in this pass
  (deferred decision stands).

---

## 10. Do not overengineer (unchanged from original instructions)

No Kafka, no RabbitMQ, no Kubernetes, no separate microservice for roles,
no billing/payment service. This is a role-model cleanup + dead-code
removal pass on the existing Express + MongoDB + Redis + BullMQ stack —
nothing architecturally new is being introduced.

---

## 11. Superseded decisions (post-execution amendments)

Amendment recorded 2026-09-25 after plan publication — these overrule the
earlier text:

- **`SUPER_ADMIN` is NOT read-only on operators anymore.** The earlier
  "*make the view read-only for `SUPER_ADMIN`*" instruction (§8, OperatorsView
  item) was superseded by the plan owner's later decision: SUPER_ADMIN manages
  everything user-wise. `manageOperators` was re-added to `SUPER_ADMIN` in
  `src/config/roles.ts`, and the panel gating was reverted accordingly
  (Org-layout separation pass). Operator read-only now applies to **OPERATOR**
  only.
- **Server-side file separation**: routes/controllers/services/validations are
  now split into `admin/` (superadmin domain: `organizations`) and `user/`
  (org-tier domain: `operators`, `scans`, `webhooks`), mounted from
  `src/routes/index.ts`. Public API paths are unchanged.
- **No new superadmin-creation API** (kept out of `ORGANIZATION_ASSIGNABLE_ROLES`);
  SUPER_ADMIN creates all user accounts (ORGANIZATION_ADMIN / OPERATOR) via the
  `/operators` CRUD.
- **Legacy DB fields fully purged**: the migration's `$unset` via Mongoose was
  silently stripped for non-schema paths; the raw-driver final pass removed the
  remaining `is_sub_user` / `parent_id` on all 14 user docs (verified in the
  cleanup run after this plan's migration step).