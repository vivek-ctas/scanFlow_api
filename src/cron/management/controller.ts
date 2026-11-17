import httpStatus from 'http-status';
import type { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync.js';
import {
  ManagementError,
  capabilityNotSupported,
  validationError,
} from './errors.js';
import { cronManager } from './manager.js';
import { failure, success } from './http.js';
import { parseLimit } from './repository.js';
import type { ManagementAuditContext } from './types.js';

const auditOf = (req: Request, res: Response): ManagementAuditContext => ({
  requestId: String(res.locals.requestId ?? ''),
  ip: req.ip ?? req.socket?.remoteAddress ?? '',
  actor: 'cronzivo-panel',
});

const bodyObject = (req: Request): Record<string, unknown> => {
  const body = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw validationError('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
};

const assertAllowedKeys = (
  body: Record<string, unknown>,
  allowed: string[],
): void => {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw validationError(`Unknown field(s): ${unknown.join(', ')}`);
  }
};

const assertEmptyBody = (req: Request): void => {
  const body = bodyObject(req);
  if (Object.keys(body).length > 0) {
    throw validationError('This endpoint does not accept a request body');
  }
};

const queryString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    throw validationError('Query parameter must be a single value');
  }
  if (typeof value !== 'string') {
    throw validationError('Query parameter must be a string');
  }
  return value;
};

const nonEmptyString = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw validationError(`${key} is required`);
  }
  return value;
};

const parseScheduleBody = (req: Request) => {
  const body = bodyObject(req);
  assertAllowedKeys(body, [
    'expression',
    'timezone',
    'expected_version',
    'dry_run',
  ]);
  const expression = nonEmptyString(body, 'expression');
  const timezone = nonEmptyString(body, 'timezone');

  let expectedVersion: number | undefined;
  if (body.expected_version !== undefined) {
    if (
      typeof body.expected_version !== 'number' ||
      !Number.isInteger(body.expected_version) ||
      body.expected_version < 1
    ) {
      throw validationError('expected_version must be a positive integer');
    }
    expectedVersion = body.expected_version;
  }

  let dryRun = false;
  if (body.dry_run !== undefined) {
    if (typeof body.dry_run !== 'boolean') {
      throw validationError('dry_run must be a boolean');
    }
    dryRun = body.dry_run;
  }

  return { expression, timezone, expectedVersion, dryRun };
};

const parseBulkBody = (req: Request) => {
  const body = bodyObject(req);
  assertAllowedKeys(body, ['job_ids', 'confirm']);
  if (body.confirm !== true) {
    throw new ManagementError(
      httpStatus.BAD_REQUEST,
      'CONFIRMATION_REQUIRED',
      'confirm:true is required for bulk operations',
    );
  }
  if (
    body.job_ids !== undefined &&
    body.job_ids !== null &&
    !Array.isArray(body.job_ids)
  ) {
    throw validationError('job_ids must be an array of strings or null');
  }
  return { jobIds: body.job_ids };
};

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
  assertEmptyBody(req);
  success(
    res,
    await cronManager.startJob(
      String(req.params.id),
      auditOf(req, res),
      'start',
    ),
  );
});

export const stopJob = catchAsync(async (req, res) => {
  assertEmptyBody(req);
  success(
    res,
    await cronManager.stopJob(String(req.params.id), auditOf(req, res), 'stop'),
  );
});

export const runJob = catchAsync(async (req, res) => {
  assertEmptyBody(req);
  const result = await cronManager.runManual(
    String(req.params.id),
    auditOf(req, res),
    'run',
  );
  success(res, result, httpStatus.ACCEPTED);
});

export const updateSchedule = catchAsync(async (req, res) => {
  const input = parseScheduleBody(req);
  const result = await cronManager.updateSchedule(
    String(req.params.id),
    input,
    auditOf(req, res),
  );
  success(res, result);
});

export const resetSchedule = catchAsync(async (req, res) => {
  assertEmptyBody(req);
  success(
    res,
    await cronManager.resetSchedule(String(req.params.id), auditOf(req, res)),
  );
});

export const listExecutions = catchAsync(async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const cursor = queryString(req.query.cursor);
  const status = queryString(req.query.status);
  const trigger = queryString(req.query.trigger);
  success(
    res,
    await cronManager.executions(String(req.params.id), {
      limit,
      cursor,
      status,
      trigger,
    }),
  );
});

export const listLogs = catchAsync(async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const cursor = queryString(req.query.cursor);
  const executionId = queryString(req.query.execution_id);
  const level = queryString(req.query.level);
  success(
    res,
    await cronManager.logs(String(req.params.id), {
      limit,
      cursor,
      executionId,
      level,
    }),
  );
});

export const listAudit = catchAsync(async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const cursor = queryString(req.query.cursor);
  const command = queryString(req.query.command);
  success(
    res,
    await cronManager.audit(String(req.params.id), {
      limit,
      cursor,
      command,
    }),
  );
});

export const bulkStart = catchAsync(async (req, res) => {
  const { jobIds } = parseBulkBody(req);
  success(
    res,
    await cronManager.bulkStart({ jobIds, audit: auditOf(req, res) }),
  );
});

export const bulkStop = catchAsync(async (req, res) => {
  const { jobIds } = parseBulkBody(req);
  success(
    res,
    await cronManager.bulkStop({ jobIds, audit: auditOf(req, res) }),
  );
});

export const bulkRun = catchAsync(async (req, res) => {
  const { jobIds } = parseBulkBody(req);
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
