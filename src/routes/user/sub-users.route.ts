import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as subUsersValidation from '../../validations/user/sub-users.validations.js';
import * as subUsersController from '../../controllers/user/sub-users.controller.js';

const router = Router();

router.post(
  '/create-sub-user',
  auth('manageSubUsers'),
  validate(subUsersValidation.createSubUser),
  subUsersController.createSubUser,
);

router.get(
  '/get-all-sub-users',
  auth('manageSubUsers'),
  validate(subUsersValidation.listSubUsers),
  subUsersController.listSubUsers,
);

router.get(
  '/sub-user/:subUserId',
  auth('manageSubUsers'),
  validate(subUsersValidation.getSubUser),
  subUsersController.getSubUser,
);

router.put(
  '/update-sub-user/:subUserId',
  auth('manageSubUsers'),
  validate(subUsersValidation.updateSubUser),
  subUsersController.updateSubUser,
);

router.patch(
  '/sub-user-role/:subUserId',
  auth('manageSubUsers'),
  validate(subUsersValidation.subUserRole),
  subUsersController.subUserRole,
);

router.post(
  '/sub-user-status/:subUserId',
  auth('manageSubUsers'),
  validate(subUsersValidation.subUserStatus),
  subUsersController.subUserStatus,
);

router.delete(
  '/sub-user/:subUserId',
  auth('manageSubUsers'),
  validate(subUsersValidation.deleteSubUser),
  subUsersController.deleteSubUser,
);

export const subUsersRouter = router;
