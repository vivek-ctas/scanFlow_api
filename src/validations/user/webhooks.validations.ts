import Joi from 'joi';
import { objectId } from '../custom.validation.js';

export const upsertWebhookConfig = {
  body: Joi.object().keys({
    organization_id: Joi.string().custom(objectId).optional(),
    endpoint_url: Joi.string().uri().required(),
    secret: Joi.string().allow('', null).optional(),
    enabled: Joi.boolean().optional().default(true),
    timeout_ms: Joi.number().integer().min(100).optional(),
    batch_size: Joi.number().integer().min(1).optional(),
    retry_limit: Joi.number().integer().min(1).max(10).optional(),
  }),
};

export const getWebhookConfig = {
  query: Joi.object().keys({
    organization_id: Joi.string().custom(objectId).optional(),
  }),
};

export const deleteWebhookConfig = {
  query: Joi.object().keys({
    organization_id: Joi.string().custom(objectId).optional(),
  }),
};

export const listWebhookDeliveries = {
  query: Joi.object().keys({
    organization_id: Joi.string().custom(objectId).optional(),
    status: Joi.string()
      .valid('pending', 'processing', 'delivered', 'failed')
      .optional(),
    sort_by: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};
