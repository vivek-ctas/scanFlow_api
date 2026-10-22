import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import * as faqService from '../services/support-faq.service.js';

export const listFaqs = catchAsync(async (req: Request, res: Response) => {
  const result = await faqService.listFaqs(req.user);
  res.status(result.status).json(result);
});

export const manageFaqs = catchAsync(async (req: Request, res: Response) => {
  const result = await faqService.manageFaqs(req.user, req.query, req.query);
  res.status(result.status).json(result);
});

export const createFaq = catchAsync(async (req: Request, res: Response) => {
  const result = await faqService.createFaq(req.user, req.body);
  res.status(result.status).json(result);
});

export const updateFaq = catchAsync(async (req: Request, res: Response) => {
  const result = await faqService.updateFaq(
    req.user,
    String(req.params.faqId),
    req.body,
  );
  res.status(result.status).json(result);
});

export const updateFaqStatus = catchAsync(
  async (req: Request, res: Response) => {
    const result = await faqService.updateFaqStatus(
      req.user,
      String(req.params.faqId),
      req.body,
    );
    res.status(result.status).json(result);
  },
);

export const deleteFaq = catchAsync(async (req: Request, res: Response) => {
  const result = await faqService.deleteFaq(req.user, String(req.params.faqId));
  res.status(result.status).json(result);
});
