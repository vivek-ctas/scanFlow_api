import httpStatus from 'http-status';
import { catchAsync } from '../../utils/catchAsync.js';
import { pick } from '../../utils/pick.js';
import * as scanService from '../../services/user/scans.service.js';
import { createResponse } from '../../services/common.service.js';
import { Request, Response } from 'express';

const scanIdParam = (req: Request) => String(req.params.scanId);

export const createScan = catchAsync(async (req: Request, res: Response) => {
  const result = await scanService.createScan(req.body, req.user);
  res.status(result.status).json(result);
});

export const batchCreateScans = catchAsync(
  async (req: Request, res: Response) => {
    const result = await scanService.batchCreateScans(req.body.scans, req.user);
    res.status(result.status).json(result);
  },
);

export const listScans = catchAsync(async (req: Request, res: Response) => {
  const filter = pick(req.query, ['organization_id', 'user_id', 'barcode']);
  const options = pick(req.query, ['sort_by', 'limit', 'page']);
  const result = await scanService.listScans(filter, options, req.user);
  res.status(result.status).json(result);
});

export const getScan = catchAsync(async (req: Request, res: Response) => {
  const scan = await scanService.getScanById(scanIdParam(req), req.user);
  res
    .status(httpStatus.OK)
    .json(
      createResponse(httpStatus.OK, 'Scan fetched successfully.', { scan }),
    );
});
