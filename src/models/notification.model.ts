import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';

export type NotificationType =
  'support_ticket' | 'quota_alert' | 'subscription' | 'system';
export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface INotification extends Document {
  user_id: mongoose.Types.ObjectId;
  organization_id?: mongoose.Types.ObjectId;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  action_url?: string | null;
  is_read: boolean;
  dedupe_key?: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface INotificationModel extends Model<INotification> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const notificationSchema = new Schema<INotification, INotificationModel>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'tbl_user', required: true },
    organization_id: { type: Schema.Types.ObjectId, ref: 'tbl_organization' },
    type: {
      type: String,
      enum: ['support_ticket', 'quota_alert', 'subscription', 'system'],
      required: true,
    },
    severity: {
      type: String,
      enum: ['info', 'warning', 'critical'],
      default: 'info',
    },
    title: { type: String, trim: true, maxlength: 100 },
    message: { type: String, trim: true, maxlength: 500 },
    action_url: { type: String },
    is_read: { type: Boolean, default: false },
    dedupe_key: { type: String },
    expires_at: { type: Date, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

notificationSchema.index({ user_id: 1, is_read: 1, created_at: -1 });
notificationSchema.index({ user_id: 1, created_at: -1 });
notificationSchema.index(
  { user_id: 1, dedupe_key: 1 },
  { unique: true, sparse: true },
);
notificationSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

notificationSchema.plugin(toJSON);

export const Notification = mongoose.model<INotification, INotificationModel>(
  'tbl_notification',
  notificationSchema,
);
