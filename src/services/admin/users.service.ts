import httpStatus from 'http-status';
import mongoose from 'mongoose';
import { User, IUser } from '../../models/user.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { createResponse } from '../common.service.js';

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

export const isRequesterAdmin = (reqUser: any) =>
  Boolean(
    reqUser &&
    (reqUser.isSuperAdmin === true || reqUser.role === 'SUPER_ADMIN'),
  );

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

export const createUser = async (
  userBody: Partial<IUser>,
  createdBy?: string | mongoose.Types.ObjectId,
) => {
  const role = userBody.role || 'USER';
  const parentIdStr = (userBody as { parent_id?: string }).parent_id;
  const normalizedBody: Partial<IUser> = {
    first_name: userBody.first_name,
    last_name: userBody.last_name,
    email: normalizeEmail(userBody.email || ''),
    contact_no: userBody.contact_no,
    password: userBody.password,
    role,
    business_address: userBody.business_address,
    parent_id: parentIdStr ? toObjectId(parentIdStr) : null,
    is_sub_user: Boolean(userBody.is_sub_user ?? role === 'USER'),
    isSuperAdmin: Boolean(userBody.isSuperAdmin ?? role === 'SUPER_ADMIN'),
    isEmailVerified: Boolean(userBody.isEmailVerified),
    status: userBody.status ?? 1,
    created_by: createdBy ? toObjectId(createdBy) : null,
  };

  const emailTaken = await User.isEmailTaken(normalizedBody.email as string);
  if (emailTaken) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
  }

  const user = await User.create(normalizedBody);
  return createResponse(httpStatus.CREATED, 'User registered successfully.', {
    user,
  });
};

export const getUserById = async (id: string) => User.findById(id);

export const getUserByEmail = async (email: string) => User.findOne({ email });

const USER_UPDATE_KEYS = [
  'first_name',
  'last_name',
  'email',
  'contact_no',
  'business_address',
  'password',
  'role',
  'status',
  'isEmailVerified',
  'isSuperAdmin',
  'is_sub_user',
  'parent_id',
];

export const updateUserById = async (
  userId: string,
  updateBody: Partial<IUser>,
  modifiedBy?: string | mongoose.Types.ObjectId,
) => {
  const user = await getUserById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  if (
    updateBody.email &&
    (await User.isEmailTaken(updateBody.email, user._id as any))
  ) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email already taken');
  }

  USER_UPDATE_KEYS.forEach((key) => {
    if (updateBody[key as keyof IUser] !== undefined) {
      (user as any)[key] = updateBody[key as keyof IUser];
    }
  });
  if (updateBody.role !== undefined) {
    user.isSuperAdmin = (user as any).role === 'SUPER_ADMIN';
  }
  if (modifiedBy) {
    user.modified_by = toObjectId(modifiedBy);
  }
  await user.save();

  return user;
};

export const updateUserRoleById = async (userId: string, role: string) => {
  const user = await getUserById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  user.role = role;
  user.isSuperAdmin = role === 'SUPER_ADMIN';
  await user.save();
  return user;
};

export const updateUserStatusById = async (
  userId: string,
  body: { status?: number; action_type?: string },
) => {
  const user = await getUserById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  user.status = computeUserStatus(body, user.status);
  await user.save();
  return user;
};

export const deleteUserById = async (
  userId: string,
  actorId?: string | mongoose.Types.ObjectId,
) => {
  const user = await getUserById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  if (actorId && String(user._id) === String(actorId)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'You cannot delete your own account',
    );
  }
  user.status = 2;
  await user.save();
  return user;
};

export const listUsers = async (
  filter: Record<string, any>,
  options: Record<string, any>,
) => {
  const query: Record<string, any> = {};
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
      { contact_no: regex },
    ];
  }

  const users = await (User as any).paginate(query, options);
  return createResponse(httpStatus.OK, 'Users fetched successfully.', {
    results: users.results,
    page: users.page,
    limit: users.limit,
    totalPages: users.totalPages,
    totalResults: users.totalResults,
  });
};
