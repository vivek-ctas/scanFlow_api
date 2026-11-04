import { Request, Response } from 'express';
import httpStatus from 'http-status';
import { catchAsync } from '../utils/catchAsync.js';
import { pick } from '../utils/pick.js';
import * as supportService from '../services/support.service.js';
import {
  resolveAttachmentPath,
  attachmentExists,
  canPreviewAttachment,
  verifyAttachmentToken,
} from '../services/support-storage.service.js';
import {
  DEFAULT_CONFIG,
  getAttachmentConfig,
  kindForAttachment,
} from '../services/support-attachment-types.js';
import config from '../config/config.js';
import type {
  CreateTicketBody,
  ReplyBody,
  UpdateTicketBody,
} from '../services/support.service.js';

const files = (req: Request) => (req.files as Express.Multer.File[]) ?? [];

const attachmentConfig = () => {
  const support = (config as any).support ?? {};
  const allowedKinds = String(support.allowedKinds || '')
    .split(',')
    .map((kind: string) => kind.trim())
    .filter(Boolean);
  return {
    ...DEFAULT_CONFIG,
    maxFiles: Number(support.maxFiles) || DEFAULT_CONFIG.maxFiles,
    maxTotalMB: Number(support.maxTotalMb) || DEFAULT_CONFIG.maxTotalMB,
    maxImageMB: Number(support.maxImageMb) || DEFAULT_CONFIG.maxImageMB,
    maxDocumentMB:
      Number(support.maxDocumentMb) || DEFAULT_CONFIG.maxDocumentMB,
    maxTextMB: Number(support.maxTextMb) || DEFAULT_CONFIG.maxTextMB,
    maxArchiveMB: Number(support.maxArchiveMb) || DEFAULT_CONFIG.maxArchiveMB,
    maxVideoMB: Number(support.maxVideoMb) || DEFAULT_CONFIG.maxVideoMB,
    allowedKinds: allowedKinds.length
      ? (allowedKinds as typeof DEFAULT_CONFIG.allowedKinds)
      : DEFAULT_CONFIG.allowedKinds,
  };
};

const sendAttachment = async (
  res: Response,
  attachment: {
    storage_key: string;
    file_name: string;
    content_type: string;
    kind?: string | null;
  },
  forceDownload = false,
) => {
  if (!(await attachmentExists(attachment.storage_key))) {
    res.status(httpStatus.NOT_FOUND).json({
      status: httpStatus.NOT_FOUND,
      message: 'Attachment not found',
    });
    return;
  }

  const kind =
    (attachment.kind as any) ??
    kindForAttachment(attachment.content_type, attachment.file_name);
  const inline =
    !forceDownload &&
    canPreviewAttachment(kind, attachment.content_type, attachment.file_name);

  const fallbackName = attachment.file_name
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/"/g, '');

  res.setHeader(
    'Content-Type',
    attachment.content_type || 'application/octet-stream',
  );
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(
      attachment.file_name,
    )}`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(resolveAttachmentPath(attachment.storage_key));
};

export const getAttachmentConfigHandler = catchAsync(
  async (_req: Request, res: Response) => {
    res.status(httpStatus.OK).json(getAttachmentConfig(attachmentConfig()));
  },
);

export const createTicket = catchAsync(async (req: Request, res: Response) => {
  const result = await supportService.createTicket(
    req.user,
    req.body as CreateTicketBody,
    files(req),
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
  const result = await supportService.addMessage(
    req.user,
    String(req.params.ticketId),
    req.body as ReplyBody,
    files(req),
  );
  res.status(result.status).json(result);
});

export const listMessages = catchAsync(async (req: Request, res: Response) => {
  const result = await supportService.listMessages(
    req.user,
    String(req.params.ticketId),
    {
      before: req.query.before ? String(req.query.before) : undefined,
      after: req.query.after ? String(req.query.after) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    },
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
    await sendAttachment(res, attachment, req.query.download === '1');
  },
);

export const getAttachmentAccess = catchAsync(
  async (req: Request, res: Response) => {
    const result = await supportService.getAttachmentAccess(
      req.user,
      String(req.params.ticketId),
      String(req.params.messageId),
      Number(req.params.index),
    );
    res.status(result.status).json(result);
  },
);

export const mediaAttachment = catchAsync(
  async (req: Request, res: Response) => {
    const ticketId = String(req.params.ticketId);
    const messageId = String(req.params.messageId);
    const index = Number(req.params.index);
    const token = String(req.query.token ?? '');

    if (!verifyAttachmentToken(token, { ticketId, messageId, index })) {
      res.status(httpStatus.NOT_FOUND).json({
        status: httpStatus.NOT_FOUND,
        message: 'Attachment not found',
      });
      return;
    }

    const attachment = await supportService.getAttachmentForToken(
      ticketId,
      messageId,
      index,
    );
    await sendAttachment(res, attachment, req.query.download === '1');
  },
);

export const listTicketAttachments = catchAsync(
  async (req: Request, res: Response) => {
    const result = await supportService.listTicketAttachments(
      req.user,
      String(req.params.ticketId),
      {
        page: req.query.page ? Number(req.query.page) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      },
    );
    res.status(result.status).json(result);
  },
);

export const removeAttachment = catchAsync(
  async (req: Request, res: Response) => {
    const result = await supportService.removeAttachment(
      req.user,
      String(req.params.ticketId),
      String(req.params.messageId),
      Number(req.params.index),
    );
    res.status(result.status).json(result);
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
  const result = await supportService.getSummary(
    req.user,
    req.query.organization_id ? String(req.query.organization_id) : undefined,
  );
  res.status(result.status).json(result);
});

export const listStaff = catchAsync(async (_req: Request, res: Response) => {
  const result = await supportService.listStaff();
  res.status(result.status).json(result);
});

export const markTicketAsRead = catchAsync(
  async (req: Request, res: Response) => {
    const result = await supportService.markTicketAsRead(
      req.user,
      String(req.params.ticketId),
      req.body?.up_to ? String(req.body.up_to) : undefined,
    );
    res.status(result.status).json(result);
  },
);
