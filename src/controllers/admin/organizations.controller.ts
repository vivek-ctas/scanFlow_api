import httpStatus from 'http-status';
import { catchAsync } from '../../utils/catchAsync.js';
import { pick } from '../../utils/pick.js';
import * as organizationService from '../../services/admin/organizations.service.js';
import { createResponse } from '../../services/common.service.js';
import { Request, Response } from 'express';

const orgIdParam = (req: Request) => String(req.params.organizationId);
const getActorId = (req: Request) => (req.user as any)?._id;

export const createOrganization = catchAsync(
  async (req: Request, res: Response) => {
    const result = await organizationService.createOrganization(
      req.body,
      getActorId(req),
    );
    res.status(result.status).json(result);
  },
);

export const listOrganizations = catchAsync(
  async (req: Request, res: Response) => {
    const filter = pick(req.query, ['search', 'status']);
    const options = pick(req.query, ['sortBy', 'limit', 'page']);
    const result = await organizationService.listOrganizations(filter, options);
    res.status(result.status).json(result);
  },
);

export const getOrganization = catchAsync(
  async (req: Request, res: Response) => {
    const org = await organizationService.getOrganizationById(orgIdParam(req));
    res.status(httpStatus.OK).json(
      createResponse(httpStatus.OK, 'Organization fetched successfully.', {
        organization: org,
      }),
    );
  },
);

export const updateOrganization = catchAsync(
  async (req: Request, res: Response) => {
    const org = await organizationService.updateOrganizationById(
      orgIdParam(req),
      req.body,
      getActorId(req),
    );
    res.status(httpStatus.OK).json(
      createResponse(httpStatus.OK, 'Organization updated successfully.', {
        organization: org,
      }),
    );
  },
);

export const updateOrganizationStatus = catchAsync(
  async (req: Request, res: Response) => {
    const org = await organizationService.updateOrganizationStatusById(
      orgIdParam(req),
      req.body,
      getActorId(req),
    );
    res.status(httpStatus.OK).json(
      createResponse(
        httpStatus.OK,
        'Organization status updated successfully.',
        {
          organization: org,
        },
      ),
    );
  },
);

export const deleteOrganization = catchAsync(
  async (req: Request, res: Response) => {
    const org = await organizationService.deleteOrganizationById(
      orgIdParam(req),
      getActorId(req),
    );
    res.status(httpStatus.OK).json(
      createResponse(httpStatus.OK, 'Organization deleted successfully.', {
        organization: org,
      }),
    );
  },
);

export const getOrganizationUsage = catchAsync(
  async (req: Request, res: Response) => {
    const result = await organizationService.getOrganizationUsage(
      orgIdParam(req),
      req.user,
    );
    res.status(result.status).json(result);
  },
);
