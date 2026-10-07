import httpStatus from 'http-status';
import { WebSettings } from '../../models/web-settings.model.js';
import { createResponse } from '../common.service.js';
import type {
  ICompanyInfo,
  IContactInfo,
  IFooterSettings,
  ISocialLinks,
} from '../../models/web-settings.model.js';

/** Plain data shape served to the website and the panel (no mongoose bits). */
export type WebSettingsShape = {
  company: ICompanyInfo;
  contact: IContactInfo;
  social: ISocialLinks;
  footer: IFooterSettings;
};

/**
 * Single-document Web Settings. Until the admin panel saves for the first time
 * the API serves this snapshot of the current ScanFlow marketing site content,
 * so the website, navigation and footer keep rendering without hardcoding.
 */
export const DEFAULT_WEB_SETTINGS: WebSettingsShape = {
  company: {
    name: 'scanflow',
    website: '',
    tagline: "The world's fastest and most accurate barcode scanning engine.",
    about: 'High-throughput barcode scanning for warehouse-scale operations.',
  },
  contact: {
    email: 'info@ctasis.com',
    phone: '+91 7948993409',
    address:
      'A-865/866, Money Plant High Street, Jagatpur Rd, near BSNL Office, Gota, Gujarat 382470',
    city: 'Ahmedabad',
    state: 'Gujarat',
    country: 'India',
    postal_code: '382470',
    working_hours: 'Mon – Fri, 10:00 AM – 8:00 PM IST',
    timezone: 'Asia/Kolkata',
  },
  social: {
    facebook: '',
    instagram: '',
    linkedin: '',
    youtube: '',
    twitter: '',
  },
  footer: {
    about: '',
    copyright_text: '© 2026 ScanFlow Technologies, Inc. All rights reserved.',
    show_social: true,
    show_contact: true,
    show_address: true,
    show_working_hours: true,
  },
};

/**
 * Public — return the persisted settings or the seed defaults when nothing has
 * been saved yet.
 */
export const getWebSettings = async (): Promise<WebSettingsShape> => {
  const doc = await WebSettings.findOne({}).lean();
  if (doc) {
    return doc as unknown as WebSettingsShape;
  }
  return DEFAULT_WEB_SETTINGS;
};

/**
 * Admin — upsert the single settings document. The incoming payload is merged
 * over the persisted values (or the seed defaults on first save) so any subset
 * — e.g. one panel tab saving at a time — patches without clobbering the rest.
 */
export const updateWebSettings = async (payload: Partial<WebSettingsShape>) => {
  const existing = await WebSettings.findOne({}).lean();
  const base = existing ?? DEFAULT_WEB_SETTINGS;
  const merged: WebSettingsShape = {
    company: { ...base.company, ...(payload.company ?? {}) },
    contact: { ...base.contact, ...(payload.contact ?? {}) },
    social: { ...base.social, ...(payload.social ?? {}) },
    footer: { ...base.footer, ...(payload.footer ?? {}) },
  };

  const doc = await WebSettings.findOneAndUpdate(
    {},
    { $set: merged },
    { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
  );
  return createResponse(httpStatus.OK, 'Web settings saved successfully.', doc);
};
