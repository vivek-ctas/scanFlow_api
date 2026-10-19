import { Request, Response } from 'express';
import httpStatus from 'http-status';
import { catchAsync } from '../utils/catchAsync.js';
import { pick } from '../utils/pick.js';
import * as supportService from '../services/support.service.js';
import {
  saveAttachments,
  resolveAttachmentPath,
  attachmentExists,
} from '../services/support-storage.service.js';
import type {
  CreateTicketBody,
  ReplyBody,
  UpdateTicketBody,
} from '../services/support.service.js';

const files = (req: Request) => (req.files as Express.Multer.File[]) ?? [];

export const createTicket = catchAsync(async (req: Request, res: Response) => {
  const attachments = await saveAttachments(files(req));
  const result = await supportService.createTicket(
    req.user,
    req.body as CreateTicketBody,
    attachments,
  );
  res.status(result.status).json(result);
});

export const listTickets = catchAsync(async (req: Request, res: Response) => {
  const filter = pick(req.query, [
    'view',
    'category',
    'priority',
    'status',
    'search',
    'organization_id',
    'assigned_to',
  ]);
  const options = pick(req.query, ['sort_by', 'limit', 'page']);
  const result = await supportService.listTickets(req.user, filter, options);
  res.status(result.status).json(result);
});

export const getTicket = catchAsync(async (req: Request, res: Response) => {
  const result = await supportService.getTicketDetail(
    req.user,
    String(req.params.ticketId),
  );
  res.status(result.status).json(result);
});

export const addMessage = catchAsync(async (req: Request, res: Response) => {
  const attachments = await saveAttachments(files(req));
  const result = await supportService.addMessage(
    req.user,
    String(req.params.ticketId),
    req.body as ReplyBody,
    attachments,
  );
  res.status(result.status).json(result);
});

export const downloadAttachment = catchAsync(
  async (req: Request, res: Response) => {
    const attachment = await supportService.getAttachment(
      req.user,
      String(req.params.ticketId),
      String(req.params.messageId),
      Number(req.params.index),
    );
    const absolute = resolveAttachmentPath(attachment.storage_key);
    if (!(await attachmentExists(attachment.storage_key))) {
      res.status(httpStatus.NOT_FOUND).json({
        status: httpStatus.NOT_FOUND,
        message: 'Attachment not found',
      });
      return;
    }
    res.setHeader('Content-Type', attachment.content_type);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${attachment.file_name.replace(/"/g, '')}"`,
    );
    res.sendFile(absolute);
  },
);

export const closeTicket = catchAsync(async (req: Request, res: Response) => {
  const result = await supportService.closeTicket(
    req.user,
    String(req.params.ticketId),
  );
  res.status(result.status).json(result);
});

export const addNote = catchAsync(async (req: Request, res: Response) => {
  const result = await supportService.addNote(
    req.user,
    String(req.params.ticketId),
    req.body as ReplyBody,
  );
  res.status(result.status).json(result);
});

export const updateTicket = catchAsync(async (req: Request, res: Response) => {
  const result = await supportService.updateTicket(
    req.user,
    String(req.params.ticketId),
    req.body as UpdateTicketBody,
  );
  res.status(result.status).json(result);
});

export const getSummary = catchAsync(async (req: Request, res: Response) => {
  const result = await supportService.getSummary(req.user);
  res.status(result.status).json(result);
});

export const listStaff = catchAsync(async (_req: Request, res: Response) => {
  const result = await supportService.listStaff();
  res.status(result.status).json(result);
});
