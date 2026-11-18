import express from 'express';
import * as controller from './controller.js';
import {
  managementAuth,
  managementCors,
  managementErrorHandler,
  managementRateLimiter,
  notFound,
  requestId,
} from './http.js';
import {
  bulkRoute,
  emptyBodyRoute,
  executionsRoute,
  globalAuditRoute,
  jobAuditRoute,
  jobRoute,
  logsRoute,
  scheduleRoute,
  validateManagement,
} from './validation.js';

/**
 * CronZivo Cron Management API v1 router.
 *
 * Mounted at `config.cronzivo.mgmtPrefix` *before* the global body parser and
 * CORS middleware, so the management prefix keeps its own 10 KB limit,
 * origin allowlist and error envelope.
 */
export const cronManagementRouter = express.Router();

cronManagementRouter.use(requestId);
cronManagementRouter.use(managementCors);
cronManagementRouter.use(managementRateLimiter);
cronManagementRouter.use(managementAuth);
cronManagementRouter.use(express.json({ limit: '10kb' }));

cronManagementRouter.get('/health', controller.health);
cronManagementRouter.get('/capabilities', controller.capabilities);

cronManagementRouter.get('/jobs', controller.listJobs);
cronManagementRouter.get(
  '/jobs/:id/status',
  validateManagement(jobRoute),
  controller.getJobStatus,
);
cronManagementRouter.get(
  '/jobs/:id/executions',
  validateManagement(executionsRoute),
  controller.listExecutions,
);
cronManagementRouter.get(
  '/jobs/:id/logs',
  validateManagement(logsRoute),
  controller.listLogs,
);
cronManagementRouter.get(
  '/jobs/:id/audit',
  validateManagement(jobAuditRoute),
  controller.listAudit,
);
cronManagementRouter.get(
  '/jobs/:id',
  validateManagement(jobRoute),
  controller.getJob,
);

cronManagementRouter.get(
  '/audit',
  validateManagement(globalAuditRoute),
  controller.listAllAudit,
);

cronManagementRouter.post(
  '/jobs/:id/start',
  validateManagement(emptyBodyRoute),
  controller.startJob,
);
cronManagementRouter.post(
  '/jobs/:id/stop',
  validateManagement(emptyBodyRoute),
  controller.stopJob,
);
cronManagementRouter.post(
  '/jobs/:id/run',
  validateManagement(emptyBodyRoute),
  controller.runJob,
);
cronManagementRouter.post(
  '/jobs/:id/cancel',
  validateManagement(jobRoute),
  controller.cancelJob,
);
cronManagementRouter.post(
  '/jobs/:id/schedule/reset',
  validateManagement(emptyBodyRoute),
  controller.resetSchedule,
);
cronManagementRouter.patch(
  '/jobs/:id/schedule',
  validateManagement(scheduleRoute),
  controller.updateSchedule,
);

cronManagementRouter.post(
  '/bulk/start',
  validateManagement(bulkRoute),
  controller.bulkStart,
);
cronManagementRouter.post(
  '/bulk/stop',
  validateManagement(bulkRoute),
  controller.bulkStop,
);
cronManagementRouter.post(
  '/bulk/run',
  validateManagement(bulkRoute),
  controller.bulkRun,
);

cronManagementRouter.use(notFound);
cronManagementRouter.use(managementErrorHandler);
