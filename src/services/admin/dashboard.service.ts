import mongoose from 'mongoose';
import config from '../../config/config.js';
import {
  Organization,
  Plan,
  Subscription,
  Usage,
  Payment,
  GuestLead,
  WebhookDelivery,
  SystemError,
  User,
  Scan,
} from '../../models/index.js';
import { getRedis, isRedisConfigured } from '../../queues/redis.js';
import { getWebhookQueue } from '../../queues/webhook.queue.js';
import { scrubErrorSummary } from '../../utils/dashboard-scrub.js';
import {
  dashboardTimezone,
  dayBuckets,
  getMonthWindows,
  objectIdRange,
  resolveRange,
  type DashboardRange,
} from '../../utils/dashboard-time.js';

const maxMs = () => config.dashboard.queryMaxMs;
const tz = () => dashboardTimezone();

const round1 = (value: number): number => Math.round(value * 10) / 10;

const scanLimitOf = (
  features?: { features_name: string; scan_limit: number }[],
): number =>
  features?.find((feature) => feature.features_name === 'scan')?.scan_limit ??
  features?.[0]?.scan_limit ??
  0;

const countScans = (start: Date, end: Date): Promise<number> =>
  Scan.countDocuments({ _id: objectIdRange(start, end) }).maxTimeMS(maxMs());

interface ActiveUsageRow {
  organizationId: string;
  planName: string;
  billingCycle: string;
  expiresAt: Date;
  usage: number;
  scanLimit: number;
  utilizationPct: number | null;
  isExhausted: boolean;
  startedAt: Date;
}

const loadActiveUsage = async (): Promise<ActiveUsageRow[]> => {
  const actives = await Subscription.find({ status: 'active' })
    .select(
      'organization_id plan_name billing_cycle started_at expires_at features',
    )
    .lean();
  const subIds = actives.map((sub) => sub._id);
  const usageRows = subIds.length
    ? await Usage.find({ subscription_id: { $in: subIds } }).lean()
    : [];
  const usageBySub = new Map(
    usageRows.map((row) => [String(row.subscription_id), row]),
  );

  return actives.map((sub) => {
    const row = usageBySub.get(String(sub._id));
    const usage = row?.usage ?? 0;
    const scanLimit = row?.scan_limit ?? scanLimitOf(sub.features as any);
    return {
      organizationId: String(sub.organization_id),
      planName: sub.plan_name ?? '',
      billingCycle: sub.billing_cycle,
      startedAt: sub.started_at,
      expiresAt: sub.expires_at,
      usage,
      scanLimit,
      utilizationPct: scanLimit > 0 ? round1((usage / scanLimit) * 100) : null,
      isExhausted: row?.is_exhausted ?? (scanLimit > 0 && usage >= scanLimit),
    };
  });
};

const organizationNameMap = async (
  orgIds: string[],
): Promise<Map<string, string>> => {
  if (!orgIds.length) {
    return new Map();
  }
  const orgs = await Organization.find({
    _id: { $in: orgIds.map((id) => new mongoose.Types.ObjectId(id)) },
  })
    .select('company_name')
    .lean();
  return new Map(orgs.map((org) => [String(org._id), org.company_name]));
};

export const getSummary = async () => {
  const timeZone = tz();
  const now = new Date();
  const win = getMonthWindows(now, timeZone);

  const [
    orgAgg,
    subRows,
    futureQueued,
    deletedOrgIds,
    userAgg,
    leadAgg,
    converted,
    monthToDate,
    previousMonthSamePeriod,
    previousMonthTotal,
  ] = await Promise.all([
    Organization.aggregate([
      { $match: { status: { $ne: 2 } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).option({ maxTimeMS: maxMs() }),
    Subscription.aggregate([
      { $match: { status: 'active' } },
      {
        $lookup: {
          from: 'tbl_payment',
          localField: 'payment_id',
          foreignField: '_id',
          as: 'payment',
        },
      },
      {
        $project: {
          trial_days: 1,
          gateway: { $arrayElemAt: ['$payment.gateway', 0] },
        },
      },
    ]).option({ maxTimeMS: maxMs() }),
    Subscription.countDocuments({ status: 'future' }),
    Organization.distinct('_id', { status: 2 }),
    User.aggregate([
      {
        $match: {
          role: { $in: ['ORGANIZATION_ADMIN', 'OPERATOR'] },
          status: { $ne: 2 },
        },
      },
      { $group: { _id: '$role', count: { $sum: 1 } } },
    ]).option({ maxTimeMS: maxMs() }),
    GuestLead.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).option({ maxTimeMS: maxMs() }),
    GuestLead.countDocuments({
      status: 'success',
      organization_id: { $ne: null },
    }),
    countScans(win.monthStart, win.monthToDateEnd),
    countScans(win.previousMonthStart, win.previousMonthSamePeriodEnd),
    countScans(win.previousMonthStart, win.previousMonthEnd),
  ]);

  const orgByStatus = new Map(
    orgAgg.map((row: any) => [Number(row._id), row.count as number]),
  );
  const orgTotalCount = orgAgg.reduce(
    (sum: number, row: any) => sum + row.count,
    0,
  );

  const deletedSet = new Set(deletedOrgIds.map((id: any) => String(id)));
  const userByRole = new Map(
    userAgg.map((row: any) => [row._id, row.count as number]),
  );
  const leadByStatus = new Map(
    leadAgg.map((row: any) => [row._id, row.count as number]),
  );

  let paid = 0;
  let trial = 0;
  let manual = 0;
  for (const row of subRows as any[]) {
    if ((row.trial_days ?? 0) > 0) {
      trial += 1;
    } else if (row.gateway === 'manual') {
      manual += 1;
    } else {
      paid += 1;
    }
  }

  const active = orgByStatus.get(1) ?? 0;
  const inactive = orgByStatus.get(0) ?? 0;
  const pendingLeads =
    (leadByStatus.get('pending') ?? 0) + (leadByStatus.get('initiated') ?? 0);

  const changePct =
    previousMonthSamePeriod > 0
      ? round1(
          ((monthToDate - previousMonthSamePeriod) / previousMonthSamePeriod) *
            100,
        )
      : null;

  return {
    generated_at: new Date().toISOString(),
    timezone: timeZone,
    organizations: {
      total: orgTotalCount,
      active,
      inactive,
    },
    scans: {
      month_to_date: monthToDate,
      previous_month_same_period: previousMonthSamePeriod,
      previous_month_total: previousMonthTotal,
      change_pct: changePct,
      month_start: win.monthStart.toISOString(),
      as_of: now.toISOString(),
    },
    subscriptions: {
      active: subRows.length,
      paid,
      trial,
      manual,
      future_queued: futureQueued,
    },
    users: {
      total:
        (userByRole.get('ORGANIZATION_ADMIN') ?? 0) +
        (userByRole.get('OPERATOR') ?? 0),
      organization_admins: userByRole.get('ORGANIZATION_ADMIN') ?? 0,
      operators: userByRole.get('OPERATOR') ?? 0,
      excluded_deleted_orgs: deletedSet.size,
    },
    guest_leads: {
      pending: pendingLeads,
      failed: leadByStatus.get('failed') ?? 0,
      converted,
    },
  };
};

const scanDailyCounts = async (
  start: Date,
  end: Date,
): Promise<Map<string, number>> => {
  const rows = await Scan.aggregate([
    { $match: { _id: objectIdRange(start, end) } },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: { $toDate: '$_id' },
            timezone: tz(),
          },
        },
        count: { $sum: 1 },
      },
    },
  ]).option({ maxTimeMS: maxMs() });
  return new Map(
    rows.map((row: any) => [row._id as string, row.count as number]),
  );
};

export const getScanTrend = async (options: {
  range?: DashboardRange;
  from?: Date;
  to?: Date;
  compare?: boolean;
}) => {
  const timeZone = tz();
  const resolved = resolveRange(timeZone, options);
  const points = dayBuckets(resolved.start, resolved.end, timeZone);
  const counts = await scanDailyCounts(resolved.start, resolved.end);

  const series = points.map((bucket) => ({
    date: bucket.key,
    count: counts.get(bucket.key) ?? 0,
  }));

  let comparison: { date: string; count: number }[] | null = null;
  if (options.compare) {
    const previousBuckets = dayBuckets(
      resolved.previousStart,
      resolved.previousEnd,
      timeZone,
    );
    const previousCounts = await scanDailyCounts(
      resolved.previousStart,
      resolved.previousEnd,
    );
    comparison = previousBuckets.map((bucket) => ({
      date: bucket.key,
      count: previousCounts.get(bucket.key) ?? 0,
    }));
  }

  return {
    range: options.range ?? (options.from && options.to ? 'custom' : '30d'),
    timezone: timeZone,
    points: series,
    comparison,
  };
};

export const getPlanDistribution = async () => {
  const [grouped, orgTotal, orgsWithActive] = await Promise.all([
    Subscription.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: '$plan_id', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).option({ maxTimeMS: maxMs() }),
    Organization.countDocuments({ status: { $ne: 2 } }),
    Subscription.distinct('organization_id', { status: 'active' }),
  ]);

  const planIds = grouped
    .map((row: any) => row._id)
    .filter(Boolean) as mongoose.Types.ObjectId[];
  const plans = planIds.length
    ? await Plan.find({ _id: { $in: planIds } })
        .select('name')
        .lean()
    : [];
  const planName = new Map(plans.map((plan) => [String(plan._id), plan.name]));

  const results = grouped.map((row: any) => ({
    plan_id: row._id ? String(row._id) : null,
    plan_name: row._id
      ? (planName.get(String(row._id)) ?? 'Unknown plan')
      : 'No plan',
    count: row.count as number,
  }));

  return {
    results,
    no_plan: Math.max(0, orgTotal - orgsWithActive.length),
  };
};

export const getGrowth = async (options: {
  range?: DashboardRange;
  from?: Date;
  to?: Date;
}) => {
  const timeZone = tz();
  const resolved = resolveRange(timeZone, options);
  const window = { $gte: resolved.start, $lt: resolved.end };

  const [orgRows, leadRows] = await Promise.all([
    Organization.aggregate([
      { $match: { status: { $ne: 2 }, created_at: window } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$created_at',
              timezone: timeZone,
            },
          },
          count: { $sum: 1 },
        },
      },
    ]).option({ maxTimeMS: maxMs() }),
    GuestLead.aggregate([
      { $match: { created_at: window } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$created_at',
              timezone: timeZone,
            },
          },
          count: { $sum: 1 },
        },
      },
    ]).option({ maxTimeMS: maxMs() }),
  ]);

  const orgByDay = new Map(
    orgRows.map((row: any) => [row._id as string, row.count as number]),
  );
  const leadByDay = new Map(
    leadRows.map((row: any) => [row._id as string, row.count as number]),
  );

  const points = dayBuckets(resolved.start, resolved.end, timeZone).map(
    (bucket) => ({
      date: bucket.key,
      organizations: orgByDay.get(bucket.key) ?? 0,
      guest_leads: leadByDay.get(bucket.key) ?? 0,
    }),
  );

  return {
    range: options.range ?? (options.from && options.to ? 'custom' : '30d'),
    timezone: timeZone,
    points,
  };
};

export const getRecentLeads = async (limit: number) => {
  const leads = await GuestLead.find()
    .sort({ created_at: -1 })
    .limit(limit)
    .lean();

  const planIds = leads
    .map((lead) => lead.plan_id)
    .filter(Boolean) as mongoose.Types.ObjectId[];
  const plans = planIds.length
    ? await Plan.find({ _id: { $in: planIds } })
        .select('name')
        .lean()
    : [];
  const planName = new Map(plans.map((plan) => [String(plan._id), plan.name]));

  return {
    results: leads.map((lead) => ({
      id: String(lead._id),
      name: `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim(),
      email: lead.email,
      company_name: lead.company_name ?? null,
      country_name: lead.country_name ?? null,
      plan_name: planName.get(String(lead.plan_id)) ?? null,
      billing_cycle: lead.billing_cycle,
      trial_days: lead.trial_days,
      status: lead.status,
      created_at: lead.created_at,
    })),
  };
};

export const getTopOrganizations = async (limit: number) => {
  const rows = await loadActiveUsage();
  const top = [...rows].sort((a, b) => b.usage - a.usage).slice(0, limit);
  const names = await organizationNameMap(top.map((row) => row.organizationId));

  return {
    results: top.map((row) => ({
      organization_id: row.organizationId,
      name: names.get(row.organizationId) ?? 'Unknown organization',
      plan_name: row.planName,
      billing_cycle: row.billingCycle,
      usage: row.usage,
      scan_limit: row.scanLimit,
      utilization_pct: row.utilizationPct,
      status: 'active',
      expires_at: row.expiresAt,
    })),
  };
};

export const getAttention = async () => {
  const now = new Date();
  const nearLimitPct = config.dashboard.nearLimitPct;
  const soon = new Date(now.getTime() + 7 * 86_400_000);
  const rows = await loadActiveUsage();

  const quotaExhausted = rows.filter(
    (row) => row.scanLimit > 0 && row.usage >= row.scanLimit,
  );
  const nearLimit = rows.filter(
    (row) =>
      row.scanLimit > 0 &&
      row.usage < row.scanLimit &&
      (row.utilizationPct ?? 0) >= nearLimitPct,
  );
  const expiring = rows.filter(
    (row) => row.expiresAt.getTime() >= now.getTime() && row.expiresAt <= soon,
  );

  const [paidNotProvisioned, queuedOrgIds] = await Promise.all([
    Payment.find({
      gateway: { $in: ['stripe', 'razorpay'] },
      status: 'TXN_SUCCESS',
      $or: [{ organization_id: null }, { organization_id: { $exists: false } }],
    })
      .select(
        'gateway price currency_code paid_at organization_id plan_id lead_id',
      )
      .lean(),
    Subscription.distinct('organization_id', { status: 'future' }),
  ]);
  const queuedSet = new Set(queuedOrgIds.map((id: any) => String(id)));

  const planIds = [
    ...new Set(
      paidNotProvisioned
        .map((payment) => payment.plan_id)
        .filter(Boolean)
        .map((id: any) => String(id)),
    ),
  ];
  const leadIds = [
    ...new Set(
      paidNotProvisioned
        .map((payment) => payment.lead_id)
        .filter(Boolean)
        .map((id: any) => String(id)),
    ),
  ];
  const [paidPlans, paidLeads] = await Promise.all([
    planIds.length
      ? Plan.find({ _id: { $in: planIds } })
          .select('name')
          .lean()
      : Promise.resolve([]),
    leadIds.length
      ? GuestLead.find({ _id: { $in: leadIds } })
          .select('first_name last_name company_name')
          .lean()
      : Promise.resolve([]),
  ]);
  const planNameById = new Map(
    paidPlans.map((plan) => [String(plan._id), plan.name]),
  );
  const leadNameById = new Map(
    paidLeads.map((lead) => [
      String(lead._id),
      [lead.first_name, lead.last_name].filter(Boolean).join(' ') ||
        lead.company_name ||
        null,
    ]),
  );

  const names = await organizationNameMap([
    ...quotaExhausted.map((r) => r.organizationId),
    ...nearLimit.map((r) => r.organizationId),
    ...expiring.map((r) => r.organizationId),
  ]);

  const decorate = (row: ActiveUsageRow) => ({
    organization_id: row.organizationId,
    name: names.get(row.organizationId) ?? 'Unknown organization',
    plan_name: row.planName,
    billing_cycle: row.billingCycle,
    usage: row.usage,
    scan_limit: row.scanLimit,
    utilization_pct: row.utilizationPct,
    expires_at: row.expiresAt,
  });

  return {
    quota_exhausted: quotaExhausted.map(decorate),
    near_limit: nearLimit.map(decorate),
    expiring_soon: expiring.map((row) => ({
      ...decorate(row),
      next_plan_queued: queuedSet.has(row.organizationId),
    })),
    paid_not_provisioned: paidNotProvisioned.map((payment) => ({
      payment_id: String(payment._id),
      gateway: payment.gateway,
      price: payment.price,
      currency_code: payment.currency_code,
      paid_at: payment.paid_at ?? null,
      plan_name: payment.plan_id
        ? (planNameById.get(String(payment.plan_id)) ?? null)
        : null,
      lead_id: payment.lead_id ? String(payment.lead_id) : null,
      lead_name: payment.lead_id
        ? (leadNameById.get(String(payment.lead_id)) ?? null)
        : null,
    })),
  };
};

export const getWebhooks = async () => {
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 3_600_000);

  const [failedLast24h, pending, retryBacklog, oldest] = await Promise.all([
    WebhookDelivery.countDocuments({
      status: 'failed',
      last_attempt_at: { $gte: since },
    }),
    WebhookDelivery.countDocuments({ status: 'pending' }),
    WebhookDelivery.countDocuments({
      status: 'pending',
      retry_count: { $gt: 0 },
    }),
    WebhookDelivery.findOne({ status: 'pending' })
      .sort({ created_at: 1 })
      .select('created_at')
      .lean(),
  ]);

  let queue: Record<string, number> | null = null;
  if (isRedisConfigured()) {
    try {
      queue = (await getWebhookQueue().getJobCounts()) as Record<
        string,
        number
      >;
    } catch {
      queue = null;
    }
  }

  return {
    generated_at: now.toISOString(),
    failed_last_24h: failedLast24h,
    pending,
    retry_backlog: retryBacklog,
    oldest_pending_age_seconds: oldest
      ? Math.floor((now.getTime() - oldest.created_at.getTime()) / 1000)
      : null,
    queue,
  };
};

export type Health = 'healthy' | 'degraded' | 'unavailable';

export const healthFromAge = (
  ageMs: number | null,
  healthyMax: number,
  degradedMax: number,
): Health => {
  if (ageMs === null) {
    return 'unavailable';
  }
  if (ageMs < healthyMax) {
    return 'healthy';
  }
  if (ageMs <= degradedMax) {
    return 'degraded';
  }
  return 'unavailable';
};

export const getSystem = async () => {
  const now = new Date();

  const mongoStart = Date.now();
  let mongodb: Health = 'unavailable';
  try {
    const db = mongoose.connection.db;
    if (db) {
      await db.admin().command({ ping: 1 });
      mongodb = Date.now() - mongoStart > 500 ? 'degraded' : 'healthy';
    }
  } catch {
    mongodb = 'unavailable';
  }

  let redis: Health = 'unavailable';
  let worker: Health = 'unavailable';
  let heartbeatAgeMs: number | null = null;
  if (isRedisConfigured()) {
    try {
      const redisStart = Date.now();
      await getRedis().ping();
      redis = Date.now() - redisStart > 200 ? 'degraded' : 'healthy';
    } catch {
      redis = 'unavailable';
    }
    try {
      const raw = await getRedis().get('worker:heartbeat');
      if (raw) {
        heartbeatAgeMs = now.getTime() - Number(raw);
        worker = healthFromAge(heartbeatAgeMs, 60_000, 90_000);
      }
    } catch {
      worker = 'unavailable';
    }
  }

  const oldest = await WebhookDelivery.findOne({ status: 'pending' })
    .sort({ created_at: 1 })
    .select('created_at')
    .lean();
  const oldestAgeMs = oldest
    ? now.getTime() - oldest.created_at.getTime()
    : null;
  const webhookQueue: Health = isRedisConfigured()
    ? healthFromAge(oldestAgeMs, 120_000, 600_000)
    : 'unavailable';

  const errors = await SystemError.find({
    $or: [{ status_code: { $gte: 400 } }, { status_code: null }],
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  return {
    generated_at: now.toISOString(),
    services: {
      api: 'healthy' as Health,
      mongodb,
      redis,
      worker,
      webhook_queue: webhookQueue,
    },
    worker_heartbeat_age_seconds:
      heartbeatAgeMs === null ? null : Math.floor(heartbeatAgeMs / 1000),
    recent_errors: errors.map((error: any) => ({
      id: String(error._id),
      created_at: error.createdAt,
      method: error.method ?? null,
      route: error.route ?? null,
      status_code: error.status_code ?? null,
      summary: scrubErrorSummary(error.error_data),
    })),
    metrics_unavailable: ['api_latency', 'api_error_rate'],
  };
};
