import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export type GuestLeadStatus =
  'pending' | 'initiated' | 'success' | 'failed' | 'cancelled';

export interface IGuestLead extends Document {
  first_name: string;
  last_name: string;
  email: string;
  contact_number?: string;
  company_name?: string;
  country_name?: string;
  currency_code: string;
  plan_id: mongoose.Types.ObjectId;
  organization_id?: mongoose.Types.ObjectId | null;
  trial_days: number;
  status: GuestLeadStatus;
  created_at: Date;
  updated_at: Date;
}

interface IGuestLeadModel extends Model<IGuestLead> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const guestLeadSchema = new Schema<IGuestLead, IGuestLeadModel>(
  {
    first_name: { type: String, required: true, trim: true },
    last_name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    contact_number: { type: String, trim: true },
    company_name: { type: String, trim: true },
    country_name: { type: String, trim: true },
    currency_code: {
      type: String,
      default: 'inr',
      trim: true,
      lowercase: true,
    },
    plan_id: { type: Schema.Types.ObjectId, ref: 'tbl_plan', required: true },
    organization_id: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_organization',
      default: null,
    },
    trial_days: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ['pending', 'initiated', 'success', 'failed', 'cancelled'],
      default: 'pending',
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

guestLeadSchema.index({ status: 1, created_at: 1 });

guestLeadSchema.plugin(toJSON);
guestLeadSchema.plugin(paginate);

export const GuestLead = mongoose.model<IGuestLead, IGuestLeadModel>(
  'tbl_guestLead',
  guestLeadSchema,
);
