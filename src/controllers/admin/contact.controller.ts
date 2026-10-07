import httpStatus from 'http-status';
import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync.js';
import { pick } from '../../utils/pick.js';
import * as contactService from '../../services/admin/contact.service.js';
import { createResponse } from '../../services/common.service.js';

export const submitContact = catchAsync(async (req: Request, res: Response) => {
  const result = await contactService.submitContact(req.body);
  res.status(result.status).json(result);
});

export const listContacts = catchAsync(async (req: Request, res: Response) => {
  const filter = pick(req.query, [
    'search',
    'status',
    'inquiry_type',
    'date_from',
    'date_to',
  ]);
  const options = pick(req.query, ['sort_by', 'limit', 'page']);
  const result = await contactService.listContacts(filter, options);
  res.status(result.status).json(result);
});

export const getContact = catchAsync(async (req: Request, res: Response) => {
  const contact = await contactService.getContactById(
    String(req.params.contactId),
  );
  res.status(httpStatus.OK).json(
    createResponse(httpStatus.OK, 'Contact fetched successfully.', {
      contact,
    }),
  );
});

export const updateContactStatus = catchAsync(
  async (req: Request, res: Response) => {
    const result = await contactService.updateContactStatus(
      String(req.params.contactId),
      Number(req.body.status),
    );
    res.status(result.status).json(result);
  },
);

export const replyToContact = catchAsync(
  async (req: Request, res: Response) => {
    const sentBy =
      (req.user as any)?.name || (req.user as any)?.email || 'Admin';
    const result = await contactService.replyToContact(
      String(req.params.contactId),
      String(req.body.message),
      sentBy,
    );
    res.status(result.status).json(result);
  },
);
