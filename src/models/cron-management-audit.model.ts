import mongoose, { Document, Schema } from 'mongoose';
import config from '../config/config.js';
import { toJSON } from './plugins/toJSON.plugin.js';

export type CronAuditOutcome = 'SUCCESS' | 'FAILED' | 'REJECTED';

export interface CronAuditActor {
  source: string;
  token_jti?: string | null;
  ip?: string | null;
  user_agent?: string | null;
}

export interface ICronManagementAudit extends Document {
  job_id: string;
  command: string;
  actor: CronAuditActor;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  bulk_id?: string | null;
  request_id: string;
  outcome: CronAuditOutcome;
  error_code?: string | null;
  ts: Date;
  created_at: Date;
  updated_at: Date;
}

const cronManagementAuditSchema = new Schema<ICronManagementAudit>(
  {
    job_id: { type: String, required: true, trim: true },
    command: { type: String, required: true, trim: true },
    actor: {
      type: new Schema(
        {
          source: {
            type: String,
            required: true,
            trim: true,
            default: 'cronzivo-panel',
          },
          token_jti: { type: String, default: null, trim: true },
          ip: { type: String, default: null, trim: true },
          user_agent: { type: String, default: null, trim: true },
        },
        { _id: false },
      ),
      required: true,
    },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    bulk_id: { type: String, default: null, trim: true },
    request_id: { type: String, required: true, trim: true },
    outcome: {
      type: String,
      enum: ['SUCCESS', 'FAILED', 'REJECTED'],
      required: true,
    },
    error_code: { type: String, default: null, trim: true },
    ts: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

cronManagementAuditSchema.index({ job_id: 1, ts: -1 });
cronManagementAuditSchema.index({ ts: -1 });
cronManagementAuditSchema.index({ command: 1, ts: -1 });
cronManagementAuditSchema.index({ outcome: 1, ts: -1 });
cronManagementAuditSchema.index({ bulk_id: 1, ts: -1 });

if (config.cronzivo.auditRetentionDays > 0) {
  cronManagementAuditSchema.index(
    { ts: 1 },
    {
      expireAfterSeconds: config.cronzivo.auditRetentionDays * 86400,
      name: 'cron_management_audit_ttl',
    },
  );
}

cronManagementAuditSchema.plugin(toJSON);

export const CronManagementAudit = mongoose.model<ICronManagementAudit>(
  'CronManagementAudit',
  cronManagementAuditSchema,
  'cron_management_audit',
);
