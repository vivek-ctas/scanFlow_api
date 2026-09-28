import { describe, it, expect } from 'vitest';
import {
  createOrg,
  createPlan,
  grant,
  createUser,
} from './helpers.js';
import { createScan } from '../src/services/user/scans.service.js';
import { getPeriodScanCount, reconcileScanUsage } from '../src/services/quota.service.js';
import { populateActiveSubCache } from '../src/services/subscription.service.js';
import { Scan, Usage, Subscription } from '../src/models/index.js';
import { getRedis } from '../src/queues/redis.js';

const scanAs = async (organizationId: string, clientScanId?: string) => {
  const user = await createUser('OPERATOR', organizationId);
  return createScan(
    {
      organizationId,
      clientScanId: clientScanId ?? `scan-${Date.now()}-${Math.random()}`,
      barcode: `BC-${clientScanId ?? 'x'}`,
      deviceId: 'device-1',
    },
    user,
  );
};

describe('usage enforcement (§4 + §5)', () => {
  it('14. a new active subscription reports used = 0', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scanLimit: 100 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    const sub = await Subscription.findOne({ organizationId: org._id, status: 'active' });
    const usage = await Usage.findOne({ subscriptionId: sub?._id });
    expect(usage?.used ?? 0).toBe(0);
    expect(usage?.limit).toBe(100);
  });

  it('15. one scan increments the counter exactly 1', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scanLimit: 10 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await scanAs(String(org._id), 'scan-one');
    const res = await getPeriodScanCount(String(org._id), 'monthly');
    expect(res).toBe(1);
  });

  it('16. duplicate clientScanId does not consume usage', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scanLimit: 10 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await scanAs(String(org._id), 'dup');
    const second = await scanAs(String(org._id), 'dup');
    expect(second.status).toBe(200);
    const res = await getPeriodScanCount(String(org._id), 'monthly');
    expect(res).toBe(1);
    const count = await Scan.countDocuments({ organizationId: org._id });
    expect(count).toBe(1);
  });

  it('17. quota at the limit rejects the next scan', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scanLimit: 2 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const ok1 = await scanAs(String(org._id), 'a');
    const ok2 = await scanAs(String(org._id), 'b');
    expect(ok1.status).toBe(202);
    expect(ok2.status).toBe(202);
    await expect(scanAs(String(org._id), 'c')).rejects.toMatchObject({
      statusCode: 403,
      message: 'FORBIDDEN_QUOTA_EXCEEDED',
    });
  });

  it('18. concurrent scans cannot overshoot the limit (concurrency)', async () => {
    const org = await createOrg();
    const limit = 50;
    const plan = await createPlan({ scanLimit: limit });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const user = await createUser('OPERATOR', String(org._id));
    const results = await Promise.allSettled(
      Array.from({ length: 300 }, (_, i) =>
        createScan(
          {
            organizationId: String(org._id),
            clientScanId: `c-${i}`,
            barcode: `BC-${i}`,
            deviceId: 'cluster-dev',
          },
          user,
        ),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(limit);
    expect(rejected).toHaveLength(300 - limit);
    const scans = await Scan.countDocuments({ organizationId: org._id });
    expect(scans).toBe(limit);
  });

  it('22. expired subscription cannot scan', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scanLimit: 10 });
    const active = await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await Subscription.updateOne(
      { _id: active._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    await populateActiveSubCache(String(org._id));
    await expect(scanAs(String(org._id), 'x')).rejects.toMatchObject({
      statusCode: 403,
      message: 'SUBSCRIPTION_EXPIRED',
    });
  });

  it('23. a future-only subscription cannot consume usage', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B' });
    await grant(String(org._id), String(planA._id), { trialDays: 0 });
    await grant(String(org._id), String(planB._id));
    const active = await Subscription.findOne({ organizationId: org._id, status: 'active' });
    await Subscription.updateOne(
      { _id: active?._id },
      { $set: { status: 'expired', expiresAt: new Date(Date.now() - 1000) } },
    );
    const { deleteActiveSubscriptionCache } = await import(
      '../src/services/quota.service.js'
    );
    await deleteActiveSubscriptionCache(String(org._id));
    await expect(scanAs(String(org._id), 'z')).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('24. redis unreachable -> 503 and no scan is persisted', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scanLimit: 10 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const redis = getRedis();
    await redis.disconnect();
    try {
      await expect(scanAs(String(org._id), 'x')).rejects.toMatchObject({
        statusCode: 503,
      });
      const count = await Scan.countDocuments({ organizationId: org._id });
      expect(count).toBe(0);
    } finally {
      await redis.connect();
    }
  });

  it('reconcile copies the live counter into Usage.used', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scanLimit: 100 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await scanAs(String(org._id), 'r1');
    await scanAs(String(org._id), 'r2');
    await scanAs(String(org._id), 'r3');
    await reconcileScanUsage();
    const sub = await Subscription.findOne({ organizationId: org._id, status: 'active' });
    const usage = await Usage.findOne({ subscriptionId: sub?._id });
    expect(usage?.used).toBe(3);
  });
});