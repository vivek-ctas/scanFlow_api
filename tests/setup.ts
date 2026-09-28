import { beforeAll, afterAll, afterEach } from 'vitest';
import {
  connectDb,
  disconnectDb,
  clearDb,
  dropCollections,
} from './helpers.js';
import { getRedis } from '../src/queues/redis.js';

beforeAll(async () => {
  await connectDb();
  // purge stale camelCase indexes from earlier schema versions
  await dropCollections();
});

afterEach(async () => {
  await clearDb();
  try {
    const redis = getRedis();
    await redis.flushdb();
  } catch {
    // Redis not configured for this run is fine.
  }
});

afterAll(async () => {
  await disconnectDb();
});
