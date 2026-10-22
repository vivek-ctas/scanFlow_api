import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export type SupportSenderRole = 'SUPER_ADMIN' | 'ORGANIZATION_ADMIN' | 'system';

export type SupportMessageKind = 'reply' | 'note' | 'event';

export type SupportEventType =
  'status_changed' | 'priority_changed' | 'assigned' | 'reopened' | 'closed';

export interface ISupportEvent {
  type: SupportEventType;
  from?: string | null;
  to?: string | null;
}

export interface ISupportAttachment {
  storage_key: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
}

export interface ISupportMessage extends Document {
  ticket_id: mongoose.Types.ObjectId;
  organization_id: mongoose.Types.ObjectId;
  sender_id?: mongoose.Types.ObjectId | null;
  sender_role: SupportSenderRole;
  kind: SupportMessageKind;
  is_internal: boolean;
  body: string;
  event?: ISupportEvent | null;
  attachments: ISupportAttachment[];
  client_message_id?: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ISupportMessageModel extends Model<ISupportMessage> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const supportEventSchema = new Schema<ISupportEvent>(
  {
    type: {
      type: String,
      enum: [
        'status_changed',
        'priority_changed',
        'assigned',
        'reopened',
        'closed',
      ],
      required: true,
    },
    from: { type: String, default: null },
    to: { type: String, default: null },
  },
  { _id: false },
);

const supportAttachmentSchema = new Schema<ISupportAttachment>(
  {
    storage_key: { type: String, required: true, trim: true },
    file_name: { type: String, required: true, trim: true },
    content_type: { type: String, required: true, trim: true },
    size_bytes: { type: Number, required: true },
  },
  { _id: false },
);

const supportMessageSchema = new Schema<ISupportMessage, ISupportMessageModel>(
  {
    ticket_id: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_support_ticket',
      required: true,
      index: true,
    },
    organization_id: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_organization',
      required: true,
      index: true,
    },
    sender_id: { type: Schema.Types.ObjectId, ref: 'tbl_user', default: null },
    sender_role: {
      type: String,
      enum: ['SUPER_ADMIN', 'ORGANIZATION_ADMIN', 'system'],
      required: true,
    },
    kind: {
      type: String,
      enum: ['reply', 'note', 'event'],
      default: 'reply',
    },
    is_internal: { type: Boolean, default: false },
    body: { type: String, trim: true, default: '', maxlength: 5000 },
    event: { type: supportEventSchema, default: null },
    attachments: { type: [supportAttachmentSchema], default: [] },
    client_message_id: { type: String, trim: true, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

supportMessageSchema.index({ ticket_id: 1, created_at: 1 });
supportMessageSchema.index(
  { ticket_id: 1, client_message_id: 1 },
  {
    unique: true,
    partialFilterExpression: { client_message_id: { $type: 'string' } },
  },
);

supportMessageSchema.plugin(toJSON);
supportMessageSchema.plugin(paginate);

export const SupportMessage = mongoose.model<
  ISupportMessage,
  ISupportMessageModel
>('tbl_support_message', supportMessageSchema);
