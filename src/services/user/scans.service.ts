import httpStatus from 'http-status';
import { Scan } from '../../models/scan.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { createResponse, toObjectId } from '../common.service.js';
import { isSuperAdmin } from '../../middlewares/guards/isSuperAdmin.js';
import { resolveOrganizationScope } from '../../middlewares/guards/orgScope.js';
import {
  assertOrganizationActive,
  incrementScanUsage,
} from '../quota.service.js';
import { createDeliveryAndEnqueue } from './webhooks.service.js';

const resolveScanOrg = (reqUser: any, explicitOrgId?: any) =>
  resolveOrganizationScope(reqUser, explicitOrgId, { required: true })!;

export const createScan = async (
  userBody: Record<string, any>,
  reqUser: any,
) => {
  const organizationId = resolveScanOrg(reqUser, userBody.organizationId);
  const org = await assertOrganizationActive(String(organizationId));

  const filter = {
    organizationId,
    clientScanId: String(userBody.clientScanId),
  };

  const existing = await Scan.findOne(filter);
  if (existing) {
    return createResponse(
      httpStatus.OK,
      'Scan already exists (duplicate ignored).',
      { scan: existing, created: false },
    );
  }

  const insert = {
    organizationId,
    userId: reqUser._id,
    clientScanId: String(userBody.clientScanId),
    deviceId: userBody.deviceId,
    barcode: userBody.barcode,
    barcodeType: userBody.barcodeType,
    scannedAt: userBody.scannedAt || new Date(),
  };

  try {
    const scan = await Scan.create(insert);
    await incrementScanUsage(
      String(organizationId),
      org.scanQuota?.period ?? 'monthly',
    );
    await createDeliveryAndEnqueue(scan);
    return createResponse(
      httpStatus.ACCEPTED,
      'Scan accepted for processing.',
      { scan, created: true },
    );
  } catch (err: any) {
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
};

export const listScans = async (
  filter: Record<string, any>,
  options: Record<string, any>,
  reqUser: any,
) => {
  const orgScope = resolveOrganizationScope(reqUser, filter.organizationId);

  const query: Record<string, any> = {};
  if (orgScope) {
    query.organizationId = orgScope;
  }
  if (filter.userId) {
    query.userId = toObjectId(filter.userId);
  }
  if (filter.barcode) {
    query.barcode = filter.barcode;
  }

  const scans = await (Scan as any).paginate(query, options);
  return createResponse(httpStatus.OK, 'Scans fetched successfully.', {
    results: scans.results,
    page: scans.page,
    limit: scans.limit,
    totalPages: scans.totalPages,
    totalResults: scans.totalResults,
  });
};

export const getScanById = async (scanId: string, reqUser: any) => {
  const scan = await Scan.findById(toObjectId(scanId));
  if (!scan) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Scan not found');
  }
  if (
    !isSuperAdmin(reqUser) &&
    (!reqUser.organizationId ||
      String(scan.organizationId) !== String(reqUser.organizationId))
  ) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  return scan;
};
