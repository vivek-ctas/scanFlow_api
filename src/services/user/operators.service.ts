import httpStatus from 'http-status';
import mongoose from 'mongoose';
import { User, Organization } from '../../models/index.js';
import { ApiError } from '../../utils/ApiError.js';
import {
  computeStatus,
  createResponse,
  escapeRegExp,
  normalizeEmail,
  toObjectId,
} from '../common.service.js';
import { ORGANIZATION_ASSIGNABLE_ROLES } from '../../config/roles.js';
import { resolveOrganizationScope } from '../../middlewares/guards/orgScope.js';
import { buildOperatorId } from '../../utils/operator-id.util.js';
import { invalidateDashboardCache } from '../admin/dashboard.cache.js';
import { systemLog } from '../../utils/system-log.js';
import { isSuperAdmin } from '../../middlewares/guards/isSuperAdmin.js';
import { dailyUsageDayKey, readDailyUsageHash } from '../quota.service.js';
import { getRedis, isRedisConfigured } from '../../queues/redis.js';

const OPERATOR_ROLES = ORGANIZATION_ASSIGNABLE_ROLES;
const PIN_PATTERN = /^\d{6}$/;
const MAX_OPERATOR_ID_ATTEMPTS = 5;

const buildOperatorScope = (
  reqUser: any,
  explicitOrgId?: any,
): Record<string, any> => {
  const scope: Record<string, any> = {
    is_super_admin: { $ne: true },
    role: { $in: OPERATOR_ROLES },
  };
  const orgScope = resolveOrganizationScope(reqUser, explicitOrgId);
  if (orgScope) {
    scope.organization_id = orgScope;
  } else {
    scope.organization_id = { $ne: null };
  }
  return scope;
};

export const createOperator = async (
  userBody: Record<string, any>,
  reqUser: any,
) => {
  const role = userBody.role || 'OPERATOR';
  if (!OPERATOR_ROLES.includes(role)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Operator role must be ORGANIZATION_ADMIN or OPERATOR',
    );
  }
  const organizationId = resolveOrganizationScope(
    reqUser,
    userBody.organization_id,
    { required: true },
  )!;
  const email = userBody.email ? normalizeEmail(userBody.email) : undefined;

  if ('daily_scan_limit' in (userBody ?? {}) && !isSuperAdmin(reqUser)) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      'Only a super admin may set an operator daily scan limit.',
    );
  }

  if (role === 'OPERATOR') {
    const pin = String(userBody.pin ?? '');
    if (!PIN_PATTERN.test(pin)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'A 6-digit PIN is required for OPERATOR role',
      );
    }
  } else if (!email) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Email is required for ORGANIZATION_ADMIN role',
    );
  } else if (userBody.pin) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'PIN is only allowed for OPERATOR role',
    );
  }

  if (email && (await User.isEmailTaken(email))) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
  }

  const baseUser = {
    first_name: userBody.first_name,
    last_name: userBody.last_name,
    contact_number: userBody.contact_number,
    business_address: userBody.business_address,
    role,
    organization_id: organizationId,
    is_super_admin: false,
    is_email_verified: false,
    status: userBody.status ?? 1,
    daily_scan_limit: userBody.daily_scan_limit ?? 0,
    created_by: reqUser._id,
  };

  if (email) {
    (baseUser as Record<string, any>).email = email;
  }

  let lastError: any;
  for (let attempt = 0; attempt < MAX_OPERATOR_ID_ATTEMPTS; attempt += 1) {
    let operatorId: string | undefined;
    let pinHash: string | undefined;
    if (role === 'OPERATOR') {
      const org = await Organization.findById(organizationId);
      operatorId = await buildOperatorId(org?.company_name, organizationId);
      pinHash = String(userBody.pin);
    }
    try {
      const user = await User.create({
        ...baseUser,
        operator_id: operatorId,
        pin_hash: pinHash,
      });
      void invalidateDashboardCache();
      await systemLog({
        operation: 'CREATE',
        key: 'create-operator',
        data: user.toObject(),
        actorId: reqUser._id,
        organizationId: organizationId,
      });
      return createResponse(
        httpStatus.CREATED,
        'Operator created successfully.',
        { user },
      );
    } catch (error: any) {
      // Duplicate key -> operator_id collision across orgs with the same
      // prefix; bump the per-org counter and retry.
      if ((error as { code?: number })?.code !== 11000) {
        throw error;
      }
      lastError = error;
    }
  }
  throw (
    lastError ||
    new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'Failed to allocate a unique Operator ID. Please retry.',
    )
  );
};

export const listOperators = async (
  filter: Record<string, any>,
  options: Record<string, any>,
  reqUser: any,
) => {
  const query: Record<string, any> = buildOperatorScope(
    reqUser,
    filter.organization_id,
  );
  if (filter.status !== undefined) {
    query.status = Number(filter.status);
  } else {
    query.status = { $ne: 2 };
  }
  if (filter.role) {
    query.role = filter.role;
  }
  if (filter.search) {
    const regex = new RegExp(escapeRegExp(String(filter.search)), 'i');
    query.$or = [
      { first_name: regex },
      { last_name: regex },
      { email: regex },
      { contact_number: regex },
      { operator_id: regex },
    ];
  }

  const users = await (User as any).paginate(query, {
    ...options,
    populate: 'organization_id',
  });
  const results = users.results.map((user: any) =>
    typeof user.toJSON === 'function' ? user.toJSON() : user,
  );

  // Daily usage is an admin-only column. One HGETALL per distinct organization
  // on the page (exactly one for an org-scoped request); operators never reach
  // this endpoint (no `viewOperators` right) and are guarded here as well.
  const canSeeUsage =
    isSuperAdmin(reqUser) || reqUser?.role === 'ORGANIZATION_ADMIN';
  if (canSeeUsage && results.length) {
    const dayKey = dailyUsageDayKey();
    const orgIds = [
      ...new Set<string>(
        results
          .map(
            (row: any) =>
              row.organization_id?.id ??
              row.organization_id?._id ??
              row.organization_id,
          )
          .filter(Boolean)
          .map(String),
      ),
    ];
    const usersByOrg = new Map<string, Record<string, number>>();
    const orgDailyLimit = new Map<string, number>();
    await Promise.all(
      orgIds.map(async (orgId) => {
        const usage = await readDailyUsageHash(orgId, dayKey);
        usersByOrg.set(orgId, usage.users);
        // Organization daily limit from the active-subscription hash (one HGET).
        let limit = 0;
        if (isRedisConfigured()) {
          try {
            const raw = await getRedis().hget(
              `org:${orgId}:activeSub`,
              'daily_limit',
            );
            limit = Number(raw ?? 0) || 0;
          } catch {
            limit = 0;
          }
        }
        orgDailyLimit.set(orgId, limit);
      }),
    );
    const isSuper = isSuperAdmin(reqUser);
    for (const row of results) {
      const orgId = String(
        row.organization_id?.id ?? row.organization_id ?? '',
      );
      const used = usersByOrg.get(orgId)?.[String(row.id)] ?? 0;
      row.daily_scan_used = used;
      const operatorCap = Number(row.daily_scan_limit ?? 0) || 0;
      const orgLimit = orgDailyLimit.get(orgId) ?? 0;
      // Effective limit: operator override if set, else organization limit.
      const effective =
        operatorCap > 0 ? operatorCap : orgLimit > 0 ? orgLimit : null;
      row.effective_daily_limit = effective;
      row.daily_limit_source =
        operatorCap > 0 ? 'operator' : orgLimit > 0 ? 'organization' : null;
      // Raw override is super-admin only.
      if (!isSuper) {
        delete row.daily_scan_limit;
      }
    }
  } else {
    // Hide raw override from non-admins regardless.
    for (const row of results) {
      delete row.daily_scan_limit;
      delete row.daily_scan_used;
      delete row.effective_daily_limit;
      delete row.daily_limit_source;
    }
  }

  return createResponse(httpStatus.OK, 'Operators fetched successfully.', {
    results,
    page: users.page,
    limit: users.limit,
    total_pages: users.total_pages,
    total_results: users.total_results,
  });
};

export const getOperatorById = async (
  operatorId: string,
  reqUser: any,
  orgOverride?: string,
) => {
  const query: Record<string, any> = {
    ...buildOperatorScope(reqUser, orgOverride),
    _id: toObjectId(operatorId),
    status: { $ne: 2 },
  };
  const user = await User.findOne(query);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Operator not found');
  }
  return user;
};

const OPERATOR_UPDATE_KEYS = [
  'first_name',
  'last_name',
  'contact_number',
  'business_address',
  'role',
  'status',
  'is_email_verified',
  'daily_scan_limit',
];

export const updateOperatorById = async (
  operatorId: string,
  updateBody: Record<string, any>,
  reqUser: any,
) => {
  const user = await getOperatorById(operatorId, reqUser);
  const existing = user.toObject();

  const nextRole = updateBody.role ?? user.role;
  if (!OPERATOR_ROLES.includes(nextRole)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Operator role must be ORGANIZATION_ADMIN or OPERATOR',
    );
  }

  if ('email' in updateBody) {
    const email = updateBody.email
      ? normalizeEmail(updateBody.email)
      : undefined;
    if (nextRole !== 'OPERATOR' && !email) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Email is required for ORGANIZATION_ADMIN role',
      );
    }
    if (email && (await User.isEmailTaken(email, user._id as any))) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
    }
    user.email = email ?? undefined;
  }

  if ('pin' in updateBody) {
    if (nextRole !== 'OPERATOR') {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'PIN is only allowed for OPERATOR role',
      );
    }
    if (!updateBody.pin) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'A 6-digit PIN is required for OPERATOR role',
      );
    }
    user.pin_hash = String(updateBody.pin);
    user.pin_attempt_count = 0;
    user.pin_locked_until = null;
  }

  if (nextRole === 'OPERATOR' && !user.operator_id) {
    const org = await Organization.findById(user.organization_id);
    user.operator_id = await buildOperatorId(
      org?.company_name,
      user.organization_id as mongoose.Types.ObjectId,
    );
  }
  if (nextRole !== 'OPERATOR') {
    user.pin_hash = undefined;
    user.pin_attempt_count = 0;
    user.pin_locked_until = null;
  }

  if ('daily_scan_limit' in (updateBody ?? {}) && !isSuperAdmin(reqUser)) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      'Only a super admin may set an operator daily scan limit.',
    );
  }

  OPERATOR_UPDATE_KEYS.forEach((key) => {
    if (updateBody[key] !== undefined) {
      (user as any)[key] = updateBody[key];
    }
  });
  user.modified_by = reqUser._id;
  await user.save();
  void invalidateDashboardCache();
  await systemLog({
    operation: 'UPDATE',
    key: 'update-operator',
    data: user.toObject(),
    existingData: existing,
    actorId: reqUser._id,
    organizationId: user.organization_id,
  });
  return user;
};

export const updateOperatorRoleById = async (
  operatorId: string,
  role: string,
  reqUser: any,
) => {
  if (!OPERATOR_ROLES.includes(role)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Operator role must be ORGANIZATION_ADMIN or OPERATOR',
    );
  }
  const user = await getOperatorById(operatorId, reqUser);
  const existing = user.toObject();
  user.role = role;
  user.modified_by = reqUser._id;
  await user.save();
  void invalidateDashboardCache();
  await systemLog({
    operation: 'UPDATE',
    key: 'update-operator-role',
    data: user.toObject(),
    existingData: existing,
    actorId: reqUser._id,
    organizationId: user.organization_id,
  });
  return user;
};

export const updateOperatorStatusById = async (
  operatorId: string,
  body: { status?: number; action_type?: string },
  reqUser: any,
) => {
  const user = await getOperatorById(operatorId, reqUser);
  const existing = user.toObject();
  user.status = computeStatus(body, user.status);
  user.modified_by = reqUser._id;
  await user.save();
  void invalidateDashboardCache();
  await systemLog({
    operation: 'UPDATE',
    key: 'update-operator-status',
    data: user.toObject(),
    existingData: existing,
    actorId: reqUser._id,
    organizationId: user.organization_id,
  });
  return user;
};

export const deleteOperatorById = async (operatorId: string, reqUser: any) => {
  const user = await getOperatorById(operatorId, reqUser);
  if (String(user._id) === String(reqUser._id)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'You cannot delete your own account',
    );
  }
  const existing = user.toObject();
  user.status = 2;
  user.modified_by = reqUser._id;
  await user.save();
  void invalidateDashboardCache();
  await systemLog({
    operation: 'DELETE',
    key: 'delete-operator',
    data: existing,
    actorId: reqUser._id,
    organizationId: user.organization_id,
  });
  return user;
};
