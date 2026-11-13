import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import {
  connectDb,
  disconnectDb,
  clearDb,
  createOrg,
  createPlan,
  createUser,
  createAdminUser,
  createOperator,
  grant,
} from './helpers.js';
import { generateAuthTokens } from '../src/services/token.service.js';
import {
  dailyUsageCacheKey,
  dailyUsageDayKey,
  nextDailyResetAt,
  readActiveSubUsage,
  releaseScanUsage,
  reserveScanUsage,
} from '../src/services/quota.service.js';
import { populateActiveSubCache } from '../src/services/subscription.service.js';
import { createScan } from '../src/services/user/scans.service.js';
import { getRedis } from '../src/queues/redis.js';
import config from '../src/config/config.js';
import {
  buildDailyQuota,
  suggestDailyLimit,
  tidyStep,
} from '../src/utils/daily-quota.util.js';
import { Organization, Scan, Subscription } from '../src/models/index.js';

// These tests hash passwords and hit Mongo/Redis over the network; a full-file
// run on a loaded machine can exceed the default 30 s per-test budget.
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const tokenFor = async (user: any) => {
  const tokens = await generateAuthTokens(user as any);
  return tokens.access_token;
};

const scanBody = (id: string) => ({
  client_scan_id: id,
  barcode: `BC-${id}`,
  barcode_type: 'ZBAR_EAN13',
  device_id: 'device-1',
});

const setupOrg = async (
  daily: number,
  scanLimit = 1000,
  extra: Record<string, any> = {},
) => {
  const org = await createOrg({ daily_scan_limit: daily, ...extra });
  const plan = await createPlan({ scan_limit: scanLimit });
  await grant(String(org._id), String(plan._id), { trialDays: 0 });
  await populateActiveSubCache(String(org._id));
  return { org, plan };
};

beforeEach(async () => {
  await connectDb();
  await clearDb();
});

afterAll(async () => {
  await disconnectDb();
});

describe('daily quota helper', () => {
  it('rounds suggestions to tidy steps', () => {
    expect(tidyStep(50)).toBe(10);
    expect(tidyStep(199)).toBe(10);
    expect(tidyStep(200)).toBe(50);
    expect(tidyStep(999)).toBe(50);
    expect(tidyStep(1000)).toBe(100);
  });

  it('suggests 2x the daily average, rounded up and capped at the cycle limit', () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    const monthEnd = new Date('2026-01-31T00:00:00.000Z');
    const quarterEnd = new Date('2026-04-01T00:00:00.000Z');

    // 3000 / 30 days * 2 = 200 -> tidy step 50 -> 200.
    expect(suggestDailyLimit(3000, start, monthEnd)).toBe(200);
    // 9000 / 90 days * 2 = 200 -> 200.
    expect(suggestDailyLimit(9000, start, quarterEnd)).toBe(200);
    // A tiny cycle limit caps the suggestion.
    expect(suggestDailyLimit(5, start, monthEnd)).toBe(5);
    // No subscription / unlimited -> no suggestion.
    expect(suggestDailyLimit(0, start, monthEnd)).toBeNull();
    expect(suggestDailyLimit(3000, null, null)).toBeNull();
  });

  it('builds the daily block with remaining, state and reset seconds', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const resetAt = new Date('2026-01-01T00:00:30.000Z');
    const base = {
      limit: 100,
      resetAt,
      timezone: 'Asia/Kolkata',
      now,
      alertThresholdPct: 90,
    };

    expect(buildDailyQuota({ ...base, limit: 0, used: 0 })).toBeNull();

    expect(buildDailyQuota({ ...base, used: 89 })).toMatchObject({
      limit: 100,
      used: 89,
      remaining: 11,
      utilization_pct: 89,
      state: 'ok',
      resets_in_seconds: 30,
    });
    expect(buildDailyQuota({ ...base, used: 90 })?.state).toBe('near_limit');
    expect(buildDailyQuota({ ...base, used: 99 })?.state).toBe('near_limit');
    expect(buildDailyQuota({ ...base, used: 100 })).toMatchObject({
      remaining: 0,
      state: 'exhausted',
    });
    expect(
      buildDailyQuota({ ...base, used: 10, suggestedLimit: 250 }),
    ).toMatchObject({ suggested_limit: 250 });
  });
});

describe('daily scan limit — organization counter', () => {
  it('does not touch the daily hash when the limit is 0 (feature off)', async () => {
    await setupOrg(0);
    const org = await Organization.findOne({});
    const orgId = String(org!._id);

    const result = await reserveScanUsage(orgId, { dailyLimit: 0 });
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.dailyApplied).toBe(false);

    const raw = await getRedis().hgetall(dailyUsageCacheKey(orgId, dailyUsageDayKey()));
    expect(raw).toEqual({});
  });

  it('enforces one organization cap across different users', async () => {
    const { org } = await setupOrg(3);
    const orgId = String(org._id);

    for (let i = 0; i < 3; i += 1) {
      const result = await reserveScanUsage(orgId, { dailyLimit: 3 });
      expect(result.status).toBe('ok');
    }
    const blocked = await reserveScanUsage(orgId, { dailyLimit: 3 });
    expect(blocked).toMatchObject({
      status: 'organization_daily_exceeded',
      orgDaily: 3,
      dailyLimit: 3,
    });
  });

  it('accepts exactly N concurrent scans with many different users', async () => {
    const { org } = await setupOrg(5);
    const orgId = String(org._id);

    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        reserveScanUsage(orgId, { dailyLimit: 5 }),
      ),
    );
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(5);
    expect(
      results.filter((r) => r.status === 'organization_daily_exceeded'),
    ).toHaveLength(20);
  });

  it('checks the cycle limit before the organization daily limit', async () => {
    const { org } = await setupOrg(5, 1);
    const orgId = String(org._id);

    expect((await reserveScanUsage(orgId, { dailyLimit: 5 })).status).toBe('ok');
    expect((await reserveScanUsage(orgId, { dailyLimit: 5 })).status).toBe(
      'quota_exceeded',
    );
  });

  it('sets the amber and limit alert flags exactly once per day', async () => {
    const { org } = await setupOrg(10);
    const orgId = String(org._id);
    const crossings: string[] = [];

    for (let i = 0; i < 10; i += 1) {
      const result = await reserveScanUsage(orgId, { dailyLimit: 10 });
      if (result.status === 'ok' && result.orgCrossing !== 'none') {
        crossings.push(result.orgCrossing);
      }
    }
    expect(crossings).toEqual(['near', 'limit']);

    const hash = await getRedis().hgetall(
      dailyUsageCacheKey(orgId, dailyUsageDayKey()),
    );
    expect(hash.a90).toBe('1');
    expect(hash.a100).toBe('1');
    expect(hash.t).toBe('10');
    // No per-user counters are written any more.
    expect(Object.keys(hash).some((key) => key.startsWith('u:'))).toBe(false);
  });

  it('releases from the original day key captured at reserve time', async () => {
    const { org } = await setupOrg(10);
    const orgId = String(org._id);
    // A day key from an earlier business day, reserved with a current
    // timestamp so the hash expiry stays in the future.
    const now = new Date();
    const dayKey = dailyUsageDayKey(new Date(now.getTime() - 86400000));

    const result = await reserveScanUsage(orgId, {
      dailyLimit: 10,
      dayKey,
      now,
    });
    expect(result.status).toBe('ok');
    expect(
      await getRedis().hget(dailyUsageCacheKey(orgId, dayKey), 't'),
    ).toBe('1');

    await releaseScanUsage(orgId, dayKey, true);
    expect(
      await getRedis().hget(dailyUsageCacheKey(orgId, dayKey), 't'),
    ).toBe('0');
  });
});

describe('daily scan limit — HTTP surface', () => {
  it('returns 403 with reset_at and timezone details on the single-scan endpoint', async () => {
    const { org } = await setupOrg(1);
    const user = await createUser('OPERATOR', String(org._id));
    const token = await tokenFor(user);

    const first = await request(app)
      .post('/api/scans')
      .set('authorization', `Bearer ${token}`)
      .send(scanBody('one'));
    expect(first.status).toBe(202);

    const second = await request(app)
      .post('/api/scans')
      .set('authorization', `Bearer ${token}`)
      .send(scanBody('two'));

    expect(second.status).toBe(403);
    expect(second.body.message).toBe('FORBIDDEN_DAILY_LIMIT_EXCEEDED');
    expect(second.body.details).toMatchObject({
      timezone: config.dailyLimit.timezone,
    });
    expect(new Date(second.body.details.reset_at).getTime()).toBe(
      nextDailyResetAt().getTime(),
    );
  });

  it('replays a saved scan as duplicate even when the daily limit is reached', async () => {
    const { org } = await setupOrg(1);
    const user = await createUser('OPERATOR', String(org._id));

    const first = await createScan(scanBody('replay'), user);
    expect(first.status).toBe(202);

    const replay = await createScan(scanBody('replay'), user);
    expect(replay.status).toBe(200);
    expect(replay.data?.created).toBe(false);
    expect(await Scan.countDocuments({ organization_id: org._id })).toBe(1);
  });

  it('returns the shared usage snapshot and short-circuits a batch', async () => {
    const { org } = await setupOrg(2);
    const user = await createUser('OPERATOR', String(org._id));
    const token = await tokenFor(user);

    const res = await request(app)
      .post('/api/scans/batch')
      .set('authorization', `Bearer ${token}`)
      .send({ scans: [scanBody('b1'), scanBody('b2'), scanBody('b3'), scanBody('b4')] });

    expect(res.status).toBe(200);
    expect(res.body.data.results.map((r: any) => r.status)).toEqual([
      'accepted',
      'accepted',
      'daily_limit_exceeded',
      'daily_limit_exceeded',
    ]);
    expect(res.body.data.usage).toMatchObject({
      used: 2,
      limit: 2,
      timezone: config.dailyLimit.timezone,
    });
    expect(res.body.data.results.every((r: any) => r.usage === undefined)).toBe(
      true,
    );
    expect(res.body.data.results[2].reset_at).toBeTruthy();
  });

  it('does not include data.usage when the organization limit is 0', async () => {
    const { org } = await setupOrg(0);
    const user = await createUser('OPERATOR', String(org._id));
    const token = await tokenFor(user);

    const res = await request(app)
      .post('/api/scans/batch')
      .set('authorization', `Bearer ${token}`)
      .send({ scans: [scanBody('f1')] });

    expect(res.status).toBe(200);
    expect(res.body.data.usage).toBeUndefined();
  });

  it('has no operator daily endpoint and no operator daily fields', async () => {
    const { org } = await setupOrg(5);
    const operator = await createOperator(String(org._id));
    await createScan(scanBody('op-1'), operator);
    const admin = await createUser('ORGANIZATION_ADMIN', String(org._id));
    const token = await tokenFor(admin);

    const retired = await request(app)
      .get('/api/scans/daily-usage')
      .set('authorization', `Bearer ${await tokenFor(operator)}`);
    expect(retired.status).toBe(404);

    const list = await request(app)
      .get('/api/operators')
      .set('authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    for (const row of list.body.data.results) {
      expect(row.daily_scan_limit).toBeUndefined();
      expect(row.daily_scan_used).toBeUndefined();
      expect(row.effective_daily_limit).toBeUndefined();
      expect(row.daily_limit_source).toBeUndefined();
    }
  });
});

describe('daily scan limit — organization write path', () => {
  it('lets only a super admin set the organization limit', async () => {
    const { org } = await setupOrg(0);
    const superAdmin = await createAdminUser();
    const superToken = await tokenFor(superAdmin);

    const updated = await request(app)
      .put(`/api/organizations/${org._id}`)
      .set('authorization', `Bearer ${superToken}`)
      .send({ daily_scan_limit: 50 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.organization.daily_scan_limit).toBe(50);

    const refreshed = await Organization.findById(org._id);
    expect(refreshed?.daily_scan_limit).toBe(50);

    const orgAdmin = await createUser('ORGANIZATION_ADMIN', String(org._id));
    const denied = await request(app)
      .put(`/api/organizations/${org._id}`)
      .set('authorization', `Bearer ${await tokenFor(orgAdmin)}`)
      .send({ daily_scan_limit: 10 });
    expect(denied.status).toBe(403);
  });

  it('rejects a daily limit above the active cycle limit and non-integers', async () => {
    const { org } = await setupOrg(0, 100);
    const superToken = await tokenFor(await createAdminUser());

    const tooHigh = await request(app)
      .put(`/api/organizations/${org._id}`)
      .set('authorization', `Bearer ${superToken}`)
      .send({ daily_scan_limit: 101 });
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.body.message).toContain('less than or equal');

    const negative = await request(app)
      .put(`/api/organizations/${org._id}`)
      .set('authorization', `Bearer ${superToken}`)
      .send({ daily_scan_limit: -1 });
    expect(negative.status).toBe(400);

    const fractional = await request(app)
      .put(`/api/organizations/${org._id}`)
      .set('authorization', `Bearer ${superToken}`)
      .send({ daily_scan_limit: 1.5 });
    expect(fractional.status).toBe(400);
  });

  it('accepts a limit on organization creation and returns it in details', async () => {
    const plan = await createPlan({ scan_limit: 100 });
    const superToken = await tokenFor(await createAdminUser());
    const email = `org-${Date.now()}@example.com`;

    const created = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${superToken}`)
      .send({
        first_name: 'Org',
        last_name: 'Admin',
        company_name: 'Daily Org',
        email,
        plan_id: String(plan._id),
        billing_cycle: 'month',
        daily_scan_limit: 25,
      });
    expect(created.status).toBe(201);
    expect(created.body.data.organization.daily_scan_limit).toBe(25);

    const details = await request(app)
      .get(`/api/organizations/${created.body.data.organization.id}`)
      .set('authorization', `Bearer ${superToken}`);
    expect(details.status).toBe(200);
    expect(details.body.data.organization.daily_scan_limit).toBe(25);
  });

  it('rejects the removed operator daily field instead of accepting it', async () => {
    const { org } = await setupOrg(0);
    const admin = await createUser('ORGANIZATION_ADMIN', String(org._id));
    const token = await tokenFor(admin);

    const create = await request(app)
      .post('/api/operators')
      .set('authorization', `Bearer ${token}`)
      .send({
        first_name: 'Sneaky',
        last_name: 'Op',
        pin: '123456',
        role: 'OPERATOR',
        organization_id: String(org._id),
        daily_scan_limit: 9,
      });
    expect(create.status).toBe(400);

    const operator = await createOperator(String(org._id));
    const update = await request(app)
      .put(`/api/operators/${operator._id}`)
      .set('authorization', `Bearer ${token}`)
      .send({ daily_scan_limit: 9 });
    expect(update.status).toBe(400);
  });
});

describe('daily scan limit — dashboard surface', () => {
  it('returns the organization daily block from the organization document', async () => {
    const { org } = await setupOrg(10);
    const operator = await createUser('OPERATOR', String(org._id));
    await createScan(scanBody('q-1'), operator);
    const admin = await createUser('ORGANIZATION_ADMIN', String(org._id));

    const res = await request(app)
      .get('/api/org-dashboard/quota')
      .query({ organization_id: String(org._id) })
      .set('authorization', `Bearer ${await tokenFor(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.daily).toMatchObject({
      limit: 10,
      used: 1,
      remaining: 9,
      utilization_pct: 10,
      state: 'ok',
      timezone: config.dailyLimit.timezone,
    });
    expect(res.body.data.daily.reset_at).toBeTruthy();
    expect(typeof res.body.data.daily.resets_in_seconds).toBe('number');
    // Never leak the super-admin-only hint to an organization admin.
    expect(res.body.data.daily.suggested_limit).toBeUndefined();
  });

  it('returns a null daily block when the organization limit is 0', async () => {
    const { org } = await setupOrg(0);
    const admin = await createUser('ORGANIZATION_ADMIN', String(org._id));

    const res = await request(app)
      .get('/api/org-dashboard/quota')
      .query({ organization_id: String(org._id) })
      .set('authorization', `Bearer ${await tokenFor(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.daily).toBeNull();
  });

  it('adds suggested_limit for super admins only', async () => {
    const { org } = await setupOrg(200, 3000);
    const superToken = await tokenFor(await createAdminUser());

    const res = await request(app)
      .get('/api/org-dashboard/quota')
      .query({ organization_id: String(org._id) })
      .set('authorization', `Bearer ${superToken}`);

    expect(res.status).toBe(200);
    // 3000 over a 30-day cycle -> 200/day suggestion.
    expect(res.body.data.daily.suggested_limit).toBe(200);
  });

  it('keeps the daily limit as the scan-trend reference line', async () => {
    const { org } = await setupOrg(40);
    const admin = await createUser('ORGANIZATION_ADMIN', String(org._id));

    const res = await request(app)
      .get('/api/org-dashboard/scan-trend')
      .query({ organization_id: String(org._id), range: '7d' })
      .set('authorization', `Bearer ${await tokenFor(admin)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.daily_limit).toBe(40);
  });

  it('emits daily_limit_near and daily_limit_reached attention items', async () => {
    const { org } = await setupOrg(10);
    const operator = await createUser('OPERATOR', String(org._id));
    for (let i = 0; i < 9; i += 1) {
      await createScan(scanBody(`near-${i}`), operator);
    }
    const admin = await createUser('ORGANIZATION_ADMIN', String(org._id));
    const res = await request(app)
      .get('/api/org-dashboard/attention')
      .query({ organization_id: String(org._id) })
      .set('authorization', `Bearer ${await tokenFor(admin)}`);

    expect(res.status).toBe(200);
    const item = res.body.data.items.find(
      (row: any) => row.type === 'daily_limit_near',
    );
    expect(item).toMatchObject({
      severity: 'warning',
      data: {
        used: 9,
        limit: 10,
        utilization_pct: 90,
        timezone: config.dailyLimit.timezone,
      },
    });
  });
});

describe('daily scan limit — plans and subscriptions are commercial only', () => {
  it('rejects a plan payload that still carries daily_scan_limit', async () => {
    const token = await tokenFor(await createAdminUser());
    const res = await request(app)
      .post('/api/plans')
      .set('authorization', `Bearer ${token}`)
      .send({
        name: `No Daily Plan ${Date.now()}`,
        price: 10,
        billing_cycle: 'month',
        features: [{ features_name: 'scan', scan_limit: 10, daily_scan_limit: 3 }],
      });
    expect(res.status).toBe(400);
  });

  it('returns no daily field in plan or subscription payloads', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);

    const created = await request(app)
      .post('/api/plans')
      .set('authorization', `Bearer ${token}`)
      .send({
        name: `Clean Plan ${Date.now()}`,
        price: 10,
        billing_cycle: 'month',
        features: [{ features_name: 'scan', scan_limit: 10 }],
      });
    expect(created.status).toBe(201);
    expect(created.body.data.plan.features[0]).not.toHaveProperty(
      'daily_scan_limit',
    );

    const { org } = await setupOrg(0);
    const subRes = await request(app)
      .get(`/api/organizations/${org._id}/subscription`)
      .set('authorization', `Bearer ${token}`);

    expect(subRes.status).toBe(200);
    expect(
      subRes.body.data.activeSubscription.features[0],
    ).not.toHaveProperty('daily_scan_limit');
  });

  it('keeps the active-subscription cache free of a daily field', async () => {
    const { org } = await setupOrg(50);
    const cache = await readActiveSubUsage(String(org._id));
    expect(cache).toMatchObject({ scanLimit: 1000 });
    expect(cache).not.toHaveProperty('dailyLimit');
    const raw = await getRedis().hgetall(
      `org:${String(org._id)}:activeSub`,
    );
    expect(raw.daily_limit).toBeUndefined();
  });
});
