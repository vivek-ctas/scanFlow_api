import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as validation from '../../validations/admin/guest-leads.validations.js';
import * as controller from '../../controllers/admin/guest-leads.controller.js';

const router = Router();

router
  .route('/')
  .get(
    auth('manageGuestLeads'),
    validate(validation.listGuestLeads),
    controller.listGuestLeads,
  );

router
  .route('/:guestLeadId')
  .get(
    auth('manageGuestLeads'),
    validate(validation.getGuestLead),
    controller.getGuestLead,
  );

export const guestLeadsRouter = router;
