import type { MainNavKey } from '../shell/shellTypes';

export type AccessAction =
  | 'view'
  | 'detail'
  | 'create'
  | 'edit'
  | 'delete'
  | 'export'
  | 'import'
  | 'approve';

export type AccessEffect = 'ALLOW' | 'DENY';
export type OverrideChoice = 'INHERIT' | AccessEffect;
export type AccessSource = 'PLATFORM_SUPER_ADMIN' | 'USER_OVERRIDE' | 'ROLE_DEFAULT' | 'DEFAULT_DENY';

export const ACCESS_ACTIONS: AccessAction[] = [
  'view',
  'detail',
  'create',
  'edit',
  'delete',
  'export',
  'import',
  'approve',
];

/** Standard table action columns */
export const TABLE_ACTIONS: AccessAction[] = [
  'view',
  'detail',
  'create',
  'edit',
  'delete',
  'export',
  'import',
];

export const ACCESS_ACTION_LABELS: Record<AccessAction, string> = {
  view: 'Lihat',
  detail: 'Detail',
  create: 'Tambah',
  edit: 'Ubah',
  delete: 'Hapus',
  export: 'Export',
  import: 'Import',
  approve: 'Approve',
};

/**
 * Declares which actions are applicable for each menu/module.
 * Unsupported actions will be rendered as disabled / dash (—).
 */
export const MODULE_SUPPORTED_ACTIONS: Record<string, AccessAction[]> = {
  Kalender: ['view', 'detail', 'create', 'edit', 'delete'],
  'Pemeriksaan Kamar Pre-Checkout': ['view', 'detail', 'create', 'edit'],
  'Dokumen & Print': ['view', 'detail', 'edit', 'export'],
  Transaksi: ['view', 'detail', 'create', 'edit', 'delete', 'export'],
  Pelanggan: ['view', 'detail', 'create', 'edit', 'delete', 'export', 'import'],
  Housekeeping: ['view', 'detail', 'create', 'edit', 'delete'],
  HRD: ['view', 'detail', 'create', 'edit', 'delete', 'export'],
  POS: ['view', 'detail', 'create', 'edit', 'delete', 'export'],
  'Daftar Purchase Order': ['view', 'detail', 'create', 'edit', 'delete', 'export'],
  Supplier: ['view', 'detail', 'create', 'edit', 'delete', 'export'],
  'Penerimaan Barang': ['view', 'detail', 'create', 'edit', 'delete', 'export'],
  'Produk & Inventori': ['view', 'detail', 'create', 'edit', 'delete', 'export', 'import'],
  'Master Produk': ['view', 'detail', 'create', 'edit', 'delete', 'export', 'import'],
  'Analisis Food Cost': ['view', 'detail', 'create', 'edit', 'delete', 'export'],
  'Master Kamar': ['view', 'detail', 'create', 'edit', 'delete', 'export'],
  Akuntansi: ['view', 'detail', 'create', 'edit', 'delete', 'export'],
  Laporan: ['view', 'detail', 'export'],
  'Employee Mobile': ['view', 'detail', 'create', 'edit'],
  Pengaturan: ['view', 'detail', 'create', 'edit', 'delete'],
  'Persetujuan PO': ['approve'],
  'Persetujuan Komplimentari': ['approve'],
};

/**
 * Toggles a user permission override between ALLOW and DENY,
 * returning to INHERIT whenever the new state matches the role default.
 */
export function toggleUserOverride(roleAllowed: boolean, currentChoice: OverrideChoice): OverrideChoice {
  const isCurrentlyAllowed = currentChoice === 'ALLOW' || (currentChoice === 'INHERIT' && roleAllowed);
  if (isCurrentlyAllowed) {
    return roleAllowed ? 'DENY' : 'INHERIT';
  } else {
    return roleAllowed ? 'INHERIT' : 'ALLOW';
  }
}

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
const NON_NAV_RESOURCE_KEYS = new Set([
  'Persetujuan PO',
  'Persetujuan Komplimentari',
  'Pemeriksaan Kamar Pre-Checkout',
]);

export function getVisibleNavKeys(effective: EffectiveAccessGrid): MainNavKey[] {
  return Object.keys(effective).filter(
    resource => !NON_NAV_RESOURCE_KEYS.has(resource) && effective[resource]?.view?.allowed === true
  ) as MainNavKey[];
}

export function isNavAllowed(effective: EffectiveAccessGrid | null | undefined, menuKey: MainNavKey): boolean {
  if (!effective) return false;
  if (effective[menuKey]?.view?.allowed !== undefined) {
    return effective[menuKey].view.allowed === true;
  }
  if (
    menuKey === 'Produk & Inventori' ||
    menuKey === 'Penerimaan Barang' ||
    menuKey === 'Analisis Food Cost'
  ) {
    return (
      effective['Master Produk']?.view?.allowed === true ||
      effective['Produk & Inventori']?.view?.allowed === true
    );
  }
  if (menuKey === 'Daftar Purchase Order' || menuKey === 'Supplier') {
    return (
      effective['Daftar Purchase Order']?.view?.allowed === true ||
      effective['Supplier']?.view?.allowed === true ||
      effective['Transaksi']?.view?.allowed === true ||
      effective['Master Produk']?.view?.allowed === true ||
      effective['Produk & Inventori']?.view?.allowed === true
    );
  }
  if (menuKey === 'Akuntansi') {
    return (
      effective['Akuntansi']?.view?.allowed === true ||
      effective['Laporan']?.view?.allowed === true ||
      effective['Transaksi']?.view?.allowed === true
    );
  }
  return false;
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
