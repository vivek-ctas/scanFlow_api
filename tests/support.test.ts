import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import {
  connectDb,
  disconnectDb,
  clearDb,
  createAdminUser,
  createOrg,
  createUser,
  createPlan,
  grant,
} from './helpers.js';
import { generateAuthTokens } from '../src/services/token.service.js';
import { SupportTicket, SupportMessage } from '../src/models/index.js';

vi.mock('../src/config/config.js', () => ({
  default: {
    NODE_ENV: 'test',
    PORT: 3000,
    mongoose: { url: process.env.MONGODB_URL! },
    jwt: { secret: 'test', accessExpirationMinutes: 30, refreshExpirationDays: 30, resetPasswordExpirationMinutes: 10, verifyEmailExpirationMinutes: 10 },
    email: { smtp: { host: 'localhost', port: 587, username: '', password: '' }, from: 'test@test.com' },
    redis: { url: 'redis://localhost:6379' },
    panelUrl: 'http://localhost:7052',
    dashboard: { nearLimitPct: 80, alertCooldownMinutes: 60 },
    support: {
      notifyEmails: '',
      firstResponseHours: 24,
      autocloseDays: 7,
      maxAttachmentMb: 5,
      storageDriver: 'local',
      uploadDir: '/tmp/support-test',
      rateCreatePerHour: 10,
      rateReplyPerHour: 60,
      maxActivePerOrg: 25,
    },
    stripe: { secretKey: '', webhookSecret: '' },
  },
}));

const tokenFor = async (user: any) => {
  const tokens = await generateAuthTokens(user as any);
  return tokens.access_token;
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('support flow — customer + staff', () => {
  let superAdmin: any;
  let org: any;
  let orgAdmin: any;
  let superToken: string;
  let orgAdminToken: string;
  let plan: any;

  beforeAll(async () => {
    await connectDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  beforeEach(async () => {
    await clearDb();
    await SupportTicket.deleteMany({});
    await SupportMessage.deleteMany({});

    superAdmin = await createAdminUser();
    superToken = await tokenFor(superAdmin);

    org = await createOrg({ company_name: 'Support Test Org' });
    plan = await createPlan({ scan_limit: 1000 });
    await grant(String(org._id), String(plan._id));

    orgAdmin = await createUser('ORGANIZATION_ADMIN', String(org._id), {
      email: 'orgadmin@example.com',
    });
    orgAdminToken = await tokenFor(orgAdmin);
  });

  describe('POST /support/tickets (viewSupport)', () => {
    it('org admin can create a ticket', async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Scanner not reading QR codes',
          category: 'scanner',
          priority: 'high',
          description: 'The scanner fails on GS1 DataMatrix codes at high speed.',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.ticket).toMatchObject({
        subject: 'Scanner not reading QR codes',
        category: 'scanner',
        priority: 'high',
        status: 'open',
        ticket_no: expect.stringMatching(/^SF-\d+$/),
      });
      expect(res.body.data.ticket.id).toBeDefined();
    });

    it('super admin can create a ticket on behalf of an org', async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(superToken))
        .send({
          subject: 'SA filing for customer',
          category: 'subscription_quota',
          description: 'Customer reached quota limit and needs guidance.',
          organization_id: String(org._id),
        });

      expect(res.status).toBe(201);
      expect(res.body.data.ticket.organization.id).toBe(String(org._id));
    });

    it('super admin without organization_id is rejected', async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(superToken))
        .send({
          subject: 'No org provided',
          category: 'other',
          description: 'Super admin must pass organization_id when filing for a customer.',
        });

      expect(res.status).toBe(400);
    });

    it('rejects invalid category', async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Bad category',
          category: 'not-a-category',
          description: 'This should fail validation.',
        });

      expect(res.status).toBe(400);
    });

    it('rejects short description', async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Short desc',
          category: 'scanner',
          description: 'short',
        });

      expect(res.status).toBe(400);
    });

    it('enforces priority restriction for non-staff', async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Critical issue',
          category: 'scanner',
          priority: 'critical',
          description: 'Only staff should set critical.',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Priority must be normal or high/);
    });
  });

  describe('GET /support/tickets (viewSupport)', () => {
    let ticketId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Listable ticket',
          category: 'scanner',
          description: 'This ticket should appear in lists.',
        });
      ticketId = res.body.data.ticket.id;
    });

    it('org admin sees their org tickets', async () => {
      const res = await request(app)
        .get('/api/support/tickets')
        .set(bearer(orgAdminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.results.length).toBe(1);
      expect(res.body.data.results[0].id).toBe(ticketId);
    });

    it('super admin sees all tickets (no org scope)', async () => {
      await request(app)
        .post('/api/support/tickets')
        .set(bearer(superToken))
        .send({
          subject: 'SA ticket',
          category: 'other',
          description: 'Visible to SA only',
          organization_id: String(org._id),
        });

      const res = await request(app)
        .get('/api/support/tickets')
        .set(bearer(superToken));

      expect(res.status).toBe(200);
      expect(res.body.data.results.length).toBe(2);
    });

    it('filters by view=active', async () => {
      const res = await request(app)
        .get('/api/support/tickets?view=active')
        .set(bearer(orgAdminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.results.length).toBe(1);
    });

    it('filters by status', async () => {
      const res = await request(app)
        .get('/api/support/tickets?status=open')
        .set(bearer(orgAdminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.results[0].status).toBe('open');
    });

    it('paginates', async () => {
      const res = await request(app)
        .get('/api/support/tickets?limit=1&page=1')
        .set(bearer(orgAdminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.results.length).toBe(1);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.limit).toBe(1);
    });
  });

  describe('GET /support/tickets/summary', () => {
    it('org admin sees counts for their org', async () => {
      await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Ticket 1',
          category: 'scanner',
          description: 'First ticket',
        });
      await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Ticket 2',
          category: 'account_login',
          description: 'Second ticket',
        });

      const res = await request(app)
        .get('/api/support/tickets/summary')
        .set(bearer(orgAdminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.active).toBe(2);
      expect(res.body.data.awaiting_customer).toBe(0);
    });
  });

  describe('GET /support/tickets/:ticketId', () => {
    let ticketId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Detail ticket',
          category: 'webhook',
          description: 'Webhook not firing on scan completion.',
        });
      ticketId = res.body.data.ticket.id;
    });

    it('returns ticket detail with messages', async () => {
      const res = await request(app)
        .get(`/api/support/tickets/${ticketId}`)
        .set(bearer(orgAdminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.ticket.id).toBe(ticketId);
      expect(res.body.data.ticket.messages).toHaveLength(1);
      expect(res.body.data.ticket.messages[0].body).toBe(
        'Webhook not firing on scan completion.',
      );
    });

    it('cross-org access returns 404', async () => {
      const otherOrg = await createOrg({ company_name: 'Other Org' });
      const otherAdmin = await createUser('ORGANIZATION_ADMIN', String(otherOrg._id));
      const otherToken = await tokenFor(otherAdmin);

      const res = await request(app)
        .get(`/api/support/tickets/${ticketId}`)
        .set(bearer(otherToken));

      expect(res.status).toBe(404);
    });
  });

  describe('POST /support/tickets/:ticketId/messages (viewSupport)', () => {
    let ticketId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Reply test',
          category: 'scanner',
          description: 'Initial message.',
        });
      ticketId = res.body.data.ticket.id;
    });

    it('customer can reply', async () => {
      const res = await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken))
        .send({ message: 'Adding more detail to my issue.' });

      expect(res.status).toBe(200);
      expect(res.body.data.message.body).toBe('Adding more detail to my issue.');
      expect(res.body.data.message.kind).toBe('reply');
      expect(res.body.data.message.is_internal).toBe(false);
    });

    it('updates last_customer_message_at', async () => {
      await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken))
        .send({ message: 'Customer follow-up.' });

      const detail = await request(app)
        .get(`/api/support/tickets/${ticketId}`)
        .set(bearer(orgAdminToken));

      expect(detail.body.data.ticket.last_customer_message_at).toBeDefined();
    });
  });

  describe('POST /support/tickets/:ticketId/notes (manageSupport)', () => {
    let ticketId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Note test',
          category: 'bug',
          description: 'Customer reported a bug.',
        });
      ticketId = res.body.data.ticket.id;
    });

    it('super admin can add internal note', async () => {
      const res = await request(app)
        .post(`/api/support/tickets/${ticketId}/notes`)
        .set(bearer(superToken))
        .send({ message: 'Internal note: reproduce on staging.' });

      expect(res.status).toBe(200);
      expect(res.body.data.message.kind).toBe('note');
      expect(res.body.data.message.is_internal).toBe(true);
      expect(res.body.data.message.sender_role).toBe('SUPER_ADMIN');
    });

    it('org admin cannot add notes (403)', async () => {
      const res = await request(app)
        .post(`/api/support/tickets/${ticketId}/notes`)
        .set(bearer(orgAdminToken))
        .send({ message: 'Should not work.' });

      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /support/tickets/:ticketId/close (viewSupport)', () => {
    let ticketId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Close me',
          category: 'other',
          description: 'Ticket to close.',
        });
      ticketId = res.body.data.ticket.id;
    });

    it('customer can close their ticket', async () => {
      const res = await request(app)
        .patch(`/api/support/tickets/${ticketId}/close`)
        .set(bearer(orgAdminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.ticket.status).toBe('closed');
      expect(res.body.data.ticket.closed_at).toBeDefined();
    });
  });

  describe('PATCH /support/tickets/:ticketId (manageSupport)', () => {
    let ticketId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Assign me',
          category: 'scanner',
          description: 'Needs staff assignment.',
        });
      ticketId = res.body.data.ticket.id;
    });

    it('super admin can assign ticket', async () => {
      const res = await request(app)
        .patch(`/api/support/tickets/${ticketId}`)
        .set(bearer(superToken))
        .send({ assigned_to: String(superAdmin._id) });

      expect(res.status).toBe(200);
      expect(res.body.data.ticket.assigned_to?.id).toBe(String(superAdmin._id));
    });

    it('super admin can change priority', async () => {
      const res = await request(app)
        .patch(`/api/support/tickets/${ticketId}`)
        .set(bearer(superToken))
        .send({ priority: 'critical' });

      expect(res.status).toBe(200);
      expect(res.body.data.ticket.priority).toBe('critical');
    });

    it('org admin cannot update ticket (403)', async () => {
      const res = await request(app)
        .patch(`/api/support/tickets/${ticketId}`)
        .set(bearer(orgAdminToken))
        .send({ priority: 'high' });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /support/staff (manageSupport)', () => {
    it('returns list of super admins', async () => {
      const res = await request(app)
        .get('/api/support/staff')
        .set(bearer(superToken));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.results)).toBe(true);
      expect(res.body.data.results.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.results[0]).toHaveProperty('name');
    });

    it('org admin cannot access (403)', async () => {
      const res = await request(app)
        .get('/api/support/staff')
        .set(bearer(orgAdminToken));

      expect(res.status).toBe(403);
    });
  });

  describe('Attachments', () => {
    it('ticket creation accepts multipart attachments', async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .attach('attachments', Buffer.from('test content'), 'test.txt')
        .field('subject', 'With attachment')
        .field('category', 'other')
        .field('description', 'This ticket has a file attached.');

      expect(res.status).toBe(201);
      expect(res.body.data.ticket.messages[0].attachments).toHaveLength(1);
      expect(res.body.data.ticket.messages[0].attachments[0].file_name).toBe(
        'test.txt',
      );
    });

    it('reply accepts attachments', async () => {
      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Reply attachment',
          category: 'other',
          description: 'Base ticket.',
        });
      const ticketId = created.body.data.ticket.id;

      const res = await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken))
        .attach('attachments', Buffer.from('reply file'), 'reply.pdf')
        .field('message', 'Here is the log file.');

      expect(res.status).toBe(200);
      expect(res.body.data.message.attachments).toHaveLength(1);
      expect(res.body.data.message.attachments[0].content_type).toBe(
        'application/pdf',
      );
    });

    it('rejects unsupported mime type', async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .attach('attachments', Buffer.from('exe'), 'malware.exe')
        .field('subject', 'Bad file')
        .field('category', 'other')
        .field('description', 'Should be rejected.');

      expect(res.status).toBe(400);
    });

    it('rejects files over size limit', async () => {
      const large = Buffer.alloc(6 * 1024 * 1024);
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .attach('attachments', large, 'large.bin')
        .field('subject', 'Too big')
        .field('category', 'other')
        .field('description', 'Exceeds 5MB default.');

      expect(res.status).toBe(400);
    });
  });
});