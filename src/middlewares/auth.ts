import passport from 'passport';
import httpStatus from 'http-status';
import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError.js';
import { roleRights } from '../config/roles.js';

const verifyCallback =
  (
    req: Request,
    resolve: (value: unknown) => void,
    reject: (reason?: Error) => void,
    requiredRights: string[],
  ) =>
  async (err: Error | null, user: any, info: any) => {
    if (err || info || !user) {
      return reject(
        new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'),
      );
    }

    req.user = user;

    if (requiredRights.length) {
      const userRights = roleRights.get(user.role) || [];
      const hasRequiredRights = requiredRights.every((requiredRight) =>
        userRights.includes(requiredRight),
      );

      if (!hasRequiredRights && req.params.userId !== user.id) {
        return reject(new ApiError(httpStatus.FORBIDDEN, 'Forbidden'));
      }
    }

    resolve(user);
  };

export const auth =
  (...requiredRights: string[]) =>
  async (req: Request, res: Response, next: NextFunction) => {
    return new Promise((resolve, reject) => {
      passport.authenticate(
        'jwt',
        { session: false },
        verifyCallback(req, resolve, reject, requiredRights),
      )(req, res, next);
    })
      .then(() => next())
      .catch((err) => {
        if (err instanceof ApiError) {
          return res.status(err.statusCode).json({
            code: err.statusCode,
            message: err.message,
          });
        }
        return res.status(httpStatus.UNAUTHORIZED).json({
          code: httpStatus.UNAUTHORIZED,
          message: 'Please authenticate',
        });
      });
  };
