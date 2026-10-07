import httpStatus from 'http-status';
import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync.js';
import * as webSettingsService from '../../services/admin/web-settings.service.js';
import { createResponse } from '../../services/common.service.js';

export const getWebSettings = catchAsync(
  async (_req: Request, res: Response) => {
    const webSettings = await webSettingsService.getWebSettings();
    res.status(httpStatus.OK).json(
      createResponse(httpStatus.OK, 'Web settings fetched successfully.', {
        webSettings,
      }),
    );
  },
);

export const updateWebSettings = catchAsync(
  async (req: Request, res: Response) => {
    const result = await webSettingsService.updateWebSettings(req.body);
    res.status(result.status).json(result);
  },
);
