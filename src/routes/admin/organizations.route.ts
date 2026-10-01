import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as validation from '../../validations/admin/organizations.validations.js';
import * as subscriptionValidation from '../../validations/admin/subscription.validations.js';
import * as controller from '../../controllers/admin/organizations.controller.js';
import * as subscriptionController from '../../controllers/admin/subscription.controller.js';

const router = Router();

router
  .route('/')
  .get(
    auth('manageOrganizations'),
    validate(validation.listOrganizations),
    controller.listOrganizations,
  )
  .post(
    auth('manageOrganizations'),
    validate(validation.createOrganization),
    controller.createOrganization,
  );

router
  .route('/:organizationId')
  .get(
    auth('manageOrganizations'),
    validate(validation.getOrganization),
    controller.getOrganization,
  )
  .put(
    auth('manageOrganizations'),
    validate(validation.updateOrganization),
    controller.updateOrganization,
  )
  .delete(
    auth('manageOrganizations'),
    validate(validation.getOrganization),
    controller.deleteOrganization,
  );

router.patch(
  '/:organizationId/update-status',
  auth('manageOrganizations'),
  validate(validation.updateOrganizationStatus),
  controller.updateOrganizationStatus,
);

router.get(
  '/:organizationId/usage',
  auth('viewSubscription'),
  validate(subscriptionValidation.getOrganizationUsage),
  subscriptionController.getOrganizationUsage,
);

router.get(
  '/:organizationId/subscription',
  auth('viewSubscription'),
  validate(subscriptionValidation.getSubscription),
  subscriptionController.getSubscription,
);

router.post(
  '/:organizationId/subscription/assign-plan',
  auth('manageSubscriptions'),
  validate(subscriptionValidation.assignPlan),
  subscriptionController.assignPlan,
);

router.post(
  '/:organizationId/subscription/renew',
  auth('manageSubscriptions'),
  validate(subscriptionValidation.renewSubscription),
  subscriptionController.renewSubscription,
);

router.post(
  '/:organizationId/subscription/cancel-active',
  auth('manageSubscriptions'),
  validate(subscriptionValidation.cancelActiveSubscription),
  subscriptionController.cancelActiveSubscription,
);

router.post(
  '/:organizationId/subscription/force-activate',
  auth('manageSubscriptions'),
  validate(subscriptionValidation.forceActivateSubscription),
  subscriptionController.forceActivateSubscription,
);

router.post(
  '/:organizationId/subscription/cancel-queued',
  auth('manageSubscriptions'),
  validate(subscriptionValidation.cancelQueuedSubscription),
  subscriptionController.cancelQueuedSubscription,
);

router.post(
  '/:organizationId/subscription/reorder-queue',
  auth('manageSubscriptions'),
  validate(subscriptionValidation.reorderSubscriptionQueue),
  subscriptionController.reorderSubscriptionQueue,
);

router.post(
  '/:organizationId/subscription/limits/adjust',
  auth('manageSubscriptions'),
  validate(subscriptionValidation.adjustScanLimits),
  subscriptionController.adjustScanLimits,
);

export const organizationsRouter = router;
