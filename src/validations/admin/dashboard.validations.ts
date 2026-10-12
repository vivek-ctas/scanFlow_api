import Joi from 'joi';

const MAX_SPAN_DAYS = 90;

const validateWindow = (value: any, helpers: Joi.CustomHelpers) => {
  const hasFrom = value.from !== undefined && value.from !== null;
  const hasTo = value.to !== undefined && value.to !== null;

  if (hasFrom !== hasTo) {
    return helpers.message({
      custom: 'from and to must be provided together',
    });
  }

  if (hasFrom && hasTo) {
    const from = new Date(value.from).getTime();
    const to = new Date(value.to).getTime();
    if (from >= to) {
      return helpers.message({ custom: 'from must be before to' });
    }
    if ((to - from) / 86_400_000 > MAX_SPAN_DAYS) {
      return helpers.message({
        custom: 'date range must not exceed 90 days',
      });
    }
  }

  return value;
};

export const emptyQuery = {
  query: Joi.object().keys({}),
};

export const rangeQuery = {
  query: Joi.object()
    .keys({
      range: Joi.string().valid('7d', '30d', '90d').default('30d'),
      from: Joi.date().iso().optional(),
      to: Joi.date().iso().optional(),
      compare: Joi.boolean().truthy('true').falsy('false').default(false),
    })
    .custom(validateWindow),
};

export const growthQuery = {
  query: Joi.object()
    .keys({
      range: Joi.string().valid('7d', '30d', '90d').default('30d'),
      from: Joi.date().iso().optional(),
      to: Joi.date().iso().optional(),
    })
    .custom(validateWindow),
};

export const recentLeadsQuery = {
  query: Joi.object().keys({
    limit: Joi.number().integer().min(1).max(10).default(10),
  }),
};

export const topOrganizationsQuery = {
  query: Joi.object().keys({
    limit: Joi.number().integer().min(1).max(5).default(5),
  }),
};
