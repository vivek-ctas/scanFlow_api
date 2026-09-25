import mongoose from 'mongoose';

export const createResponse = (
  statusCode: number,
  message: string,
  data?: any,
) => {
  if (data !== undefined) {
    return { status: statusCode, message, data };
  }
  return { status: statusCode, message };
};

export const normalizeEmail = (email: string) =>
  String(email || '')
    .trim()
    .toLowerCase();

export const toObjectId = (value: string | mongoose.Types.ObjectId) =>
  value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(value);

export const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const computeStatus = (
  body: { status?: number; action_type?: string },
  currentStatus: number,
) => {
  if (body.status !== undefined) {
    return Number(body.status);
  }
  if (body.action_type === 'activate') {
    return 1;
  }
  if (body.action_type === 'deactivate') {
    return 0;
  }
  return currentStatus === 1 ? 0 : 1;
};
