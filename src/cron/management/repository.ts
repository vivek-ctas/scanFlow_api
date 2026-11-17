import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {
  CronExecution,
  CronJobLog,
  CronManagementAudit,
} from '../../models/index.js';
import { validationError } from './errors.js';
import type {
  AuditView,
  CollectionView,
  ExecutionSummaryView,
  ExecutionView,
  LogView,
  ManagementAuditContext,
} from './types.js';

export const toIso = (
  value: Date | string | null | undefined,
): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export const sanitizeText = (value: unknown, max = 500): string => {
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : String(value ?? '');
  return raw
    .replace(/czm1\.[A-Za-z0-9_.-]+/g, '[redacted-token]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
};

export const newExecutionId = (): string => crypto.randomUUID();

export const encodeCursor = (parts: Array<string | number>): string =>
  Buffer.from(parts.join('|'), 'utf8').toString('base64url');

export const decodeCursor = (cursor: string): string[] => {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parts = decoded.split('|');
    if (!parts.length || parts.some((part) => part === '')) {
      throw new Error('empty');
    }
    return parts;
  } catch {
    throw validationError('Invalid cursor');
  }
};

export const parseLimit = (
  value: unknown,
  defaultValue = 50,
  max = 200,
): number => {
  if (value === undefined || value === null || value === '')
    return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw validationError(`limit must be an integer between 1 and ${max}`);
  }
  return parsed;
};

export const serializeExecutionSummary = (row: any): ExecutionSummaryView => ({
  execution_id: String(row.execution_id),
  status: String(row.status),
  trigger: String(row.trigger),
  started_at: toIso(row.started_at) as string,
  finished_at: toIso(row.finished_at),
  duration_ms: row.duration_ms ?? null,
});

export const serializeExecution = (row: any): ExecutionView => ({
  execution_id: String(row.execution_id),
  job_id: String(row.job_id),
  trigger: String(row.trigger),
  triggered_by: String(row.triggered_by),
  status: String(row.status),
  started_at: toIso(row.started_at) as string,
  finished_at: toIso(row.finished_at),
  duration_ms: row.duration_ms ?? null,
  error: row.error?.message ? { message: String(row.error.message) } : null,
  summary: row.summary ?? null,
});

export const serializeLog = (row: any): LogView => ({
  ts: toIso(row.ts) as string,
  level: String(row.level),
  message: String(row.message),
  execution_id: row.execution_id ? String(row.execution_id) : null,
  data: row.data ?? null,
});

export const serializeAudit = (row: any): AuditView => ({
  id: String(row._id),
  job_id: String(row.job_id),
  command: String(row.command),
  actor: String(row.actor),
  before: row.before ?? null,
  after: row.after ?? null,
  request_id: String(row.request_id),
  ip: String(row.ip ?? ''),
  outcome: row.outcome,
  ts: toIso(row.ts) as string,
});

export const createExecution = async (input: {
  jobId: string;
  trigger: 'SCHEDULED' | 'MANUAL';
  triggeredBy: 'system' | 'cronzivo-panel';
  executionId?: string;
  status?: 'RUNNING' | 'SKIPPED';
}) => {
  const executionId = input.executionId ?? newExecutionId();
  const now = new Date();
  const row = await CronExecution.create({
    execution_id: executionId,
    job_id: input.jobId,
    trigger: input.trigger,
    triggered_by: input.triggeredBy,
    status: input.status ?? 'RUNNING',
    started_at: now,
    finished_at: input.status === 'SKIPPED' ? now : null,
    duration_ms: input.status === 'SKIPPED' ? 0 : null,
    error: null,
    summary: null,
  });
  return { row, executionId };
};

export const finishExecution = async (input: {
  executionId: string;
  status: 'SUCCESS' | 'FAILED';
  startedAt: Date;
  summary?: string | null;
  errorMessage?: string | null;
}) => {
  const finishedAt = new Date();
  const duration = Math.max(
    0,
    finishedAt.getTime() - input.startedAt.getTime(),
  );
  await CronExecution.updateOne(
    { execution_id: input.executionId },
    {
      $set: {
        status: input.status,
        finished_at: finishedAt,
        duration_ms: duration,
        summary: input.summary ? sanitizeText(input.summary, 500) : null,
        error: input.errorMessage
          ? { message: sanitizeText(input.errorMessage, 500) }
          : null,
      },
    },
  );
  return duration;
};

export const skipExecution = async (input: {
  jobId: string;
  executionId: string;
  summary: string;
}) => {
  const now = new Date();
  await CronExecution.create({
    execution_id: input.executionId,
    job_id: input.jobId,
    trigger: 'SCHEDULED',
    triggered_by: 'system',
    status: 'SKIPPED',
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    error: null,
    summary: sanitizeText(input.summary, 500),
  });
};

export const lastExecutionByJob = async (
  jobIds: string[],
): Promise<Map<string, any>> => {
  if (!jobIds.length) return new Map();
  const rows = await CronExecution.aggregate([
    { $match: { job_id: { $in: jobIds } } },
    { $sort: { started_at: -1, _id: -1 } },
    {
      $group: {
        _id: '$job_id',
        row: { $first: '$$ROOT' },
      },
    },
  ]);
  return new Map(rows.map((entry: any) => [String(entry._id), entry.row]));
};

export const listExecutions = async (input: {
  jobId: string;
  limit: number;
  cursor?: string;
  status?: string;
  trigger?: string;
}): Promise<CollectionView<ExecutionView>> => {
  const query: Record<string, unknown> = { job_id: input.jobId };
  if (input.status) query.status = input.status;
  if (input.trigger) query.trigger = input.trigger;

  if (input.cursor) {
    const parts = decodeCursor(input.cursor);
    const ms = Number(parts[0]);
    const id = parts[1];
    if (!Number.isFinite(ms) || !id || !mongoose.isValidObjectId(id)) {
      throw validationError('Invalid cursor');
    }
    const startedAt = new Date(ms);
    query.$or = [
      { started_at: { $lt: startedAt } },
      { started_at: startedAt, _id: { $lt: new mongoose.Types.ObjectId(id) } },
    ];
  }

  const rows = await CronExecution.find(query)
    .sort({ started_at: -1, _id: -1 })
    .limit(input.limit + 1)
    .lean();

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(serializeExecution),
    next_cursor:
      hasMore && last
        ? encodeCursor([
            new Date((last as any).started_at).getTime(),
            String((last as any)._id),
          ])
        : null,
  };
};

export const writeLog = async (input: {
  jobId: string;
  executionId?: string | null;
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
  data?: Record<string, unknown> | null;
}) => {
  await CronJobLog.create({
    job_id: input.jobId,
    execution_id: input.executionId ?? null,
    level: input.level,
    message: sanitizeText(input.message, 2000),
    data: input.data ?? null,
    ts: new Date(),
  });
};

export const listLogs = async (input: {
  jobId: string;
  limit: number;
  cursor?: string;
  executionId?: string;
  level?: string;
}): Promise<CollectionView<LogView>> => {
  const query: Record<string, unknown> = { job_id: input.jobId };
  if (input.executionId) query.execution_id = input.executionId;
  if (input.level) query.level = input.level;

  if (input.cursor) {
    const parts = decodeCursor(input.cursor);
    const ms = Number(parts[0]);
    const id = parts[1];
    if (!Number.isFinite(ms) || !id || !mongoose.isValidObjectId(id)) {
      throw validationError('Invalid cursor');
    }
    const ts = new Date(ms);
    query.$or = [
      { ts: { $lt: ts } },
      { ts, _id: { $lt: new mongoose.Types.ObjectId(id) } },
    ];
  }

  const rows = await CronJobLog.find(query)
    .sort({ ts: -1, _id: -1 })
    .limit(input.limit + 1)
    .lean();

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(serializeLog),
    next_cursor:
      hasMore && last
        ? encodeCursor([
            new Date((last as any).ts).getTime(),
            String((last as any)._id),
          ])
        : null,
  };
};

export const writeAudit = async (input: {
  jobId: string;
  command: string;
  outcome: 'SUCCESS' | 'FAILED';
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  context: ManagementAuditContext;
}) => {
  await CronManagementAudit.create({
    job_id: input.jobId,
    command: input.command,
    actor: input.context.actor ?? 'cronzivo-panel',
    before: input.before ?? null,
    after: input.after ?? null,
    request_id: input.context.requestId,
    ip: input.context.ip || null,
    outcome: input.outcome,
    ts: new Date(),
  });
};

export const listAudit = async (input: {
  jobId: string;
  limit: number;
  cursor?: string;
  command?: string;
}): Promise<CollectionView<AuditView>> => {
  const query: Record<string, unknown> = { job_id: input.jobId };
  if (input.command) query.command = input.command;

  if (input.cursor) {
    const parts = decodeCursor(input.cursor);
    const ms = Number(parts[0]);
    const id = parts[1];
    if (!Number.isFinite(ms) || !id || !mongoose.isValidObjectId(id)) {
      throw validationError('Invalid cursor');
    }
    const ts = new Date(ms);
    query.$or = [
      { ts: { $lt: ts } },
      { ts, _id: { $lt: new mongoose.Types.ObjectId(id) } },
    ];
  }

  const rows = await CronManagementAudit.find(query)
    .sort({ ts: -1, _id: -1 })
    .limit(input.limit + 1)
    .lean();

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(serializeAudit),
    next_cursor:
      hasMore && last
        ? encodeCursor([
            new Date((last as any).ts).getTime(),
            String((last as any)._id),
          ])
        : null,
  };
};
