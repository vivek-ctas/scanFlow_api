import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as validation from '../../validations/user/webhooks.validations.js';
import * as controller from '../../controllers/user/webhooks.controller.js';

const router = Router();

router
  .route('/config')
  .get(
    auth('manageWebhooks'),
    validate(validation.getWebhookConfig),
    controller.getWebhookConfig,
  )
  .post(
    auth('manageWebhooks'),
    validate(validation.upsertWebhookConfig),
    controller.upsertWebhookConfig,
  )
  .delete(
    auth('manageWebhooks'),
    validate(validation.deleteWebhookConfig),
    controller.deleteWebhookConfig,
  );

router.get(
  '/deliveries',
  auth('manageWebhooks'),
  validate(validation.listWebhookDeliveries),
  controller.listWebhookDeliveries,
);

export const webhooksRouter = router;
