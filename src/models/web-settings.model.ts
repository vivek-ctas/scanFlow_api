import mongoose, { Document, Model, Schema } from 'mongoose';
import { toJSON } from './plugins/toJSON.plugin.js';

export interface ICompanyInfo {
  name: string;
  website?: string;
  tagline?: string;
  about?: string;
}

export interface IContactInfo {
  email: string;
  phone: string;
  address: string;
  city?: string;
  state?: string;
  country?: string;
  postal_code: string;
  working_hours?: string;
  timezone?: string;
}

export interface ISocialLinks {
  facebook?: string;
  instagram?: string;
  linkedin?: string;
  youtube?: string;
  twitter?: string;
}

export interface IFooterSettings {
  about?: string;
  copyright_text?: string;
  show_social?: boolean;
  show_contact?: boolean;
  show_address?: boolean;
  show_working_hours?: boolean;
}

export interface IWebSettings extends Document {
  company: ICompanyInfo;
  contact: IContactInfo;
  social: ISocialLinks;
  footer: IFooterSettings;
  created_at: Date;
  updated_at: Date;
}

const companySchema = new Schema<ICompanyInfo>(
  {
    name: { type: String, required: true, trim: true },
    website: { type: String, trim: true },
    tagline: { type: String, trim: true },
    about: { type: String, trim: true },
  },
  { _id: false },
);

const contactSchema = new Schema<IContactInfo>(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true },
    postal_code: { type: String, required: true, trim: true },
    working_hours: { type: String, trim: true },
    timezone: { type: String, default: 'Asia/Kolkata', trim: true },
  },
  { _id: false },
);

const socialSchema = new Schema<ISocialLinks>(
  {
    facebook: { type: String, trim: true },
    instagram: { type: String, trim: true },
    linkedin: { type: String, trim: true },
    youtube: { type: String, trim: true },
    twitter: { type: String, trim: true },
  },
  { _id: false },
);

const footerSchema = new Schema<IFooterSettings>(
  {
    about: { type: String, trim: true },
    copyright_text: { type: String, trim: true },
    show_social: { type: Boolean, default: true },
    show_contact: { type: Boolean, default: true },
    show_address: { type: Boolean, default: true },
    show_working_hours: { type: Boolean, default: true },
  },
  { _id: false },
);

const webSettingsSchema = new Schema<IWebSettings, Model<IWebSettings>>(
  {
    company: { type: companySchema, default: () => ({}) },
    contact: { type: contactSchema, default: () => ({}) },
    social: { type: socialSchema, default: () => ({}) },
    footer: { type: footerSchema, default: () => ({}) },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

webSettingsSchema.plugin(toJSON);

export const WebSettings = mongoose.model<IWebSettings, Model<IWebSettings>>(
  'tbl_web_setting',
  webSettingsSchema,
);
