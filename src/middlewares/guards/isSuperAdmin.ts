import { SUPER_ADMIN_ROLE } from '../../config/roles.js';

export const isSuperAdmin = (reqUser: any) =>
  Boolean(
    reqUser &&
    (reqUser.is_super_admin === true || reqUser.role === SUPER_ADMIN_ROLE),
  );
