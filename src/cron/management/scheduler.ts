import { logger } from '../../config/logger.js';
import { nextRunDate } from './cron.js';

export type CronRunner = () => Promise<void>;

export interface SchedulerRegistration {
  id: string;
  expression: string;
  timezone: string;
  nextRun: Date | null;
}

interface Entry extends SchedulerRegistration {
  runner: CronRunner;
  timer: NodeJS.Timeout | null;
}

const MAX_TIMEOUT_MS = 2_147_483_647; // setTimeout 32-bit limit

/**
 * Small timer adapter around `cron-parser`.
 *
 * Each job owns one timer. On fire the runner is awaited and the next timer is
 * scheduled from the current wall clock, so a long run can never queue a burst
 * of catch-up executions. Timers are unref'd to keep shutdown/tests clean.
 */
export class CronSchedulerAdapter {
  private readonly entries = new Map<string, Entry>();

  register(
    id: string,
    expression: string,
    timezone: string,
    runner: CronRunner,
  ): void {
    this.unregister(id);
    const entry: Entry = {
      id,
      expression,
      timezone,
      nextRun: nextRunDate(expression, timezone),
      runner,
      timer: null,
    };
    this.entries.set(id, entry);
    this.arm(id);
  }

  unregister(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(id);
  }

  isRegistered(id: string): boolean {
    return this.entries.has(id);
  }

  getRegistration(id: string): SchedulerRegistration | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return {
      id: entry.id,
      expression: entry.expression,
      timezone: entry.timezone,
      nextRun: entry.nextRun,
    };
  }

  nextRun(id: string): Date | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return nextRunDate(entry.expression, entry.timezone);
  }

  registeredIds(): string[] {
    return [...this.entries.keys()];
  }

  stopAll(): void {
    for (const id of [...this.entries.keys()]) {
      this.unregister(id);
    }
  }

  private arm(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    const nextRun = nextRunDate(entry.expression, entry.timezone);
    entry.nextRun = nextRun;
    if (!nextRun) {
      logger.error(`[CRONZIVO] no next run for job ${id}`);
      return;
    }

    const delay = Math.max(0, nextRun.getTime() - Date.now());
    if (delay > MAX_TIMEOUT_MS) {
      entry.timer = setTimeout(() => this.arm(id), MAX_TIMEOUT_MS);
      entry.timer.unref();
      return;
    }

    entry.timer = setTimeout(() => {
      void this.fire(id);
    }, delay);
    entry.timer.unref();
  }

  private async fire(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      await entry.runner();
    } catch (error) {
      logger.error(
        `[CRONZIVO] scheduled runner ${id} threw: ${(error as Error).message}`,
      );
    } finally {
      this.arm(id);
    }
  }
}
