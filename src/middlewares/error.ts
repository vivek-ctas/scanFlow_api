import mongoose from 'mongoose';
import httpStatus from 'http-status';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { errorHandler as systemErrorHandler } from '../utils/system-error.handler.js';
import { Request, Response, NextFunction } from 'express';

export const errorConverter = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  let error = err;
  if (!(error instanceof ApiError)) {
    const statusCode =
      error instanceof mongoose.Error
        ? httpStatus.BAD_REQUEST
        : httpStatus.INTERNAL_SERVER_ERROR;
    const message = error.message || httpStatus[statusCode];
    error = new ApiError(statusCode, message, false, err.stack);
  }
  next(error);
};

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
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
  });

  res.status(statusCode).send(response);
};
