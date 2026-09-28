import httpStatus from 'http-status';
import { User } from '../../models/user.model.js';
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

const OPERATOR_ROLES = ORGANIZATION_ASSIGNABLE_ROLES;

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
  const email = normalizeEmail(userBody.email);
  if (await User.isEmailTaken(email)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
  }

  const user = await User.create({
    first_name: userBody.first_name,
    last_name: userBody.last_name,
    email,
    contact_number: userBody.contact_number,
    business_address: userBody.business_address,
    role,
    organization_id: organizationId,
    is_super_admin: false,
    is_email_verified: false,
    status: userBody.status ?? 1,
    created_by: reqUser._id,
  });

  return createResponse(httpStatus.CREATED, 'Operator created successfully.', {
    user,
  });
};

export const listOperators = async (
  filter: Record<string, any>,
  options: Record<string, any>,
  reqUser: any,
) => {
  const orgScope = resolveOrganizationScope(reqUser, filter.organization_id);
  const query: Record<string, any> = {};
  if (orgScope) {
    query.organization_id = orgScope;
  }
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
    ];
  }

  const users = await (User as any).paginate(query, options);
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
  const orgScope = resolveOrganizationScope(reqUser, orgOverride);
  const query: Record<string, any> = {
    _id: toObjectId(operatorId),
    status: { $ne: 2 },
  };
  if (orgScope) {
    query.organization_id = orgScope;
  }
  const user = await User.findOne(query);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Operator not found');
  }
  return user;
};

const OPERATOR_UPDATE_KEYS = [
  'first_name',
  'last_name',
  'email',
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
  if (
    updateBody.email &&
    (await User.isEmailTaken(updateBody.email, user._id as any))
  ) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
  }
  if (updateBody.role && !OPERATOR_ROLES.includes(updateBody.role)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Operator role must be ORGANIZATION_ADMIN or OPERATOR',
    );
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
