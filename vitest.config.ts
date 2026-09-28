import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Set BEFORE config.ts imports (dotenv never overrides preset env vars),
    // so tests run against the scanflow-test DB and a dedicated Redis db 15.
    env: {
      NODE_ENV: 'test',
      REDIS_URL: 'redis://localhost:6379/15',
    },
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    passWithNoTests: true,
  },
});