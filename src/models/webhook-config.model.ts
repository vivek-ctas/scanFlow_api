import mongoose, { Document, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';

export interface IWebhookConfig extends Document {
  organization_id: mongoose.Types.ObjectId;
  endpoint_url: string;
  secret?: string;
  enabled: boolean;
  timeout_ms: number;
  batch_size: number;
  retry_limit: number;
  created_at: Date;
  updated_at: Date;
}

const webhookConfigSchema = new Schema<IWebhookConfig>(
  {
    organization_id: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      unique: true,
    },
    endpoint_url: { type: String, required: true, trim: true },
    secret: {
      type: String,
      trim: true,
      private: true,
      select: false,
    },
    enabled: { type: Boolean, default: true },
    timeout_ms: { type: Number, default: 5000 },
    batch_size: { type: Number, default: 100 },
    retry_limit: { type: Number, default: 3 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

webhookConfigSchema.plugin(toJSON);

export const WebhookConfig = mongoose.model<IWebhookConfig>(
  'tbl_webhookConfig',
  webhookConfigSchema,
);
