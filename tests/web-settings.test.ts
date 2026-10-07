import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { createAdminUser } from './helpers.js';
import { generateAuthTokens } from '../src/services/token.service.js';
import { WebSettings } from '../src/models/index.js';
import { DEFAULT_WEB_SETTINGS } from '../src/services/admin/web-settings.service.js';

const tokenFor = async (user: any) => {
  const tokens = await generateAuthTokens(user as any);
  return tokens.access_token;
};

const fullPayload = {
  company: {
    name: 'ScanFlow Technologies',
    website: 'https://scanflow.dev',
    tagline: 'Scan at warehouse scale.',
    about: 'High-throughput barcode scanning.',
  },
  contact: {
    email: 'hello@scanflow.dev',
    phone: '+91 9900000000',
    address: '12 Test Road, Test City',
    city: 'Ahmedabad',
    state: 'Gujarat',
    country: 'India',
    postal_code: '380001',
    working_hours: 'Mon – Fri, 10 AM – 6 PM IST',
    timezone: 'Asia/Kolkata',
  },
  social: {
    linkedin: 'https://linkedin.com/company/scanflow',
    twitter: 'https://x.com/scanflow',
    facebook: '',
    instagram: '',
    youtube: '',
  },
  footer: {
    about: 'Built for warehouse-scale reliability.',
    copyright_text: '© 2026 ScanFlow Technologies Pvt. Ltd.',
    show_social: true,
    show_contact: true,
    show_address: false,
    show_working_hours: true,
  },
};

describe('web settings flow — public read + admin upsert', () => {
  describe('GET /web-settings (public)', () => {
    it('returns the seed defaults when nothing has been saved', async () => {
      const res = await request(app).get('/api/web-settings');
      expect(res.status).toBe(200);
      expect(res.body.data.webSettings.company.name).toBe('scanflow');
      expect(res.body.data.webSettings.contact.email).toBe('info@ctasis.com');
      expect(res.body.data.webSettings.footer.show_contact).toBe(true);
    });
  });

  describe('PUT /web-settings (auth: manageWebSettings)', () => {
    it('requires authentication', async () => {
      const res = await request(app).put('/api/web-settings').send(fullPayload);
      expect(res.status).toBe(401);
    });

    it('rejects a non-admin role', async () => {
      const user = await createAdminUser({ role: 'OPERATOR' });
      const token = await tokenFor(user);
      const res = await request(app)
        .put('/api/web-settings')
        .set('authorization', `Bearer ${token}`)
        .send(fullPayload);
      expect(res.status).toBe(403);
    });

    it('rejects an invalid payload', async () => {
      const admin = await createAdminUser();
      const token = await tokenFor(admin);
      const bad = structuredClone(fullPayload);
      bad.contact.email = 'not-an-email';
      const res = await request(app)
        .put('/api/web-settings')
        .set('authorization', `Bearer ${token}`)
        .send(bad);
      expect(res.status).toBe(400);
    });

    it('upserts the full settings and persists them', async () => {
      const admin = await createAdminUser();
      const token = await tokenFor(admin);

      const res = await request(app)
        .put('/api/web-settings')
        .set('authorization', `Bearer ${token}`)
        .send(fullPayload);

      expect(res.status).toBe(200);
      expect(res.body.data.company.name).toBe('ScanFlow Technologies');
      expect(res.body.data.contact.email).toBe('hello@scanflow.dev');
      expect(res.body.data.social.linkedin).toBe(
        'https://linkedin.com/company/scanflow',
      );

      const doc = await WebSettings.findOne({}).lean();
      expect(doc?.company.name).toBe('ScanFlow Technologies');
      expect(doc?.contact.postal_code).toBe('380001');

      const get = await request(app).get('/api/web-settings');
      expect(get.body.data.webSettings.company.name).toBe(
        'ScanFlow Technologies',
      );
      expect(get.body.data.webSettings.contact.email).toBe(
        'hello@scanflow.dev',
      );
    });

    it('merges a partial payload over existing settings', async () => {
      const admin = await createAdminUser();
      const token = await tokenFor(admin);

      await request(app)
        .put('/api/web-settings')
        .set('authorization', `Bearer ${token}`)
        .send(fullPayload);

      const res = await request(app)
        .put('/api/web-settings')
        .set('authorization', `Bearer ${token}`)
        .send({
          contact: { ...fullPayload.contact, phone: '+91 8888888888' },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.contact.phone).toBe('+91 8888888888');
      // Untouched fields survive the patch.
      expect(res.body.data.contact.email).toBe('hello@scanflow.dev');
      expect(res.body.data.company.name).toBe('ScanFlow Technologies');
    });

    it('defaults a fresh doc from the seed values', async () => {
      const admin = await createAdminUser();
      const token = await tokenFor(admin);

      const res = await request(app)
        .put('/api/web-settings')
        .set('authorization', `Bearer ${token}`)
        .send({
          footer: { ...DEFAULT_WEB_SETTINGS.footer, copyright_text: 'New ©' },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.footer.copyright_text).toBe('New ©');
      const doc = await WebSettings.findOne({}).lean();
      expect(doc?.contact.email).toBe('info@ctasis.com');
      expect(doc?.company.name).toBe('scanflow');
    });
  });
});
