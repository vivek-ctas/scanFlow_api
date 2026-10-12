import mongoose from 'mongoose';
import config from '../config/config.js';

/**
 * Timezone-aware date boundaries for the super-admin dashboard.
 *
 * MongoDB stores all timestamps in UTC; the dashboard reads days/months in
 * `config.dashboard.timezone` (IST by default). All boundary maths lives here so
 * the widgets stay consistent and this file can be unit-tested in isolation.
 */

export const dashboardTimezone = (): string => config.dashboard.timezone;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const getFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
};

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of an instant as seen in `timeZone`. */
export const zonedParts = (date: Date, timeZone: string): ZonedParts => {
  const map: Record<string, string> = {};
  for (const part of getFormatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }
  let hour = Number(map.hour);
  if (hour === 24) {
    hour = 0;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
};

/** Offset (ms) such that `utc + offset = wall clock` at `date` in `timeZone`. */
const tzOffsetMs = (date: Date, timeZone: string): number => {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    date.getUTCMilliseconds(),
  );
  return asUtc - date.getTime();
};

/** UTC instant for a wall-clock time in `timeZone`. */
export const zonedTimeToUtc = (
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date => {
  const baseUtc = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  let guess = baseUtc - tzOffsetMs(new Date(baseUtc), timeZone);
  guess = baseUtc - tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
};

export const startOfDayUtc = (date: Date, timeZone: string): Date => {
  const parts = zonedParts(date, timeZone);
  return zonedTimeToUtc(timeZone, parts.year, parts.month, parts.day);
};

export const startOfMonthUtc = (date: Date, timeZone: string): Date => {
  const parts = zonedParts(date, timeZone);
  return zonedTimeToUtc(timeZone, parts.year, parts.month, 1);
};

/** Shift by whole local days (recomputes wall clock each step, DST-safe). */
export const shiftDaysUtc = (
  date: Date,
  timeZone: string,
  deltaDays: number,
): Date => {
  const parts = zonedParts(date, timeZone);
  return zonedTimeToUtc(
    timeZone,
    parts.year,
    parts.month,
    parts.day + deltaDays,
  );
};

export interface MonthWindows {
  monthStart: Date;
  monthToDateEnd: Date;
  previousMonthStart: Date;
  previousMonthSamePeriodEnd: Date;
  previousMonthEnd: Date;
}

/**
 * Month-to-date window plus the previous month over the same elapsed time.
 * `previousMonthSamePeriodEnd` is capped at the current month start so a longer
 * month never counts into the previous month's next month.
 */
export const getMonthWindows = (now: Date, timeZone: string): MonthWindows => {
  const monthStart = startOfMonthUtc(now, timeZone);
  const previousMonthStart = startOfMonthUtc(
    new Date(monthStart.getTime() - 1),
    timeZone,
  );
  const elapsedMs = now.getTime() - monthStart.getTime();
  const previousMonthSamePeriodEnd = new Date(
    Math.min(previousMonthStart.getTime() + elapsedMs, monthStart.getTime()),
  );
  return {
    monthStart,
    monthToDateEnd: now,
    previousMonthStart,
    previousMonthSamePeriodEnd,
    previousMonthEnd: monthStart,
  };
};

export type DashboardRange = '7d' | '30d' | '90d';

export interface ResolvedRange {
  start: Date;
  end: Date;
  days: number;
  previousStart: Date;
  previousEnd: Date;
}

const RANGE_DAYS: Record<DashboardRange, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

const MS_PER_DAY = 86_400_000;

/**
 * Resolve a preset or custom range to [start, end) plus the equal-length
 * previous period. Custom `from`/`to` are whole local days (to inclusive).
 */
export const resolveRange = (
  timeZone: string,
  options: { range?: DashboardRange; from?: Date; to?: Date; now?: Date } = {},
): ResolvedRange => {
  const now = options.now ?? new Date();

  if (options.from && options.to) {
    const start = startOfDayUtc(options.from, timeZone);
    const end = shiftDaysUtc(options.to, timeZone, 1);
    const days = Math.max(
      1,
      Math.round((end.getTime() - start.getTime()) / MS_PER_DAY),
    );
    const previousEnd = start;
    const previousStart = shiftDaysUtc(start, timeZone, -days);
    return { start, end, days, previousStart, previousEnd };
  }

  const range = options.range ?? '30d';
  const days = RANGE_DAYS[range];
  const end = shiftDaysUtc(startOfDayUtc(now, timeZone), timeZone, 1);
  const start = shiftDaysUtc(end, timeZone, -days);
  const previousEnd = start;
  const previousStart = shiftDaysUtc(start, timeZone, -days);
  return { start, end, days, previousStart, previousEnd };
};

export interface DayBucket {
  key: string;
  start: Date;
  end: Date;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Zero-fillable daily buckets covering [start, end) in local days. */
export const dayBuckets = (
  start: Date,
  end: Date,
  timeZone: string,
): DayBucket[] => {
  const buckets: DayBucket[] = [];
  let cursor = startOfDayUtc(start, timeZone);
  while (cursor.getTime() < end.getTime()) {
    const parts = zonedParts(cursor, timeZone);
    const next = zonedTimeToUtc(
      timeZone,
      parts.year,
      parts.month,
      parts.day + 1,
    );
    const key = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    buckets.push({
      key,
      start: cursor,
      end: new Date(Math.min(next.getTime(), end.getTime())),
    });
    cursor = next;
  }
  return buckets;
};

/** ObjectId whose embedded timestamp equals `date` (second precision). */
export const objectIdFromDate = (date: Date): mongoose.Types.ObjectId =>
  mongoose.Types.ObjectId.createFromTime(Math.floor(date.getTime() / 1000));

/**
 * ObjectId covering the end of `date`'s second. ObjectIds only carry
 * second-precision timestamps, so an exclusive `$lt` bound at a fractional
 * instant would drop rows created earlier in that same second (e.g. the scan
 * that just landed counted by month-to-date). Day boundaries are exact
 * midnights, so this is unchanged for preset windows.
 */
const objectIdCeil = (date: Date): mongoose.Types.ObjectId =>
  mongoose.Types.ObjectId.createFromTime(Math.ceil(date.getTime() / 1000));

/**
 * `_id` range for a [start, end) window. Rides the default `_id` index with no
 * extra index on `tbl_scan`, so ingestion write cost is unchanged.
 */
export const objectIdRange = (
  start: Date,
  end: Date,
): { $gte: mongoose.Types.ObjectId; $lt: mongoose.Types.ObjectId } => ({
  $gte: objectIdFromDate(start),
  $lt: objectIdCeil(end),
});

/** Local day key (`YYYY-MM-DD`) for an instant. */
export const dayKey = (date: Date, timeZone: string): string => {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
};
