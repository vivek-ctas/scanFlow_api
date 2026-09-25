import { SUPER_ADMIN_ROLE } from '../../config/roles.js';

export const isSuperAdmin = (reqUser: any) =>
  Boolean(
    reqUser &&
    (reqUser.isSuperAdmin === true || reqUser.role === SUPER_ADMIN_ROLE),
  );
