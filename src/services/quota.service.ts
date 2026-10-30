import httpStatus from 'http-status';
import config from '../config/config.js';
import { Organization } from '../models/organization.model.js';
import { Subscription } from '../models/subscription.model.js';
import { Usage } from '../models/usage.model.js';
import { User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { getRedis, isRedisConfigured } from '../queues/redis.js';
import { logger } from '../config/logger.js';
import { Notification } from '../models/index.js';

export const activeSubscriptionCacheKey = (organizationId: string): string =>
  `org:${organizationId}:activeSub`;

const EXPIRY_GRACE_MS = 3600000;

export interface ActiveSubCache {
  scanLimit: number;
  expiresAt: number;
  used: number;
}

/**
 * Writes the active-subscription cache hash (limit + expiresAt + used).
 * `resetUsed` zeroes the counter (new period: grant/promote/force-activate).
 * Otherwise the current `used` value is preserved (renewal) unless a
 * caller-supplied `used` overrides it (cold-cache seed).
 */
export const writeActiveSubscriptionCache = async (
  organizationId: string,
  scanLimit: number,
  expiresAt: Date,
  resetUsed: boolean = true,
  used?: number,
): Promise<void> => {
  if (!isRedisConfigured()) {
    return;
  }
  const redis = getRedis();
  const key = activeSubscriptionCacheKey(organizationId);
  try {
    const fields: Record<string, string> = {
      limit: String(scanLimit),
      expiresAt: String(expiresAt.getTime()),
    };
    if (resetUsed) {
      fields.used = '0';
    } else {
      const existing = await redis.hget(key, 'used');
      fields.used = String(used ?? (existing !== null ? Number(existing) : 0));
    }
    await redis.hset(key, fields);
    await redis.pexpireat(key, expiresAt.getTime() + EXPIRY_GRACE_MS);
  } catch (err: any) {
    logger.error(
      `[QUOTA] activeSub cache write failed for ${organizationId}: ${err.message}`,
    );
  }
};

/** Reads the active-subscription cache hash; null when absent/unconfigured. */
export const readActiveSubUsage = async (
  organizationId: string,
  _sub?: {
    started_at: Date;
    expires_at: Date;
    features: { scan_limit: number }[];
  },
): Promise<ActiveSubCache | null> => {
  if (!isRedisConfigured()) {
    return null;
  }
  const redis = getRedis();
  try {
    const raw = await redis.hmget(
      activeSubscriptionCacheKey(organizationId),
      'limit',
      'expiresAt',
      'used',
    );
    const scanLimit = parseInt(String(raw[0]), 10);
    const expiresAt = parseInt(String(raw[1]), 10);
    const used = parseInt(String(raw[2] ?? '0'), 10);
    if (Number.isNaN(expiresAt)) {
      return null;
    }
    return { scanLimit, expiresAt, used };
  } catch (err: any) {
    logger.error(
      `[QUOTA] activeSub cache read failed for ${organizationId}: ${err.message}`,
    );
    return null;
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

// Atomic quota check-and-increment. The counter lives in the same hash as the
// window bounds, so there is exactly one key. Returns:
//  -1 quota exceeded / -2 cache miss / -3 subscription expired / positive new count.
// `limit === 0` means unlimited (plan convention).
const RESERVE_SCRIPT = `
local subData = redis.call('HMGET', KEYS[1], 'limit', 'expiresAt', 'used')
local limit = tonumber(subData[1])
local expiresAt = tonumber(subData[2])
local used = tonumber(subData[3] or '0')
if not limit or not expiresAt then
  return -2
end
if expiresAt <= tonumber(ARGV[1]) then
  return -3
end
if limit ~= 0 and used + 1 > limit then
  return -1
end
local newVal = redis.call('HINCRBY', KEYS[1], 'used', 1)
redis.call('PEXPIREAT', KEYS[1], expiresAt + 3600000)
return newVal
`;

export type ReserveResult =
  | { status: 'ok'; count: number }
  | { status: 'quota_exceeded' }
  | { status: 'subscription_expired' }
  | { status: 'cache_miss' };

/**
 * Atomic quota check-and-increment. Redis unreachable (or unconfigured) throws
 * a 503 — the scan path must not create a scan in that case.
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
      1,
      activeSubscriptionCacheKey(organizationId),
      String(Date.now()),
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

// Releases a reservation without ever creating a stray hash: only decrements
// when the hash already exists and `used` is positive.
const RELEASE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  local used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')
  if used > 0 then
    redis.call('HINCRBY', KEYS[1], 'used', -1)
  end
end
return 1
`;

/** Releases a reservation taken by this request when a duplicate is detected late. */
export const releaseScanUsage = async (
  organizationId: string,
): Promise<void> => {
  if (!isRedisConfigured()) {
    return;
  }
  const redis = getRedis();
  try {
    await redis.eval(
      RELEASE_SCRIPT,
      1,
      activeSubscriptionCacheKey(organizationId),
    );
  } catch (err: any) {
    logger.error(
      `[QUOTA] reserve release failed for ${organizationId}: ${err.message}`,
    );
  }
};

/**
 * Copies the active-subscription cache counter into the active subscription's
 * Usage row (durable mirror). Runs in the worker every 30s.
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
    'organization_id features',
  );
  const scanLimitOfForSub = (features: any[]) =>
    features.find((f: any) => f.features_name === 'scan')?.scan_limit ?? 0;
  for (const sub of activeSubs) {
    const raw = await readActiveSubUsage(
      String(sub.organization_id),
      sub as any,
    );
    const used = raw?.used ?? 0;
    const limit = scanLimitOfForSub(sub.features);
    await Usage.updateOne(
      { subscription_id: sub._id, organization_id: sub.organization_id },
      {
        $set: {
          usage: used,
          is_exhausted: limit !== 0 && used >= limit,
        },
      },
    );
    results.push({ organizationId: String(sub.organization_id), used });
  }
  return results;
};

/**
 * Flushes the org's Redis `used` counter into the active subscription's Usage
 * row, then returns the flushed value. Call before cancel/expiry/force so the
 * durable counter is never lost. Returns null when no active cache exists.
 */
export const flushActiveSubUsage = async (
  organizationId: string,
): Promise<number | null> => {
  if (!isRedisConfigured()) {
    return null;
  }
  const sub = await Subscription.findOne({
    organization_id: organizationId,
    status: 'active',
  }).select('organization_id _id features');
  if (!sub) {
    return null;
  }
  const raw = await readActiveSubUsage(organizationId, sub as any);
  if (!raw) {
    return null;
  }
  const limit =
    sub.features?.find((f: any) => f.features_name === 'scan')?.scan_limit ?? 0;
  await Usage.updateOne(
    { subscription_id: sub._id, organization_id: sub.organization_id },
    {
      $set: {
        usage: raw.used,
        is_exhausted: limit !== 0 && raw.used >= limit,
      },
    },
  );
  return raw.used;
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

/**
 * Checks quota thresholds against the fresh usage mirror and creates notifications.
 * Runs after the 30-second reconcile cycle; reads tbl_usage, never touches Redis or scan path.
 * Only the highest crossed level per usage row is sent; unlimited (scan_limit 0) is skipped.
 * Two concurrent runs are safe because of the conditional findOneAndUpdate with $or.
 */
export const checkQuotaAlerts = async (): Promise<void> => {
  try {
    // 1. Get all active subscriptions (status: 'active' and expires_at > now)
    const activeSubs = await Subscription.find({
      status: 'active',
      expires_at: { $gt: new Date() },
    }).select('_id organization_id');

    if (activeSubs.length === 0) {
      logger.info('[QUOTA] no active subscriptions');
      return;
    }

    const activeSubIds = activeSubs.map((sub) => sub._id);
    const activeOrgs = new Set(activeSubs.map((sub) => sub.organization_id));

    // 2. Get thresholds from config
    const thresholds = config.notification.quotaThresholds
      .split(',')
      .map(Number); // e.g. [80, 90, 100]

    // 3. For each active org, find usage rows with scan_limit > 0
    for (const orgId of activeOrgs) {
      const usageRows = await Usage.find({
        organization_id: orgId,
        subscription_id: { $in: activeSubIds },
        scan_limit: { $gt: 0 },
      }).lean();

      if (usageRows.length === 0) continue;

      // 4. For each usage row, check crossed thresholds
      for (const row of usageRows) {
        const usedPct = (row.usage / row.scan_limit) * 100;
        if (isNaN(usedPct)) continue;

        // Find the highest threshold this row has crossed
        let highestCrossed = 0;
        for (const t of thresholds) {
          if (usedPct >= t) highestCrossed = t;
        }

        if (highestCrossed === 0) continue; // no threshold crossed

        // 5. Only create notification if the new level is higher than stored
        if (row.quota_alert_level >= highestCrossed) continue;

        // 6. Resolve org admins (active only)
        const admins = await User.find({
          role: 'ORGANIZATION_ADMIN',
          organization_id: orgId,
          status: 1,
        }).select('_id');

        if (admins.length === 0) continue;

        const adminIds = admins.map((a) => a._id);

        // 7. Conditional create via findOneAndUpdate with dedupe_key
        const result = await Notification.findOneAndUpdate(
          {
            user_id: { $in: adminIds },
            type: 'quota_alert',
            dedupe_key: `subscription:${row.subscription_id}:quota`,
          },
          {
            $set: {
              severity: highestCrossed >= 100 ? 'critical' : 'warning',
              title:
                highestCrossed >= 100
                  ? 'Scan limit reached'
                  : '80% of your scan limit used',
              message:
                highestCrossed >= 100
                  ? `You have used 100% of your scan limit (${row.usage} of ${row.scan_limit}). New scans are rejected until your plan is renewed.`
                  : `You have used ${highestCrossed}% of your scan limit (${row.usage} of ${row.scan_limit}).`,
              action_url: '/',
              expires_at: new Date(Date.now() + 90 * 86400000),
              is_read: false,
            },
            $setOnInsert: {
              user_id: adminIds[0],
            },
          },
          { upsert: true, new: true, runValidators: true },
        ).lean();

        // 8. Update the usage row's quota_alert_level atomically
        await Usage.updateOne(
          { _id: row._id },
          { $set: { quota_alert_level: highestCrossed } },
        );

        logger.info(
          `[QUOTA] notification ${result ? 'created' : 'skipped'} for org ${orgId} sub ${row.subscription_id} at ${highestCrossed}%`,
        );
      }
    }
  } catch (err: any) {
    logger.error(`[QUOTA] checkQuotaAlerts failed: ${err.message}`);
  }
};
