import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export interface IScan extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  deviceId?: string;
  clientScanId: string;
  barcode: string;
  barcodeType?: string;
  scannedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface IScanModel extends Model<IScan> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const scanSchema = new Schema<IScan, IScanModel>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    userId: { type: Schema.Types.ObjectId, ref: 'tbl_user', required: true },
    deviceId: { type: String, trim: true },
    clientScanId: { type: String, required: true, trim: true },
    barcode: { type: String, required: true, trim: true },
    barcodeType: { type: String, trim: true },
    scannedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

scanSchema.index({ organizationId: 1, clientScanId: 1 }, { unique: true });
scanSchema.index({ organizationId: 1, scannedAt: 1 });
scanSchema.index({ organizationId: 1, userId: 1, scannedAt: 1 });

scanSchema.plugin(toJSON);
scanSchema.plugin(paginate);

export const Scan = mongoose.model<IScan, IScanModel>('tbl_scan', scanSchema);
