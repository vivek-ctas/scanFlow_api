import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as validation from '../../validations/admin/organizations.validations.js';
import * as controller from '../../controllers/admin/organizations.controller.js';

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
  auth('manageScans'),
  validate(validation.getOrganizationUsage),
  controller.getOrganizationUsage,
);

export const organizationsRouter = router;
