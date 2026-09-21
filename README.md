# ScanFlow API

Basic Node.js + Express + Mongoose backend for the ScanFlow barcode scanner app.

Secure-by-default: **global JWT auth** on `/v1` (allow-list for public routes), OTP-based login (bcrypt-hashed, single-use, TTL-expiring), Joi validation on every input, central error handling with error persistence, helmet/CORS/rate-limit hardening.

## Project structure

```
src/
  app.js                 # express app: security headers, parsing, global auth, routes, error handling
  index.js               # bootstrap: mongo connect + server startup + graceful shutdown
  config/                # env config (Joi-validated), roles, tokens, logger, morgan, passport strategy
  models/                # Mongoose models + toJSON/paginate plugins
  middlewares/           # auth (JWT + rights), validate, error, rateLimiter, ensureSuperAdmin
  controllers/           # route handlers
  services/              # business logic (auth, token, user, email, common)
  routes/v1/             # route definitions + PUBLIC_PATHS allow-list
  validations/           # Joi schemas
  utils/                 # ApiError, catchAsync, pick, system-error.handler
```

## Quick start

```bash
cp .env.example .env   # then edit values (MONGODB_URL default: mongodb://127.0.0.1:27017/scanflow)
npm install
npm start              # nodemon, http://localhost:3000
```

## Endpoints

| Method | Route            | Auth               | Description                                  |
| ------ | ---------------- | ------------------ | -------------------------------------------- |
| POST   | /v1/auth/register| Public             | Register (role default SELLER_USER)          |
| POST   | /v1/auth/send-otp| Public             | Request a login OTP (email / console in dev) |
| POST   | /v1/auth/verify-otp | Public          | Verify OTP → access + refresh tokens         |
| POST   | /v1/auth/refresh-tokens | Public       | Rotate refresh token                         |
| POST   | /v1/auth/logout  | JWT                | Blacklist the refresh token                  |
| GET    | /v1/auth/me      | JWT                | Current user profile                         |
| GET    | /v1/users        | JWT + manageUsers  | Paginated user list                          |
| GET    | /health          | Public             | Liveness probe                               |

## Roles

- `SUPER_ADMIN` — `manageUsers`, `manageRoles`
- `SELLER_ADMIN` — `manageUsers`
- `SELLER_USER` — none

## Security notes

- Every `/v1` route is authenticated by default (`src/app.js`); public routes are opt-in via `PUBLIC_PATHS`.
- OTPs are stored as **bcrypt hashes** in `tbl_user_sessions` and consumed after a successful login — there is no hardcoded fallback.
- Refresh tokens are persisted and invalidated on logout / rotation.
- `.env` is gitignored; never commit secrets.

## Scripts

```bash
npm start            # dev (nodemon)
npm start:prod       # production
npm run lint         # eslint
npm run prettier     # format
npm run check-all    # lint + prettier check
```