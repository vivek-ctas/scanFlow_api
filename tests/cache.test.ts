import { describe, it, expect } from 'vitest';
import { createOrg, createPlan, grant, createUser } from './helpers.js';
import {
  activeSubscriptionCacheKey,
  reserveScanUsage,
  writeActiveSubscriptionCache,
} from '../src/services/quota.service.js';
import {
  populateActiveSubCache,
  renewSubscription,
  cancelActiveSubscription,
} from '../src/services/subscription.service.js';
import { getRedis } from '../src/queues/redis.js';
import { createScan } from '../src/services/user/scans.service.js';

describe('active-subscription cache (§4)', () => {
  it('32. cold cache miss falls back to Mongo exactly once (single charge)', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scanLimit: 5 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });

    const redis = getRedis();
    await redis.del(activeSubscriptionCacheKey(String(org._id)));

    const miss = await reserveScanUsage(String(org._id));
    expect(miss.status).toBe('cache_miss');

    const hasActive = await populateActiveSubCache(String(org._id));
    expect(hasActive).toBe(true);

    const retry = await reserveScanUsage(String(org._id));
    expect(retry.status === 'ok' && retry.count).toBe(1);
  });

  it('33. renewal updates the cached expiresAt', async () => {
    const org = await createOrg();
    const plan = await createPlan();
    const active = await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const redis = getRedis();
    const before = Number(
      await redis.hget(activeSubscriptionCacheKey(String(org._id)), 'expiresAt'),
    );
    expect(before).toBe(active.expiresAt.getTime());
    await renewSubscription(String(org._id), 'continue');
    const after = Number(
      await redis.hget(activeSubscriptionCacheKey(String(org._id)), 'expiresAt'),
    );
    expect(after).toBeGreaterThan(before);
  });

  it('34. cancel removes the cache so scans fail cleanly', async () => {
    const org = await createOrg();
    const plan = await createPlan();
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await cancelActiveSubscription(String(org._id));

    const redis = getRedis();
    const cached = await redis.hget(
      activeSubscriptionCacheKey(String(org._id)),
      'limit',
    );
    expect(cached).toBeNull();

    const user = await createUser('OPERATOR', String(org._id));
    await expect(
      createScan(
        { organizationId: String(org._id), clientScanId: 'x', barcode: 'BC-x' },
        user,
      ),
    ).rejects.toMatchObject({ statusCode: 403, message: 'NO_ACTIVE_SUBSCRIPTION' });
  });

  it('cache write reflects scanLimit, period and expiresAt fields', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scanLimit: 77, billingCycle: 'yearly' });
    const active = await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const redis = getRedis();
    const [limit, period, expiresAt] = await redis.hmget(
      activeSubscriptionCacheKey(String(org._id)),
      'limit',
      'period',
      'expiresAt',
    );
    expect(limit).toBe('77');
    expect(period).toBe('yearly');
    expect(Number(expiresAt)).toBe(active.expiresAt.getTime());
    await writeActiveSubscriptionCache(String(org._id), 1, new Date(), 'daily');
    expect(await redis.hget(activeSubscriptionCacheKey(String(org._id)), 'period')).toBe('daily');
  });
});