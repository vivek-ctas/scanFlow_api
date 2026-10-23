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
export const requestContext = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const user = (req as any).user;
  storage.run(
    {
      ip: req.ip,
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
