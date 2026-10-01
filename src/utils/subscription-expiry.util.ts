import moment from 'moment';

export const BILLING_CYCLES = ['month', 'quarterly'] as const;

export const USAGE_RETENTION_DAYS = 365;

export const computeExpiresAt = (
  billingCycle: string,
  trialDays = 0,
  from: Date = new Date(),
): Date => {
  const start = moment(from);
  if (trialDays > 0) {
    start.add(trialDays, 'days');
  }
  if (billingCycle === 'quarterly') {
    return start.add(3, 'months').toDate();
  }
  return start.add(1, 'month').toDate();
};
