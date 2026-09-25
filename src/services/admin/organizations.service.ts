import httpStatus from 'http-status';
import { Organization } from '../../models/organization.model.js';
import { User } from '../../models/user.model.js';
import { ApiError } from '../../utils/ApiError.js';
import {
  computeStatus,
  createResponse,
  escapeRegExp,
  normalizeEmail,
  toObjectId,
} from '../common.service.js';
import { getPeriodScanCount } from '../quota.service.js';
import { isSuperAdmin } from '../../middlewares/guards/isSuperAdmin.js';

export const createOrganization = async (
  orgBody: Record<string, any>,
  createdBy?: string,
) => {
  const adminEmail = normalizeEmail(orgBody.adminEmail);
  if (!adminEmail) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'adminEmail is required');
  }
  if (await User.isEmailTaken(adminEmail)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
  }

  const org = await Organization.create({
    name: orgBody.name,
    email: orgBody.email,
    contactNumber: orgBody.contactNumber,
    status: orgBody.status ?? 1,
    scanQuota: {
      limit: orgBody.scanQuotaLimit ?? 0,
      period: orgBody.period ?? 'monthly',
      periodStart: new Date(),
    },
    created_by: createdBy ? toObjectId(createdBy) : null,
  });

  const admin = await User.create({
    first_name: orgBody.adminFirstName || 'Organization',
    last_name: orgBody.adminLastName || 'Admin',
    email: adminEmail,
    contact_no: orgBody.adminContactNo,
    role: 'ORGANIZATION_ADMIN',
    organizationId: org._id,
    isSuperAdmin: false,
    isEmailVerified: false,
    status: 1,
    created_by: createdBy ? toObjectId(createdBy) : null,
  });

  return createResponse(
    httpStatus.CREATED,
    'Organization created successfully.',
    { organization: org, admin },
  );
};

export const listOrganizations = async (
  filter: Record<string, any>,
  options: Record<string, any>,
) => {
  const query: Record<string, any> = {};
  if (filter.status !== undefined) {
    query.status = Number(filter.status);
  } else {
    query.status = { $ne: 2 };
  }
  if (filter.search) {
    const regex = new RegExp(escapeRegExp(String(filter.search)), 'i');
    query.$or = [{ name: regex }, { email: regex }];
  }

  const orgs = await (Organization as any).paginate(query, options);
  return createResponse(httpStatus.OK, 'Organizations fetched successfully.', {
    results: orgs.results,
    page: orgs.page,
    limit: orgs.limit,
    totalPages: orgs.totalPages,
    totalResults: orgs.totalResults,
  });
};

export const getOrganizationById = async (organizationId: string) => {
  const org = await Organization.findById(organizationId);
  if (!org || org.status === 2) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Organization not found');
  }
  return org;
};

const ORG_UPDATE_KEYS = [
  'name',
  'email',
  'contactNumber',
  'status',
  'scanQuota',
];

export const updateOrganizationById = async (
  organizationId: string,
  updateBody: Record<string, any>,
  modifiedBy?: string,
) => {
  const org = await getOrganizationById(organizationId);
  ORG_UPDATE_KEYS.forEach((key) => {
    if (updateBody[key] !== undefined) {
      (org as any)[key] = updateBody[key];
    }
  });
  org.modified_by = modifiedBy ? toObjectId(modifiedBy) : null;
  await org.save();
  return org;
};

export const updateOrganizationStatusById = async (
  organizationId: string,
  body: { status?: number; action_type?: string },
  modifiedBy?: string,
) => {
  const org = await getOrganizationById(organizationId);
  org.status = computeStatus(body, org.status);
  org.modified_by = modifiedBy ? toObjectId(modifiedBy) : null;
  await org.save();
  return org;
};

export const deleteOrganizationById = async (
  organizationId: string,
  actorId?: string,
) => {
  const org = await getOrganizationById(organizationId);
  org.status = 2;
  org.modified_by = actorId ? toObjectId(actorId) : null;
  await org.save();
  return org;
};

export const getOrganizationUsage = async (
  organizationId: string,
  reqUser: any,
) => {
  const org = await getOrganizationById(organizationId);
  if (
    !isSuperAdmin(reqUser) &&
    String(org._id) !== String(reqUser.organizationId)
  ) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const periodCount = await getPeriodScanCount(
    organizationId,
    org.scanQuota?.period ?? 'monthly',
  );
  return createResponse(
    httpStatus.OK,
    'Organization usage fetched successfully.',
    {
      organization: org,
      usage: {
        periodCount,
        quotaLimit: org.scanQuota?.limit ?? 0,
        quotaPeriod: org.scanQuota?.period ?? 'monthly',
      },
    },
  );
};
