import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { createAdminUser, createPlan } from './helpers.js';
import { generateAuthTokens } from '../src/services/token.service.js';
import { User, Organization, Subscription } from '../src/models/index.js';

describe('simple create-org contract (saas-style)', () => {
  it('creates org + admin user + inline subscription from one simple payload', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    const plan = await createPlan({
      scan_limit: 12,
      price_quarterly: 200,
      billing_cycle: 'quarterly',
    });

    const res = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Riya',
        last_name: 'Shah',
        company_name: 'Acme Retail Pvt Ltd',
        email: 'riya@acme.com',
        contact_number: '+91 98200 12345',
        country_name: 'India',
        business_address: 'Mumbai, MH 400001',
        status: 1,
        plan_id: String(plan._id),
        billing_cycle: 'quarterly',
      });

    expect(res.status).toBe(201);
    const { organization, admin: adminUser, subscription } = res.body.data;

    expect(organization.company_name).toBe('Acme Retail Pvt Ltd');
    expect(organization.email).toBe('riya@acme.com');
    expect(organization.contact_number).toBe('+91 98200 12345');
    expect(organization.country_name).toBe('India');
    expect(organization.status).toBe(1);

    const persistedUser = await User.findById(adminUser.id);
    expect(persistedUser?.first_name).toBe('Riya');
    expect(persistedUser?.last_name).toBe('Shah');
    expect(persistedUser?.role).toBe('ORGANIZATION_ADMIN');
    expect(String(persistedUser?.organization_id)).toBe(String(organization.id));
    expect(persistedUser?.company_name).toBe('Acme Retail Pvt Ltd');
    expect(persistedUser?.country_name).toBe('India');
    expect(persistedUser?.business_address).toBe('Mumbai, MH 400001');

    expect(subscription).toBeDefined();
    expect(subscription.status).toBe('active');
    expect(subscription.billing_cycle).toBe('quarterly');
    const persistedSub = await Subscription.findById(subscription.id);
    expect(String(persistedSub?.organization_id)).toBe(String(organization.id));
    expect(persistedSub?.plan_name).toBe('Test Plan');

    const orgDoc = await Organization.findById(organization.id);
    expect(orgDoc).not.toBeNull();
  });

  it('rejects quarterly plan without quarterly pricing and creates no partial data', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    const plan = await createPlan({
      scan_limit: 5,
      price_quarterly: null,
      billing_cycle: 'quarterly',
    });

    const res = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'No',
        last_name: 'Partial',
        company_name: 'Quarterly Co',
        email: 'quarterly@acme.com',
        plan_id: String(plan._id),
        billing_cycle: 'quarterly',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      'Quarterly pricing is not configured for this plan',
    );
    expect(await Organization.findOne({ email: 'quarterly@acme.com' })).toBeNull();
    expect(await User.findOne({ email: 'quarterly@acme.com' })).toBeNull();
  });

  it('rejects a billing_cycle the plan does not sell and creates no partial data', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    const plan = await createPlan({
      scan_limit: 5,
      price_quarterly: 300,
      billing_cycle: 'month',
    });

    const res = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Cycle',
        last_name: 'Mismatch',
        company_name: 'Mismatch Co',
        email: 'mismatch@acme.com',
        plan_id: String(plan._id),
        billing_cycle: 'quarterly',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      'Test Plan is only available on the monthly billing cycle',
    );
    expect(await Organization.findOne({ email: 'mismatch@acme.com' })).toBeNull();
    expect(await User.findOne({ email: 'mismatch@acme.com' })).toBeNull();
  });

  it('omitted billing_cycle falls back to the plan own cycle', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    const plan = await createPlan({
      scan_limit: 7,
      price_quarterly: 180,
      billing_cycle: 'quarterly',
    });

    const res = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Cycle',
        last_name: 'Default',
        company_name: 'Defaulted Co',
        email: 'defaulted@acme.com',
        plan_id: String(plan._id),
      });

    expect(res.status).toBe(201);
    expect(res.body.data.subscription.billing_cycle).toBe('quarterly');
    expect(res.body.data.subscription.plan_price).toBe(180);
  });

  it('creates org + admin (no plan) from simple payload and still matches legacy fallback', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);

    const simple = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Amit',
        last_name: 'Patel',
        company_name: 'Patel Industries',
        email: 'amit@patel.com',
      });
    expect(simple.status).toBe(201);
    expect(simple.body.data.subscription).toBeUndefined();
    expect(simple.body.data.organization.company_name).toBe('Patel Industries');

    const legacy = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        name: 'Legacy Co',
        email: 'billing@legacy.com',
        admin_email: 'boss@legacy.com',
        admin_first_name: 'Old',
        admin_last_name: 'Boss',
      });
    expect(legacy.status).toBe(201);
    expect(legacy.body.data.organization.company_name).toBe('Legacy Co');
    const legacyAdmin = await User.findById(legacy.body.data.admin.id);
    expect(legacyAdmin?.email).toBe('boss@legacy.com');
    expect(String(legacyAdmin?.organization_id)).toBe(
      String(legacy.body.data.organization.id),
    );
  });

  it('update accepts admin-owned fields and cascades them to the org admin user', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    const created = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Riya',
        last_name: 'Shah',
        company_name: 'Acme Retail',
        email: 'riya@acme.com',
      });
    expect(created.status).toBe(201);
    const orgId = created.body.data.organization.id;
    const adminUserId = created.body.data.admin.id;

    const updated = await request(app)
      .put(`/api/organizations/${orgId}`)
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        company_name: 'Acme Retail Plus',
        first_name: 'Riyaansh',
        last_name: 'Saxena',
        business_address: 'Pune, MH 411001',
      });

    expect(updated.status).toBe(200);
    expect(updated.body.data.organization.company_name).toBe('Acme Retail Plus');

    const persistedAdmin: any = await User.findById(adminUserId);
    expect(persistedAdmin?.first_name).toBe('Riyaansh');
    expect(persistedAdmin?.last_name).toBe('Saxena');
    expect(persistedAdmin?.business_address).toBe('Pune, MH 411001');
    // company_name still cascades to both records.
    expect(persistedAdmin?.company_name).toBe('Acme Retail Plus');
    const orgRow: any = await Organization.findById(orgId);
    expect(orgRow?.company_name).toBe('Acme Retail Plus');
  });
});