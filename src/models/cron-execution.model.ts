import mongoose, { Document, Schema } from 'mongoose';
import config from '../config/config.js';
import { toJSON } from './plugins/toJSON.plugin.js';

export type CronExecutionTrigger = 'SCHEDULED' | 'MANUAL';
export type CronExecutionTriggeredBy = 'system' | 'cronzivo-panel';
export type CronExecutionStatus = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';

export interface ICronExecution extends Document {
  execution_id: string;
  job_id: string;
  trigger: CronExecutionTrigger;
  triggered_by: CronExecutionTriggeredBy;
  status: CronExecutionStatus;
  started_at: Date;
  finished_at?: Date | null;
  duration_ms?: number | null;
  /** Sanitized failure message; never a stack trace. */
  error_message?: string | null;
  summary?: string | null;
  created_at: Date;
  updated_at: Date;
}

const cronExecutionSchema = new Schema<ICronExecution>(
  {
    execution_id: { type: String, required: true, unique: true, trim: true },
    job_id: { type: String, required: true, trim: true },
    trigger: {
      type: String,
      enum: ['SCHEDULED', 'MANUAL'],
      required: true,
    },
    triggered_by: {
      type: String,
      enum: ['system', 'cronzivo-panel'],
      required: true,
    },
    status: {
      type: String,
      enum: ['RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED'],
      required: true,
      default: 'RUNNING',
    },
    started_at: { type: Date, required: true },
    finished_at: { type: Date, default: null },
    duration_ms: { type: Number, default: null },
    error_message: { type: String, default: null, trim: true, maxlength: 500 },
    summary: { type: String, default: null, trim: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

cronExecutionSchema.index({ job_id: 1, started_at: -1 });
cronExecutionSchema.index({ status: 1, started_at: -1 });

if (config.cronzivo.executionRetentionDays > 0) {
  cronExecutionSchema.index(
    { started_at: 1 },
    {
      expireAfterSeconds: config.cronzivo.executionRetentionDays * 86400,
      name: 'cron_execution_ttl',
    },
  );
}

cronExecutionSchema.plugin(toJSON);

export const CronExecution = mongoose.model<ICronExecution>(
  'CronExecution',
  cronExecutionSchema,
  'cron_executions',
);
