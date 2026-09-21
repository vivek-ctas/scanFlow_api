import Joi from 'joi';
import httpStatus from 'http-status';
import { Request, Response, NextFunction } from 'express';
import { pick } from '../utils/pick.js';
import { ApiError } from '../utils/ApiError.js';

export const validate =
  (schema: Record<string, any>) =>
  (req: Request, res: Response, next: NextFunction) => {
    const validSchema = pick(schema, ['params', 'query', 'body'] as const);
    const object = pick(req, Object.keys(validSchema) as (keyof Request)[]);
    const { value, error } = Joi.compile(validSchema)
      .prefs({ errors: { label: 'key' }, abortEarly: false })
      .validate(object);

    if (error) {
      const errorMessage = error.details
        .map((details) => details.message)
        .join(', ');
      return next(new ApiError(httpStatus.BAD_REQUEST, errorMessage));
    }
    Object.assign(req, value);
    return next();
  };
