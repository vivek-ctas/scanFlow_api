import mongoose, { Document, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';

export type SystemLogOperation =
  'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT' | 'CRON';

export const SYSTEM_LOG_OPERATIONS: SystemLogOperation[] = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'LOGIN',
  'LOGOUT',
  'CRON',
];

export interface ISystemLog extends Document {
  operation: SystemLogOperation;
  operation_by?: mongoose.Types.ObjectId | null;
  actor_role?: string | null;
  organization_id?: mongoose.Types.ObjectId | null;
  key: string;
  operation_data?: unknown[];
  ip_address?: string | null;
  created_at: Date;
  updated_at: Date;
}

const systemLogSchema = new Schema<ISystemLog>(
  {
    operation: {
      type: String,
      enum: SYSTEM_LOG_OPERATIONS,
      required: true,
    },
    operation_by: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_user',
      default: null,
    },
    actor_role: {
      type: String,
      trim: true,
      default: null,
    },
    organization_id: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_organization',
      default: null,
    },
    key: {
      type: String,
      trim: true,
      required: true,
    },
    operation_data: {
      type: [Schema.Types.Mixed],
      default: [],
    },
    ip_address: {
      type: String,
      trim: true,
      default: null,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  },
);

systemLogSchema.index({ created_at: -1 });
systemLogSchema.index({ key: 1, created_at: -1 });
systemLogSchema.index({ operation: 1, created_at: -1 });
systemLogSchema.index({ operation_by: 1, created_at: -1 });
systemLogSchema.index({ organization_id: 1, created_at: -1 });

systemLogSchema.plugin(toJSON);

export const SystemLog = mongoose.model<ISystemLog>(
  'tbl_system_log',
  systemLogSchema,
  'tbl_system_logs',
);
