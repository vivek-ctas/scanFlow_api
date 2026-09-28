import mongoose, { Document, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export interface IWebhookDelivery extends Document {
  event_id: string;
  scan_id: mongoose.Types.ObjectId;
  organization_id: mongoose.Types.ObjectId;
  retry_count: number;
  last_attempt_at?: Date;
  delivered_at?: Date;
  last_error?: string;
  status: 'pending' | 'processing' | 'delivered' | 'failed';
  created_at: Date;
  updated_at: Date;
  paginate: (filter: object, options: object) => Promise<any>;
}

const webhookDeliverySchema = new Schema<IWebhookDelivery>(
  {
    event_id: { type: String, required: true, index: true },
    scan_id: { type: Schema.Types.ObjectId, ref: 'tbl_scan', required: true },
    organization_id: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    retry_count: { type: Number, default: 0 },
    last_attempt_at: { type: Date },
    delivered_at: { type: Date },
    last_error: { type: String },
    status: {
      type: String,
      enum: ['pending', 'processing', 'delivered', 'failed'],
      default: 'pending',
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

webhookDeliverySchema.index({ status: 1, created_at: 1 });

webhookDeliverySchema.plugin(toJSON);
webhookDeliverySchema.plugin(paginate);

export const WebhookDelivery = mongoose.model<IWebhookDelivery>(
  'tbl_webhookDelivery',
  webhookDeliverySchema,
);
