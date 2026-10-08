import httpStatus from 'http-status';
import { User } from '../../models/user.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { createResponse } from '../common.service.js';
import { resolveCountryName } from '../country-resolver.service.js';

/**
 * Fields a user may edit on their own profile. Email, role, status and
 * organization are deliberately excluded so a profile write can never escalate
 * privileges or reassign ownership.
 */
const PROFILE_UPDATE_KEYS = [
  'first_name',
  'last_name',
  'contact_number',
  'business_address',
  'company_name',
];

export const updateOwnProfile = async (
  userId: string,
  updateBody: Record<string, any>,
) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  PROFILE_UPDATE_KEYS.forEach((key) => {
    if (updateBody[key] === undefined) return;
    const value = updateBody[key];
    (user as any)[key] = value === null || value === '' ? undefined : value;
  });

  if (updateBody.country_name !== undefined) {
    const raw = String(updateBody.country_name ?? '').trim();
    if (raw) {
      // Canonicalise against the country API rows; an unrecognised value keeps
      // the existing `country_name` untouched (mirrors the org write path).
      const canonical = await resolveCountryName(raw);
      if (canonical) {
        user.country_name = canonical;
      }
    } else {
      user.country_name = undefined;
    }
  }

  user.modified_by = userId as any;
  await user.save();

  return createResponse(httpStatus.OK, 'Profile updated successfully.', {
    user,
  });
};
