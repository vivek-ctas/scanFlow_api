import Joi from 'joi';
import { objectId } from './custom.validation.js';

export const createCheckout = {
  body: Joi.object().keys({
    firstName: Joi.string().required(),
    lastName: Joi.string().required(),
    email: Joi.string().email().required(),
    phone: Joi.string().allow('', null).optional(),
    company: Joi.string().allow('', null).optional(),
    planId: Joi.string().custom(objectId).required(),
    gateway: Joi.string().valid('stripe', 'razorpay').required(),
    successUrl: Joi.string().uri().required(),
    cancelUrl: Joi.string().uri().required(),
  }),
};
