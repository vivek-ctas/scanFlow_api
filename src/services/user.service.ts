import httpStatus from 'http-status';
import mongoose from 'mongoose';
import { User, IUser } from '../models/user.model.js';
import { ApiError } from '../utils/ApiError.js';
import { createResponse } from './common.service.js';

export const createUser = async (
  userBody: Partial<IUser> & { seller_id?: string },
) => {
  const sellerIdStr = (userBody as { seller_id?: string }).seller_id;
  const normalizedBody: Partial<IUser> = {
    first_name: userBody.first_name,
    last_name: userBody.last_name,
    email: userBody.email,
    contact_no: userBody.contact_no,
    password: userBody.password,
    role: userBody.role || 'SELLER_USER',
    seller_id: sellerIdStr
      ? new mongoose.Types.ObjectId(sellerIdStr as unknown as string)
      : null,
    is_seller_user: userBody.role === 'SELLER_USER',
  };

  const emailTaken = await User.isEmailTaken(normalizedBody.email!);
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

export const updateUserById = async (
  userId: string,
  updateBody: Partial<IUser>,
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

  const keys = [
    'first_name',
    'last_name',
    'email',
    'contact_no',
    'password',
    'isSuperAdmin',
    'is_seller_user',
    'seller_id',
    'status',
    'role',
  ];
  keys.forEach((key) => {
    if (updateBody[key as keyof IUser] !== undefined) {
      (user as any)[key] = updateBody[key as keyof IUser];
    }
  });
  await user.save();

  return user;
};

export const listUsers = async (
  filter: Record<string, any>,
  options: Record<string, any>,
) => {
  const searchFilter = { ...filter, status: { $ne: 2 } };

  const users = await (User as any).paginate(searchFilter, options);
  return createResponse(httpStatus.OK, 'Users fetched successfully.', {
    results: users.results,
    page: users.page,
    limit: users.limit,
    totalPages: users.totalPages,
    totalResults: users.totalResults,
  });
};
