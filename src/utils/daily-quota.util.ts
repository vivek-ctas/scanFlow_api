/**
 * Pure daily-quota calculations shared by the quota endpoint, the organization
 * details and the dashboards. The panel never recomputes these values.
 */

export interface DailyQuotaBlock {
  limit: number;
  used: number;
  remaining: number;
  utilization_pct: number;
  state: 'ok' | 'near_limit' | 'exhausted';
  reset_at: string;
  timezone: string;
  resets_in_seconds: number;
  /** Super-admin hint only; never returned to other roles. */
  suggested_limit?: number | null;
}

/** Tidy rounding step for a suggested limit. */
export const tidyStep = (value: number): number => {
  if (value < 200) return 10;
  if (value < 1000) return 50;
  return 100;
};

/**
 * Suggests a daily limit from the active subscription: twice the average
 * per-day scans of the actual billing period, rounded up to a tidy step and
 * capped at the cycle limit. `null` when there is nothing to base it on.
 */
export const suggestDailyLimit = (
  scanLimit: number,
  startedAt?: Date | string | null,
  expiresAt?: Date | string | null,
): number | null => {
  const limit = Number(scanLimit) || 0;
  if (limit <= 0 || !startedAt || !expiresAt) {
    return null;
  }
  const start = new Date(startedAt).getTime();
  const end = new Date(expiresAt).getTime();
  const periodDays = (end - start) / 86400000;
  if (!Number.isFinite(periodDays) || periodDays <= 0) {
    return null;
  }
  const raw = Math.ceil((limit / periodDays) * 2);
  if (raw <= 0) {
    return null;
  }
  const step = tidyStep(raw);
  const rounded = Math.ceil(raw / step) * step;
  return Math.min(limit, rounded);
};

export const dailyQuotaState = (
  used: number,
  limit: number,
  alertThresholdPct: number,
): 'ok' | 'near_limit' | 'exhausted' => {
  if (limit > 0 && used >= limit) return 'exhausted';
  if (limit > 0 && (used / limit) * 100 >= alertThresholdPct) {
    return 'near_limit';
  }
  return 'ok';
};

/**
 * Builds the daily block from the organization limit and the live counter.
 * `limit = 0` means the feature is off, so the whole block is `null`.
 */
export const buildDailyQuota = (input: {
  limit: number;
  used: number;
  resetAt: Date;
  timezone: string;
  now?: Date;
  alertThresholdPct: number;
  suggestedLimit?: number | null;
}): DailyQuotaBlock | null => {
  const limit = Math.max(0, Number(input.limit) || 0);
  if (limit === 0) {
    return null;
  }
  const used = Math.max(0, Number(input.used) || 0);
  const now = input.now ?? new Date();
  const remaining = Math.max(0, limit - used);
  const utilizationPct = Math.round((used / limit) * 1000) / 10;
  const resetsInSeconds = Math.max(
    0,
    Math.floor((input.resetAt.getTime() - now.getTime()) / 1000),
  );
  return {
    limit,
    used,
    remaining,
    utilization_pct: utilizationPct,
    state: dailyQuotaState(used, limit, input.alertThresholdPct),
    reset_at: input.resetAt.toISOString(),
    timezone: input.timezone,
    resets_in_seconds: resetsInSeconds,
    ...(input.suggestedLimit !== undefined
      ? { suggested_limit: input.suggestedLimit }
      : {}),
  };
};
