import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { createAdminUser, createPlan, createCountry } from './helpers.js';
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
    await createCountry();

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

  it('normalizes a legacy country name and a country code to the canonical name', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    await createCountry({
      country_code: 'TUR',
      country_name: 'Türkiye',
      currency_code: 'TRY',
      aliases: ['Turkey'],
    });

    const byAlias = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Ali',
        last_name: 'Kaya',
        company_name: 'Kaya Trading',
        email: 'ali@kaya.com',
        country_name: 'Turkey',
      });
    expect(byAlias.status).toBe(201);
    expect(byAlias.body.data.organization.country_name).toBe('Türkiye');
    const aliasAdmin: any = await User.findById(byAlias.body.data.admin.id);
    expect(aliasAdmin?.country_name).toBe('Türkiye');

    const byCode = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Elif',
        last_name: 'Demir',
        company_name: 'Demir Ltd',
        email: 'elif@demir.com',
        country_name: 'TUR',
      });
    expect(byCode.status).toBe(201);
    expect(byCode.body.data.organization.country_name).toBe('Türkiye');
  });

  it('resolves formatting-only variants (case, padding, accents, punctuation)', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    await createCountry({
      country_code: 'CIV',
      country_name: 'Ivory Coast',
      currency_code: 'XOF',
      aliases: ["Cote d'Ivoire"],
    });

    const res = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Aya',
        last_name: 'Koné',
        company_name: 'Koné SARL',
        email: 'aya@kone.com',
        country_name: "  cote d'ivoire ",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.organization.country_name).toBe('Ivory Coast');
  });

  it('drops an unrecognised country instead of persisting free text', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    await createCountry();

    const res = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Mia',
        last_name: 'Marsh',
        company_name: 'Marsh Co',
        email: 'mia@marsh.com',
        country_name: 'Not A Real Country',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.organization.country_name).toBeUndefined();
  });

  it('update canonicalizes the country and cascades it to the admin user', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    await createCountry();
    await createCountry({
      country_code: 'SWZ',
      country_name: 'Eswatini',
      currency_code: 'SZL',
      aliases: ['Swaziland'],
    });

    const created = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Nomsa',
        last_name: 'Dlamini',
        company_name: 'Dlamini Group',
        email: 'nomsa@dlamini.com',
        country_name: 'India',
      });
    expect(created.status).toBe(201);
    const orgId = created.body.data.organization.id;
    const adminUserId = created.body.data.admin.id;

    const updated = await request(app)
      .put(`/api/organizations/${orgId}`)
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({ country_name: 'Swaziland' });

    expect(updated.status).toBe(200);
    expect(updated.body.data.organization.country_name).toBe('Eswatini');
    const persistedAdmin: any = await User.findById(adminUserId);
    expect(persistedAdmin?.country_name).toBe('Eswatini');
  });

  it('leaves an existing country untouched when the update value is unrecognised', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    await createCountry();

    const created = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Raj',
        last_name: 'Iyer',
        company_name: 'Iyer Textiles',
        email: 'raj@iyer.com',
        country_name: 'India',
      });
    const orgId = created.body.data.organization.id;

    const updated = await request(app)
      .put(`/api/organizations/${orgId}`)
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({ country_name: 'Atlantis' });

    expect(updated.status).toBe(200);
    expect(updated.body.data.organization.country_name).toBe('India');
  });

  it('GET detail returns the canonical country on org and nested admin', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    await createCountry({
      country_code: 'KOR',
      country_name: 'South Korea',
      currency_code: 'KRW',
      aliases: ['Republic of Korea'],
    });

    const created = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Min',
        last_name: 'Kim',
        company_name: 'Kim Electronics',
        email: 'min@kim.com',
        country_name: 'Republic of Korea',
      });
    const orgId = created.body.data.organization.id;

    const detail = await request(app)
      .get(`/api/organizations/${orgId}`)
      .set('authorization', `Bearer ${tokens.access_token}`);

    expect(detail.status).toBe(200);
    expect(detail.body.data.organization.country_name).toBe('South Korea');
    expect(detail.body.data.organization.admin.country_name).toBe('South Korea');
  });

  it('honours start_date when the first subscription activates immediately', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    const plan = await createPlan({ scan_limit: 9, billing_cycle: 'month' });
    await createCountry();

    const res = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Sara',
        last_name: 'Klein',
        company_name: 'Klein GmbH',
        email: 'sara@klein.com',
        country_name: 'India',
        plan_id: String(plan._id),
        billing_cycle: 'month',
        start_date: '2030-03-15',
      });

    expect(res.status).toBe(201);
    const subscription = res.body.data.subscription;
    expect(subscription.status).toBe('active');
    expect(new Date(subscription.started_at).toISOString().slice(0, 10)).toBe(
      '2030-03-15',
    );
    // One month is added to the chosen start, not to today.
    expect(new Date(subscription.expires_at).toISOString().slice(0, 10)).toBe(
      '2030-04-15',
    );
  });

  it('rejects an unparseable start_date rather than guessing a date', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    const plan = await createPlan({ scan_limit: 9, billing_cycle: 'month' });

    const res = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Omar',
        last_name: 'Haddad',
        company_name: 'Haddad Co',
        email: 'omar@haddad.com',
        plan_id: String(plan._id),
        start_date: 'not-a-date',
      });

    expect(res.status).toBe(400);
    expect(await Organization.findOne({ email: 'omar@haddad.com' })).toBeNull();
  });

  it('treats an empty start_date as "start now"', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    const plan = await createPlan({ scan_limit: 9, billing_cycle: 'month' });

    const res = await request(app)
      .post('/api/organizations')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({
        first_name: 'Lena',
        last_name: 'Fischer',
        company_name: 'Fischer AG',
        email: 'lena@fischer.com',
        plan_id: String(plan._id),
        start_date: '',
      });

    expect(res.status).toBe(201);
    const startedAt = new Date(res.body.data.subscription.started_at).getTime();
    expect(Math.abs(Date.now() - startedAt)).toBeLessThan(60_000);
  });
});