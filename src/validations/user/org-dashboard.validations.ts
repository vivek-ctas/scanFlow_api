import Joi from 'joi';

const dashboardRange = Joi.string().valid('7d', '30d', '90d').default('30d');

export const orgDashboardSummaryValidation = {
  query: Joi.object().keys({
    organization_id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/),
  }),
};

export const orgDashboardQuotaValidation = {
  query: Joi.object().keys({
    organization_id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/),
  }),
};

export const orgDashboardScanTrendValidation = {
  query: Joi.object()
    .keys({
      range: dashboardRange,
      from: Joi.date().iso(),
      to: Joi.date().iso().min(Joi.ref('from')),
      compare: Joi.boolean(),
      organization_id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/),
    })
    .or('range', 'from'),
};

export const orgDashboardTeamValidation = {
  query: Joi.object().keys({
    organization_id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/),
  }),
};

export const orgDashboardWebhooksValidation = {
  query: Joi.object().keys({
    organization_id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/),
  }),
};

export const orgDashboardAttentionValidation = {
  query: Joi.object().keys({
    organization_id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/),
  }),
};
