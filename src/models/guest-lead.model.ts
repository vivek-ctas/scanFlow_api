import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export type GuestLeadStatus =
  'pending' | 'initiated' | 'success' | 'failed' | 'cancelled';

export interface IGuestLead extends Document {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  company?: string;
  planId: mongoose.Types.ObjectId;
  trialDays: number;
  status: GuestLeadStatus;
  purchaseLink?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface IGuestLeadModel extends Model<IGuestLead> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const guestLeadSchema = new Schema<IGuestLead, IGuestLeadModel>(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    phone: { type: String, trim: true },
    company: { type: String, trim: true },
    planId: { type: Schema.Types.ObjectId, ref: 'tbl_plan', required: true },
    trialDays: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ['pending', 'initiated', 'success', 'failed', 'cancelled'],
      default: 'pending',
    },
    purchaseLink: { type: String },
  },
  { timestamps: true },
);

guestLeadSchema.index({ status: 1, createdAt: 1 });

guestLeadSchema.plugin(toJSON);
guestLeadSchema.plugin(paginate);

export const GuestLead = mongoose.model<IGuestLead, IGuestLeadModel>(
  'tbl_guestLead',
  guestLeadSchema,
);
