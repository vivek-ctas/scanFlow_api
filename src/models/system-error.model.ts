import mongoose, { Document, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';

export interface ISystemError extends Document {
  action_type?: string;
  error_data?: string;
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
  },
  {
    timestamps: true,
  },
);

systemErrorSchema.plugin(toJSON);

export const SystemError = mongoose.model<ISystemError>(
  'tbl_systemError',
  systemErrorSchema,
);
