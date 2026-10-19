import httpStatus from 'http-status';
import config from '../config/config.js';
import { ApiError } from '../utils/ApiError.js';
import { createResponse, escapeRegExp, toObjectId } from './common.service.js';
import { isSuperAdmin } from '../middlewares/guards/isSuperAdmin.js';
import { resolveOrganizationScope } from '../middlewares/guards/orgScope.js';
import { nextTicketSeq } from '../models/counter.model.js';
import { Organization } from '../models/organization.model.js';
import { User } from '../models/user.model.js';
import { WebhookDelivery } from '../models/webhook-delivery.model.js';
import {
  SupportTicket,
  ACTIVE_SUPPORT_STATUSES,
} from '../models/support-ticket.model.js';
import type {
  ISupportTicket,
  SupportCategory,
  SupportPriority,
  SupportStatus,
} from '../models/support-ticket.model.js';
import { SupportMessage } from '../models/support-message.model.js';
import type {
  ISupportAttachment,
  ISupportMessage,
  SupportEventType,
} from '../models/support-message.model.js';
import { getOrgQuota, getOrgSummary } from './user/org-dashboard.service.js';
import { scrubErrorSummary } from '../utils/dashboard-scrub.js';
import { enqueueSupportNotification } from '../queues/support.queue.js';

const MAX_SMART_CONTEXT_BYTES = 8192;

const isStaff = (reqUser: any): boolean => isSuperAdmin(reqUser);

const nameOf = (user: any): string | null => {
  if (!user) return null;
  const parts = [user.first_name, user.last_name].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
};

const toSortBy = (sortBy?: string): string => {
  if (!sortBy) return 'updated_at:desc';
  return sortBy
    .split(',')
    .map((option) => option.trim())
    .filter(Boolean)
    .map((option) => {
      if (option.includes(':')) return option;
      if (option.startsWith('-')) return `${option.slice(1)}:desc`;
      return `${option}:asc`;
    })
    .join(',');
};

const STAFF_TRANSITIONS: Record<SupportStatus, SupportStatus[]> = {
  open: ['in_progress', 'waiting_for_customer', 'resolved', 'closed'],
  in_progress: ['waiting_for_customer', 'resolved', 'closed'],
  waiting_for_customer: ['in_progress', 'resolved', 'closed'],
  resolved: ['in_progress', 'closed'],
  closed: [],
};

const CLIENT_INFO_LIMITS: Record<string, number> = {
  user_agent: 500,
  device_id: 200,
  app_path: 300,
};

const sanitizeClientInfo = (
  input: unknown,
): Record<string, string> | null => {
  if (!input || typeof input !== 'object') return null;
  const source = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, max] of Object.entries(CLIENT_INFO_LIMITS)) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      out[key] = value.trim().slice(0, max);
    }
  }
  return Object.keys(out).length ? out : null;
};

/**
 * Build the immutable staff-only snapshot of the customer's account at the
 * moment the ticket was filed. Every section is independently wrapped so a
 * broken section can never block ticket creation.
 */
const buildSmartContext = async (
  organizationId: unknown,
  createdBy: unknown,
): Promise<Record<string, any>> => {
  const orgId = String(organizationId);
  const unavailable: string[] = [];

  let organization: Record<string, any> | null = null;
  let reporter: Record<string, any> | null = null;
  let subscription: Record<string, any> | null = null;
  let usage: Record<string, any> | null = null;
  let webhook: Record<string, any> | null = null;
  let recent_errors: Record<string, any>[] | null = null;

  try {
    const org = await Organization.findById(orgId)
      .select('company_name status')
      .lean();
    organization = {
      id: orgId,
      name: org?.company_name ?? 'Unknown',
      status: org?.status ?? null,
    };
  } catch {
    unavailable.push('organization');
  }

  try {
    if (createdBy) {
      const user = await User.findById(createdBy)
        .select('first_name last_name role')
        .lean();
      reporter = user
        ? { user_id: String((user as any)._id), role: user.role, name: nameOf(user) }
        : null;
    }
  } catch {
    unavailable.push('reporter');
  }

  try {
    const quota = await getOrgQuota(orgId);
    subscription = {
      plan_name: quota.plan_name,
      billing_cycle: quota.billing_cycle,
      state: quota.state,
      is_trial: quota.is_trial,
      period_end: quota.period_end,
      days_left: quota.days_left,
      next_plan_queued: quota.next_plan_queued,
    };
    usage = {
      used: quota.used,
      scan_limit: quota.scan_limit,
      unlimited: quota.unlimited,
      utilization_pct: quota.utilization_pct,
      source: quota.source,
    };
  } catch {
    unavailable.push('subscription');
    unavailable.push('usage');
  }

  try {
    const summary = await getOrgSummary(orgId);
    webhook = {
      state: summary.webhook.state,
      failed_24h: summary.webhook.failed_24h,
    };
  } catch {
    unavailable.push('webhook');
  }

  try {
    const since = new Date(Date.now() - 24 * 3600000);
    const failed = await WebhookDelivery.find({
      organization_id: toObjectId(orgId),
      status: 'failed',
      last_attempt_at: { $gte: since },
    })
      .sort({ last_attempt_at: -1 })
      .limit(3)
      .select('last_error last_attempt_at created_at')
      .lean();
    recent_errors = failed
      .map((row) => {
        const at = row.last_attempt_at ?? row.created_at;
        return {
          at: at ? new Date(at).toISOString() : null,
          status: 'failed',
          summary: scrubErrorSummary(row.last_error),
        };
      })
      .filter((row) => row.summary);
  } catch {
    unavailable.push('recent_errors');
  }

  const ctx: Record<string, any> = {
    captured_at: new Date().toISOString(),
    organization,
    reporter,
    subscription,
    usage,
    webhook,
    recent_errors,
    unavailable,
  };

  try {
    if (Buffer.byteLength(JSON.stringify(ctx)) > MAX_SMART_CONTEXT_BYTES) {
      ctx.recent_errors = null;
      if (!unavailable.includes('recent_errors')) unavailable.push('recent_errors');
      if (Buffer.byteLength(JSON.stringify(ctx)) > MAX_SMART_CONTEXT_BYTES) {
        ctx.usage = null;
        ctx.webhook = null;
        if (!unavailable.includes('usage')) unavailable.push('usage');
        if (!unavailable.includes('webhook')) unavailable.push('webhook');
      }
    }
  } catch {
    // size probe failed; leave the context as-is
  }

  return ctx;
};

interface TicketRelations {
  staff: boolean;
  userMap: Map<string, string | null>;
  orgMap: Map<string, string | null>;
}

const buildRelations = async (
  tickets: (ISupportTicket | Record<string, any>)[],
  staff: boolean,
): Promise<TicketRelations> => {
  const userIds = new Set<string>();
  const orgIds = new Set<string>();
  for (const ticket of tickets) {
    if (ticket.created_by) userIds.add(String(ticket.created_by));
    if (ticket.assigned_to) userIds.add(String(ticket.assigned_to));
    if (ticket.organization_id) orgIds.add(String(ticket.organization_id));
  }

  const [users, orgs] = await Promise.all([
    userIds.size
      ? User.find({ _id: { $in: [...userIds] } })
          .select('first_name last_name')
          .lean()
      : Promise.resolve([] as any[]),
    orgIds.size
      ? Organization.find({ _id: { $in: [...orgIds] } })
          .select('company_name')
          .lean()
      : Promise.resolve([] as any[]),
  ]);

  return {
    staff,
    userMap: new Map(users.map((u: any) => [String(u._id), nameOf(u)])),
    orgMap: new Map(orgs.map((o: any) => [String(o._id), o.company_name ?? null])),
  };
};

const computeAwaiting = (ticket: any) => {
  const now = Date.now();
  const thresholdMs = config.support.firstResponseHours * 3600000;

  if (ticket.first_response_at) {
    const isAwaitingStaff =
      (ticket.status === 'open' || ticket.status === 'in_progress') &&
      ticket.last_customer_message_at &&
      (!ticket.last_staff_message_at ||
        new Date(ticket.last_customer_message_at).getTime() >
          new Date(ticket.last_staff_message_at).getTime());
    if (!isAwaitingStaff) return null;
    const age = Math.floor(
      (now - new Date(ticket.last_customer_message_at).getTime()) / 1000,
    );
    return { kind: 'staff', age_seconds: age, overdue: age * 1000 > thresholdMs };
  }

  if (ticket.status === 'resolved' || ticket.status === 'closed') return null;
  const age = Math.floor(
    (now - new Date(ticket.created_at).getTime()) / 1000,
  );
  return {
    kind: 'first_response',
    age_seconds: age,
    overdue: age * 1000 > thresholdMs,
  };
};

const senderLabel = (message: any, staff: boolean): string => {
  if (message.sender_role === 'SUPER_ADMIN') return 'ScanFlow Support';
  if (message.sender_role === 'system') return 'System';
  return staff ? 'Customer' : 'You';
};

const serializeMessage = (message: any, staff: boolean) => {
  const out: Record<string, any> = {
    id: String(message._id),
    kind: message.kind,
    sender_label: senderLabel(message, staff),
    body: message.body,
    event: message.event ?? null,
    attachments: message.attachments ?? [],
    is_internal: Boolean(message.is_internal),
    created_at: message.created_at,
  };
  if (staff) {
    out.sender_role = message.sender_role;
    out.sender_id = message.sender_id ? String(message.sender_id) : null;
  }
  return out;
};

const serializeTicket = (
  ticket: any,
  relations: TicketRelations,
  messages?: any[],
) => {
  const { staff, userMap, orgMap } = relations;
  const out: Record<string, any> = {
    id: String(ticket._id),
    ticket_no: ticket.ticket_no,
    subject: ticket.subject,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    resolved_at: ticket.resolved_at ?? null,
    closed_at: ticket.closed_at ?? null,
    last_customer_message_at: ticket.last_customer_message_at ?? null,
    last_staff_message_at: ticket.last_staff_message_at ?? null,
    created_by: ticket.created_by
      ? {
          id: String(ticket.created_by),
          name: userMap.get(String(ticket.created_by)) ?? null,
        }
      : null,
  };

  if (messages) {
    out.messages = messages.map((m) => serializeMessage(m, staff));
  }

  if (staff) {
    out.organization = {
      id: String(ticket.organization_id),
      name: orgMap.get(String(ticket.organization_id)) ?? null,
    };
    out.assigned_to = ticket.assigned_to
      ? {
          id: String(ticket.assigned_to),
          name: userMap.get(String(ticket.assigned_to)) ?? null,
        }
      : null;
    out.first_response_at = ticket.first_response_at ?? null;
    out.awaiting = computeAwaiting(ticket);
    out.smart_context = ticket.smart_context ?? null;
    out.client_info = ticket.client_info ?? null;
  }

  return out;
};

const loadTicketForWrite = async (reqUser: any, ticketId: string) => {
  const orgScope = resolveOrganizationScope(reqUser, undefined);
  const query: Record<string, any> = { _id: toObjectId(ticketId) };
  if (orgScope) query.organization_id = orgScope;
  const ticket = await SupportTicket.findOne(query);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Ticket not found');
  return ticket;
};

/**
 * Resolve an attachment for download after verifying the caller can access the
 * owning ticket (org-scoped via `loadTicketForWrite` → 404 for cross-org).
 */
export const getAttachment = async (
  reqUser: any,
  ticketId: string,
  messageId: string,
  index: number,
): Promise<ISupportAttachment> => {
  const ticket = await loadTicketForWrite(reqUser, ticketId);
  const message = await SupportMessage.findOne({
    _id: toObjectId(messageId),
    ticket_id: ticket._id,
  });
  if (!message) throw new ApiError(httpStatus.NOT_FOUND, 'Message not found');

  if (!Number.isInteger(index) || index < 0 || index >= (message.attachments?.length ?? 0)) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Attachment not found');
  }
  return message.attachments[index] as ISupportAttachment;
};

const writeEvent = async (
  ticket: ISupportTicket,
  type: SupportEventType,
  from: string | null,
  to: string | null,
  internal: boolean,
  actorId?: any,
) => {
  await SupportMessage.create({
    ticket_id: ticket._id,
    organization_id: ticket.organization_id,
    sender_id: actorId ?? null,
    sender_role: 'system',
    kind: 'event',
    is_internal: internal,
    body: '',
    event: { type, from, to },
  });
};

export interface CreateTicketBody {
  subject: string;
  category: SupportCategory;
  priority?: SupportPriority;
  description: string;
  organization_id?: string;
  client_info?: Record<string, any>;
}

/**
 * Create a ticket plus its first message. The org is derived server-side; a
 * super admin must pass `organization_id`.
 */
export const createTicket = async (
  reqUser: any,
  body: CreateTicketBody,
  attachments: ISupportAttachment[] = [],
) => {
  const staff = isStaff(reqUser);
  if (
    !staff &&
    body.priority &&
    !['normal', 'high'].includes(body.priority)
  ) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Priority must be normal or high.',
    );
  }

  const orgScope = resolveOrganizationScope(reqUser, body.organization_id, {
    required: true,
  })!;

  const activeCount = await SupportTicket.countDocuments({
    organization_id: orgScope,
    status: { $in: ACTIVE_SUPPORT_STATUSES },
  });
  if (activeCount >= config.support.maxActivePerOrg) {
    throw new ApiError(
      httpStatus.TOO_MANY_REQUESTS,
      `You already have ${config.support.maxActivePerOrg} active support tickets. Please close or await a reply before opening another.`,
    );
  }

  const seq = await nextTicketSeq();
  const now = new Date();
  const smart_context = await buildSmartContext(orgScope, reqUser._id);

  const ticket = await SupportTicket.create({
    ticket_no: `SF-${seq}`,
    organization_id: orgScope,
    created_by: reqUser._id,
    subject: body.subject,
    category: body.category,
    priority: body.priority ?? 'normal',
    status: 'open',
    assigned_to: null,
    last_message_at: now,
    last_customer_message_at: now,
    last_staff_message_at: null,
    first_response_at: null,
    client_info: sanitizeClientInfo(body.client_info),
    smart_context,
  });

  await SupportMessage.create({
    ticket_id: ticket._id,
    organization_id: orgScope,
    sender_id: reqUser._id,
    sender_role: reqUser.role,
    kind: 'reply',
    is_internal: false,
    body: body.description,
    attachments,
  });

  void enqueueSupportNotification({
    event: 'ticket_created',
    ticket_id: String(ticket._id),
  }).catch(() => null);

  const relations = await buildRelations([ticket], isStaff(reqUser));
  const firstMessage = await SupportMessage.findOne({ ticket_id: ticket._id })
    .sort({ created_at: 1 })
    .lean();
  return createResponse(
    httpStatus.CREATED,
    'Support ticket created successfully.',
    { ticket: serializeTicket(ticket, relations, firstMessage ? [firstMessage] : []) },
  );
};

const applyView = (
  query: Record<string, any>,
  view: string | undefined,
  staff: boolean,
) => {
  switch (view) {
    case 'active':
      query.status = { $in: ACTIVE_SUPPORT_STATUSES };
      break;
    case 'awaiting_customer':
      query.status = 'waiting_for_customer';
      break;
    case 'resolved':
      query.status = 'resolved';
      break;
    case 'closed':
      query.status = 'closed';
      break;
    case 'unassigned':
      if (staff) {
        query.status = { $in: ACTIVE_SUPPORT_STATUSES };
        query.assigned_to = null;
      }
      break;
    case 'awaiting_staff':
      if (staff) {
        query.$or = [
          { status: 'open' },
          {
            status: 'in_progress',
            $expr: {
              $gt: ['$last_customer_message_at', '$last_staff_message_at'],
            },
          },
        ];
      }
      break;
    default:
      break;
  }
};

export const listTickets = async (
  reqUser: any,
  filter: Record<string, any>,
  options: Record<string, any>,
) => {
  const staff = isStaff(reqUser);
  const orgScope = resolveOrganizationScope(reqUser, filter.organization_id);

  const query: Record<string, any> = {};
  if (orgScope) query.organization_id = orgScope;
  if (filter.category) query.category = filter.category;
  if (filter.priority) query.priority = filter.priority;
  if (filter.status) query.status = filter.status;
  if (staff && filter.assigned_to) {
    query.assigned_to = toObjectId(String(filter.assigned_to));
  }
  applyView(query, filter.view, staff);

  if (filter.search) {
    const regex = new RegExp(escapeRegExp(String(filter.search)), 'i');
    query.$or = [{ ticket_no: regex }, { subject: regex }];
  }

  const tickets = await (SupportTicket as any).paginate(query, {
    sortBy: toSortBy(options.sort_by ?? options.sortBy),
    limit: options.limit ?? 10,
    page: options.page ?? 1,
  });

  const relations = await buildRelations(tickets.results, staff);
  const results = tickets.results.map((ticket: any) =>
    serializeTicket(ticket, relations),
  );

  return createResponse(httpStatus.OK, 'Support tickets fetched successfully.', {
    results,
    page: tickets.page,
    limit: tickets.limit,
    total_pages: tickets.total_pages,
    total_results: tickets.total_results,
  });
};

export const getTicketDetail = async (reqUser: any, ticketId: string) => {
  const staff = isStaff(reqUser);
  const orgScope = resolveOrganizationScope(reqUser, undefined);

  const query: Record<string, any> = { _id: toObjectId(ticketId) };
  if (orgScope) query.organization_id = orgScope;

  const ticket = await SupportTicket.findOne(query).select(
    staff ? '+smart_context +client_info' : '',
  );
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Ticket not found');

  const messageQuery: Record<string, any> = {
    ticket_id: ticket._id,
    organization_id: ticket.organization_id,
  };
  if (!staff) messageQuery.is_internal = false;

  const messages: ISupportMessage[] = await SupportMessage.find(messageQuery).sort(
    { created_at: 1 },
  );

  const relations = await buildRelations([ticket], staff);
  return createResponse(
    httpStatus.OK,
    'Support ticket fetched successfully.',
    { ticket: serializeTicket(ticket, relations, messages) },
  );
};

export interface ReplyBody {
  message: string;
}

export const addMessage = async (
  reqUser: any,
  ticketId: string,
  body: ReplyBody,
  attachments: ISupportAttachment[] = [],
) => {
  const staff = isStaff(reqUser);
  const ticket = await loadTicketForWrite(reqUser, ticketId);
  if (ticket.status === 'closed') {
    throw new ApiError(
      httpStatus.CONFLICT,
      'This ticket is closed — open a new ticket.',
    );
  }

  const now = new Date();
  const message = await SupportMessage.create({
    ticket_id: ticket._id,
    organization_id: ticket.organization_id,
    sender_id: reqUser._id,
    sender_role: reqUser.role,
    kind: 'reply',
    is_internal: false,
    body: body.message,
    attachments,
  });

  const updates: Record<string, any> = { last_message_at: now };
  if (staff) {
    updates.last_staff_message_at = now;
    if (!ticket.first_response_at) updates.first_response_at = now;
  } else {
    updates.last_customer_message_at = now;
  }

  let nextStatus: SupportStatus = ticket.status;
  const events: { type: SupportEventType; from: string; to: string }[] = [];

  if (ticket.status === 'resolved') {
    nextStatus = staff ? 'in_progress' : 'open';
    events.push({ type: 'status_changed', from: ticket.status, to: nextStatus });
    events.push({ type: 'reopened', from: ticket.status, to: nextStatus });
    updates.resolved_at = null;
  } else if (!staff && ticket.status === 'waiting_for_customer') {
    nextStatus = ticket.assigned_to ? 'in_progress' : 'open';
  } else if (staff && ticket.status === 'open') {
    nextStatus = 'in_progress';
  }

  if (nextStatus !== ticket.status) {
    updates.status = nextStatus;
    if (!events.some((e) => e.type === 'status_changed')) {
      events.push({
        type: 'status_changed',
        from: ticket.status,
        to: nextStatus,
      });
    }
  }

  await SupportTicket.findOneAndUpdate(
    { _id: ticket._id, status: { $ne: 'closed' } },
    { $set: updates },
  );

  for (const event of events) {
    await writeEvent(
      ticket,
      event.type,
      event.from,
      event.to,
      false,
      reqUser._id,
    );
  }

  void enqueueSupportNotification({
    event: staff ? 'staff_replied' : 'customer_replied',
    ticket_id: String(ticket._id),
    message_id: String(message._id),
  }).catch(() => null);

  const updated = await SupportTicket.findById(ticket._id);
  const relations = await buildRelations([updated ?? ticket], staff);
  return createResponse(httpStatus.OK, 'Reply added successfully.', {
    ticket: serializeTicket(updated ?? ticket, relations),
    message: serializeMessage(message, staff),
  });
};

export const closeTicket = async (reqUser: any, ticketId: string) => {
  const ticket = await loadTicketForWrite(reqUser, ticketId);
  const relations = await buildRelations([ticket], isStaff(reqUser));

  if (ticket.status === 'closed') {
    return createResponse(httpStatus.OK, 'Ticket is already closed.', {
      ticket: serializeTicket(ticket, relations),
    });
  }

  const now = new Date();
  await SupportTicket.findByIdAndUpdate(ticket._id, {
    $set: { status: 'closed', closed_at: now, last_message_at: now },
  });
  await writeEvent(ticket, 'closed', ticket.status, 'closed', false, reqUser._id);

  void enqueueSupportNotification({
    event: 'status_changed',
    ticket_id: String(ticket._id),
    status: 'closed',
  }).catch(() => null);

  const updated = await SupportTicket.findById(ticket._id);
  const updatedRelations = await buildRelations([updated ?? ticket], isStaff(reqUser));
  return createResponse(httpStatus.OK, 'Ticket closed successfully.', {
    ticket: serializeTicket(updated ?? ticket, updatedRelations),
  });
};

export const addNote = async (
  reqUser: any,
  ticketId: string,
  body: ReplyBody,
) => {
  const ticket = await loadTicketForWrite(reqUser, ticketId);
  const now = new Date();

  await SupportMessage.create({
    ticket_id: ticket._id,
    organization_id: ticket.organization_id,
    sender_id: reqUser._id,
    sender_role: reqUser.role,
    kind: 'note',
    is_internal: true,
    body: body.message,
  });
  await SupportTicket.findByIdAndUpdate(ticket._id, {
    $set: { last_message_at: now },
  });

  const noteMessage = await SupportMessage.findOne({
    ticket_id: ticket._id,
    kind: 'note',
    sender_id: reqUser._id,
  }).sort({ created_at: -1 }).lean();

  const updated = await SupportTicket.findById(ticket._id);
  const relations = await buildRelations([updated ?? ticket], true);
  return createResponse(httpStatus.OK, 'Internal note added successfully.', {
    ticket: serializeTicket(updated ?? ticket, relations),
    message: noteMessage ? serializeMessage(noteMessage, true) : null,
  });
};

export interface UpdateTicketBody {
  status?: SupportStatus;
  priority?: SupportPriority;
  assigned_to?: string | null;
}

export const updateTicket = async (
  reqUser: any,
  ticketId: string,
  body: UpdateTicketBody,
) => {
  const ticket = await loadTicketForWrite(reqUser, ticketId);
  const now = new Date();
  const updates: Record<string, any> = {};

  if (body.status && body.status !== ticket.status) {
    const allowed = STAFF_TRANSITIONS[ticket.status] ?? [];
    if (!allowed.includes(body.status)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot move a ${ticket.status} ticket to ${body.status}.`,
      );
    }
    updates.status = body.status;
    if (body.status === 'resolved') updates.resolved_at = now;
    if (body.status === 'closed') updates.closed_at = now;
    if (body.status === 'in_progress' || body.status === 'open') {
      updates.resolved_at = null;
      updates.closed_at = null;
    }
  }

  if (body.priority && body.priority !== ticket.priority) {
    updates.priority = body.priority;
  }

  let assignedUser: any = null;
  if (body.assigned_to !== undefined) {
    const nextAssignee = body.assigned_to ? String(body.assigned_to) : null;
    const current = ticket.assigned_to ? String(ticket.assigned_to) : null;
    if (nextAssignee !== current) {
      if (nextAssignee) {
        assignedUser = await User.findOne({
          _id: toObjectId(nextAssignee),
          role: 'SUPER_ADMIN',
          status: 1,
        }).select('first_name last_name');
        if (!assignedUser) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            'Assignee must be an active super admin.',
          );
        }
      }
      updates.assigned_to = nextAssignee ? toObjectId(nextAssignee) : null;
    }
  }

  if (Object.keys(updates).length) {
    updates.last_message_at = now;
    await SupportTicket.findByIdAndUpdate(ticket._id, { $set: updates });
  }

  if (updates.status) {
    await writeEvent(
      ticket,
      updates.status === 'closed' ? 'closed' : 'status_changed',
      ticket.status,
      updates.status,
      false,
      reqUser._id,
    );
  }
  if (updates.priority) {
    await writeEvent(
      ticket,
      'priority_changed',
      ticket.priority,
      updates.priority,
      true,
      reqUser._id,
    );
  }
  if (updates.assigned_to !== undefined) {
    await writeEvent(
      ticket,
      'assigned',
      ticket.assigned_to ? String(ticket.assigned_to) : null,
      updates.assigned_to ? String(updates.assigned_to) : null,
      true,
      reqUser._id,
    );
  }

  if (updates.status === 'resolved' || updates.status === 'closed') {
    void enqueueSupportNotification({
      event: 'status_changed',
      ticket_id: String(ticket._id),
      status: updates.status,
    }).catch(() => null);
  }

  const updated = await SupportTicket.findById(ticket._id);
  const relations = await buildRelations([updated ?? ticket], true);
  return createResponse(httpStatus.OK, 'Ticket updated successfully.', {
    ticket: serializeTicket(updated ?? ticket, relations),
  });
};

export const getSummary = async (reqUser: any) => {
  const staff = isStaff(reqUser);
  const orgScope = resolveOrganizationScope(reqUser, undefined);

  if (staff && !orgScope) {
    const threshold = new Date(
      Date.now() - config.support.firstResponseHours * 3600000,
    );
    const [unassigned, awaiting_staff, overdue, active] = await Promise.all([
      SupportTicket.countDocuments({
        status: { $in: ACTIVE_SUPPORT_STATUSES },
        assigned_to: null,
      }),
      SupportTicket.countDocuments({
        $or: [
          { status: 'open' },
          {
            status: 'in_progress',
            $expr: {
              $gt: ['$last_customer_message_at', '$last_staff_message_at'],
            },
          },
        ],
      }),
      SupportTicket.countDocuments({
        status: { $in: ACTIVE_SUPPORT_STATUSES },
        first_response_at: null,
        created_at: { $lte: threshold },
      }),
      SupportTicket.countDocuments({ status: { $in: ACTIVE_SUPPORT_STATUSES } }),
    ]);
    return createResponse(httpStatus.OK, 'Support summary fetched successfully.', {
      unassigned,
      awaiting_staff,
      overdue,
      active,
    });
  }

  const base: Record<string, any> = {};
  if (orgScope) base.organization_id = orgScope;
  const [active, awaiting_customer] = await Promise.all([
    SupportTicket.countDocuments({
      ...base,
      status: { $in: ACTIVE_SUPPORT_STATUSES },
    }),
    SupportTicket.countDocuments({ ...base, status: 'waiting_for_customer' }),
  ]);

  return createResponse(httpStatus.OK, 'Support summary fetched successfully.', {
    active,
    awaiting_customer,
  });
};

export const listStaff = async () => {
  const staff = await User.find({ role: 'SUPER_ADMIN', status: 1 })
    .select('first_name last_name')
    .sort({ first_name: 1 })
    .lean();
  return createResponse(httpStatus.OK, 'Support staff fetched successfully.', {
    results: staff.map((user: any) => ({
      id: String(user._id),
      name: nameOf(user),
    })),
  });
};

/**
 * Phase 5: close `resolved` tickets with no customer reply for
 * SUPPORT_AUTOCLOSE_DAYS. Run from the worker.
 */
export const runAutoCloseJob = async (): Promise<number> => {
  const cutoff = new Date(
    Date.now() - config.support.autocloseDays * 86400000,
  );
  const stale = await SupportTicket.find({
    status: 'resolved',
    resolved_at: { $lte: cutoff },
  }).limit(500);

  for (const ticket of stale) {
    const now = new Date();
    await SupportTicket.findByIdAndUpdate(ticket._id, {
      $set: { status: 'closed', closed_at: now, last_message_at: now },
    });
    await writeEvent(
      ticket,
      'closed',
      'resolved',
      'closed',
      false,
      undefined,
    );
  }
  return stale.length;
};
