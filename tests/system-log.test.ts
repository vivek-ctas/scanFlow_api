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
} from './helpers.js';
import { generateAuthTokens } from '../src/services/token.service.js';
import { Plan, SystemLog } from '../src/models/index.js';
import { systemLog } from '../src/utils/system-log.js';
import { withCronRun } from '../src/cron/cron-runner.js';

vi.mock('../src/config/config.js', () => ({
  default: {
    env: 'test',
    NODE_ENV: 'test',
    PORT: 3000,
    behindReverseProxy: false,
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

const createLog = (overrides: Record<string, any> = {}) =>
  SystemLog.create({
    operation: 'CREATE',
    key: 'test:key',
    operation_data: [{ name: 'sample' }],
    ...overrides,
  });

describe('system log', () => {
  let superAdmin: any;
  let superToken: string;

  beforeAll(async () => {
    await connectDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  beforeEach(async () => {
    await clearDb();
    superAdmin = await createAdminUser();
    superToken = await tokenFor(superAdmin);
  });

  describe('writer', () => {
    it('stores a CREATE snapshot with actor and organization', async () => {
      const org = await createOrg();

      await systemLog({
        operation: 'CREATE',
        key: 'create-organization',
        data: { company_name: org.company_name, password: 'plain-secret' },
        actorId: superAdmin._id,
        actorRole: 'SUPER_ADMIN',
        organizationId: org._id,
      });

      const log = await SystemLog.findOne({ key: 'create-organization' });
      expect(log).toBeTruthy();
      expect(log!.operation).toBe('CREATE');
      expect(String(log!.operation_by)).toBe(String(superAdmin._id));
      expect(log!.actor_role).toBe('SUPER_ADMIN');
      expect(String(log!.organization_id)).toBe(String(org._id));
      expect(log!.operation_data?.[0]).toMatchObject({
        company_name: 'Test Org',
        password: '[redacted]',
      });
    });

    it('stores only changed fields for an UPDATE', async () => {
      await systemLog({
        operation: 'UPDATE',
        key: 'plan:p1',
        data: { name: 'New', price: 100, unchanged: true },
        existingData: { name: 'Old', price: 100, unchanged: true },
      });

      const log = await SystemLog.findOne({ key: 'plan:p1' });
      const payload = log!.operation_data?.[0] as Record<string, any>;
      expect(payload.oldData.name).toBe('Old');
      expect(payload.updatedData.name).toBe('New');
      expect(payload.oldData.price).toBeUndefined();
      expect(payload.updatedData.unchanged).toBeUndefined();
    });

    it('never throws when the write fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(SystemLog, 'create').mockRejectedValueOnce(
        new Error('database down'),
      );

      await expect(
        systemLog({ operation: 'CREATE', key: 'boom', data: {} }),
      ).resolves.toBeUndefined();

      errorSpy.mockRestore();
    });
  });

  describe('GET /system-logs', () => {
    it('scopes organization admins to their own organization', async () => {
      const ownOrg = await createOrg({ company_name: 'Own Org' });
      const otherOrg = await createOrg({ company_name: 'Other Org' });
      const ownLog = await createLog({
        operation: 'CREATE',
        key: 'plan:own',
        organization_id: ownOrg._id,
      });
      const otherLog = await createLog({
        operation: 'UPDATE',
        key: 'plan:other',
        organization_id: otherOrg._id,
      });
      await createLog({ operation: 'CRON', key: 'cron:global' });

      const orgAdmin = await createUser(
        'ORGANIZATION_ADMIN',
        String(ownOrg._id),
      );
      const token = await tokenFor(orgAdmin);

      const list = await request(app)
        .get('/api/system-logs')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(list.body.data.total_results).toBe(1);
      expect(list.body.data.results[0].key).toBe('plan:own');

      // A query-string org override must not escape the enforced scope.
      const forced = await request(app)
        .get('/api/system-logs')
        .query({ organization_id: String(otherOrg._id) })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(forced.body.data.total_results).toBe(1);
      expect(forced.body.data.results[0].key).toBe('plan:own');

      await request(app)
        .get(`/api/system-logs/${ownLog._id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await request(app)
        .get(`/api/system-logs/${otherLog._id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      const operations = await request(app)
        .get('/api/system-logs/operations')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(operations.body.data.operations).toEqual(['CREATE']);
    });

    it('lists logs with filters and pagination metadata', async () => {
      await createLog({ operation: 'CREATE', key: 'plan:p1' });
      await createLog({ operation: 'LOGIN', key: 'user:u1' });
      await createLog({ operation: 'CRON', key: 'cron:daily' });

      const createResponse = await request(app)
        .get('/api/system-logs')
        .query({ operation: 'CREATE' })
        .set('Authorization', `Bearer ${superToken}`)
        .expect(200);

      expect(createResponse.body.data.total_results).toBe(1);
      expect(createResponse.body.data.results[0].key).toBe('plan:p1');
      expect(createResponse.body.data.results[0].operation_data).toBeUndefined();
      expect(createResponse.body.data).toMatchObject({
        page: 1,
        limit: 20,
        total_pages: 1,
      });

      const searchResponse = await request(app)
        .get('/api/system-logs')
        .query({ search: 'cron:' })
        .set('Authorization', `Bearer ${superToken}`)
        .expect(200);

      expect(searchResponse.body.data.total_results).toBe(1);
      expect(searchResponse.body.data.results[0].key).toBe('cron:daily');

      const paged = await request(app)
        .get('/api/system-logs')
        .query({ limit: 2, page: 1, sort_by: 'created_at:asc' })
        .set('Authorization', `Bearer ${superToken}`)
        .expect(200);

      expect(paged.body.data.results).toHaveLength(2);
      expect(paged.body.data.total_results).toBe(3);
      expect(paged.body.data.total_pages).toBe(2);
    });

    it('returns the available operations', async () => {
      await createLog({ operation: 'CREATE' });
      await createLog({ operation: 'LOGIN' });

      const response = await request(app)
        .get('/api/system-logs/operations')
        .set('Authorization', `Bearer ${superToken}`)
        .expect(200);

      expect(response.body.data.operations).toEqual(['CREATE', 'LOGIN']);
    });
  });

  describe('GET /system-logs/:logId', () => {
    it('returns the stored payload and the populated actor', async () => {
      const log = await createLog({
        operation: 'CREATE',
        key: 'plan:detail',
        operation_by: superAdmin._id,
      });

      const response = await request(app)
        .get(`/api/system-logs/${log._id}`)
        .set('Authorization', `Bearer ${superToken}`)
        .expect(200);

      expect(response.body.data.log.key).toBe('plan:detail');
      expect(response.body.data.log.operation_data).toEqual([{ name: 'sample' }]);
      expect(response.body.data.log.operation_by).toMatchObject({
        email: superAdmin.email,
        role: 'SUPER_ADMIN',
      });
    });

    it('returns 404 for an unknown id', async () => {
      await request(app)
        .get('/api/system-logs/64b000000000000000000000')
        .set('Authorization', `Bearer ${superToken}`)
        .expect(404);
    });
  });

  describe('request integration', () => {
    it('records a plan mutation with actor and client ip', async () => {
      const created = await request(app)
        .post('/api/plans')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ name: 'Audited Plan', price: 250 })
        .expect(201);

      const log = await SystemLog.findOne({
        key: 'create-plan',
        operation: 'CREATE',
      });
      expect(log).toBeTruthy();
      expect(String(log!.operation_by)).toBe(String(superAdmin._id));
      expect(log!.actor_role).toBe('SUPER_ADMIN');
      expect(log!.ip_address).toBeTruthy();
      expect((log!.operation_data?.[0] as any).name).toBe('Audited Plan');

      const plan = await Plan.findById(created.body.data.plan.id);
      await request(app)
        .put(`/api/plans/${plan!._id}`)
        .set('Authorization', `Bearer ${superToken}`)
        .send({ name: 'Renamed Plan' })
        .expect(200);

      const updateLog = await SystemLog.findOne({
        key: 'update-plan',
        operation: 'UPDATE',
      });
      const payload = updateLog!.operation_data?.[0] as Record<string, any>;
      expect(payload.updatedData.name).toBe('Renamed Plan');
      expect(payload.oldData.name).toBe('Audited Plan');
    });
  });

  describe('remaining mutation coverage', () => {
    it('records a self-service profile update', async () => {
      await request(app)
        .patch('/api/auth/me')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ first_name: 'Renamed' })
        .expect(200);

      const log = await SystemLog.findOne({
        key: 'update-profile',
        operation: 'UPDATE',
      });
      expect(log).toBeTruthy();
      expect(String(log!.operation_by)).toBe(String(superAdmin._id));
      const payload = log!.operation_data?.[0] as Record<string, any>;
      expect(payload.updatedData.first_name).toBe('Renamed');
      expect(payload.oldData.first_name).toBe('Super');
    });

    it('records successful and failed cron runs as SYSTEM', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await withCronRun('test-cron-ok', async () => 7);
      await withCronRun('test-cron-fail', async () => {
        throw new Error('job exploded');
      });

      const ok = await SystemLog.findOne({ key: 'cron:test-cron-ok' });
      expect(ok).toBeTruthy();
      expect(ok!.operation).toBe('CRON');
      expect(ok!.actor_role).toBe('SYSTEM');
      expect((ok!.operation_data?.[0] as any).status).toBe('completed');

      const failed = await SystemLog.findOne({ key: 'cron:test-cron-fail' });
      expect(failed).toBeTruthy();
      expect((failed!.operation_data?.[0] as any).status).toBe('failed');
      expect((failed!.operation_data?.[0] as any).error).toBe('job exploded');

      errorSpy.mockRestore();
    });
  });
});
