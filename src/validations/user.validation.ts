import Joi from 'joi';

export const listUsers = {
  query: Joi.object().keys({
    search: Joi.string().optional(),
    status: Joi.number().integer().valid(0, 1, 2).optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};
