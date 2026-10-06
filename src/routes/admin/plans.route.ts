import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as plansController from '../../controllers/admin/plans.controller.js';
import * as plansValidation from '../../validations/admin/plans.validations.js';

const router = Router();

router.get(
  '/public/plans',
  validate(plansValidation.listPublicPlans),
  plansController.listPublicPlans,
);

router
  .route('/')
  .get(
    auth('manageSubscriptions'),
    validate(plansValidation.listPlans),
    plansController.listPlans,
  )
  .post(
    auth('manageSubscriptions'),
    validate(plansValidation.createPlan),
    plansController.createPlan,
  );

router
  .route('/:planId')
  .get(
    auth('manageSubscriptions'),
    validate(plansValidation.getPlan),
    plansController.getPlan,
  )
  .put(
    auth('manageSubscriptions'),
    validate(plansValidation.updatePlan),
    plansController.updatePlan,
  )
  .delete(
    auth('manageSubscriptions'),
    validate(plansValidation.deletePlan),
    plansController.deletePlan,
  );

router.patch(
  '/:planId/update-status',
  auth('manageSubscriptions'),
  validate(plansValidation.updatePlanStatus),
  plansController.updatePlanStatus,
);

export const plansRouter = router;
