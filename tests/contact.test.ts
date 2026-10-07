import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { createAdminUser } from './helpers.js';
import { generateAuthTokens } from '../src/services/token.service.js';
import { Contact } from '../src/models/index.js';

const tokenFor = async (user: any) => {
  const tokens = await generateAuthTokens(user as any);
  return tokens.access_token;
};

/** Full valid payload for the public form. */
const validPayload = {
  name: 'Grace Hopper',
  email: 'Grace@Example.COM',
  company: 'Naval Systems',
  phone: '+1 555 0100',
  inquiry_type: 'support',
  message: 'We need to scan GS1 barcodes at high volume.',
};

describe('contact us flow — public submit + admin management', () => {
  describe('POST /contact/public/submit (public)', () => {
    it('creates a contact inquiry and echoes it back', async () => {
      const res = await request(app)
        .post('/api/contact/public/submit')
        .send(validPayload);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('within 24 hours');
      expect(res.body.data).toMatchObject({
        name: 'Grace Hopper',
        email: 'grace@example.com',
        company: 'Naval Systems',
        phone: '+1 555 0100',
        inquiry_type: 'support',
        status: 0,
        replies: [],
      });

      const doc = await Contact.findById(res.body.data.id);
      expect(doc?.email).toBe('grace@example.com');
      expect(doc?.status).toBe(0);
    });

    it('defaults inquiry_type to general and allows omitted company/phone', async () => {
      const res = await request(app)
        .post('/api/contact/public/submit')
        .send({
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          message: 'I would like to know more about ScanFlow pricing.',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.inquiry_type).toBe('general');
      expect(res.body.data.company).toBeUndefined();
      expect(res.body.data.phone).toBeUndefined();
    });

    it.each([
      ['missing name', { email: 'a@example.com', message: 'A message long enough' }],
      ['missing email', { name: 'A', message: 'A message long enough' }],
      ['invalid email', { name: 'A', email: 'nope', message: 'A message long enough' }],
      ['short message', { name: 'A', email: 'a@example.com', message: 'short' }],
      ['bad inquiry_type', { ...validPayload, inquiry_type: 'spam' }],
    ])('rejects a submission with %s', async (_label, body) => {
      const res = await request(app)
        .post('/api/contact/public/submit')
        .send(body);
      expect(res.status).toBe(400);
    });
  });

  describe('admin contact management (auth: manageContact)', () => {
    it('requires authentication on the admin list', async () => {
      const res = await request(app).get('/api/contact');
      expect(res.status).toBe(401);
    });

    it('lists paginated contacts and filters by status + search', async () => {
      const admin = await createAdminUser();
      const token = await tokenFor(admin);

      await Contact.create([
        { name: 'Alice', email: 'alice@example.com', message: 'Hello world inquiry one', inquiry_type: 'sales', status: 0 },
        { name: 'Bob', email: 'bob@example.com', message: 'Hello world inquiry two', inquiry_type: 'support', status: 1 },
        { name: 'Carol', email: 'carol@example.com', message: 'Hello world inquiry three', inquiry_type: 'general', status: 2 },
      ]);

      const res = await request(app)
        .get('/api/contact')
        .set('authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.results).toHaveLength(3);
      expect(res.body.data.total_results).toBe(3);
      expect(res.body.data.results.map((c: any) => c.name).sort()).toEqual([
        'Alice',
        'Bob',
        'Carol',
      ]);

      const byStatus = await request(app)
        .get('/api/contact?status=1&search=Bob')
        .set('authorization', `Bearer ${token}`);
      expect(byStatus.status).toBe(200);
      expect(byStatus.body.data.total_results).toBe(1);
      expect(byStatus.body.data.results[0].name).toBe('Bob');

      const byType = await request(app)
        .get('/api/contact?inquiry_type=support')
        .set('authorization', `Bearer ${token}`);
      expect(byType.status).toBe(200);
      expect(byType.body.data.total_results).toBe(1);
      expect(byType.body.data.results[0].inquiry_type).toBe('support');
    });

    it('gets a single contact and 404s for a valid-but-unknown id', async () => {
      const admin = await createAdminUser();
      const token = await tokenFor(admin);
      const contact = await Contact.create({
        name: 'Dan',
        email: 'dan@example.com',
        message: 'A sufficiently detailed message',
      });

      const getRes = await request(app)
        .get(`/api/contact/${contact._id}`)
        .set('authorization', `Bearer ${token}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.contact.name).toBe('Dan');

      const missing = await request(app)
        .get(`/api/contact/${new (await import('mongoose')).Types.ObjectId()}`)
        .set('authorization', `Bearer ${token}`);
      expect(missing.status).toBe(404);
    });

    it('updates contact status', async () => {
      const admin = await createAdminUser();
      const token = await tokenFor(admin);
      const contact = await Contact.create({
        name: 'Eve',
        email: 'eve@example.com',
        message: 'A sufficiently detailed message',
      });

      const res = await request(app)
        .patch(`/api/contact/${contact._id}/status`)
        .set('authorization', `Bearer ${token}`)
        .send({ status: 1 });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(1);
      expect((await Contact.findById(contact._id))?.status).toBe(1);
    });

    it('rejects an invalid status value', async () => {
      const admin = await createAdminUser();
      const token = await tokenFor(admin);
      const contact = await Contact.create({
        name: 'Eve',
        email: 'eve@example.com',
        message: 'A sufficiently detailed message',
      });

      const res = await request(app)
        .patch(`/api/contact/${contact._id}/status`)
        .set('authorization', `Bearer ${token}`)
        .send({ status: 9 });
      expect(res.status).toBe(400);
    });

    it('appends a reply and flips status to replied', async () => {
      const admin = await createAdminUser();
      const token = await tokenFor(admin);
      const contact = await Contact.create({
        name: 'Frank',
        email: 'frank@example.com',
        message: 'A sufficiently detailed message',
      });

      const res = await request(app)
        .post(`/api/contact/${contact._id}/reply`)
        .set('authorization', `Bearer ${token}`)
        .send({ message: 'Thanks for reaching out — we will be in touch.' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(2);
      expect(res.body.data.replies).toHaveLength(1);
      expect(res.body.data.replies[0]).toMatchObject({
        message: 'Thanks for reaching out — we will be in touch.',
        sent_by: admin.email,
      });

      const stored = await Contact.findById(contact._id);
      expect(stored?.status).toBe(2);
      expect(stored?.replies[0].sent_by).toBe(admin.email);
    });

    it('rejects a reply with an empty message', async () => {
      const admin = await createAdminUser();
      const token = await tokenFor(admin);
      const contact = await Contact.create({
        name: 'Frank',
        email: 'frank@example.com',
        message: 'A sufficiently detailed message',
      });

      const res = await request(app)
        .post(`/api/contact/${contact._id}/reply`)
        .set('authorization', `Bearer ${token}`)
        .send({ message: '   ' });
      expect(res.status).toBe(400);
    });
  });
});