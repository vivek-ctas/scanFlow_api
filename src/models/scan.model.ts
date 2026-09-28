import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export interface IScan extends Document {
  organization_id: mongoose.Types.ObjectId;
  user_id: mongoose.Types.ObjectId;
  device_id?: string;
  client_scan_id: string;
  barcode: string;
  barcode_type?: string;
  scanned_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface IScanModel extends Model<IScan> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const scanSchema = new Schema<IScan, IScanModel>(
  {
    organization_id: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    user_id: { type: Schema.Types.ObjectId, ref: 'tbl_user', required: true },
    device_id: { type: String, trim: true },
    client_scan_id: { type: String, required: true, trim: true },
    barcode: { type: String, required: true, trim: true },
    barcode_type: { type: String, trim: true },
    scanned_at: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

scanSchema.index({ organization_id: 1, client_scan_id: 1 }, { unique: true });
scanSchema.index({ organization_id: 1, scanned_at: 1 });
scanSchema.index({ organization_id: 1, user_id: 1, scanned_at: 1 });

scanSchema.plugin(toJSON);
scanSchema.plugin(paginate);

export const Scan = mongoose.model<IScan, IScanModel>('tbl_scan', scanSchema);
