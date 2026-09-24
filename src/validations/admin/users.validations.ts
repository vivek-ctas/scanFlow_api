import Joi from 'joi';
import { objectId } from '../custom.validation.js';

const userRoleValues = ['SUPER_ADMIN', 'USER_ADMIN', 'USER'];

const userIdParams = {
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId).required(),
  }),
};

export const listUsers = {
  query: Joi.object().keys({
    search: Joi.string().optional(),
    status: Joi.number().integer().valid(0, 1, 2).optional(),
    role: Joi.string()
      .valid(...userRoleValues)
      .optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};

export const getUser = {
  ...userIdParams,
};

export const createUser = {
  body: Joi.object().keys({
    first_name: Joi.string().required(),
    last_name: Joi.string().required(),
    email: Joi.string().required().email(),
    contact_no: Joi.string().allow('', null).optional(),
    business_address: Joi.string().allow('', null).optional(),
    role: Joi.string()
      .valid(...userRoleValues)
      .optional()
      .default('USER_ADMIN'),
    status: Joi.number().integer().valid(0, 1).optional().default(1),
    isEmailVerified: Joi.boolean().optional(),
    isSuperAdmin: Joi.boolean().optional(),
    parent_id: Joi.string().custom(objectId).allow('', null).optional(),
  }),
};

export const adminUpdateUser = {
  ...userIdParams,
  body: Joi.object()
    .keys({
      first_name: Joi.string().optional(),
      last_name: Joi.string().optional(),
      email: Joi.string().email().optional(),
      contact_no: Joi.string().allow('', null).optional(),
      business_address: Joi.string().allow('', null).optional(),
      role: Joi.string()
        .valid(...userRoleValues)
        .optional(),
      status: Joi.number().integer().valid(0, 1, 2).optional(),
      isEmailVerified: Joi.boolean().optional(),
      isSuperAdmin: Joi.boolean().optional(),
      is_sub_user: Joi.boolean().optional(),
      parent_id: Joi.string().custom(objectId).allow('', null).optional(),
    })
    .min(1),
};

export const updateRole = {
  ...userIdParams,
  body: Joi.object().keys({
    role: Joi.string()
      .valid(...userRoleValues)
      .required(),
  }),
};

export const updateStatus = {
  ...userIdParams,
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
