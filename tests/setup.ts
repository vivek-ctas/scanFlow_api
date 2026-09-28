import { beforeAll, afterAll, afterEach } from 'vitest';
import { connectDb, disconnectDb, clearDb } from './helpers.js';
import { getRedis } from '../src/queues/redis.js';

beforeAll(async () => {
  await connectDb();
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