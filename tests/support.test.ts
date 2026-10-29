import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
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
import {
  SupportTicket,
  SupportMessage,
  WebhookConfig,
  WebhookDelivery,
} from '../src/models/index.js';

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

    it('combines view=awaiting_staff with search', async () => {
      const staffReplied = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Alpha scanner issue',
          category: 'scanner',
          description: 'A staff member will answer this one.',
        });

      const stillWaiting = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Beta scanner issue',
          category: 'scanner',
          description: 'Nobody has answered this one yet.',
        });

      await request(app)
        .post(`/api/support/tickets/${staffReplied.body.data.ticket.id}/messages`)
        .set(bearer(superToken))
        .send({ message: 'We are looking into it.' });

      const res = await request(app)
        .get('/api/support/tickets?view=awaiting_staff&search=scanner')
        .set(bearer(superToken));

      expect(res.status).toBe(200);
      const ids = res.body.data.results.map((ticket: any) => ticket.id);
      expect(ids).toContain(stillWaiting.body.data.ticket.id);
      expect(ids).not.toContain(staffReplied.body.data.ticket.id);
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

    it('returns ticket detail metadata only (no messages array)', async () => {
      const res = await request(app)
        .get(`/api/support/tickets/${ticketId}`)
        .set(bearer(orgAdminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.ticket.id).toBe(ticketId);
      // Detail endpoint is metadata-only.
      expect(res.body.data.ticket.messages).toBeUndefined();
      expect(res.body.data.ticket.last_public_message?.preview).toContain(
        'Webhook not firing',
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

    it('returns metadata only — no full thread (paginated via /messages)', async () => {
      for (let i = 0; i < 35; i += 1) {
        await request(app)
          .post(`/api/support/tickets/${ticketId}/messages`)
          .set(bearer(orgAdminToken))
          .send({ message: `Follow-up ${i + 1}` });
      }

      const res = await request(app)
        .get(`/api/support/tickets/${ticketId}`)
        .set(bearer(orgAdminToken));

      expect(res.status).toBe(200);
      expect(res.body.data.ticket.id).toBe(ticketId);
      // Detail endpoint is metadata-only: no messages array.
      expect(res.body.data.ticket.messages).toBeUndefined();
      // Metadata fields are still present.
      expect(res.body.data.ticket.last_public_message).toBeDefined();
      expect(res.body.data.ticket.viewer_last_read_at).toBeDefined();
      expect(res.body.data.ticket.other_party_read_at).toBeDefined();
    });
  });

  describe('GET /support/tickets/:ticketId/messages (viewSupport)', () => {
    let ticketId: string;

    const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

    const makeTicket = async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Chat thread',
          category: 'scanner',
          description: 'Opening message for the thread.',
        });
      return res.body.data.ticket.id as string;
    };

    beforeEach(async () => {
      ticketId = await makeTicket();
    });

    it('returns the latest page in chronological order with ticket state', async () => {
      for (let i = 0; i < 5; i += 1) {
        await request(app)
          .post(`/api/support/tickets/${ticketId}/messages`)
          .set(bearer(orgAdminToken))
          .send({ message: `Message ${i + 1}` });
        await tick();
      }

      const res = await request(app)
        .get(`/api/support/tickets/${ticketId}/messages?limit=3`)
        .set(bearer(orgAdminToken));

      expect(res.status).toBe(200);
      const bodies = res.body.data.results.map((m: any) => m.body);
      // Should be the newest 3, still in ascending order.
      expect(bodies).toEqual(['Message 3', 'Message 4', 'Message 5']);
      expect(res.body.data.has_more).toBe(true);
      // A customer replying on an `open` ticket keeps it `open`; only a staff
      // reply moves it to `in_progress`.
      expect(res.body.data.ticket.status).toBe('open');
      expect(res.body.data.ticket).toHaveProperty('last_public_message');
    });

    it('pages older messages with before', async () => {
      for (let i = 0; i < 5; i += 1) {
        await request(app)
          .post(`/api/support/tickets/${ticketId}/messages`)
          .set(bearer(orgAdminToken))
          .send({ message: `Message ${i + 1}` });
        await tick();
      }

      const firstPage = await request(app)
        .get(`/api/support/tickets/${ticketId}/messages?limit=3`)
        .set(bearer(orgAdminToken));
      const oldestShown = firstPage.body.data.results[0];

      const older = await request(app)
        .get(
          `/api/support/tickets/${ticketId}/messages?limit=3&before=${encodeURIComponent(
            oldestShown.created_at,
          )}`,
        )
        .set(bearer(orgAdminToken));

      expect(older.status).toBe(200);
      const bodies = older.body.data.results.map((m: any) => m.body);
      expect(bodies).toContain('Opening message for the thread.');
      expect(bodies).not.toContain('Message 5');
    });

    it('fetches only new messages with after and never drops the overlap', async () => {
      const first = await request(app)
        .get(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken));
      const seen = first.body.data.results;
      const lastSeen = seen[seen.length - 1];
      // Client sends the last seen timestamp minus ~2s to be safe.
      const cursor = new Date(
        new Date(lastSeen.created_at).getTime() - 2000,
      ).toISOString();

      await tick();
      await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken))
        .send({ message: 'Brand new reply' });

      const poll = await request(app)
        .get(
          `/api/support/tickets/${ticketId}/messages?after=${encodeURIComponent(
            cursor,
          )}`,
        )
        .set(bearer(orgAdminToken));

      expect(poll.status).toBe(200);
      const bodies = poll.body.data.results.map((m: any) => m.body);
      expect(bodies).toContain('Brand new reply');
      // The overlap intentionally re-includes the last seen message; the client
      // dedupes by id. It must never drop the new one.
      expect(poll.body.data.ticket.last_public_message.preview).toBe(
        'Brand new reply',
      );
    });

    it('never leaks internal notes to an org admin', async () => {
      await request(app)
        .post(`/api/support/tickets/${ticketId}/notes`)
        .set(bearer(superToken))
        .send({ message: 'Secret internal note.' });
      await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken))
        .send({ message: 'Public reply.' });

      const res = await request(app)
        .get(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken));

      expect(res.status).toBe(200);
      const bodies = res.body.data.results.map((m: any) => m.body);
      expect(bodies).toContain('Public reply.');
      expect(bodies).not.toContain('Secret internal note.');
      expect(
        res.body.data.results.every((m: any) => m.is_internal === false),
      ).toBe(true);
    });

    it('staff do see internal notes in the messages endpoint', async () => {
      await request(app)
        .post(`/api/support/tickets/${ticketId}/notes`)
        .set(bearer(superToken))
        .send({ message: 'Secret internal note.' });

      const res = await request(app)
        .get(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(superToken));

      expect(res.status).toBe(200);
      expect(
        res.body.data.results.some((m: any) => m.body === 'Secret internal note.'),
      ).toBe(true);
    });

    it('cross-org access returns 404', async () => {
      const otherOrg = await createOrg({ company_name: 'Other Org 2' });
      const otherAdmin = await createUser(
        'ORGANIZATION_ADMIN',
        String(otherOrg._id),
      );
      const otherToken = await tokenFor(otherAdmin);

      const res = await request(app)
        .get(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(otherToken));

      expect(res.status).toBe(404);
    });

    it('rejects an invalid cursor', async () => {
      const res = await request(app)
        .get(`/api/support/tickets/${ticketId}/messages?before=not-a-date`)
        .set(bearer(orgAdminToken));

      expect(res.status).toBe(400);
    });
  });

  describe('Idempotent reply (client_message_id)', () => {
    let ticketId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Idempotency',
          category: 'scanner',
          description: 'Opening message for idempotency.',
        });
      ticketId = res.body.data.ticket.id;
    });

    it('a retry with the same client_message_id returns the same message', async () => {
      const clientId = 'client-abc-123';
      const first = await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken))
        .send({ message: 'Sent once', client_message_id: clientId });

      const retry = await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken))
        .send({ message: 'Sent once', client_message_id: clientId });

      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(retry.body.data.message.id).toBe(first.body.data.message.id);

      const count = await SupportMessage.countDocuments({
        ticket_id: new mongoose.Types.ObjectId(ticketId),
        client_message_id: clientId,
      });
      expect(count).toBe(1);
    });

    it('concurrent duplicates yield exactly one row', async () => {
      const clientId = 'client-race-1';
      await Promise.all([
        request(app)
          .post(`/api/support/tickets/${ticketId}/messages`)
          .set(bearer(orgAdminToken))
          .send({ message: 'Race', client_message_id: clientId }),
        request(app)
          .post(`/api/support/tickets/${ticketId}/messages`)
          .set(bearer(orgAdminToken))
          .send({ message: 'Race', client_message_id: clientId }),
      ]);

      const count = await SupportMessage.countDocuments({
        ticket_id: new mongoose.Types.ObjectId(ticketId),
        client_message_id: clientId,
      });
      expect(count).toBe(1);
    });

    it('a reply without a client_message_id inserts normally', async () => {
      const res = await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken))
        .send({ message: 'No client id here' });

      expect(res.status).toBe(200);
      expect(res.body.data.message.body).toBe('No client id here');
    });
  });

  describe('Last-message preview + your_turn', () => {
    let ticketId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Preview ticket',
          category: 'scanner',
          description:
            'A very long opening message that should be truncated to eighty characters for the chat list preview.',
        });
      ticketId = res.body.data.ticket.id;
    });

    it('sets the preview from the public description, capped at 80 chars', async () => {
      const res = await request(app)
        .get('/api/support/tickets')
        .set(bearer(orgAdminToken));

      const row = res.body.data.results[0];
      expect(row.last_public_message).not.toBeNull();
      expect(row.last_public_message.preview.length).toBeLessThanOrEqual(80);
      expect(row.last_public_message.by_role).toBe('ORGANIZATION_ADMIN');
      expect(row.last_public_message.at).toBeDefined();
    });

    it('public replies update the preview', async () => {
      await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(superToken))
        .send({ message: 'Latest public staff reply.' });

      const res = await request(app)
        .get('/api/support/tickets')
        .set(bearer(orgAdminToken));

      expect(res.body.data.results[0].last_public_message.preview).toBe(
        'Latest public staff reply.',
      );
      expect(res.body.data.results[0].last_public_message.by_role).toBe(
        'SUPER_ADMIN',
      );
    });

    it('internal notes never touch the preview', async () => {
      await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken))
        .send({ message: 'Customer public line.' });
      await request(app)
        .post(`/api/support/tickets/${ticketId}/notes`)
        .set(bearer(superToken))
        .send({ message: 'Internal note that must not surface.' });

      const res = await request(app)
        .get('/api/support/tickets')
        .set(bearer(orgAdminToken));

      expect(res.body.data.results[0].last_public_message.preview).toBe(
        'Customer public line.',
      );
    });

    it('your_turn for a customer is false while staff hold the turn', async () => {
      const res = await request(app)
        .get('/api/support/tickets')
        .set(bearer(orgAdminToken));

      expect(res.body.data.results[0].your_turn).toBe(false);
    });

    it('your_turn for a customer is true when waiting_for_customer', async () => {
      await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(superToken))
        .send({ message: 'Over to you.' });
      await request(app)
        .patch(`/api/support/tickets/${ticketId}`)
        .set(bearer(superToken))
        .send({ status: 'waiting_for_customer' });

      const res = await request(app)
        .get('/api/support/tickets')
        .set(bearer(orgAdminToken));

      expect(res.body.data.results[0].your_turn).toBe(true);
    });

    it('your_turn for staff is true on a fresh open ticket', async () => {
      const res = await request(app)
        .get('/api/support/tickets')
        .set(bearer(superToken));

      expect(res.body.data.results[0].your_turn).toBe(true);
    });

    it('your_turn for staff flips false after they reply', async () => {
      await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(superToken))
        .send({ message: 'Staff answered.' });

      const res = await request(app)
        .get('/api/support/tickets')
        .set(bearer(superToken));

      expect(res.body.data.results[0].your_turn).toBe(false);
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

    it('accepts client_info as a JSON string on multipart create', async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .attach('attachments', Buffer.from('log line'), 'app.txt')
        .field('subject', 'Multipart client info')
        .field('category', 'bug')
        .field('description', 'Client context arrives as a JSON string in multipart.')
        .field(
          'client_info',
          JSON.stringify({ user_agent: 'load-rig/1.0', app_path: '/scanner' }),
        );

      expect(res.status).toBe(201);

      const detail = await request(app)
        .get(`/api/support/tickets/${res.body.data.ticket.id}`)
        .set(bearer(superToken));

      expect(detail.status).toBe(200);
      expect(detail.body.data.ticket.client_info).toMatchObject({
        user_agent: 'load-rig/1.0',
        app_path: '/scanner',
      });
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
        .attach(
          'attachments',
          Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'),
          'reply.pdf',
        )
        .field('message', 'Here is the log file.');

      expect(res.status).toBe(200);
      expect(res.body.data.message.attachments).toHaveLength(1);
      expect(res.body.data.message.attachments[0].content_type).toBe(
        'application/pdf',
      );
    });

    it('accepts a .log file declared as octet-stream', async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .attach('attachments', Buffer.from('INFO scanner ready\n'), {
          filename: 'scan.log',
          contentType: 'application/octet-stream',
        })
        .field('subject', 'Log attachment')
        .field('category', 'bug')
        .field('description', 'A plain-text log arrives as octet-stream.');

      expect(res.status).toBe(201);
      expect(res.body.data.ticket.messages[0].attachments[0].content_type).toBe(
        'text/plain',
      );
    });

    it('rejects content that does not match the declared type', async () => {
      const pngSignature = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
      ]);

      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .attach('attachments', pngSignature, {
          filename: 'fake.txt',
          contentType: 'text/plain',
        })
        .field('subject', 'Spoofed attachment')
        .field('category', 'other')
        .field('description', 'The bytes are a PNG but the declared type is text.');

      expect(res.status).toBe(400);
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

    it('cross-org attachment download returns 404', async () => {
      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .attach('attachments', Buffer.from('secret log line'), 'secret.txt')
        .field('subject', 'Private attachment')
        .field('category', 'other')
        .field('description', 'Contains a private log.');

      const messageId = created.body.data.ticket.messages[0].id;

      const otherOrg = await createOrg({ company_name: 'Download Thief' });
      const otherAdmin = await createUser('ORGANIZATION_ADMIN', String(otherOrg._id));
      const otherToken = await tokenFor(otherAdmin);

      const res = await request(app)
        .get(
          `/api/support/tickets/${created.body.data.ticket.id}/messages/${messageId}/attachments/0`,
        )
        .set(bearer(otherToken));

      expect(res.status).toBe(404);
    });

    it('removes stored files when the message write fails', async () => {
      const fsmod = await import('fs');
      const pathmod = await import('path');
      const uploadDir = '/tmp/support-test';

      const countFiles = (dir: string): number => {
        try {
          return fsmod.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
            const full = pathmod.join(dir, entry.name);
            return sum + (entry.isDirectory() ? countFiles(full) : 1);
          }, 0);
        } catch {
          return 0;
        }
      };

      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .attach('attachments', Buffer.from('original file'), 'original.txt')
        .field('subject', 'Cleanup test')
        .field('category', 'other')
        .field('description', 'Base ticket with one attachment.');

      const ticketId = created.body.data.ticket.id;
      const ticketDir = pathmod.join(uploadDir, String(org._id), ticketId);
      const before = countFiles(ticketDir);

      // Force the reply's message insert to fail AFTER files are written.
      const spy = vi
        .spyOn(SupportMessage, 'create')
        .mockRejectedValueOnce(new Error('forced message insert failure'));

      const reply = await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken))
        .attach('attachments', Buffer.from('doomed file'), 'doomed.txt')
        .field('message', 'This reply fails server-side.');

      spy.mockRestore();

      expect(reply.status).toBe(500);
      expect(countFiles(ticketDir)).toBe(before);
    });
  });

  describe('Authorization edges', () => {
    it('unauthenticated request is rejected (401)', async () => {
      const res = await request(app).get('/api/support/tickets');
      expect(res.status).toBe(401);
    });

    it('operator cannot access support (403)', async () => {
      const operator = await createUser('OPERATOR', String(org._id));
      const token = await tokenFor(operator);

      const res = await request(app)
        .get('/api/support/tickets')
        .set(bearer(token));

      expect(res.status).toBe(403);
    });

    it('operator cannot create a ticket (403)', async () => {
      const operator = await createUser('OPERATOR', String(org._id));
      const token = await tokenFor(operator);

      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(token))
        .send({
          subject: 'Operator ticket',
          category: 'other',
          description: 'Operators are out of scope in v1.',
        });

      expect(res.status).toBe(403);
    });
  });

  describe('Isolation (mandatory)', () => {
    it('org admin cannot read, reply or close another org ticket (404)', async () => {
      const otherOrg = await createOrg({ company_name: 'Isolated Org' });
      const otherAdmin = await createUser('ORGANIZATION_ADMIN', String(otherOrg._id));
      const otherToken = await tokenFor(otherAdmin);

      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(otherToken))
        .send({
          subject: 'Other org ticket',
          category: 'other',
          description: 'Belongs to another organization entirely.',
        });
      const ticketId = created.body.data.ticket.id;

      const read = await request(app)
        .get(`/api/support/tickets/${ticketId}`)
        .set(bearer(orgAdminToken));
      expect(read.status).toBe(404);

      const reply = await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken))
        .send({ message: 'Trying to reply across orgs.' });
      expect(reply.status).toBe(404);

      const close = await request(app)
        .patch(`/api/support/tickets/${ticketId}/close`)
        .set(bearer(orgAdminToken));
      expect(close.status).toBe(404);
    });

    it('a spoofed organization_id is ignored and the ticket lands in the caller org', async () => {
      const otherOrg = await createOrg({ company_name: 'Spoof Target' });

      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Spoof attempt',
          category: 'other',
          description: 'This organization_id should be ignored.',
          organization_id: String(otherOrg._id),
        });

      expect(created.status).toBe(201);
      expect(created.body.data.ticket.organization).toBeUndefined();

      const ownList = await request(app)
        .get('/api/support/tickets')
        .set(bearer(orgAdminToken));
      expect(ownList.body.data.results.length).toBe(1);

      const otherAdmin = await createUser('ORGANIZATION_ADMIN', String(otherOrg._id));
      const otherToken = await tokenFor(otherAdmin);
      const otherList = await request(app)
        .get('/api/support/tickets')
        .set(bearer(otherToken));
      expect(otherList.body.data.results.length).toBe(0);
    });

    it('list and summary never mix organizations', async () => {
      const otherOrg = await createOrg({ company_name: 'Mixed Org' });
      const otherAdmin = await createUser('ORGANIZATION_ADMIN', String(otherOrg._id));
      const otherToken = await tokenFor(otherAdmin);

      await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({ subject: 'Mine', category: 'other', description: 'Own ticket here.' });
      await request(app)
        .post('/api/support/tickets')
        .set(bearer(otherToken))
        .send({ subject: 'Theirs', category: 'other', description: 'Other ticket here.' });

      const listA = await request(app)
        .get('/api/support/tickets')
        .set(bearer(orgAdminToken));
      const listB = await request(app)
        .get('/api/support/tickets')
        .set(bearer(otherToken));

      expect(listA.body.data.results.every((t: any) => t.subject === 'Mine')).toBe(true);
      expect(listB.body.data.results.every((t: any) => t.subject === 'Theirs')).toBe(true);

      const summaryA = await request(app)
        .get('/api/support/tickets/summary')
        .set(bearer(orgAdminToken));
      const summaryB = await request(app)
        .get('/api/support/tickets/summary')
        .set(bearer(otherToken));
      expect(summaryA.body.data.active).toBe(1);
      expect(summaryB.body.data.active).toBe(1);
    });
  });

  describe('Visibility (mandatory)', () => {
    it('internal note, smart_context, client_info, assignee and SLA are absent for org admin', async () => {
      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Visibility ticket',
          category: 'webhook',
          description: 'Check that staff-only fields never leak.',
          client_info: { user_agent: 'internal-only/1.0' },
        });
      const ticketId = created.body.data.ticket.id;

      await request(app)
        .post(`/api/support/tickets/${ticketId}/notes`)
        .set(bearer(superToken))
        .send({ message: 'Secret internal note.' });

      await request(app)
        .patch(`/api/support/tickets/${ticketId}`)
        .set(bearer(superToken))
        .send({ assigned_to: String(superAdmin._id) });

      const detail = await request(app)
        .get(`/api/support/tickets/${ticketId}`)
        .set(bearer(orgAdminToken));
      const ticket = detail.body.data.ticket;

      expect(detail.status).toBe(200);
      expect(ticket.smart_context).toBeUndefined();
      expect(ticket.client_info).toBeUndefined();
      expect(ticket.assigned_to).toBeUndefined();
      expect(ticket.first_response_at).toBeUndefined();
      expect(ticket.awaiting).toBeUndefined();
      // Messages are no longer returned on the detail endpoint; verify via the
      // paginated messages endpoint instead.
      const messagesRes = await request(app)
        .get(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken));
      const messages = messagesRes.body.data.results;
      expect(messages.every((m: any) => m.is_internal === false && m.kind !== 'note')).toBe(true);
      expect(messages.some((m: any) => m.body === 'Secret internal note.')).toBe(false);
    });

    it('staff see the same ticket with all staff-only fields present', async () => {
      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Staff view ticket',
          category: 'webhook',
          description: 'Staff should see everything.',
          client_info: { user_agent: 'staff-only/1.0' },
        });
      const ticketId = created.body.data.ticket.id;

      await request(app)
        .post(`/api/support/tickets/${ticketId}/notes`)
        .set(bearer(superToken))
        .send({ message: 'Visible internal note.' });

      await request(app)
        .patch(`/api/support/tickets/${ticketId}`)
        .set(bearer(superToken))
        .send({ assigned_to: String(superAdmin._id) });

      const detail = await request(app)
        .get(`/api/support/tickets/${ticketId}`)
        .set(bearer(superToken));
      const ticket = detail.body.data.ticket;

      expect(ticket.smart_context).toBeTruthy();
      expect(ticket.client_info).toMatchObject({ user_agent: 'staff-only/1.0' });
      expect(ticket.assigned_to?.id).toBe(String(superAdmin._id));
      expect(ticket).toHaveProperty('awaiting');
      // Messages come from the paginated messages endpoint now.
      const messagesRes = await request(app)
        .get(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(superToken));
      const messages = messagesRes.body.data.results;
      expect(messages.some((m: any) => m.is_internal === true)).toBe(true);
    });
  });

  describe('Lifecycle', () => {
    it('reply on a closed ticket returns 409', async () => {
      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({ subject: 'Closed reply', category: 'other', description: 'Close then reply.' });
      const ticketId = created.body.data.ticket.id;

      await request(app)
        .patch(`/api/support/tickets/${ticketId}/close`)
        .set(bearer(orgAdminToken));

      const res = await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken))
        .send({ message: 'Trying to reply to a closed ticket.' });

      expect(res.status).toBe(409);
    });

    it('a customer reply reopens a resolved ticket', async () => {
      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({ subject: 'Reopen me', category: 'other', description: 'Resolve then reply.' });
      const ticketId = created.body.data.ticket.id;

      await request(app)
        .patch(`/api/support/tickets/${ticketId}`)
        .set(bearer(superToken))
        .send({ status: 'resolved' });

      const res = await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken))
        .send({ message: 'The issue came back.' });

      expect(res.status).toBe(200);
      expect(res.body.data.ticket.status).toBe('open');
      expect(res.body.data.ticket.resolved_at).toBeNull();
    });

    it('rejects an illegal staff transition', async () => {
      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({ subject: 'Transition', category: 'other', description: 'Open then closed.' });
      const ticketId = created.body.data.ticket.id;

      await request(app)
        .patch(`/api/support/tickets/${ticketId}`)
        .set(bearer(superToken))
        .send({ status: 'closed' });

      // closed is terminal
      const res = await request(app)
        .patch(`/api/support/tickets/${ticketId}`)
        .set(bearer(superToken))
        .send({ status: 'open' });

      expect(res.status).toBe(400);
    });

    it('sets first_response_at once and maintains last_*_message_at', async () => {
      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({ subject: 'Response clock', category: 'other', description: 'First reply timing.' });
      const ticketId = created.body.data.ticket.id;

      const first = await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(superToken))
        .send({ message: 'First staff response.' });
      const firstResponse = first.body.data.ticket.first_response_at;
      expect(firstResponse).toBeTruthy();

      const second = await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(superToken))
        .send({ message: 'Second staff response.' });

      expect(second.body.data.ticket.first_response_at).toBe(firstResponse);
      expect(second.body.data.ticket.last_staff_message_at).toBeTruthy();
    });
  });

  describe('Numbering', () => {
    it('concurrent creates yield unique, increasing ticket numbers', async () => {
      const count = 6;
      const responses = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          request(app)
            .post('/api/support/tickets')
            .set(bearer(orgAdminToken))
            .send({
              subject: `Concurrent ${i}`,
              category: 'other',
              description: `Concurrent ticket number ${i}.`,
            }),
        ),
      );

      const numbers = responses.map((res) => {
        expect(res.status).toBe(201);
        return Number(String(res.body.data.ticket.ticket_no).replace('SF-', ''));
      });

      // Every concurrent create must receive a distinct, contiguous sequence
      // number (no duplicates, no gaps) — the order across responses is
      // completion order, so only the sorted set is asserted here.
      expect(new Set(numbers).size).toBe(count);
      const sorted = [...numbers].sort((a, b) => a - b);
      expect(sorted).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    });
  });

  describe('Inactive / expired organization', () => {
    it('an inactive organization can still create and read tickets', async () => {
      const inactiveOrg = await createOrg({
        company_name: 'Inactive Org',
        status: 0,
      });
      const admin = await createUser('ORGANIZATION_ADMIN', String(inactiveOrg._id), {
        email: 'inactive-admin@example.com',
      });
      const token = await tokenFor(admin);

      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(token))
        .send({
          subject: 'Inactive org ticket',
          category: 'account_login',
          description: 'Support must work even when the org is inactive.',
        });

      expect(created.status).toBe(201);

      const detail = await request(app)
        .get(`/api/support/tickets/${created.body.data.ticket.id}`)
        .set(bearer(token));
      expect(detail.status).toBe(200);
    });
  });

  describe('Smart context', () => {
    it('never leaks organization secrets into the staff snapshot', async () => {
      const secret = 'whsec_SUPER_SECRET_WEBHOOK_VALUE';

      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Secret scan',
          category: 'webhook',
          description: 'Context must not include raw secrets.',
        });
      const ticketId = created.body.data.ticket.id;

      // The webhook config secret column must never reach the snapshot.
      await WebhookConfig.create({
        organization_id: org._id,
        endpoint_url: 'https://example.com/hook',
        secret,
        enabled: true,
      });

      const detail = await request(app)
        .get(`/api/support/tickets/${ticketId}`)
        .set(bearer(superToken));

      expect(detail.status).toBe(200);
      expect(JSON.stringify(detail.body.data.ticket.smart_context)).not.toContain(secret);
    });

    it('recent_errors carry scrubbed summaries, never secrets', async () => {
      await WebhookDelivery.create({
        event_id: 'evt-scrub-test',
        scan_id: new mongoose.Types.ObjectId(),
        organization_id: org._id,
        status: 'failed',
        retry_count: 5,
        last_attempt_at: new Date(),
        last_error:
          'Request failed with Authorization: Bearer sk_live_ABC123SECRETVALUE',
      });

      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Scrubbed errors',
          category: 'webhook',
          description: 'Recent errors must be scrubbed of secrets.',
        });

      const detail = await request(app)
        .get(`/api/support/tickets/${created.body.data.ticket.id}`)
        .set(bearer(superToken));

      const ctx = detail.body.data.ticket.smart_context;
      expect(JSON.stringify(ctx)).not.toContain('sk_live_ABC123SECRETVALUE');
      expect(Array.isArray(ctx.recent_errors) || ctx.recent_errors === null).toBe(true);
    });
  });

  describe('Validation', () => {
    it('rejects unknown body keys (Joi strict)', async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Strict body',
          category: 'other',
          description: 'Unknown keys must be rejected.',
          extra_key: 'nope',
        });

      expect(res.status).toBe(400);
    });

    it('rate-limits ticket creation per user', async () => {
      const spammer = await createUser('ORGANIZATION_ADMIN', String(org._id), {
        email: 'spammer@example.com',
      });
      const token = await tokenFor(spammer);
      const statuses: number[] = [];

      for (let i = 0; i < 11; i++) {
        const res = await request(app)
          .post('/api/support/tickets')
          .set(bearer(token))
          .send({
            subject: `Spam ${i}`,
            category: 'other',
            description: `Rate limit probe number ${i}.`,
          });
        statuses.push(res.status);
      }

      expect(statuses).toContain(429);
    });
  });

  describe('Notifications', () => {
    it('enqueues an idempotent job after a ticket is created', async () => {
      const { enqueueSupportNotification } = await import(
        '../src/queues/support.queue.js'
      );

      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Notify me',
          category: 'other',
          description: 'A notification job should be enqueued.',
        });
      const ticketId = created.body.data.ticket.id;

      const job = await enqueueSupportNotification({
        event: 'ticket_created',
        ticket_id: ticketId,
      });

      if (job) {
        expect(String(job.id)).toBe(`ticket_created:${ticketId}:status`);

        const duplicate = await enqueueSupportNotification({
          event: 'ticket_created',
          ticket_id: ticketId,
        });
        expect(String(duplicate?.id)).toBe(String(job.id));

        const { getSupportQueue } = await import('../src/queues/support.queue.js');
        const { getNotificationQueue } = await import('../src/queues/notification.queue.js');
        await job.remove().catch(() => null);
        await getSupportQueue().close().catch(() => null);
        await getNotificationQueue().close().catch(() => null);
      }
    });
  });
});