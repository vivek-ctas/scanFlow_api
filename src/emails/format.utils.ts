/** Escape every dynamic value that lands in an email body. */
export const escapeHtml = (value: string | number | null | undefined): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Format an amount already stored in major units (ScanFlow stores `price` in
 * major currency units, unlike the SaaS helper which converts minor units).
 */
export const formatCurrency = (
  amountMajor: number,
  currencyCode?: string,
): string => {
  const code = String(currencyCode || 'usd').toUpperCase();
  const value = Number(amountMajor);
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: code,
    }).format(value);
  } catch {
    return `${code} ${Number.isFinite(value) ? value.toFixed(2) : '0.00'}`;
  }
};

export const formatBillingCycleLabel = (cycle?: string): string => {
  switch (cycle) {
    case 'quarterly':
      return 'Quarterly';
    case 'month':
      return 'Monthly';
    default:
      return cycle ? cycle.charAt(0).toUpperCase() + cycle.slice(1) : 'Monthly';
  }
};

export const formatGatewayLabel = (gateway?: string): string => {
  switch (gateway?.toLowerCase()) {
    case 'razorpay':
      return 'Razorpay';
    case 'stripe':
      return 'Stripe';
    case 'manual':
      return 'Manual payment';
    default:
      return gateway
        ? gateway.charAt(0).toUpperCase() + gateway.slice(1)
        : 'Online payment';
  }
};

export const buildInvoiceNumber = (paymentId?: string): string => {
  const suffix = (paymentId || '')
    .replace(/[^a-f0-9]/gi, '')
    .slice(-8)
    .toUpperCase();
  return `INV-${suffix || '00000000'}`;
};

export const formatEmailDate = (date: Date | string): string => {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
};
