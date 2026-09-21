export const allRoles = {
  SUPER_ADMIN: ['manageUsers', 'manageRoles'],
  SELLER_ADMIN: ['manageUsers'],
  SELLER_USER: [],
};

export const roles = Object.keys(allRoles);

export const roleRights = new Map<string, string[]>(Object.entries(allRoles));
