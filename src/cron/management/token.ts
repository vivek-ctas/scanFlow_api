import crypto from 'node:crypto';
import config from '../../config/config.js';
import { logger } from '../../config/logger.js';

/**
 * CronZivo management token verifier — standard JWT (HS256).
 *
 * Mirrors the normative specification in `cronzivo_api/docs/management-token.md`.
 * The algorithm is pinned to HS256; `none` and every other alg are rejected.
 * Changing the derivation constants requires a contract version bump.
 */
export const MGMT_TOKEN_ALG = 'HS256';
export const MGMT_TOKEN_ISSUER = 'cronzivo';
export const MGMT_TOKEN_SUBJECT = 'cronzivo-panel';
export const MGMT_TOKEN_SALT = 'cronzivo-mgmt-token-v1';
export const MGMT_TOKEN_MAX_TTL_SEC = 900;
export const MGMT_TOKEN_CLOCK_SKEW_SEC = 60;

export interface ManagementTokenPayload {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
}

export type VerifyFailureReason =
  | 'format'
  | 'alg'
  | 'signature'
  | 'audience'
  | 'issuer'
  | 'claims'
  | 'expired'
  | 'iat_future'
  | 'ttl';

export type VerifyManagementTokenResult =
  | { ok: true; payload: ManagementTokenPayload }
  | { ok: false; reason: VerifyFailureReason };

export const buildAudience = (productCode: string, environment: string) =>
  `${String(productCode).toUpperCase()}|${String(environment).toUpperCase()}`;

export const cronzivoAudience = () =>
  buildAudience(config.cronzivo.productCode, config.cronzivo.environment);

export const deriveManagementKey = (globalKey: string, aud: string): Buffer =>
  Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(globalKey, 'utf8'),
      Buffer.from(MGMT_TOKEN_SALT, 'utf8'),
      Buffer.from(aud, 'utf8'),
      32,
    ),
  );

const safeEqualBuffers = (a: Buffer, b: Buffer) =>
  a.length === b.length && crypto.timingSafeEqual(a, b);

export const verifyManagementToken = (options: {
  token: string;
  keys: string[];
  expectedAud: string;
  nowSec?: number;
}): VerifyManagementTokenResult => {
  const { token, keys, expectedAud } = options;
  const now = options.nowSec ?? Math.floor(Date.now() / 1000);

  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    return { ok: false, reason: 'format' };
  }

  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(
      Buffer.from(parts[0] as string, 'base64url').toString('utf8'),
    ) as { alg?: unknown; typ?: unknown };
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (!header || header.alg !== MGMT_TOKEN_ALG) {
    return { ok: false, reason: 'alg' };
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  const received = Buffer.from(parts[2] as string, 'base64url');

  let signatureOk = false;
  for (const key of keys) {
    if (!key) continue;
    const expected = crypto
      .createHmac('sha256', deriveManagementKey(key, expectedAud))
      .update(signingInput)
      .digest();
    if (safeEqualBuffers(expected, received)) {
      signatureOk = true;
      break;
    }
  }
  if (!signatureOk) return { ok: false, reason: 'signature' };

  let payload: ManagementTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(parts[1] as string, 'base64url').toString('utf8'),
    ) as ManagementTokenPayload;
  } catch {
    return { ok: false, reason: 'format' };
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'format' };
  }
  if (payload.iss !== MGMT_TOKEN_ISSUER) {
    return { ok: false, reason: 'issuer' };
  }
  if (payload.aud !== expectedAud) {
    return { ok: false, reason: 'audience' };
  }
  if (
    typeof payload.sub !== 'string' ||
    payload.sub.length === 0 ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    typeof payload.jti !== 'string' ||
    payload.jti.length === 0
  ) {
    return { ok: false, reason: 'claims' };
  }
  if (payload.exp + MGMT_TOKEN_CLOCK_SKEW_SEC <= now) {
    return { ok: false, reason: 'expired' };
  }
  if (payload.iat > now + MGMT_TOKEN_CLOCK_SKEW_SEC) {
    return { ok: false, reason: 'iat_future' };
  }
  if (payload.exp - payload.iat > MGMT_TOKEN_MAX_TTL_SEC) {
    return { ok: false, reason: 'ttl' };
  }

  return { ok: true, payload };
};

/** Verify a request with the locally configured audience and key slots. */
export const verifyBearerToken = (authorization: string | undefined) => {
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return { ok: false as const, reason: 'format' as const };
  }
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) {
    return { ok: false as const, reason: 'format' as const };
  }

  const keys = [config.cronzivo.apiKey, config.cronzivo.apiKeySecondary].filter(
    Boolean,
  );
  if (!keys.length) {
    return { ok: false as const, reason: 'signature' as const };
  }

  const result = verifyManagementToken({
    token,
    keys,
    expectedAud: cronzivoAudience(),
  });

  if (!result.ok) {
    // Log only the category — never the token, payload, or key.
    logger.warn(`[CRONZIVO] management token rejected: ${result.reason}`);
  }

  return result;
};
