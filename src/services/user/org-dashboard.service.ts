import mongoose from 'mongoose';
import { Scan } from '../../models/scan.model.js';
import { User } from '../../models/user.model.js';
import { Usage } from '../../models/usage.model.js';
import { Subscription } from '../../models/subscription.model.js';
import { WebhookConfig } from '../../models/webhook-config.model.js';
import { WebhookDelivery } from '../../models/webhook-delivery.model.js';
import { Organization } from '../../models/organization.model.js';
import { getRedis, isRedisConfigured } from '../../queues/redis.js';
import { getSubscriptionSummary } from '../subscription.service.js';
import { getUsageTrend } from '../subscription.service.js';
import {
  dashboardTimezone,
  startOfDayUtc,
} from '../../utils/dashboard-time.js';

export interface OrgSummary {
  organization_id: string;
  organization_name: string;
  timezone: string;
  generated_at: string;
  scans: {
    today: number;
    today_start: string;
  };
  operators: {
    active: number;
    inactive: number;
    total: number;
  };
  webhook: {
    state: 'not_configured' | 'disabled' | 'enabled';
    failed_24h: number | null;
  };
}

export interface OrgQuota {
  state: 'ok' | 'near_limit' | 'exhausted' | 'expiring' | 'no_subscription';
  plan_name: string;
  billing_cycle: string;
  is_trial: boolean;
  scan_limit: number;
  unlimited: boolean;
  used: number;
  remaining: number | null;
  utilization_pct: number | null;
  period_start: string;
  period_end: string;
  days_left: number;
  next_plan_queued: boolean;
  source: 'live' | 'mirror';
  as_of: string;
}

export const getOrgSummary = async (
  organizationId: string,
): Promise<OrgSummary> => {
  const orgId = new mongoose.Types.ObjectId(organizationId);
  const now = new Date();
  const tz = dashboardTimezone();
  const todayStart = startOfDayUtc(now, tz);

  const [scansToday, operators, webhookConfig] = await Promise.all([
    Scan.countDocuments({
      organization_id: orgId,
      scanned_at: { $gte: todayStart },
    }),
    User.aggregate([
      {
        $match: {
          organization_id: orgId,
          role: 'OPERATOR',
          status: { $ne: 2 },
        },
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    WebhookConfig.findOne({ organization_id: orgId }).select('enabled').lean(),
  ]);

  const operatorCounts = { active: 0, inactive: 0, total: 0 };
  for (const op of operators) {
    if (op._id === 1) operatorCounts.active = op.count;
    else if (op._id === 0) operatorCounts.inactive = op.count;
  }
  operatorCounts.total = operatorCounts.active + operatorCounts.inactive;

  let webhookState: 'not_configured' | 'disabled' | 'enabled' =
    'not_configured';
  if (webhookConfig) {
    webhookState = webhookConfig.enabled ? 'enabled' : 'disabled';
  }

  const failed24h =
    webhookState === 'enabled'
      ? await WebhookDelivery.countDocuments({
          organization_id: orgId,
          status: 'failed',
          last_attempt_at: { $gte: new Date(Date.now() - 24 * 3600000) },
          last_error: { $ne: 'No enabled webhook config for organization' },
        })
      : null;

  const org = await Organization.findById(orgId).select('company_name').lean();

  return {
    organization_id: organizationId,
    organization_name: org?.company_name ?? 'Unknown',
    timezone: tz,
    generated_at: now.toISOString(),
    scans: {
      today: scansToday,
      today_start: todayStart.toISOString(),
    },
    operators: operatorCounts,
    webhook: {
      state: webhookState,
      failed_24h: failed24h,
    },
  };
};

const NEAR_LIMIT_PCT = Number(process.env.DASHBOARD_NEAR_LIMIT_PCT ?? 90);

export const getOrgQuota = async (
  organizationId: string,
): Promise<OrgQuota> => {
  const orgId = new mongoose.Types.ObjectId(organizationId);
  const now = new Date();

  const subscription = await Subscription.findOne({
    organization_id: orgId,
    status: 'active',
  })
    .sort({ started_at: -1 })
    .lean();

  if (!subscription) {
    return {
      state: 'no_subscription',
      plan_name: '',
      billing_cycle: '',
      is_trial: false,
      scan_limit: 0,
      unlimited: true,
      used: 0,
      remaining: null,
      utilization_pct: null,
      period_start: now.toISOString(),
      period_end: now.toISOString(),
      days_left: 0,
      next_plan_queued: false,
      source: 'mirror',
      as_of: now.toISOString(),
    };
  }

  const planName = subscription.plan_name ?? '';
  const billingCycle = subscription.billing_cycle ?? '';
  const isTrial = subscription.trial_days > 0;
  const scanLimit =
    subscription.features?.find((f: any) => f.features_name === 'scan')
      ?.scan_limit ?? 0;
  const unlimited = scanLimit === 0;

  const expiresAt = new Date(subscription.expires_at);
  const periodStart = new Date(subscription.started_at);
  const periodEnd = expiresAt;
  const daysLeft = Math.max(
    0,
    Math.ceil((expiresAt.getTime() - now.getTime()) / 86400000),
  );

  const futureSub = await Subscription.findOne({
    organization_id: orgId,
    status: 'future',
  }).lean();

  const nextPlanQueued = !!futureSub;

  let used = 0;
  let source: 'live' | 'mirror' = 'mirror';

  if (isRedisConfigured()) {
    try {
      const redis = getRedis();
      const cached = await redis.hmget(
        `org:${organizationId}:activeSub`,
        'used',
        'expiresAt',
      );
      if (
        cached[0] !== null &&
        cached[1] &&
        new Date(cached[1]).getTime() > now.getTime()
      ) {
        used = Number(cached[0]);
        source = 'live';
      }
    } catch {
      source = 'mirror';
    }
  }

  if (source === 'mirror') {
    const usage = await Usage.findOne({
      subscription_id: subscription._id,
    }).lean();
    used = usage?.usage ?? 0;
  }

  const remaining = unlimited ? null : Math.max(0, scanLimit - used);
  const utilizationPct = unlimited
    ? null
    : scanLimit > 0
      ? Math.round((used / scanLimit) * 100)
      : null;

  let state: OrgQuota['state'] = 'ok';
  if (unlimited) {
    state = 'ok';
  } else if (used >= scanLimit) {
    state = 'exhausted';
  } else if (utilizationPct !== null && utilizationPct >= NEAR_LIMIT_PCT) {
    state = 'near_limit';
  } else if (daysLeft <= 7) {
    state = 'expiring';
  }

  return {
    state,
    plan_name: planName,
    billing_cycle: billingCycle,
    is_trial: isTrial,
    scan_limit: scanLimit,
    unlimited,
    used,
    remaining,
    utilization_pct: utilizationPct,
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    days_left: daysLeft,
    next_plan_queued: nextPlanQueued,
    source,
    as_of: now.toISOString(),
  };
};

export interface OrgScanTrend {
  range: string;
  timezone: string;
  points: { date: string; count: number }[];
  comparison: { date: string; count: number }[] | null;
  peak_hour: { hour: number; count: number } | null;
}

export const getOrgScanTrend = async (
  organizationId: string,
  params: {
    range?: string;
    from?: Date;
    to?: Date;
    compare?: boolean;
  },
): Promise<OrgScanTrend> => {
  const orgId = new mongoose.Types.ObjectId(organizationId);
  const tz = dashboardTimezone();
  const now = new Date();

  let from = params.from;
  let to = params.to;
  const range = params.range ?? '30d';

  if (!from || !to) {
    const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
    to = new Date();
    from = new Date(to.getTime() - days * 86400000);
  }

  const match = {
    organization_id: new mongoose.Types.ObjectId(organizationId),
    scanned_at: { $gte: from, $lte: to },
  };

  const points = await Scan.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: '$scanned_at',
            timezone: tz,
          },
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const pointMap = new Map(points.map((p) => [p._id, p.count]));
  const allDates: { date: string; count: number }[] = [];
  const current = new Date(from);
  while (current <= to) {
    const dateStr = current.toISOString().split('T')[0] ?? '';
    allDates.push({ date: dateStr, count: pointMap.get(dateStr) ?? 0 });
    current.setDate(current.getDate() + 1);
  }

  let comparison: { date: string; count: number }[] | null = null;
  if (params.compare) {
    const prevFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
    const prevTo = new Date(from.getTime() - 1);
    const prevMatch = {
      organization_id: new mongoose.Types.ObjectId(organizationId),
      scanned_at: { $gte: prevFrom, $lte: prevTo },
    };
    const prevPoints = await Scan.aggregate([
      { $match: prevMatch },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$scanned_at',
              timezone: tz,
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const prevMap = new Map(prevPoints.map((p) => [p._id, p.count]));
    const comparisonDates: { date: string; count: number }[] = [];
    current.setTime(prevFrom.getTime());
    while (current <= prevTo) {
      const dateStr = current.toISOString().split('T')[0] ?? '';
      comparisonDates.push({ date: dateStr, count: prevMap.get(dateStr) ?? 0 });
      current.setDate(current.getDate() + 1);
    }
    comparison = comparisonDates;
  }

  let peakHour = null;
  const hourAgg = await Scan.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $hour: { date: '$scanned_at', timezone: tz } },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 1 },
  ]);
  if (hourAgg.length) {
    peakHour = { hour: hourAgg[0]._id, count: hourAgg[0].count };
  }

  return {
    range,
    timezone: tz,
    points: allDates,
    comparison,
    peak_hour: peakHour,
  };
};

export interface OrgTeam {
  top_operators: { user_id: string; name: string; scans: number }[];
  quiet_operators: { user_id: string; name: string }[];
  window_days: { top: number; quiet: number };
}

export const getOrgTeam = async (organizationId: string): Promise<OrgTeam> => {
  const orgId = new mongoose.Types.ObjectId(organizationId);
  const now = new Date();
  const tz = dashboardTimezone();
  const topFrom = new Date(now.getTime() - 30 * 86400000);
  const quietFrom = new Date(now.getTime() - 7 * 86400000);

  const activeOperators = await User.find(
    { organization_id: orgId, role: 'OPERATOR', status: 1 },
    { _id: 1, first_name: 1, last_name: 1 },
  ).lean();

  const operatorIds = activeOperators.map((u) => u._id);

  const [topAgg, quietAgg] = await Promise.all([
    Scan.aggregate([
      {
        $match: {
          organization_id: orgId,
          user_id: { $in: operatorIds },
          scanned_at: { $gte: topFrom },
        },
      },
      { $group: { _id: '$user_id', scans: { $sum: 1 } } },
      { $sort: { scans: -1 } },
      { $limit: 10 },
    ]),
    Scan.aggregate([
      {
        $match: {
          organization_id: orgId,
          user_id: { $in: operatorIds },
          scanned_at: { $gte: quietFrom },
        },
      },
      { $group: { _id: '$user_id' } },
    ]),
  ]);

  const quietScanned = new Set(quietAgg.map((a) => String(a._id)));
  const quietOperators = activeOperators
    .filter((u) => !quietScanned.has(String(u._id)))
    .map((u) => ({
      user_id: String(u._id),
      name: `${u.first_name} ${u.last_name}`.trim(),
    }));

  const nameMap = new Map(
    activeOperators.map((u) => [
      String(u._id),
      `${u.first_name} ${u.last_name}`.trim(),
    ]),
  );
  const topOperators = topAgg.map((a) => ({
    user_id: String(a._id),
    name: nameMap.get(String(a._id)) ?? 'Unknown',
    scans: a.scans,
  }));

  return {
    top_operators: topOperators,
    quiet_operators: quietOperators,
    window_days: { top: 30, quiet: 7 },
  };
};

export interface OrgWebhooks {
  state: 'not_configured' | 'disabled' | 'enabled';
  window_hours: number;
  delivered_24h: number | null;
  failed_24h: number | null;
  pending: number | null;
  oldest_pending_age_seconds: number | null;
  oldest_pending_age: string | null;
  last_error: { summary: string; at: string } | null;
}

export const getOrgWebhooks = async (
  organizationId: string,
): Promise<OrgWebhooks> => {
  const orgId = new mongoose.Types.ObjectId(organizationId);
  const configDoc = await WebhookConfig.findOne({ organization_id: orgId })
    .select('enabled')
    .lean();

  let state: 'not_configured' | 'disabled' | 'enabled' = 'not_configured';
  if (configDoc) {
    state = configDoc.enabled ? 'enabled' : 'disabled';
  }

  if (state !== 'enabled') {
    return {
      state,
      window_hours: 24,
      delivered_24h: null,
      failed_24h: null,
      pending: null,
      oldest_pending_age_seconds: null,
      oldest_pending_age: null,
      last_error: null,
    };
  }

  const now = new Date();
  const since = new Date(now.getTime() - 24 * 3600000);

  const [delivered24h, failed24h, pending, oldestPending, lastErrorDelivery] =
    await Promise.all([
      WebhookDelivery.countDocuments({
        organization_id: orgId,
        status: 'delivered',
        delivered_at: { $gte: since },
      }),
      WebhookDelivery.countDocuments({
        organization_id: orgId,
        status: 'failed',
        last_attempt_at: { $gte: since },
        last_error: { $ne: 'No enabled webhook config for organization' },
      }),
      WebhookDelivery.countDocuments({
        organization_id: orgId,
        status: 'pending',
      }),
      WebhookDelivery.findOne({ organization_id: orgId, status: 'pending' })
        .sort({ created_at: 1 })
        .select('created_at')
        .lean(),
      WebhookDelivery.findOne({ organization_id: orgId, status: 'failed' })
        .sort({ created_at: -1 })
        .select('last_error created_at')
        .lean(),
    ]);

  const oldestPendingAgeSeconds = oldestPending
    ? Math.floor((now.getTime() - oldestPending.created_at.getTime()) / 1000)
    : null;

  return {
    state,
    window_hours: 24,
    delivered_24h: delivered24h,
    failed_24h: failed24h,
    pending,
    oldest_pending_age_seconds: oldestPendingAgeSeconds,
    oldest_pending_age: oldestPendingAgeSeconds
      ? `${Math.floor(oldestPendingAgeSeconds / 3600)}h`
      : null,
    last_error: lastErrorDelivery
      ? {
          summary:
            lastErrorDelivery.last_error?.substring(0, 200) ?? 'Unknown error',
          at: lastErrorDelivery.created_at.toISOString(),
        }
      : null,
  };
};

export interface OrgAttention {
  items: {
    type: string;
    severity: 'critical' | 'warning' | 'info';
    data: Record<string, any>;
  }[];
}

export const getOrgAttention = async (
  organizationId: string,
): Promise<OrgAttention> => {
  const orgId = new mongoose.Types.ObjectId(organizationId);
  const now = new Date();

  const [quota, subscription, webhookConfig] = await Promise.all([
    Usage.findOne({ organization_id: orgId }).sort({ created_at: -1 }).lean(),
    Subscription.findOne({ organization_id: orgId, status: 'active' })
      .sort({ started_at: -1 })
      .lean(),
    WebhookConfig.findOne({ organization_id: orgId }).select('enabled').lean(),
  ]);

  const items: OrgAttention['items'] = [];

  if (!subscription) {
    items.push({
      type: 'no_subscription',
      severity: 'critical',
      data: { message: 'No active subscription. Scanning is blocked.' },
    });
  } else {
    const planLimit =
      subscription.features?.find((f: any) => f.features_name === 'scan')
        ?.scan_limit ?? 0;
    const unlimited = planLimit === 0;
    const used = quota?.usage ?? 0;

    if (!unlimited) {
      const utilization =
        planLimit > 0 ? Math.round((used / planLimit) * 100) : 0;
      if (used >= planLimit) {
        items.push({
          type: 'quota_exhausted',
          severity: 'critical',
          data: { used, limit: planLimit, utilization_pct: 100 },
        });
      } else if (utilization >= 90) {
        items.push({
          type: 'quota_near_limit',
          severity: 'warning',
          data: { used, limit: planLimit, utilization_pct: utilization },
        });
      }
    }

    const expiresAt = new Date(subscription.expires_at);
    const daysLeft = Math.ceil(
      (expiresAt.getTime() - now.getTime()) / 86400000,
    );
    if (daysLeft <= 7) {
      const futureSub = await Subscription.findOne({
        organization_id: orgId,
        status: 'future',
      }).lean();
      items.push({
        type: 'subscription_expiring',
        severity: futureSub ? 'info' : 'warning',
        data: { days_left: daysLeft, next_plan_queued: !!futureSub },
      });
    }
  }

  if (webhookConfig) {
    if (!webhookConfig.enabled) {
      items.push({
        type: 'webhook_disabled',
        severity: 'info',
        data: { message: 'Webhooks are configured but disabled.' },
      });
    } else {
      const failed24h = await WebhookDelivery.countDocuments({
        organization_id: orgId,
        status: 'failed',
        last_attempt_at: { $gte: new Date(now.getTime() - 24 * 3600000) },
        last_error: { $ne: 'No enabled webhook config for organization' },
      });
      if (failed24h > 0) {
        items.push({
          type: 'webhook_failing',
          severity: 'warning',
          data: { failed_24h: failed24h },
        });
      }
    }
  } else {
    items.push({
      type: 'webhook_not_configured',
      severity: 'info',
      data: { message: 'Webhooks are not configured.' },
    });
  }

  const activeOperators = await User.countDocuments({
    organization_id: orgId,
    role: 'OPERATOR',
    status: 1,
  });
  if (activeOperators > 0) {
    const quietFrom = new Date(now.getTime() - 7 * 86400000);
    const quietAgg = await Scan.aggregate([
      { $match: { organization_id: orgId, scanned_at: { $gte: quietFrom } } },
      { $group: { _id: '$user_id' } },
    ]);
    const quietScanned = new Set(quietAgg.map((a) => String(a._id)));
    const quietCount = activeOperators - quietScanned.size;
    if (quietCount > 0) {
      items.push({
        type: 'operators_quiet',
        severity: 'info',
        data: { quiet_count: quietCount, total_active: activeOperators },
      });
    }
  }

  return { items };
};
