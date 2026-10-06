import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { createPlan } from './helpers.js';
import { GuestLead, Payment } from '../src/models/index.js';

/**
 * The marketing website checkout runs in two steps: `POST /public-checkout/lead`
 * records the buyer, then a payment step consumes the `lead_id`. These tests pin
 * the public contract of step 1 plus the public pricing-page plan list.
 */
describe('public plans list + lead-only checkout step', () => {
  describe('GET /plans/public/plans', () => {
    it('serves active, non-custom plans without authentication', async () => {
      await createPlan({ name: 'Starter', price: 29, trial_days: 14 });
      await createPlan({
        name: 'Pro',
        price: 99,
        is_popular: true,
        billing_cycle: 'quarterly',
      });

      const res = await request(app).get('/api/plans/public/plans');

      expect(res.status).toBe(200);
      const plans = res.body.data.plans;
      expect(plans).toHaveLength(2);
      // Cheapest first.
      expect(plans.map((p: any) => p.name)).toEqual(['Starter', 'Pro']);
      expect(plans[0]).toMatchObject({
        price: 29,
        billing_cycle: 'month',
        trial_days: 14,
      });
    });

    it('hides inactive, custom and deleted plans', async () => {
      await createPlan({ name: 'Active', price: 10 });
      await createPlan({ name: 'Inactive', price: 11, status: 0 });
      await createPlan({ name: 'Custom', price: 12, is_custom_plan: true });
      await createPlan({ name: 'Deleted', price: 13, status: 2 });

      const res = await request(app).get('/api/plans/public/plans');

      expect(res.status).toBe(200);
      expect(res.body.data.plans.map((p: any) => p.name)).toEqual(['Active']);
    });

    it('still requires auth on the admin plan list', async () => {
      const res = await request(app).get('/api/plans');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /public-checkout/lead', () => {
    it('creates a pending lead with the server-resolved plan quote', async () => {
      const plan = await createPlan({
        name: 'Pro',
        price: 99,
        trial_days: 14,
        currency: 'usd',
      });

      const res = await request(app).post('/api/public-checkout/lead').send({
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ADA@Example.COM',
        contact_number: '+15551234567',
        company_name: 'Analytical Engines',
        country_name: 'United Kingdom',
        plan_id: plan._id,
      });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        status: 'pending',
        plan: {
          name: 'Pro',
          billing_cycle: 'month',
          price: 99,
          currency: 'USD',
          trial_days: 14,
        },
      });

      const lead = await GuestLead.findById(res.body.data.lead_id);
      expect(lead?.email).toBe('ada@example.com');
      expect(lead?.status).toBe('pending');
      // The quote echoes upper-case; the column lowercases on write.
      expect(lead?.currency_code).toBe('usd');
      // No payment session is created at this step.
      expect(await Payment.countDocuments()).toBe(0);
    });

    it('defaults to the plan cycle and honours a matching explicit cycle', async () => {
      const plan = await createPlan({
        price: 90,
        price_quarterly: 240,
        billing_cycle: 'quarterly',
      });

      const omitted = await request(app)
        .post('/api/public-checkout/lead')
        .send({
          first_name: 'A',
          last_name: 'B',
          email: 'a@example.com',
          plan_id: plan._id,
        });
      expect(omitted.status).toBe(201);
      expect(omitted.body.data.plan.billing_cycle).toBe('quarterly');
      expect(omitted.body.data.plan.price).toBe(240);

      const explicit = await request(app)
        .post('/api/public-checkout/lead')
        .send({
          first_name: 'A',
          last_name: 'B',
          email: 'b@example.com',
          plan_id: plan._id,
          billing_cycle: 'quarterly',
        });
      expect(explicit.status).toBe(201);
    });

    it('rejects a cycle the plan is not sold on', async () => {
      const plan = await createPlan({ price: 99, billing_cycle: 'month' });

      const res = await request(app).post('/api/public-checkout/lead').send({
        first_name: 'A',
        last_name: 'B',
        email: 'a@example.com',
        plan_id: plan._id,
        billing_cycle: 'quarterly',
      });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/only available on the monthly/i);
      expect(await GuestLead.countDocuments()).toBe(0);
    });

    it('rejects inactive, custom and unknown plans', async () => {
      const inactive = await createPlan({ status: 0 });
      const custom = await createPlan({ is_custom_plan: true });

      for (const planId of [inactive._id, custom._id]) {
        const res = await request(app)
          .post('/api/public-checkout/lead')
          .send({
            first_name: 'A',
            last_name: 'B',
            email: 'a@example.com',
            plan_id: planId,
          });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/plan not found or not available/i);
      }

      const badId = await request(app)
        .post('/api/public-checkout/lead')
        .send({
          first_name: 'A',
          last_name: 'B',
          email: 'a@example.com',
          plan_id: 'not-an-object-id',
        });
      expect(badId.status).toBe(400);
    });

    it('does not accept gateway fields — payment is a later step', async () => {
      const plan = await createPlan({ price: 10 });

      const res = await request(app)
        .post('/api/public-checkout/lead')
        .send({
          first_name: 'A',
          last_name: 'B',
          email: 'a@example.com',
          plan_id: plan._id,
          gateway: 'stripe',
        });

      expect(res.status).toBe(400);
      expect(await GuestLead.countDocuments()).toBe(0);
    });
  });
});
