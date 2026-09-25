import Joi from 'joi';
import { objectId } from '../custom.validation.js';
import { ORGANIZATION_ASSIGNABLE_ROLES } from '../../config/roles.js';

const operatorIdParams = {
  params: Joi.object().keys({
    operatorId: Joi.string().custom(objectId).required(),
  }),
};

const operatorRoles = ORGANIZATION_ASSIGNABLE_ROLES;

export const createOperator = {
  body: Joi.object().keys({
    first_name: Joi.string().required(),
    last_name: Joi.string().required(),
    email: Joi.string().required().email(),
    contact_no: Joi.string().allow('', null).optional(),
    business_address: Joi.string().allow('', null).optional(),
    role: Joi.string()
      .valid(...operatorRoles)
      .optional()
      .default('OPERATOR'),
    status: Joi.number().integer().valid(0, 1).optional().default(1),
    organizationId: Joi.string().custom(objectId).optional(),
  }),
};

export const listOperators = {
  query: Joi.object().keys({
    organizationId: Joi.string().custom(objectId).optional(),
    search: Joi.string().optional(),
    status: Joi.number().integer().valid(0, 1, 2).optional(),
    role: Joi.string()
      .valid(...operatorRoles)
      .optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};

export const getOperator = {
  ...operatorIdParams,
  query: Joi.object().keys({
    organizationId: Joi.string().custom(objectId).optional(),
  }),
};

export const updateOperator = {
  ...operatorIdParams,
  body: Joi.object()
    .keys({
      first_name: Joi.string().optional(),
      last_name: Joi.string().optional(),
      email: Joi.string().email().optional(),
      contact_no: Joi.string().allow('', null).optional(),
      business_address: Joi.string().allow('', null).optional(),
      role: Joi.string()
        .valid(...operatorRoles)
        .optional(),
      status: Joi.number().integer().valid(0, 1, 2).optional(),
      isEmailVerified: Joi.boolean().optional(),
    })
    .min(1),
};

export const operatorRole = {
  ...operatorIdParams,
  body: Joi.object().keys({
    role: Joi.string()
      .valid(...operatorRoles)
      .required(),
  }),
};

export const operatorStatus = {
  ...operatorIdParams,
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

export const deleteOperator = {
  ...operatorIdParams,
};
