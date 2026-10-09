import httpStatus from 'http-status';
import mongoose from 'mongoose';
import { Organization } from '../models/organization.model.js';
import { Plan } from '../models/plan.model.js';
import {
  Subscription,
  ISubscription,
  ISubscriptionFeature,
  SubscriptionStatus,
} from '../models/subscription.model.js';
import { Payment } from '../models/payment.model.js';
import { Usage } from '../models/usage.model.js';
import { Scan } from '../models/scan.model.js';
import { ApiError } from '../utils/ApiError.js';
import { createResponse, toObjectId } from './common.service.js';
import {
  computeExpiresAt,
  USAGE_RETENTION_DAYS,
} from '../utils/subscription-expiry.util.js';
import {
  planPriceErrorMessage,
  resolvePlanPrice,
  scanLimitOf,
} from '../utils/plan-features.util.js';
import {
  writeActiveSubscriptionCache,
  deleteActiveSubscriptionCache,
  flushActiveSubUsage,
  readActiveSubUsage,
} from './quota.service.js';
import { isSuperAdmin } from '../middlewares/guards/isSuperAdmin.js';
import {
  dispatchSubscriptionActivatedEmail,
  dispatchSubscriptionExpiredEmail,
  dispatchSubscriptionGrantEmails,
} from './subscription-email.service.js';

const activeSubQuery = (organizationId: string) => ({
  organization_id: toObjectId(organizationId),
  status: 'active' as SubscriptionStatus,
});

const futureQuery = (organizationId: string) => ({
  organization_id: toObjectId(organizationId),
  status: 'future' as SubscriptionStatus,
});

/**
 * Flattens a Subscription document for the admin API: `plan_id` is always a plain
 * id even when the query populated the plan, so clients can rely on one shape.
 */
const toSubscriptionView = (sub: any) => {
  const populatedPlan =
    sub.plan_id && typeof sub.plan_id === 'object' ? sub.plan_id : null;
  return {
    id: String(sub._id),
    organization_id: String(sub.organization_id),
    plan_id: String(populatedPlan?._id ?? sub.plan_id),
    plan_name: sub.plan_name ?? populatedPlan?.name ?? '',
    plan_price: sub.plan_price ?? 0,
    currency_code: sub.currency_code ?? 'inr',
    billing_cycle: sub.billing_cycle,
    status: sub.status,
    started_at: sub.started_at,
    expires_at: sub.expires_at,
    queue_priority: sub.queue_priority ?? 0,
    trial_days: sub.trial_days ?? 0,
    features: sub.features ?? [],
    marketing_features: sub.marketing_features ?? [],
    is_plan_cancel: sub.is_plan_cancel ?? false,
    cancellation_reason: sub.cancellation_reason ?? null,
  };
};

export const assertOrganizationActive = async (
  organizationId: string,
): Promise<InstanceType<typeof Organization>> => {
  const org = await Organization.findById(organizationId);
  if (!org || org.status !== 1) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Organization is not active or not found',
    );
  }
  return org;
};

/** Non-super-admin callers are forced into their own organization (§9). */
export const resolveOrganizationScope = (
  organizationId: string,
  reqUser: any,
): string => {
  if (!isSuperAdmin(reqUser)) {
    return String(reqUser.organization_id);
  }
  return organizationId;
};

export const getActiveSubscription = async (
  organizationId: string,
): Promise<ISubscription | null> =>
  Subscription.findOne(activeSubQuery(organizationId)).sort({ created_at: -1 });

export const getOrganizationSubscriptionQueue = async (
  organizationId: string,
): Promise<ISubscription[]> =>
  Subscription.find(futureQuery(organizationId)).sort({ queue_priority: 1 });

/** Creates the manual Payment row used by admin grants and renewals. */
const createManualPaymentRecord = async (data: {
  organization_id: mongoose.Types.ObjectId;
  plan_id: mongoose.Types.ObjectId;
  price: number;
  currency_code: string;
  billing_cycle: 'month' | 'quarterly';
}): Promise<mongoose.Types.ObjectId> => {
  const payment = await Payment.create({
    organization_id: data.organization_id,
    plan_id: data.plan_id,
    gateway: 'manual',
    price: data.price,
    currency_code: data.currency_code,
    billing_cycle: data.billing_cycle,
    status: 'TXN_SUCCESS',
    paid_at: new Date(),
    lead_id: null,
  });
  return payment._id;
};

const writeActiveSubCache = async (
  sub: ISubscription,
  resetUsed: boolean = true,
): Promise<void> => {
  await writeActiveSubscriptionCache(
    String(sub.organization_id),
    scanLimitOf(sub.features),
    sub.expires_at,
    resetUsed,
  );
};

const deleteActiveSubCache = async (organizationId: string): Promise<void> => {
  await deleteActiveSubscriptionCache(organizationId);
};

/**
 * Cold-cache fallback (§4 -2 handling): the only time the scan hot path
 * touches the Subscription collection. Populates the cache from Mongo
 * (seeded with the max of the durable Usage row and the scans created since
 * the subscription started) and reports whether an active subscription exists.
 */
export const populateActiveSubCache = async (
  organizationId: string,
): Promise<boolean> => {
  const active = await getActiveSubscription(organizationId);
  if (!active) {
    return false;
  }
  const usage = await Usage.findOne({
    organization_id: toObjectId(organizationId),
    subscription_id: active._id,
  });
  const scansFromStart = await Scan.countDocuments({
    organization_id: toObjectId(organizationId),
    created_at: { $gte: active.started_at },
  });
  const used = Math.max(usage?.usage ?? 0, scansFromStart);
  await writeActiveSubscriptionCache(
    String(active.organization_id),
    scanLimitOf(active.features),
    active.expires_at,
    false,
    used,
  );
  return true;
};

export const createUsageForSubscription = async (
  sub: ISubscription,
): Promise<InstanceType<typeof Usage>> =>
  Usage.create({
    feature_name: 'scan',
    organization_id: sub.organization_id,
    subscription_id: sub._id,
    scan_limit: scanLimitOf(sub.features),
    usage: 0,
    started_at: sub.started_at,
    expires_at: sub.expires_at,
    is_exhausted: false,
    purge_after: new Date(
      sub.expires_at.getTime() + USAGE_RETENTION_DAYS * 86400000,
    ),
  });

const decideInitialStatus = async (
  organizationId: string,
  billingCycle: 'month' | 'quarterly',
  trialDays: number,
  forceActive: boolean,
  startDate?: Date | string | null,
): Promise<{
  status: SubscriptionStatus;
  queuePriority: number;
  startedAt: Date;
  expiresAt: Date;
}> => {
  const resolveStartDate = (): Date => {
    if (!startDate) return new Date();
    const parsed = new Date(startDate);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
  };

  if (forceActive) {
    const startedAt = resolveStartDate();
    return {
      status: 'active',
      queuePriority: 0,
      startedAt,
      expiresAt: computeExpiresAt(billingCycle, trialDays, startedAt),
    };
  }
  const active = await Subscription.findOne(
    activeSubQuery(organizationId),
  ).sort({ created_at: -1 });
  const futures = await Subscription.find(futureQuery(organizationId)).sort({
    queue_priority: 1,
  });
  if (!active && futures.length === 0) {
    const startedAt = resolveStartDate();
    return {
      status: 'active',
      queuePriority: 0,
      startedAt,
      expiresAt: computeExpiresAt(billingCycle, trialDays, startedAt),
    };
  }
  const chainSource = futures.length
    ? futures[futures.length - 1]
    : (active ?? null);
  const startedAt = chainSource ? chainSource.expires_at : new Date();
  return {
    status: 'future',
    queuePriority: futures.length
      ? (futures[futures.length - 1]?.queue_priority ?? 0) + 1
      : 1,
    startedAt,
    expiresAt: computeExpiresAt(billingCycle, trialDays, startedAt),
  };
};

/**
 * Single, shared grant entry point (§3). Every caller (admin assign-plan,
 * Stripe/Razorpay success, renew-recreate, force-activate) routes through it.
 */
export const grantSubscription = async (
  organizationId: string,
  planId: string,
  options: {
    trialDays?: number;
    forceActive?: boolean;
    billingCycle?: 'month' | 'quarterly';
    paymentId?: string;
    startDate?: Date | string | null;
  } = {},
): Promise<ISubscription> => {
  const plan = await Plan.findById(planId);
  if (!plan || plan.status !== 1) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Plan not found or not active');
  }
  // The plan dictates its cycle; an explicit cycle is only honoured when it matches.
  let billingCycle: 'month' | 'quarterly';
  let planPrice: number;
  try {
    ({ billingCycle, price: planPrice } = resolvePlanPrice(
      plan,
      options.billingCycle,
    ));
  } catch {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      planPriceErrorMessage(plan, options.billingCycle ?? 'month'),
    );
  }
  const trialDays = options.trialDays ?? 0;
  const decided = await decideInitialStatus(
    organizationId,
    billingCycle,
    trialDays,
    Boolean(options.forceActive),
    options.startDate ?? null,
  );

  const orgId = toObjectId(organizationId);
  const paymentId = options.paymentId
    ? toObjectId(options.paymentId)
    : await createManualPaymentRecord({
        organization_id: orgId,
        plan_id: plan._id,
        price: planPrice,
        currency_code: plan.currency || 'inr',
        billing_cycle: billingCycle,
      });

  const sub = await Subscription.create({
    organization_id: orgId,
    plan_id: plan._id,
    payment_id: paymentId,
    features: plan.features.map((f) => ({
      features_name: f.features_name,
      scan_limit: f.scan_limit,
    })),
    billing_cycle: billingCycle,
    status: decided.status,
    started_at: decided.startedAt,
    expires_at: decided.expiresAt,
    queue_priority: decided.queuePriority,
    reminders_sent: [],
    marketing_features: plan.marketing_features ?? [],
    trial_days: trialDays,
    currency_code: plan.currency || 'inr',
    plan_price: planPrice,
    plan_name: plan.name,
    is_plan_cancel: false,
  });

  if (sub.status === 'active') {
    await createUsageForSubscription(sub);
    await writeActiveSubCache(sub, true);
  }
  return sub;
};

export const promoteEarliestFutureSubscription = async (
  organizationId: string,
): Promise<ISubscription | null> => {
  const earliest = await Subscription.findOne(futureQuery(organizationId)).sort(
    {
      queue_priority: 1,
    },
  );
  if (!earliest) {
    return null;
  }
  earliest.status = 'active';
  earliest.queue_priority = 0;
  await earliest.save();
  await createUsageForSubscription(earliest);
  await writeActiveSubCache(earliest, true);
  await normalizeQueuePriorities(organizationId);
  void dispatchSubscriptionActivatedEmail(organizationId, earliest);
  return earliest;
};

export const normalizeQueuePriorities = async (
  organizationId: string,
): Promise<void> => {
  const futures = await Subscription.find(futureQuery(organizationId)).sort({
    queue_priority: 1,
  });
  const ops = futures.map((sub, index) => ({
    updateOne: {
      filter: { _id: sub._id },
      update: { $set: { queue_priority: index + 1 } },
    },
  }));
  if (ops.length) {
    await Subscription.bulkWrite(ops);
  }
};

/**
 * Admin removes a queued (future) subscription before it ever activates.
 * Futures carry no Usage rows, so only the queue positions need repacking.
 */
export const cancelQueuedSubscription = async (
  organizationId: string,
  subscriptionId: string,
) => {
  const sub = await Subscription.findOne({
    _id: subscriptionId,
    organization_id: toObjectId(organizationId),
  });
  if (!sub) {
    throw new ApiError(httpStatus.NOT_FOUND, 'QUEUED_SUBSCRIPTION_NOT_FOUND');
  }
  if (sub.status !== 'future') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'ONLY_FUTURE_SUBSCRIPTIONS_CAN_BE_CANCELLED',
    );
  }
  sub.status = 'cancelled';
  sub.cancellation_reason = 'Cancelled from queue';
  sub.queue_priority = 0;
  await sub.save();
  await normalizeQueuePriorities(organizationId);
  return createResponse(httpStatus.OK, 'Queued subscription cancelled.', {
    cancelledSubscription: sub._id,
    futureQueue: await getOrganizationSubscriptionQueue(organizationId),
  });
};

/**
 * Rewrites the schedule of every queued subscription so it reflects the current
 * queue order. The first future row starts when the active subscription expires
 * (or now when there is no active one); each following row starts when the
 * previous one ends. Each row keeps its own cycle and trial allowance, so a
 * reordering never changes what a customer is entitled to, only when it starts.
 */
export const recalculateQueueSchedule = async (organizationId: string) => {
  const [active, futures] = await Promise.all([
    Subscription.findOne(activeSubQuery(organizationId)).sort({
      created_at: -1,
    }),
    Subscription.find(futureQuery(organizationId)).sort({ queue_priority: 1 }),
  ]);
  if (!futures.length) return;

  let cursor = active?.expires_at ?? new Date();
  for (const sub of futures) {
    const startedAt = cursor;
    cursor = computeExpiresAt(
      sub.billing_cycle,
      sub.trial_days ?? 0,
      startedAt,
    );
    sub.started_at = startedAt;
    sub.expires_at = cursor;
    await sub.save();
  }
};

/**
 * Drag-and-drop reorder among queued subscriptions. The submitted list must be an
 * exact permutation of the current future ids, so a stale drag cannot silently drop
 * or duplicate a queued plan. Priorities are repacked and the schedule is then
 * recalculated so the dates follow the new order.
 */
export const reorderSubscriptionQueue = async (
  organizationId: string,
  orderedSubscriptionIds: string[],
) => {
  const futures = await Subscription.find(futureQuery(organizationId)).sort({
    queue_priority: 1,
  });
  const futureIds = new Set(futures.map((s) => String(s._id)));
  const submitted = new Set(orderedSubscriptionIds);
  const isExactMatch =
    orderedSubscriptionIds.length === futures.length &&
    orderedSubscriptionIds.length === submitted.size &&
    [...futureIds].every((id) => submitted.has(id));
  if (!isExactMatch) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'QUEUE_ORDER_MISMATCH');
  }

  const ops = orderedSubscriptionIds.map((id, index) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set: { queue_priority: index + 1 } },
    },
  }));
  await Subscription.bulkWrite(ops);
  // Cancelled/expired rows must not take part in the promotion sort.
  await Subscription.updateMany(
    {
      organization_id: toObjectId(organizationId),
      status: { $in: ['cancelled', 'expired'] },
    },
    { $set: { queue_priority: 0 } },
  );
  await normalizeQueuePriorities(organizationId);
  await recalculateQueueSchedule(organizationId);

  return createResponse(httpStatus.OK, 'Future queue reordered successfully.', {
    futureQueue: await getOrganizationSubscriptionQueue(organizationId),
  });
};

/**
 * SaaS-parity bulk limit adjustment, narrowed to ScanFlow's single metered
 * feature ('scan'). Validates every adjustment first, then applies them all, so a
 * rejected item cannot leave a partially adjusted quota.
 *
 * An active subscription adjusts its Usage row; a queued one adjusts the feature
 * snapshot on the subscription so the new limit takes effect at promotion.
 */
export const adjustScanLimits = async (
  organizationId: string,
  subscriptionId: string,
  adjustments: { delta: number }[],
) => {
  if (!adjustments?.length) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'At least one adjustment is required',
    );
  }
  const sub = await Subscription.findOne({
    _id: subscriptionId,
    organization_id: toObjectId(organizationId),
  });
  if (!sub) {
    throw new ApiError(httpStatus.NOT_FOUND, 'SUBSCRIPTION_NOT_FOUND');
  }
  if (sub.status === 'cancelled') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'LIMITS_CANNOT_BE_ADJUSTED_ON_CANCELLED',
    );
  }

  const feature = (sub.features ?? []).find((f) => f.features_name === 'scan');
  if (!feature) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'SCAN_FEATURE_NOT_ON_SUBSCRIPTION',
    );
  }

  const totalDelta = adjustments.reduce((sum, a) => sum + Number(a.delta), 0);
  if (!Number.isFinite(totalDelta) || totalDelta <= 0) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'ADJUSTMENT_DELTA_MUST_BE_POSITIVE',
    );
  }

  if (sub.status === 'future') {
    const newLimit = feature.scan_limit + totalDelta;
    if (newLimit < 0) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'SCAN_LIMIT_WOULD_GO_NEGATIVE',
      );
    }
    await Subscription.updateOne(
      { _id: sub._id },
      { $set: { 'features.$[feat].scan_limit': newLimit } },
      { arrayFilters: [{ 'feat.features_name': 'scan' }] },
    );
    return createResponse(httpStatus.OK, 'Scan limit adjusted.', {
      subscription_id: sub._id,
      scan_limit: newLimit,
      status: sub.status,
    });
  }

  const usage = await Usage.findOne({
    organization_id: toObjectId(organizationId),
    subscription_id: sub._id,
  });
  if (!usage) {
    throw new ApiError(httpStatus.NOT_FOUND, 'USAGE_RECORD_NOT_FOUND');
  }
  // The durable row lags the hot-path counter until a flush, so compare against
  // the live value and report the same number back.
  const cache = await readActiveSubUsage(organizationId, sub as any);
  const used = cache?.used ?? usage.usage;
  const newLimit = usage.scan_limit + totalDelta;
  if (newLimit < 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'SCAN_LIMIT_WOULD_GO_NEGATIVE');
  }
  if (newLimit < used) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'SCAN_LIMIT_BELOW_USAGE');
  }
  await Usage.updateOne({ _id: usage._id }, { $set: { scan_limit: newLimit } });
  // Keep the hot-path cache in step with the durable quota, preserving `used`.
  if (sub.status === 'active') {
    await writeActiveSubscriptionCache(
      String(sub.organization_id),
      newLimit,
      sub.expires_at,
      false,
      used,
    );
  }
  return createResponse(httpStatus.OK, 'Scan limit adjusted.', {
    subscription_id: sub._id,
    scan_limit: newLimit,
    usage: used,
    status: sub.status,
  });
};

export const normalizeAllQueuePriorities = async (): Promise<void> => {
  const orgIds = await Subscription.distinct('organization_id', {
    status: 'future',
  });
  for (const orgId of orgIds) {
    await normalizeQueuePriorities(String(orgId));
  }
};

/**
 * Worker EVERY_MINUTE job (§12): expire overdue active subscriptions, then
 * promote the earliest queued successor when no active remains.
 */
export const activateEligibleSubscriptions = async (): Promise<void> => {
  const now = new Date();
  const orgIds = new Set<string>();

  const actives = await Subscription.find({ status: 'active' });
  for (const active of actives) {
    if (active.expires_at.getTime() <= now.getTime()) {
      const orgId = String(active.organization_id);
      await flushActiveSubUsage(orgId);
      await deleteActiveSubCache(orgId);
      active.status = 'expired';
      await active.save();
      orgIds.add(orgId);
      void dispatchSubscriptionExpiredEmail(orgId, active);
    }
  }

  const dueFutures = await Subscription.find({
    status: 'future',
    started_at: { $lte: now },
  }).select('organization_id');
  for (const future of dueFutures) {
    orgIds.add(String(future.organization_id));
  }

  for (const orgId of orgIds) {
    const active = await Subscription.findOne(activeSubQuery(orgId));
    if (!active) {
      await promoteEarliestFutureSubscription(orgId);
    }
  }
};

export const renewSubscription = async (
  organizationId: string,
  mode: 'continue' | 'promote' | 'recreate',
  options: { planId?: string; billingCycle?: 'month' | 'quarterly' } = {},
) => {
  const active = await getActiveSubscription(organizationId);
  if (!active) {
    throw new ApiError(httpStatus.NOT_FOUND, 'NO_ACTIVE_SUBSCRIPTION');
  }

  if (mode === 'continue') {
    const newExpiry = computeExpiresAt(
      active.billing_cycle,
      0,
      active.expires_at,
    );
    active.expires_at = newExpiry;
    await active.save();
    await writeActiveSubCache(active, false);

    const futures = await getOrganizationSubscriptionQueue(organizationId);
    if (futures.length) {
      const shiftOps = futures.map((sub, index) => ({
        updateOne: {
          filter: { _id: sub._id },
          update: { $set: { queue_priority: index + 2 } },
        },
      }));
      await Subscription.bulkWrite(shiftOps);
      const nextPaymentId = await createManualPaymentRecord({
        organization_id: active.organization_id,
        plan_id: active.plan_id,
        price: active.plan_price,
        currency_code: active.currency_code,
        billing_cycle: active.billing_cycle,
      });
      const queuedSub = await Subscription.create({
        organization_id: toObjectId(organizationId),
        plan_id: active.plan_id,
        payment_id: nextPaymentId,
        features: active.features.map((f) => ({
          features_name: f.features_name,
          scan_limit: f.scan_limit,
        })),
        billing_cycle: active.billing_cycle,
        status: 'future',
        started_at: newExpiry,
        expires_at: computeExpiresAt(active.billing_cycle, 0, newExpiry),
        queue_priority: 1,
        reminders_sent: [],
        marketing_features: active.marketing_features ?? [],
        trial_days: 0,
        currency_code: active.currency_code,
        plan_price: active.plan_price,
        plan_name: active.plan_name,
        is_plan_cancel: false,
      });
      void dispatchSubscriptionGrantEmails(organizationId, queuedSub as any);
    }
    await normalizeQueuePriorities(organizationId);
    return createResponse(httpStatus.OK, 'Subscription renewed.', {
      activeSubscription: await getActiveSubscription(organizationId),
      futureQueue: await getOrganizationSubscriptionQueue(organizationId),
    });
  }

  if (mode === 'promote') {
    const queuedHead = await Subscription.findOne(futureQuery(organizationId))
      .sort({ queue_priority: 1 })
      .select('_id');
    if (!queuedHead) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'No queued subscription to promote',
      );
    }

    // The current active must be retired first, otherwise promoting the queue head
    // leaves the organization with two active subscriptions.
    const cancelled = await cancelActiveSubscription(
      organizationId,
      'Replaced by queued subscription',
    );
    const { cancelledSubscription, promotedSubscription } = cancelled.data;
    const next = promotedSubscription
      ? await Subscription.findById(promotedSubscription)
      : null;
    if (!next) {
      throw new ApiError(
        httpStatus.NOT_FOUND,
        'No queued subscription to promote',
      );
    }
    return createResponse(
      httpStatus.OK,
      'Next queued subscription activated.',
      {
        cancelledSubscription,
        subscription: next,
        futureQueue: await getOrganizationSubscriptionQueue(organizationId),
      },
    );
  }

  active.status = 'cancelled';
  active.cancellation_reason = 'recreate';
  await active.save();
  await flushActiveSubUsage(organizationId);
  await deleteActiveSubCache(organizationId);
  const created = await grantSubscription(
    organizationId,
    options.planId ?? String(active.plan_id),
    {
      trialDays: 0,
      billingCycle: options.billingCycle ?? active.billing_cycle,
    },
  );
  await normalizeQueuePriorities(organizationId);
  void dispatchSubscriptionGrantEmails(organizationId, created as any);
  return createResponse(httpStatus.OK, 'Subscription recreated.', {
    subscription: created,
    futureQueue: await getOrganizationSubscriptionQueue(organizationId),
  });
};

export const cancelActiveSubscription = async (
  organizationId: string,
  reason?: string,
) => {
  const active = await getActiveSubscription(organizationId);
  if (!active) {
    throw new ApiError(httpStatus.NOT_FOUND, 'NO_ACTIVE_SUBSCRIPTION');
  }
  await flushActiveSubUsage(organizationId);
  active.status = 'cancelled';
  active.cancellation_reason = reason || 'Cancelled';
  await active.save();
  await deleteActiveSubCache(organizationId);
  const promoted = await promoteEarliestFutureSubscription(organizationId);
  await normalizeQueuePriorities(organizationId);
  return createResponse(httpStatus.OK, 'Active subscription cancelled.', {
    cancelledSubscription: active._id,
    promotedSubscription: promoted?._id ?? null,
  });
};

export const forceActivateSubscription = async (
  organizationId: string,
  planId: string,
  options: {
    trialDays?: number;
    billingCycle?: 'month' | 'quarterly';
    startDate?: Date | string | null;
  } = {},
) => {
  const existingActive = await getActiveSubscription(organizationId);
  if (existingActive) {
    await flushActiveSubUsage(organizationId);
    await Usage.deleteMany({ subscription_id: existingActive._id });
    existingActive.status = 'cancelled';
    existingActive.cancellation_reason = 'Force activated';
    await existingActive.save();
    await deleteActiveSubCache(organizationId);
  }
  const created = await grantSubscription(organizationId, planId, {
    trialDays: options.trialDays ?? 0,
    forceActive: true,
    billingCycle: options.billingCycle,
    startDate: options.startDate ?? null,
  });
  await normalizeQueuePriorities(organizationId);
  void dispatchSubscriptionGrantEmails(organizationId, created as any);
  return createResponse(httpStatus.OK, 'Subscription force-activated.', {
    subscription: created,
  });
};

/**
 * `usages` lists every feature snapshot on the active plan. 'scan' carries the
 * live counter; the remaining features are metadata-only (0 used / N limit),
 * matching the honest charting contract the panel already consumes.
 */
const buildUsageRows = (
  features: ISubscriptionFeature[],
  counterValue: number,
  startedAt: Date,
  expiresAt: Date,
) =>
  features.map((f) => ({
    feature_name: f.features_name,
    usage: f.features_name === 'scan' ? counterValue : 0,
    scan_limit: f.scan_limit,
    started_at: startedAt,
    expires_at: expiresAt,
  }));

const buildUsagePayload = async (
  organizationId: string,
  active: ISubscription | null,
) => {
  if (!active) {
    return {
      period_count: 0,
      scan_limit: 0,
      quota_period: null as 'month' | 'quarterly' | null,
      subscription_expires_at: null as Date | null,
      usages: [] as {
        feature_name: string;
        usage: number;
        scan_limit: number;
        started_at: Date;
        expires_at: Date;
      }[],
    };
  }
  const row = await Usage.findOne({
    organization_id: toObjectId(organizationId),
    subscription_id: active._id,
  });
  const cache = await readActiveSubUsage(organizationId, active as any);
  const counter = cache?.used ?? row?.usage ?? 0;
  return {
    period_count: counter,
    scan_limit: scanLimitOf(active.features),
    quota_period: active.billing_cycle,
    subscription_expires_at: active.expires_at,
    usages: buildUsageRows(
      active.features ?? [],
      counter,
      active.started_at,
      active.expires_at,
    ),
  };
};

export const getSubscriptionSummary = async (
  organizationId: string,
): Promise<ReturnType<typeof createResponse>> => {
  const active = await Subscription.findOne(activeSubQuery(organizationId))
    .populate('plan_id')
    .sort({ created_at: -1 });
  const futureQueue = await Subscription.find(futureQuery(organizationId))
    .populate('plan_id')
    .sort({ queue_priority: 1 });

  return createResponse(httpStatus.OK, 'Subscription fetched successfully.', {
    activeSubscription: active ? toSubscriptionView(active) : null,
    futureQueue: futureQueue.map((sub) => toSubscriptionView(sub)),
    usage: await buildUsagePayload(organizationId, active),
  });
};

export const getOrganizationUsage = async (organizationId: string) => {
  const active = await getActiveSubscription(organizationId);
  return createResponse(
    httpStatus.OK,
    'Organization usage fetched successfully.',
    {
      organization_id: organizationId,
      usage: await buildUsagePayload(organizationId, active),
    },
  );
};

/** Flattens a Payment row into the invoice/payment card attached to the ledger. */
const toSubscriptionPaymentView = (payment: any) => {
  if (!payment) return null;
  return {
    payment_id: String(payment._id),
    invoice_number: payment.invoice_number ?? null,
    gateway: payment.gateway ?? null,
    status: payment.status ?? null,
    amount: payment.price ?? 0,
    currency_code: payment.currency_code ?? 'inr',
    billing_cycle: payment.billing_cycle ?? null,
    order_id: payment.order_id ?? null,
    transaction_id: payment.transaction_id ?? null,
    paid_at: payment.paid_at ?? null,
    created_at: payment.created_at ?? null,
  };
};

/** Full subscription ledger for an organization (all statuses, newest first). */
export const listOrganizationSubscriptions = async (
  organizationId: string,
): Promise<ReturnType<typeof createResponse>> => {
  const subscriptions = await Subscription.find({
    organization_id: toObjectId(organizationId),
  })
    .populate('plan_id')
    .populate('payment_id')
    .sort({ created_at: -1 });
  return createResponse(httpStatus.OK, 'Subscriptions fetched successfully.', {
    organization_id: organizationId,
    subscriptions: subscriptions.map((sub: any) => ({
      ...toSubscriptionView(sub),
      payment: toSubscriptionPaymentView(sub.payment_id),
    })),
  });
};
