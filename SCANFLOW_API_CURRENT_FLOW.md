# ScanFlow API — Current Flow Reference

> Single source of truth for the **current** implementation of `scanflow_api`.
> Use it as the baseline for the next implementation phase. If something here
> disagrees with the code, the code wins — update this file.

- **Base path**: `/api` (no `/v1`)
- **Runtime**: Node.js >= 20, TypeScript, Express 5, Mongoose 9
- **DB**: MongoDB (db name `scanflow`; `-test` suffix appended in `test` env)
- **Auth**: OTP (email/console/dev-bypass) → JWT access + refresh tokens  
- **Health**: `GET /api/health` and `/health`

---

## 1. Project Structure

```
scanFlow_api/
├── .env                        # local env (loaded from path of config.ts)
├── .env.example                # documented env template
├── docker-compose.yml          # api + api-replica (external network scanflow-shared-network)
├── Dockerfile                  # multi-stage build; runs dist/index.js as non-root
├── scripts/
│   ├── fix-account-type.js     # one-time migration: corrected is_sub_user/parent orphan rows
│   └── rebrand-users.js        # earlier rebrand (seller -> user) migration
├── deploy/
│   ├── README.md
│   └── apache/scanflow-api.conf
└── src/
    ├── index.ts                # bootstrap: mongo connect, listen, graceful shutdown
    ├── app.ts                  # express app, middleware chain, auth gate
    ├── config/
    │   ├── config.ts           # env validation (Joi) + typed config export
    │   ├── logger.ts           # winston console logger
    │   ├── morgan.ts           # request logging (success/error)
    │   ├── passport.ts         # JWT Bearer strategy (access tokens only)
    │   ├── roles.ts            # role -> rights map, ASSIGNABLE_ROLES
    │   └── tokens.ts           # token type constants
    ├── routes/
    │   ├── index.ts            # PUBLIC_PATHS + mounts auth, sub-users, users routers
    │   ├── auth.route.ts
    │   ├── admin/users.route.ts
    │   └── user/sub-users.route.ts
    ├── controllers/
    │   ├── auth.controller.ts
    │   ├── admin/users.controller.ts
    │   └── user/sub-users.controller.ts
    ├── services/
    │   ├── auth.service.ts         # OTP, login, refresh, logout, register
    │   ├── email.service.ts        # nodemailer; console fallback in dev
    │   ├── token.service.ts        # JWT sign/verify + Token persistence
    │   ├── common.service.ts       # createResponse wrapper
    │   ├── admin/users.service.ts  # admin user CRUD (incl. listUsers)
    │   └── user/sub-users.service.ts
    ├── models/
    │   ├── index.ts
    │   ├── user.model.ts
    │   ├── user-session.model.ts
    │   ├── token.model.ts
    │   ├── system-error.model.ts
    │   └── plugins/{toJSON,paginate}.plugin.ts
    ├── middlewares/
    │   ├── auth.ts             # passport auth + role-right checks
    │   ├── validate.ts         # Joi validation
    │   ├── error.ts            # errorConverter + errorHandler
    │   ├── ensureSuperAdmin.ts # ❗ DEAD CODE — defined, never imported
    │   ├── mongoSanitize.ts
    │   └── rateLimiter.ts      # authLimiter (prod only)
    ├── utils/
    │   ├── ApiError.ts
    │   ├── catchAsync.ts
    │   ├── pick.ts
    │   └── system-error.handler.ts
    └── validations/
        ├── auth.validation.ts
        ├── custom.validation.ts  # objectId, password rules
        ├── admin/users.validations.ts
        └── user/sub-users.validations.ts
```

---

## 2. Environment Variables (`config.ts`)

Loaded from `.env` at `src/config/config.ts` path, validated with Joi (throws on error).

| Variable | Type / Default | Notes |
|---|---|---|
| `NODE_ENV` | `production`\|`development`\|`test` (required) | |
| `PORT` | number, default `3000` | |
| `MONGODB_URL` | string (required) | `-test` appended when `NODE_ENV=test` |
| `JWT_SECRET` | string (required) | |
| `JWT_ACCESS_EXPIRATION_MINUTES` | number, default `30` | |
| `JWT_REFRESH_EXPIRATION_DAYS` | number, default `30` | |
| `JWT_RESET_PASSWORD_EXPIRATION_MINUTES` | number, default `10` | not used yet |
| `JWT_VERIFY_EMAIL_EXPIRATION_MINUTES` | number, default `10` | not used yet |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` | optional | empty → OTP printed to console |
| `EMAIL_FROM` | optional | |
| `CLIENT_URL` | optional | frontend origin (future use) |
| `BEHIND_REVERSE_PROXY` | boolean, default `false` | sets `app.set('trust proxy', 1)` |
| `BYPASS_EMAIL` | optional | dev-only: email that skips real OTP delivery |
| `BYPASS_OTP` | optional | dev-only: fixed OTP accepted at login |

> **Bypass rule**: only active when `NODE_ENV != production`.
> - `sendOtp`: if `normalizedEmail == BYPASS_EMAIL` → reply success **without** storing an OTP.
> - `verifyOtp`: if `otp == BYPASS_OTP` AND (`BYPASS_EMAIL` empty OR email matches) → skip session check.

---

## 3. Request Lifecycle (middleware chain in `app.ts`)

```
request
  → morgan (successHandler/errorHandler)      [skipped in test]
  → helmet
  → express.json (10mb) / urlencoded
  → mongoSanitize (strips $ keys from body/query)
  → compression
  → cors (+ manual Access-Control-* headers, OPTIONS 200)
  → passport 'jwt' strategy registration
  → rate limit: /api/auth only, production only  (authLimiter)
  → AUTH GATE:
        app.use('/api', ...)
        path starts with PUBLIC_PATHS ['/auth', '/health'] → next()
        else auth() middleware (JWT + role rights)
  → routers (auth, sub-users, users)
  → 404 handler (ApiError NOT_FOUND)
  → errorConverter → errorHandler
```

**Auth gate details** (`app.ts:63-71`): every `/api/*` request except `/auth` and `/health` is authenticated by default. Each route may add stricter rights via `auth('right')`.

**JWT strategy** (`config/passport.ts`):
- Extracts Bearer token, secret from `JWT_SECRET`, `ignoreExpiration: false`.
- Verifies `payload.type === 'access'`, loads the **full user document** from DB by `payload.sub`.
- No user → `false` (→ 401). User found → strategy returns the full doc.

---

## 4. Auth & RBAC

### 4.1 Tokens

**JWT payload** (`token.service.ts`): `{ sub: userId, iat, exp, type }`.

| Type | Storage | Expiry |
|---|---|---|
| `access` | client-side only (never stored in DB) | `JWT_ACCESS_EXPIRATION_MINUTES` |
| `refresh` | stored in `tbl_token` (type `refresh`) + returned | `JWT_REFRESH_EXPIRATION_DAYS` |
| `resetPassword`, `verifyEmail` | token types defined; **not implemented** | — |

`Token.verifyToken(token, type)` checks JWT signature **and** a non-blacklisted `tbl_token` row for that user+type.

### 4.2 Role → Rights map (`config/roles.ts`)

| Role | Rights |
|---|---|
| `SUPER_ADMIN` | `manageUsers`, `manageSubUsers` |
| `USER_ADMIN` | `manageSubUsers` |
| `USER` | *(none)* |

- `ASSIGNABLE_ROLES = ['USER_ADMIN', 'USER']` — what admins may assign. **`SUPER_ADMIN` is never assignable via role** (boolean tier only).
- `auth(...requiredRights)` in `middlewares/auth.ts`:
  - rights from `roleRights.get(user.role) || []`
  - fails → `403 Forbidden`, **except** `GET` on `/:userId` where `userId == logged-in user id` (self read).
- **Admin identity isn't only the role**: helper `isRequesterAdmin(reqUser)` in `admin/users.service.ts` → `isSuperAdmin === true || role === 'SUPER_ADMIN'`.

> `ensureSuperAdmin.ts` is **dead code** (not imported anywhere). It checks only
> `user.isSuperAdmin`. Decision: keep+align with `isRequesterAdmin`, or delete.

### 4.3 Auth flow

1. **Register** → `POST /api/auth/register` (public): creates user via `createUser` (default role `USER`, `is_sub_user: false`) then issues tokens immediately.
2. **Send OTP** → `POST /api/auth/send-otp` (public):
   - user must exist (`status != 2`), must be active (`status != 0`).
   - bypass email → success without email.
   - else generates 6-digit OTP, bcrypt-hashed into `tbl_userSession`
     (delete prior sessions for that email), `expired_at = now + 5 min`, email sent.
3. **Verify OTP & login** → `POST /api/auth/verify-otp` (public):
   - bypass OTP path OR check `tbl_userSession` (latest): exists → not expired → `isOtpMatch`.
   - sessions deleted after use.
   - user re-checked; returns `{ tokens, user }`.
4. **Refresh** → `POST /api/auth/refresh-tokens` (public):
   - verify refresh token (JWT + DB row), user active, **delete the consumed row**,
     issue a fresh pair.
5. **Logout** → `POST /api/auth/logout` (auth): deletes the refresh token row.
6. **Me** → `GET /api/auth/me` (auth): returns `{ user: req.user }` (full user doc).

### 4.4 Email (`email.service.ts`)

- No SMTP configured → OTP logged to console (`[EMAIL-CONSOLE] ...`).
- SMTP send failure in dev → console fallback; in production → `delivered: 'failed'` → 500.

---

## 5. Data Models (Mongoose Schemas)

All models use `toJSON` plugin (see 5.5) and `timestamps: true`.

### 5.1 `tbl_user` (`models/user.model.ts`) — collection `users`

| Field | Type | Constraints / Default | Notes |
|---|---|---|---|
| `first_name` | String | required, trim | |
| `last_name` | String | required, trim | |
| `email` | String | required, unique, lowercase, `validator.isEmail` | |
| `contact_no` | String | trim, optional | |
| `business_address` | String | trim, optional | |
| `password` | String | `select:false`, private; min 8, ≥1 letter AND ≥1 number | bcrypt hash (10? no — salt factor 8) on save/findOneAndUpdate |
| `role` | String | `enum [SUPER_ADMIN, USER_ADMIN, USER]`, default `USER` | |
| `isSuperAdmin` | Boolean | default `false` | admin-tier flag (not derivable via role) |
| `is_sub_user` | Boolean | default `false` | account-type flag |
| `parent_id` | ObjectId → `User` | default `null` | set for sub-users |
| `isEmailVerified` | Boolean | default `false` | |
| `status` | Number | default `1` | `0`=inactive, `1`=active, `2`=deleted (soft) |
| `created_by` | ObjectId | default `null` | actor who created the user |
| `modified_by` | ObjectId | default `null` | last actor who modified |

- Statics: `isEmailTaken(email, excludeUserId?)`.
- Methods: `isPasswordMatch(password)`.
- `pre('save')` and `pre('findOneAndUpdate')` hash `password` (bcrypt 8).
- Plugins: toJSON, paginate.
- **Naming note**: model named `'tbl_user'` (singular); collection defaults to `users`.

### 5.2 `tbl_userSession` (`models/user-session.model.ts`) — collection `usersessions`

| Field | Type | Notes |
|---|---|---|
| `email` | String | required, lowercase, indexed |
| `hash_otp` | String | required (bcrypt) |
| `expired_at` | Date | required; TTL index `expireAfterSeconds: 0` (auto-delete) |

- Method `isOtpMatch(otp)` (bcrypt compare).
- One session row per OTP request (previous rows deleted for that email on new request).

### 5.3 `tbl_token` (`models/token.model.ts`) — collection `tokens`

| Field | Type | Notes |
|---|---|---|
| `token` | String | required, indexed |
| `user` | ObjectId → `User` | required |
| `type` | String | enum `refresh`, `resetPassword`, `verifyEmail` |
| `expires` | Date | required |
| `blacklisted` | Boolean | default `false` |

- Compound index `{ token: 1, type: 1 }`.
- Refresh tokens are **single-use**: row deleted on refresh/logout.

### 5.4 `tbl_systemError` (`models/system-error.model.ts`) — collection `systemerrors`

| Field | Type |
|---|---|
| `action_type` | String (trim) |
| `error_data` | String (serialized JSON) |

- Written by `errorHandler.errorM(...)` on every handled error (`global-error-handler`),
  and anywhere else callers choose. Registered at bootstrap via `setSystemErrorModel`.

### 5.5 Plugins

- **toJSON** — strips `private` paths (e.g. `password`), converts `_id → id` (string),
  deletes `_id` and `__v`.
- **paginate** — defaults `page=1`, `limit=10`; `sortBy: 'field:asc|desc'` comma-separated
  (default `createdAt`); optional `populate`. Returns
  `{ results, page, limit, totalPages, totalResults }`.

---

## 6. API Reference

### 6.0 Envelope / conventions

**Success** (all endpoints):
```json
{ "status": 200, "message": "...", "data": { ... } }
```
- `data` omitted when absent.
- Lists: `data.results` (paginated), plus `data.page/limit/totalPages/totalResults`.
- Single entity: `data.user` (or `data.user` for sub-user endpoints too).

**Error**:
```json
{ "code": 400, "message": "...", "stack": "..." }   // stack only in development
```
- `400 BadRequest` — validation or business rule.
- `401 Unauthorized` — missing/invalid token, expired access token.
- `403 Forbidden` — authenticated but lacks right.
- `404 Not Found` — unknown route / entity.
- `500` in production hides internal messages (`Internal server error`).

**Auth**: `Authorization: Bearer <accessToken>`.

**Field notes**:
- `status`: `0` = inactive, `1` = active, `2` = soft-deleted.
- Date/time fields: ISO strings (`createdAt`, `updatedAt`) via Mongoose formatting.
- `id` (string) instead of `_id` in all JSON output.

### 6.1 Auth — public unless noted

#### `POST /api/auth/register` *(public)*
Register a user; auto-login (tokens returned).

Request body:
```json
{
  "first_name": "John",                 // required
  "last_name": "Doe",                   // required
  "email": "john@example.com",          // required, valid email
  "contact_no": "1234567890",           // required
  "business_address": "",               // optional, allow ''
  "password": "secret123",              // optional; ≥8, ≥1 letter, ≥1 number
  "role": "USER",                       // optional, enum ['USER_ADMIN','USER'], default 'USER'
  "parent_id": null                     // optional, ObjectId
}
```
- Creates account with `is_sub_user:false`, `isSuperAdmin:false`, `status:1`, `isEmailVerified:false`.
- Passing `role: 'SUPER_ADMIN'` → **400**.

Response `201`:
```json
{
  "status": 201,
  "message": "User registered successfully.",
  "data": { "user": { /* user json */ }, "tokens": { "access": { "token","expires" }, "refresh": { "token","expires" } } }
}
```

#### `POST /api/auth/send-otp` *(public)*
```json
{ "email": "john@example.com" }
```
- `200 OTP sent successfully to your registered email.` (bypass or real; no OTP in response).

#### `POST /api/auth/verify-otp` *(public)*
```json
{ "email": "john@example.com", "otp": "123456" }   // otp length 6
```
- `200` → `{ status, message, data: { tokens, user } }`.

#### `POST /api/auth/refresh-tokens` *(public)*
```json
{ "refreshToken": "<refresh>" }
```
- `200 Tokens refreshed successfully.` → `data: { tokens, user }` (old row consumed).

#### `POST /api/auth/logout` *(auth)*
```json
{ "refreshToken": "<refresh>" }
```
- `200 Logged out successfully.`

#### `GET /api/auth/me` *(auth)*
- `200 User profile fetched successfully.` → `data: { user }`.

### 6.2 Admin User Management — `manageUsers` right (SUPER_ADMIN only)

All under `/api/users`.

#### `GET /api/users` — list users
Query params:
| Name | Type | Notes |
|---|---|---|
| `search` | string | case-insensitive regex over first_name, last_name, email, contact_no (regex-escaped) |
| `status` | int `0|1|2` | default excludes `2` |
| `role` | string | `SUPER_ADMIN` \| `USER_ADMIN` \| `USER` (filter allows all 3) |
| `sortBy` | string | `field:asc|desc` (comma list) |
| `limit` | int 1–100 | default 10 |
| `page` | int ≥1 | default 1 |

Response `200`:
```json
{
  "status": 200,
  "message": "Users fetched successfully.",
  "data": { "results": [ /* user json */ ], "page": 1, "limit": 10, "totalPages": 1, "totalResults": 3 }
}
```

#### `GET /api/users/get-all/user` — alias
Same handler + validation as `GET /api/users`.

#### `POST /api/users/create-user` — create user
Body (role default `USER_ADMIN`):
```json
{
  "first_name": "Jane",                 // required
  "last_name": "Smith",                 // required
  "email": "jane@example.com",          // required
  "contact_no": "",                     // allow ''/null
  "business_address": "",               // allow ''/null
  "role": "USER_ADMIN",                 // enum ['USER_ADMIN','USER'], default USER_ADMIN
  "status": 1,                          // 0|1, default 1
  "isEmailVerified": false,             // optional boolean
  "isSuperAdmin": false,                // optional boolean
  "parent_id": null                     // ObjectId / '' / null
}
```
- Duplicate email → 400 `Email already taken`.
- `role: 'SUPER_ADMIN'` → 400.

Response `201` → `data: { user }` (message `User registered successfully.`).

#### `GET /api/users/:userId` — get one user
`userId` must be a valid 24-hex Mongo id.
- `200 User fetched successfully.` → `data: { user }`; `404 User not found`.

#### `PUT /api/users/admin-update/:userId` — update user
Body optional keys (at least one), plus `userId` param:
`first_name`, `last_name`, `email`, `contact_no`, `business_address`, `role` (`USER_ADMIN|USER`),
`status` (0|1|2), `isEmailVerified`, `isSuperAdmin`, `is_sub_user`, `parent_id`.
- Sets `modified_by` to actor id.
- `role: 'SUPER_ADMIN'` → 400; duplicate email → 400.
- `200 User updated successfully.` → `data: { user }`.

#### `PATCH /api/users/:userId/role` — update role
```json
{ "role": "USER_ADMIN" }                // required, enum USER_ADMIN|USER
```
- `role: 'SUPER_ADMIN'` → 400.
- `200 User role updated successfully.` → `data: { user }`.

#### `POST /api/users/:userId/update-status` — update status
Body (at least one of `status` / `action_type`):
```json
{ "status": 1 }                          // 0|1|2
      // OR
{ "action_type": "activate" }            // activate|deactivate|toggle
```
- `toggle`: flips current `1↔0`.
- `200 User status updated successfully.` → `data: { user }`.

#### `DELETE /api/users/:userId` — delete user (soft)
- Sets `status: 2` (soft-delete + audit trail via modified flags); user doc still returned.
- Cannot delete yourself → 400 `You cannot delete your own account`.
- `200 User deleted successfully.` → `data: { user }`.

### 6.3 Sub-User Management — `manageSubUsers` right (SUPER_ADMIN + USER_ADMIN)

All under `/api/users`. **Owners (USER_ADMIN) are auto-scoped to their own `parent_id`** —
they can only see/manage their own sub-users; SUPER_ADMIN may scope to any/all.

#### `POST /api/users/create-sub-user` — create sub-user
Body (role default `USER`):
```json
{
  "first_name": "Bob",                  // required
  "last_name": "Brown",                 // required
  "email": "bob@example.com",           // required
  "contact_no": "",                     // allow ''/null
  "business_address": "",               // allow ''/null
  "role": "USER",                       // enum ['USER','USER_ADMIN'], default USER
  "status": 1,                          // 0|1, default 1
  "parent_id": "<parentUserId>"         // REQUIRED for SUPER_ADMIN (else 400); ignored for USER_ADMIN
}
```
- Always creates with `is_sub_user:true`, `parent_id` set, `isEmailVerified:false`, `created_by` = actor.
- Parent must exist and not be soft-deleted → else 404 `Parent account not found`.
- `role: 'SUPER_ADMIN'` → 400.
- `201 Sub-user created successfully.` → `data: { user }`.

#### `GET /api/users/get-all-sub-users` — list sub-users
Query params:
- `parentId` (ObjectId, optional) — SUPER_ADMIN may filter; **USER_ADMIN always forced to own id**.
- `search`, `status` (0|1|2; default excludes 2), `sortBy`, `limit`, `page`.

Response `200` → `data: { results, page, limit, totalPages, totalResults }`
(message `Sub-users fetched successfully.`).

#### `GET /api/users/sub-user/:subUserId` — get sub-user
- Scoped: non-admin requesters only see rows with `is_sub_user:true AND parent_id == requester`.
- `200 Sub-user fetched successfully.` → `data: { user }`; else `404 Sub-user not found`.

#### `PUT /api/users/update-sub-user/:subUserId` — update sub-user
Body optional (≥1): `first_name`, `last_name`, `email`, `contact_no`, `business_address`,
`role` (`USER|USER_ADMIN`), `status` (0|1|2), `isEmailVerified`.
- Sets `modified_by` = actor. Email-duplicate → 400. `role: 'SUPER_ADMIN'` → 400.
- `200 Sub-user updated successfully.` → `data: { user }`.

#### `PATCH /api/users/sub-user-role/:subUserId` — sub-user role
```json
{ "role": "USER_ADMIN" }                // required, enum USER|USER_ADMIN
```
- `role: 'SUPER_ADMIN'` → 400.
- `200 Sub-user role updated successfully.` → `data: { user }`.

#### `POST /api/users/sub-user-status/:subUserId` — sub-user status
Body: same `status`/`action_type` semantics as admin status.
- `200 Sub-user status updated successfully.` → `data: { user }`.

#### `DELETE /api/users/sub-user/:subUserId` — delete sub-user (soft)
- Sets `status: 2` (scoped lookup). `200 Sub-user deleted successfully.` → `data: { user }`.

### 6.4 Health / root

- `GET /api/health` and `GET /health` → `{ "status": 200, "message": "ScanFlow API is up and running." }` (both public).
- `GET /` → `{ "status": 200, "message": "ScanFlow API" }`.

---

## 7. Validation Reference

All schemas in `src/validations/`; applied via `validate()` middleware which
validates **only** `params`, `query`, `body` and `Object.assign`s sanitized values back.

Custom rules (`custom.validation.ts`):
- `objectId` → must match `/^[0-9a-fA-F]{24}$/` (`must be a valid mongo id`).
- `password` → ≥8 chars AND ≥1 digit AND ≥1 letter.

### auth.validation.ts
| Export | Fields |
|---|---|
| `register` | first_name*, last_name*, email*, contact_no*, business_address('' opt), password (custom, opt), role(USER_ADMIN\|USER, default USER), parent_id(objectId opt) |
| `sendOtp` | email* |
| `verifyOtp` | email*, otp* (length 6) |
| `refreshTokens` | refreshToken* |
| `logout` | refreshToken* |

### admin/users.validations.ts
- `userRoleValues = ['SUPER_ADMIN','USER_ADMIN','USER']` (list filter only)
- `assignableRoleValues = ['USER_ADMIN','USER']` (all mutations)
- `listUsers` (query): search, status(0|1|2), role(any of 3), sortBy, limit(1–100), page
- `getUser` (params): userId → objectId
- `createUser` (body): first_name*, last_name*, email*, contact_no/business_address (''/null), role(assignable, default USER_ADMIN), status(0|1, default 1), isEmailVerified, isSuperAdmin, parent_id(objectId/''/null)
- `adminUpdateUser` (params+body): same body keys configurable; requires ≥1 field
- `updateRole` (params+body): role* assignable
- `updateStatus` (params+body): status(0|1|2) OR action_type(activate|deactivate|toggle); ≥1; require `.or`

### user/sub-users.validations.ts
- `listSubUsers` (query): parentId(objectId), search, status, sortBy, limit, page
- `createSubUser` (body): like createUser but role default USER; parent_id(objectId, optional — but SUPER_ADMIN caller must supply it per service)
- `getSubUser` / `deleteSubUser` (params): subUserId → objectId
- `updateSubUser` (params+body, ≥1): first/last_name, email, contact_no, business_address, role(USER|USER_ADMIN), status(0|1|2), isEmailVerified
- `subUserRole` (params+body): role* USER|USER_ADMIN
- `subUserStatus` (params+body): same as admin updateStatus

---

## 8. Service Layer Rules / Business Logic

### Admin users (`admin/users.service.ts`)
- `createUser`: role default `USER`; **rejects `SUPER_ADMIN`**; `is_sub_user`/`isSuperAdmin`
  come only from explicit inputs (never derived from role); email uniqueness check first.
- `updateUserById`: email-taken guard (exclude self), `SUPER_ADMIN` role guard,
  applies whitelist `USER_UPDATE_KEYS`, stamps `modified_by`.
- `updateUserRoleById`: guard, then sets `role` only (isSuperAdmin untouched).
- `updateUserStatusById`: shared `computeUserStatus(status, action_type)` function.
- `deleteUserById`: sets `status:2` (soft); self-delete blocked.
- `listUsers`: default excludes `status 2`; regex-escaped search; paginate.

### Sub-users (`user/sub-users.service.ts`)
- `resolveParentScope(reqUser, parentId)`: SUPER_ADMIN → provided parentId or null (all);
  otherwise → own id (self-scope).
- `createSubUser`: SUPER_ADMIN must pass `parent_id` (400); parent must exist & not soft-deleted;
  always `is_sub_user:true`; `SUPER_ADMIN` role guard.
- All reads/writes go through `getSubUserById` which enforces `is_sub_user:true` + parent scope.
- Updates/role/status/delete stamp `modified_by`.

---

## 9. Error Handling

- `ApiError(statusCode, message, isOperational=true, stack='')`.
- `errorConverter` maps: Mongoose errors → 400; JWT verify/expired/not-before → 401;
  Mongo duplicate key (11000) → 400; unknown → 500.
- `errorHandler`: single JSON envelope `{ code, message, stack? }`; in production non-ApiError
  becomes generic 500; dev logs + stack; every handled error persists to `tbl_systemError`
  via `systemErrorHandler.errorM({ action_type: 'global-error-handler', error_data: err })`.
- Controllers are wrapped in `catchAsync` (forwards rejection to next → error pipeline).

---

## 10. Pagination

`paginate.plugin.ts` — used by `listUsers` and `listSubUsers`:
- defaults `page=1`, `limit=10`
- `sortBy`: `field:asc` / `field:desc`, comma-separated; default `createdAt`
- response: `{ results, page, limit, totalPages, totalResults }`

---

## 11. Security Notes

- helmet defaults, CORS open (`Access-Control-Allow-Origin: *`).
- Mongo key sanitization (`express-mongo-sanitize`) on body+query.
- Rate limiting on `/api/auth` only in production (15 min window, max 20, skip successes).
- Passwords bcrypt-hashed (factor 8) on save; stored with `select:false` + `private` (stripped from JSON).
- Refresh tokens stored in DB, single-use; not blacklistable after logout (row deleted).
- No `role`-derived superadmin; `isSuperAdmin` boolean is the authoritative tier flag.
- Access tokens: 30 min; no refresh-token reuse detection (only single-use delete).

---

## 12. Deployment

- **Docker**: multi-stage `node:22-alpine`; runs `node dist/index.js` as user `nodejs`;
  healthcheck on `GET http://127.0.0.1:3000/api/health` (container).
- **Compose** (`docker-compose.yml`): services `api` (HOST_PORT:3000) and `api-replica`
  (REPLICA_PORT:3004, profile `replica`); env from `.env`, `MONGODB_URL` overridden by
  `DOCKER_MONGODB_URL` (default `mongodb://host.docker.internal:27017/scanflow`);
  external network `scanflow-shared-network`.
- **Apache** reverse proxy config: `deploy/apache/scanflow-api.conf` (proxies `/api`).
- **Env for compose**: `HOST_PORT`, `REPLICA_PORT`, `CONTAINER_PORT`, `REPLICAS`,
  `IMAGE_TAG`, `MEMORY_LIMIT`, `MEMORY_RESERVATION`, `DOCKER_MONGODB_URL`.

---

## 13. Current DB Snapshot (development)

`tbl_users` active rows (`status != 2`), as of last verification:

| email | role | is_sub_user | parent_id | status |
|---|---|---|---|---|
| dev@scanflow.com | `SUPER_ADMIN` | false | null | 1 |
| vivek.ctasis.llp@gmail.com | `USER` | false | null | 1 |
| logtest1790063568@scanflow.com | `USER` | false | null | 1 |

- Dev OTP bypass active (`NODE_ENV != production`): `BYPASS_EMAIL=dev@scanflow.com`, `BYPASS_OTP=777777`.

---

## 14. Patterns for the Next Implementation

### End-to-end "add a new feature" checklist (follow existing 3-layer layout)

```
validations/<area>/*.validations.ts  →  routes/<area>/*.route.ts  →  controllers/<area>/*.controller.ts  →  services/<area>/*.service.ts
```

1. **Validation**: Joi schema `{ params?, query?, body? }` in `src/validations/`.
   Use `objectId` for ids, keep `SUPER_ADMIN` out of assignable role enums.
2. **Route**: mount sub-router in `src/routes/<area>/`, register in `routes/index.ts`
   (`router.use('/path', xRouter)`). Add new prefixes to `PUBLIC_PATHS` only if truly public.
3. **Protect**: `auth('rightName')` on the route; add right name to the role map in `config/roles.ts`.
4. **Controller**: thin, `catchAsync` + `pick` query filters + `createResponse` envelope.
5. **Service**: business rules, guards, `ApiError` for failures; stamp `created_by`/`modified_by`
   where an actor matters.
6. **Envelope**: success `{ status, message, data }`; errors `{ code, message, stack? }`.
7. **Model**: if new collections — apply `toJSON` + `paginate` plugins; keep model `tbl_<name>` name pattern.
8. **System errors**: route unexpected failures through `systemErrorHandler.errorM`.
9. **Verify**: `npm run lint`, `npm run prettier-check`, `npm run build`; runtime smoke via `/api`.

### Notes for next phase (gaps / decisions already flagged)
- `JWT_RESET_PASSWORD_*`, `JWT_VERIFY_EMAIL_*` and token types `resetPassword`/`verifyEmail`
  are defined but **not used** — email-verification and password-reset flows are the natural next features.
- `ensureSuperAdmin.ts` is dead code — remove or align to `isRequesterAdmin`.
- No refresh-token rotation/reuse detection; no device/session listing or logout-all.
- `is_sub_user` + `parent_id` exist, but there is no invites, no parent dashboard aggregation.
- No audit/log table for admin mutations (only `created_by`/`modified_by` on users).
- No tests yet (no test script); consider adding an integration smoke suite.

---

*Generated against the current source; re-verify after any schema/route change.*