import { describe, it, expect } from 'vitest';
import { formatAge, getMonthWindows } from '../src/utils/dashboard-time.js';

/**
 * IST is UTC+5:30 and has no DST, which keeps the expected instants stable.
 * `getMonthWindows` must derive month boundaries in the configured timezone,
 * not in raw UTC.
 */
const IST = 'Asia/Kolkata';

describe('getMonthWindows (month-to-date vs same period last month)', () => {
  it('aligns the previous window to the same elapsed period mid-month', () => {
    const now = new Date('2026-10-05T06:30:00.000Z'); // Oct 5 12:00 IST
    const win = getMonthWindows(now, IST);

    expect(win.monthStart.toISOString()).toBe('2026-09-30T18:30:00.000Z'); // Oct 1 00:00 IST
    expect(win.previousMonthStart.toISOString()).toBe(
      '2026-08-31T18:30:00.000Z',
    ); // Sep 1 00:00 IST
    expect(win.previousMonthSamePeriodEnd.toISOString()).toBe(
      '2026-09-05T06:30:00.000Z',
    ); // Sep 5 12:00 IST — exactly four days twelve hours in
    expect(win.previousMonthEnd.toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });

  it('on the first of the month only counts the elapsed sliver, not the whole month', () => {
    const now = new Date('2026-09-30T18:30:30.000Z'); // Oct 1 00:00:30 IST
    const win = getMonthWindows(now, IST);

    const elapsed = now.getTime() - win.monthStart.getTime();
    const prevSpan =
      win.previousMonthSamePeriodEnd.getTime() -
      win.previousMonthStart.getTime();

    expect(elapsed).toBe(30_000);
    expect(prevSpan).toBe(30_000);
    expect(prevSpan).toBeLessThan(86_400_000); // nowhere near a full month
    expect(win.previousMonthSamePeriodEnd.toISOString()).toBe(
      '2026-08-31T18:30:30.000Z',
    );
  });

  it('caps the previous window at the current month start for longer months', () => {
    const now = new Date('2026-03-31T06:30:00.000Z'); // Mar 31 12:00 IST
    const win = getMonthWindows(now, IST);

    // Feb 1 + 30d12h overflows past Mar 1, so it is clamped to month start.
    expect(win.previousMonthStart.toISOString()).toBe(
      '2026-01-31T18:30:00.000Z',
    ); // Feb 1 00:00 IST
    expect(win.previousMonthSamePeriodEnd.toISOString()).toBe(
      win.monthStart.toISOString(),
    );
    expect(win.monthStart.toISOString()).toBe('2026-02-28T18:30:00.000Z'); // Mar 1 00:00 IST
  });

  it('respects the timezone argument (UTC boundaries under UTC)', () => {
    const now = new Date('2026-10-05T06:30:00.000Z');
    const win = getMonthWindows(now, 'UTC');

    expect(win.monthStart.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(win.previousMonthStart.toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
    expect(win.previousMonthSamePeriodEnd.toISOString()).toBe(
      '2026-09-05T06:30:00.000Z',
    );
  });
});

describe('formatAge', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(formatAge(0)).toBe('0s');
    expect(formatAge(45)).toBe('45s');
    expect(formatAge(59)).toBe('59s');
    expect(formatAge(60)).toBe('1m');
    expect(formatAge(20 * 60)).toBe('20m');
    expect(formatAge(59 * 60)).toBe('59m');
    expect(formatAge(3_600)).toBe('1h');
    expect(formatAge(20 * 3_600)).toBe('20h');
    expect(formatAge(23 * 3_600)).toBe('23h');
    expect(formatAge(24 * 3_600)).toBe('1d');
    expect(formatAge(48 * 3_600)).toBe('2d');
  });

  it('clamps negative and fractional input', () => {
    expect(formatAge(-5)).toBe('0s');
    expect(formatAge(90.9)).toBe('1m');
  });
});
