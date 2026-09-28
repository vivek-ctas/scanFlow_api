export interface PlanFeatureEntry {
  features_name: string;
  scan_limit: number;
}

/** Reads the scan feature limit (`0` = unlimited) from a features snapshot. */
export const scanLimitOf = (features: PlanFeatureEntry[] = []): number =>
  features.find((f) => f.features_name === 'scan')?.scan_limit ?? 0;

/** Plan price for a given billing cycle. Throws on a missing quarterly price. */
export const priceForCycle = (
  price: number,
  priceQuarterly: number | null | undefined,
  billingCycle: 'month' | 'quarterly',
): number => {
  if (billingCycle === 'quarterly') {
    if (priceQuarterly === null || priceQuarterly === undefined) {
      throw new Error('PLAN_QUARTERLY_PRICE_REQUIRED');
    }
    return priceQuarterly;
  }
  return price;
};
