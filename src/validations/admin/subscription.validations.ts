import Joi from 'joi';
import { objectId } from '../custom.validation.js';

const subscriptionParams = {
  params: Joi.object().keys({
    organizationId: Joi.string().custom(objectId).required(),
  }),
};

const billingCycle = Joi.string().valid('month', 'quarterly');

export const getSubscription = {
  ...subscriptionParams,
};

export const getOrganizationUsage = {
  ...subscriptionParams,
};

export const assignPlan = {
  ...subscriptionParams,
  body: Joi.object()
    .keys({
      plan_id: Joi.string().custom(objectId).required(),
      // Optional: defaults to the plan's own billing_cycle. Must match when sent.
      billing_cycle: billingCycle.optional(),
    })
    .min(1),
};

export const renewSubscription = {
  ...subscriptionParams,
  body: Joi.object()
    .keys({
      mode: Joi.string()
        .valid('continue', 'promote', 'recreate')
        .default('continue'),
      plan_id: Joi.string().custom(objectId).optional(),
      billing_cycle: billingCycle.optional(),
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
      plan_id: Joi.string().custom(objectId).required(),
      billing_cycle: billingCycle.optional(),
      trial_days: Joi.number().integer().min(0).optional().default(0),
    })
    .min(1),
};
