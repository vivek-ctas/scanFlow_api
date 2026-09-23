import { sanitize } from 'express-mongo-sanitize';
import { Request, Response, NextFunction } from 'express';

export const mongoSanitize =
  () => (req: Request, _res: Response, next: NextFunction) => {
    if (req.body && typeof req.body === 'object') {
      req.body = sanitize(req.body);
    }
    if (req.query && typeof req.query === 'object') {
      Object.defineProperty(req, 'query', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: sanitize(req.query),
      });
    }
    next();
  };
