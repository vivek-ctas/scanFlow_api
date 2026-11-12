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
  activeSubscriptionCacheKey,
  dailyUsageCacheKey,
  dailyUsageDayKey,
  nextDailyResetAt,
  readActiveSubUsage,
  releaseScanUsage,
  reserveScanUsage,
} from '../src/services/quota.service.js';
import {
  populateActiveSubCache,
  adjustScanLimits,
} from '../src/services/subscription.service.js';
import { updatePlanById } from '../src/services/admin/plans.service.js';
import { createScan } from '../src/services/user/scans.service.js';
import { getRedis } from '../src/queues/redis.js';
import {
  dispatchAppNotification,
  enqueueDailyQuotaAlert,
  getNotificationQueue,
  type DailyQuotaAlertJob,
} from '../src/queues/notification.queue.js';
import config from '../src/config/config.js';
import {
  dailyScanLimitOf,
  scanLimitOf,
} from '../src/utils/plan-features.util.js';
import { Notification, Scan, Subscription, User } from '../src/models/index.js';

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

const reserveFor = (
  organizationId: string,
  user: { _id: any; daily_scan_limit?: number },
  overrides: Record<string, any> = {},
) =>
  reserveScanUsage(organizationId, {
    userId: String(user._id),
    userCap: user.daily_scan_limit ?? 0,
    ...overrides,
  });

beforeEach(async () => {
  await connectDb();
  await clearDb();
});

afterAll(async () => {
  await disconnectDb();
});

describe('daily scan limit — cache and snapshots', () => {
  it('uses the same exact-name, first-match rule as scanLimitOf', () => {
    const features = [
      { features_name: 'scan_extra', scan_limit: 99, daily_scan_limit: 9 },
      { features_name: 'scan', scan_limit: 10, daily_scan_limit: 3 },
      { features_name: 'scan', scan_limit: 20, daily_scan_limit: 7 },
    ];
    expect(scanLimitOf(features)).toBe(10);
    expect(dailyScanLimitOf(features)).toBe(3);
    // Missing `scan` entry or missing daily field reads as 0 (feature off).
    expect(dailyScanLimitOf([{ features_name: 'other', scan_limit: 5 }])).toBe(
      0,
    );
    expect(dailyScanLimitOf([{ features_name: 'scan', scan_limit: 5 }])).toBe(
      0,
    );
  });

  it('writes and reads daily_limit in the active-subscription hash (HMGET)', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 10, daily_scan_limit: 5 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));

    const cache = await readActiveSubUsage(String(org._id), {} as any);
    expect(cache?.scanLimit).toBe(10);
    expect(cache?.dailyLimit).toBe(5);
  });

  it('reads a missing daily_limit field as 0 (old cache hash)', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 10, daily_scan_limit: 5 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    const redis = getRedis();
    await redis.hdel(
      activeSubscriptionCacheKey(String(org._id)),
      'daily_limit',
    );

    const cache = await readActiveSubUsage(String(org._id), {} as any);
    expect(cache?.dailyLimit).toBe(0);
  });

  it('does not propagate a plan edit to an existing subscription snapshot', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 10, daily_scan_limit: 5 });
    const sub = await grant(String(org._id), String(plan._id), {
      trialDays: 0,
    });
    await populateActiveSubCache(String(org._id));

    await updatePlanById(String(plan._id), {
      features: [
        { features_name: 'scan', scan_limit: 10, daily_scan_limit: 1 },
      ],
    });

    const fresh = await Subscription.findById(sub._id);
    expect(fresh?.features?.[0]?.daily_scan_limit).toBe(5);
    const cache = await readActiveSubUsage(String(org._id), {} as any);
    expect(cache?.dailyLimit).toBe(5);
  });

  it('adjustScanLimits refreshes the cached daily_limit from the snapshot', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 10, daily_scan_limit: 5 });
    const sub = await grant(String(org._id), String(plan._id), {
      trialDays: 0,
    });
    await populateActiveSubCache(String(org._id));

    const result = await adjustScanLimits(String(org._id), String(sub._id), [
      { delta: 2 },
    ]);
    expect(result.data?.scan_limit).toBe(12);

    const cache = await readActiveSubUsage(String(org._id), {} as any);
    expect(cache?.scanLimit).toBe(12);
    // The daily cap follows the same rule: it is refreshed from the snapshot,
    // not derived from the cycle adjustment.
    expect(cache?.dailyLimit).toBe(5);
  });
});

describe('daily scan limit — reserve script', () => {
  it('does not touch the daily hash when both caps are 0 (feature off)', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 10, daily_scan_limit: 0 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    const user = await createUser('OPERATOR', String(org._id));

    const result = await reserveFor(String(org._id), user);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.dailyApplied).toBe(false);
    }

    const redis = getRedis();
    const dayKey = dailyUsageDayKey();
    expect(
      await redis.exists(dailyUsageCacheKey(String(org._id), dayKey)),
    ).toBe(0);
  });

  it('enforces the organization daily cap before the operator cap', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 100, daily_scan_limit: 2 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    const user = await createUser('OPERATOR', String(org._id), {
      daily_scan_limit: 50,
    });

    expect((await reserveFor(String(org._id), user)).status).toBe('ok');
    expect((await reserveFor(String(org._id), user)).status).toBe('ok');
    const third = await reserveFor(String(org._id), user);
    expect(third.status).toBe('organization_daily_exceeded');
    if (third.status === 'organization_daily_exceeded') {
      expect(third.orgDaily).toBe(2);
      expect(third.dailyLimit).toBe(2);
    }

    const redis = getRedis();
    const dayKey = dailyUsageDayKey();
    expect(
      await redis.hget(dailyUsageCacheKey(String(org._id), dayKey), 't'),
    ).toBe('2');
  });

  it('enforces the operator cap independently of the organization total', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 100, daily_scan_limit: 0 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    const capped = await createUser('OPERATOR', String(org._id), {
      daily_scan_limit: 2,
    });
    const other = await createUser('OPERATOR', String(org._id));

    expect((await reserveFor(String(org._id), capped)).status).toBe('ok');
    expect((await reserveFor(String(org._id), capped)).status).toBe('ok');
    const third = await reserveFor(String(org._id), capped);
    expect(third.status).toBe('operator_daily_exceeded');
    if (third.status === 'operator_daily_exceeded') {
      expect(third.userDaily).toBe(2);
      expect(third.userCap).toBe(2);
    }
    // A different operator is unaffected by the first operator's cap.
    expect((await reserveFor(String(org._id), other)).status).toBe('ok');
  });

  it('applies the daily cap even when the cycle limit is unlimited', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 0, daily_scan_limit: 1 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    const user = await createUser('OPERATOR', String(org._id));

    expect((await reserveFor(String(org._id), user)).status).toBe('ok');
    expect((await reserveFor(String(org._id), user)).status).toBe(
      'organization_daily_exceeded',
    );
  });

  it('releases both the cycle and daily counters from the original day key', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 100, daily_scan_limit: 5 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    const user = await createUser('OPERATOR', String(org._id));
    const dayKey = dailyUsageDayKey();

    const first = await reserveFor(String(org._id), user, { dayKey });
    expect(first.status).toBe('ok');
    await releaseScanUsage(
      String(org._id),
      dayKey,
      String(user._id),
      first.status === 'ok' && first.dailyApplied,
    );

    const redis = getRedis();
    const cache = await readActiveSubUsage(String(org._id), {} as any);
    expect(cache?.used).toBe(0);
    expect(
      Number(
        (await redis.hget(dailyUsageCacheKey(String(org._id), dayKey), 't')) ??
          0,
      ),
    ).toBe(0);
    expect(
      Number(
        (await redis.hget(
          dailyUsageCacheKey(String(org._id), dayKey),
          `u:${String(user._id)}`,
        )) ?? 0,
      ),
    ).toBe(0);
  });

  it('set the 90% and 100% alert flags exactly once per day', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 100, daily_scan_limit: 10 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    const user = await createUser('OPERATOR', String(org._id));

    let crossing: string = 'none';
    for (let i = 0; i < 9; i += 1) {
      const result = await reserveFor(String(org._id), user);
      expect(result.status).toBe('ok');
      if (result.status === 'ok' && result.orgCrossing !== 'none') {
        crossing = result.orgCrossing;
      }
    }
    expect(crossing).toBe('near');

    const tenth = await reserveFor(String(org._id), user);
    expect(tenth.status).toBe('ok');
    if (tenth.status === 'ok') expect(tenth.orgCrossing).toBe('limit');

    const redis = getRedis();
    const dayKey = dailyUsageDayKey();
    const key = dailyUsageCacheKey(String(org._id), dayKey);
    expect(await redis.hget(key, 'a90')).toBe('1');
    expect(await redis.hget(key, 'a100')).toBe('1');

    // Releasing and re-incrementing must not report the crossing again.
    await releaseScanUsage(
      String(org._id),
      dayKey,
      String(user._id),
      tenth.status === 'ok' && tenth.dailyApplied,
    );
    const re = await reserveFor(String(org._id), user);
    expect(re.status).toBe('ok');
    if (re.status === 'ok') expect(re.orgCrossing).toBe('none');
  });

  it('accepts exactly N concurrent scans at the daily cap', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 100, daily_scan_limit: 5 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    const user = await createUser('OPERATOR', String(org._id));

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        createScan(scanBody(`daily-${i}`), user),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(15);
    expect(
      rejected.every(
        (r) => (r.reason as any)?.message === 'FORBIDDEN_DAILY_LIMIT_EXCEEDED',
      ),
    ).toBe(true);
  });
});

describe('daily scan limit — HTTP surface', () => {
  it('returns 403 with reset_at and timezone details on the single-scan endpoint', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 100, daily_scan_limit: 1 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
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

  it('replays a saved scan as duplicate even when the daily cap is now reached', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 100, daily_scan_limit: 1 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    const user = await createUser('OPERATOR', String(org._id));

    const first = await createScan(scanBody('replay'), user);
    expect(first.status).toBe(202);

    const replay = await createScan(scanBody('replay'), user);
    expect(replay.status).toBe(200);
    expect(replay.data?.created).toBe(false);
    expect(await Scan.countDocuments({ organization_id: org._id })).toBe(1);
  });

  it('returns the top-level data.usage snapshot and daily statuses for a batch', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 100, daily_scan_limit: 2 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    const user = await createUser('OPERATOR', String(org._id));
    const token = await tokenFor(user);

    const res = await request(app)
      .post('/api/scans/batch')
      .set('authorization', `Bearer ${token}`)
      .send({
        scans: [scanBody('b1'), scanBody('b2'), scanBody('b3'), scanBody('b4')],
      });

    expect(res.status).toBe(200);
    expect(
      res.body.data.results.filter((r: any) => r.status === 'accepted'),
    ).toHaveLength(2);
    expect(
      res.body.data.results.filter(
        (r: any) => r.status === 'daily_limit_exceeded',
      ),
    ).toHaveLength(2);
    // Usage is one top-level object, not repeated per item.
    expect(res.body.data.usage).toMatchObject({
      used: 2,
      limit: 0,
      timezone: config.dailyLimit.timezone,
    });
    expect(res.body.data.usage.reset_at).toBeTruthy();
    expect(res.body.data.results.every((r: any) => r.usage === undefined)).toBe(
      true,
    );
  });

  it('reports operator_daily_limit_exceeded and the operator usage snapshot', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 100, daily_scan_limit: 0 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    const operator = await createOperator(String(org._id), {
      daily_scan_limit: 2,
    });
    const token = await tokenFor(operator);

    const res = await request(app)
      .post('/api/scans/batch')
      .set('authorization', `Bearer ${token}`)
      .send({ scans: [scanBody('o1'), scanBody('o2'), scanBody('o3')] });

    expect(res.status).toBe(200);
    expect(res.body.data.results.map((r: any) => r.status)).toEqual([
      'accepted',
      'accepted',
      'operator_daily_limit_exceeded',
    ]);
    expect(res.body.data.usage).toMatchObject({ used: 2, limit: 2 });
    expect(res.body.data.results[2].reset_at).toBeTruthy();
  });

  it('does not include data.usage when no daily cap applies (feature off)', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 100, daily_scan_limit: 0 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    const user = await createUser('OPERATOR', String(org._id));
    const token = await tokenFor(user);

    const res = await request(app)
      .post('/api/scans/batch')
      .set('authorization', `Bearer ${token}`)
      .send({ scans: [scanBody('f1')] });

    expect(res.status).toBe(200);
    expect(res.body.data.usage).toBeUndefined();
  });
});

describe('daily scan limit — write rights', () => {
  it('rejects daily_scan_limit through the self-profile endpoint', async () => {
    const org = await createOrg();
    const operator = await createOperator(String(org._id));
    const token = await tokenFor(operator);

    const res = await request(app)
      .patch('/api/auth/me')
      .set('authorization', `Bearer ${token}`)
      .send({ daily_scan_limit: 999 });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('"daily_scan_limit" is not allowed');
  });

  it('rejects operator write endpoints for an operator role (self or others)', async () => {
    const org = await createOrg();
    const operator = await createOperator(String(org._id));
    const token = await tokenFor(operator);

    const self = await request(app)
      .put(`/api/operators/${operator._id}`)
      .set('authorization', `Bearer ${token}`)
      .send({ daily_scan_limit: 999 });
    expect(self.status).toBe(403);

    const create = await request(app)
      .post('/api/operators')
      .set('authorization', `Bearer ${token}`)
      .send({
        first_name: 'Sneaky',
        last_name: 'Op',
        pin: '123456',
        organization_id: String(org._id),
        daily_scan_limit: 999,
      });
    expect(create.status).toBe(403);
  });

  it('lets an org admin set daily limits only for operators of their own organization', async () => {
    const orgA = await createOrg({ company_name: 'Org A' });
    const orgB = await createOrg({ company_name: 'Org B' });
    const adminA = await createUser('ORGANIZATION_ADMIN', String(orgA._id));
    const token = await tokenFor(adminA);
    const opA = await createOperator(String(orgA._id));
    const opB = await createOperator(String(orgB._id));

    const created = await request(app)
      .post('/api/operators')
      .set('authorization', `Bearer ${token}`)
      .send({
        first_name: 'New',
        last_name: 'Operator',
        pin: '123456',
        role: 'OPERATOR',
        organization_id: String(orgA._id),
        daily_scan_limit: 3,
      });
    expect(created.status).toBe(201);
    expect(created.body.data.user.daily_scan_limit).toBe(3);

    const updated = await request(app)
      .put(`/api/operators/${opA._id}`)
      .set('authorization', `Bearer ${token}`)
      .send({ daily_scan_limit: 7 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.user.daily_scan_limit).toBe(7);

    const foreign = await request(app)
      .put(`/api/operators/${opB._id}`)
      .set('authorization', `Bearer ${token}`)
      .send({ daily_scan_limit: 9 });
    expect(foreign.status).toBe(404);
    expect((await User.findById(opB._id))?.daily_scan_limit).toBe(0);
  });

  it('rejects a plan whose daily limit exceeds the cycle limit', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);

    const res = await request(app)
      .post('/api/plans')
      .set('authorization', `Bearer ${token}`)
      .send({
        name: `Daily Plan ${Date.now()}`,
        price: 10,
        billing_cycle: 'month',
        features: [
          { features_name: 'scan', scan_limit: 100, daily_scan_limit: 101 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain(
      'daily_scan_limit" must be less than or equal to "scan_limit',
    );
  });
});

describe('daily scan limit — Phase 2 surface', () => {
  const setupOrg = async (daily: number, scanLimit = 1000) => {
    const org = await createOrg();
    const plan = await createPlan({
      scan_limit: scanLimit,
      daily_scan_limit: daily,
    });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    return { org, plan };
  };

  it('returns only the caller’s own numbers from GET /scans/daily-usage', async () => {
    const { org } = await setupOrg(0);
    const operator = await createUser('OPERATOR', String(org._id), {
      daily_scan_limit: 2,
    });
    const token = await tokenFor(operator);
    await createScan(scanBody('du-1'), operator);

    const res = await request(app)
      .get('/api/scans/daily-usage')
      .set('authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual([
      'limit',
      'org_blocked',
      'reset_at',
      'timezone',
      'used',
    ]);
    expect(res.body.data).toMatchObject({
      limit: 2,
      used: 1,
      org_blocked: false,
      timezone: config.dailyLimit.timezone,
    });
    expect(new Date(res.body.data.reset_at).getTime()).toBe(
      nextDailyResetAt().getTime(),
    );
  });

  it('reports org_blocked without leaking the organization limit or total', async () => {
    const { org } = await setupOrg(2);
    const first = await createUser('OPERATOR', String(org._id));
    const second = await createUser('OPERATOR', String(org._id));
    await createScan(scanBody('blk-1'), first);
    await createScan(scanBody('blk-2'), first);

    const firstToken = await tokenFor(first);
    const firstRes = await request(app)
      .get('/api/scans/daily-usage')
      .set('authorization', `Bearer ${firstToken}`);

    expect(firstRes.status).toBe(200);
    expect(firstRes.body.data).toMatchObject({
      limit: 0,
      used: 2,
      org_blocked: true,
    });
    // No organization limit/total leaks through the endpoint.
    expect(firstRes.body.data.org_limit).toBeUndefined();
    expect(firstRes.body.data.org_used).toBeUndefined();
    expect(firstRes.body.data.scan_limit).toBeUndefined();

    // A second operator has their own counter (1) but is also blocked by the org.
    const secondToken = await tokenFor(second);
    const secondRes = await request(app)
      .get('/api/scans/daily-usage')
      .set('authorization', `Bearer ${secondToken}`);
    expect(secondRes.body.data).toMatchObject({
      limit: 0,
      used: 0,
      org_blocked: true,
    });
  });

  it('adds daily usage to the operators list, scoped per organization', async () => {
    const { org: orgA } = await setupOrg(50);
    const { org: orgB } = await setupOrg(50);

    const opA1 = await createOperator(String(orgA._id), {
      daily_scan_limit: 4,
    });
    const opA2 = await createOperator(String(orgA._id));
    const opB = await createOperator(String(orgB._id));
    await createScan(scanBody('op-a-1'), opA1);
    await createScan(scanBody('op-a-2'), opA1);
    await createScan(scanBody('op-a-3'), opA2);
    await createScan(scanBody('op-b-1'), opB);

    // Organization admin: own operators only, correct per-row usage.
    const adminA = await createUser('ORGANIZATION_ADMIN', String(orgA._id));
    const adminToken = await tokenFor(adminA);
    const ownRes = await request(app)
      .get('/api/operators')
      .set('authorization', `Bearer ${adminToken}`);

    expect(ownRes.status).toBe(200);
    const ownRows = new Map(
      ownRes.body.data.results.map((row: any) => [row.id, row]),
    );
    // The list includes the organization admin themselves plus their operators.
    expect(ownRows.size).toBe(3);
    expect(ownRows.has(String(opB._id))).toBe(false);
    expect(ownRows.get(String(adminA._id))).toMatchObject({
      daily_scan_limit: 0,
      daily_scan_used: 0,
    });
    expect(ownRows.get(String(opA1._id))).toMatchObject({
      daily_scan_limit: 4,
      daily_scan_used: 2,
    });
    expect(ownRows.get(String(opA2._id))).toMatchObject({
      daily_scan_limit: 0,
      daily_scan_used: 1,
    });

    // Super admin: cross-org page reads each organization's own day hash.
    const superAdmin = await createAdminUser();
    const superToken = await tokenFor(superAdmin);
    const allRes = await request(app)
      .get('/api/operators')
      .set('authorization', `Bearer ${superToken}`);

    expect(allRes.status).toBe(200);
    const allRows = new Map(
      allRes.body.data.results.map((row: any) => [row.id, row]),
    );
    expect(allRows.get(String(opA1._id))?.daily_scan_used).toBe(2);
    expect(allRows.get(String(opA2._id))?.daily_scan_used).toBe(1);
    expect(allRows.get(String(opB._id))?.daily_scan_used).toBe(1);
  });

  it('returns a null daily block when no daily limit is configured', async () => {
    const { org } = await setupOrg(0);
    const admin = await createUser('ORGANIZATION_ADMIN', String(org._id));
    const token = await tokenFor(admin);

    const res = await request(app)
      .get('/api/org-dashboard/quota')
      .query({ organization_id: String(org._id) })
      .set('authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.daily).toBeNull();
  });

  it('returns the daily quota block with limit, usage, state and reset', async () => {
    const { org } = await setupOrg(10);
    const operator = await createUser('OPERATOR', String(org._id));
    await createScan(scanBody('q-1'), operator);
    const admin = await createUser('ORGANIZATION_ADMIN', String(org._id));
    const token = await tokenFor(admin);

    const res = await request(app)
      .get('/api/org-dashboard/quota')
      .query({ organization_id: String(org._id) })
      .set('authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.daily).toMatchObject({
      limit: 10,
      used: 1,
      remaining: 9,
      utilization_pct: 10,
      state: 'ok',
      timezone: config.dailyLimit.timezone,
    });
    expect(new Date(res.body.data.daily.reset_at).getTime()).toBe(
      nextDailyResetAt().getTime(),
    );
  });

  it('emits daily_limit_near and daily_limit_reached attention items', async () => {
    const near = await setupOrg(10);
    const nearOperator = await createUser('OPERATOR', String(near.org._id));
    for (let i = 0; i < 9; i += 1) {
      await createScan(scanBody(`near-${i}`), nearOperator);
    }
    const nearAdmin = await createUser(
      'ORGANIZATION_ADMIN',
      String(near.org._id),
    );
    const nearRes = await request(app)
      .get('/api/org-dashboard/attention')
      .query({ organization_id: String(near.org._id) })
      .set('authorization', `Bearer ${await tokenFor(nearAdmin)}`);

    expect(nearRes.status).toBe(200);
    const nearItem = nearRes.body.data.items.find(
      (item: any) => item.type === 'daily_limit_near',
    );
    expect(nearItem).toMatchObject({
      severity: 'warning',
      data: {
        used: 9,
        limit: 10,
        utilization_pct: 90,
        timezone: config.dailyLimit.timezone,
      },
    });
    expect(nearItem.data.reset_at).toBeTruthy();

    const reached = await setupOrg(2);
    const reachedOperator = await createUser(
      'OPERATOR',
      String(reached.org._id),
    );
    await createScan(scanBody('reached-1'), reachedOperator);
    await createScan(scanBody('reached-2'), reachedOperator);
    const reachedAdmin = await createUser(
      'ORGANIZATION_ADMIN',
      String(reached.org._id),
    );
    const reachedRes = await request(app)
      .get('/api/org-dashboard/attention')
      .query({ organization_id: String(reached.org._id) })
      .set('authorization', `Bearer ${await tokenFor(reachedAdmin)}`);

    expect(reachedRes.status).toBe(200);
    const reachedItem = reachedRes.body.data.items.find(
      (item: any) => item.type === 'daily_limit_reached',
    );
    expect(reachedItem).toMatchObject({
      severity: 'critical',
      data: {
        used: 2,
        limit: 2,
        timezone: config.dailyLimit.timezone,
      },
    });
  });

  it('returns daily_scan_limit in plan and subscription responses', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);

    const created = await request(app)
      .post('/api/plans')
      .set('authorization', `Bearer ${token}`)
      .send({
        name: `Daily Response Plan ${Date.now()}`,
        price: 10,
        billing_cycle: 'month',
        features: [
          { features_name: 'scan', scan_limit: 10, daily_scan_limit: 3 },
        ],
      });
    expect(created.status).toBe(201);
    expect(created.body.data.plan.features[0].daily_scan_limit).toBe(3);

    const updated = await request(app)
      .put(`/api/plans/${created.body.data.plan.id}`)
      .set('authorization', `Bearer ${token}`)
      .send({
        features: [
          { features_name: 'scan', scan_limit: 10, daily_scan_limit: 4 },
        ],
      });
    expect(updated.status).toBe(200);
    expect(updated.body.data.plan.features[0].daily_scan_limit).toBe(4);

    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 10, daily_scan_limit: 6 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });

    const subRes = await request(app)
      .get(`/api/organizations/${org._id}/subscription`)
      .set('authorization', `Bearer ${token}`);

    expect(subRes.status).toBe(200);
    expect(
      subRes.body.data.activeSubscription.features[0].daily_scan_limit,
    ).toBe(6);
  });
});

describe('daily scan limit — Phase 3 alerts', () => {
  const collectDailyJobs = async (): Promise<any[]> => {
    const queue = getNotificationQueue();
    const jobs = await queue.getJobs(
      ['waiting', 'delayed', 'active', 'paused', 'completed', 'failed'],
      0,
      1000,
    );
    return jobs.filter(
      (job) => job && (job.data as any)?.source === 'daily_quota',
    );
  };

  const waitForDailyJobs = async (count: number): Promise<any[]> => {
    const deadline = Date.now() + 3000;
    let jobs = await collectDailyJobs();
    while (jobs.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      jobs = await collectDailyJobs();
    }
    return jobs;
  };

  const setupOrg = async (daily: number, scanLimit = 1000) => {
    const org = await createOrg();
    const plan = await createPlan({
      scan_limit: scanLimit,
      daily_scan_limit: daily,
    });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await populateActiveSubCache(String(org._id));
    return { org, plan };
  };

  it('enqueues one organization alert per level per day', async () => {
    const { org } = await setupOrg(10);
    const user = await createUser('OPERATOR', String(org._id));

    for (let i = 0; i < 9; i += 1) {
      await createScan(scanBody(`alert-near-${i}`), user);
    }

    let jobs = await waitForDailyJobs(1);
    expect(jobs).toHaveLength(1);
    const near = jobs[0].data as DailyQuotaAlertJob;
    expect(near).toMatchObject({
      source: 'daily_quota',
      organization_id: String(org._id),
      level: 'near',
      day_key: dailyUsageDayKey(),
      used: 9,
      limit: 10,
      timezone: config.dailyLimit.timezone,
    });
    expect(new Date(near.reset_at).getTime()).toBeGreaterThan(Date.now());
    expect(jobs[0].id).toBe(
      `daily-${String(org._id)}-${dailyUsageDayKey()}-near`,
    );

    await createScan(scanBody('alert-limit-1'), user);
    jobs = await waitForDailyJobs(2);
    expect(jobs).toHaveLength(2);
    const limit = jobs.find(
      (job) => (job.data as DailyQuotaAlertJob).level === 'limit',
    )!.data as DailyQuotaAlertJob;
    expect(limit).toMatchObject({
      source: 'daily_quota',
      organization_id: String(org._id),
      level: 'limit',
      used: 10,
      limit: 10,
    });

    // A rejected scan past the cap does not enqueue anything else.
    await expect(createScan(scanBody('alert-limit-2'), user)).rejects.toThrow(
      'FORBIDDEN_DAILY_LIMIT_EXCEEDED',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await collectDailyJobs()).toHaveLength(2);
  });

  it('never notifies for an operator personal cap', async () => {
    const { org } = await setupOrg(100);
    const user = await createUser('OPERATOR', String(org._id), {
      daily_scan_limit: 2,
    });

    await createScan(scanBody('op-alert-1'), user);
    await createScan(scanBody('op-alert-2'), user);

    const redis = getRedis();
    const key = dailyUsageCacheKey(String(org._id), dailyUsageDayKey());
    expect(await redis.hget(key, `ou:${String(user._id)}`)).toBe('1');

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await collectDailyJobs()).toHaveLength(0);
    expect(await Notification.countDocuments({ type: 'quota_alert' })).toBe(0);
  });

  it('delivers once to active organization admins with timezone wording', async () => {
    const org = await createOrg();
    const activeA = await createUser('ORGANIZATION_ADMIN', String(org._id));
    const activeB = await createUser('ORGANIZATION_ADMIN', String(org._id));
    const inactive = await createUser('ORGANIZATION_ADMIN', String(org._id), {
      status: 0,
    });
    const operator = await createUser('OPERATOR', String(org._id));

    const base = {
      source: 'daily_quota' as const,
      organization_id: String(org._id),
      day_key: '2026-11-09',
      used: 9,
      limit: 10,
      // 18:30Z is midnight on the next business day in Asia/Kolkata.
      reset_at: new Date('2026-11-09T18:30:00.000Z').toISOString(),
      timezone: 'Asia/Kolkata',
    };

    await dispatchAppNotification({ ...base, level: 'near' });
    await dispatchAppNotification({ ...base, level: 'near' }); // retry coalesces
    await dispatchAppNotification({ ...base, level: 'limit', used: 10 });

    const rows = await Notification.find({
      organization_id: org._id,
      type: 'quota_alert',
    }).lean();
    expect(rows).toHaveLength(4); // 2 active admins × (warning + critical)
    expect(await Notification.countDocuments({ user_id: inactive._id })).toBe(
      0,
    );
    expect(await Notification.countDocuments({ user_id: operator._id })).toBe(
      0,
    );
    expect(rows.map((row: any) => String(row.user_id)).sort()).toEqual(
      [
        String(activeA._id),
        String(activeA._id),
        String(activeB._id),
        String(activeB._id),
      ].sort(),
    );

    const nearRows = rows.filter((row: any) =>
      String(row.dedupe_key).endsWith(':near'),
    );
    expect(nearRows).toHaveLength(2);
    for (const row of nearRows) {
      expect(row.severity).toBe('warning');
      expect(row.title).toBe('Daily scan limit nearly reached');
      expect(row.message).toContain('9 of 10');
      expect(row.message).toContain('12:00 AM IST');
    }

    const limitRows = rows.filter((row: any) =>
      String(row.dedupe_key).endsWith(':limit'),
    );
    expect(limitRows).toHaveLength(2);
    for (const row of limitRows) {
      expect(row.severity).toBe('critical');
      expect(row.title).toBe('Daily scan limit reached');
      expect(row.message).toContain('10 of 10');
      expect(row.message).toContain('12:00 AM IST');
    }
  });

  it('swallows enqueue failures so the scan path is never affected', async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error('queue down'));
    await expect(
      enqueueDailyQuotaAlert(
        {
          organization_id: '507f1f77bcf86cd799439011',
          level: 'near',
          day_key: '2026-11-09',
          used: 9,
          limit: 10,
          reset_at: new Date().toISOString(),
          timezone: 'Asia/Kolkata',
        },
        enqueue,
      ),
    ).resolves.toBeNull();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((enqueue.mock.calls[0][0] as any).source).toBe('daily_quota');
  });
});
