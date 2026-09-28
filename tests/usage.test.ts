import { describe, it, expect } from 'vitest';
import {
  createOrg,
  createPlan,
  grant,
  createUser,
  activeUsed,
} from './helpers.js';
import { createScan } from '../src/services/user/scans.service.js';
import {
  reconcileScanUsage,
  readActiveSubUsage,
} from '../src/services/quota.service.js';
import { populateActiveSubCache } from '../src/services/subscription.service.js';
import { Scan, Usage, Subscription } from '../src/models/index.js';
import { getRedis } from '../src/queues/redis.js';

const scanAs = async (organizationId: string, clientScanId?: string) => {
  const user = await createUser('OPERATOR', organizationId);
  return createScan(
    {
      organization_id: organizationId,
      client_scan_id: clientScanId ?? `scan-${Date.now()}-${Math.random()}`,
      barcode: `BC-${clientScanId ?? 'x'}`,
      device_id: 'device-1',
    },
    user,
  );
};

describe('usage enforcement (§4 + §5)', () => {
  it('14. a new active subscription reports used = 0', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 100 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    const sub = await Subscription.findOne({
      organization_id: org._id,
      status: 'active',
    });
    const usage = await Usage.findOne({ subscription_id: sub?._id });
    expect(usage?.usage ?? 0).toBe(0);
    expect(usage?.scan_limit).toBe(100);
  });

  it('15. one scan increments the counter exactly 1', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 10 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await scanAs(String(org._id), 'scan-one');
    expect(await activeUsed(String(org._id))).toBe(1);
  });

  it('16. duplicate clientScanId does not consume usage', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 10 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await scanAs(String(org._id), 'dup');
    const second = await scanAs(String(org._id), 'dup');
    expect(second.status).toBe(200);
    expect(await activeUsed(String(org._id))).toBe(1);
    const count = await Scan.countDocuments({ organization_id: org._id });
    expect(count).toBe(1);
  });

  it('17. quota at the limit rejects the next scan', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 2 });
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
    const plan = await createPlan({ scan_limit: limit });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const user = await createUser('OPERATOR', String(org._id));
    const results = await Promise.allSettled(
      Array.from({ length: 300 }, (_, i) =>
        createScan(
          {
            organization_id: String(org._id),
            client_scan_id: `c-${i}`,
            barcode: `BC-${i}`,
            device_id: 'cluster-dev',
          },
          user,
        ),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(limit);
    expect(rejected).toHaveLength(300 - limit);
    const scans = await Scan.countDocuments({ organization_id: org._id });
    expect(scans).toBe(limit);
  });

  it('22. expired subscription cannot scan', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 10 });
    const active = await grant(String(org._id), String(plan._id), {
      trialDays: 0,
    });
    await Subscription.updateOne(
      { _id: active._id },
      { $set: { expires_at: new Date(Date.now() - 1000) } },
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
    const active = await Subscription.findOne({
      organization_id: org._id,
      status: 'active',
    });
    await Subscription.updateOne(
      { _id: active?._id },
      { $set: { status: 'expired', expires_at: new Date(Date.now() - 1000) } },
    );
    const { deleteActiveSubscriptionCache } =
      await import('../src/services/quota.service.js');
    await deleteActiveSubscriptionCache(String(org._id));
    await expect(scanAs(String(org._id), 'z')).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('24. redis unreachable -> 503 and no scan is persisted', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 10 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const redis = getRedis();
    await redis.disconnect();
    try {
      await expect(scanAs(String(org._id), 'x')).rejects.toMatchObject({
        statusCode: 503,
      });
      const count = await Scan.countDocuments({ organization_id: org._id });
      expect(count).toBe(0);
    } finally {
      await redis.connect();
    }
  });

  it('reconcile copies the live counter into Usage.usage', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 100 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await scanAs(String(org._id), 'r1');
    await scanAs(String(org._id), 'r2');
    await scanAs(String(org._id), 'r3');
    await reconcileScanUsage();
    const sub = await Subscription.findOne({
      organization_id: org._id,
      status: 'active',
    });
    const usage = await Usage.findOne({ subscription_id: sub?._id });
    expect(usage?.usage).toBe(3);
  });

  it('limit 0 is unlimited (plan convention)', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 0 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await scanAs(String(org._id), 'u1');
    await scanAs(String(org._id), 'u2');
    const sub = await Subscription.findOne({
      organization_id: org._id,
      status: 'active',
    });
    const cache = await readActiveSubUsage(String(org._id), sub as any);
    expect(cache?.used).toBe(2);
  });
});
