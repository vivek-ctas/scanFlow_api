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
cronManagementRouter.get('/jobs/:id/status', controller.getJobStatus);
cronManagementRouter.get('/jobs/:id/executions', controller.listExecutions);
cronManagementRouter.get('/jobs/:id/logs', controller.listLogs);
cronManagementRouter.get('/jobs/:id/audit', controller.listAudit);
cronManagementRouter.get('/jobs/:id', controller.getJob);

cronManagementRouter.post('/jobs/:id/start', controller.startJob);
cronManagementRouter.post('/jobs/:id/stop', controller.stopJob);
cronManagementRouter.post('/jobs/:id/run', controller.runJob);
cronManagementRouter.post('/jobs/:id/cancel', controller.cancelJob);
cronManagementRouter.post('/jobs/:id/schedule/reset', controller.resetSchedule);
cronManagementRouter.patch('/jobs/:id/schedule', controller.updateSchedule);

cronManagementRouter.post('/bulk/start', controller.bulkStart);
cronManagementRouter.post('/bulk/stop', controller.bulkStop);
cronManagementRouter.post('/bulk/run', controller.bulkRun);

cronManagementRouter.use(notFound);
cronManagementRouter.use(managementErrorHandler);
