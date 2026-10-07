import httpStatus from 'http-status';
import config from '../config/config.js';
import { Plan } from '../models/plan.model.js';
import { GuestLead } from '../models/guest-lead.model.js';
import { Payment, PaymentGateway } from '../models/payment.model.js';
import { ApiError } from '../utils/ApiError.js';
import {
  createResponse,
  normalizeEmail,
  toObjectId,
} from './common.service.js';
import {
  planPriceErrorMessage,
  resolvePlanPrice,
} from '../utils/plan-features.util.js';
import { isStripeConfigured, createCheckoutSession } from './stripe.service.js';
import {
  isRazorpayConfigured,
  createRazorpayOrder,
} from './razorpay.service.js';

type BillingCycle = 'month' | 'quarterly';

const resolveCheckoutPlan = async (
  plan_id: string,
  requestedCycle?: BillingCycle,
): Promise<{
  plan: any;
  price: number;
  cycle: BillingCycle;
  currency: string;
}> => {
  const plan = await Plan.findOne({
    _id: toObjectId(plan_id),
    status: 1,
    is_custom_plan: false,
  });
  if (!plan) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Plan not found or not available',
    );
  }

  let price: number;
  let cycle: BillingCycle;
  try {
    ({ price, billingCycle: cycle } = resolvePlanPrice(plan, requestedCycle));
  } catch {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      planPriceErrorMessage(
        plan,
        requestedCycle ?? plan.billing_cycle ?? 'month',
      ),
    );
  }

  return { plan, price, cycle, currency: cartCurrency(plan.currency) };
};

export const createLead = async ({
  first_name,
  last_name,
  email,
  contact_number,
  company_name,
  country_name,
  plan_id,
  billing_cycle,
}: {
  first_name: string;
  last_name: string;
  email: string;
  contact_number?: string;
  company_name?: string;
  country_name?: string;
  plan_id: string;
  billing_cycle?: BillingCycle;
}) => {
  const { plan, price, cycle, currency } = await resolveCheckoutPlan(
    plan_id,
    billing_cycle,
  );

  const lead = await GuestLead.create({
    first_name,
    last_name,
    email: normalizeEmail(email),
    contact_number,
    company_name,
    country_name,
    plan_id: plan._id,
    billing_cycle: cycle,
    currency_code: currency,
    trial_days: plan.trial_days,
    status: 'pending',
  });

  return createResponse(httpStatus.CREATED, 'Lead created successfully.', {
    lead_id: lead._id,
    status: lead.status,
    plan: {
      name: plan.name,
      billing_cycle: cycle,
      price,
      currency,
      trial_days: plan.trial_days,
    },
  });
};

export const createCheckout = async ({
  first_name,
  last_name,
  email,
  contact_number,
  company_name,
  country_name,
  plan_id,
  billing_cycle,
  gateway,
  success_url,
  cancel_url,
}: {
  first_name: string;
  last_name: string;
  email: string;
  contact_number?: string;
  company_name?: string;
  country_name?: string;
  plan_id: string;
  billing_cycle?: BillingCycle;
  gateway: PaymentGateway;
  success_url: string;
  cancel_url: string;
}) => {
  const { plan, price, cycle, currency } = await resolveCheckoutPlan(
    plan_id,
    billing_cycle,
  );

  const lead = await GuestLead.create({
    first_name,
    last_name,
    email: normalizeEmail(email),
    contact_number,
    company_name,
    country_name,
    plan_id: plan._id,
    billing_cycle: cycle,
    currency_code: currency,
    trial_days: plan.trial_days,
    status: 'initiated',
  });

  let checkout: Record<string, any> = { gateway };

  if (gateway === 'stripe') {
    if (!isStripeConfigured()) {
      throw new ApiError(
        httpStatus.SERVICE_UNAVAILABLE,
        'Stripe is not configured',
      );
    }
    const session = await createCheckoutSession({
      leadId: String(lead._id),
      amount: price,
      currency: currency.toLowerCase(),
      successUrl: success_url,
      cancelUrl: cancel_url,
    });
    checkout = {
      gateway: 'stripe',
      session_id: session.id,
      url: session.url,
    };
  } else if (gateway === 'razorpay') {
    if (!isRazorpayConfigured()) {
      throw new ApiError(
        httpStatus.SERVICE_UNAVAILABLE,
        'Razorpay is not configured',
      );
    }
    const order = await createRazorpayOrder({
      leadId: String(lead._id),
      amountMinor: Math.round(price * 100),
      currency,
    });
    checkout = {
      gateway: 'razorpay',
      order_id: order.id,
      amount: order.amount,
      currency,
      key_id: config.razorpay.keyId,
    };
  } else {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid payment gateway');
  }

  const payment = await Payment.create({
    lead_id: lead._id,
    plan_id: plan._id,
    gateway,
    order_id: checkout.session_id ?? checkout.order_id,
    price,
    currency_code: currency,
    billing_cycle: cycle,
    status: 'CREATED',
  });

  return createResponse(httpStatus.CREATED, 'Checkout initiated.', {
    lead,
    checkout,
    payment: { _id: payment._id, status: payment.status },
  });
};

const cartCurrency = (currency?: string): string =>
  (currency || 'usd').toUpperCase();
