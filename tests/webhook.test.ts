import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createOrg, createPlan, grant } from './helpers.js';
import { flushOrgBatches } from '../src/queues/webhook.worker.js';
import { WebhookConfig, WebhookDelivery, Scan } from '../src/models/index.js';

describe('webhook delivery (§9)', () => {
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

  const seedWithConfig = async (overrides: Record<string, any> = {}) => {
    const org = await createOrg();
    const plan = await createPlan();
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const config = await WebhookConfig.create({
      organization_id: org._id,
      endpoint_url: `${baseUrl}/hook`,
      enabled: true,
      batch_size: 1,
      retry_limit: 3,
      timeout_ms: 2000,
      secret: 'secret-a',
      ...overrides,
    });
    return { org, config };
  };

  const scanWith = async (organizationId: string, id: string) => {
    const { createScan } =
      await import('../src/services/user/scans.service.js');
    const { createUser } = await import('./helpers.js');
    const user = await createUser('OPERATOR', organizationId);
    return createScan(
      {
        organization_id: organizationId,
        client_scan_id: id,
        barcode: `BC-${id}`,
        device_id: 'd1',
      },
      user,
    );
  };

  it('scan persists and is delivered to webhooks (snake contract)', async () => {
    hits = [];
    respondWith = 200;
    const { org } = await seedWithConfig();
    const res = await scanWith(String(org._id), 'webhook-scan-1');
    expect(res.status).toBe(202);

    await flushOrgBatches(String(org._id));

    const scan = await Scan.findOne({ client_scan_id: 'webhook-scan-1' });
    expect(scan).toBeTruthy();

    const delivery = await WebhookDelivery.findOne({
      organization_id: org._id,
    });
    expect(delivery).toBeTruthy();
    expect(String(delivery?.scan_id)).toBe(String(scan?._id));
    expect(delivery?.status).toBe('delivered');
    expect(delivery?.retry_count).toBe(1);
    expect(delivery?.delivered_at).toBeTruthy();
    expect(hits).toHaveLength(1);
    const event = hits[0].body.events[0];
    expect(event.event_id).toBe(delivery?.event_id);
    expect(event.scan_id).toBe(String(scan?._id));
    expect(event.organization_id).toBe(String(org._id));
    expect(event.barcode).toBe('BC-webhook-scan-1');
  });

  it('delivery failure retries, honoring retry_limit', async () => {
    hits = [];
    const { org } = await seedWithConfig({
      endpoint_url: 'http://127.0.0.1:1/unreachable',
      retry_limit: 1,
      timeout_ms: 500,
    });
    await scanWith(String(org._id), 'fail-scan');
    await flushOrgBatches(String(org._id));

    const delivery = await WebhookDelivery.findOne({
      organization_id: org._id,
    });
    expect(delivery?.status).toBe('failed');
    expect(delivery?.retry_count).toBe(1);
    expect(delivery?.last_error).toBeTruthy();
  });

  it('failed delivery retries after backoff and delivers', async () => {
    hits = [];
    respondWith = 500;
    const { org } = await seedWithConfig({ retry_limit: 2 });
    await scanWith(String(org._id), 'retry-scan');
    await flushOrgBatches(String(org._id));

    let delivery = await WebhookDelivery.findOne({ organization_id: org._id });
    expect(delivery?.status).toBe('pending');
    expect(delivery?.retry_count).toBe(1);
    expect(delivery?.last_error).toContain('500');

    // simulate the 8s backoff elapsing, then the retry succeeds
    respondWith = 200;
    await WebhookDelivery.updateOne(
      { organization_id: org._id },
      { $set: { last_attempt_at: new Date(Date.now() - 10_000) } },
    );
    await flushOrgBatches(String(org._id));
    delivery = await WebhookDelivery.findOne({ organization_id: org._id });
    expect(delivery?.status).toBe('delivered');
    expect(delivery?.retry_count).toBe(2);
    expect(delivery?.delivered_at).toBeTruthy();
    expect(hits).toHaveLength(2);
  });

  it('scan persists even with no enabled webhook config', async () => {
    const org = await createOrg();
    const plan = await createPlan();
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const res = await scanWith(String(org._id), 'no-config');
    expect(res.status).toBe(202);
    const scan = await Scan.findOne({ client_scan_id: 'no-config' });
    expect(scan).toBeTruthy();
    const deliveries = await WebhookDelivery.find({ organization_id: org._id });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('pending');
  });
});
