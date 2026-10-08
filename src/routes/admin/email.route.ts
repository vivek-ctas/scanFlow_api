import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as validation from '../../validations/admin/email.validations.js';
import * as controller from '../../controllers/admin/email.controller.js';

const router = Router();

router.post(
  '/resend-welcome',
  auth('manageSubscriptions'),
  validate(validation.resendWelcome),
  controller.resendWelcome,
);

router.post(
  '/resend-renewal',
  auth('manageSubscriptions'),
  validate(validation.resendRenewal),
  controller.resendRenewal,
);

router.post(
  '/test',
  auth('manageSubscriptions'),
  validate(validation.sendTest),
  controller.sendTest,
);

export const emailRouter = router;
