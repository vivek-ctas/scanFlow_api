import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export type SupportCategory =
  | 'scanner'
  | 'account_login'
  | 'subscription_quota'
  | 'webhook'
  | 'bug'
  | 'other';

export type SupportPriority = 'low' | 'normal' | 'high' | 'critical';

export type SupportStatus =
  'open' | 'in_progress' | 'waiting_for_customer' | 'resolved' | 'closed';

export const SUPPORT_CATEGORIES: SupportCategory[] = [
  'scanner',
  'account_login',
  'subscription_quota',
  'webhook',
  'bug',
  'other',
];

export const SUPPORT_PRIORITIES: SupportPriority[] = [
  'low',
  'normal',
  'high',
  'critical',
];

export const SUPPORT_STATUSES: SupportStatus[] = [
  'open',
  'in_progress',
  'waiting_for_customer',
  'resolved',
  'closed',
];

/** Statuses that count as "active" for summaries and the per-org cap. */
export const ACTIVE_SUPPORT_STATUSES: SupportStatus[] = [
  'open',
  'in_progress',
  'waiting_for_customer',
];

export interface ISupportLastPublicMessage {
  preview: string;
  by_role: string;
  at: Date;
}

export interface ISupportTicket extends Document {
  ticket_no: string;
  organization_id: mongoose.Types.ObjectId;
  created_by?: mongoose.Types.ObjectId | null;
  subject: string;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportStatus;
  assigned_to?: mongoose.Types.ObjectId | null;
  last_message_at?: Date | null;
  last_customer_message_at?: Date | null;
  last_staff_message_at?: Date | null;
  first_response_at?: Date | null;
  resolved_at?: Date | null;
  closed_at?: Date | null;
  last_public_message?: ISupportLastPublicMessage | null;
  related_faq_id?: mongoose.Types.ObjectId | null;
  smart_context?: Record<string, any> | null;
  client_info?: Record<string, any> | null;
  /** Per-user last read timestamp (Map: userId -> Date). */
  last_read_at?: Map<string, Date>;
  /** Role-level read cursors */
  customer_read_at?: Date | null;
  staff_read_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ISupportTicketModel extends Model<ISupportTicket> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const supportLastPublicMessageSchema = new Schema<ISupportLastPublicMessage>(
  {
    preview: { type: String, trim: true, default: '', maxlength: 80 },
    by_role: { type: String, trim: true, default: '' },
    at: { type: Date, default: null },
  },
  { _id: false },
);

const supportTicketSchema = new Schema<ISupportTicket, ISupportTicketModel>(
  {
    ticket_no: { type: String, required: true, unique: true, trim: true },
    organization_id: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_organization',
      required: true,
      index: true,
    },
    created_by: { type: Schema.Types.ObjectId, ref: 'tbl_user', default: null },
    subject: { type: String, required: true, trim: true, maxlength: 120 },
    category: {
      type: String,
      enum: SUPPORT_CATEGORIES,
      default: 'other',
    },
    priority: {
      type: String,
      enum: SUPPORT_PRIORITIES,
      default: 'normal',
    },
    status: {
      type: String,
      enum: SUPPORT_STATUSES,
      default: 'open',
      index: true,
    },
    assigned_to: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_user',
      default: null,
    },
    last_message_at: { type: Date, default: null },
    last_customer_message_at: { type: Date, default: null },
    last_staff_message_at: { type: Date, default: null },
    first_response_at: { type: Date, default: null },
    resolved_at: { type: Date, default: null },
    closed_at: { type: Date, default: null },
    last_public_message: {
      type: supportLastPublicMessageSchema,
      default: null,
    },
    related_faq_id: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_faq',
      default: null,
    },
    // Staff-only snapshot, never serialised by accident (select:false + private).
    smart_context: {
      type: Schema.Types.Mixed,
      default: null,
      select: false,
      private: true,
    },
    client_info: {
      type: Schema.Types.Mixed,
      default: null,
      select: false,
      private: true,
    },
    /** Per-user last read timestamp (Map: userId -> Date). */
    last_read_at: {
      type: Map,
      of: Date,
      default: {},
    },
    customer_read_at: { type: Date, default: null },
    staff_read_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

supportTicketSchema.index({ organization_id: 1, status: 1, updated_at: -1 });
supportTicketSchema.index({ status: 1, updated_at: -1 });
supportTicketSchema.index({ assigned_to: 1, status: 1 });

supportTicketSchema.plugin(toJSON);
supportTicketSchema.plugin(paginate);

export const SupportTicket = mongoose.model<
  ISupportTicket,
  ISupportTicketModel
>('tbl_support_ticket', supportTicketSchema);
