import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
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
import { Notification, Usage, Subscription, SupportTicket } from '../src/models/index.js';
import {
  createForUsers,
  listNotifications,
} from '../src/services/notification.service.js';
import { dispatchAppNotification } from '../src/queues/notification.queue.js';
import { runAutoCloseJob } from '../src/services/support.service.js';
import { checkQuotaAlerts } from '../src/services/quota.service.js';
import {
  checkSubscriptionReminders,
} from '../src/services/subscription-notification.service.js';
import { activateEligibleSubscriptions } from '../src/services/subscription.service.js';

vi.mock('../src/config/config.js', () => ({
  default: {
    NODE_ENV: 'test',
    PORT: 3000,
    mongoose: { url: process.env.MONGODB_URL! },
    jwt: {
      secret: 'test',
      accessExpirationMinutes: 30,
      refreshExpirationDays: 30,
      resetPasswordExpirationMinutes: 10,
      verifyEmailExpirationMinutes: 10,
    },
    email: {
      smtp: { host: 'localhost', port: 587, username: '', password: '' },
      from: 'test@test.com',
    },
    // Redis intentionally absent: support dispatch must still write the row.
    redis: { url: '' },
    panelUrl: 'http://localhost:7052',
    dashboard: { nearLimitPct: 80, alertCooldownMinutes: 60 },
    notification: {
      quotaThresholds: '80,90,100',
      subscriptionReminderDays: '7,1',
      readRetentionDays: 30,
      unreadRetentionDays: 90,
      unreadCountCap: 100,
      reminderIntervalMinutes: 15,
    },
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

const DAY = 86_400_000;

describe('notifications', () => {
  let superAdmin: any;
  let org: any;
  let orgAdmin: any;
  let superToken: string;
  let orgAdminToken: string;

  beforeAll(async () => {
    await connectDb();
    await clearDb();
    await Notification.syncIndexes();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  beforeEach(async () => {
    await clearDb();
    superAdmin = await createAdminUser();
    superToken = await tokenFor(superAdmin);
    org = await createOrg({ company_name: 'Notification Test Org' });
    orgAdmin = await createUser('ORGANIZATION_ADMIN', String(org._id));
    orgAdminToken = await tokenFor(orgAdmin);
  });

  const seed = async (
    userId: string,
    overrides: Record<string, any> = {},
  ): Promise<any> =>
    Notification.create({
      user_id: userId,
      type: 'system',
      severity: 'info',
      title: 'Seeded',
      message: 'Seeded notification',
      expires_at: new Date(Date.now() + 30 * DAY),
      is_read: false,
      ...overrides,
    });

  describe('API', () => {
    it('lists only the caller rows, newest first, without private fields', async () => {
      const older = await seed(String(superAdmin._id), { title: 'Older' });
      await Notification.updateOne(
        { _id: older._id },
        { $set: { created_at: new Date(Date.now() - DAY) } },
      );
      await seed(String(superAdmin._id), { title: 'Newer' });
      await seed(orgAdmin._id, { title: 'Other user' });

      const res = await request(app)
        .get('/api/notifications')
        .set(bearer(superToken))
        .expect(200);

      expect(res.body.data.total_results).toBe(2);
      expect(res.body.data.results.map((r: any) => r.title)).toEqual([
        'Newer',
        'Older',
      ]);
      expect(res.body.data.results[0].id).toBeTruthy();
      expect(res.body.data.results[0]).not.toHaveProperty('dedupe_key');
      expect(res.body.data.results[0]).not.toHaveProperty('expires_at');
      expect(res.body.data.results[0]).not.toHaveProperty('organization_id');
    });

    it('filters unread_only and caps the page size', async () => {
      await seed(String(superAdmin._id), { title: 'Unread' });
      await seed(String(superAdmin._id), { title: 'Read', is_read: true });

      const unread = await request(app)
        .get('/api/notifications?unread_only=true')
        .set(bearer(superToken))
        .expect(200);
      expect(unread.body.data.results.map((r: any) => r.title)).toEqual([
        'Unread',
      ]);

      await request(app)
        .get('/api/notifications?limit=51')
        .set(bearer(superToken))
        .expect(400);
    });

    it('returns 404 for another user notification and keeps read-all scoped', async () => {
      const other = await seed(orgAdmin._id, { title: 'Theirs' });
      await seed(String(superAdmin._id), { title: 'Mine' });

      await request(app)
        .patch(`/api/notifications/${String(other._id)}/read`)
        .set(bearer(superToken))
        .expect(404);

      const readAll = await request(app)
        .patch('/api/notifications/read-all')
        .set(bearer(superToken))
        .expect(200);
      expect(readAll.body.data.modified).toBe(1);

      const theirs = await Notification.findById(other._id).lean();
      expect(theirs?.is_read).toBe(false);
    });

    it('marks read idempotently and moves expiry to the read retention', async () => {
      const row = await seed(String(superAdmin._id));

      await request(app)
        .patch(`/api/notifications/${String(row._id)}/read`)
        .set(bearer(superToken))
        .expect(200);
      await request(app)
        .patch(`/api/notifications/${String(row._id)}/read`)
        .set(bearer(superToken))
        .expect(200);

      const updated = await Notification.findById(row._id).lean();
      expect(updated?.is_read).toBe(true);
      const days = (updated!.expires_at.getTime() - Date.now()) / DAY;
      expect(days).toBeGreaterThan(29);
      expect(days).toBeLessThan(31);
    });

    it('caps unread-count at 100 and reports capped', async () => {
      const docs = Array.from({ length: 105 }).map((_, index) => ({
        user_id: superAdmin._id,
        type: 'system',
        severity: 'info',
        title: `Row ${index}`,
        message: 'x',
        expires_at: new Date(Date.now() + 30 * DAY),
        is_read: false,
        dedupe_key: `cap:${index}`,
      }));
      await Notification.insertMany(docs);

      const res = await request(app)
        .get('/api/notifications/unread-count')
        .set(bearer(superToken))
        .expect(200);
      expect(res.body.data).toEqual({ count: 100, capped: true });
    });

    it('rejects spoofed user_id / organization_id query parameters', async () => {
      await request(app)
        .get(`/api/notifications?user_id=${String(orgAdmin._id)}`)
        .set(bearer(superToken))
        .expect(400);

      await request(app)
        .get(`/api/notifications?organization_id=${String(org._id)}`)
        .set(bearer(superToken))
        .expect(400);
    });

    it('moves the unread count after read and read-all', async () => {
      const first = await seed(String(superAdmin._id), { title: 'First' });
      await seed(String(superAdmin._id), { title: 'Second' });

      const before = await request(app)
        .get('/api/notifications/unread-count')
        .set(bearer(superToken))
        .expect(200);
      expect(before.body.data.count).toBe(2);

      await request(app)
        .patch(`/api/notifications/${String(first._id)}/read`)
        .set(bearer(superToken))
        .expect(200);

      const afterOne = await request(app)
        .get('/api/notifications/unread-count')
        .set(bearer(superToken))
        .expect(200);
      expect(afterOne.body.data.count).toBe(1);

      await request(app)
        .patch('/api/notifications/read-all')
        .set(bearer(superToken))
        .expect(200);

      const afterAll = await request(app)
        .get('/api/notifications/unread-count')
        .set(bearer(superToken))
        .expect(200);
      expect(afterAll.body.data.count).toBe(0);
    });
  });

  describe('service', () => {
    it('truncates over-long title/message instead of throwing', async () => {
      const [created] = await createForUsers({
        user_ids: [String(superAdmin._id)],
        type: 'system',
        severity: 'info',
        title: 'T'.repeat(150),
        message: 'M'.repeat(700),
        dedupe_key: 'truncate:1',
      });

      expect(created.title.length).toBe(100);
      expect(created.message.length).toBe(500);
    });

    it('drops unsafe action_url values and keeps internal paths', async () => {
      const [safe] = await createForUsers({
        user_ids: [String(superAdmin._id)],
        type: 'system',
        severity: 'info',
        title: 'safe',
        message: 'safe',
        action_url: '/support/123',
        dedupe_key: 'url:safe',
      });
      expect(safe.action_url).toBe('/support/123');

      const [unsafe] = await createForUsers({
        user_ids: [String(superAdmin._id)],
        type: 'system',
        severity: 'info',
        title: 'unsafe',
        message: 'unsafe',
        action_url: 'http://evil.test/x',
        dedupe_key: 'url:unsafe',
      });
      expect(unsafe.action_url).toBeNull();
    });

    it('drops every unsafe action_url variant', async () => {
      const variants = [
        '//evil.test/x',
        'javascript:alert(1)',
        'http://evil.test',
        '\\\\evil',
        '/path with space',
        '/path\twith-tab',
      ];

      for (const [index, action_url] of variants.entries()) {
        const [created] = await createForUsers({
          user_ids: [String(superAdmin._id)],
          type: 'system',
          severity: 'info',
          title: `unsafe-${index}`,
          message: 'unsafe',
          action_url,
          dedupe_key: `url:unsafe:${index}`,
        });
        expect(created.action_url).toBeNull();
      }
    });

    it('allows a null organization and still hides private fields from JSON', async () => {
      const [created] = await createForUsers({
        user_ids: [String(superAdmin._id)],
        type: 'system',
        severity: 'info',
        title: 'No org',
        message: 'Super admin has no organization',
        dedupe_key: 'org:null',
      });

      const json = created.toJSON();
      expect(json.organization_id).toBeUndefined();
      expect(json.dedupe_key).toBeUndefined();
      expect(json.expires_at).toBeUndefined();
      expect(json.id).toBeTruthy();
    });

    it('concurrent upserts leave exactly one unread row', async () => {
      const inputs = {
        user_ids: [String(superAdmin._id)],
        type: 'support_ticket' as const,
        severity: 'info' as const,
        title: 'Concurrent',
        message: 'Concurrent upsert',
        dedupe_key: 'concurrent:1',
      };

      await Promise.all([createForUsers(inputs), createForUsers(inputs)]);

      expect(
        await Notification.countDocuments({
          user_id: superAdmin._id,
          is_read: false,
          dedupe_key: 'concurrent:1',
        }),
      ).toBe(1);
    });

    it('declares the plan indexes, including the partial unique and TTL', async () => {
      const indexes = await Notification.collection.indexes();
      const byKeys = (keys: Record<string, number>) =>
        indexes.find(
          (index) =>
            JSON.stringify(index.key) === JSON.stringify(keys),
        );

      expect(byKeys({ user_id: 1, is_read: 1, created_at: -1 })).toBeTruthy();
      expect(byKeys({ user_id: 1, created_at: -1 })).toBeTruthy();

      const dedupe = byKeys({ user_id: 1, dedupe_key: 1 });
      expect(dedupe?.unique).toBe(true);
      expect(dedupe?.partialFilterExpression).toMatchObject({
        is_read: false,
        dedupe_key: { $type: 'string' },
      });

      const ttl = byKeys({ expires_at: 1 });
      expect(ttl?.expireAfterSeconds).toBe(0);

      const explain = await Notification.find({
        user_id: superAdmin._id,
        is_read: false,
      })
        .sort({ created_at: -1 })
        .explain('queryPlanner');
      expect(JSON.stringify(explain)).toContain(
        'user_id_1_is_read_1_created_at_-1',
      );
    });

    it('coalesces unread rows and bumps created_at; a read row does not block a new one', async () => {
      const first = await createForUsers({
        user_ids: [String(superAdmin._id)],
        type: 'support_ticket',
        severity: 'info',
        title: 'Reply 1',
        message: 'one',
        dedupe_key: 'support:ticket-1',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await createForUsers({
        user_ids: [String(superAdmin._id)],
        type: 'support_ticket',
        severity: 'info',
        title: 'Reply 2',
        message: 'two',
        dedupe_key: 'support:ticket-1',
      });

      expect(await Notification.countDocuments({ is_read: false })).toBe(1);
      expect(String(second[0]._id)).toBe(String(first[0]._id));
      expect(second[0].title).toBe('Reply 2');
      expect(second[0].created_at.getTime()).toBeGreaterThan(
        first[0].created_at.getTime(),
      );

      await Notification.updateOne(
        { _id: first[0]._id },
        { $set: { is_read: true } },
      );
      const third = await createForUsers({
        user_ids: [String(superAdmin._id)],
        type: 'support_ticket',
        severity: 'info',
        title: 'Reply 3',
        message: 'three',
        dedupe_key: 'support:ticket-1',
      });
      expect(String(third[0]._id)).not.toBe(String(first[0]._id));
      expect(await Notification.countDocuments({})).toBe(2);
    });

    it('exposes the shared pagination envelope', async () => {
      await seed(String(superAdmin._id));
      const result = await listNotifications(
        { user_id: superAdmin._id },
        { page: 1, limit: 20 },
      );
      expect(result.data).toMatchObject({
        page: 1,
        limit: 20,
        total_pages: 1,
        total_results: 1,
      });
    });
  });

  describe('producers', () => {
    it('creates a support notification for a new ticket even without Redis', async () => {
      const res = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Notification producer test',
          category: 'bug',
          description: 'Checking that the producer writes an in-app row.',
        })
        .expect(201);

      const row = await Notification.findOne({
        user_id: superAdmin._id,
        type: 'support_ticket',
      }).lean();
      expect(row).toBeTruthy();
      expect(row?.dedupe_key).toBe(`support:${res.body.data.ticket.id}`);
    });

    it('notifies every active super admin and skips inactive ones', async () => {
      const secondAdmin = await createAdminUser({
        email: `second-super-${Date.now()}@example.com`,
      });
      const inactiveAdmin = await createAdminUser({
        email: `inactive-super-${Date.now()}@example.com`,
        status: 0,
      });

      await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Recipient fan-out',
          category: 'bug',
          description: 'All active super admins should be notified.',
        })
        .expect(201);

      const rows = await Notification.find({ type: 'support_ticket' }).lean();
      const recipients = rows.map((row: any) => String(row.user_id));
      expect(recipients).toContain(String(superAdmin._id));
      expect(recipients).toContain(String(secondAdmin._id));
      expect(recipients).not.toContain(String(inactiveAdmin._id));
    });

    it('sends customer replies to the active assignee, not every super admin', async () => {
      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Assigned ticket',
          category: 'bug',
          description: 'Assignment routing check.',
        })
        .expect(201);

      const ticketId = created.body.data.ticket.id;
      const assignee = await createAdminUser({
        email: `assignee-${Date.now()}@example.com`,
      });

      await request(app)
        .patch(`/api/support/tickets/${ticketId}`)
        .set(bearer(superToken))
        .send({ assigned_to: String(assignee._id) })
        .expect(200);

      await Notification.deleteMany({});

      await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(orgAdminToken))
        .send({ message: 'Customer follow-up for the assignee.' })
        .expect(200);

      const rows = await Notification.find({ type: 'support_ticket' }).lean();
      expect(rows).toHaveLength(1);
      expect(String(rows[0].user_id)).toBe(String(assignee._id));
      expect(rows[0].title).toMatch(/^New reply on /);
    });

    it('notifies the ticket creator when staff replies', async () => {
      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Staff reply target',
          category: 'bug',
          description: 'The creator should get the reply notice.',
        })
        .expect(201);

      const ticketId = created.body.data.ticket.id;
      await Notification.deleteMany({});

      await request(app)
        .post(`/api/support/tickets/${ticketId}/messages`)
        .set(bearer(superToken))
        .send({ message: 'We are looking into this now.' })
        .expect(200);

      const row = await Notification.findOne({
        user_id: orgAdmin._id,
        type: 'support_ticket',
      }).lean();
      expect(row?.title).toBe('ScanFlow Support replied');
      expect(row?.dedupe_key).toBe(`support:${ticketId}`);
    });

    it('notifies the creator with a status-specific dedupe key', async () => {
      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Resolve me',
          category: 'bug',
          description: 'Status change notification check.',
        })
        .expect(201);

      const ticketId = created.body.data.ticket.id;
      await Notification.deleteMany({});

      await request(app)
        .patch(`/api/support/tickets/${ticketId}`)
        .set(bearer(superToken))
        .send({ status: 'resolved' })
        .expect(200);

      const row = await Notification.findOne({
        user_id: orgAdmin._id,
        type: 'support_ticket',
      }).lean();
      expect(row?.title).toMatch(/resolved$/);
      expect(row?.dedupe_key).toBe(`support:${ticketId}:status:resolved`);
    });

    it('creates nothing for internal notes or auto-close housekeeping', async () => {
      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Internal only',
          category: 'bug',
          description: 'Internal notes must not notify the customer.',
        })
        .expect(201);

      const ticketId = created.body.data.ticket.id;
      await Notification.deleteMany({});

      await request(app)
        .post(`/api/support/tickets/${ticketId}/notes`)
        .set(bearer(superToken))
        .send({ message: 'Internal triage note.' })
        .expect(200);

      expect(await Notification.countDocuments({})).toBe(0);

      await SupportTicket.updateOne(
        { _id: ticketId },
        {
          $set: {
            status: 'resolved',
            resolved_at: new Date(Date.now() - 8 * DAY),
          },
        },
      );
      await runAutoCloseJob();

      expect(await Notification.countDocuments({})).toBe(0);
    });

    it('coalesces ten replies into one unread row', async () => {
      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Chatty ticket',
          category: 'bug',
          description: 'Ten quick replies must not flood the bell.',
        })
        .expect(201);

      const ticketId = created.body.data.ticket.id;
      await Notification.deleteMany({});

      for (let index = 1; index <= 10; index += 1) {
        await request(app)
          .post(`/api/support/tickets/${ticketId}/messages`)
          .set(bearer(orgAdminToken))
          .send({ message: `Follow-up ${index}` })
          .expect(200);
      }

      const rows = await Notification.find({
        user_id: superAdmin._id,
        type: 'support_ticket',
        is_read: false,
      }).lean();
      expect(rows).toHaveLength(1);
      expect(rows[0].dedupe_key).toBe(`support:${ticketId}`);
    });

    it('is idempotent when a support job is retried', async () => {
      const created = await request(app)
        .post('/api/support/tickets')
        .set(bearer(orgAdminToken))
        .send({
          subject: 'Retry me',
          category: 'bug',
          description: 'A retried job must not duplicate the row.',
        })
        .expect(201);

      const ticketId = created.body.data.ticket.id;
      await Notification.deleteMany({});

      const job = {
        source: 'support' as const,
        event: 'ticket_created' as const,
        ticket_id: ticketId,
      };
      await dispatchAppNotification(job);
      await dispatchAppNotification(job);

      expect(
        await Notification.countDocuments({
          user_id: superAdmin._id,
          type: 'support_ticket',
          is_read: false,
        }),
      ).toBe(1);
    });

    it('sends one quota alert per level and skips unlimited plans', async () => {
      const plan = await createPlan({ scan_limit: 100 });
      await grant(String(org._id), String(plan._id));
      await Notification.deleteMany({});

      await Usage.updateOne(
        { organization_id: org._id },
        { $set: { usage: 85, scan_limit: 100, quota_alert_level: 0 } },
      );

      await checkQuotaAlerts();
      await checkQuotaAlerts();

      const rows = await Notification.find({
        user_id: orgAdmin._id,
        type: 'quota_alert',
      }).lean();
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('80% of your scan limit used');

      await Usage.updateOne(
        { organization_id: org._id },
        { $set: { usage: 100 } },
      );
      await checkQuotaAlerts();

      const afterJump = await Notification.find({
        user_id: orgAdmin._id,
        type: 'quota_alert',
      }).lean();
      expect(afterJump).toHaveLength(2);
      expect(afterJump.some((row: any) => row.severity === 'critical')).toBe(
        true,
      );
    });

    it('sends nothing below 80 and exactly one alert per level, even with stale usage expiry', async () => {
      const plan = await createPlan({ scan_limit: 100 });
      await grant(String(org._id), String(plan._id));
      await Notification.deleteMany({});

      const usage = await Usage.findOne({ organization_id: org._id });
      expect(usage).toBeTruthy();

      const setUsage = (value: number) =>
        Usage.updateOne(
          { _id: usage!._id },
          {
            $set: {
              usage: value,
              scan_limit: 100,
              quota_alert_level: 0,
              expires_at: new Date(Date.now() - DAY),
            },
          },
        );

      const quotaRows = () =>
        Notification.find({
          user_id: orgAdmin._id,
          type: 'quota_alert',
        }).lean();

      await setUsage(79);
      await checkQuotaAlerts();
      expect(await quotaRows()).toHaveLength(0);

      await Usage.updateOne(
        { _id: usage!._id },
        { $set: { usage: 80, expires_at: new Date(Date.now() - DAY) } },
      );
      await checkQuotaAlerts();
      await checkQuotaAlerts();
      expect(await quotaRows()).toHaveLength(1);

      await Usage.updateOne(
        { _id: usage!._id },
        { $set: { usage: 89 } },
      );
      await checkQuotaAlerts();
      expect(await quotaRows()).toHaveLength(1);

      await Usage.updateOne(
        { _id: usage!._id },
        { $set: { usage: 90 } },
      );
      await checkQuotaAlerts();
      expect(await quotaRows()).toHaveLength(2);

      await Usage.updateOne(
        { _id: usage!._id },
        { $set: { usage: 100 } },
      );
      await checkQuotaAlerts();
      await checkQuotaAlerts();

      const rows = await quotaRows();
      expect(rows).toHaveLength(3);
      expect(rows.map((row: any) => row.title)).toEqual(
        expect.arrayContaining([
          '80% of your scan limit used',
          '90% of your scan limit used',
          'Scan limit reached',
        ]),
      );
    });

    it('never alerts for an unlimited plan', async () => {
      const plan = await createPlan({ scan_limit: 0 });
      await grant(String(org._id), String(plan._id));
      await Notification.deleteMany({});

      const usage = await Usage.findOne({ organization_id: org._id });
      await Usage.updateOne(
        { _id: usage!._id },
        {
          $set: {
            usage: 5000,
            scan_limit: 0,
            quota_alert_level: 0,
          },
        },
      );

      await checkQuotaAlerts();

      expect(
        await Notification.countDocuments({
          user_id: orgAdmin._id,
          type: 'quota_alert',
        }),
      ).toBe(0);
    });

    it('creates one notification when two workers run at the same time', async () => {
      const plan = await createPlan({ scan_limit: 100 });
      await grant(String(org._id), String(plan._id));
      await Notification.deleteMany({});

      const usage = await Usage.findOne({ organization_id: org._id });
      await Usage.updateOne(
        { _id: usage!._id },
        {
          $set: {
            usage: 85,
            scan_limit: 100,
            quota_alert_level: 0,
          },
        },
      );

      await Promise.all([checkQuotaAlerts(), checkQuotaAlerts()]);

      expect(
        await Notification.countDocuments({
          user_id: orgAdmin._id,
          type: 'quota_alert',
          is_read: false,
        }),
      ).toBe(1);
    });

    it('restarts the levels for a new subscription period', async () => {
      const firstPlan = await createPlan({ scan_limit: 100 });
      const first = await grant(String(org._id), String(firstPlan._id));
      await Notification.deleteMany({});

      const firstUsage = await Usage.findOne({
        subscription_id: first._id,
      });
      await Usage.updateOne(
        { _id: firstUsage!._id },
        { $set: { usage: 100, scan_limit: 100, quota_alert_level: 0 } },
      );
      await checkQuotaAlerts();
      expect(
        await Notification.countDocuments({
          user_id: orgAdmin._id,
          type: 'quota_alert',
        }),
      ).toBe(1);

      const secondPlan = await createPlan({
        name: 'Second period',
        scan_limit: 200,
      });
      const second = await grant(String(org._id), String(secondPlan._id), {
        forceActive: true,
      });
      await Notification.deleteMany({});

      const secondUsage = await Usage.findOne({
        subscription_id: second._id,
      });
      expect(secondUsage).toBeTruthy();
      await Usage.updateOne(
        { _id: secondUsage!._id },
        { $set: { usage: 170, scan_limit: 200, quota_alert_level: 0 } },
      );

      await checkQuotaAlerts();

      const rows = await Notification.find({
        user_id: orgAdmin._id,
        type: 'quota_alert',
      }).lean();
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('80% of your scan limit used');
    });

    it('sends 7-day and 1-day reminders once each and skips short trials', async () => {
      const plan = await createPlan({ scan_limit: 1000 });
      const sub = await grant(String(org._id), String(plan._id));
      await Notification.deleteMany({});

      const sixDays = new Date(Date.now() + 6 * DAY);
      await Subscription.updateOne(
        { _id: sub._id },
        {
          $set: {
            started_at: new Date(Date.now() - 24 * DAY),
            expires_at: sixDays,
            app_reminders_sent: [],
          },
        },
      );

      expect(await checkSubscriptionReminders()).toBe(1);
      expect(await checkSubscriptionReminders()).toBe(0);

      const reminders = await Notification.find({
        user_id: orgAdmin._id,
        type: 'subscription',
      }).lean();
      expect(reminders).toHaveLength(1);
      expect(reminders[0].title).toBe('Your plan expires in 7 days');

      // Short trial: 2 days left on a 3-day subscription must not claim 7 days.
      await Notification.deleteMany({});
      await Subscription.updateOne(
        { _id: sub._id },
        {
          $set: {
            started_at: new Date(Date.now() - 1 * DAY),
            expires_at: new Date(Date.now() + 2 * DAY),
            app_reminders_sent: [],
          },
        },
      );
      expect(await checkSubscriptionReminders()).toBe(0);
    });

    it('sends the 1-day reminder independently of the email reminders_sent array', async () => {
      const plan = await createPlan({ scan_limit: 1000 });
      const sub = await grant(String(org._id), String(plan._id));
      await Notification.deleteMany({});

      await Subscription.updateOne(
        { _id: sub._id },
        {
          $set: {
            started_at: new Date(Date.now() - 29 * DAY),
            expires_at: new Date(Date.now() + 0.5 * DAY),
            app_reminders_sent: [],
            // The email cron already claimed its 7-day window.
            reminders_sent: [7],
          },
        },
      );

      expect(await checkSubscriptionReminders()).toBe(1);
      expect(await checkSubscriptionReminders()).toBe(0);

      const row = await Notification.findOne({
        user_id: orgAdmin._id,
        type: 'subscription',
      }).lean();
      expect(row?.title).toBe('Your plan expires tomorrow');
      expect(row?.dedupe_key).toMatch(/:reminder:1$/);
      expect(row?.severity).toBe('info');
    });

    it('uses queued-plan wording when a successor is scheduled', async () => {
      const plan = await createPlan({ scan_limit: 1000 });
      const sub = await grant(String(org._id), String(plan._id));

      await Subscription.create({
        organization_id: org._id,
        plan_id: plan._id,
        payment_id: (sub as any).payment_id,
        features: [],
        billing_cycle: 'month',
        status: 'future',
        started_at: new Date(Date.now() + 6 * DAY),
        expires_at: new Date(Date.now() + 36 * DAY),
        queue_priority: 1,
        reminders_sent: [],
        app_reminders_sent: [],
        plan_name: 'Next Plan',
      });

      await Subscription.updateOne(
        { _id: sub._id },
        {
          $set: {
            started_at: new Date(Date.now() - 24 * DAY),
            expires_at: new Date(Date.now() + 6 * DAY),
            app_reminders_sent: [],
          },
        },
      );
      await Notification.deleteMany({});

      expect(await checkSubscriptionReminders()).toBe(1);

      const row = await Notification.findOne({
        user_id: orgAdmin._id,
        type: 'subscription',
      }).lean();
      expect(row?.severity).toBe('info');
      expect(row?.message).toContain('next plan starts automatically');
    });

    it('sends no expiry notice when a successor is promoted', async () => {
      const plan = await createPlan({ scan_limit: 1000 });
      const sub = await grant(String(org._id), String(plan._id));
      await Notification.deleteMany({});

      await Subscription.updateOne(
        { _id: sub._id },
        { $set: { expires_at: new Date(Date.now() - DAY) } },
      );
      await Subscription.create({
        organization_id: org._id,
        plan_id: plan._id,
        payment_id: (sub as any).payment_id,
        features: [],
        billing_cycle: 'month',
        status: 'future',
        started_at: new Date(Date.now() - 1000),
        expires_at: new Date(Date.now() + 30 * DAY),
        reminders_sent: [],
        app_reminders_sent: [],
        plan_name: plan.name,
      });

      await activateEligibleSubscriptions();

      const critical = await Notification.findOne({
        user_id: orgAdmin._id,
        severity: 'critical',
      }).lean();
      expect(critical).toBeNull();
    });

    it('sends one critical expiry notice when no successor exists', async () => {
      const plan = await createPlan({ scan_limit: 1000 });
      const sub = await grant(String(org._id), String(plan._id));
      await Notification.deleteMany({});

      await Subscription.updateOne(
        { _id: sub._id },
        { $set: { expires_at: new Date(Date.now() - DAY) } },
      );

      await activateEligibleSubscriptions();

      const rows = await Notification.find({
        user_id: orgAdmin._id,
        type: 'subscription',
        severity: 'critical',
      }).lean();
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('Your subscription has expired');
      expect(rows[0].dedupe_key).toMatch(/:expired$/);
    });
  });
});
