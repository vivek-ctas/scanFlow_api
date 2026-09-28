import httpStatus from 'http-status';
import { Plan } from '../../models/plan.model.js';
import { ApiError } from '../../utils/ApiError.js';
import {
  computeStatus,
  createResponse,
  escapeRegExp,
  toObjectId,
} from '../common.service.js';

const PLAN_UPDATE_KEYS = [
  'name',
  'desc',
  'price',
  'price_quarterly',
  'currency',
  'trial_days',
  'features',
  'marketing_features',
  'status',
  'is_custom_plan',
  'is_popular',
  'discount',
];

const planNameTaken = async (name: string, excludeId?: string) => {
  const regex = new RegExp(`^${escapeRegExp(String(name).trim())}$`, 'i');
  const query: Record<string, any> = { name: regex, status: { $ne: 2 } };
  if (excludeId) {
    query._id = { $ne: toObjectId(excludeId) };
  }
  return Plan.exists(query);
};

export const createPlan = async (planBody: Record<string, any>) => {
  if (await planNameTaken(planBody.name)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Plan name already exists');
  }
  const plan = await Plan.create({
    ...planBody,
    status: planBody.status ?? 1,
  });
  return createResponse(httpStatus.CREATED, 'Plan created successfully.', {
    plan,
  });
};

export const listPlans = async (
  filter: Record<string, any>,
  options: Record<string, any>,
) => {
  const hasAdminParams =
    options.page !== undefined ||
    options.limit !== undefined ||
    options.sort_by !== undefined ||
    filter.search !== undefined ||
    filter.status !== undefined ||
    filter.is_custom_plan !== undefined ||
    filter.date_from !== undefined ||
    filter.date_to !== undefined;

  if (!hasAdminParams) {
    const plans = await Plan.find({
      status: 1,
      is_custom_plan: false,
    }).sort({ price: 1 });
    return createResponse(httpStatus.OK, 'Plans fetched successfully.', {
      plans,
    });
  }

  const query: Record<string, any> = { status: { $ne: 2 } };
  if (filter.status !== undefined) {
    query.status = Number(filter.status);
  }
  if (filter.is_custom_plan !== undefined) {
    query.is_custom_plan =
      filter.is_custom_plan === 'true' || filter.is_custom_plan === true;
  }
  if (filter.search) {
    const regex = new RegExp(escapeRegExp(String(filter.search)), 'i');
    query.$or = [{ name: regex }, { desc: regex }];
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

  const results = await (Plan as any).paginate(query, {
    sort_by: options.sort_by ?? 'created_at:desc',
    limit: options.limit ?? 10,
    page: options.page ?? 1,
  });
  return createResponse(httpStatus.OK, 'Plans fetched successfully.', {
    results: results.results,
    page: results.page,
    limit: results.limit,
    total_pages: results.total_pages,
    total_results: results.total_results,
  });
};

export const getPlanById = async (planId: string) => {
  const plan = await Plan.findById(toObjectId(planId));
  if (!plan || plan.status === 2) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Plan not found');
  }
  return plan;
};

export const updatePlanById = async (
  planId: string,
  updateBody: Record<string, any>,
) => {
  const plan = await getPlanById(planId);
  if (updateBody.name && (await planNameTaken(updateBody.name, planId))) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Plan name already exists');
  }
  PLAN_UPDATE_KEYS.forEach((key) => {
    if (updateBody[key] !== undefined) {
      (plan as any)[key] = updateBody[key];
    }
  });
  await plan.save();
  return plan;
};

export const updatePlanStatusById = async (
  planId: string,
  body: { status?: number; action_type?: string },
) => {
  const plan = await getPlanById(planId);
  (plan as any).status = computeStatus(body, plan.status);
  await plan.save();
  return plan;
};

export const deletePlanById = async (planId: string) => {
  const plan = await getPlanById(planId);
  (plan as any).status = 2;
  await plan.save();
  return plan;
};
