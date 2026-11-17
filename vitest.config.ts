import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Set BEFORE config.ts imports (dotenv never overrides preset env vars),
    // so tests run against the scanflow-test DB and a dedicated Redis db 15.
    env: {
      NODE_ENV: 'test',
      REDIS_URL: 'redis://localhost:6379/15',
      CRONZIVO_API_KEY:
        'test-global-key-0123456789abcdef0123456789abcdef',
      CRONZIVO_API_KEY_SECONDARY:
        'rotated-global-key-fedcba9876543210fedcba9876543210',
      CRONZIVO_PRODUCT_CODE: 'SCANFLOW',
      CRONZIVO_ENVIRONMENT: 'PRODUCTION',
      CRONZIVO_ALLOWED_ORIGINS: 'https://panel.test',
      CRONZIVO_MGMT_PREFIX: '/internal/cron',
      CRONZIVO_RECONCILE_SEC: '5',
    },
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    passWithNoTests: true,
  },
});