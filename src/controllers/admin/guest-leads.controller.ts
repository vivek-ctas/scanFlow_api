import httpStatus from 'http-status';
import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync.js';
import { pick } from '../../utils/pick.js';
import * as guestLeadService from '../../services/admin/guest-lead.service.js';
import { createResponse } from '../../services/common.service.js';

export const listGuestLeads = catchAsync(
  async (req: Request, res: Response) => {
    const filter = pick(req.query, [
      'search',
      'status',
      'plan_id',
      'organization_id',
      'date_from',
      'date_to',
    ]);
    const options = pick(req.query, ['sort_by', 'limit', 'page']);
    const result = await guestLeadService.listGuestLeads(
      filter,
      options,
      req.user,
    );
    res.status(result.status).json(result);
  },
);

export const getGuestLead = catchAsync(async (req: Request, res: Response) => {
  const query = pick(req.query, ['organization_id']);
  const organizationId = String(query.organization_id ?? '') || undefined;
  const lead = await guestLeadService.getGuestLeadById(
    String(req.params.guestLeadId),
    req.user,
    organizationId,
  );
  res.status(httpStatus.OK).json(
    createResponse(httpStatus.OK, 'Guest lead fetched successfully.', {
      lead,
    }),
  );
});
