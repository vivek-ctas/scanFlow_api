import { beforeAll, afterAll, afterEach } from 'vitest';
import {
  connectDb,
  disconnectDb,
  clearDb,
  dropCollections,
  ensureSupportIndexes,
} from './helpers.js';
import { getRedis } from '../src/queues/redis.js';
import { SystemLog } from '../src/models/index.js';
import { setSystemLogModel } from '../src/utils/system-log.js';

setSystemLogModel(SystemLog);

beforeAll(async () => {
  await connectDb();
  // purge stale camelCase indexes from earlier schema versions
  await dropCollections();
  await ensureSupportIndexes();
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
