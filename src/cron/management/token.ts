import crypto from 'node:crypto';
import config from '../../config/config.js';
import { logger } from '../../config/logger.js';

/**
 * CronZivo management token v1 verifier.
 *
 * This is a byte-for-byte implementation of the frozen specification in
 * `cronzivo_api/docs/management-token.md`. It is used by the product and by
 * tests/conformance; do not change constants without a contract version bump.
 */
export const MGMT_TOKEN_PREFIX = 'czm1.';
export const MGMT_TOKEN_SALT = 'cronzivo-mgmt-token-v1';
export const MGMT_TOKEN_VERSION = 1;
export const MGMT_TOKEN_MAX_TTL_SEC = 900;
export const MGMT_TOKEN_CLOCK_SKEW_SEC = 60;

export interface ManagementTokenPayload {
  v: number;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

export type VerifyFailureReason =
  | 'format'
  | 'signature'
  | 'version'
  | 'audience'
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
  if (parts.length !== 3 || `${parts[0]}.` !== MGMT_TOKEN_PREFIX) {
    return { ok: false, reason: 'format' };
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  let received: Buffer;
  try {
    received = Buffer.from(parts[2] as string, 'base64url');
  } catch {
    return { ok: false, reason: 'format' };
  }

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
  if (payload.v !== MGMT_TOKEN_VERSION) {
    return { ok: false, reason: 'version' };
  }
  if (payload.aud !== expectedAud) {
    return { ok: false, reason: 'audience' };
  }
  if (
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    typeof payload.jti !== 'string' ||
    payload.jti.length === 0
  ) {
    return { ok: false, reason: 'claims' };
  }
  if (payload.exp <= now) {
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
