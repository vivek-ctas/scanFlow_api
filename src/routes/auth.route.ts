import { Router } from 'express';
import { validate } from '../middlewares/validate.js';
import { auth } from '../middlewares/auth.js';
import * as authValidation from '../validations/auth.validation.js';
import * as authController from '../controllers/auth.controller.js';

const router = Router();

router.post(
  '/register',
  validate(authValidation.register),
  authController.register,
);
router.post(
  '/send-otp',
  validate(authValidation.sendOtp),
  authController.sendOtp,
);
router.post(
  '/verify-otp',
  validate(authValidation.verifyOtp),
  authController.verifyOtp,
);
router.post(
  '/refresh-tokens',
  validate(authValidation.refreshTokens),
  authController.refreshTokens,
);
router.post(
  '/logout',
  auth(),
  validate(authValidation.logout),
  authController.logout,
);
router.get('/me', auth(), authController.getMe);

export const authRouter = router;
