import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import {
  createOrg,
  createPlan,
  createUser,
  createAdminUser,
  grant,
  scan,
} from './helpers.js';
import { GuestLead, SystemError } from '../src/models/index.js';
import { generateAuthTokens } from '../src/services/token.service.js';

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

    it('GET /attention buckets quota and expiry signals', async () => {
      const org = await createOrg({ company_name: 'Full Co' });
      const plan = await createPlan({ name: 'Pro', price: 199 });
      const sub = await grant(org.id, String(plan._id));
      const { Usage } = await import('../src/models/index.js');
      await Usage.updateOne(
        { subscription_id: sub._id },
        { $set: { usage: 100, scan_limit: 100, is_exhausted: true } },
      );

      const res = await request(app)
        .get('/api/dashboard/attention')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.quota_exhausted[0].organization_id).toBe(org.id);
      expect(res.body.data.quota_exhausted[0].name).toBe('Full Co');
    });

    it('GET /webhooks reports delivery health', async () => {
      const res = await request(app)
        .get('/api/dashboard/webhooks')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(typeof res.body.data.failed_last_24h).toBe('number');
      expect(typeof res.body.data.pending).toBe('number');
    });

    it('GET /system reports service health and scrubs error summaries', async () => {
      await SystemError.create({
        action_type: 'global-error-handler',
        error_data: JSON.stringify({
          message: 'boom',
          token: 'secret-token-value',
        }),
      });

      const res = await request(app)
        .get('/api/dashboard/system')
        .set('authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.services.api).toBe('healthy');
      expect(res.body.data.recent_errors[0].summary).toContain('boom');
      expect(JSON.stringify(res.body.data.recent_errors)).not.toContain(
        'secret-token-value',
      );
    });
  });
});
