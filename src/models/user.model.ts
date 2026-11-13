import mongoose, { Document, Schema, Model, Query } from 'mongoose';
import validator from 'validator';
import bcrypt from 'bcryptjs';
import { roles } from '../config/roles.js';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export interface IUser extends Document {
  first_name: string;
  last_name: string;
  email?: string | null;
  contact_number?: string;
  country_name?: string;
  company_name?: string;
  password?: string;
  business_address?: string;
  role: string;
  is_super_admin: boolean;
  organization_id?: mongoose.Types.ObjectId | null;
  is_email_verified: boolean;
  status: number;
  avatar?: string;
  operator_id?: string;
  pin_hash?: string;
  pin_attempt_count: number;
  pin_locked_until?: Date | null;
  created_by?: mongoose.Types.ObjectId | null;
  modified_by?: mongoose.Types.ObjectId | null;
  created_at: Date;
  updated_at: Date;
  isPasswordMatch(password: string): Promise<boolean>;
  isPinMatch(pin: string): Promise<boolean>;
}

interface IUserModel extends Model<IUser> {
  isEmailTaken(
    email: string,
    excludeUserId?: mongoose.Types.ObjectId,
  ): Promise<boolean>;
  paginate: (
    filter: Record<string, any>,
    options: Record<string, any>,
  ) => Promise<any>;
}

const userSchema = new Schema<IUser, IUserModel>(
  {
    first_name: { type: String, required: true, trim: true },
    last_name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: function (this: IUser) {
        return this.role !== 'OPERATOR';
      },
      trim: true,
      lowercase: true,
      validate: {
        validator: (value: string) => validator.isEmail(value),
        message: 'Invalid email',
      },
    },
    contact_number: { type: String, trim: true },
    country_name: { type: String, trim: true },
    company_name: { type: String, trim: true },
    business_address: { type: String, trim: true },
    password: {
      type: String,
      trim: true,
      minlength: 8,
      select: false,
      private: true,
      validate: {
        validator: (value: string) =>
          !!value.match(/\d/) && !!value.match(/[a-zA-Z]/),
        message: 'Password must contain at least one letter and one number',
      },
    },
    operator_id: { type: String, trim: true, uppercase: true },
    pin_hash: { type: String, private: true },
    pin_attempt_count: { type: Number, default: 0, private: true },
    pin_locked_until: { type: Date, default: null, private: true },
    role: { type: String, enum: roles, default: 'OPERATOR' },
    is_super_admin: { type: Boolean, default: false },
    organization_id: {
      type: Schema.Types.ObjectId,
      ref: 'tbl_organization',
      default: null,
    },
    is_email_verified: { type: Boolean, default: false },
    status: { type: Number, default: 1 },
    avatar: { type: String, trim: true },
    created_by: { type: Schema.Types.ObjectId, default: null },
    modified_by: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

userSchema.plugin(toJSON);
userSchema.plugin(paginate);

userSchema.index({ email: 1 }, { unique: true, sparse: true });
userSchema.index({ operator_id: 1 }, { unique: true, sparse: true });

userSchema.statics.isEmailTaken = async function (
  email: string,
  excludeUserId?: mongoose.Types.ObjectId,
): Promise<boolean> {
  const user = await this.findOne({ email, _id: { $ne: excludeUserId } });
  return !!user;
};

userSchema.methods.isPasswordMatch = async function (
  password: string,
): Promise<boolean> {
  return bcrypt.compare(password, this.get('password') as string);
};

userSchema.methods.isPinMatch = async function (pin: string): Promise<boolean> {
  const hash = this.get('pin_hash');
  if (!hash) return false;
  return bcrypt.compare(pin, hash as string);
};

// Use any for middleware to avoid Mongoose 8 type issues
(userSchema as any).pre('save', async function (this: IUser) {
  if (this.isModified('password') && this.get('password')) {
    this.set('password', bcrypt.hashSync(this.get('password') as string, 8));
  }
  if (this.isModified('pin_hash') && this.get('pin_hash')) {
    this.set('pin_hash', bcrypt.hashSync(this.get('pin_hash') as string, 8));
  }
});

(userSchema as any).pre(
  'findOneAndUpdate',
  async function (this: Query<any, IUser>) {
    const update = this.getUpdate() as Record<string, any>;
    if (update && update.password) {
      this.setUpdate({
        ...update,
        password: bcrypt.hashSync(update.password, 8),
      });
    }
  },
);

export const User = mongoose.model<IUser, IUserModel>('tbl_user', userSchema);
