import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import {
  createOrg,
  createPlan,
  createUser,
  createAdminUser,
} from './helpers.js';
import { GuestLead, Organization } from '../src/models/index.js';
import { generateAuthTokens } from '../src/services/token.service.js';

const tokenFor = async (user: any) => {
  const tokens = await generateAuthTokens(user as any);
  return tokens.access_token;
};

const seedGuestLeads = async () => {
  const plan = await createPlan({ name: 'Starter', price: 99 });
  const o2 = await Organization.create({ name: 'Org 2', status: 1 });
  const leads = [
    {
      first_name: 'Alice',
      last_name: 'Wong',
      email: 'alice@example.com',
      contact_number: '1111111111',
      company_name: 'Alice Co',
      country_name: 'UAE',
      currency_code: 'aed',
      plan_id: plan._id,
      trial_days: 7,
      status: 'initiated',
    },
    {
      first_name: 'Bob',
      last_name: 'Smith',
      email: 'bob@example.com',
      contact_number: '2222222222',
      company_name: 'Bob Ltd',
      country_name: 'India',
      currency_code: 'inr',
      plan_id: plan._id,
      trial_days: 0,
      status: 'success',
    },
    {
      first_name: 'Cara',
      last_name: 'Lopez',
      email: 'cara@example.com',
      contact_number: '3333333333',
      company_name: 'Cara Inc',
      country_name: 'USA',
      currency_code: 'usd',
      plan_id: plan._id,
      organization_id: o2._id,
      trial_days: 14,
      status: 'failed',
    },
  ];
  const docs = await GuestLead.create(leads);
  return { plan, o2, leads: docs };
};

describe('admin plans CRUD (§4)', () => {
  beforeEach(async () => {
    await createAdminUser();
  });

  it('no-param GET /plans returns only active non-custom plans', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);
    await createPlan({ name: 'Public' });
    await createPlan({ name: 'Off', status: 0 });
    await createPlan({ name: 'Custom', is_custom_plan: true });
    const hidden = await createPlan({ name: 'Deleted', status: 2 });

    const res = await request(app)
      .get('/api/plans')
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const names = res.body.data.plans.map((p: any) => p.name);
    expect(names).toContain('Public');
    expect(names).not.toContain('Off');
    expect(names).not.toContain('Custom');
    expect(names).not.toContain(hidden.name);
  });

  it('paginated GET /plans returns envelope incl. inactive, excluding deleted', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);
    await createPlan({ name: 'A' });
    await createPlan({ name: 'B', status: 0 });
    await createPlan({ name: 'C' });
    await createPlan({ name: 'D', status: 2 });

    const res = await request(app)
      .get('/api/plans?page=1&limit=10&sort_by=created_at:desc')
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('results');
    expect(res.body.data.results.length).toBe(3);
    expect(res.body.data.total_results).toBe(3);
    const statuses = res.body.data.results.map((p: any) => p.status);
    expect(statuses).not.toContain(2);
  });

  it('GET /plans supports search + status filters', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);
    await createPlan({ name: 'Gold Plan' });
    await createPlan({ name: 'Silver Plan', status: 0 });

    const searchRes = await request(app)
      .get('/api/plans?search=gold')
      .set('authorization', `Bearer ${token}`);
    expect(searchRes.body.data.results.length).toBe(1);
    expect(searchRes.body.data.results[0].name).toBe('Gold Plan');

    const statusRes = await request(app)
      .get('/api/plans?status=0')
      .set('authorization', `Bearer ${token}`);
    const names = statusRes.body.data.results.map((p: any) => p.name);
    expect(names).toEqual(['Silver Plan']);
  });

  it('POST create + duplicate name rejected', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);
    await createPlan({ name: 'Basic' });

    const body = {
      name: 'Pro',
      price: 499,
      price_quarterly: 1199,
      currency: 'inr',
      trial_days: 7,
      features: [{ features_name: 'scan', scan_limit: 500 }],
      marketing_features: ['Priority support'],
      is_popular: true,
      discount: 20,
    };
    const created = await request(app)
      .post('/api/plans')
      .set('authorization', `Bearer ${token}`)
      .send(body);
    expect(created.status).toBe(201);
    expect(created.body.data.plan.name).toBe('Pro');
    expect(created.body.data.plan.status).toBe(1);

    const dup = await request(app)
      .post('/api/plans')
      .set('authorization', `Bearer ${token}`)
      .send({ name: 'pro', price: 1 });
    expect(dup.status).toBe(400);
    expect(dup.body.message).toMatch(/already exists/i);
  });

  it('PUT update, PATCH update-status, DELETE soft-delete', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);
    const plan = await createPlan({ name: 'Basic' });
    const id = String(plan._id);

    const updated = await request(app)
      .put(`/api/plans/${id}`)
      .set('authorization', `Bearer ${token}`)
      .send({ price: 199, is_popular: true });
    expect(updated.status).toBe(200);
    expect(updated.body.data.plan.price).toBe(199);

    const toggled = await request(app)
      .patch(`/api/plans/${id}/update-status`)
      .set('authorization', `Bearer ${token}`)
      .send({ action_type: 'deactivate' });
    expect(toggled.body.data.plan.status).toBe(0);

    const deleted = await request(app)
      .delete(`/api/plans/${id}`)
      .set('authorization', `Bearer ${token}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.plan.status).toBe(2);

    const getAfterDelete = await request(app)
      .get(`/api/plans/${id}`)
      .set('authorization', `Bearer ${token}`);
    expect(getAfterDelete.status).toBe(404);
  });

  it('plans CRUD requires manageSubscriptions permission', async () => {
    const org = await createOrg();
    const operator = await createUser('OPERATOR', String(org._id));
    const orgAdmin = await createUser('ORGANIZATION_ADMIN', String(org._id));
    const opToken = await tokenFor(operator);
    const oaToken = await tokenFor(orgAdmin);

    const unauth = await request(app).get('/api/plans');
    expect(unauth.status).toBe(401);

    const forbidden = await request(app)
      .get('/api/plans')
      .set('authorization', `Bearer ${opToken}`);
    expect(forbidden.status).toBe(403);

    const oaForbidden = await request(app)
      .post('/api/plans')
      .set('authorization', `Bearer ${oaToken}`)
      .send({ name: 'Nope', price: 1 });
    expect(oaForbidden.status).toBe(403);
  });
});

describe('admin guest-leads list/get (§8)', () => {
  it('super admin lists guest leads with search + status filters (paginated)', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);
    const { leads } = await seedGuestLeads();

    const list = await request(app)
      .get('/api/guest-leads?page=1&limit=10')
      .set('authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.total_results).toBe(3);

    const search = await request(app)
      .get('/api/guest-leads?search=alice')
      .set('authorization', `Bearer ${token}`);
    expect(search.body.data.total_results).toBe(1);
    expect(search.body.data.results[0].email).toBe('alice@example.com');

    const byStatus = await request(app)
      .get('/api/guest-leads?status=success')
      .set('authorization', `Bearer ${token}`);
    expect(byStatus.body.data.results[0].first_name).toBe('Bob');

    const scoped = await request(app)
      .get(`/api/guest-leads?organization_id=${leads[2].organization_id}`)
      .set('authorization', `Bearer ${token}`);
    expect(scoped.body.data.total_results).toBe(1);
    expect(scoped.body.data.results[0].email).toBe('cara@example.com');
  });

  it('get single guest lead populates plan', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);
    const { leads, plan } = await seedGuestLeads();

    const res = await request(app)
      .get(`/api/guest-leads/${leads[1]._id}`)
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.lead.plan_id.name).toBe(plan.name);
    expect(res.body.data.lead.status).toBe('success');
  });

  it('guest-leads requires manageGuestLeads (super admin only)', async () => {
    const org = await createOrg();
    const operator = await createUser('OPERATOR', String(org._id));
    const orgAdmin = await createUser('ORGANIZATION_ADMIN', String(org._id));

    const unauth = await request(app).get('/api/guest-leads');
    expect(unauth.status).toBe(401);

    const opForbidden = await request(app)
      .get('/api/guest-leads')
      .set('authorization', `Bearer ${await tokenFor(operator)}`);
    expect(opForbidden.status).toBe(403);

    const oaForbidden = await request(app)
      .get('/api/guest-leads')
      .set('authorization', `Bearer ${await tokenFor(orgAdmin)}`);
    expect(oaForbidden.status).toBe(403);
  });
});