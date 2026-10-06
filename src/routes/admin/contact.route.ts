import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as contactValidation from '../../validations/admin/contact.validations.js';
import * as contactController from '../../controllers/admin/contact.controller.js';

const router = Router();

// Public — anyone can submit a contact inquiry.
router.post(
  '/public/submit',
  validate(contactValidation.submitContact),
  contactController.submitContact,
);

router
  .route('/')
  .get(
    auth('manageContact'),
    validate(contactValidation.listContacts),
    contactController.listContacts,
  );

router
  .route('/:contactId')
  .get(
    auth('manageContact'),
    validate(contactValidation.getContact),
    contactController.getContact,
  );

router.patch(
  '/:contactId/status',
  auth('manageContact'),
  validate(contactValidation.updateContactStatus),
  contactController.updateContactStatus,
);

router.post(
  '/:contactId/reply',
  auth('manageContact'),
  validate(contactValidation.replyToContact),
  contactController.replyToContact,
);

export const contactRouter = router;
