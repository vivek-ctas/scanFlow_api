import jwt from 'jsonwebtoken';
import moment from 'moment';
import httpStatus from 'http-status';
import config from '../config/config.js';
import { tokenTypes } from '../config/tokens.js';
import { Token } from '../models/token.model.js';
import { ApiError } from '../utils/ApiError.js';

export const generateToken = (
  userId: string,
  expires: moment.Moment,
  type: string,
  secret = config.jwt.secret,
): string => {
  const payload = {
    sub: userId,
    iat: moment().unix(),
    exp: expires.unix(),
    type,
  };
  return jwt.sign(payload, secret);
};

export const saveToken = async (
  token: string,
  userId: string,
  expires: moment.Moment,
  type: string,
  blacklisted = false,
) => {
  const tokenDoc = await Token.create({
    token,
    user: userId,
    expires: expires.toDate(),
    type,
    blacklisted,
  });
  return tokenDoc;
};

export const verifyToken = async (token: string, type: string) => {
  let payload: { sub: string };
  try {
    payload = jwt.verify(token, config.jwt.secret) as { sub: string };
  } catch {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid token');
  }
  const tokenDoc = await Token.findOne({
    token,
    type,
    user: payload.sub,
    blacklisted: false,
  });
  if (!tokenDoc) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid token');
  }
  return tokenDoc;
};

export const generateAuthTokens = async (user: any) => {
  const accessTokenExpires = moment().add(
    config.jwt.accessExpirationMinutes,
    'minutes',
  );
  const accessToken = generateToken(
    user.id,
    accessTokenExpires,
    tokenTypes.ACCESS,
  );

  const refreshTokenExpires = moment().add(
    config.jwt.refreshExpirationDays,
    'days',
  );
  const refreshToken = generateToken(
    user.id,
    refreshTokenExpires,
    tokenTypes.REFRESH,
  );

  await saveToken(
    refreshToken,
    user.id,
    refreshTokenExpires,
    tokenTypes.REFRESH,
  );

  return {
    access: {
      token: accessToken,
      expires: accessTokenExpires.toDate(),
    },
    refresh: {
      token: refreshToken,
      expires: refreshTokenExpires.toDate(),
    },
  };
};
