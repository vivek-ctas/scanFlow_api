import Joi from 'joi';
import httpStatus from 'http-status';
import type { NextFunction, Request, Response } from 'express';
import { pick } from '../../utils/pick.js';
import { ManagementError } from './errors.js';

/**
 * Shape validation for the management API, in the same style as the product's
 * reference modules (`validations/*.validations.ts` + `validate(schema)`).
 *
 * Semantic rules that need cron/timezone libraries stay in `cron.ts` / the
 * manager; this file only validates params/query/body shape and enums.
 */
export const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;

const jobId = Joi.string().pattern(JOB_ID_PATTERN);
const limit = Joi.number().integer().min(1).max(200).default(50);
const cursor = Joi.string().min(1).max(512);
const isoDate = Joi.date().iso();

const params = Joi.object().keys({ id: jobId.required() });

export const jobRoute = { params };

export const emptyBodyRoute = {
  params,
  body: Joi.object().keys({}).default({}),
};

export const scheduleRoute = {
  params,
  body: Joi.object().keys({
    expression: Joi.string().trim().min(1).max(120).required(),
    timezone: Joi.string().trim().min(1).max(80).required(),
    expected_version: Joi.number().integer().min(1),
    dry_run: Joi.boolean(),
  }),
};

export const bulkRoute = {
  body: Joi.object().keys({
    job_ids: Joi.array().items(jobId).min(1).allow(null),
    confirm: Joi.boolean(),
  }),
};

export const executionsRoute = {
  params,
  query: Joi.object().keys({
    limit,
    cursor,
    status: Joi.string().valid('RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED'),
    trigger: Joi.string().valid('SCHEDULED', 'MANUAL'),
    from: isoDate,
    to: isoDate,
  }),
};

export const logsRoute = {
  params,
  query: Joi.object().keys({
    limit,
    cursor,
    execution_id: Joi.string().trim().max(64),
    level: Joi.string().valid('INFO', 'WARN', 'ERROR'),
  }),
};

export const jobAuditRoute = {
  params,
  query: Joi.object().keys({
    limit,
    cursor,
    command: Joi.string().trim().max(64),
  }),
};

export const globalAuditRoute = {
  query: Joi.object().keys({
    limit,
    cursor,
    job_id: jobId,
    command: Joi.string().trim().max(64),
    outcome: Joi.string().valid('SUCCESS', 'FAILED', 'REJECTED'),
    from: isoDate,
    to: isoDate,
  }),
};

/**
 * Validate `params`/`query`/`body` and map Joi failures to the contract's
 * `400 VALIDATION_ERROR`. Unknown keys are rejected (never silently dropped).
 */
export const validateManagement =
  (schema: Record<string, any>) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const validSchema = pick(schema, ['params', 'query', 'body'] as const);
    const object = pick(req, Object.keys(validSchema) as (keyof Request)[]);
    const { value, error } = Joi.compile(validSchema)
      .prefs({ errors: { label: 'key' }, abortEarly: false })
      .validate(object);

    if (error) {
      const message = error.details.map((detail) => detail.message).join(', ');
      return next(
        new ManagementError(
          httpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
          message,
        ),
      );
    }
    Object.assign(req, value);
    return next();
  };
