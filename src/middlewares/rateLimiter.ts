import rateLimit from 'express-rate-limit';
import { Request } from 'express';

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
});

export const operatorPinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => {
    const operatorId = (req.body as Record<string, unknown> | undefined)
      ?.operator_id;
    return `${req.ip ?? 'unknown'}:${String(operatorId ?? '')}`.toUpperCase();
  },
});
