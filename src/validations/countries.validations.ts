import Joi from 'joi';

export const listCountries = {
  query: Joi.object().keys({
    search: Joi.string().optional(),
    sort_by: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(300).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};
