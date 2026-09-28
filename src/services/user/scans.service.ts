import httpStatus from 'http-status';
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

export const createScan = async (
  userBody: Record<string, any>,
  reqUser: any,
) => {
  const organizationId = resolveScanOrg(reqUser, userBody.organization_id);
  await assertOrganizationActive(String(organizationId));

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
