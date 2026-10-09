import Joi from 'joi';
import { objectId } from '../custom.validation.js';

const subscriptionParams = {
  params: Joi.object().keys({
    organizationId: Joi.string().custom(objectId).required(),
  }),
};

const billingCycle = Joi.string().valid('month', 'quarterly');

const startDate = Joi.date().optional().allow('', null);

export const getSubscription = {
  ...subscriptionParams,
};

export const getSubscriptions = {
  ...subscriptionParams,
};

export const getOrganizationUsage = {
  ...subscriptionParams,
};

export const getInvoice = {
  params: Joi.object().keys({
    organizationId: Joi.string().custom(objectId).required(),
    paymentId: Joi.string().custom(objectId).required(),
  }),
};

export const assignPlan = {
  ...subscriptionParams,
  body: Joi.object()
    .keys({
      plan_id: Joi.string().custom(objectId).required(),
      // Optional: defaults to the plan's own billing_cycle. Must match when sent.
      billing_cycle: billingCycle.optional(),
      start_date: startDate,
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
    .optional(),
};

export const cancelQueuedSubscription = {
  ...subscriptionParams,
  body: Joi.object()
    .keys({
      subscription_id: Joi.string().custom(objectId).required(),
    })
    .min(1),
};

export const reorderSubscriptionQueue = {
  ...subscriptionParams,
  body: Joi.object()
    .keys({
      orderedSubscriptionIds: Joi.array()
        .items(Joi.string().custom(objectId))
        .min(1)
        .required(),
    })
    .min(1),
};

// ScanFlow meters a single feature ('scan'), so the SaaS per-feature array
// collapses to one adjustment entry.
export const adjustScanLimits = {
  ...subscriptionParams,
  body: Joi.object()
    .keys({
      subscription_id: Joi.string().custom(objectId).required(),
      adjustments: Joi.array()
        .items(
          Joi.object()
            .keys({
              delta: Joi.number().integer().min(1).required(),
            })
            .min(1),
        )
        .min(1)
        .required(),
    })
    .min(1),
};

export const forceActivateSubscription = {
  ...subscriptionParams,
  body: Joi.object()
    .keys({
      plan_id: Joi.string().custom(objectId).required(),
      billing_cycle: billingCycle.optional(),
      start_date: startDate,
      trial_days: Joi.number().integer().min(0).optional().default(0),
    })
    .min(1),
};
