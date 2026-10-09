import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export interface IOrganization extends Document {
  company_name: string;
  email?: string;
  contact_number?: string;
  country_name?: string;
  status: number;
  operator_seq: number;
  created_by?: mongoose.Types.ObjectId | null;
  modified_by?: mongoose.Types.ObjectId | null;
  created_at: Date;
  updated_at: Date;
}

interface IOrganizationModel extends Model<IOrganization> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const organizationSchema = new Schema<IOrganization, IOrganizationModel>(
  {
    company_name: { type: String, required: true, trim: true },
    email: { type: String, trim: true },
    contact_number: { type: String, trim: true },
    country_name: { type: String, trim: true },
    status: { type: Number, default: 1 },
    operator_seq: { type: Number, default: 1000 },
    created_by: { type: Schema.Types.ObjectId, index: true, default: null },
    modified_by: { type: Schema.Types.ObjectId, index: true, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

organizationSchema.plugin(toJSON);
organizationSchema.plugin(paginate);

export const Organization = mongoose.model<IOrganization, IOrganizationModel>(
  'tbl_organization',
  organizationSchema,
);
