import httpStatus from 'http-status';
import { catchAsync } from '../../utils/catchAsync.js';
import { pick } from '../../utils/pick.js';
import * as operatorService from '../../services/user/operators.service.js';
import { createResponse } from '../../services/common.service.js';
import { Request, Response } from 'express';

const operatorIdParam = (req: Request) => String(req.params.operatorId);

export const createOperator = catchAsync(
  async (req: Request, res: Response) => {
    const result = await operatorService.createOperator(req.body, req.user);
    res.status(result.status).json(result);
  },
);

export const listOperators = catchAsync(async (req: Request, res: Response) => {
  const filter = pick(req.query, [
    'search',
    'status',
    'role',
    'organizationId',
  ]);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await operatorService.listOperators(filter, options, req.user);
  res.status(result.status).json(result);
});

export const getOperator = catchAsync(async (req: Request, res: Response) => {
  const query = pick(req.query, ['organizationId']);
  const organizationId = String(query.organizationId ?? '') || undefined;
  const user = await operatorService.getOperatorById(
    operatorIdParam(req),
    req.user,
    organizationId,
  );
  res
    .status(httpStatus.OK)
    .json(
      createResponse(httpStatus.OK, 'Operator fetched successfully.', { user }),
    );
});

export const updateOperator = catchAsync(
  async (req: Request, res: Response) => {
    const user = await operatorService.updateOperatorById(
      operatorIdParam(req),
      req.body,
      req.user,
    );
    res.status(httpStatus.OK).json(
      createResponse(httpStatus.OK, 'Operator updated successfully.', {
        user,
      }),
    );
  },
);

export const operatorRole = catchAsync(async (req: Request, res: Response) => {
  const user = await operatorService.updateOperatorRoleById(
    operatorIdParam(req),
    req.body.role,
    req.user,
  );
  res.status(httpStatus.OK).json(
    createResponse(httpStatus.OK, 'Operator role updated successfully.', {
      user,
    }),
  );
});

export const operatorStatus = catchAsync(
  async (req: Request, res: Response) => {
    const user = await operatorService.updateOperatorStatusById(
      operatorIdParam(req),
      req.body,
      req.user,
    );
    res.status(httpStatus.OK).json(
      createResponse(httpStatus.OK, 'Operator status updated successfully.', {
        user,
      }),
    );
  },
);

export const deleteOperator = catchAsync(
  async (req: Request, res: Response) => {
    const user = await operatorService.deleteOperatorById(
      operatorIdParam(req),
      req.user,
    );
    res.status(httpStatus.OK).json(
      createResponse(httpStatus.OK, 'Operator deleted successfully.', {
        user,
      }),
    );
  },
);
