import httpStatus from 'http-status';
import { catchAsync } from '../utils/catchAsync.js';
import * as authService from '../services/auth.service.js';
import * as profileService from '../services/user/profile.service.js';
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

export const loginWithPin = catchAsync(async (req: Request, res: Response) => {
  const { operator_id, pin } = req.body;
  const result = await authService.loginWithPin(operator_id, pin);
  res.status(result.status).json(result);
});

export const refreshTokens = catchAsync(async (req: Request, res: Response) => {
  const result = await authService.refreshAuth(req.body.refresh_token);
  res.status(result.status).json(result);
});

export const logout = catchAsync(async (req: Request, res: Response) => {
  const result = await authService.logout(req.body.refresh_token);
  res.status(result.status).json(result);
});

export const getMe = catchAsync(async (req: Request, res: Response) => {
  res.status(httpStatus.OK).json({
    status: httpStatus.OK,
    message: 'User profile fetched successfully.',
    data: { user: req.user },
  });
});

export const updateMe = catchAsync(async (req: Request, res: Response) => {
  const result = await profileService.updateOwnProfile(
    String((req.user as any)._id),
    req.body,
  );
  res.status(result.status).json(result);
});
