import { describe, it, expect } from 'vitest';
import {
  createOrg,
  createPlan,
  grant,
  createUser,
  activeUsed,
} from './helpers.js';
import {
  activeSubscriptionCacheKey,
  reserveScanUsage,
  releaseScanUsage,
} from '../src/services/quota.service.js';
import {
  populateActiveSubCache,
  renewSubscription,
  cancelActiveSubscription,
} from '../src/services/subscription.service.js';
import { getRedis } from '../src/queues/redis.js';
import { createScan } from '../src/services/user/scans.service.js';
import { Usage, Scan } from '../src/models/index.js';
import mongoose from 'mongoose';

describe('active-subscription cache (§4)', () => {
  it('32. cold cache miss falls back to Mongo exactly once (single charge)', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 5 });
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

  it('cold-cache seed = max(Usage.usage, scans since sub start)', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 100 });
    const sub = await grant(String(org._id), String(plan._id), {
      trialDays: 0,
    });
    const redis = getRedis();
    await redis.del(activeSubscriptionCacheKey(String(org._id)));

    await Scan.create([
      {
        organization_id: org._id,
        user_id: new mongoose.Types.ObjectId(),
        client_scan_id: 'seed-1',
        barcode: 'S1',
      },
      {
        organization_id: org._id,
        user_id: new mongoose.Types.ObjectId(),
        client_scan_id: 'seed-2',
        barcode: 'S2',
      },
    ]);
    await Usage.updateOne({ subscription_id: sub._id }, { $set: { usage: 4 } });
    const before = await activeUsed(String(org._id));
    expect(before).toBe(0);

    await populateActiveSubCache(String(org._id));
    // scans (2) < usage row (4) -> seed from usage row
    expect(await activeUsed(String(org._id))).toBe(4);

    await redis.del(activeSubscriptionCacheKey(String(org._id)));
    await Scan.create({
      organization_id: org._id,
      user_id: new mongoose.Types.ObjectId(),
      client_scan_id: 'seed-3',
      barcode: 'S3',
    });
    await Usage.updateOne({ subscription_id: sub._id }, { $set: { usage: 2 } });
    await populateActiveSubCache(String(org._id));
    // scans (3) > usage row (2) -> seed from mongo count
    expect(await activeUsed(String(org._id))).toBe(3);
  });

  it('33. renewal updates the cached expiresAt and preserves used', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 100 });
    const active = await grant(String(org._id), String(plan._id), {
      trialDays: 0,
    });
    const redis = getRedis();
    const key = activeSubscriptionCacheKey(String(org._id));
    const before = Number(await redis.hget(key, 'expiresAt'));
    expect(before).toBe(active.expires_at.getTime());
    await reserveScanUsage(String(org._id));
    const usedBefore = await activeUsed(String(org._id));
    expect(usedBefore).toBe(1);
    await renewSubscription(String(org._id), 'continue');
    const after = Number(await redis.hget(key, 'expiresAt'));
    expect(after).toBeGreaterThan(before);
    expect(await activeUsed(String(org._id))).toBe(1);
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
        {
          organization_id: String(org._id),
          client_scan_id: 'x',
          barcode: 'BC-x',
        },
        user,
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'NO_ACTIVE_SUBSCRIPTION',
    });
  });

  it('release never creates a stray hash and never goes negative', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 5 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const redis = getRedis();
    const key = activeSubscriptionCacheKey(String(org._id));

    // No hash anywhere -> release is a no-op, no hash materialises.
    await redis.del(key);
    await releaseScanUsage(String(org._id));
    expect(await redis.exists(key)).toBe(0);

    // Hash exists with used = 0 -> release is a no-op (never negative).
    await reserveScanUsage(String(org._id));
    await redis.hset(key, 'used', '0');
    await releaseScanUsage(String(org._id));
    expect(await redis.exists(key)).toBe(1);
    expect(await activeUsed(String(org._id))).toBe(0);

    // Hash with used = 2 -> release decrements to 1.
    await redis.hset(key, 'used', '2');
    await releaseScanUsage(String(org._id));
    expect(await activeUsed(String(org._id))).toBe(1);
  });

  it('cache write reflects scanLimit + expiresAt fields', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 77 });
    const active = await grant(String(org._id), String(plan._id), {
      trialDays: 0,
    });
    const redis = getRedis();
    const [limit, expiresAt] = await redis.hmget(
      activeSubscriptionCacheKey(String(org._id)),
      'limit',
      'expiresAt',
    );
    expect(limit).toBe('77');
    expect(Number(expiresAt)).toBe(active.expires_at.getTime());
  });
});
