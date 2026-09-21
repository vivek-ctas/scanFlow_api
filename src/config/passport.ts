import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import config from './config.js';
import { tokenTypes } from './tokens.js';
import { User, IUser } from '../models/user.model.js';
import { Model } from 'mongoose';

const jwtOptions = {
  secretOrKey: config.jwt.secret,
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  ignoreExpiration: false,
};

const jwtVerify = async (
  payload: { sub: string; type: string },
  done: (error: Error | null, user?: IUser | false) => void,
) => {
  try {
    if (payload.type !== tokenTypes.ACCESS) {
      throw new Error('Invalid token type');
    }
    const user = await (User as Model<IUser>).findById(payload.sub);
    if (!user) {
      return done(null, false);
    }
    return done(null, user);
  } catch (error) {
    return done(error as Error, false);
  }
};

export const jwtStrategy = new JwtStrategy(jwtOptions, jwtVerify);
