import httpStatus from 'http-status';
import config from '../../config/config.js';
import { logger } from '../../config/logger.js';
import { CronSchedule } from '../../models/index.js';
import { errorHandler } from '../../utils/system-error.handler.js';
import { systemLog } from '../../utils/system-log.js';
import { getRedis, isRedisConfigured } from '../../queues/redis.js';
import { JOB_REGISTRY, findJob } from './registry.js';
import { CronSchedulerAdapter } from './scheduler.js';
import {
  assertValidSchedule,
  CronValidationError,
  nextRunDate,
  nextRunDates,
} from './cron.js';
import {
  ManagementError,
  capabilityNotSupported,
  jobNotFound,
  validationError,
} from './errors.js';
import {
  createExecution,
  finishExecution,
  lastExecutionByJob,
  listAudit,
  listExecutions,
  listLogs,
  newExecutionId,
  sanitizeText,
  serializeExecutionSummary,
  skipExecution,
  toIso,
  writeAudit,
  writeLog,
} from './repository.js';
import type {
  BulkItemResult,
  BulkResult,
  CollectionView,
  CronJobDefinition,
  JobView,
  ManagementAuditContext,
} from './types.js';

const SCHEDULER_HEARTBEAT_KEY = 'cronzivo:scheduler:heartbeat';
const SCHEDULER_HEARTBEAT_TTL_SEC = 90;
const EXECUTION_LEASE_MS = 30 * 60 * 1000;

const summaryOf = (jobId: string, result: unknown): string => {
  if (typeof result === 'string') return result;
  if (typeof result === 'number' || typeof result === 'boolean') {
    return String(result);
  }
  if (result && typeof result === 'object') {
    try {
      return JSON.stringify(result).slice(0, 500);
    } catch {
      return `${jobId} completed`;
    }
  }
  return `${jobId} completed`;
};

const mapCronValidation = (error: unknown): ManagementError => {
  if (error instanceof CronValidationError) {
    return new ManagementError(
      httpStatus.BAD_REQUEST,
      error.code,
      error.message,
    );
  }
  return new ManagementError(
    httpStatus.INTERNAL_SERVER_ERROR,
    'INTERNAL_ERROR',
    'Internal server error',
  );
};

const skippedCodes = new Set(['JOB_ALREADY_RUNNING', 'JOB_NOT_RUNNABLE']);

export class CronManager {
  private readonly scheduler = new CronSchedulerAdapter();
  private readonly running = new Map<string, string>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private started = false;

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    await this.seedSchedules();
    this.started = true;
    await this.reconcile();
    await this.writeSchedulerHeartbeat();

    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch((error) => {
        logger.error(
          `[CRONZIVO] reconcile failed: ${sanitizeText(error, 300)}`,
        );
      });
    }, config.cronzivo.reconcileSec * 1000);
    this.reconcileTimer.unref();

    this.heartbeatTimer = setInterval(() => {
      void this.writeSchedulerHeartbeat();
    }, 30_000);
    this.heartbeatTimer.unref();

    logger.info(
      `[CRONZIVO] scheduler started (${JOB_REGISTRY.length} jobs, reconcile ${config.cronzivo.reconcileSec}s)`,
    );
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconcileTimer = null;
    this.heartbeatTimer = null;
    this.scheduler.stopAll();
    this.started = false;
    await this.setSchedulerHeartbeat('stopped');
    logger.info('[CRONZIVO] scheduler stopped');
  }

  isStarted(): boolean {
    return this.started;
  }

  // -------------------------------------------------------------- persistence

  async seedSchedules(jobs: CronJobDefinition[] = JOB_REGISTRY): Promise<void> {
    await Promise.all(
      jobs.map(async (job) => {
        try {
          await CronSchedule.updateOne(
            { job_id: job.id },
            {
              $setOnInsert: {
                job_id: job.id,
                enabled: true,
                cron_expression: job.defaultExpression,
                timezone: job.defaultTimezone,
                source: 'default',
                version: 1,
                updated_by: null,
                lock_execution_id: null,
                lock_expires_at: null,
              },
            },
            { upsert: true },
          );
        } catch (error: any) {
          // Concurrent seeding from another process: the row already exists.
          if (error?.code !== 11000) throw error;
        }
      }),
    );
  }

  private async ensureSchedule(job: CronJobDefinition) {
    let row = await CronSchedule.findOne({ job_id: job.id });
    if (!row) {
      await this.seedSchedules([job]);
      row = await CronSchedule.findOne({ job_id: job.id });
    }
    if (!row) {
      throw new ManagementError(
        httpStatus.INTERNAL_SERVER_ERROR,
        'INTERNAL_ERROR',
        'Failed to initialise job schedule',
      );
    }
    return row;
  }

  /**
   * Apply persisted schedules to the running scheduler. In the API process the
   * scheduler is control-only and this is a no-op; the worker applies changes
   * within `CRONZIVO_RECONCILE_SEC`.
   */
  async reconcile(): Promise<void> {
    if (!this.started) return;

    const ids = JOB_REGISTRY.map((job) => job.id);
    const rows = await CronSchedule.find({ job_id: { $in: ids } }).lean();
    const byId = new Map(rows.map((row: any) => [String(row.job_id), row]));

    for (const job of JOB_REGISTRY) {
      const row: any = byId.get(job.id);
      const registered = this.scheduler.getRegistration(job.id);
      if (!row || !row.enabled) {
        if (registered) this.scheduler.unregister(job.id);
        continue;
      }

      const sameSchedule =
        registered &&
        registered.expression === row.cron_expression &&
        registered.timezone === row.timezone;

      if (!sameSchedule) {
        this.scheduler.register(job.id, row.cron_expression, row.timezone, () =>
          this.runScheduled(job.id),
        );
      }
    }

    for (const id of this.scheduler.registeredIds()) {
      const row: any = byId.get(id);
      if (!row || !row.enabled) this.scheduler.unregister(id);
    }
  }

  // ---------------------------------------------------------------- execution

  private async acquireLease(
    jobId: string,
    executionId: string,
  ): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXECUTION_LEASE_MS);
    const row = await CronSchedule.findOneAndUpdate(
      {
        job_id: jobId,
        $or: [
          { lock_execution_id: null },
          { lock_expires_at: null },
          { lock_expires_at: { $lte: now } },
        ],
      },
      {
        $set: {
          lock_execution_id: executionId,
          lock_expires_at: expiresAt,
        },
      },
      { returnDocument: 'after' },
    );
    return Boolean(row);
  }

  private async releaseLease(
    jobId: string,
    executionId: string,
  ): Promise<void> {
    await CronSchedule.updateOne(
      { job_id: jobId, lock_execution_id: executionId },
      { $set: { lock_execution_id: null, lock_expires_at: null } },
    );
  }

  private async leaseHeld(jobId: string): Promise<boolean> {
    const row = await CronSchedule.findOne({ job_id: jobId })
      .select('lock_execution_id lock_expires_at')
      .lean();
    if (!row || !row.lock_execution_id || !row.lock_expires_at) return false;
    return new Date(row.lock_expires_at).getTime() > Date.now();
  }

  private isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  private async safeLog(
    jobId: string,
    executionId: string | null,
    level: 'INFO' | 'WARN' | 'ERROR',
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await writeLog({
        jobId,
        executionId,
        level,
        message,
        data: data ?? null,
      });
    } catch (error) {
      logger.error(
        `[CRONZIVO] failed to write log for ${jobId}: ${sanitizeText(error, 200)}`,
      );
    }
  }

  private async safeSystemLog(
    jobId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await systemLog({
        operation: 'CRON',
        key: `cron:${jobId}`,
        data: payload,
        actorRole: 'SYSTEM',
      });
    } catch (error) {
      logger.error(
        `[CRONZIVO] failed to write system log for ${jobId}: ${sanitizeText(error, 200)}`,
      );
    }
  }

  private async safeAudit(input: {
    jobId: string;
    command: string;
    outcome: 'SUCCESS' | 'FAILED' | 'REJECTED';
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    errorCode?: string | null;
    bulkId?: string | null;
    context: ManagementAuditContext;
  }): Promise<void> {
    try {
      await writeAudit(input);
    } catch (error) {
      logger.error(
        `[CRONZIVO] failed to write audit for ${input.jobId}: ${sanitizeText(error, 200)}`,
      );
    }
  }

  private async execute(
    job: CronJobDefinition,
    execution: any,
    executionId: string,
  ): Promise<void> {
    const startedAt: Date = execution.started_at ?? new Date();
    const ctx = {
      log: (
        level: 'INFO' | 'WARN' | 'ERROR',
        message: string,
        data?: Record<string, unknown>,
      ) => this.safeLog(job.id, executionId, level, message, data),
    };

    try {
      await this.safeLog(job.id, executionId, 'INFO', 'job started');
      const result = await job.handler(ctx);
      const summary = summaryOf(job.id, result);
      const duration = await finishExecution({
        executionId,
        status: 'SUCCESS',
        startedAt,
        summary,
      });
      await this.safeLog(job.id, executionId, 'INFO', 'job completed', {
        duration_ms: duration,
      });
      await this.safeSystemLog(job.id, {
        status: 'completed',
        duration_ms: duration,
        execution_id: executionId,
      });
      logger.info(`[CRONZIVO] ${job.id} completed in ${duration}ms`);
    } catch (error) {
      const message = sanitizeText(error, 500);
      const duration = await finishExecution({
        executionId,
        status: 'FAILED',
        startedAt,
        errorMessage: message,
      });
      await this.safeLog(job.id, executionId, 'ERROR', 'job failed', {
        duration_ms: duration,
        error: message,
      });
      await this.safeSystemLog(job.id, {
        status: 'failed',
        duration_ms: duration,
        execution_id: executionId,
        error: message,
      });
      logger.error(`[CRONZIVO] ${job.id} failed in ${duration}ms: ${message}`);
      try {
        await errorHandler.errorM({
          action_type: `cron-${job.id}`,
          error_data: error,
        });
      } catch {
        // Persisted error reporting is best-effort.
      }
    } finally {
      if (this.running.get(job.id) === executionId) {
        this.running.delete(job.id);
      }
      try {
        await this.releaseLease(job.id, executionId);
      } catch (error) {
        logger.error(
          `[CRONZIVO] failed to release lease for ${job.id}: ${sanitizeText(error, 200)}`,
        );
      }
    }
  }

  private async runScheduled(jobId: string): Promise<void> {
    const job = findJob(jobId);
    if (!job || !job.capabilities.run) return;

    await this.ensureSchedule(job);
    const executionId = newExecutionId();
    const acquired = await this.acquireLease(jobId, executionId);
    if (!acquired) {
      await skipExecution({
        jobId,
        executionId,
        summary: 'overlapping run skipped',
      });
      await this.safeLog(
        jobId,
        executionId,
        'WARN',
        'scheduled run skipped: another execution holds the lease',
      );
      return;
    }

    let execution: any;
    try {
      const created = await createExecution({
        jobId,
        trigger: 'SCHEDULED',
        triggeredBy: 'system',
        executionId,
      });
      execution = created.row;
    } catch (error) {
      await this.releaseLease(jobId, executionId);
      throw error;
    }

    this.running.set(jobId, executionId);
    await this.execute(job, execution, executionId);
  }

  // ---------------------------------------------------------------- commands

  async startJob(
    jobId: string,
    audit: ManagementAuditContext,
    command = 'START',
  ) {
    const job = findJob(jobId);
    if (!job) {
      await this.safeAudit({
        jobId,
        command,
        outcome: 'REJECTED',
        errorCode: 'JOB_NOT_FOUND',
        context: audit,
      });
      throw jobNotFound();
    }
    if (!job.capabilities.start) {
      await this.safeAudit({
        jobId,
        command,
        outcome: 'REJECTED',
        errorCode: 'CAPABILITY_NOT_SUPPORTED',
        context: audit,
      });
      throw capabilityNotSupported();
    }

    let row = await this.ensureSchedule(job);
    const before = {
      enabled: row.enabled,
      expression: row.cron_expression,
      timezone: row.timezone,
      version: row.version,
    };
    if (row.enabled) {
      const result = {
        id: job.id,
        scheduling: 'ACTIVE' as const,
        changed: false,
        next_run_at: toIso(this.nextRunFor(row)),
      };
      await this.safeAudit({
        jobId,
        command,
        outcome: 'SUCCESS',
        before,
        after: before,
        context: audit,
      });
      return result;
    }

    const enabled = await CronSchedule.findOneAndUpdate(
      { job_id: job.id },
      { $set: { enabled: true } },
      { returnDocument: 'after' },
    );
    if (!enabled) throw jobNotFound();
    row = enabled;

    try {
      await this.reconcile();
    } catch (error) {
      await CronSchedule.updateOne(
        { job_id: job.id },
        { $set: { enabled: before.enabled } },
      );
      await this.safeAudit({
        jobId,
        command,
        outcome: 'FAILED',
        errorCode: 'SCHEDULER_APPLY_FAILED',
        before,
        context: audit,
      });
      logger.error(
        `[CRONZIVO] start apply failed for ${job.id}: ${sanitizeText(error, 200)}`,
      );
      throw new ManagementError(
        httpStatus.INTERNAL_SERVER_ERROR,
        'SCHEDULER_APPLY_FAILED',
        'Schedule was persisted but the scheduler apply failed',
      );
    }

    const result = {
      id: job.id,
      scheduling: 'ACTIVE' as const,
      changed: true,
      next_run_at: toIso(this.nextRunFor(row)),
    };
    await this.safeAudit({
      jobId,
      command,
      outcome: 'SUCCESS',
      before,
      after: { ...before, enabled: true },
      context: audit,
    });
    return result;
  }

  async stopJob(
    jobId: string,
    audit: ManagementAuditContext,
    command = 'STOP',
  ) {
    const job = findJob(jobId);
    if (!job) {
      await this.safeAudit({
        jobId,
        command,
        outcome: 'REJECTED',
        errorCode: 'JOB_NOT_FOUND',
        context: audit,
      });
      throw jobNotFound();
    }
    if (!job.capabilities.stop) {
      await this.safeAudit({
        jobId,
        command,
        outcome: 'REJECTED',
        errorCode: 'CAPABILITY_NOT_SUPPORTED',
        context: audit,
      });
      throw capabilityNotSupported();
    }

    let row = await this.ensureSchedule(job);
    const before = {
      enabled: row.enabled,
      expression: row.cron_expression,
      timezone: row.timezone,
      version: row.version,
    };
    const executionInProgress =
      this.isRunning(job.id) || (await this.leaseHeld(job.id));

    if (!row.enabled) {
      const result = {
        id: job.id,
        scheduling: 'STOPPED' as const,
        changed: false,
        execution_in_progress: executionInProgress,
      };
      await this.safeAudit({
        jobId,
        command,
        outcome: 'SUCCESS',
        before,
        after: before,
        context: audit,
      });
      return result;
    }

    const disabled = await CronSchedule.findOneAndUpdate(
      { job_id: job.id },
      { $set: { enabled: false } },
      { returnDocument: 'after' },
    );
    if (!disabled) throw jobNotFound();
    row = disabled;

    try {
      await this.reconcile();
    } catch {
      await CronSchedule.updateOne(
        { job_id: job.id },
        { $set: { enabled: before.enabled } },
      );
      await this.safeAudit({
        jobId,
        command,
        outcome: 'FAILED',
        errorCode: 'SCHEDULER_APPLY_FAILED',
        before,
        context: audit,
      });
      throw new ManagementError(
        httpStatus.INTERNAL_SERVER_ERROR,
        'SCHEDULER_APPLY_FAILED',
        'Schedule was persisted but the scheduler apply failed',
      );
    }

    const result = {
      id: job.id,
      scheduling: 'STOPPED' as const,
      changed: true,
      execution_in_progress:
        this.isRunning(job.id) || (await this.leaseHeld(job.id)),
    };
    await this.safeAudit({
      jobId,
      command,
      outcome: 'SUCCESS',
      before,
      after: { ...before, enabled: false },
      context: audit,
    });
    return result;
  }

  async runManual(
    jobId: string,
    audit: ManagementAuditContext,
    command = 'RUN',
  ) {
    const job = findJob(jobId);
    if (!job) {
      await this.safeAudit({
        jobId,
        command,
        outcome: 'REJECTED',
        errorCode: 'JOB_NOT_FOUND',
        context: audit,
      });
      throw jobNotFound();
    }
    if (!job.capabilities.run) {
      await this.safeAudit({
        jobId,
        command,
        outcome: 'REJECTED',
        errorCode: 'JOB_NOT_RUNNABLE',
        context: audit,
      });
      throw new ManagementError(
        httpStatus.UNPROCESSABLE_ENTITY,
        'JOB_NOT_RUNNABLE',
        'Job cannot be run on demand',
      );
    }

    await this.ensureSchedule(job);
    if (this.isRunning(job.id) || (await this.leaseHeld(job.id))) {
      await this.safeAudit({
        jobId,
        command,
        outcome: 'REJECTED',
        errorCode: 'JOB_ALREADY_RUNNING',
        after: { code: 'JOB_ALREADY_RUNNING' },
        context: audit,
      });
      throw new ManagementError(
        httpStatus.CONFLICT,
        'JOB_ALREADY_RUNNING',
        'Job is already running',
      );
    }

    const executionId = newExecutionId();
    const acquired = await this.acquireLease(job.id, executionId);
    if (!acquired) {
      await this.safeAudit({
        jobId,
        command,
        outcome: 'REJECTED',
        errorCode: 'JOB_ALREADY_RUNNING',
        after: { code: 'JOB_ALREADY_RUNNING' },
        context: audit,
      });
      throw new ManagementError(
        httpStatus.CONFLICT,
        'JOB_ALREADY_RUNNING',
        'Job is already running',
      );
    }

    let execution: any;
    try {
      const created = await createExecution({
        jobId: job.id,
        trigger: 'MANUAL',
        triggeredBy: 'cronzivo-panel',
        executionId,
      });
      execution = created.row;
    } catch (error) {
      await this.releaseLease(job.id, executionId);
      throw error;
    }

    this.running.set(job.id, executionId);
    const acceptedAt = new Date().toISOString();
    await this.safeAudit({
      jobId,
      command,
      outcome: 'SUCCESS',
      after: { execution_id: executionId, trigger: 'MANUAL' },
      context: audit,
    });

    void this.execute(job, execution, executionId).catch((error) => {
      logger.error(
        `[CRONZIVO] manual run wrapper failed for ${job.id}: ${sanitizeText(error, 200)}`,
      );
    });

    return {
      job_id: job.id,
      execution_id: executionId,
      status: 'RUNNING' as const,
      accepted_at: acceptedAt,
    };
  }

  // ---------------------------------------------------------------- schedules

  scheduleDryRun(expression: string, timezone: string) {
    const validated = assertValidSchedule(expression, timezone);
    const runs = nextRunDates(validated.expression, validated.timezone, 5);
    return {
      valid: true,
      normalized_expression: validated.expression,
      expression: String(expression).trim(),
      timezone: validated.timezone,
      next_runs: runs.map((date) => date.toISOString()),
    };
  }

  async updateSchedule(
    jobId: string,
    input: {
      expression: string;
      timezone: string;
      expectedVersion?: number;
      dryRun: boolean;
    },
    audit: ManagementAuditContext,
  ) {
    const job = findJob(jobId);
    if (!job) {
      await this.safeAudit({
        jobId,
        command: 'SCHEDULE_UPDATE',
        outcome: 'REJECTED',
        errorCode: 'JOB_NOT_FOUND',
        context: audit,
      });
      throw jobNotFound();
    }
    if (!job.capabilities.update_schedule) {
      await this.safeAudit({
        jobId,
        command: 'SCHEDULE_UPDATE',
        outcome: 'REJECTED',
        errorCode: 'CAPABILITY_NOT_SUPPORTED',
        context: audit,
      });
      throw capabilityNotSupported();
    }

    let validated: { expression: string; timezone: string };
    try {
      validated = assertValidSchedule(input.expression, input.timezone);
    } catch (error) {
      const mapped = mapCronValidation(error);
      await this.safeAudit({
        jobId,
        command: 'SCHEDULE_UPDATE',
        outcome: 'REJECTED',
        errorCode: mapped.code,
        context: audit,
      });
      throw mapped;
    }

    if (input.dryRun) {
      return this.scheduleDryRun(validated.expression, validated.timezone);
    }

    const row = await this.ensureSchedule(job);
    const before = {
      expression: row.cron_expression,
      timezone: row.timezone,
      version: row.version,
    };

    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== row.version
    ) {
      await this.safeAudit({
        jobId,
        command: 'SCHEDULE_UPDATE',
        outcome: 'REJECTED',
        errorCode: 'VERSION_CONFLICT',
        before,
        after: { code: 'VERSION_CONFLICT' },
        context: audit,
      });
      throw new ManagementError(
        httpStatus.CONFLICT,
        'VERSION_CONFLICT',
        'Schedule version does not match',
        {
          expected_version: input.expectedVersion,
          actual_version: row.version,
        },
      );
    }

    const updated = await CronSchedule.findOneAndUpdate(
      { job_id: job.id },
      {
        $set: {
          cron_expression: validated.expression,
          timezone: validated.timezone,
          source: 'custom',
          version: row.version + 1,
          updated_by: 'cronzivo-panel',
        },
      },
      { returnDocument: 'after' },
    );
    if (!updated) throw jobNotFound();

    try {
      await this.reconcile();
    } catch (error) {
      await CronSchedule.findOneAndUpdate(
        { job_id: job.id },
        {
          $set: {
            cron_expression: before.expression,
            timezone: before.timezone,
            version: before.version,
          },
        },
      );
      await this.safeAudit({
        jobId,
        command: 'SCHEDULE_UPDATE',
        outcome: 'FAILED',
        errorCode: 'SCHEDULER_APPLY_FAILED',
        before,
        context: audit,
      });
      logger.error(
        `[CRONZIVO] schedule apply failed for ${job.id}: ${sanitizeText(error, 200)}`,
      );
      throw new ManagementError(
        httpStatus.INTERNAL_SERVER_ERROR,
        'SCHEDULER_APPLY_FAILED',
        'Schedule was persisted but the scheduler apply failed',
      );
    }

    await this.safeAudit({
      jobId,
      command: 'SCHEDULE_UPDATE',
      outcome: 'SUCCESS',
      before,
      after: {
        expression: validated.expression,
        timezone: validated.timezone,
        version: row.version + 1,
      },
      context: audit,
    });

    return this.getJob(job.id);
  }

  async resetSchedule(jobId: string, audit: ManagementAuditContext) {
    const job = findJob(jobId);
    if (!job) {
      await this.safeAudit({
        jobId,
        command: 'SCHEDULE_UPDATE',
        outcome: 'REJECTED',
        errorCode: 'JOB_NOT_FOUND',
        context: audit,
      });
      throw jobNotFound();
    }
    if (!job.capabilities.update_schedule) {
      await this.safeAudit({
        jobId,
        command: 'SCHEDULE_UPDATE',
        outcome: 'REJECTED',
        errorCode: 'CAPABILITY_NOT_SUPPORTED',
        context: audit,
      });
      throw capabilityNotSupported();
    }

    const row = await this.ensureSchedule(job);
    const before = {
      expression: row.cron_expression,
      timezone: row.timezone,
      version: row.version,
    };

    const updated = await CronSchedule.findOneAndUpdate(
      { job_id: job.id },
      {
        $set: {
          cron_expression: job.defaultExpression,
          timezone: job.defaultTimezone,
          source: 'default',
          version: row.version + 1,
          updated_by: 'cronzivo-panel',
        },
      },
      { returnDocument: 'after' },
    );
    if (!updated) throw jobNotFound();

    try {
      await this.reconcile();
    } catch {
      await CronSchedule.findOneAndUpdate(
        { job_id: job.id },
        {
          $set: {
            cron_expression: before.expression,
            timezone: before.timezone,
            version: before.version,
          },
        },
      );
      await this.safeAudit({
        jobId,
        command: 'SCHEDULE_UPDATE',
        outcome: 'FAILED',
        errorCode: 'SCHEDULER_APPLY_FAILED',
        before,
        context: audit,
      });
      throw new ManagementError(
        httpStatus.INTERNAL_SERVER_ERROR,
        'SCHEDULER_APPLY_FAILED',
        'Schedule was persisted but the scheduler apply failed',
      );
    }

    await this.safeAudit({
      jobId,
      command: 'SCHEDULE_UPDATE',
      outcome: 'SUCCESS',
      before,
      after: {
        expression: job.defaultExpression,
        timezone: job.defaultTimezone,
        version: row.version + 1,
      },
      context: audit,
    });

    return this.getJob(job.id);
  }

  // -------------------------------------------------------------------- bulk

  private resolveBulkIds(jobIds: unknown): string[] {
    if (jobIds === undefined || jobIds === null) {
      return JOB_REGISTRY.map((job) => job.id);
    }
    if (!Array.isArray(jobIds)) {
      throw validationError('job_ids must be an array of strings or null');
    }
    if (jobIds.length === 0) {
      throw validationError('job_ids must not be empty');
    }
    const ids: string[] = [];
    for (const value of jobIds) {
      if (typeof value !== 'string') {
        throw validationError('job_ids must contain only strings');
      }
      if (!ids.includes(value)) ids.push(value);
    }
    return ids;
  }

  private summarize(results: BulkItemResult[]): BulkResult {
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    for (const item of results) {
      if (item.ok) succeeded += 1;
      else if (item.code && skippedCodes.has(item.code)) skipped += 1;
      else failed += 1;
    }
    return {
      results,
      summary: { total: results.length, succeeded, failed, skipped },
    };
  }

  async bulkStart(input: {
    jobIds: unknown;
    audit: ManagementAuditContext;
  }): Promise<BulkResult> {
    const ids = this.resolveBulkIds(input.jobIds);
    const audit = { ...input.audit, bulkId: newExecutionId() };
    const results: BulkItemResult[] = [];
    for (const jobId of ids) {
      try {
        const result = await this.startJob(jobId, audit, 'BULK_START');
        results.push({
          job_id: jobId,
          ok: true,
          changed: result.changed,
        });
      } catch (error) {
        results.push(this.bulkFailure(jobId, error));
      }
    }
    return this.summarize(results);
  }

  async bulkStop(input: {
    jobIds: unknown;
    audit: ManagementAuditContext;
  }): Promise<BulkResult> {
    const ids = this.resolveBulkIds(input.jobIds);
    const audit = { ...input.audit, bulkId: newExecutionId() };
    const results: BulkItemResult[] = [];
    for (const jobId of ids) {
      try {
        const result = await this.stopJob(jobId, audit, 'BULK_STOP');
        results.push({
          job_id: jobId,
          ok: true,
          changed: result.changed,
        });
      } catch (error) {
        results.push(this.bulkFailure(jobId, error));
      }
    }
    return this.summarize(results);
  }

  async bulkRun(input: {
    jobIds: unknown;
    audit: ManagementAuditContext;
  }): Promise<BulkResult> {
    const ids = this.resolveBulkIds(input.jobIds);
    const audit = { ...input.audit, bulkId: newExecutionId() };
    const results: BulkItemResult[] = [];
    let accepted = 0;
    const limit = config.cronzivo.bulkRunConcurrency;

    for (const jobId of ids) {
      const job = findJob(jobId);
      if (!job) {
        await this.safeAudit({
          jobId,
          command: 'BULK_RUN',
          outcome: 'REJECTED',
          errorCode: 'JOB_NOT_FOUND',
          context: audit,
        });
        results.push({
          job_id: jobId,
          ok: false,
          code: 'JOB_NOT_FOUND',
          message: 'Unknown job id',
        });
        continue;
      }
      if (!job.capabilities.run) {
        await this.safeAudit({
          jobId,
          command: 'BULK_RUN',
          outcome: 'REJECTED',
          errorCode: 'JOB_NOT_RUNNABLE',
          context: audit,
        });
        results.push({
          job_id: jobId,
          ok: false,
          code: 'JOB_NOT_RUNNABLE',
          message: 'Job cannot be run on demand',
        });
        continue;
      }
      if (accepted >= limit) {
        await this.safeAudit({
          jobId,
          command: 'BULK_RUN',
          outcome: 'REJECTED',
          errorCode: 'JOB_ALREADY_RUNNING',
          context: audit,
        });
        results.push({
          job_id: jobId,
          ok: false,
          code: 'JOB_ALREADY_RUNNING',
          message: 'Bulk run concurrency limit reached',
        });
        continue;
      }
      try {
        const run = await this.runManual(jobId, audit, 'BULK_RUN');
        accepted += 1;
        results.push({
          job_id: jobId,
          ok: true,
          execution_id: run.execution_id,
          status: run.status,
        });
      } catch (error) {
        results.push(this.bulkFailure(jobId, error));
      }
    }
    return this.summarize(results);
  }

  private bulkFailure(jobId: string, error: unknown): BulkItemResult {
    if (error instanceof ManagementError) {
      return {
        job_id: jobId,
        ok: false,
        code: error.code,
        message: error.message,
      };
    }
    return {
      job_id: jobId,
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    };
  }

  // ------------------------------------------------------------------- views

  private nextRunFor(row: any): Date | null {
    if (!row?.enabled) return null;
    return nextRunDate(String(row.cron_expression), String(row.timezone));
  }

  private jobView(
    job: CronJobDefinition,
    row: any,
    lastExecution: any | null,
  ): JobView {
    return {
      id: job.id,
      name: job.name,
      description: job.description,
      schedule: {
        expression: String(row.cron_expression),
        timezone: String(row.timezone),
        source: row.source === 'custom' ? 'custom' : 'default',
        default_expression: job.defaultExpression,
        default_timezone: job.defaultTimezone,
        version: Number(row.version ?? 1),
        updated_at: toIso(row.updated_at),
        updated_by: row.updated_by ?? null,
      },
      scheduling: row.enabled ? 'ACTIVE' : 'STOPPED',
      execution: this.isRunning(job.id) ? 'RUNNING' : 'IDLE',
      next_run_at: toIso(this.nextRunFor(row)),
      last_execution: lastExecution
        ? serializeExecutionSummary(lastExecution)
        : null,
      runtime: 'nodejs',
      scheduler: 'cron-parser',
      capabilities: job.capabilities,
    };
  }

  async listJobs(): Promise<{ items: JobView[]; total: number }> {
    const ids = JOB_REGISTRY.map((job) => job.id);
    const rows = await CronSchedule.find({ job_id: { $in: ids } }).lean();
    const byId = new Map(rows.map((row: any) => [String(row.job_id), row]));
    const lastByJob = await lastExecutionByJob(ids);

    const items = JOB_REGISTRY.map((job) => {
      // Listing must stay read-only: when boot seeding has not run (e.g. an
      // API-only process without the worker), expose the registry defaults
      // instead of writing a schedule row or failing the whole request.
      const row: any = byId.get(job.id) ?? {
        enabled: true,
        cron_expression: job.defaultExpression,
        timezone: job.defaultTimezone,
        source: 'default',
        version: 1,
        updated_by: null,
      };
      return this.jobView(job, row, lastByJob.get(job.id) ?? null);
    });

    return { items, total: items.length };
  }

  async getJob(jobId: string): Promise<JobView> {
    const job = findJob(jobId);
    if (!job) throw jobNotFound();
    const row = await this.ensureSchedule(job);
    const lastByJob = await lastExecutionByJob([job.id]);
    return this.jobView(job, row, lastByJob.get(job.id) ?? null);
  }

  async getStatus(jobId: string) {
    const jobView = await this.getJob(jobId);
    return {
      id: jobView.id,
      scheduling: jobView.scheduling,
      execution: jobView.execution,
      next_run_at: jobView.next_run_at,
      last_execution: jobView.last_execution,
    };
  }

  // -------------------------------------------------------------- read models

  async executions(
    jobId: string,
    options: {
      limit: number;
      cursor?: string;
      status?: string;
      trigger?: string;
      from?: Date;
      to?: Date;
    },
  ): Promise<CollectionView<any>> {
    if (!findJob(jobId)) throw jobNotFound();
    const status = options.status;
    if (
      status &&
      !['RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED'].includes(status)
    ) {
      throw validationError('Invalid status filter');
    }
    if (options.trigger && !['SCHEDULED', 'MANUAL'].includes(options.trigger)) {
      throw validationError('Invalid trigger filter');
    }
    if (options.from && options.to && options.from > options.to) {
      throw validationError('from must be before to');
    }
    return listExecutions({
      jobId,
      limit: options.limit,
      cursor: options.cursor,
      status,
      trigger: options.trigger,
      from: options.from,
      to: options.to,
    });
  }

  async logs(
    jobId: string,
    options: {
      limit: number;
      cursor?: string;
      executionId?: string;
      level?: string;
    },
  ): Promise<CollectionView<any>> {
    if (!findJob(jobId)) throw jobNotFound();
    if (options.level && !['INFO', 'WARN', 'ERROR'].includes(options.level)) {
      throw validationError('Invalid level filter');
    }
    // Contract default: the latest execution's logs when no id is supplied.
    let executionId = options.executionId;
    if (!executionId) {
      const latest = await lastExecutionByJob([jobId]);
      executionId = latest.get(jobId)?.execution_id ?? undefined;
      if (!executionId) return { items: [], next_cursor: null };
    }
    return listLogs({
      jobId,
      limit: options.limit,
      cursor: options.cursor,
      executionId,
      level: options.level,
    });
  }

  async audit(
    jobId: string,
    options: { limit: number; cursor?: string; command?: string },
  ): Promise<CollectionView<any>> {
    if (!findJob(jobId)) throw jobNotFound();
    return listAudit({
      jobId,
      limit: options.limit,
      cursor: options.cursor,
      command: options.command,
    });
  }

  /** Environment-level audit feed (`GET /audit`), all jobs. */
  async globalAudit(options: {
    jobId?: string;
    limit: number;
    cursor?: string;
    command?: string;
    outcome?: string;
    from?: Date;
    to?: Date;
  }): Promise<CollectionView<any>> {
    if (
      options.outcome &&
      !['SUCCESS', 'FAILED', 'REJECTED'].includes(options.outcome)
    ) {
      throw validationError('Invalid outcome filter');
    }
    if (options.from && options.to && options.from > options.to) {
      throw validationError('from must be before to');
    }
    return listAudit(options);
  }

  // ------------------------------------------------------------------- health

  capabilities() {
    return {
      integration_version: '1.0.0',
      api_version: 'v1',
      runtime: 'nodejs',
      scheduler: 'cron-parser',
      capabilities: {
        discovery: true,
        start: true,
        stop: true,
        run: true,
        update_schedule: true,
        schedule_dry_run: true,
        schedule_reset: true,
        bulk: true,
        execution_history: true,
        logs: true,
        audit: true,
        cancel_running: false,
        cron_seconds: false,
        // Optional Part B endpoints are intentionally not implemented here;
        // advertising false keeps the panel from probing them (and logging
        // 404s) and makes it use the per-job fallback instead.
        executions_overview: false,
        stats: false,
      },
    };
  }

  private async setSchedulerHeartbeat(value: string): Promise<void> {
    if (!isRedisConfigured()) return;
    try {
      await getRedis().set(
        SCHEDULER_HEARTBEAT_KEY,
        value,
        'EX',
        SCHEDULER_HEARTBEAT_TTL_SEC,
      );
    } catch (error) {
      logger.error(
        `[CRONZIVO] scheduler heartbeat failed: ${sanitizeText(error, 200)}`,
      );
    }
  }

  private async writeSchedulerHeartbeat(): Promise<void> {
    await this.setSchedulerHeartbeat(String(Date.now()));
  }

  async schedulerStatus(): Promise<'running' | 'stopped' | 'error'> {
    if (this.started) return 'running';
    if (!isRedisConfigured()) return 'stopped';
    try {
      const raw = await getRedis().get(SCHEDULER_HEARTBEAT_KEY);
      if (!raw) return 'stopped';
      if (raw === 'stopped') return 'stopped';
      const ts = Number(raw);
      if (!Number.isFinite(ts)) return 'stopped';
      return Date.now() - ts < SCHEDULER_HEARTBEAT_TTL_SEC * 1000
        ? 'running'
        : 'stopped';
    } catch {
      return 'error';
    }
  }

  async health() {
    const scheduler = await this.schedulerStatus();
    return {
      status: scheduler === 'running' ? 'ok' : 'degraded',
      scheduler,
      jobs_total: JOB_REGISTRY.length,
      time: new Date().toISOString(),
      key_slots: {
        secondary_configured: Boolean(config.cronzivo.apiKeySecondary),
      },
      integration_version: '1.0.0',
      api_version: 'v1',
      runtime: 'nodejs',
      scheduler_library: 'cron-parser',
    };
  }
}

export const cronManager = new CronManager();
