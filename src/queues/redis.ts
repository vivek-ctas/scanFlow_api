import { Redis } from 'ioredis';
import config from '../config/config.js';
import { logger } from '../config/logger.js';

let client: Redis | null = null;

export const isRedisConfigured = () => Boolean(config.redis.url);

export const getRedis = (): Redis => {
  if (!isRedisConfigured()) {
    throw new Error('REDIS_URL is not configured');
  }
  if (!client) {
    client = new Redis(config.redis.url!, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    client.on('error', (err) => {
      logger.error(`[REDIS] client error: ${err.message}`);
    });
    client.connect().catch((err) => {
      logger.error(`[REDIS] connect failed: ${err.message}`);
    });
  }
  return client;
};
