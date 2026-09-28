import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { createOrg, createPlan, grant } from './helpers.js';
import { generateAuthTokens } from '../src/services/token.service.js';
import { User, Scan } from '../src/models/index.js';
import { getPeriodScanCount } from '../src/services/quota.service.js';
import { createScan } from '../src/services/user/scans.service.js';

const makeUser = async (role: string, organizationId: string | null) => {
  const user = await User.create({
    first_name: 'Test',
    last_name: 'User',
    email: `auth-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    role,
    isSuperAdmin: false,
    organizationId,
    status: 1,
  });
  return user;
};

const tokenFor = async (user: any) =>
  (await generateAuthTokens(user)).access.token;

describe('authorization & organization scope (§9)', () => {
  it('25. org admin is forced into their own org scope', async () => {
    const own = await createOrg({ name: 'Own' });
    const other = await createOrg({ name: 'Other' });
    const admin = await makeUser('ORGANIZATION_ADMIN', String(own._id));
    const token = await tokenFor(admin);

    const res = await request(app)
      .get(`/api/organizations/${other._id}/usage`)
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(String(res.body.data.organizationId)).toBe(String(own._id));
    expect(String(res.body.data.organizationId)).not.toBe(String(other._id));
  });

  it('26. operator cannot manage subscriptions (403)', async () => {
    const org = await createOrg();
    const plan = await createPlan();
    const operator = await makeUser('OPERATOR', String(org._id));
    const token = await tokenFor(operator);

    const res = await request(app)
      .post(`/api/organizations/${org._id}/subscription/force-activate`)
      .set('authorization', `Bearer ${token}`)
      .send({ planId: String(plan._id) });
    expect(res.status).toBe(403);
  });

  it('27. super admin can assign a plan', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scanLimit: 42 });
    const admin = await makeUser('SUPER_ADMIN', null);
    await User.updateOne({ _id: admin._id }, { $set: { isSuperAdmin: true } });
    const token = await tokenFor(admin);

    const res = await request(app)
      .post(`/api/organizations/${org._id}/subscription/assign-plan`)
      .set('authorization', `Bearer ${token}`)
      .send({ planId: String(plan._id) });
    expect(res.status).toBe(201);
    expect(res.body.data.subscription.scanLimit).toBe(42);
    expect(res.body.data.subscription.status).toBe('active');
  });

  it('28. operator scans are charged to their own org only', async () => {
    const orgA = await createOrg({ name: 'A' });
    const orgB = await createOrg({ name: 'B' });
    const planA = await createPlan({ scanLimit: 10 });
    const planB = await createPlan({ scanLimit: 10 });
    await grant(String(orgA._id), String(planA._id), { trialDays: 0 });
    await grant(String(orgB._id), String(planB._id), { trialDays: 0 });

    const userA = await makeUser('OPERATOR', String(orgA._id));
    const res = await createScan(
      {
        organizationId: String(orgB._id),
        clientScanId: 'sneaky',
        barcode: 'BC-1',
      },
      userA,
    );
    expect(res.status).toBe(202);
    const scan = await Scan.findOne({ clientScanId: 'sneaky' });
    expect(String(scan?.organizationId)).toBe(String(orgA._id));
    expect(await getPeriodScanCount(String(orgA._id), 'monthly')).toBe(1);
    expect(await getPeriodScanCount(String(orgB._id), 'monthly')).toBe(0);
  });

  it('29. super admin can list public plans (200)', async () => {
    await createPlan({
      name: 'Cheap',
      amount: 50,
      isPublic: true,
      isActive: true,
    });
    await createPlan({
      name: 'Hidden',
      amount: 9000,
      isPublic: false,
      isActive: true,
    });
    await createPlan({
      name: 'Disabled',
      amount: 7000,
      isPublic: true,
      isActive: false,
    });
    const admin = await makeUser('SUPER_ADMIN', null);
    await User.updateOne({ _id: admin._id }, { $set: { isSuperAdmin: true } });
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
