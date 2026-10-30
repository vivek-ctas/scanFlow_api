import rateLimit from 'express-rate-limit';
import { Request } from 'express';
import config from '../config/config.js';

const userKey = (req: Request) => {
  const userId = (req.user as any)?._id ?? req.ip ?? 'unknown';
  return String(userId);
};

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

/** Per-user cap on support ticket creation (default 10/hour). */
export const supportCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: config.support.rateCreatePerHour,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
});

/** Per-user cap on read-marker writes (generous; the client debounces). */
export const supportReadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
});

/** Per-user cap on support replies/notes (default 60/hour). */
export const supportReplyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: config.support.rateReplyPerHour,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
});
