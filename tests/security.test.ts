import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { createOrg, createPlan, grant, activeUsed } from './helpers.js';
import { generateAuthTokens } from '../src/services/token.service.js';
import { createScan } from '../src/services/user/scans.service.js';
import { Scan } from '../src/models/index.js';

const makeUser = async (role: string, organizationId: string | null) => {
  const { createUser } = await import('./helpers.js');
  return createUser(role, organizationId, {
    is_super_admin: role === 'SUPER_ADMIN',
  });
};

const tokenFor = async (user: any) => {
  const tokens = await generateAuthTokens(user as any);
  return tokens.access_token;
};

describe('authorization & organization scope (§9/§10)', () => {
  it('25. org admin is forced into their own org scope', async () => {
    const own = await createOrg({ name: 'Own' });
    const other = await createOrg({ name: 'Other' });
    const plan = await createPlan();
    await grant(String(own._id), String(plan._id), { trialDays: 0 });
    const admin = await makeUser('ORGANIZATION_ADMIN', String(own._id));
    const token = await tokenFor(admin);

    const res = await request(app)
      .get(`/api/organizations/${other._id}/usage`)
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(String(res.body.data.organization_id)).toBe(String(own._id));
    expect(String(res.body.data.organization_id)).not.toBe(String(other._id));
  });

  it('26. operator cannot manage subscriptions (403)', async () => {
    const org = await createOrg();
    const plan = await createPlan();
    const operator = await makeUser('OPERATOR', String(org._id));
    const token = await tokenFor(operator);

    const res = await request(app)
      .post(`/api/organizations/${org._id}/subscription/force-activate`)
      .set('authorization', `Bearer ${token}`)
      .send({ plan_id: String(plan._id) });
    expect(res.status).toBe(403);
  });

  it('27. super admin can assign a plan (features carry scan_limit)', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 42 });
    const admin = await makeUser('SUPER_ADMIN', null);
    const token = await tokenFor(admin);

    const res = await request(app)
      .post(`/api/organizations/${org._id}/subscription/assign-plan`)
      .set('authorization', `Bearer ${token}`)
      .send({ plan_id: String(plan._id) });
    expect(res.status).toBe(201);
    const scan = res.body.data.subscription.features.find(
      (f: any) => f.features_name === 'scan',
    );
    expect(scan.scan_limit).toBe(42);
    expect(res.body.data.subscription.status).toBe('active');
  });

  it('28. operator scans are charged to their own org only', async () => {
    const orgA = await createOrg({ name: 'A' });
    const orgB = await createOrg({ name: 'B' });
    const planA = await createPlan({ scan_limit: 10 });
    await grant(String(orgA._id), String(planA._id), { trialDays: 0 });

    const userA = await makeUser('OPERATOR', String(orgA._id));
    const res = await createScan(
      {
        organization_id: String(orgB._id),
        client_scan_id: 'sneaky',
        barcode: 'BC-1',
        device_id: 'd1',
      },
      userA,
    );
    expect(res.status).toBe(202);
    const scan = await Scan.findOne({ client_scan_id: 'sneaky' });
    expect(String(scan?.organization_id)).toBe(String(orgA._id));
    expect(await activeUsed(String(orgA._id))).toBe(1);
    expect(await activeUsed(String(orgB._id))).toBe(0);
  });

  it('29. super admin can list public plans (200)', async () => {
    await createPlan({
      name: 'Cheap',
      price: 50,
      status: 1,
      is_custom_plan: false,
    });
    await createPlan({
      name: 'Hidden',
      price: 9000,
      status: 1,
      is_custom_plan: true,
    });
    await createPlan({
      name: 'Disabled',
      price: 7000,
      status: 0,
      is_custom_plan: false,
    });
    const admin = await makeUser('SUPER_ADMIN', null);
    const token = await tokenFor(admin);

    const res = await request(app)
      .get('/api/plans')
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const names = res.body.data.plans.map((p: any) => String(p.name));
    expect(names).toContain('Cheap');
    expect(names).not.toContain('Hidden');
    expect(names).not.toContain('Disabled');
  });

  it('30. operator cannot list plans (403)', async () => {
    const org = await createOrg();
    const operator = await makeUser('OPERATOR', String(org._id));
    const token = await tokenFor(operator);

    const res = await request(app)
      .get('/api/plans')
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
