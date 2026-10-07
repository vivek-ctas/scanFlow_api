/** Invoice line items shown in subscription emails. */
export interface InvoiceEmailDetails {
  invoice_number: string;
  invoice_date: string;
  amount: string;
  currency_code: string;
  billing_cycle: string;
  billing_cycle_label: string;
  payment_method: string;
  transaction_id: string;
  subscription_start: string;
  subscription_end: string;
}

export interface SubscriptionEmailBaseContext {
  first_name: string;
  plan_name: string;
  expired_at: string;
  support_email: string;
  app_name: string;
  invoice: InvoiceEmailDetails;
}

export interface WelcomeEmailContext extends SubscriptionEmailBaseContext {
  features: string[];
  admin_panel_login_url: string;
}

export type RenewalEmailContext = SubscriptionEmailBaseContext;

export interface FutureSubscriptionScheduledContext {
  first_name: string;
  plan_name: string;
  purchased_at: string;
  support_email: string;
  app_name: string;
  invoice: InvoiceEmailDetails;
}

export interface FutureSubscriptionActivatedContext extends SubscriptionEmailBaseContext {
  features: string[];
  admin_panel_login_url: string;
}

export interface ExpiryReminderContext {
  first_name: string;
  plan_name: string;
  days_left: number;
  expires_at: string;
  support_email: string;
  app_name: string;
  renewal_url?: string;
}

export interface ExpiredEmailContext {
  first_name: string;
  plan_name: string;
  expires_at: string;
  support_email: string;
  app_name: string;
  login_url?: string;
}

export interface OtpEmailContext {
  first_name: string;
  otp: string;
  expiry_minutes: number;
  support_email: string;
  app_name: string;
}

export interface EmailLayoutOptions {
  appName: string;
  headerTitle: string;
  headerSubtitle: string;
  supportEmail: string;
  content: string;
}
