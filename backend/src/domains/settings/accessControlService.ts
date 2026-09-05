import type { Pool, PoolClient } from 'pg';
import { isPlatformSuperAdmin } from '../auth/authService';
import { AVAILABLE_MENUS, type MenuDefinition } from './rolePermissionsService';

export type AccessAction = 'view' | 'edit' | 'delete';
export type AccessEffect = 'ALLOW' | 'DENY';
export type AccessSource = 'PLATFORM_SUPER_ADMIN' | 'USER_OVERRIDE' | 'ROLE_DEFAULT' | 'DEFAULT_DENY';

export const ACCESS_ACTIONS: AccessAction[] = ['view', 'edit', 'delete'];

export const PLATFORM_SUPER_ADMIN_ROLE_NAME = 'Super Admin';

/**
 * Canonical View/Edit/Delete mapping.
 *
 * The navigation resource list is NOT redefined here: it is taken from
 * AVAILABLE_MENUS. This table only declares which already-existing atomic
 * `permissions.key` rows back each operator-facing action, so the permissions
 * table stays the single source of truth for what a grant means.
 *
 * VIEW   - read/open the resource
 * EDIT   - create/update normal operational records for the resource
 * DELETE - perform the resource's allowed delete/remove actions. This never
 *          implies platform hard-delete authority, which stays behind the
 *          canonical Platform Super Admin check.
 */
const RESOURCE_PERMISSION_KEYS: Record<string, Record<AccessAction, string[]>> = {
  'Kalender': {
    view: ['reservations.view', 'rooms.view'],
    edit: ['reservations.create', 'reservations.edit'],
    delete: ['reservations.delete'],
  },
  'Transaksi': {
    view: ['folios.view'],
    edit: ['folios.create', 'folios.edit'],
    delete: ['folios.delete'],
  },
  'Pelanggan': {
    view: ['guests.view'],
    edit: ['guests.create', 'guests.edit'],
    delete: ['guests.delete'],
  },
  'Housekeeping': {
    view: ['housekeeping.view'],
    edit: ['housekeeping.create', 'housekeeping.edit'],
    delete: ['housekeeping.delete'],
  },
  'HRD': {
    view: ['hrd.employees.view'],
    edit: ['hrd.employees.create', 'hrd.employees.edit'],
    delete: ['hrd.employees.delete'],
  },
  'POS': {
    view: ['pos.view'],
    edit: ['pos.create', 'pos.edit'],
    delete: ['pos.delete'],
  },
  'Master Kamar': {
    view: ['rooms.view'],
    edit: ['rooms.create', 'rooms.edit'],
    delete: ['rooms.delete'],
  },
  'Master Produk': {
    view: ['inventory.view'],
    edit: ['inventory.create', 'inventory.edit'],
    delete: ['inventory.delete'],
  },
  'Laporan': {
    view: ['reports.view'],
    edit: ['reports.create', 'reports.edit'],
    delete: ['reports.delete'],
  },
  'Employee Mobile': {
    view: ['employee_mobile.view'],
    edit: ['employee_mobile.create', 'employee_mobile.edit'],
    delete: ['employee_mobile.delete'],
  },
  'Pengaturan': {
    view: ['settings.view'],
    edit: ['settings.create', 'settings.edit'],
    delete: ['settings.delete'],
  },
};

export interface AccessResourceDefinition extends MenuDefinition {
  permission_keys: Record<AccessAction, string[]>;
}

export const ACCESS_RESOURCES: AccessResourceDefinition[] = AVAILABLE_MENUS.map(menu => {
  const permissionKeys = RESOURCE_PERMISSION_KEYS[menu.key];
  if (!permissionKeys) {
    throw new Error(`Navigasi '${menu.key}' belum memiliki pemetaan hak akses View/Edit/Delete.`);
  }
  return { ...menu, permission_keys: permissionKeys };
});

const ACCESS_RESOURCE_BY_KEY = new Map(ACCESS_RESOURCES.map(resource => [resource.key, resource]));

export function isKnownAccessResource(resource: string): boolean {
  return ACCESS_RESOURCE_BY_KEY.has(resource);
}

export function getPermissionKeysFor(resource: string, action: AccessAction): string[] {
  return ACCESS_RESOURCE_BY_KEY.get(resource)?.permission_keys[action] || [];
}

export type AccessGrid = Record<string, Record<AccessAction, boolean>>;
export type EffectiveAccessGrid = Record<string, Record<AccessAction, { allowed: boolean; source: AccessSource }>>;

function emptyGrid(value: boolean): AccessGrid {
  const grid: AccessGrid = {};
  for (const resource of ACCESS_RESOURCES) {
    grid[resource.key] = { view: value, edit: value, delete: value };
  }
  return grid;
}

function badRequest(message: string, code: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

/**
 * Resolves which View/Edit/Delete cells a role grants, by checking the atomic
 * permission keys the role actually holds. A cell is granted when the role
 * holds ANY of the mapped keys for that action.
 */
async function getRoleAccessGrid(client: Pool | PoolClient, roleId: number): Promise<AccessGrid> {
  const granted = await client.query(
    `SELECT p.key
     FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = $1 AND rp.granted = TRUE`,
    [roleId]
  );
  const grantedKeys = new Set<string>(granted.rows.map((row: any) => row.key));

  const grid = emptyGrid(false);
  for (const resource of ACCESS_RESOURCES) {
    for (const action of ACCESS_ACTIONS) {
      grid[resource.key][action] = resource.permission_keys[action].some(key => grantedKeys.has(key));
    }
  }
  return grid;
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

/**
 * Property-scoped role list: the property's own roles plus platform system
 * roles, which are visible everywhere but protected from property edits.
 */
export async function getRoleAccessMatrix(
  client: Pool | PoolClient,
  propertyId: number
): Promise<{ property_id: number; resources: AccessResourceDefinition[]; roles: AccessRoleSummary[] }> {
  const rolesRes = await client.query(
    `SELECT id, name, description, property_id, is_system_role, is_active
     FROM roles
     WHERE property_id = $1 OR property_id IS NULL
     ORDER BY (property_id IS NULL) DESC, name ASC`,
    [propertyId]
  );

  const roles: AccessRoleSummary[] = [];
  for (const row of rolesRes.rows) {
    const isPlatformRole = row.property_id === null && row.is_system_role === true;
    const isPlatformSuperAdminRole =
      isPlatformRole && String(row.name || '').trim().toLowerCase() === PLATFORM_SUPER_ADMIN_ROLE_NAME.toLowerCase();

    roles.push({
      id: Number(row.id),
      name: row.name,
      description: row.description ?? null,
      property_id: row.property_id === null ? null : Number(row.property_id),
      is_system_role: row.is_system_role === true,
      is_active: row.is_active === true,
      is_platform_super_admin: isPlatformSuperAdminRole,
      is_protected: isPlatformSuperAdminRole,
      // The canonical Platform Super Admin role always resolves to full access
      // and is never stored as an editable grid.
      access: isPlatformSuperAdminRole ? emptyGrid(true) : await getRoleAccessGrid(client, Number(row.id)),
    });
  }

  return { property_id: propertyId, resources: ACCESS_RESOURCES, roles };
}

async function writeAuditLog(
  client: Pool | PoolClient,
  propertyId: number,
  action: string,
  entity: string,
  recordId: string | number,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ('ACCESS_CONTROL', $1, $2, $3, $4, $5, $6)`,
      [action, entity, String(recordId), JSON.stringify(payload), `ACL-${Date.now()}`, propertyId]
    );
  } catch (err: any) {
    console.warn('Access control audit log warning:', err.message);
  }
}

export interface AccessActor {
  id: number;
  name: string;
  property_id: number;
  is_platform_super_admin: boolean;
}

/**
 * Replaces a role's View/Edit/Delete grid by translating it back into the
 * canonical atomic permission keys. Property isolation and Platform Super
 * Admin protection are enforced here, not in the router.
 */
export async function setRoleAccess(
  client: PoolClient,
  propertyId: number,
  roleId: number,
  requestedAccess: AccessGrid,
  actor: AccessActor
): Promise<AccessRoleSummary> {
  const roleRes = await client.query(
    `SELECT id, name, description, property_id, is_system_role, is_active
     FROM roles WHERE id = $1 FOR UPDATE`,
    [roleId]
  );
  if (roleRes.rows.length === 0) {
    throw badRequest('Role tidak ditemukan.', 'ROLE_NOT_FOUND', 404);
  }
  const role = roleRes.rows[0];

  const isPlatformRole = role.property_id === null && role.is_system_role === true;
  const isPlatformSuperAdminRole =
    isPlatformRole && String(role.name || '').trim().toLowerCase() === PLATFORM_SUPER_ADMIN_ROLE_NAME.toLowerCase();

  if (isPlatformSuperAdminRole) {
    throw badRequest(
      'Hak akses Platform Super Admin tidak dapat diubah.',
      'CANNOT_ALTER_SUPER_ADMIN_PERMISSIONS',
      403
    );
  }

  if (role.property_id !== null && Number(role.property_id) !== propertyId) {
    throw badRequest(
      'Role milik properti lain tidak dapat diubah.',
      'CROSS_PROPERTY_ROLE_FORBIDDEN',
      403
    );
  }

  // Platform system roles are shared across properties, so only a canonical
  // Platform Super Admin may reshape them.
  if (isPlatformRole && !actor.is_platform_super_admin) {
    throw badRequest(
      'Hanya Platform Super Admin yang dapat mengubah role sistem platform.',
      'PLATFORM_ROLE_FORBIDDEN',
      403
    );
  }

  const permissionRows = await client.query('SELECT id, key FROM permissions');
  const permissionIdByKey = new Map<string, number>(
    permissionRows.rows.map((row: any) => [row.key, Number(row.id)])
  );

  const grantKeys = new Set<string>();
  const revokeKeys = new Set<string>();

  for (const resource of ACCESS_RESOURCES) {
    const requested = requestedAccess[resource.key];
    for (const action of ACCESS_ACTIONS) {
      const shouldGrant = requested ? requested[action] === true : false;
      for (const key of resource.permission_keys[action]) {
        if (shouldGrant) grantKeys.add(key);
        else revokeKeys.add(key);
      }
    }
  }

  // A key shared by two granted cells must never be revoked by the other cell.
  for (const key of grantKeys) revokeKeys.delete(key);

  for (const key of grantKeys) {
    const permissionId = permissionIdByKey.get(key);
    if (!permissionId) continue;
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
       VALUES ($1, $2, TRUE, $3)
       ON CONFLICT (role_id, permission_id) DO UPDATE SET granted = TRUE`,
      [roleId, permissionId, actor.name]
    );
  }

  const revokeIds = [...revokeKeys]
    .map(key => permissionIdByKey.get(key))
    .filter((id): id is number => typeof id === 'number');
  if (revokeIds.length > 0) {
    await client.query(
      'DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = ANY($2::int[])',
      [roleId, revokeIds]
    );
  }

  await writeAuditLog(client, propertyId, 'ROLE_ACCESS_UPDATED', 'role_permissions', roleId, {
    role_id: roleId,
    role_name: role.name,
    actor_user_id: actor.id,
    actor_name: actor.name,
    granted_keys: [...grantKeys].sort(),
  });

  const refreshed = await getRoleAccessMatrix(client, propertyId);
  const updated = refreshed.roles.find(item => item.id === roleId);
  if (!updated) {
    throw badRequest('Role tidak ditemukan setelah pembaruan.', 'ROLE_NOT_FOUND', 404);
  }
  return updated;
}

export interface UserOverrideRecord {
  resource: string;
  action: AccessAction;
  effect: AccessEffect;
  reason: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
}

export interface EffectiveAccessResult {
  user_id: number;
  property_id: number;
  full_name: string;
  username: string;
  role_id: number | null;
  role_name: string | null;
  is_platform_super_admin: boolean;
  resources: AccessResourceDefinition[];
  role_access: AccessGrid;
  overrides: UserOverrideRecord[];
  effective: EffectiveAccessGrid;
}

async function loadPropertyUser(
  client: Pool | PoolClient,
  propertyId: number,
  userId: number
): Promise<any> {
  const res = await client.query(
    `SELECT u.id, u.property_id, u.username, u.full_name, u.is_active,
            r.id AS role_id, r.name AS role_name, r.is_active AS role_is_active,
            r.is_system_role, r.property_id AS role_property_id
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [userId]
  );
  if (res.rows.length === 0) {
    throw badRequest('Pengguna tidak ditemukan.', 'USER_NOT_FOUND', 404);
  }
  const user = res.rows[0];
  if (Number(user.property_id) !== propertyId) {
    throw badRequest(
      'Pengguna milik properti lain tidak dapat diakses.',
      'CROSS_PROPERTY_USER_FORBIDDEN',
      403
    );
  }
  return user;
}

/**
 * Canonical effective-permission resolver.
 *
 * Priority: Platform Super Admin > explicit user override > role default > deny.
 * Every consumer (API enforcement, dashboard nav, mobile nav) must resolve
 * through this function so there is exactly one permission truth.
 */
export async function resolveEffectiveAccess(
  client: Pool | PoolClient,
  propertyId: number,
  userId: number
): Promise<EffectiveAccessResult> {
  const user = await loadPropertyUser(client, propertyId, userId);
  const platformSuperAdmin = await isPlatformSuperAdmin(client, userId);

  const roleAccess = user.role_id && user.role_is_active === true
    ? await getRoleAccessGrid(client, Number(user.role_id))
    : emptyGrid(false);

  const overrideRes = await client.query(
    `SELECT resource, action, effect, reason, updated_at, updated_by_name
     FROM user_permission_overrides
     WHERE property_id = $1 AND user_id = $2`,
    [propertyId, userId]
  );
  const overrides: UserOverrideRecord[] = overrideRes.rows
    .filter((row: any) => isKnownAccessResource(row.resource))
    .map((row: any) => ({
      resource: row.resource,
      action: row.action as AccessAction,
      effect: row.effect as AccessEffect,
      reason: row.reason ?? null,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updated_by_name: row.updated_by_name ?? null,
    }));

  const overrideByCell = new Map<string, AccessEffect>();
  for (const override of overrides) {
    overrideByCell.set(`${override.resource}::${override.action}`, override.effect);
  }

  const effective: EffectiveAccessGrid = {};
  for (const resource of ACCESS_RESOURCES) {
    effective[resource.key] = {} as EffectiveAccessGrid[string];
    for (const action of ACCESS_ACTIONS) {
      if (platformSuperAdmin) {
        effective[resource.key][action] = { allowed: true, source: 'PLATFORM_SUPER_ADMIN' };
        continue;
      }
      const override = overrideByCell.get(`${resource.key}::${action}`);
      if (override) {
        effective[resource.key][action] = { allowed: override === 'ALLOW', source: 'USER_OVERRIDE' };
        continue;
      }
      if (roleAccess[resource.key][action]) {
        effective[resource.key][action] = { allowed: true, source: 'ROLE_DEFAULT' };
        continue;
      }
      effective[resource.key][action] = { allowed: false, source: 'DEFAULT_DENY' };
    }
  }

  return {
    user_id: Number(user.id),
    property_id: propertyId,
    full_name: user.full_name || user.username,
    username: user.username,
    role_id: user.role_id === null || user.role_id === undefined ? null : Number(user.role_id),
    role_name: user.role_name ?? null,
    is_platform_super_admin: platformSuperAdmin,
    resources: ACCESS_RESOURCES,
    role_access: platformSuperAdmin ? emptyGrid(true) : roleAccess,
    overrides,
    effective,
  };
}

export async function hasEffectivePermission(
  client: Pool | PoolClient,
  propertyId: number,
  userId: number,
  resource: string,
  action: AccessAction
): Promise<boolean> {
  if (await isPlatformSuperAdmin(client, userId)) return true;
  if (!isKnownAccessResource(resource)) return false;
  const resolved = await resolveEffectiveAccess(client, propertyId, userId);
  return resolved.effective[resource]?.[action]?.allowed === true;
}

export async function hasAnyEffectivePermission(
  client: Pool | PoolClient,
  propertyId: number,
  userId: number,
  resources: string[],
  action: AccessAction
): Promise<boolean> {
  if (await isPlatformSuperAdmin(client, userId)) return true;
  for (const resource of resources) {
    if (await hasEffectivePermission(client, propertyId, userId, resource, action)) {
      return true;
    }
  }
  return false;
}

export interface UserOverrideInput {
  resource: string;
  action: AccessAction;
  effect: AccessEffect | 'INHERIT';
  reason?: string | null;
}

export async function setUserOverrides(
  client: PoolClient,
  propertyId: number,
  userId: number,
  inputs: UserOverrideInput[],
  actor: AccessActor
): Promise<EffectiveAccessResult> {
  const user = await loadPropertyUser(client, propertyId, userId);

  // A canonical Platform Super Admin's authority is not expressible as a
  // property-scoped override, so storing one would be misleading.
  if (await isPlatformSuperAdmin(client, userId)) {
    throw badRequest(
      'Hak akses Platform Super Admin tidak dapat dibatasi melalui override pengguna.',
      'CANNOT_OVERRIDE_SUPER_ADMIN',
      403
    );
  }

  for (const input of inputs) {
    if (!isKnownAccessResource(input.resource)) {
      throw badRequest(`Resource '${input.resource}' tidak dikenal.`, 'UNKNOWN_ACCESS_RESOURCE', 422);
    }
    if (!ACCESS_ACTIONS.includes(input.action)) {
      throw badRequest(`Aksi '${input.action}' tidak valid.`, 'UNKNOWN_ACCESS_ACTION', 422);
    }
    if (input.effect !== 'ALLOW' && input.effect !== 'DENY' && input.effect !== 'INHERIT') {
      throw badRequest(`Nilai override '${input.effect}' tidak valid.`, 'UNKNOWN_ACCESS_EFFECT', 422);
    }

    if (input.effect === 'INHERIT') {
      await client.query(
        `DELETE FROM user_permission_overrides
         WHERE property_id = $1 AND user_id = $2 AND resource = $3 AND action = $4`,
        [propertyId, userId, input.resource, input.action]
      );
      continue;
    }

    await client.query(
      `INSERT INTO user_permission_overrides
         (property_id, user_id, resource, action, effect, reason,
          created_by_user_id, created_by_name, updated_by_user_id, updated_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7, $8)
       ON CONFLICT (property_id, user_id, resource, action)
       DO UPDATE SET effect = $5, reason = $6, updated_at = NOW(),
                     updated_by_user_id = $7, updated_by_name = $8`,
      [propertyId, userId, input.resource, input.action, input.effect, input.reason ?? null, actor.id, actor.name]
    );
  }

  await writeAuditLog(client, propertyId, 'USER_OVERRIDE_CHANGED', 'user_permission_overrides', userId, {
    target_user_id: userId,
    target_username: user.username,
    actor_user_id: actor.id,
    actor_name: actor.name,
    changes: inputs,
  });

  return resolveEffectiveAccess(client, propertyId, userId);
}

export async function resetUserOverrides(
  client: PoolClient,
  propertyId: number,
  userId: number,
  actor: AccessActor
): Promise<EffectiveAccessResult> {
  const user = await loadPropertyUser(client, propertyId, userId);

  const removed = await client.query(
    'DELETE FROM user_permission_overrides WHERE property_id = $1 AND user_id = $2',
    [propertyId, userId]
  );

  await writeAuditLog(client, propertyId, 'USER_OVERRIDE_RESET', 'user_permission_overrides', userId, {
    target_user_id: userId,
    target_username: user.username,
    actor_user_id: actor.id,
    actor_name: actor.name,
    removed_count: removed.rowCount ?? 0,
  });

  return resolveEffectiveAccess(client, propertyId, userId);
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

export async function listAccessUsers(
  client: Pool | PoolClient,
  propertyId: number
): Promise<AccessUserSummary[]> {
  const res = await client.query(
    `SELECT u.id, u.username, u.full_name, u.is_active, u.employee_id,
            e.full_name AS employee_name,
            r.id AS role_id, r.name AS role_name,
            r.is_system_role, r.property_id AS role_property_id,
            (SELECT COUNT(*) FROM user_permission_overrides o
              WHERE o.property_id = u.property_id AND o.user_id = u.id) AS override_count
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     LEFT JOIN hr_employees e ON e.id = u.employee_id
     WHERE u.property_id = $1
     ORDER BY u.full_name ASC, u.username ASC`,
    [propertyId]
  );

  return res.rows.map((row: any) => ({
    user_id: Number(row.id),
    username: row.username,
    full_name: row.full_name || row.username,
    employee_id: row.employee_id === null || row.employee_id === undefined ? null : Number(row.employee_id),
    employee_name: row.employee_name ?? null,
    role_id: row.role_id === null || row.role_id === undefined ? null : Number(row.role_id),
    role_name: row.role_name ?? null,
    is_active: row.is_active === true,
    is_platform_super_admin:
      row.role_property_id === null &&
      row.is_system_role === true &&
      String(row.role_name || '').trim().toLowerCase() === PLATFORM_SUPER_ADMIN_ROLE_NAME.toLowerCase(),
    override_count: Number(row.override_count || 0),
  }));
}
