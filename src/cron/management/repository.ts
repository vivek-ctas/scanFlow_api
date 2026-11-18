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
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '[redacted-token]',
    )
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

export const serializeExecution = (row: any): ExecutionView => {
  // `error.message` is the legacy shape; new rows store `error_message`.
  const errorMessage =
    row.error_message ?? row.error?.message ?? row.error ?? null;
  return {
    execution_id: String(row.execution_id),
    job_id: String(row.job_id),
    trigger: String(row.trigger),
    triggered_by: String(row.triggered_by),
    status: String(row.status),
    started_at: toIso(row.started_at) as string,
    finished_at: toIso(row.finished_at),
    duration_ms: row.duration_ms ?? null,
    error_message: errorMessage ? String(errorMessage) : null,
    // Kept for older panels; `error_message` is canonical.
    error: errorMessage ? { message: String(errorMessage) } : null,
    summary: row.summary ?? null,
  };
};

export const serializeLog = (row: any): LogView => ({
  seq: Number(row.seq ?? 0),
  ts: toIso(row.ts) as string,
  level: String(row.level),
  message: String(row.message),
  execution_id: row.execution_id ? String(row.execution_id) : null,
  data: row.data ?? null,
});

export const serializeAudit = (row: any): AuditView => {
  // Rows written before the actor-object migration stored `actor` as a string
  // and `ip` at the top level; normalise both shapes on read.
  const legacyActor =
    typeof row.actor === 'string' ? row.actor : row.actor?.source;
  return {
    id: String(row._id),
    job_id: String(row.job_id),
    command: String(row.command),
    actor: {
      source: legacyActor ? String(legacyActor) : 'cronzivo-panel',
      token_jti: row.actor?.token_jti ? String(row.actor.token_jti) : null,
      ip: row.actor?.ip ? String(row.actor.ip) : row.ip ? String(row.ip) : null,
      user_agent: row.actor?.user_agent ? String(row.actor.user_agent) : null,
    },
    before: row.before ?? null,
    after: row.after ?? null,
    bulk_id: row.bulk_id ? String(row.bulk_id) : null,
    request_id: String(row.request_id),
    outcome: row.outcome,
    error_code: row.error_code ? String(row.error_code) : null,
    ts: toIso(row.ts) as string,
  };
};

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
    error_message: null,
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
        error_message: input.errorMessage
          ? sanitizeText(input.errorMessage, 500)
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
    error_message: null,
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
  from?: Date;
  to?: Date;
}): Promise<CollectionView<ExecutionView>> => {
  const query: Record<string, unknown> = { job_id: input.jobId };
  if (input.status) query.status = input.status;
  if (input.trigger) query.trigger = input.trigger;
  if (input.from || input.to) {
    const range: Record<string, Date> = {};
    if (input.from) range.$gte = input.from;
    if (input.to) range.$lte = input.to;
    query.started_at = range;
  }

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
  let seq = 0;
  if (input.executionId) {
    const last = await CronJobLog.findOne({
      execution_id: input.executionId,
    })
      .sort({ seq: -1 })
      .select('seq')
      .lean();
    seq = Number((last as any)?.seq ?? 0) + 1;
    // Cap stored lines per execution (contract: ~500).
    if (seq > 500) return;
  }
  await CronJobLog.create({
    job_id: input.jobId,
    execution_id: input.executionId ?? null,
    seq,
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
  outcome: 'SUCCESS' | 'FAILED' | 'REJECTED';
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  errorCode?: string | null;
  bulkId?: string | null;
  context: ManagementAuditContext;
}) => {
  await CronManagementAudit.create({
    job_id: input.jobId,
    command: input.command,
    actor: {
      source: input.context.source ?? 'cronzivo-panel',
      token_jti: input.context.tokenJti ?? null,
      ip: input.context.ip || null,
      user_agent: input.context.userAgent ?? null,
    },
    before: input.before ?? null,
    after: input.after ?? null,
    bulk_id: input.bulkId ?? input.context.bulkId ?? null,
    request_id: input.context.requestId,
    outcome: input.outcome,
    error_code: input.errorCode ?? null,
    ts: new Date(),
  });
};

export const listAudit = async (input: {
  jobId?: string;
  limit: number;
  cursor?: string;
  command?: string;
  outcome?: string;
  from?: Date;
  to?: Date;
}): Promise<CollectionView<AuditView>> => {
  const query: Record<string, unknown> = {};
  if (input.jobId) query.job_id = input.jobId;
  if (input.command) query.command = input.command;
  if (input.outcome) query.outcome = input.outcome;
  if (input.from || input.to) {
    const range: Record<string, Date> = {};
    if (input.from) range.$gte = input.from;
    if (input.to) range.$lte = input.to;
    query.ts = range;
  }

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
