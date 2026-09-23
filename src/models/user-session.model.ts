import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';
import { toJSON } from './plugins/toJSON.plugin.js';

export interface IUserSession extends Document {
  email: string;
  hash_otp: string;
  expired_at: Date;
  createdAt: Date;
  updatedAt: Date;
  isOtpMatch(otp: string): Promise<boolean>;
}

const userSessionSchema = new Schema<IUserSession>(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    hash_otp: {
      type: String,
      required: true,
    },
    expired_at: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

userSessionSchema.index({ expired_at: 1 }, { expireAfterSeconds: 0 });

userSessionSchema.methods.isOtpMatch = async function (
  otp: string,
): Promise<boolean> {
  return bcrypt.compare(String(otp), this.hash_otp);
};

userSessionSchema.plugin(toJSON);

export const UserSession = mongoose.model<IUserSession>(
  'tbl_userSession',
  userSessionSchema,
);
