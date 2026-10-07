import type { InvoiceEmailDetails } from './email.types.js';
import {
  buildInvoiceNumber,
  formatBillingCycleLabel,
  formatCurrency,
  formatEmailDate,
  formatGatewayLabel,
} from './format.utils.js';

/** The subset of a Payment row the invoice renderer needs. */
export interface PaymentInvoiceSource {
  _id: { toString(): string } | string;
  price: number;
  currency_code: string;
  billing_cycle: string;
  gateway: string;
  transaction_id?: string | null;
  paid_at?: Date | null;
  invoice_number?: string;
}

export function buildInvoiceEmailDetails(
  payment: PaymentInvoiceSource | null | undefined,
  subscriptionStart?: Date | null,
  subscriptionEnd?: Date | null,
): InvoiceEmailDetails {
  if (!payment) {
    return {
      invoice_number: 'INV-00000000',
      invoice_date: formatEmailDate(new Date()),
      amount: '—',
      currency_code: 'INR',
      billing_cycle: 'month',
      billing_cycle_label: 'Monthly',
      payment_method: 'Online payment',
      transaction_id: '',
      subscription_start: subscriptionStart
        ? formatEmailDate(subscriptionStart)
        : '',
      subscription_end: subscriptionEnd ? formatEmailDate(subscriptionEnd) : '',
    };
  }

  const paymentId =
    typeof payment._id === 'string' ? payment._id : payment._id.toString();

  return {
    invoice_number: payment.invoice_number || buildInvoiceNumber(paymentId),
    invoice_date: formatEmailDate(payment.paid_at || new Date()),
    amount: formatCurrency(payment.price, payment.currency_code),
    currency_code: payment.currency_code,
    billing_cycle: payment.billing_cycle,
    billing_cycle_label: formatBillingCycleLabel(payment.billing_cycle),
    payment_method: formatGatewayLabel(payment.gateway),
    transaction_id: payment.transaction_id || '',
    subscription_start: subscriptionStart
      ? formatEmailDate(subscriptionStart)
      : '',
    subscription_end: subscriptionEnd ? formatEmailDate(subscriptionEnd) : '',
  };
}
