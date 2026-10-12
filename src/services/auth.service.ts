import httpStatus from 'http-status';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import moment from 'moment';
import config from '../config/config.js';
import { User, UserSession, Token } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { tokenTypes } from '../config/tokens.js';
import { logger } from '../config/logger.js';
import { createResponse, normalizeEmail } from './common.service.js';
import * as tokenService from './token.service.js';
import * as emailService from './email.service.js';

const OTP_EXPIRY_MINUTES = 5;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MINUTES = 15;

const isBypassEnabled = () => config.env !== 'production';

const OPERATOR_LOGIN_HINT =
  'Operators must sign in with their Operator ID and PIN.';

export const sendOtp = async (email: string) => {
  const normalizedEmail = normalizeEmail(email);
  const user = await User.findOne({
    email: normalizedEmail,
    status: { $ne: 2 },
  });
  if (!user) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Email is not registered');
  }
  if (user.status === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Account is inactive');
  }
  if (user.role === 'OPERATOR') {
    throw new ApiError(httpStatus.BAD_REQUEST, OPERATOR_LOGIN_HINT);
  }

  if (
    isBypassEnabled() &&
    config.auth.bypassEmail &&
    normalizedEmail === normalizeEmail(config.auth.bypassEmail)
  ) {
    logger.info(
      `[BYPASS] OTP skipped for ${normalizedEmail} (dev bypass email)`,
    );
    return createResponse(
      httpStatus.OK,
      'OTP sent successfully to your registered email.',
    );
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  const hashOtp = await bcrypt.hash(otp, 8);
  const expiredAt = moment().add(OTP_EXPIRY_MINUTES, 'minutes').toDate();

  await UserSession.deleteMany({ email: normalizedEmail });
  await UserSession.create({
    email: normalizedEmail,
    hash_otp: hashOtp,
    expired_at: expiredAt,
  });

  const { delivered } = await emailService.sendOtpEmail(normalizedEmail, otp);
  if (delivered === 'failed') {
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'Failed to send OTP email. Please try again.',
    );
  }

  return createResponse(
    httpStatus.OK,
    'OTP sent successfully to your registered email.',
  );
};

export const verifyOtpAndLogin = async (email: string, otp: string) => {
  const normalizedEmail = normalizeEmail(email);

  if (
    isBypassEnabled() &&
    config.auth.bypassOtp &&
    otp === config.auth.bypassOtp &&
    (!config.auth.bypassEmail ||
      normalizedEmail === normalizeEmail(config.auth.bypassEmail))
  ) {
    logger.info(`[BYPASS] Login via bypass OTP for ${normalizedEmail}`);
  } else {
    const session = await UserSession.findOne({
      email: normalizedEmail,
    }).sort({ createdAt: -1 });
    if (!session) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'OTP not found. Please request a new OTP.',
      );
    }

    if (moment().isAfter(moment(session.expired_at))) {
      await UserSession.deleteMany({ email: normalizedEmail });
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'OTP expired. Please request a new OTP.',
      );
    }

    const isOtpValid = await session.isOtpMatch(otp);
    if (!isOtpValid) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid OTP.');
    }
    await UserSession.deleteMany({ email: normalizedEmail });
  }

  const user = await User.findOne({
    email: normalizedEmail,
    status: { $ne: 2 },
  });
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  if (user.status === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Account is inactive');
  }
  if (user.role === 'OPERATOR') {
    throw new ApiError(httpStatus.BAD_REQUEST, OPERATOR_LOGIN_HINT);
  }

  const tokens = await tokenService.generateAuthTokens(user);

  return createResponse(
    httpStatus.OK,
    'OTP verified and user logged in successfully.',
    {
      tokens,
      user,
    },
  );
};

export const loginWithPin = async (operatorId: string, pin: string) => {
  const normalizedId = String(operatorId ?? '')
    .trim()
    .toUpperCase();

  const user = await User.findOne({
    operator_id: normalizedId,
    status: { $ne: 2 },
  });

  // Dummy comparison so unknown ids cost the same as wrong pins
  // (anti-enumeration: attackers cannot tell if an Operator ID exists).
  if (!user) {
    await bcrypt.hash(String(pin ?? ''), 8);
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid Operator ID or PIN.');
  }
  if (user.status === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Account is inactive');
  }

  const now = Date.now();
  if (
    user.pin_locked_until &&
    now < new Date(user.pin_locked_until).getTime()
  ) {
    const minutes = Math.ceil(
      (new Date(user.pin_locked_until).getTime() - now) / 60000,
    );
    throw new ApiError(
      httpStatus.TOO_MANY_REQUESTS,
      `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    );
  }

  const isMatch = await user.isPinMatch(String(pin ?? ''));
  if (isMatch) {
    await User.updateOne(
      { _id: user._id },
      { $set: { pin_attempt_count: 0, pin_locked_until: null } },
    );
    const tokens = await tokenService.generateAuthTokens(user);
    return createResponse(httpStatus.OK, 'Operator logged in successfully.', {
      tokens,
      user,
    });
  }

  const updated = await User.findOneAndUpdate(
    { _id: user._id },
    { $inc: { pin_attempt_count: 1 } },
    { returnDocument: 'after' },
  );

  if ((updated?.pin_attempt_count ?? 0) >= PIN_MAX_ATTEMPTS) {
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          pin_locked_until: new Date(now + PIN_LOCKOUT_MINUTES * 60000),
          pin_attempt_count: 0,
        },
      },
    );
    throw new ApiError(
      httpStatus.TOO_MANY_REQUESTS,
      'Too many attempts. Operator ID locked for 15 minutes.',
    );
  }

  throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid Operator ID or PIN.');
};

export const refreshAuth = async (refreshToken: string) => {
  const refreshTokenDoc = await tokenService.verifyToken(
    refreshToken,
    tokenTypes.REFRESH,
  );
  const user = await User.findById(refreshTokenDoc.user);
  if (!user || user.status === 2) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'User not found');
  }

  await Token.deleteOne({ _id: refreshTokenDoc._id });
  const tokens = await tokenService.generateAuthTokens(user);

  return createResponse(httpStatus.OK, 'Tokens refreshed successfully.', {
    tokens,
    user,
  });
};

export const logout = async (refreshToken: string) => {
  const refreshTokenDoc = await Token.findOne({
    token: refreshToken,
    type: tokenTypes.REFRESH,
    blacklisted: false,
  });
  if (!refreshTokenDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Not found');
  }
  await refreshTokenDoc.deleteOne();

  return createResponse(httpStatus.OK, 'Logged out successfully.');
};
