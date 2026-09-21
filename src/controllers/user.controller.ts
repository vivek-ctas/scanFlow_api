import { catchAsync } from '../utils/catchAsync.js';
import { pick } from '../utils/pick.js';
import * as userService from '../services/user.service.js';
import { Request, Response } from 'express';

export const listUsers = catchAsync(async (req: Request, res: Response) => {
  const filter = pick(req.query, ['search', 'status']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await userService.listUsers(filter, options);
  res.status(result.status).json(result);
});
