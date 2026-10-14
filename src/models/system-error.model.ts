import mongoose, { Document, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';

export interface ISystemError extends Document {
  action_type?: string;
  error_data?: string;
  method?: string;
  route?: string;
  status_code?: number;
  createdAt: Date;
  updatedAt: Date;
}

const systemErrorSchema = new Schema<ISystemError>(
  {
    action_type: {
      type: String,
      trim: true,
    },
    error_data: {
      type: String,
    },
    method: {
      type: String,
      trim: true,
    },
    route: {
      type: String,
      trim: true,
    },
    status_code: {
      type: Number,
    },
  },
  {
    timestamps: true,
  },
);

systemErrorSchema.index({ createdAt: 1 });
systemErrorSchema.index({ status_code: 1, createdAt: -1 });

systemErrorSchema.plugin(toJSON);

export const SystemError = mongoose.model<ISystemError>(
  'tbl_systemError',
  systemErrorSchema,
);
