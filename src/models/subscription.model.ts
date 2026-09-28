import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export type SubscriptionStatus = 'active' | 'future' | 'expired' | 'cancelled';

export interface ISubscription extends Document {
  organizationId: mongoose.Types.ObjectId;
  planId: mongoose.Types.ObjectId;
  scanLimit: number;
  billingCycle: 'monthly' | 'yearly';
  status: SubscriptionStatus;
  startedAt: Date;
  expiresAt: Date;
  usageResetAnchor: Date;
  queuePriority?: number;
  planValidityDays?: number;
  cancellationReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ISubscriptionModel extends Model<ISubscription> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const subscriptionSchema = new Schema<ISubscription, ISubscriptionModel>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    planId: { type: Schema.Types.ObjectId, ref: 'tbl_plan', required: true },
    scanLimit: { type: Number, required: true, min: 0 },
    billingCycle: {
      type: String,
      enum: ['monthly', 'yearly'],
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'future', 'expired', 'cancelled'],
      required: true,
      default: 'future',
    },
    startedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    usageResetAnchor: { type: Date, default: Date.now },
    queuePriority: { type: Number },
    planValidityDays: { type: Number },
    cancellationReason: { type: String },
  },
  { timestamps: true },
);

subscriptionSchema.index({ organizationId: 1, status: 1 });
subscriptionSchema.index({ organizationId: 1, queuePriority: 1 });
subscriptionSchema.index({ status: 1, expiresAt: 1 });

subscriptionSchema.plugin(toJSON);
subscriptionSchema.plugin(paginate);

export const Subscription = mongoose.model<ISubscription, ISubscriptionModel>(
  'tbl_subscription',
  subscriptionSchema,
);
