import httpStatus from 'http-status';
import type { Redis } from 'ioredis';
import config from '../../config/config.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../config/logger.js';
import { getRedis, isRedisConfigured } from '../../queues/redis.js';

/**
 * Single-flight + serve-stale cache for dashboard widgets.
 *
 * Keys live in their own `dash:` namespace and never collide with the scan
 * path (`org:*:activeSub`) or the webhook batcher (`webhook-batch:*`). A stale
 * entry is served immediately while one caller refreshes it, so an expiry never
 * stampedes the database.
 */

const KEY_PREFIX = 'dash:v1';

export interface WidgetCacheOptions {
  freshSeconds?: number;
  ttlSeconds?: number;
  /** Scan-backed widgets fail closed (503) when Redis is unavailable. */
  scanHeavy?: boolean;
}

export interface WidgetResult<T> {
  data: T;
  computedAt: string;
}

const nowIso = (ms = Date.now()): string => new Date(ms).toISOString();

const unavailable = <T>(
  compute: () => Promise<T>,
  scanHeavy?: boolean,
): Promise<WidgetResult<T>> => {
  if (scanHeavy) {
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Dashboard widget temporarily unavailable',
    );
  }
  return compute().then((data) => ({ data, computedAt: nowIso() }));
};

const waitForEntry = async <T>(
  redis: Redis,
  fullKey: string,
  waitMs: number,
): Promise<WidgetResult<T> | null> => {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const raw = await redis.get(fullKey);
    if (raw) {
      const entry = JSON.parse(raw) as { data: T; at: number };
      return { data: entry.data, computedAt: nowIso(entry.at) };
    }
  }
  return null;
};

const refreshInBackground = async <T>(
  redis: Redis,
  fullKey: string,
  lockKey: string,
  ttlMs: number,
  maxMs: number,
  compute: () => Promise<T>,
): Promise<void> => {
  try {
    const acquired = await redis.set(lockKey, '1', 'PX', maxMs + 2000, 'NX');
    if (acquired !== 'OK') {
      return;
    }
    const data = await compute();
    await redis.set(
      fullKey,
      JSON.stringify({ data, at: Date.now() }),
      'PX',
      ttlMs,
    );
  } catch (err: any) {
    logger.error(`[DASHBOARD] background refresh failed: ${err.message}`);
  } finally {
    try {
      await redis.del(lockKey);
    } catch {
      // lock expiry guards the rare release failure
    }
  }
};

/**
 * Return the cached widget value, computing it exactly once per freshness
 * window. Never throws for cheap widgets when Redis is down — it falls back to
 * a bounded direct query.
 */
export const getOrCompute = async <T>(
  key: string,
  options: WidgetCacheOptions,
  compute: () => Promise<T>,
): Promise<WidgetResult<T>> => {
  const freshMs =
    (options.freshSeconds ?? config.dashboard.cacheFreshSeconds) * 1000;
  const ttlMs =
    (options.ttlSeconds ?? Math.max(freshMs * 2, freshMs + 120_000)) || freshMs;
  const fullKey = `${KEY_PREFIX}:${key}`;
  const lockKey = `dash:lock:${key}`;
  const maxMs = config.dashboard.queryMaxMs;

  if (!isRedisConfigured()) {
    return unavailable(compute, options.scanHeavy);
  }

  let redis: Redis;
  try {
    redis = getRedis();
  } catch {
    return unavailable(compute, options.scanHeavy);
  }

  try {
    const raw = await redis.get(fullKey);
    if (raw) {
      const entry = JSON.parse(raw) as { data: T; at: number };
      const age = Date.now() - entry.at;
      if (age <= freshMs) {
        return { data: entry.data, computedAt: nowIso(entry.at) };
      }
      if (age <= ttlMs) {
        void refreshInBackground(
          redis,
          fullKey,
          lockKey,
          ttlMs,
          maxMs,
          compute,
        );
        return { data: entry.data, computedAt: nowIso(entry.at) };
      }
    }

    const acquired = await redis.set(lockKey, '1', 'PX', maxMs + 2000, 'NX');
    if (acquired === 'OK') {
      try {
        const data = await compute();
        const at = Date.now();
        await redis.set(fullKey, JSON.stringify({ data, at }), 'PX', ttlMs);
        return { data, computedAt: nowIso(at) };
      } finally {
        try {
          await redis.del(lockKey);
        } catch {
          // lock expiry guards the rare release failure
        }
      }
    }

    if (options.scanHeavy) {
      const waited = await waitForEntry<T>(redis, fullKey, 1400);
      if (waited) {
        return waited;
      }
    }

    const data = await compute();
    return { data, computedAt: nowIso() };
  } catch (err: any) {
    logger.error(`[DASHBOARD] cache error for ${key}: ${err.message}`);
    return unavailable(compute, options.scanHeavy);
  }
};
