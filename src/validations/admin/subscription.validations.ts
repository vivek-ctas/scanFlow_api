import Joi from 'joi';
import { objectId } from '../custom.validation.js';

const subscriptionParams = {
  params: Joi.object().keys({
    organizationId: Joi.string().custom(objectId).required(),
  }),
};

export const getSubscription = {
  ...subscriptionParams,
};

export const getOrganizationUsage = {
  ...subscriptionParams,
};

export const assignPlan = {
  ...subscriptionParams,
  body: Joi.object().keys({
    planId: Joi.string().custom(objectId).required(),
  }),
};

export const renewSubscription = {
  ...subscriptionParams,
  body: Joi.object()
    .keys({
      mode: Joi.string()
        .valid('continue', 'promote', 'recreate')
        .default('continue'),
      planId: Joi.string().custom(objectId).optional(),
    })
    .min(1),
};

export const cancelActiveSubscription = {
  ...subscriptionParams,
  body: Joi.object()
    .keys({
      reason: Joi.string().allow('', null).optional(),
    })
    .min(1),
};

export const forceActivateSubscription = {
  ...subscriptionParams,
  body: Joi.object()
    .keys({
      planId: Joi.string().custom(objectId).required(),
      trialDays: Joi.number().integer().min(0).optional().default(0),
    })
    .min(1),
};
