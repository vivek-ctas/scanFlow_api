import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export interface IPlan extends Document {
  name: string;
  desc?: string;
  price: number;
  price_quarterly?: number | null;
  currency: string;
  trial_days: number;
  features: { features_name: string; scan_limit: number }[];
  marketing_features: string[];
  status: number;
  is_custom_plan: boolean;
  is_popular: boolean;
  discount: number;
  created_at: Date;
  updated_at: Date;
}

interface IPlanModel extends Model<IPlan> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const planSchema = new Schema<IPlan, IPlanModel>(
  {
    name: { type: String, required: true, trim: true },
    desc: { type: String, trim: true },
    price: { type: Number, required: true, min: 0 },
    price_quarterly: { type: Number, default: null, min: 0 },
    currency: { type: String, default: 'inr', trim: true, lowercase: true },
    trial_days: { type: Number, default: 0, min: 0 },
    features: {
      type: [
        {
          _id: false,
          features_name: { type: String, required: true, trim: true },
          scan_limit: { type: Number, default: 0, min: 0 },
        },
      ],
      default: [],
    },
    marketing_features: { type: [String], default: [] },
    status: { type: Number, default: 1 },
    is_custom_plan: { type: Boolean, default: false },
    is_popular: { type: Boolean, default: false },
    discount: { type: Number, default: 0, min: 0, max: 100 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

planSchema.index({ status: 1, is_custom_plan: 1 });

planSchema.plugin(toJSON);
planSchema.plugin(paginate);

export const Plan = mongoose.model<IPlan, IPlanModel>('tbl_plan', planSchema);
