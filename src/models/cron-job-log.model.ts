import mongoose, { Document, Schema } from 'mongoose';
import config from '../config/config.js';
import { toJSON } from './plugins/toJSON.plugin.js';

export type CronLogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface ICronJobLog extends Document {
  job_id: string;
  execution_id?: string | null;
  seq: number;
  level: CronLogLevel;
  message: string;
  data?: Record<string, unknown> | null;
  ts: Date;
  created_at: Date;
  updated_at: Date;
}

const cronJobLogSchema = new Schema<ICronJobLog>(
  {
    job_id: { type: String, required: true, trim: true },
    execution_id: { type: String, default: null, trim: true },
    seq: { type: Number, default: 0, min: 0 },
    level: {
      type: String,
      enum: ['INFO', 'WARN', 'ERROR'],
      required: true,
      default: 'INFO',
    },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    data: { type: Schema.Types.Mixed, default: null },
    ts: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

cronJobLogSchema.index({ job_id: 1, ts: -1 });
cronJobLogSchema.index({ execution_id: 1, seq: 1 });
cronJobLogSchema.index({ execution_id: 1, ts: -1 });

if (config.cronzivo.logRetentionDays > 0) {
  cronJobLogSchema.index(
    { ts: 1 },
    {
      expireAfterSeconds: config.cronzivo.logRetentionDays * 86400,
      name: 'cron_job_log_ttl',
    },
  );
}

cronJobLogSchema.plugin(toJSON);

export const CronJobLog = mongoose.model<ICronJobLog>(
  'CronJobLog',
  cronJobLogSchema,
  'cron_job_logs',
);
