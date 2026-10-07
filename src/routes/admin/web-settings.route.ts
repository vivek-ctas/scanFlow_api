import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as webSettingsValidation from '../../validations/admin/web-settings.validations.js';
import * as webSettingsController from '../../controllers/admin/web-settings.controller.js';

const router = Router();

router
  .route('/')
  .get(webSettingsController.getWebSettings)
  .put(
    auth('manageWebSettings'),
    validate(webSettingsValidation.updateWebSettings),
    webSettingsController.updateWebSettings,
  );

export const webSettingsRouter = router;
