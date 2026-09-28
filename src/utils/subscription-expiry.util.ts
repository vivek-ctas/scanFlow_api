import moment from 'moment';

export const BILLING_CYCLES = ['monthly', 'yearly'] as const;

export const USAGE_RETENTION_DAYS = 365;

export const computeExpiresAt = (
  billingCycle: string,
  trialDays = 0,
  from: Date = new Date(),
): Date => {
  if (trialDays > 0) {
    return moment(from).add(trialDays, 'days').toDate();
  }
  if (billingCycle === 'yearly') {
    return moment(from).add(1, 'year').toDate();
  }
  return moment(from).add(1, 'month').toDate();
};
