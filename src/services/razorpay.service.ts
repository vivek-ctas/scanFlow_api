import crypto from 'crypto';
import Razorpay from 'razorpay';
import config from '../config/config.js';

export interface RazorpayOrder {
  id: string;
  amount: number;
  amount_paid?: number;
  currency: string;
  receipt?: string;
  status?: string;
}

export const isRazorpayConfigured = () =>
  Boolean(config.razorpay.keyId && config.razorpay.keySecret);

const getRazorpay = (): Razorpay => {
  if (!isRazorpayConfigured()) {
    throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not configured');
  }
  return new Razorpay({
    key_id: config.razorpay.keyId!,
    key_secret: config.razorpay.keySecret!,
  });
};

export const createRazorpayOrder = async ({
  leadId,
  amountMinor,
  currency,
}: {
  leadId: string;
  amountMinor: number;
  currency: string;
}): Promise<RazorpayOrder> => {
  const client: any = getRazorpay();
  const order = await client.orders.create({
    amount: amountMinor,
    currency,
    receipt: String(leadId),
    payment_capture: 1,
  });
  return order as RazorpayOrder;
};

export const fetchRazorpayOrder = async (
  orderId: string,
): Promise<RazorpayOrder> => {
  const client: any = getRazorpay();
  const order = await client.orders.fetch(orderId);
  return order as RazorpayOrder;
};

/** Webhook signature: HMAC-SHA256 over the raw request body. */
export const verifyRazorpayWebhookSignature = (
  rawBody: Buffer,
  signature?: string,
): boolean => {
  if (!config.razorpay.webhookSecret) {
    throw new Error('RAZORPAY_WEBHOOK_SECRET is not configured');
  }
  if (!signature) {
    return false;
  }
  const expected = crypto
    .createHmac('sha256', config.razorpay.webhookSecret)
    .update(rawBody.toString())
    .digest('hex');
  return expected === signature;
};

/** Order-completion signature over order_id + '|' + payment_id (§6.2). */
export const verifyRazorpayPaymentSignature = (
  orderId: string,
  paymentId: string,
  signature: string,
): boolean => {
  if (!config.razorpay.webhookSecret) {
    throw new Error('RAZORPAY_WEBHOOK_SECRET is not configured');
  }
  const expected = crypto
    .createHmac('sha256', config.razorpay.webhookSecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === signature;
};
