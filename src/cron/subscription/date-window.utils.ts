/** Start of the UTC calendar day containing `date`. */
export const startOfUtcDay = (date: Date): Date =>
  new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );

/** End (inclusive, last millisecond) of the UTC calendar day containing `date`. */
export const endOfUtcDay = (date: Date): Date =>
  new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );

/** Shift a date by a whole number of days, preserving the time-of-day. */
export const shiftUtcDay = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 86_400_000);
