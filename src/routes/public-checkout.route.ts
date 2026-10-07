import { Router } from 'express';
import { validate } from '../middlewares/validate.js';
import * as validation from '../validations/public-checkout.validations.js';
import * as controller from '../controllers/public-checkout.controller.js';

const router = Router();

router.post('/lead', validate(validation.createLead), controller.createLead);

router.post(
  '/subscribe',
  validate(validation.createCheckout),
  controller.createCheckout,
);

router.post('/webhooks/stripe', controller.stripeWebhook);

router.post('/webhooks/razorpay', controller.razorpayWebhook);

export const publicCheckoutRouter = router;
