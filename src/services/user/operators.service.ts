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
  return createResponse(httpStatus.OK, 'Operators fetched successfully.', {
    results: users.results,
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
];

export const updateOperatorById = async (
  operatorId: string,
  updateBody: Record<string, any>,
  reqUser: any,
) => {
  const user = await getOperatorById(operatorId, reqUser);

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

  OPERATOR_UPDATE_KEYS.forEach((key) => {
    if (updateBody[key] !== undefined) {
      (user as any)[key] = updateBody[key];
    }
  });
  user.modified_by = reqUser._id;
  await user.save();
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
  user.role = role;
  user.modified_by = reqUser._id;
  await user.save();
  return user;
};

export const updateOperatorStatusById = async (
  operatorId: string,
  body: { status?: number; action_type?: string },
  reqUser: any,
) => {
  const user = await getOperatorById(operatorId, reqUser);
  user.status = computeStatus(body, user.status);
  user.modified_by = reqUser._id;
  await user.save();
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
  user.status = 2;
  user.modified_by = reqUser._id;
  await user.save();
  return user;
};
