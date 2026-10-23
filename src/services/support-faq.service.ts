import httpStatus from 'http-status';
import mongoose from 'mongoose';
import { Faq } from '../models/index.js';
import { computeStatus, createResponse } from './common.service.js';
import { systemLog } from '../utils/system-log.js';

const toObjectId = (value: string) => new mongoose.Types.ObjectId(value);

const visibleForUser = (user: any) => {
  const role = user?.role;
  if (role === 'SUPER_ADMIN' || user?.is_super_admin) {
    return {} as any;
  }
  if (
    Array.isArray(role)
      ? role.includes('ORGANIZATION_ADMIN')
      : role === 'ORGANIZATION_ADMIN'
  ) {
    return {
      status: 1,
      audience: { $in: ['all', 'organization_admin'] },
    } as any;
  }
  return { status: 1, audience: { $in: ['all'] } } as any;
};

export const listFaqs = async (user: any) => {
  const filter = visibleForUser(user);
  const faqs = await Faq.find(filter)
    .sort({ sort_order: 1, created_at: 1 })
    .limit(500)
    .lean();
  return createResponse(httpStatus.OK, 'FAQs fetched successfully.', {
    results: faqs,
  });
};

export const manageFaqs = async (
  user: any,
  query: Record<string, any> = {},
  options: Record<string, any> = {},
) => {
  if (!(user?.role === 'SUPER_ADMIN' || user?.is_super_admin)) {
    return createResponse(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const filter: Record<string, any> = {};
  if (query.status !== undefined && query.status !== '') {
    filter.status = Number(query.status);
  }
  if (query.category) filter.category = query.category;
  if (query.search) {
    const q = String(query.search).trim();
    if (q) {
      filter.$or = [
        { question: { $regex: q, $options: 'i' } },
        { keywords: { $regex: q, $options: 'i' } },
      ];
    }
  }
  const page = Number(options.page) || 1;
  const limit = Number(options.limit) || 20;
  const results = await (Faq as any).paginate(filter, {
    page,
    limit,
    sortBy: 'sort_order:asc,created_at:asc',
  });
  return createResponse(httpStatus.OK, 'FAQs fetched successfully.', results);
};

export const createFaq = async (user: any, body: any) => {
  if (!(user?.role === 'SUPER_ADMIN' || user?.is_super_admin)) {
    return createResponse(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const faq = await Faq.create({
    question: body.question,
    answer: body.answer,
    category: body.category,
    audience: body.audience || 'all',
    keywords: Array.isArray(body.keywords) ? body.keywords : [],
    status: body.status === undefined ? 0 : Number(body.status),
    sort_order: Number(body.sort_order) || 0,
    created_by: toObjectId(user.id || user._id),
  });
  await systemLog({
    operation: 'CREATE',
    key: 'create-faq',
    data: faq.toObject(),
    actorId: user.id || user._id,
  });
  return createResponse(httpStatus.CREATED, 'FAQ created successfully.', {
    faq,
  });
};

export const updateFaq = async (user: any, faqId: string, body: any) => {
  if (!(user?.role === 'SUPER_ADMIN' || user?.is_super_admin)) {
    return createResponse(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const faq = await Faq.findById(toObjectId(faqId));
  if (!faq || faq.status === 2) {
    return createResponse(httpStatus.NOT_FOUND, 'FAQ not found');
  }
  const existing = faq.toObject();
  if (body.question !== undefined) faq.question = body.question;
  if (body.answer !== undefined) faq.answer = body.answer;
  if (body.category !== undefined) faq.category = body.category;
  if (body.audience !== undefined) faq.audience = body.audience;
  if (body.keywords !== undefined)
    faq.keywords = Array.isArray(body.keywords) ? body.keywords : [];
  if (body.sort_order !== undefined)
    faq.sort_order = Number(body.sort_order) || 0;
  if (body.status !== undefined && body.status !== 2)
    faq.status = Number(body.status);
  (faq as any).modified_by = toObjectId(user.id || user._id);
  await faq.save();
  await systemLog({
    operation: 'UPDATE',
    key: 'update-faq',
    data: faq.toObject(),
    existingData: existing,
    actorId: user.id || user._id,
  });
  return createResponse(httpStatus.OK, 'FAQ updated successfully.', { faq });
};

export const updateFaqStatus = async (user: any, faqId: string, body: any) => {
  if (!(user?.role === 'SUPER_ADMIN' || user?.is_super_admin)) {
    return createResponse(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const faq = await Faq.findById(toObjectId(faqId));
  if (!faq || faq.status === 2) {
    return createResponse(httpStatus.NOT_FOUND, 'FAQ not found');
  }
  const existing = faq.toObject();
  (faq as any).status = computeStatus(body, (faq as any).status);
  (faq as any).modified_by = toObjectId(user.id || user._id);
  await faq.save();
  await systemLog({
    operation: 'UPDATE',
    key: 'update-faq-status',
    data: faq.toObject(),
    existingData: existing,
    actorId: user.id || user._id,
  });
  return createResponse(httpStatus.OK, 'FAQ status updated successfully.', {
    faq,
  });
};

export const deleteFaq = async (user: any, faqId: string) => {
  if (!(user?.role === 'SUPER_ADMIN' || user?.is_super_admin)) {
    return createResponse(httpStatus.FORBIDDEN, 'Forbidden');
  }
  const faq = await Faq.findById(toObjectId(faqId));
  if (!faq || faq.status === 2) {
    return createResponse(httpStatus.NOT_FOUND, 'FAQ not found');
  }
  const existing = faq.toObject();
  faq.status = 2;
  (faq as any).modified_by = toObjectId(user.id || user._id);
  await faq.save();
  await systemLog({
    operation: 'DELETE',
    key: 'delete-faq',
    data: existing,
    actorId: user.id || user._id,
  });
  return createResponse(httpStatus.OK, 'FAQ deleted successfully.');
};
