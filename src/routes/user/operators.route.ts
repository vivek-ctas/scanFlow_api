import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as validation from '../../validations/user/operators.validations.js';
import * as controller from '../../controllers/user/operators.controller.js';

const router = Router();

router
  .route('/')
  .get(
    auth('viewOperators'),
    validate(validation.listOperators),
    controller.listOperators,
  )
  .post(
    auth('manageOperators'),
    validate(validation.createOperator),
    controller.createOperator,
  );

router
  .route('/:operatorId')
  .get(
    auth('viewOperators'),
    validate(validation.getOperator),
    controller.getOperator,
  )
  .put(
    auth('manageOperators'),
    validate(validation.updateOperator),
    controller.updateOperator,
  )
  .delete(
    auth('manageOperators'),
    validate(validation.deleteOperator),
    controller.deleteOperator,
  );

router.patch(
  '/:operatorId/role',
  auth('manageOperators'),
  validate(validation.operatorRole),
  controller.operatorRole,
);

router.post(
  '/:operatorId/update-status',
  auth('manageOperators'),
  validate(validation.operatorStatus),
  controller.operatorStatus,
);

export const operatorsRouter = router;
