import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import config from '../src/config/config.js';
import {
  CronExecution,
  CronSchedule,
  CronManagementAudit,
} from '../src/models/index.js';
import {
  deriveManagementKey,
  verifyManagementToken,
} from '../src/cron/management/token.js';

const PREFIX = '/internal/cron';
const AUD = 'SCANFLOW|PRODUCTION';
const K1 = 'test-global-key-0123456789abcdef0123456789abcdef';
const K2 = 'rotated-global-key-fedcba9876543210fedcba9876543210';
const JOB_IDS = [
  'subscription_expiry',
  'subscription_reminders',
  'usage_purge',
  'support_auto_close',
];

const VECTOR_1 =
  'czm1.eyJ2IjoxLCJhdWQiOiJTQ0FORkxPV3xQUk9EVUNUSU9OIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDAzMDAsImp0aSI6IjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSJ9.BeqohiFZBCn1GvIDklZ3PM_6rTj1b5sLatboS3r412E';
const VECTOR_2 =
  'czm1.eyJ2IjoxLCJhdWQiOiJTQ0FORkxPV3xTVEFHSU5HIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDA5MDAsImp0aSI6IjIyMjIyMjIyLTIyMjItNDIyMi04MjIyLTIyMjIyMjIyMjIyMiJ9.rs8WGq6FFKGMqYUSB2bg1PhyQ28dVC_49nlFSyQtWoI';
const VECTOR_3 =
  'czm1.eyJ2IjoxLCJhdWQiOiJERU1PX1BST0RVQ1R8REVWRUxPUE1FTlQiLCJpYXQiOjE3MzU2ODk2MDAsImV4cCI6MTczNTY4OTkwMCwianRpIjoiMzMzMzMzMzMtMzMzMy00MzMzLTgzMzMtMzMzMzMzMzMzMzMzIn0.V-9qVIDdcA9EHSJ5f-CqBLXIplsJwYMAbKI8_BV_z6s';
const VECTOR_4 =
  'czm1.eyJ2IjoxLCJhdWQiOiJTQ0FORkxPV3xQUk9EVUNUSU9OIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDAzMDAsImp0aSI6IjQ0NDQ0NDQ0LTQ0NDQtNDQ0NC04NDQ0LTQ0NDQ0NDQ0NDQ0NCJ9.hg267HUS25swDcquOmFHK3HgM9YFKNvfPLWJD13lO2U';

const nowSec = () => Math.floor(Date.now() / 1000);

const mint = (options: {
  key?: string;
  aud?: string;
  ttl?: number;
  iat?: number;
  jti?: string;
  version?: number;
} = {}): string => {
  const key = options.key ?? K1;
  const aud = options.aud ?? AUD;
  const iat = options.iat ?? nowSec();
  const payload = {
    v: options.version ?? 1,
    aud,
    iat,
    exp: iat + (options.ttl ?? 300),
    jti: options.jti ?? crypto.randomUUID(),
  };
  const signingInput = `czm1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const signature = crypto
    .createHmac('sha256', deriveManagementKey(key, aud))
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
};

const bearer = (token = mint()) => ({ Authorization: `Bearer ${token}` });

const get = (path: string, token = mint()) =>
  request(app).get(`${PREFIX}${path}`).set(bearer(token));

const post = (path: string, body: unknown = {}, token = mint()) =>
  request(app).post(`${PREFIX}${path}`).set(bearer(token)).send(body as any);

const patch = (path: string, body: unknown, token = mint()) =>
  request(app).patch(`${PREFIX}${path}`).set(bearer(token)).send(body as any);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForIdle = async (jobId: string, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await get(`/jobs/${jobId}/status`);
    if (res.body?.data?.execution !== 'RUNNING') return;
    await sleep(100);
  }
  throw new Error(`job ${jobId} did not become idle`);
};

const seed = async () => {
  const res = await get('/jobs');
  expect(res.status).toBe(200);
  return res.body.data.items;
};

const findJob = (items: any[], id: string) =>
  items.find((item) => item.id === id);

describe('management token verification (frozen vectors)', () => {
  it('accepts vectors 1-3 with the primary key', () => {
    expect(
      verifyManagementToken({
        token: VECTOR_1,
        keys: [K1],
        expectedAud: AUD,
        nowSec: 1700000000,
      }).ok,
    ).toBe(true);
    expect(
      verifyManagementToken({
        token: VECTOR_2,
        keys: [K1],
        expectedAud: 'SCANFLOW|STAGING',
        nowSec: 1700000000,
      }).ok,
    ).toBe(true);
    expect(
      verifyManagementToken({
        token: VECTOR_3,
        keys: [K1],
        expectedAud: 'DEMO_PRODUCT|DEVELOPMENT',
        nowSec: 1735689600,
      }).ok,
    ).toBe(true);
  });

  it('accepts a secondary-key token only when the secondary slot is present', () => {
    expect(
      verifyManagementToken({
        token: VECTOR_4,
        keys: [K1, K2],
        expectedAud: AUD,
        nowSec: 1700000000,
      }).ok,
    ).toBe(true);
    expect(
      verifyManagementToken({
        token: VECTOR_4,
        keys: [K1],
        expectedAud: AUD,
        nowSec: 1700000000,
      }),
    ).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects expired tokens', () => {
    expect(
      verifyManagementToken({
        token: VECTOR_1,
        keys: [K1],
        expectedAud: AUD,
        nowSec: 1700000301,
      }),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects wrong audience (signature mismatch)', () => {
    expect(
      verifyManagementToken({
        token: VECTOR_1,
        keys: [K1],
        expectedAud: 'SCANFLOW|STAGING',
        nowSec: 1700000000,
      }),
    ).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects wrong key and tampered signature', () => {
    expect(
      verifyManagementToken({
        token: VECTOR_1,
        keys: [K2],
        expectedAud: AUD,
        nowSec: 1700000000,
      }),
    ).toEqual({ ok: false, reason: 'signature' });

    const tampered = `${VECTOR_1.slice(0, -4)}AAAA`;
    expect(
      verifyManagementToken({
        token: tampered,
        keys: [K1],
        expectedAud: AUD,
        nowSec: 1700000000,
      }),
    ).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects a future iat, excessive TTL, bad version and bad prefix', () => {
    const future = mint({ iat: nowSec() + 120 });
    expect(
      verifyManagementToken({
        token: future,
        keys: [K1],
        expectedAud: AUD,
      }),
    ).toEqual({ ok: false, reason: 'iat_future' });

    const longTtl = mint({ ttl: 1800 });
    expect(
      verifyManagementToken({
        token: longTtl,
        keys: [K1],
        expectedAud: AUD,
      }),
    ).toEqual({ ok: false, reason: 'ttl' });

    const badVersion = mint({ version: 2 });
    expect(
      verifyManagementToken({
        token: badVersion,
        keys: [K1],
        expectedAud: AUD,
      }),
    ).toEqual({ ok: false, reason: 'version' });

    const badPrefix = VECTOR_1.replace('czm1.', 'czm2.');
    expect(
      verifyManagementToken({
        token: badPrefix,
        keys: [K1],
        expectedAud: AUD,
        nowSec: 1700000000,
      }),
    ).toEqual({ ok: false, reason: 'format' });
  });

  it('rejects an audience mismatch even when the HMAC matches', () => {
    const payload = {
      v: 1,
      aud: 'OTHER|PRODUCTION',
      iat: nowSec(),
      exp: nowSec() + 300,
      jti: crypto.randomUUID(),
    };
    const signingInput = `czm1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    const signature = crypto
      .createHmac('sha256', deriveManagementKey(K1, AUD))
      .update(signingInput)
      .digest('base64url');
    expect(
      verifyManagementToken({
        token: `${signingInput}.${signature}`,
        keys: [K1],
        expectedAud: AUD,
      }),
    ).toEqual({ ok: false, reason: 'audience' });
  });
});

describe('management API authentication', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get(`${PREFIX}/health`);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'UNAUTHORIZED' },
    });
    expect(typeof res.body.request_id).toBe('string');
  });

  it('returns 401 for a wrong-audience or wrong-key token', async () => {
    const wrongAud = await get(
      '/health',
      mint({ aud: 'SCANFLOW|STAGING' }),
    );
    expect(wrongAud.status).toBe(401);

    const wrongKey = await get('/health', mint({ key: 'not-the-key' }));
    expect(wrongKey.status).toBe(401);
  });

  it('accepts a secondary-key token during rotation', async () => {
    const res = await get('/health', mint({ key: K2 }));
    expect(res.status).toBe(200);
    expect(res.body.data.key_slots.secondary_configured).toBe(true);
  });

  it('echoes a valid request id and generates one otherwise', async () => {
    const echoed = await request(app)
      .get(`${PREFIX}/health`)
      .set(bearer())
      .set('X-Request-Id', 'req-abc.123');
    expect(echoed.status).toBe(200);
    expect(echoed.headers['x-request-id']).toBe('req-abc.123');
    expect(echoed.body.request_id).toBe('req-abc.123');

    const generated = await get('/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.body.request_id).toBe(generated.headers['x-request-id']);
  });
});

describe('management CORS and body limits', () => {
  it('answers allowed-origin preflight with 204 and the contract headers', async () => {
    const res = await request(app)
      .options(`${PREFIX}/jobs`)
      .set('Origin', 'https://panel.test')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'Authorization');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://panel.test',
    );
    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
    expect(res.headers['access-control-allow-headers']).toContain(
      'Authorization',
    );
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.text).toBe('');
  });

  it('rejects a disallowed origin preflight', async () => {
    const res = await request(app)
      .options(`${PREFIX}/jobs`)
      .set('Origin', 'https://evil.test')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(403);
  });

  it('sets the allow-origin header on actual allowed-origin requests', async () => {
    const res = await request(app)
      .get(`${PREFIX}/health`)
      .set(bearer())
      .set('Origin', 'https://panel.test');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://panel.test',
    );
  });

  it('rejects bodies over 10 KB with the management envelope', async () => {
    const res = await post('/bulk/start', {
      job_ids: ['x'.repeat(11_000)],
      confirm: true,
    });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });
  });

  it('rejects malformed JSON with the management envelope', async () => {
    const res = await request(app)
      .post(`${PREFIX}/bulk/start`)
      .set(bearer())
      .set('Content-Type', 'application/json')
      .send('{"confirm":');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
    });
  });
});

describe('management discovery', () => {
  it('exposes honest health and capabilities', async () => {
    const health = await get('/health');
    expect(health.status).toBe(200);
    expect(health.body.success).toBe(true);
    expect(['ok', 'degraded']).toContain(health.body.data.status);
    expect(['running', 'stopped', 'error']).toContain(
      health.body.data.scheduler,
    );
    expect(health.body.data.jobs_total).toBe(4);
    expect(health.body.data.api_version).toBe('v1');
    expect(health.body.data.integration_version).toBe('1.0.0');
    expect(health.body.data.runtime).toBe('nodejs');
    expect(health.body.data.scheduler_library).toBe('cron-parser');

    const capabilities = await get('/capabilities');
    expect(capabilities.status).toBe(200);
    const caps = capabilities.body.data.capabilities;
    for (const key of [
      'discovery',
      'start',
      'stop',
      'run',
      'update_schedule',
      'schedule_dry_run',
      'schedule_reset',
      'bulk',
      'execution_history',
      'logs',
      'audit',
      'cancel_running',
      'cron_seconds',
    ]) {
      expect(typeof caps[key]).toBe('boolean');
    }
    expect(caps.cancel_running).toBe(false);
    expect(caps.cron_seconds).toBe(false);
  });

  it('lists the four registry jobs in order with stable shapes', async () => {
    const res = await get('/jobs');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(4);
    expect(res.body.data.items.map((job: any) => job.id)).toEqual(JOB_IDS);

    for (const job of res.body.data.items) {
      expect(job).toMatchObject({
        runtime: 'nodejs',
        scheduler: 'cron-parser',
        scheduling: 'ACTIVE',
        execution: 'IDLE',
        capabilities: {
          start: true,
          stop: true,
          run: true,
          update_schedule: true,
        },
      });
      expect(job.schedule).toMatchObject({
        source: 'default',
        version: 1,
      });
      expect(typeof job.schedule.expression).toBe('string');
      expect(typeof job.schedule.timezone).toBe('string');
      expect(typeof job.next_run_at).toBe('string');
      expect(job.last_execution).toBeNull();
    }

    const status = await get('/jobs/usage_purge/status');
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({
      id: 'usage_purge',
      scheduling: 'ACTIVE',
      execution: 'IDLE',
      last_execution: null,
    });
  });

  it('returns 404 for an unknown job and route', async () => {
    const job = await get('/jobs/does_not_exist');
    expect(job.status).toBe(404);
    expect(job.body.error.code).toBe('JOB_NOT_FOUND');

    const route = await get('/nope');
    expect(route.status).toBe(404);
    expect(route.body.success).toBe(false);
  });
});

describe('management start/stop', () => {
  it('persists state, is idempotent, and never triggers a run', async () => {
    await seed();

    const firstStart = await post('/jobs/usage_purge/start');
    expect(firstStart.status).toBe(200);
    expect(firstStart.body.data).toMatchObject({
      id: 'usage_purge',
      scheduling: 'ACTIVE',
      changed: false,
    });
    expect(typeof firstStart.body.data.next_run_at).toBe('string');

    const stop = await post('/jobs/usage_purge/stop');
    expect(stop.status).toBe(200);
    expect(stop.body.data).toMatchObject({
      id: 'usage_purge',
      scheduling: 'STOPPED',
      changed: true,
    });
    expect(typeof stop.body.data.execution_in_progress).toBe('boolean');

    const stillStopped = await post('/jobs/usage_purge/stop');
    expect(stillStopped.body.data.changed).toBe(false);

    const row = await CronSchedule.findOne({ job_id: 'usage_purge' }).lean();
    expect(row?.enabled).toBe(false);

    const start = await post('/jobs/usage_purge/start');
    expect(start.body.data).toMatchObject({
      scheduling: 'ACTIVE',
      changed: true,
    });
    expect(
      await CronExecution.countDocuments({ job_id: 'usage_purge' }),
    ).toBe(0);
  });
});

describe('management run', () => {
  it('accepts a manual run with 202 and records execution/logs', async () => {
    await seed();

    const res = await post('/jobs/usage_purge/run');
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({
      job_id: 'usage_purge',
      status: 'RUNNING',
    });
    expect(res.body.data.execution_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    await waitForIdle('usage_purge');

    const executions = await get(
      `/jobs/usage_purge/executions?limit=5&trigger=MANUAL`,
    );
    expect(executions.status).toBe(200);
    expect(executions.body.data.items).toHaveLength(1);
    expect(executions.body.data.items[0]).toMatchObject({
      execution_id: res.body.data.execution_id,
      job_id: 'usage_purge',
      trigger: 'MANUAL',
      triggered_by: 'cronzivo-panel',
      status: 'SUCCESS',
    });
    expect(typeof executions.body.data.items[0].finished_at).toBe('string');

    const logs = await get(
      `/jobs/usage_purge/logs?limit=10&execution_id=${res.body.data.execution_id}`,
    );
    expect(logs.status).toBe(200);
    expect(logs.body.data.items.length).toBeGreaterThanOrEqual(2);
    expect(logs.body.data.items.map((entry: any) => entry.message)).toEqual(
      expect.arrayContaining(['job started', 'job completed']),
    );
  });

  it('rejects a non-empty run body', async () => {
    await seed();
    const res = await post('/jobs/usage_purge/run', { arguments: ['x'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 409 while another execution holds the lease', async () => {
    await seed();
    await CronSchedule.updateOne(
      { job_id: 'usage_purge' },
      {
        $set: {
          lock_execution_id: 'held-by-other-process',
          lock_expires_at: new Date(Date.now() + 60_000),
        },
      },
    );

    const res = await post('/jobs/usage_purge/run');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('JOB_ALREADY_RUNNING');

    await CronSchedule.updateOne(
      { job_id: 'usage_purge' },
      { $set: { lock_execution_id: null, lock_expires_at: null } },
    );
  });
});

describe('management schedules', () => {
  it('validates, dry-runs, applies, detects conflicts and resets', async () => {
    await seed();

    const invalidCron = await patch('/jobs/usage_purge/schedule', {
      expression: '* * *',
      timezone: 'UTC',
    });
    expect(invalidCron.status).toBe(400);
    expect(invalidCron.body.error.code).toBe('INVALID_CRON');

    const invalidTz = await patch('/jobs/usage_purge/schedule', {
      expression: '*/5 * * * *',
      timezone: 'Mars/Olympus',
    });
    expect(invalidTz.status).toBe(400);
    expect(invalidTz.body.error.code).toBe('INVALID_TIMEZONE');

    const missing = await patch('/jobs/usage_purge/schedule', {
      expression: '*/5 * * * *',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');

    const unknown = await patch('/jobs/usage_purge/schedule', {
      expression: '*/5 * * * *',
      timezone: 'UTC',
      nope: true,
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('VALIDATION_ERROR');

    const dryRun = await patch('/jobs/usage_purge/schedule', {
      expression: '0 9 * * *',
      timezone: 'Asia/Kolkata',
      dry_run: true,
    });
    expect(dryRun.status).toBe(200);
    expect(dryRun.body.data).toMatchObject({
      valid: true,
      normalized_expression: '0 9 * * *',
      expression: '0 9 * * *',
      timezone: 'Asia/Kolkata',
    });
    expect(dryRun.body.data.next_runs).toHaveLength(5);
    for (const next of dryRun.body.data.next_runs) {
      expect(new Date(next).toISOString()).toBe(next);
    }

    const unchanged = await get('/jobs/usage_purge');
    expect(unchanged.body.data.schedule.version).toBe(1);
    expect(unchanged.body.data.schedule.source).toBe('default');

    const applied = await patch('/jobs/usage_purge/schedule', {
      expression: '0 9 * * *',
      timezone: 'Asia/Kolkata',
      expected_version: 1,
    });
    expect(applied.status).toBe(200);
    expect(applied.body.data.schedule).toMatchObject({
      expression: '0 9 * * *',
      timezone: 'Asia/Kolkata',
      source: 'custom',
      version: 2,
      updated_by: 'cronzivo-panel',
    });
    expect(typeof applied.body.data.schedule.updated_at).toBe('string');

    const conflict = await patch('/jobs/usage_purge/schedule', {
      expression: '*/10 * * * *',
      timezone: 'UTC',
      expected_version: 1,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('VERSION_CONFLICT');

    const afterConflict = await get('/jobs/usage_purge');
    expect(afterConflict.body.data.schedule).toMatchObject({
      expression: '0 9 * * *',
      version: 2,
    });

    const reset = await post('/jobs/usage_purge/schedule/reset');
    expect(reset.status).toBe(200);
    expect(reset.body.data.schedule).toMatchObject({
      expression: '0 * * * *',
      timezone: 'UTC',
      source: 'default',
      version: 3,
      updated_by: 'cronzivo-panel',
    });
  });

  it('returns 501 for the unsupported cancel capability', async () => {
    await seed();
    const res = await post('/jobs/usage_purge/cancel', {
      execution_id: 'anything',
    });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('CAPABILITY_NOT_SUPPORTED');
  });
});

describe('management bulk operations', () => {
  it('requires confirm:true and a non-empty job list', async () => {
    await seed();
    const missing = await post('/bulk/start', {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('CONFIRMATION_REQUIRED');

    const empty = await post('/bulk/start', { job_ids: [], confirm: true });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('reports per-item failures and still processes the rest', async () => {
    await seed();
    const res = await post('/bulk/stop', {
      job_ids: ['usage_purge', 'does_not_exist'],
      confirm: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([
      expect.objectContaining({
        job_id: 'usage_purge',
        ok: true,
        changed: true,
      }),
      expect.objectContaining({
        job_id: 'does_not_exist',
        ok: false,
        code: 'JOB_NOT_FOUND',
      }),
    ]);
    expect(res.body.data.summary).toEqual({
      total: 2,
      succeeded: 1,
      failed: 1,
      skipped: 0,
    });
  });

  it('stops and starts all jobs idempotently', async () => {
    await seed();

    const stopped = await post('/bulk/stop', { confirm: true });
    expect(stopped.status).toBe(200);
    expect(stopped.body.data.summary).toEqual({
      total: 4,
      succeeded: 4,
      failed: 0,
      skipped: 0,
    });
    const afterStop = await get('/jobs');
    expect(
      afterStop.body.data.items.every(
        (job: any) => job.scheduling === 'STOPPED',
      ),
    ).toBe(true);

    const started = await post('/bulk/start', { confirm: true });
    expect(started.status).toBe(200);
    expect(started.body.data.summary.succeeded).toBe(4);
    const afterStart = await get('/jobs');
    expect(
      afterStart.body.data.items.every((job: any) => job.scheduling === 'ACTIVE'),
    ).toBe(true);
  });

  it('enforces the bulk-run concurrency limit and returns 202', async () => {
    await seed();
    const res = await post('/bulk/run', {
      job_ids: ['usage_purge', 'support_auto_close'],
      confirm: true,
    });
    expect(res.status).toBe(202);

    const [first, second] = res.body.data.results;
    expect(first).toMatchObject({
      job_id: 'usage_purge',
      ok: true,
      status: 'RUNNING',
    });
    expect(typeof first.execution_id).toBe('string');
    expect(second).toEqual(
      expect.objectContaining({
        job_id: 'support_auto_close',
        ok: false,
        code: 'JOB_ALREADY_RUNNING',
      }),
    );
    expect(res.body.data.summary).toEqual({
      total: 2,
      succeeded: 1,
      failed: 0,
      skipped: 1,
    });

    await waitForIdle('usage_purge');
  });
});

describe('management history', () => {
  it('paginates executions newest-first with an opaque cursor', async () => {
    await seed();
    const base = Date.now() - 60_000;
    for (let index = 0; index < 3; index += 1) {
      await CronExecution.create({
        execution_id: crypto.randomUUID(),
        job_id: 'usage_purge',
        trigger: 'SCHEDULED',
        triggered_by: 'system',
        status: 'SUCCESS',
        started_at: new Date(base + index * 1000),
        finished_at: new Date(base + index * 1000 + 100),
        duration_ms: 100,
      });
    }

    const pageOne = await get('/jobs/usage_purge/executions?limit=2');
    expect(pageOne.status).toBe(200);
    expect(pageOne.body.data.items).toHaveLength(2);
    expect(typeof pageOne.body.data.next_cursor).toBe('string');

    const pageTwo = await get(
      `/jobs/usage_purge/executions?limit=2&cursor=${pageOne.body.data.next_cursor}`,
    );
    expect(pageTwo.status).toBe(200);
    expect(pageTwo.body.data.items).toHaveLength(1);
    expect(pageTwo.body.data.next_cursor).toBeNull();

    const invalidCursor = await get(
      '/jobs/usage_purge/executions?cursor=not-a-cursor',
    );
    expect(invalidCursor.status).toBe(400);

    const invalidStatus = await get(
      '/jobs/usage_purge/executions?status=NOPE',
    );
    expect(invalidStatus.status).toBe(400);
  });

  it('records successful and failed commands with the request id', async () => {
    await seed();

    const stop = await request(app)
      .post(`${PREFIX}/jobs/usage_purge/stop`)
      .set(bearer())
      .set('X-Request-Id', 'audit-stop-1');
    expect(stop.status).toBe(200);

    await patch('/jobs/usage_purge/schedule', {
      expression: '*/5 * * * *',
      timezone: 'UTC',
      expected_version: 99,
    });

    const audit = await get('/jobs/usage_purge/audit?limit=10');
    expect(audit.status).toBe(200);

    const stopEntry = audit.body.data.items.find(
      (entry: any) => entry.command === 'stop',
    );
    expect(stopEntry).toMatchObject({
      job_id: 'usage_purge',
      actor: 'cronzivo-panel',
      request_id: 'audit-stop-1',
      outcome: 'SUCCESS',
    });
    expect(stopEntry.before).toMatchObject({ enabled: true });
    expect(stopEntry.after).toMatchObject({ enabled: false });

    const failed = audit.body.data.items.find(
      (entry: any) => entry.command === 'schedule.update',
    );
    expect(failed).toMatchObject({ outcome: 'FAILED' });

    const stored = await CronManagementAudit.findOne({
      request_id: 'audit-stop-1',
    }).lean();
    expect(stored?.actor).toBe('cronzivo-panel');
    expect(stored?.ip).toBeTruthy();
  });
});

describe('management configuration', () => {
  it('exposes the configured audience and prefix defaults', () => {
    expect(config.cronzivo.productCode).toBe('SCANFLOW');
    expect(config.cronzivo.environment).toBe('PRODUCTION');
    expect(config.cronzivo.mgmtPrefix).toBe('/internal/cron');
    expect(config.cronzivo.allowedOrigins).toEqual(['https://panel.test']);
  });
});
