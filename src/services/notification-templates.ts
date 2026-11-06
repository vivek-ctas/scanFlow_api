import type { NotificationSeverity } from '../models/notification.model.js';

/**
 * Every notification title/message is built here (plan §5.4). Producers only
 * supply the event data; no producer assembles user-facing strings itself.
 * User-supplied text is limited to the ticket subject and organization name,
 * and `createForUsers` truncates it before storage.
 */

export interface NotificationTemplate {
  title: string;
  message: string;
  severity: NotificationSeverity;
  action_url: string;
}

export type SupportTemplateEvent =
  'ticket_created' | 'customer_replied' | 'staff_replied' | 'status_changed';

export interface SupportTemplateInput {
  event: SupportTemplateEvent;
  ticketNo: string;
  subject: string;
  organizationName: string;
  status?: string | null;
}

export interface SupportTemplate {
  title: string;
  message: string;
}

export const supportNotificationTemplate = ({
  event,
  ticketNo,
  subject,
  organizationName,
  status,
}: SupportTemplateInput): SupportTemplate => {
  switch (event) {
    case 'ticket_created':
      return {
        title: `New support ticket ${ticketNo}`,
        message: `${organizationName}: ${subject}`,
      };
    case 'customer_replied':
      return {
        title: `New reply on ${ticketNo}`,
        message: `${organizationName}: ${subject}`,
      };
    case 'staff_replied':
      return {
        title: 'ScanFlow Support replied',
        message: `New reply on ${ticketNo}: ${subject}`,
      };
    case 'status_changed': {
      const resolved = status === 'resolved';
      return {
        title: `Ticket ${ticketNo} ${resolved ? 'resolved' : 'closed'}`,
        message: resolved
          ? `Your ticket ${ticketNo} has been resolved.`
          : `Your ticket ${ticketNo} has been closed.`,
      };
    }
  }
};

export interface QuotaTemplateInput {
  level: number;
  usage: number;
  scanLimit: number;
}

export const quotaNotificationTemplate = ({
  level,
  usage,
  scanLimit,
}: QuotaTemplateInput): NotificationTemplate => {
  if (level >= 100) {
    return {
      severity: 'critical',
      title: 'Scan limit reached',
      message: `You have used 100% of your scan limit (${usage} of ${scanLimit}). New scans are rejected until your plan is renewed.`,
      action_url: '/',
    };
  }

  if (level >= 90) {
    return {
      severity: 'warning',
      title: `${level}% of your scan limit used`,
      message: `You have used ${level}% of your scan limit (${usage} of ${scanLimit}). Contact support to extend before scanning stops.`,
      action_url: '/',
    };
  }

  return {
    severity: 'warning',
    title: `${level}% of your scan limit used`,
    message: `You have used ${level}% of your scan limit (${usage} of ${scanLimit}).`,
    action_url: '/',
  };
};

export interface SubscriptionReminderTemplateInput {
  days: number;
  planName: string;
  queuedNextPlan: boolean;
}

export const subscriptionReminderTemplate = ({
  days,
  planName,
  queuedNextPlan,
}: SubscriptionReminderTemplateInput): NotificationTemplate => {
  const when = days === 1 ? 'tomorrow' : `in ${days} days`;

  return {
    severity: 'info',
    title:
      days === 1
        ? 'Your plan expires tomorrow'
        : `Your plan expires in ${days} days`,
    message: queuedNextPlan
      ? `${planName} expires ${when}. Your next plan starts automatically.`
      : `${planName} expires ${when}. Renew to keep scanning without interruption.`,
    action_url: '/support',
  };
};

export const subscriptionExpiredTemplate = (): NotificationTemplate => ({
  severity: 'critical',
  title: 'Your subscription has expired',
  message: 'New scans are being rejected until a plan is assigned.',
  action_url: '/subscription',
});

export interface PlanAssignedTemplateInput {
  planName: string;
  activated: boolean;
}

export const planAssignedTemplate = ({
  planName,
  activated,
}: PlanAssignedTemplateInput): NotificationTemplate => ({
  severity: 'info',
  title: activated ? 'Plan activated' : 'Plan scheduled',
  message: activated
    ? `${planName} has been activated for your organization.`
    : `${planName} has been scheduled for your organization.`,
  action_url: '/subscription',
});
