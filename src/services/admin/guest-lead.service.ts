import httpStatus from 'http-status';
import { GuestLead } from '../../models/guest-lead.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { createResponse, escapeRegExp, toObjectId } from '../common.service.js';
import { resolveOrganizationScope } from '../../middlewares/guards/orgScope.js';

export const listGuestLeads = async (
  filter: Record<string, any>,
  options: Record<string, any>,
  reqUser: any,
) => {
  const orgScope = resolveOrganizationScope(reqUser, filter.organization_id);
  const query: Record<string, any> = {};
  if (orgScope) {
    query.organization_id = orgScope;
  }
  if (filter.status) {
    query.status = filter.status;
  }
  if (filter.plan_id) {
    query.plan_id = toObjectId(filter.plan_id);
  }
  if (filter.date_from !== undefined || filter.date_to !== undefined) {
    query.created_at = {};
    if (filter.date_from !== undefined) {
      query.created_at.$gte = new Date(String(filter.date_from));
    }
    if (filter.date_to !== undefined) {
      query.created_at.$lte = new Date(String(filter.date_to));
    }
  }
  if (filter.search) {
    const regex = new RegExp(escapeRegExp(String(filter.search)), 'i');
    query.$or = [
      { first_name: regex },
      { last_name: regex },
      { email: regex },
      { company_name: regex },
      { contact_number: regex },
    ];
  }

  const leads = await (GuestLead as any).paginate(query, {
    sort_by: options.sort_by ?? 'created_at:desc',
    limit: options.limit ?? 10,
    page: options.page ?? 1,
    populate: 'plan_id,organization_id',
  });
  return createResponse(httpStatus.OK, 'Guest leads fetched successfully.', {
    results: leads.results,
    page: leads.page,
    limit: leads.limit,
    total_pages: leads.total_pages,
    total_results: leads.total_results,
  });
};

export const getGuestLeadById = async (
  guestLeadId: string,
  reqUser: any,
  orgOverride?: string,
) => {
  const orgScope = resolveOrganizationScope(reqUser, orgOverride);
  const query: Record<string, any> = { _id: toObjectId(guestLeadId) };
  if (orgScope) {
    query.organization_id = orgScope;
  }
  const lead = await GuestLead.findOne(query)
    .populate(
      'plan_id',
      'name price price_quarterly currency trial_days status',
    )
    .populate('organization_id', 'name');
  if (!lead) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Guest lead not found');
  }
  return lead;
};
