import httpStatus from 'http-status';
import { catchAsync } from '../../utils/catchAsync.js';
import { pick } from '../../utils/pick.js';
import * as subUserService from '../../services/user/sub-users.service.js';
import { createResponse } from '../../services/common.service.js';
import { Request, Response } from 'express';

const subUserIdParam = (req: Request) => String(req.params.subUserId);

export const createSubUser = catchAsync(async (req: Request, res: Response) => {
  const result = await subUserService.createSubUser(req.body, req.user);
  res.status(result.status).json(result);
});

export const listSubUsers = catchAsync(async (req: Request, res: Response) => {
  const filter = pick(req.query, ['parentId', 'search', 'status']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await subUserService.listSubUsers(filter, options, req.user);
  res.status(result.status).json(result);
});

export const getSubUser = catchAsync(async (req: Request, res: Response) => {
  const user = await subUserService.getSubUserById(
    subUserIdParam(req),
    req.user,
  );
  res
    .status(httpStatus.OK)
    .json(
      createResponse(httpStatus.OK, 'Sub-user fetched successfully.', { user }),
    );
});

export const updateSubUser = catchAsync(async (req: Request, res: Response) => {
  const user = await subUserService.updateSubUserById(
    subUserIdParam(req),
    req.body,
    req.user,
  );
  res
    .status(httpStatus.OK)
    .json(
      createResponse(httpStatus.OK, 'Sub-user updated successfully.', { user }),
    );
});

export const subUserRole = catchAsync(async (req: Request, res: Response) => {
  const user = await subUserService.updateSubUserRoleById(
    subUserIdParam(req),
    req.body.role,
    req.user,
  );
  res.status(httpStatus.OK).json(
    createResponse(httpStatus.OK, 'Sub-user role updated successfully.', {
      user,
    }),
  );
});

export const subUserStatus = catchAsync(async (req: Request, res: Response) => {
  const user = await subUserService.updateSubUserStatusById(
    subUserIdParam(req),
    req.body,
    req.user,
  );
  res.status(httpStatus.OK).json(
    createResponse(httpStatus.OK, 'Sub-user status updated successfully.', {
      user,
    }),
  );
});

export const deleteSubUser = catchAsync(async (req: Request, res: Response) => {
  const user = await subUserService.deleteSubUserById(
    subUserIdParam(req),
    req.user,
  );
  res.status(httpStatus.OK).json(
    createResponse(httpStatus.OK, 'Sub-user deleted successfully.', {
      user,
    }),
  );
});
