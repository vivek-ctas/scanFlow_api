import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import {
  connectDb,
  disconnectDb,
  clearDb,
  createOrg,
  createPlan,
  createUser,
  createAdminUser,
  grant,
  activeUsed,
} from './helpers.js';
import { generateAuthTokens } from '../src/services/token.service.js';
import { populateActiveSubCache } from '../src/services/subscription.service.js';
import { Scan } from '../src/models/index.js';
import { MAX_BATCH_SCANS } from '../src/validations/user/scans.validations.js';

const tokenFor = async (user: any) => {
  const tokens = await generateAuthTokens(user as any);
  return tokens.access_token;
};

const setupOrg = async (scanLimit = 1000) => {
  const org = await createOrg();
  const plan = await createPlan({ scan_limit: scanLimit });
  await grant(String(org._id), String(plan._id), { trialDays: 0 });
  await populateActiveSubCache(String(org._id));
  const user = await createUser('OPERATOR', String(org._id));
  return { org, user, token: await tokenFor(user) };
};

const item = (n: number | string, overrides: Record<string, any> = {}) => ({
  client_scan_id: `csid-${n}`,
  barcode: `BC-${n}`,
  barcode_type: 'ZBAR_EAN13',
  device_id: 'handheld-1',
  ...overrides,
});

const postBatch = (token: string, scans: any) =>
  request(app)
    .post('/api/scans/batch')
    .set('authorization', `Bearer ${token}`)
    .send({ scans });

beforeEach(async () => {
  await connectDb();
  await clearDb();
});

afterAll(async () => {
  await disconnectDb();
});

describe('POST /api/scans/batch', () => {
  it('accepts a valid batch and returns one accepted result per item', async () => {
    const { org, token } = await setupOrg();
    const scans = [item(1), item(2), item(3)];

    const res = await postBatch(token, scans);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Batch processed.');
    expect(res.body.data.results).toHaveLength(3);
    expect(
      res.body.data.results.every((r: any) => r.status === 'accepted' && r.created),
    ).toBe(true);
    expect(await Scan.countDocuments({ organization_id: org._id })).toBe(3);
    expect(await activeUsed(String(org._id))).toBe(3);
  });

  it('preserves barcode_type and device_id per item', async () => {
    const { token } = await setupOrg();

    const res = await postBatch(token, [
      item('a', { barcode_type: 'ZBAR_CODE128', device_id: 'handheld-2' }),
    ]);

    expect(res.status).toBe(200);
    const stored = await Scan.findOne({ barcode: 'BC-a' });
    expect(stored!.barcode_type).toBe('ZBAR_CODE128');
    expect(stored!.device_id).toBe('handheld-2');
  });

  it('reports a duplicate client_scan_id as duplicate and still accepts the rest', async () => {
    const { org, token } = await setupOrg();
    await postBatch(token, [item('dup')]);

    // Replays the first scan alongside two fresh ones in a single batch.
    const res = await postBatch(token, [item('dup'), item('new1'), item('new2')]);

    expect(res.status).toBe(200);
    const results = res.body.data.results;
    expect(results.find((r: any) => r.client_scan_id === 'csid-dup')).toMatchObject({
      created: false,
      status: 'duplicate',
    });
    expect(results.filter((r: any) => r.status === 'accepted')).toHaveLength(2);
    expect(await Scan.countDocuments({ organization_id: org._id })).toBe(3);
    // Duplicates must not consume usage.
    expect(await activeUsed(String(org._id))).toBe(3);
  });

  it('stops at the quota mid-batch without discarding earlier items or throwing', async () => {
    const { org, token } = await setupOrg(2);

    const res = await postBatch(token, [item(1), item(2), item(3), item(4)]);

    expect(res.status).toBe(200);
    const results = res.body.data.results;
    expect(results.filter((r: any) => r.status === 'accepted')).toHaveLength(2);
    const blocked = results.filter((r: any) => r.status === 'quota_exceeded');
    expect(blocked).toHaveLength(2);
    // The loop kept going after the failure instead of aborting.
    expect(results).toHaveLength(4);
    expect(await Scan.countDocuments({ organization_id: org._id })).toBe(2);
    expect(await activeUsed(String(org._id))).toBe(2);
  });

  it('rejects an empty batch (400)', async () => {
    const { token } = await setupOrg();

    const res = await postBatch(token, []);

    expect(res.status).toBe(400);
  });

  it(`rejects a batch over the cap of ${MAX_BATCH_SCANS} (400) and writes nothing`, async () => {
    const { org, token } = await setupOrg();

    const res = await postBatch(
      token,
      Array.from({ length: MAX_BATCH_SCANS + 1 }, (_, i) => item(`over-${i}`)),
    );

    expect(res.status).toBe(400);
    expect(await Scan.countDocuments({ organization_id: org._id })).toBe(0);
  });

  it(`accepts a batch exactly at the cap of ${MAX_BATCH_SCANS}`, async () => {
    const { token } = await setupOrg();

    const res = await postBatch(
      token,
      Array.from({ length: MAX_BATCH_SCANS }, (_, i) => item(`cap-${i}`)),
    );

    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(MAX_BATCH_SCANS);
  });

  it('rejects an item missing a required field (400, whole batch)', async () => {
    const { token } = await setupOrg();

    const res = await postBatch(token, [item(1), { client_scan_id: 'csid-2' }]);

    expect(res.status).toBe(400);
  });

  it('rejects unknown fields inside an item — Joi is strict (400)', async () => {
    const { token } = await setupOrg();

    const res = await postBatch(token, [item(1, { bogus_field: 'x' })]);

    expect(res.status).toBe(400);
  });

  it('requires authentication (401)', async () => {
    await setupOrg();

    const res = await request(app)
      .post('/api/scans/batch')
      .send({ scans: [item(1)] });

    expect(res.status).toBe(401);
  });

  it('reports no_active_subscription per item rather than failing the request', async () => {
    const org = await createOrg();
    const user = await createUser('OPERATOR', String(org._id));
    const token = await tokenFor(user);

    const res = await postBatch(token, [item(1), item(2)]);

    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(2);
    expect(
      res.body.data.results.every((r: any) => r.status === 'no_active_subscription'),
    ).toBe(true);
    expect(await Scan.countDocuments({ organization_id: org._id })).toBe(0);
  });

  it('forces every item into the caller own org, ignoring a foreign organization_id', async () => {
    const { org, token } = await setupOrg();
    const otherOrg = await createOrg({ company_name: 'Someone Else' });

    const res = await postBatch(token, [
      item(1, { organization_id: String(otherOrg._id) }),
      item(2),
    ]);

    expect(res.status).toBe(200);
    expect(res.body.data.results.every((r: any) => r.status === 'accepted')).toBe(true);
    expect(await Scan.countDocuments({ organization_id: otherOrg._id })).toBe(0);
    expect(await Scan.countDocuments({ organization_id: org._id })).toBe(2);
  });

  it('requires organization_id from a super admin (no org on the token)', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);

    const res = await postBatch(token, [item(1)]);

    expect(res.status).toBe(400);
  });

  it('accepts an explicit organization_id from a super admin', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);
    const { org } = await setupOrg();

    const res = await postBatch(token, [
      item(1, { organization_id: String(org._id) }),
    ]);

    expect(res.status).toBe(200);
    expect(res.body.data.results[0].status).toBe('accepted');
    expect(await Scan.countDocuments({ organization_id: org._id })).toBe(1);
  });

  it('never overshoots the org quota under concurrent batches', async () => {
    const { org, token } = await setupOrg(5);

    await Promise.all([
      postBatch(token, [item('c1'), item('c2'), item('c3')]),
      postBatch(token, [item('c4'), item('c5'), item('c6')]),
      postBatch(token, [item('c7'), item('c8')]),
    ]);

    // The atomic reserve still holds when createScan is called in a loop.
    expect(await Scan.countDocuments({ organization_id: org._id })).toBe(5);
    expect(await activeUsed(String(org._id))).toBe(5);
  });
});
