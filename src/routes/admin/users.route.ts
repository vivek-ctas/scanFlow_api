import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as usersValidation from '../../validations/admin/users.validations.js';
import * as usersController from '../../controllers/admin/users.controller.js';

const router = Router();

router
  .route('/')
  .get(
    auth('manageUsers'),
    validate(usersValidation.listUsers),
    usersController.listUsers,
  );

router.get(
  '/get-all/user',
  auth('manageUsers'),
  validate(usersValidation.listUsers),
  usersController.listUsers,
);

router.post(
  '/create-user',
  auth('manageUsers'),
  validate(usersValidation.createUser),
  usersController.createUser,
);

router.get(
  '/:userId',
  auth('manageUsers'),
  validate(usersValidation.getUser),
  usersController.getUserById,
);

router.put(
  '/admin-update/:userId',
  auth('manageUsers'),
  validate(usersValidation.adminUpdateUser),
  usersController.adminUpdateUser,
);

router.patch(
  '/:userId/role',
  auth('manageUsers'),
  validate(usersValidation.updateRole),
  usersController.updateRole,
);

router.post(
  '/:userId/update-status',
  auth('manageUsers'),
  validate(usersValidation.updateStatus),
  usersController.updateUserStatus,
);

router.delete(
  '/:userId',
  auth('manageUsers'),
  validate(usersValidation.getUser),
  usersController.deleteUser,
);

export const usersRouter = router;
