import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createOrg, createPlan, grant, createUser } from './helpers.js';
import { createScan } from '../src/services/user/scans.service.js';
import { flushOrgBatches } from '../src/queues/webhook.worker.js';
import { WebhookConfig, WebhookDelivery } from '../src/models/index.js';

describe('webhook delivery (§11)', () => {
  let server: http.Server;
  let baseUrl = '';
  let hits: Array<{ body: any }> = [];
  let respondWith: number = 200;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        hits.push({ body: JSON.parse(raw || '{}') });
        res.writeHead(respondWith, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as any;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const scanWith = async (organizationId: string, id: string) => {
    const user = await createUser('OPERATOR', organizationId);
    return createScan(
      { organizationId, clientScanId: id, barcode: `BC-${id}`, deviceId: 'd1' },
      user,
    );
  };

  it('29. scan persists even with no webhook endpoint configured', async () => {
    const org = await createOrg();
    const plan = await createPlan();
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const res = await scanWith(String(org._id), 'no-config');
    expect(res.status).toBe(202);
    const deliveries = await WebhookDelivery.find({ organizationId: org._id });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('pending');
  });

  it('30. delivery is retried and eventually delivered (batched)', async () => {
    hits = [];
    respondWith = 500;
    const org = await createOrg();
    const plan = await createPlan();
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const res = await scanWith(String(org._id), 'retry-me');
    expect(res.status).toBe(202);

    await WebhookConfig.create({
      organizationId: org._id,
      endpointUrl: `${baseUrl}/hook`,
      enabled: true,
      batchSize: 1,
      retryLimit: 3,
      timeoutMs: 1000,
    });

    await flushOrgBatches(String(org._id));
    const afterFail = await WebhookDelivery.findOne({ organizationId: org._id });
    expect(afterFail?.status).toBe('pending');
    expect(afterFail?.attempts).toBe(1);
    expect(afterFail?.lastError).toContain('500');

    respondWith = 200;
    await flushOrgBatches(String(org._id));
    const delivered = await WebhookDelivery.findOne({ organizationId: org._id });
    expect(delivered?.status).toBe('delivered');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const last = hits[hits.length - 1];
    expect(last.body.events).toBeDefined();
    expect(last.body.events).toHaveLength(1);
    expect(last.body.events[0].scanId).toBeDefined();
  });

  it('31. webhook failure never blocks the scan response', async () => {
    hits = [];
    respondWith = 503;
    const org = await createOrg();
    const plan = await createPlan();
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    await WebhookConfig.create({
      organizationId: org._id,
      endpointUrl: `${baseUrl}/down`,
      enabled: true,
      batchSize: 1,
      retryLimit: 1,
      timeoutMs: 500,
    });
    const res = await scanWith(String(org._id), 'fail-fast');
    expect(res.status).toBe(202);
    await flushOrgBatches(String(org._id));
    const row = await WebhookDelivery.findOne({ organizationId: org._id });
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toBeDefined();
  });
});