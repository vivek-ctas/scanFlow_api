import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import {
  connectDb,
  disconnectDb,
  clearDb,
  createOrg,
  createUser,
  createAdminUser,
} from './helpers.js';
import { generateAuthTokens } from '../src/services/token.service.js';

const tokenFor = async (user: any) => {
  const tokens = await generateAuthTokens(user as any);
  return tokens.access_token;
};

/** Lists operators through the real HTTP stack and returns the payload. */
const listOperators = async (token: string, query = '') => {
  const res = await request(app)
    .get(`/api/operators${query}`)
    .set('authorization', `Bearer ${token}`);
  return res;
};

beforeEach(async () => {
  await connectDb();
  await clearDb();
});

afterAll(async () => {
  await disconnectDb();
});

describe('POST /api/operators (list scoping)', () => {
  it('never returns the super admin in the operator list', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);

    const res = await listOperators(token);

    expect(res.status).toBe(200);
    expect(res.body.data.total_results).toBe(0);
    expect(res.body.data.results).toHaveLength(0);
  });

  it('lists operators across every customer for a super admin', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);
    const orgA = await createOrg({ company_name: 'Org A' });
    const orgB = await createOrg({ company_name: 'Org B' });
    await createUser('OPERATOR', orgA._id.toString());
    await createUser('ORGANIZATION_ADMIN', orgB._id.toString());

    const res = await listOperators(token);

    expect(res.status).toBe(200);
    expect(res.body.data.total_results).toBe(2);
    const emails = res.body.data.results.map((r: any) => r.email);
    expect(emails).toHaveLength(2);
    expect(emails).not.toContain(admin.email);
    // Both customers are represented.
    const orgIds = res.body.data.results.map(
      (r: any) => r.organization_id?._id ?? r.organization_id?.id,
    );
    expect(orgIds).toContain(orgA._id.toString());
    expect(orgIds).toContain(orgB._id.toString());
  });

  it('scopes an organization admin to their own organization only', async () => {
    const orgA = await createOrg({ company_name: 'Org A' });
    const orgB = await createOrg({ company_name: 'Org B' });
    const ownAdmin = await createUser('ORGANIZATION_ADMIN', orgA._id.toString());
    await createUser('OPERATOR', orgA._id.toString());
    await createUser('OPERATOR', orgB._id.toString());

    const res = await listOperators(await tokenFor(ownAdmin));

    expect(res.status).toBe(200);
    expect(res.body.data.total_results).toBe(2);
    for (const row of res.body.data.results) {
      const orgRef = row.organization_id?._id ?? row.organization_id?.id;
      expect(String(orgRef)).toBe(orgA._id.toString());
    }
  });

  it('honours the role filter', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);
    const org = await createOrg({ company_name: 'Org A' });
    await createUser('OPERATOR', org._id.toString());
    await createUser('ORGANIZATION_ADMIN', org._id.toString());

    const res = await listOperators(token, '?role=ORGANIZATION_ADMIN');

    expect(res.status).toBe(200);
    expect(res.body.data.total_results).toBe(1);
    expect(res.body.data.results[0].role).toBe('ORGANIZATION_ADMIN');
  });

  it('rejects a SUPER_ADMIN role filter as invalid', async () => {
    const admin = await createAdminUser();
    const res = await listOperators(await tokenFor(admin), '?role=SUPER_ADMIN');

    expect(res.status).toBe(400);
  });
});

describe('operator endpoints reject super-admin targets', () => {
  it('does not expose a super admin through GET /:operatorId', async () => {
    const admin = await createAdminUser();
    const target = await createAdminUser();
    const token = await tokenFor(admin);

    const res = await request(app)
      .get(`/api/operators/${target._id}`)
      .set('authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('does not let a super admin deactivate themselves', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);

    const res = await request(app)
      .post(`/api/operators/${admin._id}/update-status`)
      .set('authorization', `Bearer ${token}`)
      .send({ action_type: 'deactivate' });

    expect(res.status).toBe(404);
  });

  it('does not let a super admin change their own role', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);

    const res = await request(app)
      .patch(`/api/operators/${admin._id}/role`)
      .set('authorization', `Bearer ${token}`)
      .send({ role: 'OPERATOR' });

    expect(res.status).toBe(404);
  });

  it('does not let a super admin update or delete themselves', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);

    const put = await request(app)
      .put(`/api/operators/${admin._id}`)
      .set('authorization', `Bearer ${token}`)
      .send({ first_name: 'Hacked' });
    expect(put.status).toBe(404);

    const del = await request(app)
      .delete(`/api/operators/${admin._id}`)
      .set('authorization', `Bearer ${token}`);
    expect(del.status).toBe(404);
  });

  it('still lets a super admin manage a real operator', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);
    const org = await createOrg({ company_name: 'Org A' });
    const operator = await createUser('OPERATOR', org._id.toString());

    const res = await request(app)
      .put(`/api/operators/${operator.id}`)
      .set('authorization', `Bearer ${token}`)
      .send({ first_name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.first_name).toBe('Renamed');
  });

  it('creates an operator that then appears in the super-admin list', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);
    const org = await createOrg({ company_name: 'Org A' });

    const created = await request(app)
      .post('/api/operators')
      .set('authorization', `Bearer ${token}`)
      .send({
        first_name: 'New',
        last_name: 'Op',
        email: 'new-op@example.com',
        organization_id: org._id.toString(),
      });
    expect(created.status).toBe(201);

    const res = await listOperators(token);

    expect(res.body.data.total_results).toBe(1);
    expect(res.body.data.results[0].email).toBe('new-op@example.com');
  });

  it('requires an organization when a super admin creates an operator', async () => {
    const admin = await createAdminUser();
    const token = await tokenFor(admin);

    const res = await request(app)
      .post('/api/operators')
      .set('authorization', `Bearer ${token}`)
      .send({ first_name: 'No', last_name: 'Org', email: 'no-org@example.com' });

    expect(res.status).toBe(400);
  });
});
