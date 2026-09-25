import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as validation from '../../validations/user/scans.validations.js';
import * as controller from '../../controllers/user/scans.controller.js';

const router = Router();

router
  .route('/')
  .get(
    auth('manageScans'),
    validate(validation.listScans),
    controller.listScans,
  )
  .post(
    auth('manageScans'),
    validate(validation.createScan),
    controller.createScan,
  );

router.get(
  '/:scanId',
  auth('manageScans'),
  validate(validation.getScan),
  controller.getScan,
);

export const scansRouter = router;
