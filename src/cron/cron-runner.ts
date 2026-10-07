import { logger } from '../config/logger.js';
import { errorHandler } from '../utils/system-error.handler.js';

const running = new Set<string>();

/**
 * Executes a scheduled function at most once at a time. The ScanFlow worker is a
 * single process (docker-compose `worker` service), so an in-process guard is
 * sufficient to prevent overlapping runs. Logs start/completion with duration
 * and records failures both to the logger and the persisted system-error store,
 * mirroring the SaaS `runWithLogging` + scheduler running-flag behaviour.
 */
export const withCronRun = async <T>(
  title: string,
  fn: () => Promise<T>,
): Promise<T | undefined> => {
  if (running.has(title)) {
    logger.warn(
      `[CRON] ${title} is already running — skipping overlapping run`,
    );
    return undefined;
  }
  running.add(title);
  const started = Date.now();
  logger.info(`[CRON] ${title} starting`);
  try {
    const result = await fn();
    logger.info(`[CRON] ${title} completed in ${Date.now() - started}ms`);
    return result;
  } catch (err) {
    logger.error(
      `[CRON] ${title} failed after ${Date.now() - started}ms: ${(err as Error).message}`,
    );
    await errorHandler.errorM({
      action_type: `cron-${title}`,
      error_data: err,
    });
    return undefined;
  } finally {
    running.delete(title);
  }
};
