import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync.js';
import { pick } from '../../utils/pick.js';
import * as systemLogService from '../../services/system-log.service.js';

export const listSystemLogs = catchAsync(
  async (req: Request, res: Response) => {
    const filter = pick(req.query, [
      'search',
      'operation',
      'actor_role',
      'operation_by',
      'key',
      'organization_id',
      'startDate',
      'endDate',
    ]) as systemLogService.ListSystemLogsFilter;
    const options = pick(req.query, [
      'sort_by',
      'limit',
      'page',
    ]) as systemLogService.ListSystemLogsOptions;
    const result = await systemLogService.listSystemLogs(
      filter,
      options,
      req.user,
    );
    res.status(result.status).json(result);
  },
);

export const getSystemLogOperations = catchAsync(
  async (req: Request, res: Response) => {
    const result = await systemLogService.getSystemLogOperations(req.user);
    res.status(result.status).json(result);
  },
);

export const getSystemLog = catchAsync(async (req: Request, res: Response) => {
  const result = await systemLogService.getSystemLogById(
    String(req.params.logId),
    req.user,
  );
  res.status(result.status).json(result);
});
