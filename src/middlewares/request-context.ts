import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

export interface RequestContext {
  ip?: string;
  actor_id?: string | null;
  actor_role?: string | null;
  organization_id?: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Captures per-request metadata (client IP + authenticated actor) so the audit
 * writer can record "who did what from where" without threading extra arguments
 * through every service signature.
 */
const getClientIp = (req: Request): string | undefined => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    const first = String(forwarded[0]).split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();
  if (req.ip) return req.ip;
  const socketIp = (req.socket as any)?.remoteAddress;
  if (socketIp) return String(socketIp);
  return undefined;
};

export const requestContext = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const user = (req as any).user;
  storage.run(
    {
      ip: getClientIp(req),
      actor_id: user?._id ? String(user._id) : null,
      actor_role: user?.role ?? null,
      organization_id: user?.organization_id
        ? String(user.organization_id)
        : null,
    },
    () => next(),
  );
};

export const getRequestContext = (): RequestContext | undefined =>
  storage.getStore();
