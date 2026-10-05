import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import {
  connectDb,
  disconnectDb,
  clearDb,
  createOrg,
  createPlan,
  createUser,
  grant,
} from './helpers.js';
import { generateAuthTokens } from '../src/services/token.service.js';
import { populateActiveSubCache } from '../src/services/subscription.service.js';

/**
 * Regression guard for the batch optimisation: `assertOrganizationActive`
 * performs an `Organization.findById()` per call, so hoisting it to once per
 * batch is the entire point. Nothing else asserts that — a future refactor
 * could quietly reintroduce the per-item lookup and every functional test
 * would still pass.
 *
 * `vi.mock` is required here rather than reassigning the import: ES module
 * namespaces are read-only, and the spy must be installed BEFORE
 * `scans.service.js` captures the binding at import time.
 */
let assertCalls = 0;

vi.mock('../src/services/quota.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/quota.service.js')>();
  return {
    ...actual,
    assertOrganizationActive: async (...args: any[]) => {
      assertCalls += 1;
      return (actual.assertOrganizationActive as any)(...args);
    },
  };
});

// Imported after vi.mock so the service binds the spy.
const { default: app } = await import('../src/app.js');

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

const item = (n: number | string) => ({
  client_scan_id: `csid-${n}`,
  barcode: `BC-${n}`,
  barcode_type: 'ZBAR_EAN13',
  device_id: 'handheld-1',
});

beforeEach(async () => {
  await connectDb();
  await clearDb();
  assertCalls = 0;
});

afterAll(async () => {
  await disconnectDb();
});

describe('organisation assertion hoisting', () => {
  it('asserts the organisation exactly once for a 5-scan batch', async () => {
    const { token } = await setupOrg();

    const res = await request(app)
      .post('/api/scans/batch')
      .set('authorization', `Bearer ${token}`)
      .send({ scans: [1, 2, 3, 4, 5].map(item) });

    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(5);
    // Without hoisting this would be 5.
    expect(assertCalls).toBe(1);
  });

  it('still asserts once for a 1-scan batch', async () => {
    const { token } = await setupOrg();

    await request(app)
      .post('/api/scans/batch')
      .set('authorization', `Bearer ${token}`)
      .send({ scans: [item(1)] });

    expect(assertCalls).toBe(1);
  });

  it('does NOT hoist on single-scan POST /api/scans — behaviour unchanged', async () => {
    const { token } = await setupOrg();

    await request(app)
      .post('/api/scans')
      .set('authorization', `Bearer ${token}`)
      .send({ client_scan_id: 'single-1', barcode: 'BC-single' });
    await request(app)
      .post('/api/scans')
      .set('authorization', `Bearer ${token}`)
      .send({ client_scan_id: 'single-2', barcode: 'BC-single-2' });

    // Two requests, two assertions — the opt-in param defaults to off.
    expect(assertCalls).toBe(2);
  });

  it('asserts once per batch request, so two batches assert twice', async () => {
    const { token } = await setupOrg();

    await request(app)
      .post('/api/scans/batch')
      .set('authorization', `Bearer ${token}`)
      .send({ scans: [1, 2].map(item) });
    await request(app)
      .post('/api/scans/batch')
      .set('authorization', `Bearer ${token}`)
      .send({ scans: [3, 4].map(item) });

    expect(assertCalls).toBe(2);
  });
});