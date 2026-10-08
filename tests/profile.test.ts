import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import {
  connectDb,
  disconnectDb,
  clearDb,
  createOrg,
  createUser,
  createCountry,
} from './helpers.js';
import { User } from '../src/models/index.js';
import { generateAuthTokens } from '../src/services/token.service.js';

const tokenFor = async (user: any) => {
  const tokens = await generateAuthTokens(user as any);
  return tokens.access_token;
};

const me = async (token: string) =>
  request(app).get('/api/auth/me').set('authorization', `Bearer ${token}`);

const updateMe = async (token: string, body: Record<string, any>) =>
  request(app)
    .patch('/api/auth/me')
    .set('authorization', `Bearer ${token}`)
    .send(body);

beforeEach(async () => {
  await connectDb();
  await clearDb();
});

afterAll(async () => {
  await disconnectDb();
});

describe('GET /api/auth/me', () => {
  it('returns the authenticated user with the editable profile fields', async () => {
    const org = await createOrg({ company_name: 'Test Org' });
    const user = await createUser('OPERATOR', org._id.toString(), {
      first_name: 'Aarav',
      last_name: 'Shah',
      contact_number: '9876543210',
      country_name: 'India',
      company_name: 'Acme Pvt Ltd',
      business_address: 'Mumbai',
    });

    const res = await me(await tokenFor(user));

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(user.email);
    expect(res.body.data.user.first_name).toBe('Aarav');
    expect(res.body.data.user.last_name).toBe('Shah');
    expect(res.body.data.user.contact_number).toBe('9876543210');
    expect(res.body.data.user.country_name).toBe('India');
    expect(res.body.data.user.company_name).toBe('Acme Pvt Ltd');
    expect(res.body.data.user.business_address).toBe('Mumbai');
    expect(res.body.data.user.role).toBe('OPERATOR');
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/auth/me', () => {
  it('updates the allowed fields and persists them', async () => {
    await createCountry({ country_name: 'India', country_code: 'IND' });
    const user = await createUser('OPERATOR', null);

    const res = await updateMe(await tokenFor(user), {
      first_name: 'Riya',
      last_name: 'Patel',
      contact_number: '9123456780',
      country_name: 'india',
      business_address: 'Ahmedabad, Gujarat',
      company_name: 'Patel Traders',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.user.first_name).toBe('Riya');
    expect(res.body.data.user.last_name).toBe('Patel');
    expect(res.body.data.user.contact_number).toBe('9123456780');
    // Multiple spellings resolve to the canonical row's name.
    expect(res.body.data.user.country_name).toBe('India');
    expect(res.body.data.user.business_address).toBe('Ahmedabad, Gujarat');
    expect(res.body.data.user.company_name).toBe('Patel Traders');

    const stored = await User.findById(user.id);
    expect(stored?.first_name).toBe('Riya');
    expect(stored?.last_name).toBe('Patel');
    expect(stored?.contact_number).toBe('9123456780');
    expect(stored?.country_name).toBe('India');
    expect(stored?.business_address).toBe('Ahmedabad, Gujarat');
    expect(stored?.company_name).toBe('Patel Traders');
  });

  it('rejects email, role and status through the profile API', async () => {
    const user = await createUser('OPERATOR', null);

    const res = await updateMe(await tokenFor(user), {
      email: 'not-me@example.com',
      role: 'SUPER_ADMIN',
      is_super_admin: true,
      status: 2,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('"email" is not allowed');

    const stored = await User.findById(user.id);
    expect(stored?.email).toBe(user.email);
    expect(stored?.role).toBe('OPERATOR');
    expect(stored?.is_super_admin).toBe(false);
    expect(stored?.status).toBe(1);
  });

  it('only mutates the own user record', async () => {
    const org = await createOrg({ company_name: 'Shared Org' });
    const a = await createUser('OPERATOR', org._id.toString(), {
      first_name: 'AAA',
    });
    const b = await createUser('OPERATOR', org._id.toString(), {
      first_name: 'BBB',
    });

    await updateMe(await tokenFor(a), {
      first_name: 'Changed',
      contact_number: '9999999999',
    });

    const storedB = await User.findById(b.id);
    expect(storedB?.first_name).toBe('BBB');
    expect(storedB?.contact_number).toBeUndefined();
  });

  it('keeps an unrecognised country and clears an empty one', async () => {
    await createCountry({ country_name: 'India', country_code: 'IND' });
    const user = await createUser('OPERATOR', null, {
      country_name: 'India',
    });

    const untouched = await updateMe(await tokenFor(user), {
      country_name: 'Not A Real Country',
    });
    expect(untouched.status).toBe(200);
    expect(untouched.body.data.user.country_name).toBe('India');

    const cleared = await updateMe(await tokenFor(user), {
      country_name: '',
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.user.country_name).toBeUndefined();
  });

  it('rejects an empty body and invalid values', async () => {
    const user = await createUser('OPERATOR', null);

    const empty = await updateMe(await tokenFor(user), {});
    expect(empty.status).toBe(400);

    const blankFirstName = await updateMe(await tokenFor(user), {
      first_name: '',
    });
    expect(blankFirstName.status).toBe(400);
  });

  it('rejects unauthenticated updates', async () => {
    const res = await request(app).patch('/api/auth/me').send({ first_name: 'X' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('invalidates the refresh token and rejects a second use', async () => {
    const user = await createUser('OPERATOR', null);
    const tokens = await generateAuthTokens(user as any);

    const loggedOut = await request(app)
      .post('/api/auth/logout')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({ refresh_token: tokens.refresh_token });

    expect(loggedOut.status).toBe(200);

    const again = await request(app)
      .post('/api/auth/logout')
      .set('authorization', `Bearer ${tokens.access_token}`)
      .send({ refresh_token: tokens.refresh_token });

    expect(again.status).toBe(404);
  });
});