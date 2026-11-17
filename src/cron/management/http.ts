import httpStatus from 'http-status';
import crypto from 'node:crypto';
import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';
import rateLimit from 'express-rate-limit';
import config from '../../config/config.js';
import { logger } from '../../config/logger.js';
import { ManagementError } from './errors.js';
import { sanitizeText } from './repository.js';
import { verifyBearerToken } from './token.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const id =
    incoming && REQUEST_ID_PATTERN.test(incoming)
      ? incoming
      : crypto.randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};

/**
 * Management-prefix CORS. The global ScanFlow middleware intentionally does
 * not apply here: the panel origin allowlist is narrower and credentials are
 * never allowed.
 */
export const managementCors: RequestHandler = (req, res, next) => {
  const origin = req.header('origin');
  const allowed = config.cronzivo.allowedOrigins;
  const originAllowed = Boolean(origin && allowed.includes(origin));

  if (originAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin as string);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');

  if (req.method === 'OPTIONS') {
    if (origin && !originAllowed) {
      res.status(httpStatus.FORBIDDEN).end();
      return;
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-Request-Id',
    );
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(httpStatus.NO_CONTENT).end();
    return;
  }

  next();
};

export const managementRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => req.method === 'OPTIONS',
  handler: (_req: Request, res: Response) => {
    failure(
      res,
      httpStatus.TOO_MANY_REQUESTS,
      'RATE_LIMITED',
      'Too many management requests',
    );
  },
});

export const managementAuth: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const result = verifyBearerToken(req.headers.authorization);
  if (!result.ok) {
    failure(res, httpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
    return;
  }
  (req as any).managementToken = result.payload;
  next();
};

export const success = (
  res: Response,
  data: unknown,
  status: number = httpStatus.OK,
): Response =>
  res.status(status).json({
    success: true,
    data,
    request_id: res.locals.requestId ?? '',
  });

export const failure = (
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response => {
  if (!res.headersSent) {
    res.setHeader('X-Request-Id', res.locals.requestId ?? '');
  }
  return res.status(status).json({
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
    request_id: res.locals.requestId ?? '',
  });
};

export const notFound: RequestHandler = (req, res) => {
  failure(
    res,
    httpStatus.NOT_FOUND,
    'JOB_NOT_FOUND',
    `Not found: ${req.method} ${req.path}`,
  );
};

export const managementErrorHandler: ErrorRequestHandler = (
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  if (res.headersSent) return;

  if (err instanceof ManagementError) {
    failure(res, err.statusCode, err.code, err.message, err.details);
    return;
  }

  if (err?.type === 'entity.too.large' || err?.status === 413) {
    failure(
      res,
      httpStatus.REQUEST_ENTITY_TOO_LARGE,
      'PAYLOAD_TOO_LARGE',
      'Request body exceeds 10 KB',
    );
    return;
  }

  if (err?.type === 'entity.parse.failed') {
    failure(
      res,
      httpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      'Invalid JSON body',
    );
    return;
  }

  logger.error(
    `[CRONZIVO] ${req.method} ${req.path} failed: ${sanitizeText(err, 300)}`,
  );
  failure(
    res,
    httpStatus.INTERNAL_SERVER_ERROR,
    'INTERNAL_ERROR',
    'Internal server error',
  );
};
