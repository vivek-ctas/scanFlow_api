import httpStatus from 'http-status';
import { Organization } from '../../models/organization.model.js';
import { User } from '../../models/user.model.js';
import { Plan } from '../../models/plan.model.js';
import { Subscription } from '../../models/subscription.model.js';
import { ApiError } from '../../utils/ApiError.js';
import {
  computeStatus,
  createResponse,
  escapeRegExp,
  normalizeEmail,
  toObjectId,
} from '../common.service.js';
import { grantSubscription } from '../subscription.service.js';

export const createOrganization = async (
  orgBody: Record<string, any>,
  createdBy?: string,
) => {
  const isLegacy = orgBody.admin_email !== undefined;

  const adminFields = isLegacy
    ? {
        first_name: orgBody.admin_first_name || 'Organization',
        last_name: orgBody.admin_last_name || 'Admin',
        email: normalizeEmail(orgBody.admin_email),
        contact_number: orgBody.admin_contact_no,
        company_name: orgBody.admin_company_name,
        country_name: orgBody.admin_country_name,
        business_address: orgBody.admin_business_address,
      }
    : {
        first_name: orgBody.first_name,
        last_name: orgBody.last_name,
        email: normalizeEmail(orgBody.email),
        contact_number: orgBody.contact_number,
        company_name: orgBody.company_name,
        country_name: orgBody.country_name,
        business_address: orgBody.business_address,
      };

  if (!adminFields.email) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'admin_email is required');
  }
  if (await User.isEmailTaken(adminFields.email)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
  }

  const billingCycle = orgBody.billing_cycle ?? 'month';
  if (orgBody.plan_id) {
    const plan = await Plan.findById(orgBody.plan_id);
    if (!plan || plan.status !== 1) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Plan not found or not active',
      );
    }
    if (billingCycle === 'quarterly' && !(plan.price_quarterly ?? 0)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Quarterly pricing is not configured for this plan',
      );
    }
  }

  const org = await Organization.create({
    company_name: orgBody.company_name ?? orgBody.name,
    email: orgBody.email,
    contact_number: orgBody.contact_number,
    country_name: orgBody.country_name,
    status: orgBody.status ?? 1,
    created_by: createdBy ? toObjectId(createdBy) : null,
  });

  const admin = await User.create({
    ...adminFields,
    role: 'ORGANIZATION_ADMIN',
    organization_id: org._id,
    is_super_admin: false,
    is_email_verified: false,
    status: 1,
    created_by: createdBy ? toObjectId(createdBy) : null,
  });

  const data: Record<string, any> = { organization: org, admin };
  if (orgBody.plan_id) {
    data.subscription = await grantSubscription(
      String(org._id),
      String(orgBody.plan_id),
      { billingCycle },
    );
  }

  return createResponse(
    httpStatus.CREATED,
    'Organization created successfully.',
    data,
  );
};

const buildSubscriptionSummaryMap = async (orgIds: string[]) => {
  const subs = await Subscription.find({
    organization_id: { $in: orgIds.map((id) => toObjectId(id)) },
    status: { $in: ['active', 'future'] },
  }).select(
    'organization_id plan_id plan_name billing_cycle status started_at expires_at',
  );

  const planMap: Record<string, any> = {};
  const futureCountMap: Record<string, number> = {};
  for (const sub of subs) {
    const orgId = String(sub.organization_id);
    if (sub.status === 'active' && !planMap[orgId]) {
      planMap[orgId] = {
        plan_id: sub.plan_id,
        plan_name: sub.plan_name,
        billing_cycle: sub.billing_cycle,
        started_at: sub.started_at,
        expires_at: sub.expires_at,
        status: sub.status,
      };
    }
    if (sub.status === 'future') {
      futureCountMap[orgId] = (futureCountMap[orgId] ?? 0) + 1;
    }
  }
  return { planMap, futureCountMap };
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
    query.$or = [{ company_name: regex }, { email: regex }];
  }

  const orgs = await (Organization as any).paginate(query, options);
  const orgIds = orgs.results.map((org: any) => String(org._id));
  const { planMap, futureCountMap } = await buildSubscriptionSummaryMap(orgIds);
  const results = orgs.results.map((org: any) => {
    const orgId = String(org._id);
    const plain = typeof org.toJSON === 'function' ? org.toJSON() : { ...org };
    return {
      ...plain,
      plan: planMap[orgId] ?? null,
      future_queue_count: futureCountMap[orgId] ?? 0,
    };
  });
  return createResponse(httpStatus.OK, 'Organizations fetched successfully.', {
    results,
    page: orgs.page,
    limit: orgs.limit,
    total_pages: orgs.total_pages,
    total_results: orgs.total_results,
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
  'company_name',
  'email',
  'contact_number',
  'country_name',
  'status',
];

export const updateOrganizationById = async (
  organizationId: string,
  updateBody: Record<string, any>,
  modifiedBy?: string,
) => {
  const org = await getOrganizationById(organizationId);
  const normalized = { ...updateBody };
  if (normalized.company_name === undefined && normalized.name !== undefined) {
    normalized.company_name = normalized.name;
  }
  ORG_UPDATE_KEYS.forEach((key) => {
    if (normalized[key] !== undefined) {
      (org as any)[key] = normalized[key];
    }
  });
  org.modified_by = modifiedBy ? toObjectId(modifiedBy) : null;
  await org.save();

  if (normalized.company_name !== undefined) {
    await User.updateOne(
      { organization_id: org._id, role: 'ORGANIZATION_ADMIN' },
      { $set: { company_name: normalized.company_name } },
    );
  }

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
