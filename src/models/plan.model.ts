import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export interface IPlan extends Document {
  name: string;
  billingCycle: 'monthly' | 'yearly';
  amount: number;
  currency: string;
  trialDays: number;
  scanLimit: number;
  isActive: boolean;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
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
    billingCycle: {
      type: String,
      enum: ['monthly', 'yearly'],
      default: 'monthly',
    },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: 'INR', trim: true, uppercase: true },
    trialDays: { type: Number, default: 0, min: 0 },
    scanLimit: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    isPublic: { type: Boolean, default: false },
  },
  { timestamps: true },
);

planSchema.index({ isActive: 1, isPublic: 1 });

planSchema.plugin(toJSON);
planSchema.plugin(paginate);

export const Plan = mongoose.model<IPlan, IPlanModel>('tbl_plan', planSchema);
