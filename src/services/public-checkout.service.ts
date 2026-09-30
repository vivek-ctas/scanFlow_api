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

  // The plan decides its cycle; an explicit request is only honoured when it matches.
  let price: number;
  let cycle: BillingCycle;
  try {
    ({ price, billingCycle: cycle } = resolvePlanPrice(plan, billing_cycle));
  } catch {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      planPriceErrorMessage(
        plan,
        billing_cycle ?? plan.billing_cycle ?? 'month',
      ),
    );
  }

  const lead = await GuestLead.create({
    first_name,
    last_name,
    email: normalizeEmail(email),
    contact_number,
    company_name,
    country_name,
    plan_id: plan._id,
    billing_cycle: cycle,
    currency_code: cartCurrency(plan.currency),
    trial_days: plan.trial_days,
    status: 'initiated',
  });

  const currency = cartCurrency(plan.currency);
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
      currency,
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
  (currency || 'inr').toUpperCase();
