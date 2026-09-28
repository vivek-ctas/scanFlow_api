import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';
import { USAGE_RETENTION_DAYS } from '../utils/subscription-expiry.util.js';

export interface IUsage extends Document {
  organizationId: mongoose.Types.ObjectId;
  subscriptionId: mongoose.Types.ObjectId;
  used: number;
  limit: number;
  startTime: Date;
  endTime: Date;
  lastUsedAt?: Date;
  isExhausted: boolean;
  purgeAfter: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface IUsageModel extends Model<IUsage> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const usageSchema = new Schema<IUsage, IUsageModel>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_subscription',
      required: true,
    },
    used: { type: Number, default: 0, min: 0 },
    limit: { type: Number, required: true, min: 0 },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    lastUsedAt: { type: Date },
    isExhausted: { type: Boolean, default: false },
    purgeAfter: {
      type: Date,
      default: () => new Date(Date.now() + USAGE_RETENTION_DAYS * 86400000),
    },
  },
  { timestamps: true },
);

usageSchema.index({ organizationId: 1, subscriptionId: 1 });
usageSchema.index({ subscriptionId: 1 });
usageSchema.index({ purgeAfter: 1 }, { expireAfterSeconds: 0 });

usageSchema.plugin(toJSON);
usageSchema.plugin(paginate);

export const Usage = mongoose.model<IUsage, IUsageModel>(
  'tbl_usage',
  usageSchema,
);
