import httpStatus from 'http-status';
import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError.js';

export const ensureSuperAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const user = req.user as any;
  if (!user) {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
  }

  if (user.isSuperAdmin) {
    return next();
  }

  return next(new ApiError(httpStatus.FORBIDDEN, 'SuperAdmin access required'));
};
