import httpStatus from 'http-status';
import { Contact } from '../../models/contact.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { createResponse, escapeRegExp, toObjectId } from '../common.service.js';
import {
  sendContactConfirmationEmail,
  sendContactNotificationEmail,
  sendContactReplyEmail,
} from '../email.service.js';
import type {
  ContactInquiryType,
  IContact,
  IContactReply,
} from '../../models/contact.model.js';

export interface SubmitContactBody {
  name: string;
  email: string;
  company?: string;
  phone?: string;
  inquiry_type?: ContactInquiryType;
  message: string;
}

/**
 * Public — persist a contact inquiry and notify the company + the visitor.
 */
export const submitContact = async (body: SubmitContactBody) => {
  const contact = await Contact.create(body);

  // Email notifications run detached from the request: a sluggish/offline SMTP
  // must never stall the submit response. Errors are swallowed and, in dev,
  // deliverTyped already falls back to the console.
  const info = {
    name: contact.name,
    email: contact.email,
    company: contact.company,
    inquiryType: contact.inquiry_type,
    message: contact.message,
  };
  void sendContactNotificationEmail(info).catch(() => null);
  void sendContactConfirmationEmail(contact.email, {
    name: contact.name,
    inquiryType: contact.inquiry_type,
  }).catch(() => null);

  return createResponse(
    httpStatus.OK,
    'Your message has been received. We will get back to you within 24 hours.',
    contact,
  );
};

/**
 * Admin — paginated contact list with search + status/inquiry-type filters.
 */
export const listContacts = async (
  filter: Record<string, any>,
  options: Record<string, any>,
) => {
  const query: Record<string, any> = {};

  if (filter.search) {
    const regex = new RegExp(escapeRegExp(String(filter.search)), 'i');
    query.$or = [
      { name: regex },
      { email: regex },
      { company: regex },
      { phone: regex },
    ];
  }

  if (filter.status !== undefined && filter.status !== '') {
    query.status = Number(filter.status);
  }
  if (filter.inquiry_type) {
    query.inquiry_type = filter.inquiry_type;
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

  const contacts = await (Contact as any).paginate(query, {
    sort_by: options.sort_by ?? 'created_at:desc',
    limit: options.limit ?? 10,
    page: options.page ?? 1,
  });

  return createResponse(httpStatus.OK, 'Contacts fetched successfully.', {
    results: contacts.results,
    page: contacts.page,
    limit: contacts.limit,
    total_pages: contacts.total_pages,
    total_results: contacts.total_results,
  });
};

export const getContactById = async (contactId: string) => {
  const contact = await Contact.findById(toObjectId(contactId));
  if (!contact) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Contact not found');
  }
  return contact;
};

/**
 * Admin — set a contact's status (0 new, 1 read, 2 replied).
 */
export const updateContactStatus = async (
  contactId: string,
  status: number,
) => {
  const existing = await Contact.findById(toObjectId(contactId));
  if (!existing) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Contact not found');
  }

  const contact = await Contact.findByIdAndUpdate(
    toObjectId(contactId),
    { status },
    { new: true },
  );
  return createResponse(httpStatus.OK, 'Status updated successfully', contact);
};

/**
 * Admin — append a reply, flip status to replied, and notify the visitor.
 */
export const replyToContact = async (
  contactId: string,
  message: string,
  sentBy: string,
) => {
  const contact = await Contact.findById(toObjectId(contactId));
  if (!contact) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Contact not found');
  }

  const reply: IContactReply = {
    message,
    sent_by: sentBy,
    sent_at: new Date(),
  };

  const updated: IContact | null = await Contact.findByIdAndUpdate(
    toObjectId(contactId),
    {
      $push: { replies: reply },
      status: 2,
    },
    { new: true },
  );

  void sendContactReplyEmail(contact.email, {
    name: contact.name,
    message,
  }).catch(() => null);

  return createResponse(httpStatus.OK, 'Reply sent successfully', updated);
};
