import { Router } from 'express';
import { auth } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';
import {
  supportCreateLimiter,
  supportReplyLimiter,
} from '../middlewares/rateLimiter.js';
import { supportUpload } from '../middlewares/supportUpload.js';
import * as supportController from '../controllers/support.controller.js';
import * as supportValidation from '../validations/support.validations.js';

const router = Router();

router.use(auth());

// Shared routes — both SUPER_ADMIN and ORGANIZATION_ADMIN hold `viewSupport`.
// `/tickets/summary` MUST be declared before `/tickets/:ticketId`.
router.get(
  '/tickets/summary',
  auth('viewSupport'),
  validate(supportValidation.getSummary),
  supportController.getSummary,
);

router.get(
  '/tickets',
  auth('viewSupport'),
  validate(supportValidation.listTickets),
  supportController.listTickets,
);

router.post(
  '/tickets',
  auth('viewSupport'),
  supportCreateLimiter,
  supportUpload,
  validate(supportValidation.createTicket),
  supportController.createTicket,
);

router.get(
  '/tickets/:ticketId/messages/:messageId/attachments/:index',
  auth('viewSupport'),
  validate(supportValidation.downloadAttachment),
  supportController.downloadAttachment,
);

router.get(
  '/tickets/:ticketId',
  auth('viewSupport'),
  validate(supportValidation.getTicket),
  supportController.getTicket,
);

router.post(
  '/tickets/:ticketId/messages',
  auth('viewSupport'),
  supportReplyLimiter,
  supportUpload,
  validate(supportValidation.addMessage),
  supportController.addMessage,
);

router.patch(
  '/tickets/:ticketId/close',
  auth('viewSupport'),
  validate(supportValidation.closeTicket),
  supportController.closeTicket,
);

// Staff-only routes — SUPER_ADMIN holds `manageSupport`.
router.post(
  '/tickets/:ticketId/notes',
  auth('manageSupport'),
  supportReplyLimiter,
  validate(supportValidation.addNote),
  supportController.addNote,
);

router.patch(
  '/tickets/:ticketId',
  auth('manageSupport'),
  validate(supportValidation.updateTicket),
  supportController.updateTicket,
);

router.get(
  '/staff',
  auth('manageSupport'),
  supportController.listStaff,
);

export const supportRouter = router;
