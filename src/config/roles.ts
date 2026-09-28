export const allRoles = {
  SUPER_ADMIN: [
    'manageOrganizations',
    'viewOperators',
    'manageOperators',
    'manageScans',
    'manageWebhooks',
    'manageSubscriptions',
    'viewSubscription',
  ],
  ORGANIZATION_ADMIN: [
    'viewOperators',
    'manageOperators',
    'manageScans',
    'manageWebhooks',
    'viewSubscription',
  ],
  OPERATOR: ['manageScans'],
};

export const roles = Object.keys(allRoles);

export const roleRights = new Map<string, string[]>(Object.entries(allRoles));

export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
export const ORGANIZATION_ASSIGNABLE_ROLES = ['ORGANIZATION_ADMIN', 'OPERATOR'];
