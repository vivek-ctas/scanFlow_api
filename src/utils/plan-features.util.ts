import type { BillingCycle } from '../models/plan.model.js';

export interface PlanFeatureEntry {
  features_name: string;
  scan_limit: number;
}

/** Minimum plan shape needed to price a cycle. */
export interface PriceablePlan {
  name?: string;
  price: number;
  price_quarterly?: number | null;
  billing_cycle?: BillingCycle;
  discount?: number;
}

/** Sentinel messages the callers map onto HTTP 400 responses. */
export const PLAN_CYCLE_MISMATCH = 'PLAN_CYCLE_MISMATCH';
export const PLAN_QUARTERLY_PRICE_REQUIRED = 'PLAN_QUARTERLY_PRICE_REQUIRED';

/** Human label for a billing cycle, used in API error messages. */
export const billingCycleLabel = (cycle: BillingCycle): string =>
  cycle === 'quarterly' ? 'quarterly' : 'monthly';

/** Reads the scan feature limit (`0` = unlimited) from a features snapshot. */
export const scanLimitOf = (features: PlanFeatureEntry[] = []): number =>
  features.find((f) => f.features_name === 'scan')?.scan_limit ?? 0;

/**
 * Quarterly price for a plan. Always numeric: uses the explicit override when one
 * is supplied, otherwise derives it from the monthly base price minus `discount`
 * percent. `billing_cycle` (not this value) decides which price is charged, so a
 * monthly plan still carries a real quarterly amount.
 */
export const computeQuarterlyPrice = (
  billingCycle: BillingCycle,
  price: number,
  discountPercent = 0,
  quarterlyOverride?: number | null,
): number => {
  if (
    quarterlyOverride !== undefined &&
    quarterlyOverride !== null &&
    Number(quarterlyOverride) > 0
  ) {
    return Math.round(Number(quarterlyOverride) * 100) / 100;
  }
  const base = Number(price) * 3;
  const discount = (base * Number(discountPercent || 0)) / 100;
  return Math.round((base - discount) * 100) / 100;
};

/** Plan price for a given billing cycle. Throws on a missing quarterly price. */
export const priceForCycle = (
  price: number,
  priceQuarterly: number | null | undefined,
  billingCycle: BillingCycle,
): number => {
  if (billingCycle === 'quarterly') {
    if (priceQuarterly === null || priceQuarterly === undefined) {
      throw new Error(PLAN_QUARTERLY_PRICE_REQUIRED);
    }
    return priceQuarterly;
  }
  return price;
};

/**
 * Resolves the amount actually charged for a plan on a billing cycle.
 *
 * `plan.billing_cycle` is the single cycle the plan is sold on, so a request for
 * any other cycle is rejected. `requestedCycle` may be omitted, in which case the
 * plan's own cycle is used.
 */
export const resolvePlanPrice = (
  plan: PriceablePlan,
  requestedCycle?: BillingCycle,
): { billingCycle: BillingCycle; price: number } => {
  const planCycle: BillingCycle = plan.billing_cycle ?? 'month';
  const cycle = requestedCycle ?? planCycle;

  if (cycle !== planCycle) {
    throw new Error(PLAN_CYCLE_MISMATCH);
  }

  return {
    billingCycle: cycle,
    price: priceForCycle(plan.price, plan.price_quarterly, cycle),
  };
};

/** Builds the correct 400 message for whichever sentinel was thrown. */
export const planPriceErrorMessage = (
  plan: PriceablePlan,
  cycle: BillingCycle,
): string => {
  if (plan.billing_cycle && plan.billing_cycle !== cycle) {
    return `${plan.name ?? 'This plan'} is only available on the ${billingCycleLabel(
      plan.billing_cycle,
    )} billing cycle`;
  }
  return 'Quarterly pricing is not configured for this plan';
};
