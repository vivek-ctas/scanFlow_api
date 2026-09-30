import Joi from 'joi';
import { objectId } from '../custom.validation.js';

const planIdParams = {
  params: Joi.object().keys({
    planId: Joi.string().custom(objectId).required(),
  }),
};

const featureObject = Joi.object().keys({
  features_name: Joi.string().required(),
  scan_limit: Joi.number().integer().min(0).optional().default(0),
});

const billingCycle = Joi.string().valid('month', 'quarterly');

export const createPlan = {
  body: Joi.object().keys({
    name: Joi.string().required(),
    desc: Joi.string().allow('', null).optional(),
    price: Joi.number().min(0).required(),
    price_quarterly: Joi.number().min(0).allow(null).optional(),
    billing_cycle: billingCycle.optional().default('month'),
    currency: Joi.string().trim().lowercase().optional().default('inr'),
    trial_days: Joi.number().integer().min(0).optional().default(0),
    features: Joi.array().items(featureObject).optional().default([]),
    marketing_features: Joi.array().items(Joi.string()).optional().default([]),
    status: Joi.number().integer().valid(0, 1).optional().default(1),
    is_custom_plan: Joi.boolean().optional().default(false),
    is_popular: Joi.boolean().optional().default(false),
    discount: Joi.number().min(0).max(100).optional().default(0),
  }),
};

export const listPlans = {
  query: Joi.object().keys({
    search: Joi.string().optional(),
    status: Joi.number().integer().valid(0, 1, 2).optional(),
    is_custom_plan: Joi.boolean().optional(),
    date_from: Joi.date().iso().optional(),
    date_to: Joi.date().iso().optional(),
    sort_by: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(1000).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};

export const getPlan = {
  ...planIdParams,
};

export const updatePlan = {
  ...planIdParams,
  body: Joi.object()
    .keys({
      name: Joi.string().optional(),
      desc: Joi.string().allow('', null).optional(),
      price: Joi.number().min(0).optional(),
      price_quarterly: Joi.number().min(0).allow(null).optional(),
      billing_cycle: billingCycle.optional(),
      currency: Joi.string().trim().lowercase().optional(),
      trial_days: Joi.number().integer().min(0).optional(),
      features: Joi.array().items(featureObject).optional(),
      marketing_features: Joi.array().items(Joi.string()).optional(),
      status: Joi.number().integer().valid(0, 1, 2).optional(),
      is_custom_plan: Joi.boolean().optional(),
      is_popular: Joi.boolean().optional(),
      discount: Joi.number().min(0).max(100).optional(),
    })
    .min(1),
};

export const updatePlanStatus = {
  ...planIdParams,
  body: Joi.object()
    .keys({
      status: Joi.number().integer().valid(0, 1, 2).optional(),
      action_type: Joi.string()
        .valid('activate', 'deactivate', 'toggle')
        .optional(),
    })
    .min(1)
    .or('status', 'action_type'),
};

export const deletePlan = {
  ...planIdParams,
};
