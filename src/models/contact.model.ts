import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export type ContactInquiryType =
  'sales' | 'demo' | 'support' | 'sdk' | 'partnership' | 'general';

export type ContactStatus = 0 | 1 | 2;

export interface IContactReply {
  message: string;
  sent_by: string;
  sent_at: Date;
}

export interface IContact extends Document {
  name: string;
  email: string;
  company?: string;
  phone?: string;
  inquiry_type: ContactInquiryType;
  message: string;
  status: ContactStatus;
  replies: IContactReply[];
  created_at: Date;
  updated_at: Date;
}

interface IContactModel extends Model<IContact> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const contactReplySchema = new Schema<IContactReply>(
  {
    message: { type: String, required: true, trim: true },
    sent_by: { type: String, required: true, trim: true },
    sent_at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const contactSchema = new Schema<IContact, IContactModel>(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    company: { type: String, trim: true },
    phone: { type: String, trim: true },
    inquiry_type: {
      type: String,
      enum: ['sales', 'demo', 'support', 'sdk', 'partnership', 'general'],
      default: 'general',
    },
    message: { type: String, required: true, trim: true },
    status: { type: Number, enum: [0, 1, 2], default: 0 },
    replies: { type: [contactReplySchema], default: [] },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

contactSchema.index({ status: 1, created_at: 1 });

contactSchema.plugin(toJSON);
contactSchema.plugin(paginate);

export const Contact = mongoose.model<IContact, IContactModel>(
  'tbl_contact',
  contactSchema,
);
