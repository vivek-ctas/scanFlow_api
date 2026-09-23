import mongoose from 'mongoose';
import httpStatus from 'http-status';
import jwt from 'jsonwebtoken';
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
  });

  res.status(statusCode).send(response);
};
