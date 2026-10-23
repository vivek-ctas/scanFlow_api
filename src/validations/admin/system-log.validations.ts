import Joi from 'joi';
import { objectId } from '../custom.validation.js';

const logIdParams = {
  params: Joi.object().keys({
    logId: Joi.string().custom(objectId).required(),
  }),
};

export const listSystemLogs = {
  query: Joi.object().keys({
    search: Joi.string().allow('').optional(),
    operation: Joi.string()
      .valid('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'CRON')
      .optional(),
    actor_role: Joi.string().optional(),
    operation_by: Joi.string().custom(objectId).optional(),
    key: Joi.string().allow('').optional(),
    organization_id: Joi.string().custom(objectId).optional(),
    startDate: Joi.date().iso().optional(),
    endDate: Joi.date().iso().optional(),
    sort_by: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};

export const getSystemLog = {
  ...logIdParams,
};
