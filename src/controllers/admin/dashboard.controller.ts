import httpStatus from 'http-status';
import { Request, Response } from 'express';
import config from '../../config/config.js';
import { catchAsync } from '../../utils/catchAsync.js';
import { createResponse } from '../../services/common.service.js';
import * as dashboardService from '../../services/admin/dashboard.service.js';
import {
  getOrCompute,
  type WidgetCacheOptions,
  type WidgetResult,
} from '../../services/admin/dashboard.cache.js';
import type { DashboardRange } from '../../utils/dashboard-time.js';

const fresh = () => config.dashboard.cacheFreshSeconds;
const chart = () => config.dashboard.chartCacheSeconds;

const respond = (
  res: Response,
  message: string,
  result: WidgetResult<Record<string, unknown>>,
) => {
  res.status(httpStatus.OK).json(
    createResponse(httpStatus.OK, message, {
      ...result.data,
      computed_at: result.computedAt,
    }),
  );
};

const windowKey = (query: any): string => {
  if (query.from && query.to) {
    return `custom:${new Date(query.from).toISOString()}:${new Date(
      query.to,
    ).toISOString()}`;
  }
  return String(query.range ?? '30d');
};

export const getSummary = catchAsync(async (_req: Request, res: Response) => {
  const result = await getOrCompute('summary', { freshSeconds: fresh() }, () =>
    dashboardService.getSummary(),
  );
  respond(res, 'Dashboard summary fetched successfully.', result as any);
});

export const getScanTrend = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as any;
  const options: WidgetCacheOptions = {
    freshSeconds: chart(),
    scanHeavy: true,
  };
  const key = `scan-trend:${windowKey(query)}:${query.compare ? 'cmp' : 'nocmp'}`;
  const result = await getOrCompute(key, options, () =>
    dashboardService.getScanTrend({
      range:
        query.from && query.to ? undefined : (query.range as DashboardRange),
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      compare: Boolean(query.compare),
    }),
  );
  respond(res, 'Scan trend fetched successfully.', result as any);
});

export const getPlanDistribution = catchAsync(
  async (_req: Request, res: Response) => {
    const result = await getOrCompute(
      'plan-distribution',
      { freshSeconds: chart() },
      () => dashboardService.getPlanDistribution(),
    );
    respond(res, 'Plan distribution fetched successfully.', result as any);
  },
);

export const getGrowth = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as any;
  const key = `growth:${windowKey(query)}`;
  const result = await getOrCompute(key, { freshSeconds: chart() }, () =>
    dashboardService.getGrowth({
      range:
        query.from && query.to ? undefined : (query.range as DashboardRange),
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    }),
  );
  respond(res, 'Growth fetched successfully.', result as any);
});

export const getRecentLeads = catchAsync(
  async (req: Request, res: Response) => {
    const limit = Number((req.query as any).limit ?? 10);
    const result = await getOrCompute(
      `recent-leads:${limit}`,
      { freshSeconds: fresh() },
      () => dashboardService.getRecentLeads(limit),
    );
    respond(res, 'Recent leads fetched successfully.', result as any);
  },
);

export const getTopOrganizations = catchAsync(
  async (req: Request, res: Response) => {
    const limit = Number((req.query as any).limit ?? 5);
    const result = await getOrCompute(
      `top-organizations:${limit}`,
      { freshSeconds: fresh() },
      () => dashboardService.getTopOrganizations(limit),
    );
    respond(res, 'Top organizations fetched successfully.', result as any);
  },
);

export const getAttention = catchAsync(async (_req: Request, res: Response) => {
  const result = await getOrCompute(
    'attention',
    { freshSeconds: fresh() },
    () => dashboardService.getAttention(),
  );
  respond(res, 'Attention items fetched successfully.', result as any);
});

export const getWebhooks = catchAsync(async (_req: Request, res: Response) => {
  const result = await getOrCompute('webhooks', { freshSeconds: 30 }, () =>
    dashboardService.getWebhooks(),
  );
  respond(res, 'Webhook health fetched successfully.', result as any);
});

export const getSystem = catchAsync(async (_req: Request, res: Response) => {
  const result = await getOrCompute('system', { freshSeconds: 15 }, () =>
    dashboardService.getSystem(),
  );
  respond(res, 'System health fetched successfully.', result as any);
});
