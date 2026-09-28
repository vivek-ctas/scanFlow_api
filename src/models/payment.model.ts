import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export type PaymentStatus =
  'CREATED' | 'TXN_SUCCESS' | 'TXN_FAILURE' | 'FAILED' | 'CANCELLED';

export type PaymentGateway = 'stripe' | 'razorpay' | 'manual';

export interface IPayment extends Document {
  lead_id?: mongoose.Types.ObjectId | null;
  organization_id?: mongoose.Types.ObjectId | null;
  plan_id: mongoose.Types.ObjectId;
  gateway: PaymentGateway;
  price: number;
  currency_code: string;
  billing_cycle: 'month' | 'quarterly';
  order_id?: string | null;
  transaction_id?: string | null;
  status: PaymentStatus;
  gateway_response?: Record<string, any>;
  paid_at?: Date | null;
  invoice_number?: string;
  invoice_url?: string;
  created_at: Date;
  updated_at: Date;
}

interface IPaymentModel extends Model<IPayment> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const paymentSchema = new Schema<IPayment, IPaymentModel>(
  {
    lead_id: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_guestLead',
      default: null,
    },
    organization_id: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
    },
    plan_id: { type: Schema.Types.ObjectId, ref: 'tbl_plan', required: true },
    gateway: {
      type: String,
      enum: ['stripe', 'razorpay', 'manual'],
      required: true,
    },
    price: { type: Number, required: true, min: 0 },
    currency_code: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    billing_cycle: {
      type: String,
      enum: ['month', 'quarterly'],
      required: true,
    },
    order_id: { type: String, trim: true },
    transaction_id: { type: String, trim: true },
    status: {
      type: String,
      enum: ['CREATED', 'TXN_SUCCESS', 'TXN_FAILURE', 'FAILED', 'CANCELLED'],
      default: 'CREATED',
    },
    gateway_response: { type: Schema.Types.Mixed },
    paid_at: { type: Date },
    invoice_number: { type: String, trim: true },
    invoice_url: { type: String, trim: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

paymentSchema.index({ lead_id: 1 });
paymentSchema.index({ order_id: 1 });
paymentSchema.index({ transaction_id: 1 }, { unique: true, sparse: true });
paymentSchema.index({ status: 1, created_at: 1 });
paymentSchema.index({ plan_id: 1 });

paymentSchema.plugin(toJSON);
paymentSchema.plugin(paginate);

export const Payment = mongoose.model<IPayment, IPaymentModel>(
  'tbl_payment',
  paymentSchema,
);
