import httpStatus from 'http-status';
import type { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync.js';
import { ManagementError, capabilityNotSupported } from './errors.js';
import { cronManager } from './manager.js';
import { failure, success } from './http.js';
import type { ManagementAuditContext } from './types.js';

const auditOf = (req: Request, res: Response): ManagementAuditContext => {
  const token = (req as any).managementToken ?? {};
  return {
    requestId: String(res.locals.requestId ?? ''),
    ip: req.ip ?? req.socket?.remoteAddress ?? '',
    // Correlate the command with the token; never store the token itself.
    tokenJti: typeof token.jti === 'string' ? token.jti : null,
    userAgent: req.header('user-agent') ?? null,
    source: 'cronzivo-panel',
  };
};

const query = (req: Request) => req.query as Record<string, any>;

// --------------------------------------------------------------------- routes

export const health = catchAsync(async (_req, res) => {
  success(res, await cronManager.health());
});

export const capabilities = catchAsync(async (_req, res) => {
  success(res, cronManager.capabilities());
});

export const listJobs = catchAsync(async (_req, res) => {
  success(res, await cronManager.listJobs());
});

export const getJob = catchAsync(async (req, res) => {
  success(res, await cronManager.getJob(String(req.params.id)));
});

export const getJobStatus = catchAsync(async (req, res) => {
  success(res, await cronManager.getStatus(String(req.params.id)));
});

export const startJob = catchAsync(async (req, res) => {
  success(
    res,
    await cronManager.startJob(String(req.params.id), auditOf(req, res)),
  );
});

export const stopJob = catchAsync(async (req, res) => {
  success(
    res,
    await cronManager.stopJob(String(req.params.id), auditOf(req, res)),
  );
});

export const runJob = catchAsync(async (req, res) => {
  const result = await cronManager.runManual(
    String(req.params.id),
    auditOf(req, res),
  );
  success(res, result, httpStatus.ACCEPTED);
});

export const updateSchedule = catchAsync(async (req, res) => {
  const body = req.body as Record<string, any>;
  const result = await cronManager.updateSchedule(
    String(req.params.id),
    {
      expression: String(body.expression),
      timezone: String(body.timezone),
      expectedVersion: body.expected_version,
      dryRun: body.dry_run === true,
    },
    auditOf(req, res),
  );
  success(res, result);
});

export const resetSchedule = catchAsync(async (req, res) => {
  success(
    res,
    await cronManager.resetSchedule(String(req.params.id), auditOf(req, res)),
  );
});

export const listExecutions = catchAsync(async (req, res) => {
  const q = query(req);
  success(
    res,
    await cronManager.executions(String(req.params.id), {
      limit: q.limit,
      cursor: q.cursor,
      status: q.status,
      trigger: q.trigger,
      from: q.from,
      to: q.to,
    }),
  );
});

export const listLogs = catchAsync(async (req, res) => {
  const q = query(req);
  success(
    res,
    await cronManager.logs(String(req.params.id), {
      limit: q.limit,
      cursor: q.cursor,
      executionId: q.execution_id,
      level: q.level,
    }),
  );
});

export const listAudit = catchAsync(async (req, res) => {
  const q = query(req);
  success(
    res,
    await cronManager.audit(String(req.params.id), {
      limit: q.limit,
      cursor: q.cursor,
      command: q.command,
    }),
  );
});

export const listAllAudit = catchAsync(async (req, res) => {
  const q = query(req);
  success(
    res,
    await cronManager.globalAudit({
      jobId: q.job_id,
      limit: q.limit,
      cursor: q.cursor,
      command: q.command,
      outcome: q.outcome,
      from: q.from,
      to: q.to,
    }),
  );
});

const assertConfirmed = (req: Request): void => {
  if ((req.body as Record<string, unknown>).confirm !== true) {
    throw new ManagementError(
      httpStatus.BAD_REQUEST,
      'CONFIRMATION_REQUIRED',
      'confirm:true is required for bulk operations',
    );
  }
};

export const bulkStart = catchAsync(async (req, res) => {
  assertConfirmed(req);
  const jobIds = (req.body as Record<string, unknown>).job_ids;
  success(
    res,
    await cronManager.bulkStart({ jobIds, audit: auditOf(req, res) }),
  );
});

export const bulkStop = catchAsync(async (req, res) => {
  assertConfirmed(req);
  const jobIds = (req.body as Record<string, unknown>).job_ids;
  success(
    res,
    await cronManager.bulkStop({ jobIds, audit: auditOf(req, res) }),
  );
});

export const bulkRun = catchAsync(async (req, res) => {
  assertConfirmed(req);
  const jobIds = (req.body as Record<string, unknown>).job_ids;
  const result = await cronManager.bulkRun({
    jobIds,
    audit: auditOf(req, res),
  });
  success(res, result, httpStatus.ACCEPTED);
});

export const cancelJob = catchAsync(async (_req, res) => {
  // Honest capability: ScanFlow cannot safely cancel an in-flight handler.
  const error = capabilityNotSupported();
  failure(res, error.statusCode, error.code, error.message);
});
