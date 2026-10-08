/**
 * ScanFlow email brand tokens. Mirror the marketing site palette
 * (scanflow/app/globals.css): Primary Navy #13355A + Accent Sky #3C9AC4.
 */
export const BRAND = {
  navy: '#13355A',
  navyDeep: '#0A1B2E',
  sky: '#3C9AC4',
  skyLight: '#6BC1E0',
  skySoft: '#38BDF8',
  gradient: 'linear-gradient(135deg, #3C9AC4 0%, #13355A 100%)',
  textPrimary: '#111827',
  textSecondary: '#4B5563',
  textMuted: '#6B7280',
  border: '#E2E8F0',
  surface: '#F8FAFC',
  otpBackground: '#EFF7FB',
} as const;

export const DEFAULT_COMPANY_NAME = 'ScanFlow';
export const DEFAULT_SUPPORT_EMAIL = 'info@scanflow.app';
export const DEFAULT_PANEL_LOGIN_PATH = '/login';
