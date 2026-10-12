import Joi from 'joi';

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

export const loginPin = {
  body: Joi.object().keys({
    operator_id: Joi.string()
      .trim()
      .uppercase()
      .pattern(/^[A-Z0-9]{2}\d+$/)
      .required(),
    pin: Joi.string()
      .pattern(/^\d{6}$/)
      .required(),
  }),
};

export const refreshTokens = {
  body: Joi.object().keys({
    refresh_token: Joi.string().required(),
  }),
};

export const logout = {
  body: Joi.object().keys({
    refresh_token: Joi.string().required(),
  }),
};

export const updateMe = {
  body: Joi.object()
    .keys({
      first_name: Joi.string().trim().min(1).max(64).optional(),
      last_name: Joi.string().trim().min(1).max(64).optional(),
      contact_number: Joi.string().trim().max(20).allow('', null).optional(),
      country_name: Joi.string().trim().max(100).allow('', null).optional(),
      business_address: Joi.string().trim().max(300).allow('', null).optional(),
      company_name: Joi.string().trim().max(120).allow('', null).optional(),
    })
    .min(1),
};
