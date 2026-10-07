import Joi from 'joi';
import { objectId } from '../custom.validation.js';

const resendBody = {
  body: Joi.object()
    .keys({
      organization_id: Joi.string().custom(objectId).required(),
    })
    .min(1),
};

export const resendWelcome = resendBody;

export const resendRenewal = resendBody;

export const sendTest = {
  body: Joi.object()
    .keys({
      to: Joi.string().email().required(),
      subject: Joi.string().max(200).required(),
      message: Joi.string().max(5000).allow(''),
    })
    .min(1),
};
