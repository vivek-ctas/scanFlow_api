import httpStatus from 'http-status';
import { catchAsync } from '../utils/catchAsync.js';
import { ApiError } from '../utils/ApiError.js';
import * as publicCheckoutService from '../services/public-checkout.service.js';
import { processGatewaySuccess } from '../services/payment.service.js';
import {
  constructStripeEvent,
  isStripeConfigured,
} from '../services/stripe.service.js';
import {
  verifyRazorpayWebhookSignature,
  verifyRazorpayPaymentSignature,
} from '../services/razorpay.service.js';
import { logger } from '../config/logger.js';
import { Request, Response } from 'express';

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export const createLead = catchAsync(async (req: Request, res: Response) => {
  const result = await publicCheckoutService.createLead(req.body);
  res.status(result.status).json(result);
});

export const createCheckout = catchAsync(
  async (req: Request, res: Response) => {
    const result = await publicCheckoutService.createCheckout(req.body);
    res.status(result.status).json(result);
  },
);

export const stripeWebhook = catchAsync(async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'];
  if (!signature || Array.isArray(signature)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Missing stripe signature');
  }
  if (!isStripeConfigured()) {
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Stripe is not configured',
    );
  }
  let event: any;
  try {
    event = constructStripeEvent(
      (req as RawBodyRequest).rawBody as Buffer,
      signature,
    );
  } catch (err: any) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Stripe signature verification failed: ${err.message}`,
    );
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object ?? {};
    if (!session.id) {
      logger.warn('[STRIPE] checkout.session.completed without session.id');
      return res.status(httpStatus.OK).json({ received: true });
    }
    await processGatewaySuccess({
      orderId: session.id,
      transactionId: event.id,
      gateway: 'stripe',
      successPayload: session,
      amount: (session.amount_total ?? 0) / 100,
      currency: session.currency ?? 'usd',
    });
  }

  res.status(httpStatus.OK).json({ received: true });
});

export const razorpayWebhook = catchAsync(
  async (req: Request, res: Response) => {
    const signature = req.headers['x-razorpay-signature'];
    if (typeof signature !== 'string') {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Missing Razorpay signature');
    }
    try {
      if (
        !verifyRazorpayWebhookSignature(
          (req as RawBodyRequest).rawBody as Buffer,
          signature,
        )
      ) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'Invalid Razorpay signature',
        );
      }
    } catch (err: any) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, err.message);
    }

    const body: any = req.body;
    const event = body?.event;
    const paymentEntity = body?.payload?.payment?.entity;

    if (event === 'payment.captured' && paymentEntity) {
      if (
        !verifyRazorpayPaymentSignature(
          String(paymentEntity.order_id),
          String(paymentEntity.id),
          signature,
        )
      ) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'Invalid Razorpay signature',
        );
      }

      if (paymentEntity.status !== 'captured') {
        return res.status(httpStatus.OK).json({ received: true });
      }

      await processGatewaySuccess({
        orderId: String(paymentEntity.order_id),
        transactionId: String(paymentEntity.id),
        gateway: 'razorpay',
        successPayload: body.payload,
        amount: (paymentEntity.amount ?? 0) / 100,
        currency: paymentEntity.currency ?? 'INR',
      });
    }

    res.status(httpStatus.OK).json({ received: true });
  },
);
