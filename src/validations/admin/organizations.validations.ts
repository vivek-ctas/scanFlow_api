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
    contactNumber: Joi.string().allow('', null).optional(),
    status: Joi.number().integer().valid(0, 1).optional().default(1),
    scanQuotaLimit: Joi.number().integer().min(0).optional(),
    period: Joi.string()
      .valid('daily', 'monthly')
      .optional()
      .default('monthly'),
    adminEmail: Joi.string().email().required(),
    adminFirstName: Joi.string().optional(),
    adminLastName: Joi.string().optional(),
    adminContactNo: Joi.string().allow('', null).optional(),
  }),
};

export const listOrganizations = {
  query: Joi.object().keys({
    search: Joi.string().optional(),
    status: Joi.number().integer().valid(0, 1, 2).optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
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
      contactNumber: Joi.string().allow('', null).optional(),
      status: Joi.number().integer().valid(0, 1, 2).optional(),
      scanQuota: Joi.object()
        .keys({
          limit: Joi.number().integer().min(0).optional(),
          period: Joi.string().valid('daily', 'monthly').optional(),
          periodStart: Joi.date().optional(),
        })
        .optional(),
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
