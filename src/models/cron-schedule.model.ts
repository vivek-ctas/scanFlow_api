import mongoose, { Document, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';

export type CronScheduleSource = 'default' | 'custom';

export interface ICronSchedule extends Document {
  job_id: string;
  enabled: boolean;
  cron_expression: string;
  timezone: string;
  source: CronScheduleSource;
  version: number;
  updated_by?: string | null;
  /** Cross-process execution lease; never exposed through the API. */
  lock_execution_id?: string | null;
  lock_expires_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}

const cronScheduleSchema = new Schema<ICronSchedule>(
  {
    job_id: { type: String, required: true, unique: true, trim: true },
    enabled: { type: Boolean, default: true },
    cron_expression: { type: String, required: true, trim: true },
    timezone: { type: String, required: true, trim: true },
    source: {
      type: String,
      enum: ['default', 'custom'],
      default: 'default',
    },
    version: { type: Number, default: 1, min: 1 },
    updated_by: { type: String, default: null, trim: true },
    lock_execution_id: { type: String, default: null },
    lock_expires_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

cronScheduleSchema.index({ enabled: 1 });
cronScheduleSchema.index({ lock_expires_at: 1 });

cronScheduleSchema.plugin(toJSON);

export const CronSchedule = mongoose.model<ICronSchedule>(
  'CronSchedule',
  cronScheduleSchema,
  'tbl_cron_schedules',
);
