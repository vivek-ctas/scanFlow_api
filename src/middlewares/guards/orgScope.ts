import httpStatus from 'http-status';
import mongoose from 'mongoose';
import { ApiError } from '../../utils/ApiError.js';
import { isSuperAdmin } from './isSuperAdmin.js';
import { toObjectId } from '../../services/common.service.js';

export interface OrgScopeOptions {
  required?: boolean;
}

export const resolveOrganizationScope = (
  reqUser: any,
  explicitOrgId?: any,
  options: OrgScopeOptions = {},
): mongoose.Types.ObjectId | null => {
  if (isSuperAdmin(reqUser)) {
    if (explicitOrgId) {
      return toObjectId(explicitOrgId);
    }
    if (options.required) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'organizationId is required');
    }
    return null;
  }
  if (!reqUser.organizationId) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'User is not scoped to an organization',
    );
  }
  return toObjectId(String(reqUser.organizationId));
};
