import { describe, it, expect } from 'vitest';
import { logger } from '../src/config/logger.js';

describe('logger (§security)', () => {
  it('does not mutate the logged error message', () => {
    const error = new Error('original message');
    const stackBefore = error.stack;

    logger.error(error);

    expect(error.message).toBe('original message');
    expect(error.stack).toBe(stackBefore);
  });
});
