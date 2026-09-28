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
