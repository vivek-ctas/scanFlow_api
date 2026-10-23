import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as validation from '../../validations/admin/system-log.validations.js';
import * as controller from '../../controllers/admin/system-log.controller.js';

const router = Router();

router.get(
  '/',
  auth('viewSystemLogs'),
  validate(validation.listSystemLogs),
  controller.listSystemLogs,
);

router.get(
  '/operations',
  auth('viewSystemLogs'),
  controller.getSystemLogOperations,
);

router.get(
  '/:logId',
  auth('viewSystemLogs'),
  validate(validation.getSystemLog),
  controller.getSystemLog,
);

export const systemLogRouter = router;
