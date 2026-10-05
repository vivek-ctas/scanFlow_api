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

const tokenFor = async (user: any) => {
  const tokens = await generateAuthTokens(user as any);
  return tokens.access_token;
};

/** Operator + plan with `scan_limit`, wired the same way usage.test.ts does. */
const setupOrg = async (scanLimit = 100) => {
  const org = await createOrg();
  const plan = await createPlan({ scan_limit: scanLimit });
  await grant(String(org._id), String(plan._id), { trialDays: 0 });
  await populateActiveSubCache(String(org._id));
  const user = await createUser('OPERATOR', String(org._id));
  return { org, user, token: await tokenFor(user) };
};

const postScan = (token: string, body: Record<string, any>) =>
  request(app).post('/api/scans').set('authorization', `Bearer ${token}`).send(body);

/** A realistic payload as the scanner's worker would emit it. */
const scanBody = (overrides: Record<string, any> = {}) => ({
  client_scan_id: 'csid-' + Math.random().toString(36).slice(2, 10),
  barcode: '8901234567890',
  barcode_type: 'ZBAR_EAN13',
  device_id: 'handheld-1',
  ...overrides,
});

beforeEach(async () => {
  await connectDb();
  await clearDb();
});

afterAll(async () => {
  await disconnectDb();
});

describe('POST /api/scans (HTTP level)', () => {
  it('accepts a new scan with 202 and persists it against the operator + org', async () => {
    const { org, user, token } = await setupOrg();

    const res = await postScan(token, scanBody());

    expect(res.status).toBe(202);
    expect(res.body.message).toBe('Scan accepted for processing.');
    expect(res.body.data.created).toBe(true);

    const stored = await Scan.findOne({ barcode: '8901234567890' });
    expect(stored).toBeTruthy();
    expect(String(stored!.organization_id)).toBe(String(org._id));
    expect(String(stored!.user_id)).toBe(String(user._id));
    expect(stored!.barcode_type).toBe('ZBAR_EAN13');
    expect(stored!.device_id).toBe('handheld-1');
    expect(await activeUsed(String(org._id))).toBe(1);
  });

  it('round-trips the scanner symbology typeName as barcode_type', async () => {
    const { token } = await setupOrg();

    // Exactly what `symbol.typeName` returns from @undecaf/zbar-wasm.
    const res = await postScan(
      token,
      scanBody({ barcode: '32277202523440', barcode_type: 'ZBAR_CODE128' }),
    );

    expect(res.status).toBe(202);
    const stored = await Scan.findOne({ barcode: '32277202523440' });
    expect(stored!.barcode_type).toBe('ZBAR_CODE128');
  });

  it('treats a replayed client_scan_id as a 200 duplicate and never double-counts', async () => {
    const { org, token } = await setupOrg();
    const body = scanBody({ client_scan_id: 'replayed-id' });

    const first = await postScan(token, body);
    const second = await postScan(token, body);

    expect(first.status).toBe(202);
    expect(first.body.data.created).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body.data.created).toBe(false);
    expect(await Scan.countDocuments({ organization_id: org._id })).toBe(1);
    expect(await activeUsed(String(org._id))).toBe(1);
  });

  it('rejects a body with no barcode (400)', async () => {
    const { token } = await setupOrg();

    const res = await postScan(token, scanBody({ barcode: undefined }));

    expect(res.status).toBe(400);
  });

  it('rejects a body with no client_scan_id (400)', async () => {
    const { token } = await setupOrg();

    const res = await postScan(token, scanBody({ client_scan_id: undefined }));

    expect(res.status).toBe(400);
  });

  it('rejects unknown body keys — Joi is strict (400)', async () => {
    const { token } = await setupOrg();

    const res = await postScan(token, scanBody({ not_a_real_field: 'x' }));

    expect(res.status).toBe(400);
  });

  it('requires authentication (401)', async () => {
    await setupOrg();

    const res = await request(app).post('/api/scans').send(scanBody());

    expect(res.status).toBe(401);
  });

  it('hard-stops with 403 once the scan limit is reached', async () => {
    const { org, token } = await setupOrg(1);

    const ok = await postScan(token, scanBody());
    const blocked = await postScan(token, scanBody());

    expect(ok.status).toBe(202);
    expect(blocked.status).toBe(403);
    expect(await activeUsed(String(org._id))).toBe(1);
    expect(await Scan.countDocuments({ organization_id: org._id })).toBe(1);
  });

  it('returns 403 NO_ACTIVE_SUBSCRIPTION when the org has no subscription', async () => {
    const org = await createOrg();
    const user = await createUser('OPERATOR', String(org._id));
    const token = await tokenFor(user);

    const res = await postScan(token, scanBody());

    expect(res.status).toBe(403);
    expect(await Scan.countDocuments({ organization_id: org._id })).toBe(0);
  });

  it('forces a scan into the operator own org, ignoring a foreign organization_id', async () => {
    const { org, user, token } = await setupOrg();
    const otherOrg = await createOrg({ company_name: 'Someone Else' });

    const res = await postScan(
      token,
      scanBody({ organization_id: String(otherOrg._id) }),
    );

    expect(res.status).toBe(202);
    expect(await Scan.countDocuments({ organization_id: otherOrg._id })).toBe(0);
    const mine = await Scan.findOne({ organization_id: org._id });
    expect(mine).toBeTruthy();
    expect(String(mine!.user_id)).toBe(String(user._id));
  });

  it('requires organization_id from a super admin (no org on the token)', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);

    const res = await postScan(token, scanBody());

    // SUPER_ADMIN has no organization_id, so the scan has nothing to attribute to.
    expect(res.status).toBe(400);
  });
});