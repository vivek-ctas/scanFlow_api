import httpStatus from 'http-status';
import { Organization } from '../models/organization.model.js';
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

export const incrementScanUsage = async (
  organizationId: string,
  period: string = 'monthly',
) => {
  if (!isRedisConfigured()) {
    logger.warn('[QUOTA] REDIS_URL not configured; counter skipped');
    return 0;
  }
  const redis = getRedis();
  const value = await redis.incr(redisScanKey(organizationId, period));
  return value;
};

export const getPeriodScanCount = async (
  organizationId: string,
  period: string = 'monthly',
) => {
  if (!isRedisConfigured()) {
    return 0;
  }
  const redis = getRedis();
  const raw = await redis.get(redisScanKey(organizationId, period));
  return parseInt(String(raw || '0'), 10) || 0;
};

export const reconcileScanUsage = async () => {
  if (!isRedisConfigured()) {
    logger.warn('[QUOTA] REDIS_URL not configured; reconcile skipped');
    return [];
  }
  const redis = getRedis();
  const orgs = await Organization.find({ status: 1 });
  const results: { organizationId: string; count: number }[] = [];
  for (const org of orgs) {
    const period = org.scanQuota?.period ?? 'monthly';
    const key = redisScanKey(String(org._id), period);
    const count = parseInt(String((await redis.get(key)) || '0'), 10) || 0;
    org.scanUsage = { count, lastSyncedAt: new Date() };
    await org.save();
    results.push({ organizationId: String(org._id), count });
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
