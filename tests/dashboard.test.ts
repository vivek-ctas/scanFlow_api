import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app.js';
import {
  createOrg,
  createPlan,
  createUser,
  createAdminUser,
  grant,
  scan,
} from './helpers.js';
import {
  GuestLead,
  Organization,
  Payment,
  Scan,
  Subscription,
  SystemError,
  Usage,
  WebhookDelivery,
} from '../src/models/index.js';
import { generateAuthTokens } from '../src/services/token.service.js';
import { healthFromAge } from '../src/services/admin/dashboard.service.js';
import {
  dashboardTimezone,
  getMonthWindows,
  objectIdFromDate,
} from '../src/utils/dashboard-time.js';
import { getRedis, isRedisConfigured } from '../src/queues/redis.js';
import { scrubErrorSummary } from '../src/utils/dashboard-scrub.js';
import { invalidateDashboardCache } from '../src/services/admin/dashboard.cache.js';

const tokenFor = async (user: any) => {
  const tokens = await generateAuthTokens(user as any);
  return tokens.access_token;
};

describe('super admin dashboard (§dashboard)', () => {
  it('rejects unauthenticated access', async () => {
    const res = await request(app).get('/api/dashboard/summary');
    expect(res.status).toBe(401);
  });

  it('forbids ORGANIZATION_ADMIN (no viewDashboard right)', async () => {
    const org = await createOrg();
    const admin = await createUser('ORGANIZATION_ADMIN', org.id);
    const token = await tokenFor(admin);
    const res = await request(app)
      .get('/api/dashboard/summary')
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  describe('as SUPER_ADMIN', () => {
    let token: string;

    beforeEach(async () => {
      const admin = await createAdminUser();
      token = await tokenFor(admin);
    });

    it('GET /summary returns the KPI envelope', async () => {
      const org = await createOrg({ status: 1 });
      const plan = await createPlan({ name: 'Starter', price: 99 });
      await grant(org.id, String(plan._id));
      await GuestLead.create({
        first_name: 'Alice',
        last_name: 'Wong',
        email: 'alice@example.com',
        plan_id: plan._id,
        status: 'pending',
      });
      await scan(org.id);

      const res = await request(app)
        .get('/api/dashboard/summary')
        .set('authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(200);
      expect(res.body.data.computed_at).toBeTruthy();
      expect(res.body.data.timezone).toBe('Asia/Kolkata');
      expect(res.body.data.organizations.total).toBe(1);
      expect(res.body.data.organizations.active).toBe(1);
      expect(res.body.data.scans.month_to_date).toBe(1);
      expect(res.body.data.subscriptions.active).toBe(1);
      expect(res.body.data.guest_leads.pending).toBe(1);
      expect(res.body.data.users).toBeTruthy();
    });

    it('GET /summary classifies paid, trial and manual subscriptions', async () => {
      const plan = await createPlan({ name: 'Starter', price: 99 });
      const makeSub = async (
        gateway: 'stripe' | 'manual',
        trialDays: number,
      ) => {
        const org = await createOrg({ status: 1 });
        const payment = await Payment.create({
          organization_id: org._id,
          plan_id: plan._id,
          gateway,
          price: 99,
          currency_code: 'inr',
          billing_cycle: 'month',
          status: 'TXN_SUCCESS',
        });
        await Subscription.create({
          organization_id: org._id,
          plan_id: plan._id,
          payment_id: payment._id,
          features: [{ features_name: 'scan', scan_limit: 100 }],
          billing_cycle: 'month',
          status: 'active',
          started_at: new Date(),
          expires_at: new Date(Date.now() + 30 * 86_400_000),
          trial_days: trialDays,
          plan_name: plan.name,
        });
      };

      await makeSub('stripe', 0); // paid
      await makeSub('manual', 0); // manual
      await makeSub('manual', 14); // trial

      const res = await request(app)
        .get('/api/dashboard/summary')
        .set('authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.subscriptions.active).toBe(3);
      expect(res.body.data.subscriptions.paid).toBe(1);
      expect(res.body.data.subscriptions.trial).toBe(1);
      expect(res.body.data.subscriptions.manual).toBe(1);
    });

    it('GET /summary returns null change_pct when the previous period had no scans', async () => {
      const res = await request(app)
        .get('/api/dashboard/summary')
        .set('authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.scans.month_to_date).toBe(0);
      expect(res.body.data.scans.previous_month_same_period).toBe(0);
      expect(res.body.data.scans.change_pct).toBeNull();
    });

    it('GET /summary compares month-to-date against the same period last month', async () => {
      const win = getMonthWindows(new Date(), dashboardTimezone());
      const organization_id = new mongoose.Types.ObjectId();
      const user_id = new mongoose.Types.ObjectId();
      const seedScan = (date: Date, n: number) =>
        Scan.create({
          _id: objectIdFromDate(date),
          organization_id,
          user_id,
          client_scan_id: `cs-${n}`,
          barcode: `bc-${n}`,
          scanned_at: date,
        });

      await seedScan(win.previousMonthStart, 1);
      await seedScan(new Date(), 2);

      const res = await request(app)
        .get('/api/dashboard/summary')
        .set('authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.scans.previous_month_same_period).toBeGreaterThan(0);
      expect(res.body.data.scans.change_pct).not.toBeNull();
      expect(Number.isFinite(res.body.data.scans.change_pct as number)).toBe(
        true,
      );
    });

    it('GET /scan-trend validates range and returns daily points', async () => {
      const org = await createOrg();
      const plan = await createPlan({ name: 'Starter', price: 99 });
      await grant(org.id, String(plan._id));
      await scan(org.id);

      const res = await request(app)
        .get('/api/dashboard/scan-trend?range=7d&compare=true')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.points.length).toBe(7);
      expect(res.body.data.points.at(-1).count).toBe(1);
      expect(res.body.data.comparison.length).toBe(7);
    });

    it('rejects an invalid range value', async () => {
      const res = await request(app)
        .get('/api/dashboard/scan-trend?range=1y')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('rejects a custom window over 90 days', async () => {
      const res = await request(app)
        .get(
          '/api/dashboard/scan-trend?from=2026-01-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z',
        )
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('rejects a reversed custom window', async () => {
      const res = await request(app)
        .get(
          '/api/dashboard/growth?from=2026-03-10T00:00:00.000Z&to=2026-03-01T00:00:00.000Z',
        )
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('caps the recent-leads limit', async () => {
      const res = await request(app)
        .get('/api/dashboard/recent-leads?limit=50')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('GET /recent-leads returns newest first', async () => {
      const plan = await createPlan({ name: 'Starter', price: 99 });
      await GuestLead.create([
        {
          first_name: 'Old',
          last_name: 'Lead',
          email: 'old@example.com',
          plan_id: plan._id,
          status: 'pending',
          created_at: new Date(Date.now() - 60_000),
        },
        {
          first_name: 'New',
          last_name: 'Lead',
          email: 'new@example.com',
          plan_id: plan._id,
          status: 'success',
          created_at: new Date(),
        },
      ]);

      const res = await request(app)
        .get('/api/dashboard/recent-leads?limit=5')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.results[0].name).toBe('New Lead');
    });

    it('GET /plan-distribution groups active subscriptions', async () => {
      const org = await createOrg();
      const plan = await createPlan({ name: 'Pro', price: 199 });
      await grant(org.id, String(plan._id));

      const res = await request(app)
        .get('/api/dashboard/plan-distribution')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.results[0].plan_name).toBe('Pro');
      expect(res.body.data.results[0].count).toBe(1);
    });

    it('GET /plan-distribution no_plan excludes soft-deleted orgs', async () => {
      const plan = await createPlan({ name: 'Pro', price: 199 });

      const withPlan = await createOrg({ company_name: 'With Plan' });
      await grant(withPlan.id, String(plan._id));

      // A live org with no active subscription — the only real no-plan org.
      await createOrg({ company_name: 'No Plan' });

      // A soft-deleted org that still owns an active subscription: it must be
      // left out of `no_plan` AND must not swallow a live no-plan org.
      const deleted = await createOrg({ company_name: 'Deleted With Plan' });
      await grant(deleted.id, String(plan._id));
      await Organization.updateOne({ _id: deleted.id }, { status: 2 });

      const res = await request(app)
        .get('/api/dashboard/plan-distribution')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      // Both active subscriptions still count in the plan split.
      expect(
        res.body.data.results.find((r: any) => r.plan_name === 'Pro').count,
      ).toBe(2);
      // Only the live org without a plan.
      expect(res.body.data.no_plan).toBe(1);
    });

    it('GET /growth returns org and lead series', async () => {
      await createOrg();
      const plan = await createPlan({ name: 'Starter', price: 99 });
      await GuestLead.create({
        first_name: 'Lead',
        last_name: 'User',
        email: 'lead@example.com',
        plan_id: plan._id,
        status: 'pending',
      });

      const res = await request(app)
        .get('/api/dashboard/growth?range=7d')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.points.length).toBe(7);
      const totals = res.body.data.points.reduce(
        (acc: any, p: any) => ({
          orgs: acc.orgs + p.organizations,
          leads: acc.leads + p.guest_leads,
        }),
        { orgs: 0, leads: 0 },
      );
      expect(totals.orgs).toBe(1);
      expect(totals.leads).toBe(1);
    });

    it('GET /top-organizations ranks by usage', async () => {
      const org = await createOrg({ company_name: 'Top Co' });
      const plan = await createPlan({ name: 'Pro', price: 199 });
      const sub = await grant(org.id, String(plan._id));
      const { Usage } = await import('../src/models/index.js');
      await Usage.updateOne(
        { subscription_id: sub._id },
        { $set: { usage: 12, scan_limit: 100 } },
      );

      const res = await request(app)
        .get('/api/dashboard/top-organizations?limit=5')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.results[0].name).toBe('Top Co');
      expect(res.body.data.results[0].usage).toBe(12);
    });

    it('GET /attention & /top-organizations exclude soft-deleted orgs', async () => {
      const plan = await createPlan({
        name: 'Pro',
        price: 199,
        scan_limit: 100,
      });

      const live = await createOrg({ company_name: 'Live Co' });
      const liveSub = await grant(live.id, String(plan._id));
      await Usage.updateOne(
        { subscription_id: liveSub._id },
        { $set: { usage: 95, scan_limit: 100, is_exhausted: false } },
      );

      // A soft-deleted org that still owns an active subscription expiring
      // soon and over quota — it must never surface in either widget.
      const deleted = await createOrg({ company_name: 'Deleted Co' });
      const deletedSub = await grant(deleted.id, String(plan._id));
      await Usage.updateOne(
        { subscription_id: deletedSub._id },
        { $set: { usage: 100, scan_limit: 100, is_exhausted: true } },
      );
      await Subscription.updateOne(
        { _id: deletedSub._id },
        { $set: { expires_at: new Date(Date.now() + 2 * 86_400_000) } },
      );
      await Organization.updateOne({ _id: deleted.id }, { status: 2 });

      const [attention, top] = await Promise.all([
        request(app)
          .get('/api/dashboard/attention')
          .set('authorization', `Bearer ${token}`),
        request(app)
          .get('/api/dashboard/top-organizations?limit=5')
          .set('authorization', `Bearer ${token}`),
      ]);

      const names = [
        ...attention.body.data.quota_exhausted,
        ...attention.body.data.near_limit,
        ...attention.body.data.expiring_soon,
      ].map((r: any) => r.name);
      expect(names).not.toContain('Deleted Co');
      expect(names).toContain('Live Co');

      const topNames = top.body.data.results.map((r: any) => r.name);
      expect(topNames).not.toContain('Deleted Co');
      expect(topNames).toContain('Live Co');
    });

    it('GET /attention buckets quota, near-limit, expiry and provisioning signals', async () => {
      const plan = await createPlan({
        name: 'Pro',
        price: 199,
        scan_limit: 100,
      });

      const quotaOrg = await createOrg({ company_name: 'Full Co' });
      const quotaSub = await grant(quotaOrg.id, String(plan._id));
      await Usage.updateOne(
        { subscription_id: quotaSub._id },
        { $set: { usage: 100, scan_limit: 100, is_exhausted: true } },
      );

      const nearOrg = await createOrg({ company_name: 'Almost Co' });
      const nearSub = await grant(nearOrg.id, String(plan._id));
      await Usage.updateOne(
        { subscription_id: nearSub._id },
        { $set: { usage: 95, scan_limit: 100, is_exhausted: false } },
      );

      const expiringOrg = await createOrg({ company_name: 'Expiring Co' });
      const expiringSub = await grant(expiringOrg.id, String(plan._id));
      await Usage.updateOne(
        { subscription_id: expiringSub._id },
        { $set: { usage: 10, scan_limit: 100, is_exhausted: false } },
      );
      await Subscription.updateOne(
        { _id: expiringSub._id },
        { $set: { expires_at: new Date(Date.now() + 3 * 86_400_000) } },
      );
      await Subscription.create({
        organization_id: expiringOrg.id,
        plan_id: plan._id,
        payment_id: new mongoose.Types.ObjectId(),
        billing_cycle: 'month',
        status: 'future',
        started_at: new Date(),
        expires_at: new Date(Date.now() + 33 * 86_400_000),
      });

      const lead = await GuestLead.create({
        first_name: 'Priya',
        last_name: 'Nair',
        email: 'priya@example.com',
        plan_id: plan._id,
        status: 'success',
      });
      await Payment.create({
        lead_id: lead._id,
        organization_id: null,
        plan_id: plan._id,
        gateway: 'stripe',
        price: 199,
        currency_code: 'inr',
        billing_cycle: 'month',
        status: 'TXN_SUCCESS',
        paid_at: new Date(),
        gateway_response: { secret: 'should-never-leak' },
      });

      const res = await request(app)
        .get('/api/dashboard/attention')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);

      expect(res.body.data.quota_exhausted.map((r: any) => r.name)).toContain(
        'Full Co',
      );
      expect(res.body.data.near_limit.map((r: any) => r.name)).toContain(
        'Almost Co',
      );

      const expiring = res.body.data.expiring_soon.find(
        (r: any) => r.organization_id === expiringOrg.id,
      );
      expect(expiring).toBeTruthy();
      expect(expiring.next_plan_queued).toBe(true);

      const paid = res.body.data.paid_not_provisioned;
      expect(paid).toHaveLength(1);
      expect(paid[0]).toMatchObject({
        gateway: 'stripe',
        plan_name: 'Pro',
        lead_id: String(lead._id),
        lead_name: 'Priya Nair',
      });
      expect(paid[0].gateway_response).toBeUndefined();
    });

    it('GET /webhooks reports delivery health from last_attempt_at, not created_at', async () => {
      const org = await createOrg();
      const now = Date.now();
      const hour = 3_600_000;
      const base = {
        scan_id: new mongoose.Types.ObjectId(),
        organization_id: org._id,
      };

      await WebhookDelivery.collection.insertMany([
        // Failed 1h ago although created 2 days ago → must count as a recent failure.
        {
          ...base,
          event_id: 'evt-failed-recent',
          status: 'failed',
          retry_count: 1,
          last_attempt_at: new Date(now - hour),
          created_at: new Date(now - 48 * hour),
          updated_at: new Date(now - hour),
        },
        // Failed 48h ago → outside the 24h window.
        {
          ...base,
          event_id: 'evt-failed-old',
          status: 'failed',
          retry_count: 1,
          last_attempt_at: new Date(now - 48 * hour),
          created_at: new Date(now - 72 * hour),
          updated_at: new Date(now - 48 * hour),
        },
        // Fresh pending delivery, no retries yet.
        {
          ...base,
          event_id: 'evt-pending-fresh',
          status: 'pending',
          retry_count: 0,
          created_at: new Date(now - 30_000),
          updated_at: new Date(now - 30_000),
        },
        // Oldest pending, already retried once → drives both backlog and age.
        {
          ...base,
          event_id: 'evt-pending-old',
          status: 'pending',
          retry_count: 2,
          created_at: new Date(now - 20 * hour),
          updated_at: new Date(now - 20 * hour),
        },
      ]);

      const res = await request(app)
        .get('/api/dashboard/webhooks')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const data = res.body.data;

      expect(data.failed_24h).toBe(1);
      expect(data.failed_last_24h).toBe(1);
      expect(data.pending).toBe(2);
      expect(data.retry_backlog).toBe(1);
      expect(data.oldest_pending_age_seconds).toBeGreaterThanOrEqual(
        20 * 3600 - 5,
      );
      expect(data.oldest_pending_age_seconds).toBeLessThan(20 * 3600 + 5);
      expect(data.oldest_pending_age).toBe('20h');
      expect(typeof data.computed_at).toBe('string');

      if (isRedisConfigured()) {
        expect(data.queue).toEqual({
          waiting: expect.any(Number),
          active: expect.any(Number),
          completed: expect.any(Number),
          delayed: expect.any(Number),
          failed: expect.any(Number),
        });
      } else {
        expect(data.queue).toBeNull();
      }
    });

    it('GET /system returns scrubbed errors and masks sensitive data', async () => {
      await SystemError.create({
        action_type: 'global-error-handler',
        method: 'POST',
        route: '/api/auth/verify-otp',
        status_code: 401,
        error_data: JSON.stringify({
          name: 'Error',
          message: 'Invalid token password=supersecret',
          stack:
            'Error: Invalid token\n    at verifyToken (/home/ctas/app/scanFlow_api/src/middlewares/auth.ts:42:13)\n    at node:internal/process/task_queues:95:5',
        }),
      });
      await SystemError.create({
        action_type: 'cron-expiry-reminder',
        error_data: 'cron failed reading /var/log/scanflow/worker.log',
      });
      await SystemError.create({
        action_type: 'not-an-error',
        status_code: 200,
        error_data: 'ok',
      });

      const res = await request(app)
        .get('/api/dashboard/system')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.services.api).toBe('healthy');

      const rows = res.body.data.recent_errors as any[];
      // status_code 200 is filtered out; HTTP error + non-HTTP error remain.
      expect(rows).toHaveLength(2);

      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('supersecret');
      expect(serialized).not.toContain('password=');
      expect(serialized).not.toContain('/home/');
      expect(serialized).not.toContain('/var/');
      expect(serialized).not.toContain('node:internal');

      const apiError = rows.find((row) => row.route === '/api/auth/verify-otp');
      expect(apiError).toBeTruthy();
      expect(apiError.method).toBe('POST');
      expect(apiError.status_code).toBe(401);
      expect(apiError.summary).toContain('Invalid token');
      expect(apiError.summary).toContain('src/middlewares/auth.ts:42');
      expect(apiError.summary.length).toBeLessThanOrEqual(151);

      // Non-HTTP (cron) error is retained with a null status.
      expect(rows.some((row) => row.status_code === null)).toBe(true);
    });

    it('GET /system reflects the worker heartbeat status', async () => {
      if (!isRedisConfigured()) {
        return;
      }
      const redis = getRedis();
      const bustCache = async () => {
        const keys = await redis.keys('dash:*:system');
        await Promise.all(keys.map((key) => redis.del(key)));
      };

      // No heartbeat -> unavailable.
      await redis.del('worker:heartbeat');
      await bustCache();
      let res = await request(app)
        .get('/api/dashboard/system')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.services.worker).toBe('unavailable');
      expect(res.body.data.worker_heartbeat_age_seconds).toBeNull();

      // Fresh heartbeat -> healthy.
      await redis.set('worker:heartbeat', String(Date.now()), 'EX', 90);
      await bustCache();
      res = await request(app)
        .get('/api/dashboard/system')
        .set('authorization', `Bearer ${token}`);
      expect(res.body.data.services.worker).toBe('healthy');
      expect(res.body.data.worker_heartbeat_age_seconds).toBeLessThan(60);

      // Stale heartbeat (~75s old) -> degraded.
      await redis.set(
        'worker:heartbeat',
        String(Date.now() - 75_000),
        'EX',
        90,
      );
      await bustCache();
      res = await request(app)
        .get('/api/dashboard/system')
        .set('authorization', `Bearer ${token}`);
      expect(res.body.data.services.worker).toBe('degraded');
    });

    it('GET /system treats an idle webhook queue as healthy, not unavailable', async () => {
      // No pending deliveries -> oldest age is null. That is an idle queue, not
      // an unreachable one, so it must not surface as `unavailable`.
      await WebhookDelivery.deleteMany({ status: 'pending' });
      const res = await request(app)
        .get('/api/dashboard/system')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.services.webhook_queue).toBe(
        isRedisConfigured() ? 'healthy' : 'unavailable',
      );
    });
  });
});

describe('dashboard worker health', () => {
  it('maps heartbeat age to the healthy/degraded/unavailable bands', () => {
    expect(healthFromAge(null, 60_000, 90_000)).toBe('unavailable');
    expect(healthFromAge(0, 60_000, 90_000)).toBe('healthy');
    expect(healthFromAge(59_999, 60_000, 90_000)).toBe('healthy');
    expect(healthFromAge(60_000, 60_000, 90_000)).toBe('degraded');
    expect(healthFromAge(90_000, 60_000, 90_000)).toBe('degraded');
    expect(healthFromAge(90_001, 60_000, 90_000)).toBe('unavailable');
  });
});

describe('dashboard error scrubber', () => {
  it('keeps relative paths and strips absolute server paths', () => {
    const summary = scrubErrorSummary(
      JSON.stringify({
        message: 'Invalid token',
        stack:
          'Error: Invalid token\n    at fn (/home/user/proj/src/middlewares/auth.ts:42:13)',
      }),
    );

    expect(summary).toContain('src/middlewares/auth.ts:42');
    expect(summary).not.toContain('/home/');
  });

  it('redacts tokens, secrets and masks ids', () => {
    const summary = scrubErrorSummary(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij.klmnopqrst password=hunter2 org 6ac8ca8c6d60d439eb444bc8',
    );

    expect(summary).not.toContain('hunter2');
    expect(summary).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(summary).not.toContain('6ac8ca8c6d60d439eb444bc8');
  });

  it('truncates the summary to 150 characters', () => {
    const summary = scrubErrorSummary('x'.repeat(400));

    expect(summary.length).toBeLessThanOrEqual(151);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('dashboard cache invalidation', () => {
  it('purges every dash:v2 widget key and leaves other namespaces alone', async () => {
    if (!isRedisConfigured()) {
      return;
    }
    const redis = getRedis();
    await redis.set('dash:v2:summary', 'a');
    await redis.set('dash:v2:attention', 'b');
    await redis.set('other:key', 'c');

    await invalidateDashboardCache();

    expect(await redis.get('dash:v2:summary')).toBeNull();
    expect(await redis.get('dash:v2:attention')).toBeNull();
    expect(await redis.get('other:key')).toBe('c');
  });
});
