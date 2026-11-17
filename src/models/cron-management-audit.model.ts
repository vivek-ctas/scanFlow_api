import mongoose, { Document, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';

export type CronAuditOutcome = 'SUCCESS' | 'FAILED';

export interface ICronManagementAudit extends Document {
  job_id: string;
  command: string;
  actor: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  request_id: string;
  ip?: string | null;
  outcome: CronAuditOutcome;
  ts: Date;
  created_at: Date;
  updated_at: Date;
}

const cronManagementAuditSchema = new Schema<ICronManagementAudit>(
  {
    job_id: { type: String, required: true, trim: true },
    command: { type: String, required: true, trim: true },
    actor: {
      type: String,
      required: true,
      trim: true,
      default: 'cronzivo-panel',
    },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    request_id: { type: String, required: true, trim: true },
    ip: { type: String, default: null, trim: true },
    outcome: { type: String, enum: ['SUCCESS', 'FAILED'], required: true },
    ts: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

cronManagementAuditSchema.index({ job_id: 1, ts: -1 });
cronManagementAuditSchema.index({ ts: -1 });
cronManagementAuditSchema.index({ command: 1, ts: -1 });

cronManagementAuditSchema.plugin(toJSON);

export const CronManagementAudit = mongoose.model<ICronManagementAudit>(
  'CronManagementAudit',
  cronManagementAuditSchema,
  'cron_management_audit',
);
