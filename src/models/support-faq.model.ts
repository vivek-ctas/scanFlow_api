import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export type FaqCategory =
  | 'scanner'
  | 'account_login'
  | 'subscription_quota'
  | 'webhook'
  | 'bug'
  | 'other';

export type FaqAudience = 'all' | 'organization_admin' | 'operator';

export const FAQ_CATEGORIES: FaqCategory[] = [
  'scanner',
  'account_login',
  'subscription_quota',
  'webhook',
  'bug',
  'other',
];

export const FAQ_AUDIENCES: FaqAudience[] = [
  'all',
  'organization_admin',
  'operator',
];

export interface IFaq extends Document {
  question: string;
  answer: string;
  category: FaqCategory;
  audience: FaqAudience;
  keywords: string[];
  status: number; // 0 unpublished · 1 published · 2 deleted
  sort_order: number;
  created_by?: mongoose.Types.ObjectId | null;
  modified_by?: mongoose.Types.ObjectId | null;
  created_at: Date;
  updated_at: Date;
}

interface IFaqModel extends Model<IFaq> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const faqSchema = new Schema<IFaq, IFaqModel>(
  {
    question: { type: String, required: true, trim: true, maxlength: 200 },
    answer: { type: String, required: true, trim: true, maxlength: 4000 },
    category: {
      type: String,
      enum: FAQ_CATEGORIES,
      required: true,
    },
    audience: {
      type: String,
      enum: FAQ_AUDIENCES,
      default: 'all',
    },
    keywords: {
      type: [String],
      default: [],
      validate: {
        validator: (v: string[]) => Array.isArray(v) && v.length <= 10,
        message: 'Keywords must have at most 10 items',
      },
    },
    status: { type: Number, default: 0 }, // 0 unpublished · 1 published · 2 deleted
    sort_order: { type: Number, default: 0 },
    created_by: { type: Schema.Types.ObjectId, ref: 'tbl_user', default: null },
    modified_by: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_user',
      default: null,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

faqSchema.index({ status: 1, audience: 1, category: 1, sort_order: 1 });
faqSchema.index({ status: 1, sort_order: 1 });

faqSchema.plugin(toJSON);
faqSchema.plugin(paginate);

export const Faq = mongoose.model<IFaq, IFaqModel>('tbl_faq', faqSchema);
