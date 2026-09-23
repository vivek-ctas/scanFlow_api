import httpStatus from 'http-status';
import { catchAsync } from '../../utils/catchAsync.js';
import { pick } from '../../utils/pick.js';
import * as userService from '../../services/admin/users.service.js';
import { createResponse } from '../../services/common.service.js';
import { Request, Response } from 'express';

const userIdParam = (req: Request) => String(req.params.userId);
const getActorId = (req: Request) => (req.user as any)?._id;

export const listUsers = catchAsync(async (req: Request, res: Response) => {
  const filter = pick(req.query, ['search', 'status', 'role']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await userService.listUsers(filter, options);
  res.status(result.status).json(result);
});

export const getUserById = catchAsync(async (req: Request, res: Response) => {
  const user = await userService.getUserById(userIdParam(req));
  if (!user) {
    return res.status(httpStatus.NOT_FOUND).json({
      status: httpStatus.NOT_FOUND,
      message: 'User not found',
    });
  }
  res
    .status(httpStatus.OK)
    .json(
      createResponse(httpStatus.OK, 'User fetched successfully.', { user }),
    );
});

export const createUser = catchAsync(async (req: Request, res: Response) => {
  const result = await userService.createUser(req.body, getActorId(req));
  res.status(result.status).json(result);
});

export const adminUpdateUser = catchAsync(
  async (req: Request, res: Response) => {
    const user = await userService.updateUserById(
      userIdParam(req),
      req.body,
      getActorId(req),
    );
    res
      .status(httpStatus.OK)
      .json(
        createResponse(httpStatus.OK, 'User updated successfully.', { user }),
      );
  },
);

export const updateRole = catchAsync(async (req: Request, res: Response) => {
  const user = await userService.updateUserRoleById(
    userIdParam(req),
    req.body.role,
  );
  res.status(httpStatus.OK).json(
    createResponse(httpStatus.OK, 'User role updated successfully.', {
      user,
    }),
  );
});

export const updateUserStatus = catchAsync(
  async (req: Request, res: Response) => {
    const user = await userService.updateUserStatusById(
      userIdParam(req),
      req.body,
    );
    res.status(httpStatus.OK).json(
      createResponse(httpStatus.OK, 'User status updated successfully.', {
        user,
      }),
    );
  },
);

export const deleteUser = catchAsync(async (req: Request, res: Response) => {
  const user = await userService.deleteUserById(
    userIdParam(req),
    getActorId(req),
  );
  res
    .status(httpStatus.OK)
    .json(
      createResponse(httpStatus.OK, 'User deleted successfully.', { user }),
    );
});
