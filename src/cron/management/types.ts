/**
 * Types for the CronZivo Cron Management API v1.
 *
 * Contract: `cronzivo_api/docs/management-api-contract.md`.
 * Token spec: `cronzivo_api/docs/management-token.md`.
 */

export type CronJobId = string;

export interface CronJobCapabilities {
  start: boolean;
  stop: boolean;
  run: boolean;
  update_schedule: boolean;
}

export interface CronJobLogContext {
  log: (
    level: 'INFO' | 'WARN' | 'ERROR',
    message: string,
    data?: Record<string, unknown>,
  ) => Promise<void>;
}

export type CronJobHandler = (
  ctx: CronJobLogContext,
) => Promise<unknown> | unknown;

export interface CronJobDefinition {
  id: CronJobId;
  name: string;
  description: string;
  defaultExpression: string;
  defaultTimezone: string;
  concurrentSafe: boolean;
  capabilities: CronJobCapabilities;
  handler: CronJobHandler;
}

export interface ManagementAuditContext {
  requestId: string;
  ip: string;
  actor?: string;
}

export interface ScheduleView {
  expression: string;
  timezone: string;
  source: 'default' | 'custom';
  default_expression: string;
  default_timezone: string;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

export interface ExecutionSummaryView {
  execution_id: string;
  status: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface JobView {
  id: string;
  name: string;
  description: string;
  schedule: ScheduleView;
  scheduling: 'ACTIVE' | 'STOPPED';
  execution: 'IDLE' | 'RUNNING';
  next_run_at: string | null;
  last_execution: ExecutionSummaryView | null;
  runtime: 'nodejs';
  scheduler: 'cron-parser';
  capabilities: CronJobCapabilities;
}

export interface ExecutionView {
  execution_id: string;
  job_id: string;
  trigger: string;
  triggered_by: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error: { message: string } | null;
  summary: string | null;
}

export interface LogView {
  ts: string;
  level: string;
  message: string;
  execution_id: string | null;
  data: Record<string, unknown> | null;
}

export interface AuditView {
  id: string;
  job_id: string;
  command: string;
  actor: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  request_id: string;
  ip: string;
  outcome: 'SUCCESS' | 'FAILED';
  ts: string;
}

export interface CollectionView<T> {
  items: T[];
  next_cursor: string | null;
}

export interface BulkItemResult {
  job_id: string;
  ok: boolean;
  changed?: boolean;
  code?: string;
  message?: string;
  execution_id?: string;
  status?: string;
}

export interface BulkSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface BulkResult {
  results: BulkItemResult[];
  summary: BulkSummary;
}
