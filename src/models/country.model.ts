import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export interface ICountry extends Document {
  country_code: string;
  country_name: string;
  currency_code: string;
  aliases: string[];
}

interface ICountryModel extends Model<ICountry> {
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const countrySchema = new Schema<ICountry, ICountryModel>(
  {
    country_code: { type: String, required: true, trim: true, index: true },
    country_name: { type: String, required: true, trim: true, index: true },
    currency_code: { type: String, required: true, trim: true },
    aliases: { type: [String], default: [] },
  },
  { timestamps: false, collection: 'tbl_country_data' },
);

countrySchema.plugin(toJSON);
countrySchema.plugin(paginate);

export const Country = mongoose.model<ICountry, ICountryModel>(
  'tbl_country_data',
  countrySchema,
);
