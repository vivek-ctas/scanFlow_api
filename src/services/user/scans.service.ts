import httpStatus from 'http-status';
import type mongoose from 'mongoose';
import { Scan } from '../../models/scan.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { createResponse, toObjectId } from '../common.service.js';
import { isSuperAdmin } from '../../middlewares/guards/isSuperAdmin.js';
import { resolveOrganizationScope } from '../../middlewares/guards/orgScope.js';
import {
  assertOrganizationActive,
  reserveScanUsage,
  releaseScanUsage,
} from '../quota.service.js';
import { populateActiveSubCache } from '../subscription.service.js';
import { createDeliveryAndEnqueue } from './webhooks.service.js';

const resolveScanOrg = (reqUser: any, explicitOrgId?: any) =>
  resolveOrganizationScope(reqUser, explicitOrgId, { required: true })!;

/**
 * Pre-resolved organisation context, supplied by callers that have already
 * resolved and asserted the org (see `batchCreateScans`).
 *
 * `organizationVerified` skips the `assertOrganizationActive` database lookup.
 * This is OPT-IN: when omitted, this function behaves exactly as before, so
 * `POST /api/scans` and its existing tests are untouched.
 */
export type PreResolvedScanOrg = {
  organizationId?: mongoose.Types.ObjectId | string;
  organizationVerified?: boolean;
};

export const createScan = async (
  userBody: Record<string, any>,
  reqUser: any,
  preResolved?: PreResolvedScanOrg,
) => {
  const organizationId =
    preResolved?.organizationId ??
    resolveScanOrg(reqUser, userBody.organization_id);
  if (!preResolved?.organizationVerified) {
    await assertOrganizationActive(String(organizationId));
  }

  const filter = {
    organization_id: organizationId,
    client_scan_id: String(userBody.client_scan_id),
  };

  // §4: atomic cache-backed reserve (single Redis round trip). -2 is a cold
  // cache, not an error: fall back to Mongo exactly once, then retry once.
  const reserve = () => reserveScanUsage(String(organizationId));
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
  if (reserved.status === 'quota_exceeded') {
    throw new ApiError(httpStatus.FORBIDDEN, 'FORBIDDEN_QUOTA_EXCEEDED');
  }
  if (reserved.status === 'subscription_expired') {
    throw new ApiError(httpStatus.FORBIDDEN, 'SUBSCRIPTION_EXPIRED');
  }

  const existing = await Scan.findOne(filter);
  if (existing) {
    await releaseScanUsage(String(organizationId));
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

  try {
    const scan = await Scan.create(insert);
    await createDeliveryAndEnqueue(scan);
    return createResponse(
      httpStatus.ACCEPTED,
      'Scan accepted for processing.',
      { scan, created: true },
    );
  } catch (err: any) {
    if (err && err.code === 11000) {
      await releaseScanUsage(String(organizationId));
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
};

/**
 * Per-item outcome of a batch submission. The client reconciles against these
 * rather than the top-level HTTP status, because a batch can partially succeed.
 */
export type BatchScanItemStatus =
  | 'accepted'
  | 'duplicate'
  | 'quota_exceeded'
  | 'no_active_subscription'
  | 'subscription_expired'
  | 'failed';

export interface BatchScanItemResult {
  client_scan_id: string;
  created: boolean;
  status: BatchScanItemStatus;
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
    case 'NO_ACTIVE_SUBSCRIPTION':
      return 'no_active_subscription';
    case 'SUBSCRIPTION_EXPIRED':
      return 'subscription_expired';
    default:
      return 'failed';
  }
};

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
 * Items are processed in sequence, and each in its own try/catch, so a
 * mid-batch quota exhaustion cannot discard the scans that already
 * succeeded or the ones that follow it.
 */
export const batchCreateScans = async (
  scans: Record<string, any>[],
  reqUser: any,
) => {
  const organizationId = resolveScanOrg(reqUser, scans[0]?.organization_id);
  // Once per batch, not once per item — the whole point of batching.
  await assertOrganizationActive(String(organizationId));

  const preResolved: PreResolvedScanOrg = {
    organizationId,
    organizationVerified: true,
  };

  const results: BatchScanItemResult[] = [];

  for (const scan of scans) {
    const clientScanId = String(scan?.client_scan_id ?? '');
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
      results.push({
        client_scan_id: clientScanId,
        created: false,
        status: toItemFailure(err),
      });
    }
  }

  return createResponse(httpStatus.OK, 'Batch processed.', { results });
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

  const scans = await (Scan as any).paginate(query, options);
  return createResponse(httpStatus.OK, 'Scans fetched successfully.', {
    results: scans.results,
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
