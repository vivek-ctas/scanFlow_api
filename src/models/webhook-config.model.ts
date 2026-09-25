import mongoose, { Document, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';

export interface IWebhookConfig extends Document {
  organizationId: mongoose.Types.ObjectId;
  endpointUrl: string;
  secret?: string;
  enabled: boolean;
  timeoutMs: number;
  batchSize: number;
  retryLimit: number;
  createdAt: Date;
  updatedAt: Date;
}

const webhookConfigSchema = new Schema<IWebhookConfig>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      unique: true,
    },
    endpointUrl: { type: String, required: true, trim: true },
    secret: {
      type: String,
      trim: true,
      private: true,
      select: false,
    },
    enabled: { type: Boolean, default: true },
    timeoutMs: { type: Number, default: 5000 },
    batchSize: { type: Number, default: 100 },
    retryLimit: { type: Number, default: 3 },
  },
  { timestamps: true },
);

webhookConfigSchema.plugin(toJSON);

export const WebhookConfig = mongoose.model<IWebhookConfig>(
  'tbl_webhookConfig',
  webhookConfigSchema,
);
