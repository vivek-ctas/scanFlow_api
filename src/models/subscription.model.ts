import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export type SubscriptionStatus = 'active' | 'future' | 'expired' | 'cancelled';

export interface ISubscriptionFeature {
  features_name: string;
  scan_limit: number;
}

export interface ISubscription extends Document {
  organization_id: mongoose.Types.ObjectId;
  plan_id: mongoose.Types.ObjectId;
  payment_id: mongoose.Types.ObjectId;
  features: ISubscriptionFeature[];
  billing_cycle: 'month' | 'quarterly';
  status: SubscriptionStatus;
  started_at: Date;
  expires_at: Date;
  queue_priority?: number;
  reminders_sent: number[];
  marketing_features: string[];
  trial_days: number;
  currency_code: string;
  plan_price: number;
  plan_name: string;
  is_plan_cancel: boolean;
  cancellation_reason?: string;
  created_at: Date;
  updated_at: Date;
}

interface ISubscriptionModel extends Model<ISubscription> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const subscriptionSchema = new Schema<ISubscription, ISubscriptionModel>(
  {
    organization_id: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    plan_id: { type: Schema.Types.ObjectId, ref: 'tbl_plan', required: true },
    payment_id: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_payment',
      required: true,
    },
    features: {
      type: [
        {
          _id: false,
          features_name: { type: String, required: true, trim: true },
          scan_limit: { type: Number, default: 0, min: 0 },
        },
      ],
      default: [],
    },
    billing_cycle: {
      type: String,
      enum: ['month', 'quarterly'],
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'future', 'expired', 'cancelled'],
      required: true,
      default: 'future',
    },
    started_at: { type: Date, required: true },
    expires_at: { type: Date, required: true },
    queue_priority: { type: Number },
    reminders_sent: { type: [Number], default: [] },
    marketing_features: { type: [String], default: [] },
    trial_days: { type: Number, default: 0, min: 0 },
    currency_code: {
      type: String,
      default: 'inr',
      trim: true,
      lowercase: true,
    },
    plan_price: { type: Number, default: 0, min: 0 },
    plan_name: { type: String, trim: true },
    is_plan_cancel: { type: Boolean, default: false },
    cancellation_reason: { type: String },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

subscriptionSchema.index({ organization_id: 1, status: 1 });
subscriptionSchema.index({ organization_id: 1, queue_priority: 1 });
subscriptionSchema.index({ status: 1, expires_at: 1 });

subscriptionSchema.plugin(toJSON);
subscriptionSchema.plugin(paginate);

export const Subscription = mongoose.model<ISubscription, ISubscriptionModel>(
  'tbl_subscription',
  subscriptionSchema,
);
