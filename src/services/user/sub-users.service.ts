import httpStatus from 'http-status';
import mongoose from 'mongoose';
import { User } from '../../models/user.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { createResponse } from '../common.service.js';
import { isRequesterAdmin } from '../admin/users.service.js';

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeEmail = (email: string) =>
  String(email || '')
    .trim()
    .toLowerCase();

const toObjectId = (value: string | mongoose.Types.ObjectId) =>
  value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(value);

const computeUserStatus = (
  body: { status?: number; action_type?: string },
  currentStatus: number,
) => {
  if (body.status !== undefined) {
    return Number(body.status);
  }
  if (body.action_type === 'activate') {
    return 1;
  }
  if (body.action_type === 'deactivate') {
    return 0;
  }
  return currentStatus === 1 ? 0 : 1;
};

const resolveParentScope = (reqUser: any, parentId?: any) => {
  if (isRequesterAdmin(reqUser)) {
    return parentId ? toObjectId(parentId) : null;
  }
  return toObjectId(String(reqUser._id || reqUser.id));
};

export const createSubUser = async (userBody: any, reqUser: any) => {
  const role = userBody.role || 'USER';
  const adminRequested = isRequesterAdmin(reqUser);
  const parentIdStr = adminRequested ? userBody.parent_id : undefined;
  if (adminRequested && !parentIdStr) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'parent_id is required');
  }

  const parent = await User.findById(parentIdStr || reqUser._id);
  if (!parent || parent.status === 2) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Parent account not found');
  }

  const emailTaken = await User.isEmailTaken(normalizeEmail(userBody.email));
  if (emailTaken) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
  }

  const user = await User.create({
    first_name: userBody.first_name,
    last_name: userBody.last_name,
    email: normalizeEmail(userBody.email),
    contact_no: userBody.contact_no,
    business_address: userBody.business_address,
    role,
    status: userBody.status ?? 1,
    isEmailVerified: false,
    is_sub_user: true,
    parent_id: parent._id,
    created_by: reqUser._id,
  });

  return createResponse(httpStatus.CREATED, 'Sub-user created successfully.', {
    user,
  });
};

export const listSubUsers = async (
  filter: Record<string, any>,
  options: Record<string, any>,
  reqUser: any,
) => {
  const ownerScope = resolveParentScope(reqUser, filter.parentId);
  const query: Record<string, any> = { is_sub_user: true };
  if (ownerScope) {
    query.parent_id = ownerScope;
  }
  if (filter.status !== undefined) {
    query.status = Number(filter.status);
  } else {
    query.status = { $ne: 2 };
  }
  if (filter.search) {
    const regex = new RegExp(escapeRegExp(String(filter.search)), 'i');
    query.$or = [
      { first_name: regex },
      { last_name: regex },
      { email: regex },
      { contact_no: regex },
    ];
  }

  const users = await (User as any).paginate(query, options);
  return createResponse(httpStatus.OK, 'Sub-users fetched successfully.', {
    results: users.results,
    page: users.page,
    limit: users.limit,
    totalPages: users.totalPages,
    totalResults: users.totalResults,
  });
};

export const getSubUserById = async (subUserId: string, reqUser: any) => {
  const query: Record<string, any> = {
    _id: toObjectId(subUserId),
    is_sub_user: true,
    status: { $ne: 2 },
  };
  if (!isRequesterAdmin(reqUser)) {
    query.parent_id = toObjectId(String(reqUser._id || reqUser.id));
  }
  const user = await User.findOne(query);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Sub-user not found');
  }
  return user;
};

const SUB_USER_UPDATE_KEYS = [
  'first_name',
  'last_name',
  'email',
  'contact_no',
  'business_address',
  'role',
  'status',
  'isEmailVerified',
];

export const updateSubUserById = async (
  subUserId: string,
  updateBody: any,
  reqUser: any,
) => {
  const user = await getSubUserById(subUserId, reqUser);
  if (
    updateBody.email &&
    (await User.isEmailTaken(updateBody.email, user._id as any))
  ) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
  }

  SUB_USER_UPDATE_KEYS.forEach((key) => {
    if (updateBody[key] !== undefined) {
      (user as any)[key] = updateBody[key];
    }
  });
  user.modified_by = reqUser._id;
  await user.save();
  return user;
};

export const updateSubUserRoleById = async (
  subUserId: string,
  role: string,
  reqUser: any,
) => {
  const user = await getSubUserById(subUserId, reqUser);
  user.role = role;
  user.modified_by = reqUser._id;
  await user.save();
  return user;
};

export const updateSubUserStatusById = async (
  subUserId: string,
  body: { status?: number; action_type?: string },
  reqUser: any,
) => {
  const user = await getSubUserById(subUserId, reqUser);
  user.status = computeUserStatus(body, user.status);
  user.modified_by = reqUser._id;
  await user.save();
  return user;
};

export const deleteSubUserById = async (subUserId: string, reqUser: any) => {
  const user = await getSubUserById(subUserId, reqUser);
  user.status = 2;
  user.modified_by = reqUser._id;
  await user.save();
  return user;
};
