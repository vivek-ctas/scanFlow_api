import mongoose from 'mongoose';
import httpStatus from 'http-status';
import jwt from 'jsonwebtoken';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { errorHandler as systemErrorHandler } from '../utils/system-error.handler.js';
import { Request, Response, NextFunction } from 'express';

const OBJECT_ID_IN_PATH = /\/[0-9a-fA-F]{24}(?=\/|$)/g;
const UUID_IN_PATH =
  /\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?=\/|$)/g;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Route without query string, with path params masked (never store secrets/PII). */
const sanitizeRoute = (req: Request): string => {
  let path = req.originalUrl.split('?')[0] ?? '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  for (const [key, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : [value];
    for (const raw of values) {
      if (raw == null || raw === '') continue;
      path = path.replace(
        new RegExp(`/${escapeRegExp(String(raw))}(?=/|$)`, 'g'),
        `/:${key}`,
      );
    }
  }

  return path.replace(OBJECT_ID_IN_PATH, '/:id').replace(UUID_IN_PATH, '/:id');
};

export const errorConverter = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  let error = err;
  if (!(error instanceof ApiError)) {
    let statusCode: number = httpStatus.INTERNAL_SERVER_ERROR;
    if (error instanceof mongoose.Error) {
      statusCode = httpStatus.BAD_REQUEST;
    } else if (
      error instanceof jwt.JsonWebTokenError ||
      error instanceof jwt.TokenExpiredError ||
      error instanceof jwt.NotBeforeError
    ) {
      statusCode = httpStatus.UNAUTHORIZED;
    } else if (
      (error as any).name === 'MongoServerError' &&
      (error as any).code === 11000
    ) {
      statusCode = httpStatus.BAD_REQUEST;
    }
    const message = error.message || (httpStatus as any)[statusCode];
    error = new ApiError(statusCode, message, false, err.stack);
  }
  next(error);
};

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  let { statusCode, message } = err as ApiError;
  if (config.env === 'production' && !(err instanceof ApiError)) {
    statusCode = httpStatus.INTERNAL_SERVER_ERROR;
    message = httpStatus[httpStatus.INTERNAL_SERVER_ERROR];
  }

  res.locals.errorMessage = err.message;

  const response = {
    code: statusCode,
    message,
    ...(config.env === 'development' && { stack: err.stack }),
  };

  if (config.env === 'development') {
    logger.error(err);
  }

  systemErrorHandler.errorM({
    action_type: 'global-error-handler',
    error_data: err,
    method: req.method,
    route: sanitizeRoute(req),
    status_code: statusCode,
  });

  res.status(statusCode).send(response);
};
