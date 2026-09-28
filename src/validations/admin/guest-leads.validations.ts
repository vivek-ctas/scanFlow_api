import Joi from 'joi';
import { objectId } from '../custom.validation.js';

const guestLeadIdParams = {
  params: Joi.object().keys({
    guestLeadId: Joi.string().custom(objectId).required(),
  }),
};

export const listGuestLeads = {
  query: Joi.object().keys({
    search: Joi.string().optional(),
    status: Joi.string()
      .valid('pending', 'initiated', 'success', 'failed', 'cancelled')
      .optional(),
    plan_id: Joi.string().custom(objectId).optional(),
    organization_id: Joi.string().custom(objectId).optional(),
    date_from: Joi.date().iso().optional(),
    date_to: Joi.date().iso().optional(),
    sort_by: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(1000).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};

export const getGuestLead = {
  ...guestLeadIdParams,
};
