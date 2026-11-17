import { CronExpressionParser } from 'cron-parser';

/**
 * Cron expression + timezone helpers. `cron-parser` is authoritative for
 * next-run calculation (including DST); the wrappers below only shape the
 * errors into the contract's codes.
 */
const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

export type CronValidationFailure = 'INVALID_CRON' | 'INVALID_TIMEZONE';

export class CronValidationError extends Error {
  public readonly code: CronValidationFailure;

  constructor(code: CronValidationFailure, message: string) {
    super(message);
    this.name = 'CronValidationError';
    this.code = code;
  }
}

export const assertTimezone = (timezone: string): void => {
  if (typeof timezone !== 'string' || !timezone.trim()) {
    throw new CronValidationError('INVALID_TIMEZONE', 'Invalid timezone');
  }
  try {
    // Throws RangeError for unknown IANA names.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new CronValidationError('INVALID_TIMEZONE', 'Invalid timezone');
  }
};

/** Normalise macros and enforce the 5-field v1 format. */
export const normalizeCronExpression = (expression: string): string => {
  if (typeof expression !== 'string') {
    throw new CronValidationError('INVALID_CRON', 'Invalid cron expression');
  }
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new CronValidationError('INVALID_CRON', 'Invalid cron expression');
  }

  const lowered = trimmed.toLowerCase();
  const normalized = MACROS[lowered] ?? trimmed;

  if (normalized.startsWith('@')) {
    throw new CronValidationError('INVALID_CRON', 'Invalid cron expression');
  }

  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) {
    throw new CronValidationError(
      'INVALID_CRON',
      'Cron expression must have 5 fields',
    );
  }
  if (fields.some((field) => field.length === 0)) {
    throw new CronValidationError('INVALID_CRON', 'Invalid cron expression');
  }

  return fields.join(' ');
};

export const assertValidSchedule = (
  expression: string,
  timezone: string,
): { expression: string; timezone: string } => {
  assertTimezone(timezone);
  const normalized = normalizeCronExpression(expression);
  try {
    CronExpressionParser.parse(normalized, { tz: timezone });
  } catch {
    throw new CronValidationError('INVALID_CRON', 'Invalid cron expression');
  }
  return { expression: normalized, timezone };
};

export const nextRunDate = (
  expression: string,
  timezone: string,
  from: Date = new Date(),
): Date | null => {
  try {
    const interval = CronExpressionParser.parse(expression, {
      tz: timezone,
      currentDate: from,
    });
    if (!interval.hasNext()) return null;
    return interval.next().toDate();
  } catch {
    return null;
  }
};

export const nextRunDates = (
  expression: string,
  timezone: string,
  count = 5,
  from: Date = new Date(),
): Date[] => {
  const interval = CronExpressionParser.parse(expression, {
    tz: timezone,
    currentDate: from,
  });
  const dates: Date[] = [];
  for (let index = 0; index < count; index += 1) {
    if (!interval.hasNext()) break;
    dates.push(interval.next().toDate());
  }
  return dates;
};
