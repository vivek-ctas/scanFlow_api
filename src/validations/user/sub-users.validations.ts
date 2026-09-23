import Joi from 'joi';
import { objectId } from '../custom.validation.js';

const subUserIdParams = {
  params: Joi.object().keys({
    subUserId: Joi.string().custom(objectId).required(),
  }),
};

export const listSubUsers = {
  query: Joi.object().keys({
    parentId: Joi.string().custom(objectId).optional(),
    search: Joi.string().optional(),
    status: Joi.number().integer().valid(0, 1, 2).optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};

export const createSubUser = {
  body: Joi.object().keys({
    first_name: Joi.string().required(),
    last_name: Joi.string().required(),
    email: Joi.string().required().email(),
    contact_no: Joi.string().allow('', null).optional(),
    business_address: Joi.string().allow('', null).optional(),
    role: Joi.string().valid('USER', 'USER_ADMIN').optional().default('USER'),
    status: Joi.number().integer().valid(0, 1).optional().default(1),
    parent_id: Joi.string().custom(objectId).optional(),
  }),
};

export const getSubUser = {
  ...subUserIdParams,
};

export const updateSubUser = {
  ...subUserIdParams,
  body: Joi.object()
    .keys({
      first_name: Joi.string().optional(),
      last_name: Joi.string().optional(),
      email: Joi.string().email().optional(),
      contact_no: Joi.string().allow('', null).optional(),
      business_address: Joi.string().allow('', null).optional(),
      role: Joi.string().valid('USER', 'USER_ADMIN').optional(),
      status: Joi.number().integer().valid(0, 1, 2).optional(),
      isEmailVerified: Joi.boolean().optional(),
    })
    .min(1),
};

export const subUserRole = {
  ...subUserIdParams,
  body: Joi.object().keys({
    role: Joi.string().valid('USER', 'USER_ADMIN').required(),
  }),
};

export const subUserStatus = {
  ...subUserIdParams,
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

export const deleteSubUser = {
  ...subUserIdParams,
};
