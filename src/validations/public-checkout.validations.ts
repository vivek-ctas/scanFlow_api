import Joi from 'joi';
import { objectId } from './custom.validation.js';

export const createCheckout = {
  body: Joi.object().keys({
    first_name: Joi.string().required(),
    last_name: Joi.string().required(),
    email: Joi.string().email().required(),
    contact_number: Joi.string().allow('', null).optional(),
    company_name: Joi.string().allow('', null).optional(),
    country_name: Joi.string().allow('', null).optional(),
    plan_id: Joi.string().custom(objectId).required(),
    billing_cycle: Joi.string().valid('month', 'quarterly').required(),
    gateway: Joi.string().valid('stripe', 'razorpay').required(),
    success_url: Joi.string().uri().required(),
    cancel_url: Joi.string().uri().required(),
  }),
};
