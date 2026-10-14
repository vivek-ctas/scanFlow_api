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

/**
 * Light per-user rate limit for org-dashboard endpoints.
 * Prevents a runaway tab/script from hammering the customer-facing API.
 * ~60 req/min per user (identified by user id or IP).
 */
export const orgDashboardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const userId = (req.user as any)?._id ?? req.ip ?? 'unknown';
    return String(userId);
  },
});
