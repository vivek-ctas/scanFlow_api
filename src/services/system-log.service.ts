import httpStatus from 'http-status';
import { SystemLog } from '../models/system-log.model.js';
import { ApiError } from '../utils/ApiError.js';
import { isSuperAdmin } from '../middlewares/guards/isSuperAdmin.js';
import { createResponse, escapeRegExp, toObjectId } from './common.service.js';

export interface ListSystemLogsFilter {
  search?: string;
  operation?: string;
  actor_role?: string;
  operation_by?: string;
  key?: string;
  organization_id?: string;
  startDate?: string;
  endDate?: string;
}

export interface ListSystemLogsOptions {
  sort_by?: string;
  limit?: number | string;
  page?: number | string;
}

const SORTABLE_FIELDS = new Set([
  'created_at',
  'operation',
  'key',
  'actor_role',
  'ip_address',
]);

const buildSort = (sortBy?: string): Record<string, 1 | -1> => {
  const [rawField = 'created_at', rawDirection] = String(
    sortBy || 'created_at:desc',
  ).split(':');
  const field = rawField === 'createdAt' ? 'created_at' : rawField;
  const sortable = SORTABLE_FIELDS.has(field) ? field : 'created_at';
  const direction = rawDirection?.toLowerCase() === 'asc' ? 1 : -1;
  return { [sortable]: direction };
};

const escapeOrUndefined = (value?: string) => {
  const trimmed = value?.trim();
  return trimmed ? new RegExp(escapeRegExp(trimmed), 'i') : undefined;
};

const resolveOrgScope = (reqUser: any): string | null => {
  if (isSuperAdmin(reqUser)) return null;
  const orgId = reqUser?.organization_id ? String(reqUser.organization_id) : '';
  if (!/^[0-9a-fA-F]{24}$/.test(orgId)) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      'Organization scope is required to view system logs',
    );
  }
  return orgId;
};

const buildFilter = (
  filter: ListSystemLogsFilter,
  orgScope: string | null,
): Record<string, any> => {
  const query: Record<string, any> = {};

  if (filter.search?.trim()) {
    const regex = escapeOrUndefined(filter.search);
    const search: Record<string, any>[] = [
      { key: regex },
      { ip_address: regex },
      { actor_role: regex },
    ];
    if (/^[0-9a-fA-F]{24}$/.test(filter.search.trim())) {
      search.push({ operation_by: filter.search.trim() });
      search.push({ organization_id: filter.search.trim() });
    }
    query.$or = search;
  }

  if (filter.operation) {
    query.operation = filter.operation.toUpperCase();
  }
  if (filter.actor_role) {
    query.actor_role = filter.actor_role.toUpperCase();
  }
  if (filter.operation_by && /^[0-9a-fA-F]{24}$/.test(filter.operation_by)) {
    query.operation_by = toObjectId(filter.operation_by);
  }
  if (
    filter.organization_id &&
    /^[0-9a-fA-F]{24}$/.test(filter.organization_id)
  ) {
    query.organization_id = toObjectId(filter.organization_id);
  }
  if (filter.key?.trim()) {
    query.key = new RegExp(escapeRegExp(filter.key.trim()), 'i');
  }

  if (filter.startDate || filter.endDate) {
    const createdAt: Record<string, Date> = {};
    if (filter.startDate) {
      const start = new Date(filter.startDate);
      if (!Number.isNaN(start.getTime())) createdAt.$gte = start;
    }
    if (filter.endDate) {
      const end = new Date(filter.endDate);
      if (!Number.isNaN(end.getTime())) {
        end.setHours(23, 59, 59, 999);
        createdAt.$lte = end;
      }
    }
    if (Object.keys(createdAt).length) {
      query.created_at = createdAt;
    }
  }

  // Non-super-admins are hard-scoped to their own organization, overriding any
  // organization_id supplied in the query string.
  if (orgScope) {
    query.organization_id = toObjectId(orgScope);
  }

  return query;
};

export const listSystemLogs = async (
  filter: ListSystemLogsFilter,
  options: ListSystemLogsOptions,
  reqUser: any,
) => {
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
  const page = Math.max(Number(options.page) || 1, 1);
  const query = buildFilter(filter, resolveOrgScope(reqUser));

  const [logs, total] = await Promise.all([
    SystemLog.find(query)
      .sort(buildSort(options.sort_by))
      .skip((page - 1) * limit)
      .limit(limit)
      .select('-operation_data')
      .populate('operation_by', 'first_name last_name email role')
      .lean(),
    SystemLog.countDocuments(query),
  ]);

  const results = logs.map(({ _id, operation_by, ...rest }) => {
    const item: Record<string, any> = { id: String(_id), ...rest };
    if (operation_by && typeof operation_by === 'object') {
      const ob: any = operation_by;
      if (ob._id) {
        ob.id = String(ob._id);
        delete ob._id;
      }
      item.operation_by = ob;
    } else if (operation_by) {
      item.operation_by = String(operation_by);
    }
    return item;
  });

  return createResponse(httpStatus.OK, 'System logs fetched successfully.', {
    results,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
    total_results: total,
  });
};

export const getSystemLogOperations = async (reqUser: any) => {
  const orgScope = resolveOrgScope(reqUser);
  const operations = await SystemLog.distinct(
    'operation',
    orgScope ? { organization_id: toObjectId(orgScope) } : {},
  );
  return createResponse(
    httpStatus.OK,
    'System log operations fetched successfully.',
    { operations: operations.sort() },
  );
};

export const getSystemLogById = async (logId: string, reqUser: any) => {
  const orgScope = resolveOrgScope(reqUser);
  const query: Record<string, any> = { _id: logId };
  if (orgScope) {
    query.organization_id = toObjectId(orgScope);
  }
  const log = await SystemLog.findOne(query).populate(
    'operation_by',
    'first_name last_name email role',
  );
  if (!log) {
    throw new ApiError(httpStatus.NOT_FOUND, 'System log not found');
  }
  const plain: any = log.toObject ? log.toObject() : log;
  if (plain._id) {
    plain.id = String(plain._id);
    delete plain._id;
  }
  if (plain.operation_by && plain.operation_by._id) {
    plain.operation_by.id = String(plain.operation_by._id);
    delete plain.operation_by._id;
  }
  return createResponse(httpStatus.OK, 'System log fetched successfully.', {
    log: plain,
  });
};
