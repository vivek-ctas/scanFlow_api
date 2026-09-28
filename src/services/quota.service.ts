import httpStatus from 'http-status';
import { Organization } from '../models/organization.model.js';
import { Subscription } from '../models/subscription.model.js';
import { Usage } from '../models/usage.model.js';
import { ApiError } from '../utils/ApiError.js';
import { getRedis, isRedisConfigured } from '../queues/redis.js';
import { logger } from '../config/logger.js';

export interface PeriodWindow {
  key: string;
  start: Date;
}

export const periodWindow = (
  period: string = 'monthly',
  date: Date = new Date(),
): PeriodWindow => {
  if (period === 'daily') {
    const key = date.toISOString().slice(0, 10);
    const start = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    return { key, start };
  }
  if (period === 'yearly') {
    const key = String(date.getUTCFullYear());
    return {
      key,
      start: new Date(Date.UTC(date.getUTCFullYear(), 0, 1)),
    };
  }
  const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return {
    key,
    start: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)),
  };
};

export const redisScanKey = (
  organizationId: string,
  period: string = 'monthly',
): string => {
  const { key } = periodWindow(period);
  return `org:${organizationId}:scans:${period}:${key}`;
};

export const activeSubscriptionCacheKey = (organizationId: string): string =>
  `org:${organizationId}:activeSub`;

/** Writes the active-subscription cache hash: limit + expiresAt + period (epoch ms). */
export const writeActiveSubscriptionCache = async (
  organizationId: string,
  scanLimit: number,
  expiresAt: Date,
  period: string = 'monthly',
): Promise<void> => {
  if (!isRedisConfigured()) {
    return;
  }
  const redis = getRedis();
  try {
    await redis.hset(
      activeSubscriptionCacheKey(organizationId),
      'limit',
      String(scanLimit),
      'expiresAt',
      String(expiresAt.getTime()),
      'period',
      period,
    );
  } catch (err: any) {
    logger.error(
      `[QUOTA] activeSub cache write failed for ${organizationId}: ${err.message}`,
    );
  }
};

/** Deletes the active-subscription cache hash. */
export const deleteActiveSubscriptionCache = async (
  organizationId: string,
): Promise<void> => {
  if (!isRedisConfigured()) {
    return;
  }
  const redis = getRedis();
  try {
    await redis.del(activeSubscriptionCacheKey(organizationId));
  } catch (err: any) {
    logger.error(
      `[QUOTA] activeSub cache delete failed for ${organizationId}: ${err.message}`,
    );
  }
};

// Counter keys embed the period window (daily/monthly/yearly), so the Lua
// derives the full key from KEYS[1] (the org prefix) + the cached period with
// no extra round trip. TTL is a generous upper bound; the window boundary is
// what actually resets the counter.
const COUNTER_TTL_SECONDS = 380 * 86400;

const RESERVE_SCRIPT = `
local function civilFromDays(days)
  local z = days + 719468
  local era = math.floor(z / 146097)
  local doe = z - era * 146097
  local yoe = math.floor((doe - math.floor(doe / 1460) + math.floor(doe / 36524) - math.floor(doe / 146096)) / 365)
  local y = yoe + era * 400
  local doy = doe - (365 * yoe + math.floor(yoe / 4) - math.floor(yoe / 100))
  local mp = math.floor((5 * doy + 2) / 153)
  local d = doy - math.floor((153 * mp + 2) / 5) + 1
  local m = mp < 10 and mp + 3 or mp - 9
  y = m <= 2 and y + 1 or y
  return y, m, d
end
local subData = redis.call('HMGET', KEYS[2], 'period', 'limit', 'expiresAt')
local period = subData[1] or 'monthly'
local limit = tonumber(subData[2])
local expiresAt = tonumber(subData[3])
if not limit or not expiresAt then
  return -2
end
if expiresAt <= tonumber(ARGV[1]) then
  return -3
end
local days = math.floor(tonumber(ARGV[1]) / 86400000)
local yy, mm, dd = civilFromDays(days)
local function pad(n)
  return n < 10 and '0' .. n or tostring(n)
end
local window
if period == 'daily' then
  window = tostring(yy) .. '-' .. pad(mm) .. '-' .. pad(dd)
elseif period == 'yearly' then
  window = tostring(yy)
else
  window = tostring(yy) .. '-' .. pad(mm)
end
local counterKey = KEYS[1] .. ':' .. period .. ':' .. window
local current = tonumber(redis.call('GET', counterKey) or '0')
if current + 1 > limit then
  return -1
end
local newVal = redis.call('INCR', counterKey)
redis.call('EXPIRE', counterKey, ARGV[2])
return newVal
`;

export type ReserveResult =
  | { status: 'ok'; count: number }
  | { status: 'quota_exceeded' }
  | { status: 'subscription_expired' }
  | { status: 'cache_miss' };

/**
 * Atomic quota check-and-increment (§4). Returns:
 *  -1 quota exceeded / -2 cache miss / -3 subscription expired / positive = new count.
 * Redis unreachable (or unconfigured) throws a 503 — the scan path must not
 * create a scan in that case.
 */
export const reserveScanUsage = async (
  organizationId: string,
): Promise<ReserveResult> => {
  if (!isRedisConfigured()) {
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Temporarily unavailable',
    );
  }
  const redis = getRedis();
  try {
    const result = await redis.eval(
      RESERVE_SCRIPT,
      2,
      `org:${organizationId}:scans`,
      activeSubscriptionCacheKey(organizationId),
      String(Date.now()),
      String(COUNTER_TTL_SECONDS),
    );
    if (result === -1) return { status: 'quota_exceeded' };
    if (result === -2) return { status: 'cache_miss' };
    if (result === -3) return { status: 'subscription_expired' };
    return { status: 'ok', count: Number(result) };
  } catch (err: any) {
    logger.error(
      `[QUOTA] reserve failed for ${organizationId}: ${err.message}`,
    );
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Temporarily unavailable',
    );
  }
};

/** Releases a reservation taken by this request when a duplicate is detected late. */
export const releaseScanUsage = async (
  organizationId: string,
): Promise<void> => {
  if (!isRedisConfigured()) {
    return;
  }
  const redis = getRedis();
  try {
    const periodLookup = await redis.hget(
      activeSubscriptionCacheKey(organizationId),
      'period',
    );
    const period = periodLookup || 'monthly';
    const window = periodWindow(period);
    await redis.decr(`org:${organizationId}:scans:${period}:${window.key}`);
  } catch (err: any) {
    logger.error(
      `[QUOTA] reserve release failed for ${organizationId}: ${err.message}`,
    );
  }
};

export const getPeriodScanCount = async (
  organizationId: string,
  period: string = 'monthly',
): Promise<number> => {
  if (!isRedisConfigured()) {
    return 0;
  }
  const redis = getRedis();
  const raw = await redis.get(redisScanKey(organizationId, period));
  return parseInt(String(raw || '0'), 10) || 0;
};

/**
 * Clears every period counter for an org. Used by force-activation so a brand
 * new active subscription starts from zero regardless of the previous one.
 */
export const resetScanCounters = async (
  organizationId: string,
): Promise<void> => {
  if (!isRedisConfigured()) {
    return;
  }
  const redis = getRedis();
  try {
    const pattern = `org:${organizationId}:scans:*`;
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        200,
      );
      cursor = next;
      if (keys.length) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  } catch (err: any) {
    logger.error(
      `[QUOTA] counter reset failed for ${organizationId}: ${err.message}`,
    );
  }
};

/**
 * Reconciliation: copies the current-period Redis counter into the active
 * subscription's Usage.used row (durable mirror, same relationship as the old
 * Organization.scanUsage). Runs in the worker every 30s.
 */
export const reconcileScanUsage = async (): Promise<
  { organizationId: string; used: number }[]
> => {
  const results: { organizationId: string; used: number }[] = [];
  if (!isRedisConfigured()) {
    logger.warn('[QUOTA] REDIS_URL not configured; reconcile skipped');
    return results;
  }
  const activeSubs = await Subscription.find({ status: 'active' }).select(
    'organizationId billingCycle scanLimit',
  );
  for (const sub of activeSubs) {
    const period = sub.billingCycle ?? 'monthly';
    const count = await getPeriodScanCount(String(sub.organizationId), period);
    await Usage.updateOne(
      { subscriptionId: sub._id, organizationId: sub.organizationId },
      { $set: { used: count, isExhausted: count >= sub.scanLimit } },
    );
    results.push({ organizationId: String(sub.organizationId), used: count });
  }
  return results;
};

export const assertOrganizationActive = async (
  organizationId: string,
): Promise<InstanceType<typeof Organization>> => {
  const org = await Organization.findById(organizationId);
  if (!org || org.status !== 1) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Organization is not active or not found',
    );
  }
  return org;
};
