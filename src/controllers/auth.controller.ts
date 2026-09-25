import httpStatus from 'http-status';
import { catchAsync } from '../utils/catchAsync.js';
import * as authService from '../services/auth.service.js';
import { Request, Response } from 'express';

export const sendOtp = catchAsync(async (req: Request, res: Response) => {
  const result = await authService.sendOtp(req.body.email);
  res.status(result.status).json(result);
});

export const verifyOtp = catchAsync(async (req: Request, res: Response) => {
  const { email, otp } = req.body;
  const result = await authService.verifyOtpAndLogin(email, otp);
  res.status(result.status).json(result);
});

export const refreshTokens = catchAsync(async (req: Request, res: Response) => {
  const result = await authService.refreshAuth(req.body.refreshToken);
  res.status(result.status).json(result);
});

export const logout = catchAsync(async (req: Request, res: Response) => {
  const result = await authService.logout(req.body.refreshToken);
  res.status(result.status).json(result);
});

export const getMe = catchAsync(async (req: Request, res: Response) => {
  res.status(httpStatus.OK).json({
    status: httpStatus.OK,
    message: 'User profile fetched successfully.',
    data: { user: req.user },
  });
});
