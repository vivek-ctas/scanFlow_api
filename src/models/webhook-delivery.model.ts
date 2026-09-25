import mongoose, { Document, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export interface IWebhookDelivery extends Document {
  eventId: string;
  scanId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  attempts: number;
  lastAttemptAt?: Date;
  deliveredAt?: Date;
  lastError?: string;
  status: 'pending' | 'processing' | 'delivered' | 'failed';
  createdAt: Date;
  updatedAt: Date;
  paginate: (filter: object, options: object) => Promise<any>;
}

const webhookDeliverySchema = new Schema<IWebhookDelivery>(
  {
    eventId: { type: String, required: true, index: true },
    scanId: { type: Schema.Types.ObjectId, ref: 'tbl_scan', required: true },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date },
    deliveredAt: { type: Date },
    lastError: { type: String },
    status: {
      type: String,
      enum: ['pending', 'processing', 'delivered', 'failed'],
      default: 'pending',
    },
  },
  { timestamps: true },
);

webhookDeliverySchema.index({ status: 1, createdAt: 1 });

webhookDeliverySchema.plugin(toJSON);
webhookDeliverySchema.plugin(paginate);

export const WebhookDelivery = mongoose.model<IWebhookDelivery>(
  'tbl_webhookDelivery',
  webhookDeliverySchema,
);
