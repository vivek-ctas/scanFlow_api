import Stripe from 'stripe';
import config from '../config/config.js';

export const isStripeConfigured = () => Boolean(config.stripe.secretKey);

export const getStripe = (): Stripe => {
  if (!isStripeConfigured()) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  return new Stripe(config.stripe.secretKey!);
};

export const createCheckoutSession = async ({
  leadId,
  amount,
  currency,
  successUrl,
  cancelUrl,
}: {
  leadId: string;
  amount: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<Stripe.Checkout.Session> => {
  const stripe = getStripe();
  return stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency,
          product_data: { name: 'ScanFlow Subscription' },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      },
    ],
    metadata: { lead_id: leadId },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
};

export const constructStripeEvent = (
  rawBody: Buffer,
  signature: string,
): Stripe.Event => {
  if (!config.stripe.webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }
  return getStripe().webhooks.constructEvent(
    rawBody,
    signature,
    config.stripe.webhookSecret,
  );
};
