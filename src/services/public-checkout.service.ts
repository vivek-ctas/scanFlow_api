import httpStatus from 'http-status';
import config from '../config/config.js';
import { Plan } from '../models/plan.model.js';
import { GuestLead } from '../models/guest-lead.model.js';
import { Payment, PaymentGateway } from '../models/payment.model.js';
import { ApiError } from '../utils/ApiError.js';
import { createResponse, normalizeEmail } from './common.service.js';
import { isStripeConfigured, createCheckoutSession } from './stripe.service.js';
import {
  isRazorpayConfigured,
  createRazorpayOrder,
} from './razorpay.service.js';

export const createCheckout = async ({
  firstName,
  lastName,
  email,
  phone,
  company,
  planId,
  gateway,
  successUrl,
  cancelUrl,
}: {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  company?: string;
  planId: string;
  gateway: PaymentGateway;
  successUrl: string;
  cancelUrl: string;
}) => {
  const plan = await Plan.findOne({
    _id: planId,
    isActive: true,
    isPublic: true,
  });
  if (!plan) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Plan not found or not available',
    );
  }

  const lead = await GuestLead.create({
    firstName,
    lastName,
    email: normalizeEmail(email),
    phone,
    company,
    planId: plan._id,
    trialDays: plan.trialDays,
    status: 'initiated',
  });

  const currency = plan.currency || 'INR';
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
      amount: plan.amount,
      currency,
      successUrl,
      cancelUrl,
    });
    if (session.url) {
      lead.purchaseLink = session.url;
    }
    checkout = { gateway: 'stripe', sessionId: session.id, url: session.url };
  } else if (gateway === 'razorpay') {
    if (!isRazorpayConfigured()) {
      throw new ApiError(
        httpStatus.SERVICE_UNAVAILABLE,
        'Razorpay is not configured',
      );
    }
    const order = await createRazorpayOrder({
      leadId: String(lead._id),
      amountMinor: Math.round(plan.amount * 100),
      currency,
    });
    checkout = {
      gateway: 'razorpay',
      orderId: order.id,
      amount: order.amount,
      currency,
      keyId: config.razorpay.keyId,
    };
  } else {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid payment gateway');
  }

  await lead.save();

  await Payment.create({
    leadId: lead._id,
    gateway,
    amount: plan.amount,
    gatewayAmount: Math.round(plan.amount * 100),
    currency,
    status: 'CREATED',
  });

  return createResponse(httpStatus.CREATED, 'Checkout initiated.', {
    lead,
    checkout,
  });
};
