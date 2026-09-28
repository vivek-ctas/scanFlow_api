import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export type PaymentStatus =
  'CREATED' | 'TXN_SUCCESS' | 'TXN_FAILURE' | 'FAILED' | 'CANCELLED';

export type PaymentGateway = 'stripe' | 'razorpay';

export interface IPayment extends Document {
  leadId: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId | null;
  gateway: PaymentGateway;
  amount: number;
  gatewayAmount: number;
  currency: string;
  status: PaymentStatus;
  gatewayEventId?: string;
  successResponse?: Record<string, any>;
  failedResponse?: Record<string, any>;
  invoiceNumber?: string;
  invoiceUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface IPaymentModel extends Model<IPayment> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const paymentSchema = new Schema<IPayment, IPaymentModel>(
  {
    leadId: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_guestLead',
      required: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
    },
    gateway: { type: String, enum: ['stripe', 'razorpay'], required: true },
    amount: { type: Number, required: true, min: 0 },
    gatewayAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, trim: true, uppercase: true },
    status: {
      type: String,
      enum: ['CREATED', 'TXN_SUCCESS', 'TXN_FAILURE', 'FAILED', 'CANCELLED'],
      default: 'CREATED',
    },
    gatewayEventId: { type: String, trim: true },
    successResponse: { type: Schema.Types.Mixed },
    failedResponse: { type: Schema.Types.Mixed },
    invoiceNumber: { type: String, trim: true },
    invoiceUrl: { type: String, trim: true },
  },
  { timestamps: true },
);

paymentSchema.index({ leadId: 1 });
paymentSchema.index({ gatewayEventId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ status: 1, createdAt: 1 });

paymentSchema.plugin(toJSON);
paymentSchema.plugin(paginate);

export const Payment = mongoose.model<IPayment, IPaymentModel>(
  'tbl_payment',
  paymentSchema,
);
