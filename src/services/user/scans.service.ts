import httpStatus from 'http-status';
import type mongoose from 'mongoose';
import config from '../../config/config.js';
import { Scan } from '../../models/scan.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { createResponse, toObjectId } from '../common.service.js';
import { isSuperAdmin } from '../../middlewares/guards/isSuperAdmin.js';
import { resolveOrganizationScope } from '../../middlewares/guards/orgScope.js';
import {
  assertOrganizationActive,
  reserveScanUsage,
  releaseScanUsage,
  dailyUsageDayKey,
  nextDailyResetAt,
  type ReserveResult,
} from '../quota.service.js';
import { populateActiveSubCache } from '../subscription.service.js';
import { enqueueDailyQuotaAlert } from '../../queues/notification.queue.js';
import { createDeliveryAndEnqueue } from './webhooks.service.js';

const resolveScanOrg = (reqUser: any, explicitOrgId?: any) =>
  resolveOrganizationScope(reqUser, explicitOrgId, { required: true })!;

/** Business-day context captured once at the start of a request/batch. */
export interface DailyScanContext {
  dayKey: string;
  resetAt: string;
  timezone: string;
  now: Date;
}

/** Mutable usage snapshot filled from the reserve script by `createScan`. */
export interface ScanUsageRef {
  used: number;
  limit: number;
  dailyApplied: boolean;
}

const buildDailyContext = (): DailyScanContext => {
  const now = new Date();
  return {
    dayKey: dailyUsageDayKey(now),
    resetAt: nextDailyResetAt(now).toISOString(),
    timezone: config.dailyLimit.timezone,
    now,
  };
};

const recordReserveUsage = (
  ref: ScanUsageRef | undefined,
  result: ReserveResult,
): void => {
  if (!ref) return;
  switch (result.status) {
    case 'ok':
      ref.used = result.orgDaily;
      ref.limit = result.dailyLimit;
      ref.dailyApplied = result.dailyApplied;
      break;
    case 'organization_daily_exceeded':
      ref.used = result.orgDaily;
      ref.limit = result.dailyLimit;
      ref.dailyApplied = true;
      break;
    default:
      break;
  }
};

/**
 * Pre-resolved organisation context, supplied by callers that have already
 * resolved and asserted the org (see `batchCreateScans`).
 *
 * `organizationVerified` skips the `assertOrganizationActive` database lookup.
 * This is OPT-IN: when omitted, this function behaves exactly as before, so
 * `POST /api/scans` and its existing tests are untouched.
 *
 * `dailyContext`/`usageRef` let a batch compute the business day and operator
 * cap once per request and read back the post-reserve usage snapshot.
 */
export type PreResolvedScanOrg = {
  organizationId?: mongoose.Types.ObjectId | string;
  organizationVerified?: boolean;
  dailyLimit?: number;
  dailyContext?: DailyScanContext;
  usageRef?: ScanUsageRef;
};

export const createScan = async (
  userBody: Record<string, any>,
  reqUser: any,
  preResolved?: PreResolvedScanOrg,
) => {
  const organizationId =
    preResolved?.organizationId ??
    resolveScanOrg(reqUser, userBody.organization_id);
  let dailyLimit = preResolved?.dailyLimit;
  if (dailyLimit === undefined) {
    const org = await assertOrganizationActive(String(organizationId));
    dailyLimit = Number((org as any).daily_scan_limit ?? 0) || 0;
  }

  const daily = preResolved?.dailyContext ?? buildDailyContext();

  const filter = {
    organization_id: organizationId,
    client_scan_id: String(userBody.client_scan_id),
  };

  // §4: atomic cache-backed reserve (single Redis round trip). -2 is a cold
  // cache, not an error: fall back to Mongo exactly once, then retry once.
  const reserve = () =>
    reserveScanUsage(String(organizationId), {
      dailyLimit,
      dayKey: daily.dayKey,
      now: daily.now,
    });
  let reserved = await reserve();
  if (reserved.status === 'cache_miss') {
    const hasActive = await populateActiveSubCache(String(organizationId));
    if (!hasActive) {
      throw new ApiError(httpStatus.FORBIDDEN, 'NO_ACTIVE_SUBSCRIPTION');
    }
    reserved = await reserve();
    if (reserved.status === 'cache_miss') {
      throw new ApiError(httpStatus.FORBIDDEN, 'NO_ACTIVE_SUBSCRIPTION');
    }
  }
  recordReserveUsage(preResolved?.usageRef, reserved);

  if (reserved.status === 'ok' && reserved.orgCrossing !== 'none') {
    void enqueueDailyQuotaAlert({
      organization_id: String(organizationId),
      level: reserved.orgCrossing === 'limit' ? 'limit' : 'near',
      day_key: daily.dayKey,
      used: reserved.orgDaily,
      limit: reserved.dailyLimit,
      reset_at: daily.resetAt,
      timezone: daily.timezone,
    });
  }

  if (reserved.status === 'quota_exceeded') {
    const existing = await Scan.findOne(filter);
    if (existing) {
      return createResponse(
        httpStatus.OK,
        'Scan already exists (duplicate ignored).',
        { scan: existing, created: false },
      );
    }
    throw new ApiError(httpStatus.FORBIDDEN, 'FORBIDDEN_QUOTA_EXCEEDED');
  }
  if (reserved.status === 'organization_daily_exceeded') {
    const existing = await Scan.findOne(filter);
    if (existing) {
      return createResponse(
        httpStatus.OK,
        'Scan already exists (duplicate ignored).',
        { scan: existing, created: false },
      );
    }
    throw new ApiError(
      httpStatus.FORBIDDEN,
      'FORBIDDEN_DAILY_LIMIT_EXCEEDED',
      true,
      '',
      { reset_at: daily.resetAt, timezone: daily.timezone },
    );
  }
  if (reserved.status === 'subscription_expired') {
    throw new ApiError(httpStatus.FORBIDDEN, 'SUBSCRIPTION_EXPIRED');
  }

  const existing = await Scan.findOne(filter);
  if (existing) {
    await releaseScanUsage(
      String(organizationId),
      daily.dayKey,
      reserved.dailyApplied,
    );
    return createResponse(
      httpStatus.OK,
      'Scan already exists (duplicate ignored).',
      { scan: existing, created: false },
    );
  }

  const insert = {
    organization_id: organizationId,
    user_id: reqUser._id,
    client_scan_id: String(userBody.client_scan_id),
    device_id: userBody.device_id,
    barcode: userBody.barcode,
    barcode_type: userBody.barcode_type,
    scanned_at: userBody.scanned_at || new Date(),
  };

  let scan: any;
  try {
    scan = await Scan.create(insert);
  } catch (err: any) {
    await releaseScanUsage(
      String(organizationId),
      daily.dayKey,
      reserved.dailyApplied,
    );
    if (err && err.code === 11000) {
      const dup = await Scan.findOne(filter);
      if (!dup) throw err;
      return createResponse(
        httpStatus.OK,
        'Scan already exists (duplicate ignored).',
        { scan: dup, created: false },
      );
    }
    throw err;
  }

  await createDeliveryAndEnqueue(scan);
  return createResponse(httpStatus.ACCEPTED, 'Scan accepted for processing.', {
    scan,
    created: true,
  });
};

/**
 * Per-item outcome of a batch submission. The client reconciles against these
 * rather than the top-level HTTP status, because a batch can partially succeed.
 */
export type BatchScanItemStatus =
  | 'accepted'
  | 'duplicate'
  | 'quota_exceeded'
  | 'daily_limit_exceeded'
  | 'no_active_subscription'
  | 'subscription_expired'
  | 'failed';

export interface BatchScanItemResult {
  client_scan_id: string;
  created: boolean;
  status: BatchScanItemStatus;
  reset_at?: string;
  timezone?: string;
}

export interface BatchScanUsageSnapshot {
  used: number;
  limit: number;
  reset_at: string;
  timezone: string;
}

/**
 * Maps a thrown `ApiError` from `createScan` onto a per-item status so one
 * failure cannot abort the rest of the batch. Anything unrecognised is
 * reported as `failed` rather than thrown, so a single systemic-looking
 * error still lets the other items through.
 *
 * NOTE: `ApiError` carries these sentinels in `message` (it has no `code`
 * field) — e.g. `new ApiError(403, 'FORBIDDEN_QUOTA_EXCEEDED')` — so the
 * message is what we match on. `code` is checked first only as a cheap
 * forward-compatible path if that ever changes.
 */
const toItemFailure = (err: unknown): BatchScanItemStatus => {
  const { code, message } = (err ?? {}) as { code?: string; message?: string };
  switch (code ?? message) {
    case 'FORBIDDEN_QUOTA_EXCEEDED':
      return 'quota_exceeded';
    case 'FORBIDDEN_DAILY_LIMIT_EXCEEDED':
      return 'daily_limit_exceeded';
    case 'NO_ACTIVE_SUBSCRIPTION':
      return 'no_active_subscription';
    case 'SUBSCRIPTION_EXPIRED':
      return 'subscription_expired';
    default:
      return 'failed';
  }
};

const isLimitStatus = (status: BatchScanItemStatus): boolean =>
  status === 'quota_exceeded' || status === 'daily_limit_exceeded';

const isDailyStatus = (status: BatchScanItemStatus): boolean =>
  status === 'daily_limit_exceeded';

/**
 * Submits many already-decoded scans in one request.
 *
 * This is a THIN LOOP over `createScan` — no duplicate quota-reservation,
 * dedupe, insert or webhook logic. The atomic per-scan operation is exactly
 * the one the single-scan endpoint uses, so the existing concurrency
 * guarantees carry over unchanged.
 *
 * The only optimisation is hoisting the organisation lookup:
 * `assertOrganizationActive` performs an `Organization.findById()` per call,
 * so it runs once per batch instead of once per item. Resolution itself is
 * pure and cheap — it is the database round trip that costs.
 *
 * The business day and organization daily limit are computed once per request.
 * Once an item hits a limit (cycle or daily), the remaining items receive the
 * same status without another Redis call: the state cannot change within
 * milliseconds, so a blocked client costs one script call per batch.
 */
export const batchCreateScans = async (
  scans: Record<string, any>[],
  reqUser: any,
) => {
  const organizationId = resolveScanOrg(reqUser, scans[0]?.organization_id);
  // Once per batch, not once per item — the whole point of batching.
  const organization = await assertOrganizationActive(String(organizationId));
  const dailyLimit = Number((organization as any).daily_scan_limit ?? 0) || 0;

  const dailyContext = buildDailyContext();
  const usageRef: ScanUsageRef = { used: 0, limit: 0, dailyApplied: false };

  const preResolved: PreResolvedScanOrg = {
    organizationId,
    organizationVerified: true,
    dailyLimit,
    dailyContext,
    usageRef,
  };

  const results: BatchScanItemResult[] = [];
  let shortCircuit: BatchScanItemStatus | null = null;

  for (const scan of scans) {
    const clientScanId = String(scan?.client_scan_id ?? '');
    const itemMeta = isDailyStatus(shortCircuit ?? 'accepted')
      ? { reset_at: dailyContext.resetAt, timezone: dailyContext.timezone }
      : {};
    if (shortCircuit) {
      results.push({
        client_scan_id: clientScanId,
        created: false,
        status: shortCircuit,
        ...itemMeta,
      });
      continue;
    }
    try {
      // Each item's own organization_id is ignored: a batch can never span
      // organisations, they all belong to the caller's resolved org.
      const result = await createScan(
        { ...scan, organization_id: undefined },
        reqUser,
        preResolved,
      );
      results.push({
        client_scan_id: clientScanId,
        created: Boolean(result.data?.created),
        status: result.data?.created ? 'accepted' : 'duplicate',
      });
    } catch (err) {
      const status = toItemFailure(err);
      results.push({
        client_scan_id: clientScanId,
        created: false,
        status,
        ...(isDailyStatus(status)
          ? { reset_at: dailyContext.resetAt, timezone: dailyContext.timezone }
          : {}),
      });
      if (isLimitStatus(status)) {
        shortCircuit = status;
      }
    }
  }

  const data: Record<string, any> = { results };
  if (usageRef.dailyApplied) {
    const usage: BatchScanUsageSnapshot = {
      used: usageRef.used,
      limit: usageRef.limit,
      reset_at: dailyContext.resetAt,
      timezone: dailyContext.timezone,
    };
    data.usage = usage;
  }

  return createResponse(httpStatus.OK, 'Batch processed.', data);
};

const toSortBy = (sortBy?: string): string => {
  if (!sortBy) return 'scanned_at:desc';
  return sortBy
    .split(',')
    .map((option) => option.trim())
    .filter(Boolean)
    .map((option) => {
      if (option.includes(':')) return option;
      if (option.startsWith('-')) return `${option.slice(1)}:desc`;
      return `${option}:asc`;
    })
    .join(',');
};

export const listScans = async (
  filter: Record<string, any>,
  options: Record<string, any>,
  reqUser: any,
) => {
  const orgScope = resolveOrganizationScope(reqUser, filter.organization_id);

  const query: Record<string, any> = {};
  if (orgScope) {
    query.organization_id = orgScope;
  }
  if (filter.user_id) {
    query.user_id = toObjectId(filter.user_id);
  }
  if (filter.barcode) {
    query.barcode = filter.barcode;
  }

  const scans = await (Scan as any).paginate(query, {
    ...options,
    sortBy: toSortBy(options.sort_by ?? options.sortBy),
    populate: 'user_id',
  });

  // Flatten the populated operator into a display name and restore `user_id`
  // to a plain id, so existing consumers keep working unchanged.
  const results = scans.results.map((scan: any) => {
    const json = typeof scan.toJSON === 'function' ? scan.toJSON() : scan;
    const user =
      json.user_id && typeof json.user_id === 'object' ? json.user_id : null;
    const name = user
      ? [user.first_name, user.last_name].filter(Boolean).join(' ')
      : '';
    return {
      ...json,
      user_id: user ? (user.id ?? String(user._id)) : json.user_id,
      operator_name: name || null,
    };
  });

  return createResponse(httpStatus.OK, 'Scans fetched successfully.', {
    results,
    page: scans.page,
    limit: scans.limit,
    total_pages: scans.total_pages,
    total_results: scans.total_results,
  });
};

export const getScanById = async (scanId: string, reqUser: any) => {
  const scan = await Scan.findById(toObjectId(scanId));
  if (!scan) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Scan not found');
  }
  if (
    !isSuperAdmin(reqUser) &&
    (!reqUser.organization_id ||
      String(scan.organization_id) !== String(reqUser.organization_id))
  ) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  return scan;
};
