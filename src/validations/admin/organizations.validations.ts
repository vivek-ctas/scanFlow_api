import Joi from 'joi';
import { objectId } from '../custom.validation.js';

const orgIdParams = {
  params: Joi.object().keys({
    organizationId: Joi.string().custom(objectId).required(),
  }),
};

export const createOrganization = {
  body: Joi.object().keys({
    name: Joi.string().required(),
    email: Joi.string().email().allow('', null).optional(),
    contact_number: Joi.string().allow('', null).optional(),
    country_name: Joi.string().allow('', null).optional(),
    status: Joi.number().integer().valid(0, 1).optional().default(1),
    admin_email: Joi.string().email().required(),
    admin_first_name: Joi.string().optional(),
    admin_last_name: Joi.string().optional(),
    admin_contact_no: Joi.string().allow('', null).optional(),
  }),
};

export const listOrganizations = {
  query: Joi.object().keys({
    search: Joi.string().optional(),
    status: Joi.number().integer().valid(0, 1, 2).optional(),
    sort_by: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(1000).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};

export const getOrganization = {
  ...orgIdParams,
};

export const updateOrganization = {
  ...orgIdParams,
  body: Joi.object()
    .keys({
      name: Joi.string().optional(),
      email: Joi.string().email().allow('', null).optional(),
      contact_number: Joi.string().allow('', null).optional(),
      country_name: Joi.string().allow('', null).optional(),
      status: Joi.number().integer().valid(0, 1, 2).optional(),
    })
    .min(1),
};

export const updateOrganizationStatus = {
  ...orgIdParams,
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

export const getOrganizationUsage = {
  ...orgIdParams,
};
