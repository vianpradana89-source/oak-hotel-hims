import type { MainNavKey } from '../shell/shellTypes';

export type AccessAction = 'view' | 'edit' | 'delete';
export type AccessEffect = 'ALLOW' | 'DENY';
export type OverrideChoice = 'INHERIT' | AccessEffect;
export type AccessSource = 'PLATFORM_SUPER_ADMIN' | 'USER_OVERRIDE' | 'ROLE_DEFAULT' | 'DEFAULT_DENY';

export const ACCESS_ACTIONS: AccessAction[] = ['view', 'edit', 'delete'];

export const ACCESS_ACTION_LABELS: Record<AccessAction, string> = {
  view: 'View',
  edit: 'Edit',
  delete: 'Delete',
};

export interface AccessResource {
  key: string;
  label: string;
  group: string;
  description: string;
  permission_keys: Record<AccessAction, string[]>;
}

export type AccessGrid = Record<string, Record<AccessAction, boolean>>;

export interface EffectiveCell {
  allowed: boolean;
  source: AccessSource;
}

export type EffectiveAccessGrid = Record<string, Record<AccessAction, EffectiveCell>>;

export interface UserOverrideRecord {
  resource: string;
  action: AccessAction;
  effect: AccessEffect;
  reason: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
}

export interface EffectiveAccessResponse {
  user_id: number;
  property_id: number;
  full_name: string;
  username: string;
  role_id: number | null;
  role_name: string | null;
  is_platform_super_admin: boolean;
  resources: AccessResource[];
  role_access: AccessGrid;
  overrides: UserOverrideRecord[];
  effective: EffectiveAccessGrid;
}

export interface AccessRoleSummary {
  id: number;
  name: string;
  description: string | null;
  property_id: number | null;
  is_system_role: boolean;
  is_active: boolean;
  is_platform_super_admin: boolean;
  is_protected: boolean;
  access: AccessGrid;
}

export interface AccessUserSummary {
  user_id: number;
  username: string;
  full_name: string;
  employee_id: number | null;
  employee_name: string | null;
  role_id: number | null;
  role_name: string | null;
  is_active: boolean;
  is_platform_super_admin: boolean;
  override_count: number;
}

/**
 * Mirrors the backend resolver precedence:
 * Platform Super Admin > explicit user override > role default > deny.
 *
 * The UI never invents its own permission logic; this keeps the rendered state
 * identical to what the API will enforce.
 */
export function resolveEffectiveCell(options: {
  isPlatformSuperAdmin: boolean;
  roleAllowed: boolean;
  override?: OverrideChoice | null;
}): EffectiveCell {
  if (options.isPlatformSuperAdmin) {
    return { allowed: true, source: 'PLATFORM_SUPER_ADMIN' };
  }
  if (options.override === 'ALLOW' || options.override === 'DENY') {
    return { allowed: options.override === 'ALLOW', source: 'USER_OVERRIDE' };
  }
  if (options.roleAllowed) {
    return { allowed: true, source: 'ROLE_DEFAULT' };
  }
  return { allowed: false, source: 'DEFAULT_DENY' };
}

export function buildOverrideLookup(overrides: UserOverrideRecord[]): Record<string, AccessEffect> {
  const lookup: Record<string, AccessEffect> = {};
  for (const override of overrides) {
    lookup[`${override.resource}::${override.action}`] = override.effect;
  }
  return lookup;
}

export function getOverrideChoice(
  lookup: Record<string, AccessEffect>,
  resource: string,
  action: AccessAction
): OverrideChoice {
  return lookup[`${resource}::${action}`] || 'INHERIT';
}

/**
 * Navigation visibility derived from the same effective grid used for API
 * enforcement: a menu is shown when its VIEW permission resolves to allowed.
 */
export function getVisibleNavKeys(effective: EffectiveAccessGrid): MainNavKey[] {
  return Object.keys(effective).filter(
    resource => effective[resource]?.view?.allowed === true
  ) as MainNavKey[];
}

export function isNavAllowed(effective: EffectiveAccessGrid | null | undefined, menuKey: MainNavKey): boolean {
  if (!effective) return false;
  return effective[menuKey]?.view?.allowed === true;
}

export function getDefaultNavKey(
  effective: EffectiveAccessGrid | null | undefined,
  fallback: MainNavKey = 'Kalender'
): MainNavKey {
  const visible = effective ? getVisibleNavKeys(effective) : [];
  return visible[0] || fallback;
}

export function groupResources(resources: AccessResource[]): { group: string; resources: AccessResource[] }[] {
  const grouped: { group: string; resources: AccessResource[] }[] = [];
  for (const resource of resources) {
    let bucket = grouped.find(item => item.group === resource.group);
    if (!bucket) {
      bucket = { group: resource.group, resources: [] };
      grouped.push(bucket);
    }
    bucket.resources.push(resource);
  }
  return grouped;
}

export function countOverrides(overrides: UserOverrideRecord[]): { allow: number; deny: number } {
  let allow = 0;
  let deny = 0;
  for (const override of overrides) {
    if (override.effect === 'ALLOW') allow += 1;
    else if (override.effect === 'DENY') deny += 1;
  }
  return { allow, deny };
}

export const ACCESS_SOURCE_LABELS: Record<AccessSource, string> = {
  PLATFORM_SUPER_ADMIN: 'Platform Super Admin',
  USER_OVERRIDE: 'Override pengguna',
  ROLE_DEFAULT: 'Default role',
  DEFAULT_DENY: 'Ditolak default',
};
