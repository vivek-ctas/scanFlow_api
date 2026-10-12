import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import app from '../src/app.js';
import { User, UserSession } from '../src/models/index.js';
import {
  connectDb,
  disconnectDb,
  clearDb,
  createOrg,
  createOperator,
  createAdminUser,
} from './helpers.js';
import { generateAuthTokens } from '../src/services/token.service.js';

const login = (operatorId: string, pin: string) =>
  request(app)
    .post('/api/auth/login-pin')
    .send({ operator_id: operatorId, pin });

beforeEach(async () => {
  await connectDb();
  await clearDb();
});

afterAll(async () => {
  await disconnectDb();
});

describe('POST /api/auth/login-pin', () => {
  it('logs an operator in with a correct Operator ID + PIN (case-insensitive id)', async () => {
    const org = await createOrg({ company_name: 'Test Org' });
    await createOperator(org._id.toString(), {
      operator_id: 'OR1001',
      pin: '123456',
    });

    const res = await login('or1001', '123456');

    expect(res.status).toBe(200);
    expect(res.body.data.tokens.access_token).toBeTruthy();
    expect(res.body.data.tokens.refresh_token).toBeTruthy();
    expect(res.body.data.user.operator_id).toBe('OR1001');
    expect(res.body.data.user.role).toBe('OPERATOR');
    // PIN material and lockout state never leak.
    expect(res.body.data.user.pin_hash).toBeUndefined();
    expect(res.body.data.user.pin_attempt_count).toBeUndefined();
    expect(res.body.data.user.pin_locked_until).toBeUndefined();
  });

  it('accepts operators that have no email address', async () => {
    const org = await createOrg({ company_name: 'Test Org' });
    await createOperator(org._id.toString(), {
      operator_id: 'OR2001',
      pin: '654321',
    });

    const res = await login('OR2001', '654321');

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBeUndefined();
  });

  it('rejects a wrong PIN with a generic message', async () => {
    const org = await createOrg({ company_name: 'Test Org' });
    await createOperator(org._id.toString(), {
      operator_id: 'OR2002',
      pin: '123456',
    });

    const res = await login('OR2002', '000000');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid Operator ID or PIN.');
  });

  it('does not reveal whether an Operator ID exists (anti-enumeration)', async () => {
    const res = await login('XX999999', '123456');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid Operator ID or PIN.');
  });

  it('rejects a malformed Operator ID or PIN shape', async () => {
    expect((await login('OR2002', '12345')).status).toBe(400);
    expect((await login('ORX2002', '123456')).status).toBe(400);
    expect((await login('or2002', '123456')).status).toBe(400);
  });

  it('locks the account after 5 consecutive wrong attempts', async () => {
    const org = await createOrg({ company_name: 'Test Org' });
    await createOperator(org._id.toString(), {
      operator_id: 'OR3001',
      pin: '123456',
    });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await login('OR3001', '000000');
      expect(res.status).toBe(400);
    }

    const lock = await login('OR3001', '000000');
    expect(lock.status).toBe(429);
    expect(lock.body.message).toContain('Too many attempts');

    const locked = await User.findOne({ operator_id: 'OR3001' });
    expect(locked?.pin_locked_until).toBeTruthy();
    expect(locked?.pin_attempt_count).toBe(0);

    // Even a correct PIN is refused while locked out.
    const afterLock = await login('OR3001', '123456');
    expect(afterLock.status).toBe(429);
  });

  it('allows login again once the lock expires and resets the counter', async () => {
    const org = await createOrg({ company_name: 'Test Org' });
    await createOperator(org._id.toString(), {
      operator_id: 'OR3101',
      pin: '123456',
    });
    await User.updateOne(
      { operator_id: 'OR3101' },
      { $set: { pin_locked_until: new Date(Date.now() - 1000) } },
    );

    const res = await login('OR3101', '123456');

    expect(res.status).toBe(200);
    const user = await User.findOne({ operator_id: 'OR3101' });
    expect(user?.pin_attempt_count).toBe(0);
    expect(user?.pin_locked_until).toBeNull();
  });

  it('never logs an operator in under another organization', async () => {
    const orgA = await createOrg({ company_name: 'Org A' });
    const orgB = await createOrg({ company_name: 'Org B' });
    await createOperator(orgA._id.toString(), {
      operator_id: 'OR4001',
      pin: '123456',
    });

    const res = await login('OR4001', '123456');

    expect(res.status).toBe(200);
    expect(String(res.body.data.user.organization_id)).toBe(
      orgA._id.toString(),
    );
    expect(String(res.body.data.user.organization_id)).not.toBe(
      orgB._id.toString(),
    );
  });

  it('globally enforces Operator ID uniqueness at the DB level', async () => {
    const orgA = await createOrg({ company_name: 'Org A' });
    const orgB = await createOrg({ company_name: 'Org B' });
    await createOperator(orgA._id.toString(), { operator_id: 'ZZ7777' });

    await expect(
      User.create({
        first_name: 'Other',
        last_name: 'Org',
        role: 'OPERATOR',
        organization_id: orgB._id.toString(),
        operator_id: 'ZZ7777',
        status: 1,
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('issues a JWT that authorizes protected endpoints with the operator org', async () => {
    const org = await createOrg({ company_name: 'Test Org' });
    await createOperator(org._id.toString(), {
      operator_id: 'OR5001',
      pin: '123456',
    });

    const res = await login('OR5001', '123456');
    const token = res.body.data.tokens.access_token;

    const me = await request(app)
      .get('/api/auth/me')
      .set('authorization', `Bearer ${token}`);

    expect(me.status).toBe(200);
    expect(me.body.data.user.role).toBe('OPERATOR');
  });
});

describe('OTP login is rejected for OPERATOR role', () => {
  it('refuses to send an OTP to an operator email', async () => {
    const org = await createOrg({ company_name: 'Test Org' });
    await createOperator(org._id.toString(), {
      operator_id: 'OR6001',
      pin: '123456',
      email: 'operator@example.com',
    });

    const res = await request(app)
      .post('/api/auth/send-otp')
      .send({ email: 'operator@example.com' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Operator ID and PIN');
  });

  it('refuses to verify an OTP for an operator even with a valid session', async () => {
    const org = await createOrg({ company_name: 'Test Org' });
    await createOperator(org._id.toString(), {
      operator_id: 'OR6101',
      pin: '123456',
      email: 'operator2@example.com',
    });
    await UserSession.create({
      email: 'operator2@example.com',
      hash_otp: bcrypt.hashSync('555666', 8),
      expired_at: new Date(Date.now() + 5 * 60 * 1000),
    });

    const res = await request(app)
      .post('/api/auth/verify-otp')
      .send({ email: 'operator2@example.com', otp: '555666' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Operator ID and PIN');
  });
});

describe('parallel operator creation', () => {
  it('allocates unique Operator IDs under concurrency', async () => {
    const admin = await createAdminUser();
    const tokens = await generateAuthTokens(admin as any);
    const org = await createOrg({ company_name: 'Test Org' });

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        request(app)
          .post('/api/operators')
          .set('authorization', `Bearer ${tokens.access_token}`)
          .send({
            first_name: `Op${i}`,
            last_name: 'Bulk',
            role: 'OPERATOR',
            pin: '123456',
            organization_id: org._id.toString(),
          }),
      ),
    );

    for (const r of results) {
      expect(r.status).toBe(201);
    }
    const ids = results.map((r: any) => r.body.data.user.operator_id);
    expect(new Set(ids).size).toBe(20);
    expect(ids.every((id: string) => /^TE\d+$/.test(String(id)))).toBe(true);

    const users = await User.countDocuments({ organization_id: org._id });
    expect(users).toBe(20);
  });
});
