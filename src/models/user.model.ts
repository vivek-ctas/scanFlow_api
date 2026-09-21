import mongoose, {
  Document,
  Schema,
  Model,
  Query,
  CallbackWithoutResultAndOptionalError,
} from 'mongoose';
import validator from 'validator';
import bcrypt from 'bcryptjs';
import { roles } from '../config/roles.js';
import { toJSON } from './plugins/toJSON.plugin.js';
import { paginate } from './plugins/paginate.plugin.js';

export interface IUser extends Document {
  first_name: string;
  last_name: string;
  email: string;
  contact_no?: string;
  password?: string;
  role: string;
  isSuperAdmin: boolean;
  is_seller_user: boolean;
  seller_id?: mongoose.Types.ObjectId | null;
  isEmailVerified: boolean;
  status: number;
  created_by?: mongoose.Types.ObjectId | null;
  modified_by?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  isPasswordMatch(password: string): Promise<boolean>;
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
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      validate: {
        validator: (value: string) => validator.isEmail(value),
        message: 'Invalid email',
      },
    },
    contact_no: { type: String, trim: true },
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
    role: { type: String, enum: roles, default: 'SELLER_USER' },
    isSuperAdmin: { type: Boolean, default: false },
    is_seller_user: { type: Boolean, default: false },
    seller_id: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    isEmailVerified: { type: Boolean, default: false },
    status: { type: Number, default: 1 },
    created_by: { type: Schema.Types.ObjectId, default: null },
    modified_by: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });

userSchema.plugin(toJSON);
userSchema.plugin(paginate);

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

// Use any for middleware to avoid Mongoose 8 type issues
(userSchema as any).pre(
  'save',
  async function (this: IUser, next: CallbackWithoutResultAndOptionalError) {
    const user = this;
    if (user.isModified('password') && user.get('password')) {
      user.set('password', bcrypt.hashSync(user.get('password') as string, 8));
    }
    next();
  },
);

(userSchema as any).pre(
  'findOneAndUpdate',
  async function (
    this: Query<any, IUser>,
    next: CallbackWithoutResultAndOptionalError,
  ) {
    const update = this.getUpdate() as Record<string, any>;
    if (update && update.password) {
      this.setUpdate({
        ...update,
        password: bcrypt.hashSync(update.password, 8),
      });
    }
    next();
  },
);

export const User = mongoose.model<IUser, IUserModel>('User', userSchema);
