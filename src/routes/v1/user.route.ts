import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as userValidation from '../../validations/user.validation.js';
import * as userController from '../../controllers/user.controller.js';

const router = Router();

router
  .route('/')
  .get(
    auth('manageUsers'),
    validate(userValidation.listUsers),
    userController.listUsers,
  );

export const userRouter = router;
