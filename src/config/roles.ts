export const allRoles = {
  SUPER_ADMIN: ['manageUsers', 'manageSubUsers'],
  USER_ADMIN: ['manageSubUsers'],
  USER: [],
};

export const roles = Object.keys(allRoles);

export const roleRights = new Map<string, string[]>(Object.entries(allRoles));
