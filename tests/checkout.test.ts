import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import {
  createOrg,
  createPlan,
  createAdminUser,
  createUser,
  grant,
} from './helpers.js';
import { GuestLead, Organization, Payment, Subscription } from '../src/models/index.js';

const state = vi.hoisted(() => {
  return {
    leadId: '' as string,
    stripeConstruct: vi.fn(),
    stripeSession: vi.fn(),
    razorVerifyWebhook: vi.fn(),
    razorVerifyPayment: vi.fn(),
    razorFetchOrder: vi.fn(),
    razorCreateOrder: vi.fn(),
  };
});

vi.mock('../src/services/stripe.service.js', () => ({
  isStripeConfigured: () => true,
  getStripe: () => ({}),
  createCheckoutSession: state.stripeSession,
  constructStripeEvent: state.stripeConstruct,
}));

vi.mock('../src/services/razorpay.service.js', () => ({
  isRazorpayConfigured: () => true,
  getRazorpay: () => ({}),
  createRazorpayOrder: state.razorCreateOrder,
  fetchRazorpayOrder: state.razorFetchOrder,
  verifyRazorpayWebhookSignature: state.razorVerifyWebhook,
  verifyRazorpayPaymentSignature: state.razorVerifyPayment,
}));

describe('public checkout + gateway provisioning (§6/§7)', () => {
  beforeEach(() => {
    state.leadId = '';
    state.stripeSession.mockReset().mockImplementation(async () => ({
      id: 'cs_test',
      url: 'https://checkout.stripe.com/test',
    }));
    state.stripeConstruct.mockReset().mockImplementation((_body, signature) => {
      if (signature !== 'valid') {
        throw new Error('Bad signature');
      }
      return {
        type: 'checkout.session.completed',
        id: `evt_${state.leadId}`,
        data: {
          object: {
            metadata: { lead_id: state.leadId },
            amount_total: 1000,
            currency: 'inr',
          },
        },
      };
    });
    state.razorCreateOrder.mockReset().mockImplementation(async ({ leadId }) => ({
      id: 'order_test',
      amount: 1000,
      receipt: String(leadId),
    }));
    state.razorVerifyWebhook.mockReset().mockImplementation((_body, sig) => sig === 'valid');
    state.razorVerifyPayment.mockReset().mockReturnValue(true);
    state.razorFetchOrder.mockReset().mockImplementation(async (orderId) => ({
      id: orderId,
      receipt: state.leadId,
    }));
  });

  const seedLead = async (gateway = 'stripe') => {
    const plan = await createPlan({ amount: 10 });
    const lead = await GuestLead.create({
      firstName: 'First',
      lastName: 'Guest',
      email: 'guest-pay@example.com',
      phone: '9999999999',
      company: 'Guest Co',
      planId: plan._id,
      trialDays: plan.trialDays,
      status: 'initiated',
    });
    state.leadId = String(lead._id);
    return { plan, lead };
  };

  it('checkout endpoint creates an initiated lead + CREATED payment row', async () => {
    const plan = await createPlan({ amount: 10 });
    const res = await request(app)
      .post('/api/public-checkout/subscribe')
      .send({
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
        phone: '8888888888',
        company: 'Jane Co',
        planId: String(plan._id),
        gateway: 'stripe',
        successUrl: 'https://app.example.com/success',
        cancelUrl: 'https://app.example.com/cancel',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.lead.status).toBe('initiated');
    expect(res.body.data.checkout.sessionId).toBe('cs_test');
    const payment = await Payment.findOne({ gateway: 'stripe', status: 'CREATED' });
    expect(payment).toBeTruthy();
  });

  it('9. stripe webhook provisions org + active subscription exactly once', async () => {
    const { lead } = await seedLead('stripe');
    const first = await request(app)
      .post('/api/public-checkout/webhooks/stripe')
      .set('stripe-signature', 'valid')
      .send({ some: 'payload' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/public-checkout/webhooks/stripe')
      .set('stripe-signature', 'valid')
      .send({ some: 'payload' });
    expect(second.status).toBe(200);

    const orgs = await Organization.find({ email: lead.email });
    expect(orgs).toHaveLength(1);
    const subs = await Subscription.find({ organizationId: orgs[0]?._id });
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe('active');
    const payments = await Payment.find({ gatewayEventId: 'evt_' + lead._id });
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('TXN_SUCCESS');
    const refreshed = await GuestLead.findById(lead._id);
    expect(refreshed?.status).toBe('success');
  });

  it('10. razorpay webhook provisions exactly once (and reuses existing org)', async () => {
    const { plan, lead } = await seedLead('razorpay');
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: 'pay_123', order_id: 'order_test', amount: 1000, currency: 'INR', status: 'captured' },
        },
        order: { entity: { receipt: String(lead._id) } },
      },
    });
    const post = () =>
      request(app)
        .post('/api/public-checkout/webhooks/razorpay')
        .set('x-razorpay-signature', 'valid')
        .set('content-type', 'application/json')
        .send(body);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);

    const orgs = await Organization.find({ email: lead.email });
    expect(orgs).toHaveLength(1);
    expect(await Subscription.countDocuments({ organizationId: orgs[0]?._id })).toBe(1);
    const payments = await Payment.find({ gatewayEventId: 'pay_123' });
    expect(payments).toHaveLength(1);

    // second payment reuses the existing org (fresh lead, same email)
    const lead2 = await GuestLead.create({
      firstName: 'Second',
      lastName: 'Guest',
      email: lead.email,
      planId: plan._id,
      trialDays: plan.trialDays,
      status: 'initiated',
    });
    state.leadId = String(lead2._id);
    const body2 = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: 'pay_456', order_id: 'order_test2', amount: 2000, currency: 'INR', status: 'captured' } },
        order: { entity: { receipt: String(lead2._id) } },
      },
    });
    const res2 = await request(app)
      .post('/api/public-checkout/webhooks/razorpay')
      .set('x-razorpay-signature', 'valid')
      .set('content-type', 'application/json')
      .send(body2);
    expect(res2.status).toBe(200);
    expect(await Organization.countDocuments({ email: lead.email })).toBe(1);
    expect(await Payment.countDocuments({ leadId: lead2._id })).toBe(1);
  });

  it('11. duplicate gateway event id is idempotent (no double provision)', async () => {
    const { lead } = await seedLead('stripe');
    const post = () =>
      request(app)
        .post('/api/public-checkout/webhooks/stripe')
        .set('stripe-signature', 'valid')
        .send({});
    await post();
    await post();
    await post();
    expect(await Organization.countDocuments({ email: lead.email })).toBe(1);
    expect(await Subscription.countDocuments()).toBe(1);
    expect(await Payment.countDocuments({ status: 'TXN_SUCCESS' })).toBe(1);
  });

  it('12. invalid signatures are rejected with 400', async () => {
    await seedLead('stripe');
    const stripRes = await request(app)
      .post('/api/public-checkout/webhooks/stripe')
      .set('stripe-signature', 'forged')
      .send({});
    expect(stripRes.status).toBe(400);

    const razorRes = await request(app)
      .post('/api/public-checkout/webhooks/razorpay')
      .set('x-razorpay-signature', 'forged')
      .send({ event: 'payment.captured', payload: { payment: { entity: { id: 'p', order_id: 'o', status: 'captured' } } } });
    expect(razorRes.status).toBe(400);
  });

  it('13. provisioning failure marks lead failed + payment FAILED, no org/sub', async () => {
    const plan = await createPlan({ isActive: false });
    const lead = await GuestLead.create({
      firstName: 'Fail',
      lastName: 'Lead',
      email: 'fail-lead@example.com',
      planId: plan._id,
      trialDays: 0,
      status: 'initiated',
    });
    state.leadId = String(lead._id);
    const res = await request(app)
      .post('/api/public-checkout/webhooks/stripe')
      .set('stripe-signature', 'valid')
      .send({});
    expect(res.status).toBe(502);
    const refreshed = await GuestLead.findById(lead._id);
    expect(refreshed?.status).toBe('failed');
    const payment = await Payment.findOne({ leadId: lead._id });
    expect(payment?.status).toBe('FAILED');
    expect(await Organization.countDocuments({ email: lead.email })).toBe(1);
    expect(await Subscription.countDocuments()).toBe(0);
  });
});