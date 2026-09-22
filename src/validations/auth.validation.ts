import Joi from 'joi';
import { password, objectId } from './custom.validation.js';

export const register = {
  body: Joi.object().keys({
    first_name: Joi.string().required(),
    last_name: Joi.string().required(),
    email: Joi.string().required().email(),
    contact_no: Joi.string().required(),
    business_address: Joi.string().allow('').optional(),
    password: Joi.string().custom(password).optional(),
    role: Joi.string()
      .valid('SELLER_ADMIN', 'SELLER_USER')
      .optional()
      .default('SELLER_USER'),
    seller_id: Joi.string().custom(objectId).optional(),
  }),
};

export const sendOtp = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
  }),
};

export const verifyOtp = {
  body: Joi.object().keys({
    email: Joi.string().required().email(),
    otp: Joi.string().length(6).required(),
  }),
};

export const refreshTokens = {
  body: Joi.object().keys({
    refreshToken: Joi.string().required(),
  }),
};

export const logout = {
  body: Joi.object().keys({
    refreshToken: Joi.string().required(),
  }),
};
