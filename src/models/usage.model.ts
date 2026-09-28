import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';
import { USAGE_RETENTION_DAYS } from '../utils/subscription-expiry.util.js';

export interface IUsage extends Document {
  feature_name: string;
  organization_id: mongoose.Types.ObjectId;
  subscription_id: mongoose.Types.ObjectId;
  scan_limit: number;
  usage: number;
  started_at: Date;
  expires_at: Date;
  last_used_at?: Date;
  is_exhausted: boolean;
  purge_after: Date;
  created_at: Date;
  updated_at: Date;
}

interface IUsageModel extends Model<IUsage> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const usageSchema = new Schema<IUsage, IUsageModel>(
  {
    feature_name: { type: String, default: 'scan', trim: true },
    organization_id: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_organization',
      required: true,
      index: true,
    },
    subscription_id: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_subscription',
      required: true,
    },
    scan_limit: { type: Number, required: true, min: 0 },
    usage: { type: Number, default: 0, min: 0 },
    started_at: { type: Date, required: true },
    expires_at: { type: Date, required: true },
    last_used_at: { type: Date },
    is_exhausted: { type: Boolean, default: false },
    purge_after: {
      type: Date,
      default: () => new Date(Date.now() + USAGE_RETENTION_DAYS * 86400000),
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

usageSchema.index({ organization_id: 1, subscription_id: 1 });
usageSchema.index({ subscription_id: 1 });
usageSchema.index({ purge_after: 1 }, { expireAfterSeconds: 0 });

usageSchema.plugin(toJSON);
usageSchema.plugin(paginate);

export const Usage = mongoose.model<IUsage, IUsageModel>(
  'tbl_usage',
  usageSchema,
);
