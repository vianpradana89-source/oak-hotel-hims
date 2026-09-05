import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { hashPassword } from '../auth/authService';
import {
  type HrEmployee,
  type HrdRolePolicySettings,
  type CreateEmployeePayload,
  type UpdateEmployeePayload,
  type RoleCategoryDef,
  type LoginAccountDiagnosis,
  type DiagnosisState,
  type CandidateUser,
  type AccountRepairActionPayload,
  type CreateEmployeeResult,
  type PasswordResetResult,
  type HrDepartment,
  type CreateDepartmentPayload,
  type UpdateDepartmentPayload,
  type HrPosition,
  type CreatePositionPayload,
  type UpdatePositionPayload,
  type DynamicRole,
  type CreateRolePayload,
  type UpdateRolePayload,
  type GranularPermission,
  type RolePermissionGrant,
  STANDARD_ROLE_CATEGORIES,
  PRIVILEGED_ROLE_CATEGORIES
} from './hrdTypes';

function hasRows(res: any): boolean {
  return Boolean(res && Array.isArray(res.rows) && res.rows.length > 0);
}

export function normalizeRoleName(role?: string | null): string {
  if (!role) return 'Crew';
  const r = role.trim();
  const lower = r.toLowerCase();
  if (lower === 'gm' || lower === 'general manager' || lower.includes('general manager')) {
    return 'General Manager';
  }
  if (lower === 'owner' || lower.includes('direksi')) {
    return 'Owner';
  }
  if (lower.includes('front office') || lower.includes('receptionist') || lower === 'fo') {
    return 'Front Office';
  }
  if (lower.includes('housekeeping') || lower === 'hk') {
    return 'Housekeeping';
  }
  if (lower.includes('accountant') || lower.includes('accounting') || lower.includes('finance')) {
    return 'Accounting';
  }
  if (lower.includes('pos') || lower.includes('resto') || lower.includes('cashier')) {
    return 'POS / Resto';
  }
  return r;
}

export function formatCalendarDate(val: any): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
    if (match) return match[0];
  }
  if (val instanceof Date && !isNaN(val.getTime())) {
    const year = val.getFullYear();
    const month = String(val.getMonth() + 1).padStart(2, '0');
    const day = String(val.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return null;
}

export function validateAndNormalizeCalendarDate(
  val: any,
  fieldName = 'hire_date'
): string | null {
  if (val === undefined) return undefined as any;
  if (val === null) return null;
  if (typeof val !== 'string') {
    throw Object.assign(
      new Error(`Format tanggal ${fieldName} tidak valid. Gunakan format YYYY-MM-DD.`),
      { statusCode: 400, code: 'INVALID_DATE_FORMAT' }
    );
  }
  const trimmed = val.trim();
  if (trimmed === '') return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    throw Object.assign(
      new Error(`Format tanggal ${fieldName} harus YYYY-MM-DD (diterima: "${trimmed}").`),
      { statusCode: 400, code: 'INVALID_DATE_FORMAT' }
    );
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw Object.assign(
      new Error(`Nilai tanggal ${fieldName} di luar rentang kalender yang valid.`),
      { statusCode: 400, code: 'INVALID_DATE_VALUE' }
    );
  }

  const testDate = new Date(Date.UTC(year, month - 1, day));
  if (
    testDate.getUTCFullYear() !== year ||
    testDate.getUTCMonth() !== month - 1 ||
    testDate.getUTCDate() !== day
  ) {
    throw Object.assign(
      new Error(`Tanggal ${fieldName} "${trimmed}" bukan tanggal kalender yang valid.`),
      { statusCode: 400, code: 'INVALID_CALENDAR_DATE' }
    );
  }

  return trimmed;
}

export function generateSecureTemporaryPassword(length: number = 12): string {
  const uppers = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lowers = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%*';
  const all = uppers + lowers + digits + symbols;

  let pwd = '';
  pwd += uppers[crypto.randomInt(uppers.length)];
  pwd += lowers[crypto.randomInt(lowers.length)];
  pwd += digits[crypto.randomInt(digits.length)];
  pwd += symbols[crypto.randomInt(symbols.length)];

  for (let i = pwd.length; i < Math.max(10, length); i++) {
    pwd += all[crypto.randomInt(all.length)];
  }

  // Cryptographically robust shuffle
  return pwd
    .split('')
    .sort(() => crypto.randomInt(3) - 1)
    .join('');
}

export async function resolveUniqueUsername(client: PoolClient, baseUsername: string): Promise<string> {
  const clean = baseUsername.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'staff';
  let candidate = clean;
  let counter = 2;
  while (true) {
    const existing = await client.query(
      `SELECT 1 FROM users WHERE LOWER(username) = $1 LIMIT 1`,
      [candidate]
    );
    if ((existing.rowCount ?? 0) === 0) {
      return candidate;
    }
    candidate = `${clean}${counter}`;
    counter++;
  }
}

export async function resolveCanonicalRoleId(
  client: PoolClient,
  roleName: string,
  propertyId?: number
): Promise<number> {
  if (!roleName || !roleName.trim()) {
    throw Object.assign(new Error('Role name wajib diisi untuk menentukan peran otorisasi akun login.'), {
      statusCode: 400,
      code: 'ROLE_REQUIRED'
    });
  }

  const rawTrimmed = roleName.trim();
  if (rawTrimmed.toLowerCase() === 'crew') {
    throw Object.assign(
      new Error("Role 'Crew' bukan peran otorisasi sistem (Auth Role). Untuk staf pelaksana tanpa akses PMS desktop, gunakan tipe akses MOBILE_ONLY."),
      {
        statusCode: 400,
        code: 'INVALID_AUTH_ROLE'
      }
    );
  }

  const norm = normalizeRoleName(rawTrimmed);

  // 1. Query canonical role: check property-scoped custom role first, then fallback to system role (property_id IS NULL)
  const qNorm = await client.query(
    `SELECT id, name, property_id, is_system_role FROM roles
     WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
       AND (property_id IS NULL OR ($2::int IS NOT NULL AND property_id = $2::int))
     ORDER BY (property_id IS NOT NULL) DESC, id ASC
     LIMIT 1`,
    [norm, propertyId || null]
  );
  if (qNorm.rows.length > 0) {
    return Number(qNorm.rows[0].id);
  }

  // 2. Query canonical role by raw name if different from normalized
  if (norm.toLowerCase() !== rawTrimmed.toLowerCase()) {
    const qRaw = await client.query(
      `SELECT id, name, property_id, is_system_role FROM roles
       WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
         AND (property_id IS NULL OR ($2::int IS NOT NULL AND property_id = $2::int))
       ORDER BY (property_id IS NOT NULL) DESC, id ASC
       LIMIT 1`,
      [rawTrimmed, propertyId || null]
    );
    if (qRaw.rows.length > 0) {
      return Number(qRaw.rows[0].id);
    }
  }

  // 3. ZERO GUESSING. Reject any role that does not map to a real canonical auth role row!
  throw Object.assign(
    new Error(`Role '${roleName}' tidak memiliki peran otorisasi sistem (Auth Role) yang valid di database. Peran yang tersedia: Front Office, Accounting, Housekeeping, General Manager, POS / Resto, atau HRD Admin.`),
    {
      statusCode: 400,
      code: 'INVALID_AUTH_ROLE'
    }
  );
}

export async function getHrdRolePolicies(
  client: PoolClient,
  propertyId: number
): Promise<HrdRolePolicySettings> {
  const res = await client.query(
    'SELECT * FROM hrd_role_policies WHERE property_id = $1 LIMIT 1',
    [propertyId]
  );

  if (hasRows(res)) {
    const row = res.rows[0];
    return {
      id: row.id,
      property_id: row.property_id,
      allow_hrd_assign_owner_role: Boolean(row.allow_hrd_assign_owner_role),
      allow_hrd_assign_gm_role: Boolean(row.allow_hrd_assign_gm_role),
      allow_hrd_assign_dept_manager_role: row.allow_hrd_assign_dept_manager_role !== false,
      allow_hrd_assign_accountant_role: row.allow_hrd_assign_accountant_role !== false,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  // Insert default if not existing
  const ins = await client.query(
    `INSERT INTO hrd_role_policies (
      property_id, allow_hrd_assign_owner_role, allow_hrd_assign_gm_role,
      allow_hrd_assign_dept_manager_role, allow_hrd_assign_accountant_role
    )
    VALUES ($1, FALSE, FALSE, TRUE, TRUE)
    ON CONFLICT (property_id) DO NOTHING
    RETURNING *`,
    [propertyId]
  );

  if (hasRows(ins)) {
    const row = ins.rows[0];
    return {
      id: row.id,
      property_id: row.property_id,
      allow_hrd_assign_owner_role: Boolean(row.allow_hrd_assign_owner_role),
      allow_hrd_assign_gm_role: Boolean(row.allow_hrd_assign_gm_role),
      allow_hrd_assign_dept_manager_role: Boolean(row.allow_hrd_assign_dept_manager_role),
      allow_hrd_assign_accountant_role: Boolean(row.allow_hrd_assign_accountant_role),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  return {
    property_id: propertyId,
    allow_hrd_assign_owner_role: false,
    allow_hrd_assign_gm_role: false,
    allow_hrd_assign_dept_manager_role: true,
    allow_hrd_assign_accountant_role: true
  };
}

export async function updateHrdRolePolicies(
  client: PoolClient,
  propertyId: number,
  patch: Partial<HrdRolePolicySettings>,
  actor?: { id?: number; name?: string; role?: string }
): Promise<HrdRolePolicySettings> {
  const current = await getHrdRolePolicies(client, propertyId);

  const newOwner = typeof patch.allow_hrd_assign_owner_role === 'boolean'
    ? patch.allow_hrd_assign_owner_role
    : current.allow_hrd_assign_owner_role;

  const newGm = typeof patch.allow_hrd_assign_gm_role === 'boolean'
    ? patch.allow_hrd_assign_gm_role
    : current.allow_hrd_assign_gm_role;

  const newDeptMgr = typeof patch.allow_hrd_assign_dept_manager_role === 'boolean'
    ? patch.allow_hrd_assign_dept_manager_role
    : current.allow_hrd_assign_dept_manager_role;

  const newAccountant = typeof patch.allow_hrd_assign_accountant_role === 'boolean'
    ? patch.allow_hrd_assign_accountant_role
    : current.allow_hrd_assign_accountant_role;

  const res = await client.query(
    `INSERT INTO hrd_role_policies (
      property_id, allow_hrd_assign_owner_role, allow_hrd_assign_gm_role,
      allow_hrd_assign_dept_manager_role, allow_hrd_assign_accountant_role, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (property_id) DO UPDATE
    SET allow_hrd_assign_owner_role = EXCLUDED.allow_hrd_assign_owner_role,
        allow_hrd_assign_gm_role = EXCLUDED.allow_hrd_assign_gm_role,
        allow_hrd_assign_dept_manager_role = EXCLUDED.allow_hrd_assign_dept_manager_role,
        allow_hrd_assign_accountant_role = EXCLUDED.allow_hrd_assign_accountant_role,
        updated_at = NOW()
    RETURNING *`,
    [propertyId, newOwner, newGm, newDeptMgr, newAccountant]
  );

  const updatedRow = res.rows[0];

  // Write Audit Log
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'HRD_ROLE_POLICIES_UPDATED',
      'HRD_ROLE_POLICY',
      String(updatedRow.id),
      JSON.stringify({ old: current, new: updatedRow }),
      actor?.name || 'Admin',
      propertyId
    ]
  );

  return {
    id: updatedRow.id,
    property_id: updatedRow.property_id,
    allow_hrd_assign_owner_role: Boolean(updatedRow.allow_hrd_assign_owner_role),
    allow_hrd_assign_gm_role: Boolean(updatedRow.allow_hrd_assign_gm_role),
    allow_hrd_assign_dept_manager_role: Boolean(updatedRow.allow_hrd_assign_dept_manager_role),
    allow_hrd_assign_accountant_role: Boolean(updatedRow.allow_hrd_assign_accountant_role),
    created_at: updatedRow.created_at,
    updated_at: updatedRow.updated_at
  };
}

export async function getAvailableRolesForHrd(
  client: PoolClient,
  propertyId: number
): Promise<RoleCategoryDef[]> {
  const policies = await getHrdRolePolicies(client, propertyId);

  const roles: RoleCategoryDef[] = [...STANDARD_ROLE_CATEGORIES];

  if (policies.allow_hrd_assign_gm_role) {
    const gmRole = PRIVILEGED_ROLE_CATEGORIES.find(r => r.key === 'General Manager');
    if (gmRole) roles.push(gmRole);
  }

  if (policies.allow_hrd_assign_owner_role) {
    const ownerRole = PRIVILEGED_ROLE_CATEGORIES.find(r => r.key === 'Owner');
    if (ownerRole) roles.push(ownerRole);
  }

  return roles;
}

export async function getEmployees(
  client: PoolClient,
  propertyId: number,
  options?: { scope?: string; department?: string; role?: string; department_id?: number }
): Promise<HrEmployee[]> {
  let sql = `
    SELECT e.*,
           to_char(e.hire_date, 'YYYY-MM-DD') AS hire_date_formatted,
           d.name AS department_name,
           d.code AS department_code,
           p.name AS position_name,
           u.id AS user_id,
           u.account_status,
           u.is_active AS user_is_active,
           u.access_type,
           u.role_id,
           r.name AS role_name
    FROM hr_employees e
    LEFT JOIN hr_departments d ON d.id = e.department_id
    LEFT JOIN hr_positions p ON p.id = e.position_id
    LEFT JOIN users u ON u.employee_id = e.id
    LEFT JOIN roles r ON r.id = u.role_id
    WHERE e.property_id = $1
  `;
  const params: any[] = [propertyId];

  if (options?.scope === 'inactive' || options?.scope === 'archive') {
    sql += " AND (COALESCE(e.is_active, TRUE) = FALSE OR e.status != 'ACTIVE')";
  } else if (options?.scope === 'all') {
    // all records, no filter
  } else {
    // default: active employees
    sql += " AND COALESCE(e.is_active, TRUE) = TRUE AND e.status = 'ACTIVE'";
  }

  if (options?.department_id) {
    params.push(options.department_id);
    sql += ` AND e.department_id = $${params.length}`;
  } else if (options?.department) {
    params.push(options.department);
    sql += ` AND (e.department = $${params.length} OR d.name = $${params.length})`;
  }

  if (options?.role) {
    params.push(options.role);
    sql += ` AND (e.role = $${params.length} OR r.name = $${params.length})`;
  }

  sql += ' ORDER BY e.full_name ASC';

  const res = await client.query(sql, params);
  return res.rows.map((row: any) => ({
    id: Number(row.id),
    property_id: Number(row.property_id),
    employee_code: row.employee_code,
    full_name: row.full_name,
    department_id: row.department_id ? Number(row.department_id) : null,
    department_name: row.department_name || row.department || null,
    department_code: row.department_code || null,
    position_id: row.position_id ? Number(row.position_id) : null,
    position_name: row.position_name || row.position || null,
    position: row.position_name || row.position || null,
    department: row.department_name || row.department || null,
    role: row.role_name || row.role || 'Crew',
    role_id: row.role_id ? Number(row.role_id) : null,
    access_type: row.access_type || 'PMS_STAFF',
    username: row.username,
    email: row.email,
    phone: row.phone,
    hire_date: row.hire_date_formatted || formatCalendarDate(row.hire_date),
    monthly_salary: Number(row.monthly_salary || 0),
    status: row.status || 'ACTIVE',
    is_active: row.is_active !== false,
    user_id: row.user_id ? Number(row.user_id) : null,
    account_status: row.account_status || null,
    user_is_active: row.user_id ? row.user_is_active !== false : null,
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
}

export async function validateRoleAssignment(
  client: PoolClient,
  propertyId: number,
  role: string,
  _actor?: { id?: number; name?: string; role?: string }
): Promise<void> {
  const normalized = normalizeRoleName(role);
  const upper = normalized.toUpperCase();

  if (
    normalized === 'Super Admin' ||
    upper === 'SUPER ADMIN' ||
    upper === 'SUPERADMIN' ||
    upper === 'ADMIN' ||
    upper.includes('PLATFORM') ||
    upper.includes('SYSTEM')
  ) {
    throw Object.assign(new Error('Akun Administrator Platform tidak dapat dibuat melalui HRD properti.'), { statusCode: 403, code: 'PLATFORM_ADMIN_PROHIBITED' });
  }

  const policy = await getHrdRolePolicies(client, propertyId);

  if (normalized === 'Owner' && !policy.allow_hrd_assign_owner_role) {
    throw Object.assign(
      new Error('Penugasan role Owner tidak diizinkan oleh kebijakan HRD properti ini. Hubungi Management Administrator.'),
      { statusCode: 403, code: 'ROLE_ASSIGNMENT_RESTRICTED' }
    );
  }

  if (normalized === 'General Manager' && !policy.allow_hrd_assign_gm_role) {
    throw Object.assign(
      new Error('Penugasan role General Manager tidak diizinkan oleh kebijakan HRD properti ini. Hubungi Management Administrator.'),
      { statusCode: 403, code: 'ROLE_ASSIGNMENT_RESTRICTED' }
    );
  }
}

export async function createEmployeeAccount(
  client: PoolClient,
  propertyId: number,
  payload: CreateEmployeePayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<CreateEmployeeResult> {
  if (!payload.full_name || !payload.full_name.trim()) {
    throw Object.assign(new Error('Nama lengkap karyawan wajib diisi.'), { statusCode: 400, code: 'NAME_REQUIRED' });
  }

  const shouldCreateLogin = Boolean(payload.create_login_account);
  let requestedRole = payload.role ? normalizeRoleName(payload.role) : '';
  let canonicalRoleId: number = 2;

  // Resolve Role
  if (payload.role_id) {
    const rRes = await client.query('SELECT id, name, is_active FROM roles WHERE id = $1', [payload.role_id]);
    if (rRes.rows.length === 0) {
      throw Object.assign(new Error('Role tidak ditemukan.'), { statusCode: 400, code: 'ROLE_NOT_FOUND' });
    }
    if (!rRes.rows[0].is_active) {
      throw Object.assign(new Error('Role non-aktif tidak dapat ditugaskan ke akun karyawan.'), { statusCode: 400, code: 'ROLE_INACTIVE' });
    }
    canonicalRoleId = Number(rRes.rows[0].id);
    requestedRole = rRes.rows[0].name;
  } else if (payload.role && payload.role.trim()) {
    const rRes = await client.query(
      `SELECT id, name, is_active FROM roles
       WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
         AND (property_id IS NULL OR property_id = $2)
       ORDER BY (property_id IS NOT NULL) DESC, id ASC
       LIMIT 1`,
      [requestedRole, propertyId]
    );
    if (rRes.rows.length > 0) {
      if (!rRes.rows[0].is_active) {
        throw Object.assign(new Error('Role non-aktif tidak dapat ditugaskan ke akun karyawan.'), { statusCode: 400, code: 'ROLE_INACTIVE' });
      }
      canonicalRoleId = Number(rRes.rows[0].id);
      requestedRole = rRes.rows[0].name;
    } else if (shouldCreateLogin) {
      canonicalRoleId = await resolveCanonicalRoleId(client, requestedRole, propertyId);
    }
  } else {
    requestedRole = 'Crew';
  }

  if (shouldCreateLogin && (payload.role?.trim().toLowerCase() === 'crew' || requestedRole.toLowerCase() === 'crew')) {
    throw Object.assign(
      new Error("Role 'Crew' bukan peran otorisasi sistem (Auth Role). Untuk staf pelaksana tanpa akses PMS desktop, gunakan tipe akses MOBILE_ONLY."),
      { statusCode: 400, code: 'INVALID_AUTH_ROLE' }
    );
  }

  await validateRoleAssignment(client, propertyId, requestedRole, actor);

  // Resolve Department
  let resolvedDeptId: number | null = null;
  let resolvedDeptCode: string = 'EMP';
  let resolvedDeptName: string = payload.department || 'Operations';

  if (payload.department_id) {
    const dRes = await client.query(
      'SELECT id, code, name, is_active FROM hr_departments WHERE id = $1 AND property_id = $2',
      [payload.department_id, propertyId]
    );
    if (dRes.rows.length === 0) {
      throw Object.assign(new Error('Departemen tidak ditemukan.'), { statusCode: 400, code: 'DEPARTMENT_NOT_FOUND' });
    }
    if (!dRes.rows[0].is_active) {
      throw Object.assign(new Error('Departemen non-aktif tidak dapat dipilih untuk penugasan karyawan baru.'), { statusCode: 400, code: 'DEPARTMENT_INACTIVE' });
    }
    resolvedDeptId = Number(dRes.rows[0].id);
    resolvedDeptCode = dRes.rows[0].code;
    resolvedDeptName = dRes.rows[0].name;
  } else if (payload.department && payload.department.trim()) {
    const dRes = await client.query(
      'SELECT id, code, name, is_active FROM hr_departments WHERE property_id = $1 AND (LOWER(name) = LOWER($2) OR LOWER(code) = LOWER($2)) LIMIT 1',
      [propertyId, payload.department.trim()]
    );
    if (dRes.rows.length > 0) {
      if (!dRes.rows[0].is_active) {
        throw Object.assign(new Error('Departemen non-aktif tidak dapat dipilih untuk penugasan karyawan baru.'), { statusCode: 400, code: 'DEPARTMENT_INACTIVE' });
      }
      resolvedDeptId = Number(dRes.rows[0].id);
      resolvedDeptCode = dRes.rows[0].code;
      resolvedDeptName = dRes.rows[0].name;
    }
  }

  // Resolve Position
  let resolvedPosId: number | null = null;
  let resolvedPosName: string = payload.position || 'Staff';

  if (payload.position_id) {
    const pRes = await client.query(
      'SELECT id, name, is_active, department_id FROM hr_positions WHERE id = $1 AND property_id = $2',
      [payload.position_id, propertyId]
    );
    if (pRes.rows.length === 0) {
      throw Object.assign(new Error('Jabatan tidak ditemukan.'), { statusCode: 400, code: 'POSITION_NOT_FOUND' });
    }
    if (!pRes.rows[0].is_active) {
      throw Object.assign(new Error('Jabatan non-aktif tidak dapat dipilih untuk penugasan karyawan baru.'), { statusCode: 400, code: 'POSITION_INACTIVE' });
    }
    resolvedPosId = Number(pRes.rows[0].id);
    resolvedPosName = pRes.rows[0].name;
  } else if (payload.position && payload.position.trim()) {
    const pRes = await client.query(
      'SELECT id, name, is_active FROM hr_positions WHERE property_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
      [propertyId, payload.position.trim()]
    );
    if (pRes.rows.length > 0) {
      if (!pRes.rows[0].is_active) {
        throw Object.assign(new Error('Jabatan non-aktif tidak dapat dipilih untuk penugasan karyawan baru.'), { statusCode: 400, code: 'POSITION_INACTIVE' });
      }
      resolvedPosId = Number(pRes.rows[0].id);
      resolvedPosName = pRes.rows[0].name;
    }
  }

  const cleanEmail = payload.email ? payload.email.trim().toLowerCase() : null;

  let finalUsername: string | null = null;
  let tempPassword: string | null = null;
  let tempExpiresAt: Date | null = null;

  if (shouldCreateLogin) {
    if (!cleanEmail) {
      throw Object.assign(new Error('Email wajib diisi untuk pembuatan akun login karyawan.'), {
        statusCode: 400,
        code: 'EMAIL_REQUIRED'
      });
    }

    // Check duplicate email in users
    const existingEmail = await client.query(
      'SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1',
      [cleanEmail]
    );
    if ((existingEmail.rowCount ?? 0) > 0) {
      throw Object.assign(new Error(`Email '${cleanEmail}' sudah terdaftar pada akun login lain.`), {
        statusCode: 400,
        code: 'EMAIL_ALREADY_EXISTS'
      });
    }

    // Determine username with deterministic collision resolution
    if (payload.username && payload.username.trim()) {
      const userReq = payload.username.trim().toLowerCase();
      finalUsername = await resolveUniqueUsername(client, userReq);
    } else {
      const emailPrefix = cleanEmail.split('@')[0];
      finalUsername = await resolveUniqueUsername(client, emailPrefix);
    }

    // Generate secure temporary password
    tempPassword = generateSecureTemporaryPassword(12);
    tempExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  } else {
    finalUsername = payload.username && payload.username.trim() ? payload.username.trim().toLowerCase() : null;
  }

  // Employee Code generation: strictly immutable once created, patterned <DEPT_CODE>-0001
  let employeeCode = payload.employee_code && payload.employee_code.trim() ? payload.employee_code.trim() : null;
  if (!employeeCode) {
    const prefix = (resolvedDeptCode || 'EMP').toUpperCase();
    const codeRes = await client.query(
      `SELECT employee_code FROM hr_employees
       WHERE property_id = $1 AND employee_code ~ $2
       ORDER BY id DESC FOR UPDATE`,
      [propertyId, `^${prefix}-\\d+$`]
    );
    let maxSeq = 0;
    for (const row of codeRes.rows) {
      const m = row.employee_code.match(new RegExp(`^${prefix}-(\\d+)$`));
      if (m) {
        const seq = parseInt(m[1], 10);
        if (seq > maxSeq) maxSeq = seq;
      }
    }
    const nextSeq = maxSeq + 1;
    employeeCode = `${prefix}-${String(nextSeq).padStart(4, '0')}`;
  }

  const normalizedHireDate = payload.hire_date !== undefined
    ? validateAndNormalizeCalendarDate(payload.hire_date, 'hire_date')
    : null;

  const res = await client.query(
    `INSERT INTO hr_employees (
      property_id, employee_code, full_name, position, department,
      department_id, position_id,
      role, username, email, phone, hire_date, monthly_salary, status, is_active
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE)
    RETURNING *`,
    [
      propertyId,
      employeeCode,
      payload.full_name.trim(),
      resolvedPosName,
      resolvedDeptName,
      resolvedDeptId,
      resolvedPosId,
      requestedRole,
      finalUsername,
      cleanEmail,
      payload.phone || null,
      normalizedHireDate,
      payload.monthly_salary || 0,
      payload.status || 'ACTIVE'
    ]
  );

  const created: HrEmployee = {
    ...res.rows[0],
    id: Number(res.rows[0].id),
    property_id: Number(res.rows[0].property_id),
    department_id: res.rows[0].department_id ? Number(res.rows[0].department_id) : null,
    position_id: res.rows[0].position_id ? Number(res.rows[0].position_id) : null,
    hire_date: formatCalendarDate(res.rows[0].hire_date),
    is_active: res.rows[0].is_active !== false,
    monthly_salary: Number(res.rows[0].monthly_salary || 0)
  };

  let createdUserId: number | undefined = undefined;

  if (shouldCreateLogin && tempPassword && tempExpiresAt) {
    const passwordHash = await hashPassword(tempPassword);

    const userRes = await client.query(
      `INSERT INTO users (
        property_id, employee_id, role_id, username, email, password_hash,
        full_name, is_active, account_status, must_change_password,
        local_password_enabled, temp_password_expires_at, access_type, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, 'FIRST_LOGIN_REQUIRED', TRUE, TRUE, $8, $9, NOW(), NOW())
      RETURNING id`,
      [
        propertyId,
        created.id,
        canonicalRoleId,
        finalUsername,
        cleanEmail,
        passwordHash,
        created.full_name,
        tempExpiresAt,
        payload.access_type || 'PMS_STAFF'
      ]
    );

    createdUserId = Number(userRes.rows[0].id);

    // Audit log for user account creation
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'HRD',
        'AUTH_ACCOUNT_CREATED',
        'USER_AUTH',
        String(createdUserId),
        JSON.stringify({
          target_user_id: createdUserId,
          employee_id: created.id,
          username: finalUsername,
          email: cleanEmail,
          role: requestedRole,
          role_id: canonicalRoleId,
          account_status: 'FIRST_LOGIN_REQUIRED',
          temp_password_expires_at: tempExpiresAt.toISOString()
        }),
        actor?.name || 'HRD',
        propertyId
      ]
    );
  }

  // Audit log for employee creation
  const isPrivileged = requestedRole === 'Owner' || requestedRole === 'General Manager';
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      isPrivileged ? 'PRIVILEGED_ROLE_ASSIGNED' : 'EMPLOYEE_ACCOUNT_CREATED',
      'EMPLOYEE_ROLE',
      String(created.id),
      JSON.stringify({
        target_employee: created.full_name,
        role: created.role,
        code: created.employee_code,
        auth_account_created: shouldCreateLogin,
        user_id: createdUserId
      }),
      actor?.name || 'HRD',
      propertyId
    ]
  );

  return {
    ...created,
    user_id: createdUserId || null,
    role_id: canonicalRoleId || null,
    access_type: payload.access_type || 'PMS_STAFF',
    account_status: shouldCreateLogin ? 'FIRST_LOGIN_REQUIRED' : null,
    user_is_active: shouldCreateLogin ? true : null,
    auth_account_created: shouldCreateLogin,
    temporary_password: tempPassword || undefined,
    temp_password_expires_at: tempExpiresAt ? tempExpiresAt.toISOString() : undefined
  };
}

export async function updateEmployeeAccount(
  client: PoolClient,
  propertyId: number,
  employeeId: number,
  payload: UpdateEmployeePayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<HrEmployee> {
  const currentRes = await client.query(
    `SELECT *, to_char(hire_date, 'YYYY-MM-DD') AS hire_date_formatted
     FROM hr_employees WHERE id = $1 AND property_id = $2`,
    [employeeId, propertyId]
  );

  if (!hasRows(currentRes)) {
    throw Object.assign(new Error(`Karyawan dengan ID ${employeeId} tidak ditemukan pada properti ini.`), {
      statusCode: 404,
      code: 'EMPLOYEE_NOT_FOUND'
    });
  }

  const current = currentRes.rows[0];
  let targetRole = current.role;
  let targetRoleId: number | null = null;

  // Resolve Role
  if (payload.role_id !== undefined && payload.role_id !== null) {
    const rRes = await client.query('SELECT id, name, is_active FROM roles WHERE id = $1', [payload.role_id]);
    if (rRes.rows.length === 0) {
      throw Object.assign(new Error('Role tidak ditemukan.'), { statusCode: 400, code: 'ROLE_NOT_FOUND' });
    }
    if (!rRes.rows[0].is_active) {
      throw Object.assign(new Error('Role non-aktif tidak dapat ditugaskan ke akun karyawan.'), { statusCode: 400, code: 'ROLE_INACTIVE' });
    }
    targetRoleId = Number(rRes.rows[0].id);
    targetRole = rRes.rows[0].name;
  } else if (payload.role !== undefined) {
    if (payload.role.trim().toLowerCase() === 'crew' && current.user_id) {
      throw Object.assign(
        new Error("Role 'Crew' bukan peran otorisasi sistem (Auth Role). Akun login membutuhkan peran otorisasi valid. Untuk staf tanpa hak akses PMS desktop, gunakan tipe akses MOBILE_ONLY."),
        { statusCode: 400, code: 'INVALID_AUTH_ROLE' }
      );
    }
    targetRole = normalizeRoleName(payload.role);
    const rRes = await client.query(
      `SELECT id, name, is_active FROM roles
       WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
         AND (property_id IS NULL OR property_id = $2)
       ORDER BY (property_id IS NOT NULL) DESC, id ASC
       LIMIT 1`,
      [targetRole, propertyId]
    );
    if (rRes.rows.length > 0) {
      if (!rRes.rows[0].is_active) {
        throw Object.assign(new Error('Role non-aktif tidak dapat ditugaskan ke akun karyawan.'), { statusCode: 400, code: 'ROLE_INACTIVE' });
      }
      targetRoleId = Number(rRes.rows[0].id);
      targetRole = rRes.rows[0].name;
    }
  }

  if (payload.role !== undefined || payload.role_id !== undefined) {
    // Platform Admin prohibition
    if (targetRole.toUpperCase().includes('PLATFORM') || targetRole.toUpperCase().includes('SYSTEM_ADMIN') || targetRole.toUpperCase().includes('SUPER_ADMIN')) {
      throw Object.assign(new Error('Akun Administrator Platform tidak dapat diberikan melalui HRD properti.'), { statusCode: 403, code: 'PLATFORM_ADMIN_PROHIBITED' });
    }

    const policy = await getHrdRolePolicies(client, propertyId);

    if (targetRole === 'Owner' && current.role !== 'Owner' && !policy.allow_hrd_assign_owner_role) {
      throw Object.assign(
        new Error('Penugasan role Owner tidak diizinkan oleh kebijakan HRD properti ini. Hubungi Management Administrator.'),
        { statusCode: 403, code: 'ROLE_ASSIGNMENT_RESTRICTED' }
      );
    }

    if (targetRole === 'General Manager' && current.role !== 'General Manager' && !policy.allow_hrd_assign_gm_role) {
      throw Object.assign(
        new Error('Penugasan role General Manager tidak diizinkan oleh kebijakan HRD properti ini. Hubungi Management Administrator.'),
        { statusCode: 403, code: 'ROLE_ASSIGNMENT_RESTRICTED' }
      );
    }
  }

  // Resolve Department
  let targetDepartmentId: number | null = current.department_id ? Number(current.department_id) : null;
  let targetDepartment: string = current.department;

  if (payload.department_id !== undefined) {
    if (payload.department_id === null) {
      targetDepartmentId = null;
    } else {
      const dRes = await client.query(
        'SELECT id, name, is_active FROM hr_departments WHERE id = $1 AND property_id = $2',
        [payload.department_id, propertyId]
      );
      if (dRes.rows.length === 0) {
        throw Object.assign(new Error('Departemen tidak ditemukan.'), { statusCode: 400, code: 'DEPARTMENT_NOT_FOUND' });
      }
      if (!dRes.rows[0].is_active) {
        throw Object.assign(new Error('Departemen non-aktif tidak dapat dipilih untuk penugasan karyawan.'), { statusCode: 400, code: 'DEPARTMENT_INACTIVE' });
      }
      targetDepartmentId = Number(dRes.rows[0].id);
      targetDepartment = dRes.rows[0].name;
    }
  } else if (payload.department !== undefined) {
    targetDepartment = payload.department;
  }

  // Resolve Position
  let targetPositionId: number | null = current.position_id ? Number(current.position_id) : null;
  let targetPosition: string = current.position;

  if (payload.position_id !== undefined) {
    if (payload.position_id === null) {
      targetPositionId = null;
    } else {
      const pRes = await client.query(
        'SELECT id, name, is_active FROM hr_positions WHERE id = $1 AND property_id = $2',
        [payload.position_id, propertyId]
      );
      if (pRes.rows.length === 0) {
        throw Object.assign(new Error('Jabatan tidak ditemukan.'), { statusCode: 400, code: 'POSITION_NOT_FOUND' });
      }
      if (!pRes.rows[0].is_active) {
        throw Object.assign(new Error('Jabatan non-aktif tidak dapat dipilih untuk penugasan karyawan.'), { statusCode: 400, code: 'POSITION_INACTIVE' });
      }
      targetPositionId = Number(pRes.rows[0].id);
      targetPosition = pRes.rows[0].name;
    }
  } else if (payload.position !== undefined) {
    targetPosition = payload.position;
  }

  const fullName = payload.full_name !== undefined ? payload.full_name.trim() : current.full_name;
  const username = payload.username !== undefined ? payload.username : current.username;
  const email = payload.email !== undefined ? payload.email : current.email;
  const phone = payload.phone !== undefined ? payload.phone : current.phone;
  let hireDate: string | null = current.hire_date_formatted || formatCalendarDate(current.hire_date);
  if (payload.hire_date !== undefined) {
    hireDate = validateAndNormalizeCalendarDate(payload.hire_date, 'hire_date');
  }
  const monthlySalary = payload.monthly_salary !== undefined ? payload.monthly_salary : current.monthly_salary;
  const status = payload.status !== undefined ? payload.status : current.status;
  const isActive = payload.is_active !== undefined ? Boolean(payload.is_active) : (current.is_active !== false);

  // Strictly preserve employee_code! Do not allow modification.
  const res = await client.query(
    `UPDATE hr_employees
     SET full_name = $1, position = $2, department = $3, role = $4,
         username = $5, email = $6, phone = $7, hire_date = $8,
         monthly_salary = $9, status = $10, is_active = $11,
         department_id = $12, position_id = $13,
         updated_at = NOW()
     WHERE id = $14 AND property_id = $15
     RETURNING *`,
    [
      fullName, targetPosition, targetDepartment, targetRole,
      username, email, phone, hireDate,
      monthlySalary, status, isActive,
      targetDepartmentId, targetPositionId,
      employeeId, propertyId
    ]
  );

  const updated: HrEmployee = {
    ...res.rows[0],
    id: Number(res.rows[0].id),
    property_id: Number(res.rows[0].property_id),
    department_id: res.rows[0].department_id ? Number(res.rows[0].department_id) : null,
    position_id: res.rows[0].position_id ? Number(res.rows[0].position_id) : null,
    hire_date: formatCalendarDate(res.rows[0].hire_date),
    is_active: res.rows[0].is_active !== false,
    monthly_salary: Number(res.rows[0].monthly_salary || 0)
  };

  // Synchronize users account if linked
  const userCheck = await client.query(
    'SELECT id, role_id, access_type FROM users WHERE employee_id = $1 AND property_id = $2',
    [employeeId, propertyId]
  );
  if (userCheck.rows.length > 0) {
    const userRow = userCheck.rows[0];
    const oldRoleId = userRow.role_id ? Number(userRow.role_id) : null;
    const newRoleId = targetRoleId || oldRoleId;

    if (targetRoleId && targetRoleId !== oldRoleId) {
      await client.query(
        'UPDATE users SET role_id = $1, updated_at = NOW() WHERE id = $2',
        [targetRoleId, userRow.id]
      );

      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'HRD',
          'USER_ROLE_CHANGED',
          'users',
          String(userRow.id),
          JSON.stringify({
            user_id: userRow.id,
            employee_id: employeeId,
            old_role_id: oldRoleId,
            old_role_name: current.role,
            new_role_id: newRoleId,
            new_role_name: targetRole
          }),
          actor?.name || 'HRD',
          propertyId
        ]
      );
    }

    if (payload.access_type && payload.access_type !== userRow.access_type) {
      await client.query(
        'UPDATE users SET access_type = $1, updated_at = NOW() WHERE id = $2',
        [payload.access_type, userRow.id]
      );
    }
  }

  // Audit Department change
  if (targetDepartmentId && targetDepartmentId !== current.department_id) {
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'HRD',
        'EMPLOYEE_DEPARTMENT_CHANGED',
        'hr_employees',
        String(employeeId),
        JSON.stringify({
          employee_id: employeeId,
          old_department_id: current.department_id,
          new_department_id: targetDepartmentId,
          old_department: current.department,
          new_department: targetDepartment
        }),
        actor?.name || 'HRD',
        propertyId
      ]
    );
  }

  // Audit Position change
  if (targetPositionId && targetPositionId !== current.position_id) {
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'HRD',
        'EMPLOYEE_POSITION_CHANGED',
        'hr_employees',
        String(employeeId),
        JSON.stringify({
          employee_id: employeeId,
          old_position_id: current.position_id,
          new_position_id: targetPositionId,
          old_position: current.position,
          new_position: targetPosition
        }),
        actor?.name || 'HRD',
        propertyId
      ]
    );
  }

  // Check if role changed to/from privileged role
  const wasPrivileged = current.role === 'Owner' || current.role === 'General Manager';
  const isPrivileged = updated.role === 'Owner' || updated.role === 'General Manager';

  let auditAction = 'EMPLOYEE_ACCOUNT_UPDATED';
  if (!wasPrivileged && isPrivileged) {
    auditAction = 'PRIVILEGED_ROLE_ASSIGNED';
  } else if (wasPrivileged && !isPrivileged) {
    auditAction = 'PRIVILEGED_ROLE_REVOKED';
  }

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      auditAction,
      'EMPLOYEE_ROLE',
      String(updated.id),
      JSON.stringify({ previous_role: current.role, new_role: updated.role, full_name: updated.full_name }),
      actor?.name || 'HRD',
      propertyId
    ]
  );

  return {
    ...updated,
    role_id: targetRoleId || (userCheck.rows[0]?.role_id ? Number(userCheck.rows[0].role_id) : undefined),
    access_type: payload.access_type || userCheck.rows[0]?.access_type
  };
}

export async function deactivateEmployeeAccount(
  client: PoolClient,
  propertyId: number,
  employeeId: number,
  options?: { reason?: string; effective_date?: string | null },
  actor?: { id?: number; name?: string; role?: string }
): Promise<HrEmployee> {
  const currentRes = await client.query(
    'SELECT * FROM hr_employees WHERE id = $1 AND property_id = $2',
    [employeeId, propertyId]
  );

  if (!hasRows(currentRes)) {
    throw Object.assign(new Error(`Karyawan dengan ID ${employeeId} tidak ditemukan pada properti ini.`), {
      statusCode: 404,
      code: 'EMPLOYEE_NOT_FOUND'
    });
  }

  const current = currentRes.rows[0];

  // 1. Deactivate employee personnel record
  const res = await client.query(
    `UPDATE hr_employees
     SET is_active = FALSE, status = 'INACTIVE', updated_at = NOW()
     WHERE id = $1 AND property_id = $2
     RETURNING *`,
    [employeeId, propertyId]
  );

  // 2. Deactivate linked users auth account (is_active = FALSE, account_status = 'DISABLED')
  const userUpdateRes = await client.query(
    `UPDATE users
     SET is_active = FALSE, account_status = 'DISABLED', updated_at = NOW()
     WHERE employee_id = $1 AND property_id = $2
     RETURNING id, username, email, account_status`,
    [employeeId, propertyId]
  );

  const effectiveDate = options?.effective_date !== undefined
    ? validateAndNormalizeCalendarDate(options.effective_date, 'effective_date')
    : formatCalendarDate(new Date());

  const deactivated: HrEmployee = {
    ...res.rows[0],
    id: Number(res.rows[0].id),
    property_id: Number(res.rows[0].property_id),
    hire_date: formatCalendarDate(res.rows[0].hire_date),
    is_active: false,
    monthly_salary: Number(res.rows[0].monthly_salary || 0)
  };

  // 3. Audit deactivation with reason & effective date
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'EMPLOYEE_ACCOUNT_DEACTIVATED',
      'EMPLOYEE_ROLE',
      String(deactivated.id),
      JSON.stringify({
        is_active: false,
        status: 'INACTIVE',
        previous_status: current.status,
        reason: options?.reason || 'Nonaktifkan via HRD',
        effective_date: effectiveDate,
        auth_users_disabled: userUpdateRes.rows.length > 0,
        disabled_user_ids: userUpdateRes.rows.map((u: any) => u.id)
      }),
      actor?.name || 'HRD',
      propertyId
    ]
  );

  return deactivated;
}

export async function reactivateEmployeeAccount(
  client: PoolClient,
  propertyId: number,
  employeeId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<HrEmployee> {
  const currentRes = await client.query(
    'SELECT * FROM hr_employees WHERE id = $1 AND property_id = $2',
    [employeeId, propertyId]
  );

  if (!hasRows(currentRes)) {
    throw Object.assign(new Error(`Karyawan dengan ID ${employeeId} tidak ditemukan pada properti ini.`), {
      statusCode: 404,
      code: 'EMPLOYEE_NOT_FOUND'
    });
  }

  const current = currentRes.rows[0];

  // Reactivate personnel record ONLY
  const res = await client.query(
    `UPDATE hr_employees
     SET is_active = TRUE, status = 'ACTIVE', updated_at = NOW()
     WHERE id = $1 AND property_id = $2
     RETURNING *`,
    [employeeId, propertyId]
  );

  // CRITICAL INVARIANT: DO NOT BLINDLY RESTORE AUTH ACCOUNT.
  // The login account remains DISABLED until HR explicitly evaluates and triggers diagnosis/repair.

  const reactivated: HrEmployee = {
    ...res.rows[0],
    id: Number(res.rows[0].id),
    property_id: Number(res.rows[0].property_id),
    hire_date: formatCalendarDate(res.rows[0].hire_date),
    is_active: true,
    monthly_salary: Number(res.rows[0].monthly_salary || 0)
  };

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'EMPLOYEE_PERSONNEL_REACTIVATED',
      'EMPLOYEE_ROLE',
      String(reactivated.id),
      JSON.stringify({
        is_active: true,
        status: 'ACTIVE',
        previous_status: current.status,
        auth_account_restored: false,
        note: 'Personnel record reactivated. Auth account remains unchanged pending explicit diagnosis/repair.'
      }),
      actor?.name || 'HRD',
      propertyId
    ]
  );

  return reactivated;
}

export async function checkUserHasOperationalHistory(
  client: PoolClient,
  userId: number
): Promise<{ hasHistory: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  // 1. User login history
  const userRes = await client.query(
    'SELECT last_login_at, google_sub, username FROM users WHERE id = $1',
    [userId]
  );
  if (userRes.rows.length > 0) {
    if (userRes.rows[0].last_login_at) {
      reasons.push('User sudah memiliki riwayat login sistem');
    }
    if (userRes.rows[0].google_sub) {
      reasons.push('User terhubung dengan Google Account');
    }
  }

  // 2. Attendance references
  const attRes = await client.query(
    'SELECT COUNT(*) FROM employee_attendance WHERE reviewed_by_user_id = $1',
    [userId]
  );
  if (Number(attRes.rows[0].count) > 0) {
    reasons.push('Terdapat riwayat review absensi oleh user ini');
  }

  // 3. Face enrollment references
  const faceRes = await client.query(
    'SELECT COUNT(*) FROM employee_face_enrollments WHERE enrolled_by_user_id = $1 OR reviewed_by_user_id = $1 OR revoked_by_user_id = $1',
    [userId]
  );
  if (Number(faceRes.rows[0].count) > 0) {
    reasons.push('Terdapat riwayat pendaftaran/verifikasi wajah oleh user ini');
  }

  // 4. Work schedules and audits
  const schedRes = await client.query(
    'SELECT COUNT(*) FROM employee_work_schedules WHERE created_by_user_id = $1 OR updated_by_user_id = $1 OR published_by_user_id = $1',
    [userId]
  );
  if (Number(schedRes.rows[0].count) > 0) {
    reasons.push('Terdapat riwayat pembuatan/pembaruan jadwal kerja');
  }

  const schedAuditRes = await client.query(
    'SELECT COUNT(*) FROM employee_work_schedule_audits WHERE changed_by_user_id = $1',
    [userId]
  );
  if (Number(schedAuditRes.rows[0].count) > 0) {
    reasons.push('Terdapat riwayat audit jadwal kerja');
  }

  // 5. Folio & transactions
  const folioRes = await client.query(
    'SELECT COUNT(*) FROM folio_entries WHERE actor_user_id = $1',
    [userId]
  );
  if (Number(folioRes.rows[0].count) > 0) {
    reasons.push('Terdapat entri folio/transaksi kamar');
  }

  const txRes = await client.query(
    'SELECT COUNT(*) FROM transactions WHERE created_by = $1 OR deleted_by_user_id = $2 OR verified_by_user_id = $2',
    [String(userId), userId]
  );
  if (Number(txRes.rows[0].count) > 0) {
    reasons.push('Terdapat riwayat transaksi finansial/kasir');
  }

  // 6. Housekeeping tasks & findings
  const hkRes = await client.query(
    'SELECT COUNT(*) FROM housekeeping_tasks WHERE assigned_user_id = $1 OR requested_by_user_id = $1',
    [userId]
  );
  if (Number(hkRes.rows[0].count) > 0) {
    reasons.push('Terdapat penugasan housekeeping');
  }

  const hkFindingsRes = await client.query(
    'SELECT COUNT(*) FROM housekeeping_task_findings WHERE reported_by_user_id = $1 OR resolved_by_user_id = $1 OR verified_by_user_id = $1',
    [userId]
  );
  if (Number(hkFindingsRes.rows[0].count) > 0) {
    reasons.push('Terdapat temuan inspeksi housekeeping');
  }

  // 7. Payment evidences
  const paymentEvRes = await client.query(
    'SELECT COUNT(*) FROM payment_evidences WHERE uploaded_by_user_id = $1 OR deactivated_by_user_id = $1',
    [userId]
  );
  if (Number(paymentEvRes.rows[0].count) > 0) {
    reasons.push('Terdapat bukti pembayaran yang diunggah/diproses');
  }

  // 8. Room moves
  const roomMoveRes = await client.query(
    'SELECT COUNT(*) FROM reservation_room_moves WHERE moved_by_user_id = $1',
    [userId]
  );
  if (Number(roomMoveRes.rows[0].count) > 0) {
    reasons.push('Terdapat riwayat pemindahan kamar reservasi');
  }

  // 9. Operational audit logs where this user was the actor
  if (userRes.rows.length > 0 && userRes.rows[0].username) {
    const auditActorRes = await client.query(
      `SELECT COUNT(*) FROM audit_logs
       WHERE correlation_id = $1
         AND action NOT IN ('WHATSAPP_CREDENTIAL_OPENED', 'EMPLOYEE_ACCOUNT_CREATED')`,
      [userRes.rows[0].username]
    );
    if (Number(auditActorRes.rows[0].count) > 0) {
      reasons.push('Terdapat log aktivitas operasional atas nama akun ini');
    }
  }

  return {
    hasHistory: reasons.length > 0,
    reasons
  };
}

export async function hardDeleteAuthAccount(
  client: PoolClient,
  propertyId: number,
  employeeId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ deleted_user_id: number; username: string; email: string }> {
  // Check employee exists
  const empRes = await client.query(
    'SELECT * FROM hr_employees WHERE id = $1 AND property_id = $2',
    [employeeId, propertyId]
  );
  if (!hasRows(empRes)) {
    throw Object.assign(new Error(`Karyawan dengan ID ${employeeId} tidak ditemukan.`), {
      statusCode: 404,
      code: 'EMPLOYEE_NOT_FOUND'
    });
  }

  // Find linked user
  const userRes = await client.query(
    'SELECT * FROM users WHERE employee_id = $1 AND property_id = $2',
    [employeeId, propertyId]
  );
  if (!hasRows(userRes)) {
    throw Object.assign(new Error('Karyawan ini tidak memiliki akun login untuk dihapus.'), {
      statusCode: 404,
      code: 'LOGIN_ACCOUNT_NOT_FOUND'
    });
  }

  const user = userRes.rows[0];

  // Check operational history dependencies
  const historyCheck = await checkUserHasOperationalHistory(client, user.id);
  if (historyCheck.hasHistory) {
    throw Object.assign(
      new Error('Akun ini sudah memiliki histori aktivitas dan tidak dapat dihapus permanen. Gunakan Nonaktifkan Akun.'),
      {
        statusCode: 409,
        code: 'ACCOUNT_HAS_HISTORY',
        details: historyCheck.reasons
      }
    );
  }

  // Safe to delete users row ONLY (hr_employees row is preserved!)
  await client.query('DELETE FROM users WHERE id = $1', [user.id]);

  // Audit deletion (CRITICAL: employee record remains intact!)
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'EMPLOYEE_AUTH_ACCOUNT_DELETED',
      'USER_AUTH',
      String(employeeId),
      JSON.stringify({
        deleted_user_id: user.id,
        username: user.username,
        email: user.email,
        employee_id: employeeId,
        timestamp: new Date().toISOString()
      }),
      actor?.name || 'HRD',
      propertyId
    ]
  );

  return {
    deleted_user_id: Number(user.id),
    username: user.username,
    email: user.email
  };
}

export async function hardDeleteEmployeeAccount(
  client: PoolClient,
  propertyId: number,
  employeeId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; message: string; deleted_employee: { id: number; employee_code: string; full_name: string } }> {
  // 1. Fetch employee
  const empRes = await client.query(
    'SELECT * FROM hr_employees WHERE id = $1 AND property_id = $2',
    [employeeId, propertyId]
  );
  if (!hasRows(empRes)) {
    throw Object.assign(new Error(`Karyawan dengan ID ${employeeId} tidak ditemukan.`), {
      statusCode: 404,
      code: 'EMPLOYEE_NOT_FOUND'
    });
  }
  const emp = empRes.rows[0];

  // 2. Check operational & history references
  // 2a. Work schedules
  const schedRes = await client.query(
    'SELECT COUNT(*) FROM employee_work_schedules WHERE employee_id = $1',
    [employeeId]
  );
  if (Number(schedRes.rows[0].count) > 0) {
    throw Object.assign(
      new Error('Karyawan tidak dapat dihapus permanen karena memiliki riwayat operasional jadwal kerja. Nonaktifkan karyawan untuk mempertahankan histori.'),
      { statusCode: 409, code: 'EMPLOYEE_HAS_SCHEDULE_HISTORY' }
    );
  }

  // 2b. Schedule audits
  const schedAuditRes = await client.query(
    'SELECT COUNT(*) FROM employee_work_schedule_audits WHERE employee_id = $1',
    [employeeId]
  );
  if (Number(schedAuditRes.rows[0].count) > 0) {
    throw Object.assign(
      new Error('Karyawan tidak dapat dihapus permanen karena memiliki riwayat audit jadwal kerja. Nonaktifkan karyawan untuk mempertahankan histori.'),
      { statusCode: 409, code: 'EMPLOYEE_HAS_SCHEDULE_AUDIT' }
    );
  }

  // 2c. Attendance
  try {
    const attRes = await client.query(
      'SELECT COUNT(*) FROM employee_attendance WHERE employee_id = $1',
      [employeeId]
    );
    if (Number(attRes.rows[0].count) > 0) {
      throw Object.assign(
        new Error('Karyawan tidak dapat dihapus permanen karena memiliki data kehadiran. Nonaktifkan karyawan untuk mempertahankan histori.'),
        { statusCode: 409, code: 'EMPLOYEE_HAS_ATTENDANCE' }
      );
    }
  } catch (err: any) {
    if (err.statusCode === 409) throw err;
  }

  try {
    const attRecRes = await client.query(
      'SELECT COUNT(*) FROM employee_attendance_records WHERE employee_id = $1',
      [employeeId]
    );
    if (Number(attRecRes.rows[0].count) > 0) {
      throw Object.assign(
        new Error('Karyawan tidak dapat dihapus permanen karena memiliki riwayat catatan kehadiran. Nonaktifkan karyawan untuk mempertahankan histori.'),
        { statusCode: 409, code: 'EMPLOYEE_HAS_ATTENDANCE' }
      );
    }
  } catch (err: any) {
    if (err.statusCode === 409) throw err;
  }

  // 2d. Payroll
  try {
    const payrollRes = await client.query(
      'SELECT COUNT(*) FROM payroll_records WHERE employee_id = $1',
      [employeeId]
    );
    if (Number(payrollRes.rows[0].count) > 0) {
      throw Object.assign(
        new Error('Karyawan tidak dapat dihapus permanen karena memiliki riwayat slip gaji/payroll. Nonaktifkan karyawan untuk mempertahankan histori.'),
        { statusCode: 409, code: 'EMPLOYEE_HAS_PAYROLL' }
      );
    }
  } catch (err: any) {
    if (err.statusCode === 409) throw err;
  }

  // 2e. Face enrollment
  try {
    const faceRes = await client.query(
      'SELECT COUNT(*) FROM employee_face_enrollments WHERE employee_id = $1',
      [employeeId]
    );
    if (Number(faceRes.rows[0].count) > 0) {
      throw Object.assign(
        new Error('Karyawan tidak dapat dihapus permanen karena memiliki data biometrik/face enrollment. Nonaktifkan karyawan untuk mempertahankan histori.'),
        { statusCode: 409, code: 'EMPLOYEE_HAS_FACE_ENROLLMENT' }
      );
    }
  } catch (err: any) {
    if (err.statusCode === 409) throw err;
  }

  // 3. Linked users account check
  const userRes = await client.query(
    'SELECT * FROM users WHERE employee_id = $1',
    [employeeId]
  );
  if (userRes.rows.length > 0) {
    const linkedUser = userRes.rows[0];
    const userHistory = await checkUserHasOperationalHistory(client, linkedUser.id);
    if (userHistory.hasHistory) {
      throw Object.assign(
        new Error('Karyawan tidak dapat dihapus permanen karena akun login terhubung memiliki riwayat operasional. Nonaktifkan karyawan untuk mempertahankan histori.'),
        { statusCode: 409, code: 'EMPLOYEE_USER_HAS_HISTORY', details: userHistory.reasons }
      );
    }

    // Check if user is referenced in schedules as creator or publisher
    const userSchedRes = await client.query(
      'SELECT COUNT(*) FROM employee_work_schedules WHERE created_by_user_id = $1 OR published_by_user_id = $1 OR updated_by_user_id = $1',
      [linkedUser.id]
    );
    if (Number(userSchedRes.rows[0].count) > 0) {
      throw Object.assign(
        new Error('Karyawan tidak dapat dihapus permanen karena akun login terhubung tercatat sebagai pembuat/penerbit jadwal. Nonaktifkan karyawan untuk mempertahankan histori.'),
        { statusCode: 409, code: 'EMPLOYEE_USER_HAS_SCHEDULE_HISTORY' }
      );
    }

    // If safe, delete user permission overrides if table exists, then delete the user
    const tblCheck = await client.query("SELECT to_regclass('user_permission_overrides') as tbl");
    if (tblCheck.rows[0]?.tbl) {
      await client.query('DELETE FROM user_permission_overrides WHERE user_id = $1', [linkedUser.id]);
    }
    await client.query('DELETE FROM users WHERE id = $1', [linkedUser.id]);
  }

  // 4. Safe to delete hr_employees
  await client.query(
    'DELETE FROM hr_employees WHERE id = $1 AND property_id = $2',
    [employeeId, propertyId]
  );

  // 5. Audit log
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'EMPLOYEE_HARD_DELETED',
      'hr_employees',
      String(employeeId),
      JSON.stringify({
        id: employeeId,
        employee_code: emp.employee_code,
        full_name: emp.full_name,
        timestamp: new Date().toISOString()
      }),
      actor?.name || 'Super Admin',
      propertyId
    ]
  );

  return {
    success: true,
    message: 'Karyawan berhasil dihapus permanen.',
    deleted_employee: {
      id: Number(emp.id),
      employee_code: emp.employee_code,
      full_name: emp.full_name
    }
  };
}

export async function diagnoseEmployeeLoginAccount(
  client: PoolClient,
  propertyId: number,
  employeeId: number
): Promise<LoginAccountDiagnosis> {
  const empRes = await client.query(
    'SELECT * FROM hr_employees WHERE id = $1 AND property_id = $2',
    [employeeId, propertyId]
  );

  if (!hasRows(empRes)) {
    throw Object.assign(new Error(`Karyawan dengan ID ${employeeId} tidak ditemukan pada properti ini.`), {
      statusCode: 404,
      code: 'EMPLOYEE_NOT_FOUND'
    });
  }

  const emp = empRes.rows[0];

  // 1. Direct link by users.employee_id
  const directUserRes = await client.query(
    `SELECT u.*, r.name AS role_name
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.employee_id = $1`,
    [employeeId]
  );

  if (hasRows(directUserRes)) {
    const u = directUserRes.rows[0];
    const states: DiagnosisState[] = [];
    const mismatchReasons: string[] = [];

    const isEmpActive = emp.is_active !== false && emp.status === 'ACTIVE';
    const isUserActive = u.is_active !== false;

    if (Number(u.property_id) !== propertyId) {
      states.push('PROPERTY_MISMATCH');
      mismatchReasons.push(`Akun login terdaftar pada properti ID ${u.property_id}, sedangkan karyawan berada pada properti ID ${propertyId}.`);
    }

    if (emp.email && u.email && u.email.trim().toLowerCase() !== emp.email.trim().toLowerCase()) {
      states.push('EMAIL_MISMATCH');
      mismatchReasons.push(`Email akun login (${u.email}) berbeda dengan email karyawan (${emp.email}).`);
    }

    if (emp.username && u.username && u.username.trim().toLowerCase() !== emp.username.trim().toLowerCase()) {
      states.push('USERNAME_MISMATCH');
      mismatchReasons.push(`Username akun login (${u.username}) berbeda dengan username karyawan (${emp.username}).`);
    }

    if (u.role_name && normalizeRoleName(u.role_name) !== normalizeRoleName(emp.role)) {
      states.push('ROLE_MISMATCH');
      mismatchReasons.push(`Role akun login (${u.role_name}) berbeda dengan role data karyawan (${emp.role}).`);
    }

    if (!isUserActive) {
      states.push('ACCOUNT_DISABLED');
      mismatchReasons.push('Akun login dalam status dinonaktifkan.');
    }

    if (!isEmpActive) {
      states.push('EMPLOYEE_DISABLED');
      mismatchReasons.push('Data karyawan dalam status non-aktif.');
    }

    if (u.account_status !== 'READY') {
      states.push('ACCOUNT_NOT_READY');
    }

    if (isUserActive && isEmpActive) {
      states.push('PASSWORD_RESET_AVAILABLE');
    }

    if (mismatchReasons.length === 0) {
      states.push('LINKED_OK');
    }

    // Determine primary state
    let primaryState: DiagnosisState = 'LINKED_OK';
    if (states.includes('PROPERTY_MISMATCH')) primaryState = 'PROPERTY_MISMATCH';
    else if (states.includes('ACCOUNT_DISABLED')) primaryState = 'ACCOUNT_DISABLED';
    else if (states.includes('EMPLOYEE_DISABLED')) primaryState = 'EMPLOYEE_DISABLED';
    else if (states.includes('EMAIL_MISMATCH')) primaryState = 'EMAIL_MISMATCH';
    else if (states.includes('USERNAME_MISMATCH')) primaryState = 'USERNAME_MISMATCH';
    else if (states.includes('ROLE_MISMATCH')) primaryState = 'ROLE_MISMATCH';
    else if (states.includes('ACCOUNT_NOT_READY')) primaryState = 'ACCOUNT_NOT_READY';
    else primaryState = 'LINKED_OK';

    return {
      employee_id: Number(emp.id),
      employee_name: emp.full_name,
      employee_code: emp.employee_code,
      employee_email: emp.email || null,
      employee_username: emp.username || null,
      employee_role: emp.role,
      employee_active: isEmpActive,
      linked_user_id: Number(u.id),
      login_email: u.email,
      username: u.username,
      account_status: u.account_status,
      is_active: isUserActive,
      must_change_password: Boolean(u.must_change_password),
      role_name: u.role_name || null,
      temp_password_expires_at: u.temp_password_expires_at ? new Date(u.temp_password_expires_at).toISOString() : null,
      diagnosis_state: primaryState,
      diagnosis_states: states,
      candidate_user: null,
      mismatch_reasons: mismatchReasons
    };
  }

  // 2. Unlinked: search candidate matches by email or username
  const cleanEmail = emp.email ? emp.email.trim().toLowerCase() : '';
  const cleanUsername = emp.username ? emp.username.trim().toLowerCase() : '';

  let candidates: any[] = [];
  if (cleanEmail || cleanUsername) {
    const candRes = await client.query(
      `SELECT u.id, u.property_id, u.username, u.email, u.full_name, u.is_active,
              u.account_status, u.employee_id, r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE (LOWER(u.email) = $1 AND $1 != '')
          OR (LOWER(u.username) = $2 AND $2 != '')`,
      [cleanEmail, cleanUsername]
    );
    candidates = candRes.rows;
  }

  const isEmpActive = emp.is_active !== false && emp.status === 'ACTIVE';

  if (candidates.length === 0) {
    return {
      employee_id: Number(emp.id),
      employee_name: emp.full_name,
      employee_code: emp.employee_code,
      employee_email: emp.email || null,
      employee_username: emp.username || null,
      employee_role: emp.role,
      employee_active: isEmpActive,
      linked_user_id: null,
      login_email: null,
      username: null,
      account_status: null,
      is_active: null,
      must_change_password: null,
      role_name: null,
      temp_password_expires_at: null,
      diagnosis_state: 'NO_ACCOUNT',
      diagnosis_states: ['NO_ACCOUNT'],
      candidate_user: null,
      mismatch_reasons: ['Belum ada akun login yang terhubung atau cocok dengan karyawan ini.']
    };
  }

  if (candidates.length === 1) {
    const c = candidates[0];
    if (Number(c.property_id) !== propertyId) {
      return {
        employee_id: Number(emp.id),
        employee_name: emp.full_name,
        employee_code: emp.employee_code,
        employee_email: emp.email || null,
        employee_username: emp.username || null,
        employee_role: emp.role,
        employee_active: isEmpActive,
        linked_user_id: null,
        login_email: null,
        username: null,
        account_status: null,
        is_active: null,
        must_change_password: null,
        role_name: null,
        temp_password_expires_at: null,
        diagnosis_state: 'PROPERTY_MISMATCH',
        diagnosis_states: ['PROPERTY_MISMATCH'],
        candidate_user: null,
        mismatch_reasons: [`Akun yang cocok terdaftar pada properti ID ${c.property_id}. Hubungi administrator lintas properti.`]
      };
    }

    if (c.employee_id !== null && Number(c.employee_id) !== employeeId) {
      return {
        employee_id: Number(emp.id),
        employee_name: emp.full_name,
        employee_code: emp.employee_code,
        employee_email: emp.email || null,
        employee_username: emp.username || null,
        employee_role: emp.role,
        employee_active: isEmpActive,
        linked_user_id: null,
        login_email: null,
        username: null,
        account_status: null,
        is_active: null,
        must_change_password: null,
        role_name: null,
        temp_password_expires_at: null,
        diagnosis_state: 'AMBIGUOUS_MATCH',
        diagnosis_states: ['AMBIGUOUS_MATCH'],
        candidate_user: null,
        mismatch_reasons: [`Akun login '${c.username}' sudah terhubung ke karyawan ID ${c.employee_id}. Diperlukan review manual.`]
      };
    }

    // Unambiguous candidate found!
    const candidateObj: CandidateUser = {
      id: Number(c.id),
      property_id: Number(c.property_id),
      username: c.username,
      email: c.email,
      full_name: c.full_name,
      is_active: c.is_active !== false,
      role_name: c.role_name || undefined,
      account_status: c.account_status || undefined,
      employee_id: c.employee_id ? Number(c.employee_id) : null
    };

    return {
      employee_id: Number(emp.id),
      employee_name: emp.full_name,
      employee_code: emp.employee_code,
      employee_email: emp.email || null,
      employee_username: emp.username || null,
      employee_role: emp.role,
      employee_active: isEmpActive,
      linked_user_id: null,
      login_email: c.email,
      username: c.username,
      account_status: c.account_status,
      is_active: c.is_active !== false,
      must_change_password: null,
      role_name: c.role_name || null,
      temp_password_expires_at: null,
      diagnosis_state: 'UNLINKED_MATCH_FOUND',
      diagnosis_states: ['UNLINKED_MATCH_FOUND'],
      candidate_user: candidateObj,
      mismatch_reasons: [`Ditemukan akun login '${c.username}' (${c.email}) yang cocok namun belum terhubung ke ID karyawan.`]
    };
  }

  // candidates.length > 1: Ambiguous
  return {
    employee_id: Number(emp.id),
    employee_name: emp.full_name,
    employee_code: emp.employee_code,
    employee_email: emp.email || null,
    employee_username: emp.username || null,
    employee_role: emp.role,
    employee_active: isEmpActive,
    linked_user_id: null,
    login_email: null,
    username: null,
    account_status: null,
    is_active: null,
    must_change_password: null,
    role_name: null,
    temp_password_expires_at: null,
    diagnosis_state: 'AMBIGUOUS_MATCH',
    diagnosis_states: ['AMBIGUOUS_MATCH'],
    candidate_user: null,
    mismatch_reasons: [`Ditemukan ${candidates.length} akun pengguna yang cocok dengan email/username. Diperlukan peninjauan manual.`]
  };
}

export async function repairEmployeeLoginAccount(
  client: PoolClient,
  propertyId: number,
  employeeId: number,
  payload: AccountRepairActionPayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ status: string; message: string; data?: any }> {
  const empRes = await client.query(
    'SELECT * FROM hr_employees WHERE id = $1 AND property_id = $2',
    [employeeId, propertyId]
  );

  if (!hasRows(empRes)) {
    throw Object.assign(new Error(`Karyawan dengan ID ${employeeId} tidak ditemukan pada properti ini.`), {
      statusCode: 404,
      code: 'EMPLOYEE_NOT_FOUND'
    });
  }

  const emp = empRes.rows[0];

  switch (payload.action) {
    case 'LINK_UNAMBIGUOUS_ACCOUNT': {
      const diag = await diagnoseEmployeeLoginAccount(client, propertyId, employeeId);
      if (diag.diagnosis_state !== 'UNLINKED_MATCH_FOUND' || !diag.candidate_user) {
        throw Object.assign(
          new Error('Hanya akun yang cocok secara unik dan belum terhubung yang dapat dihubungkan otomatis.'),
          { statusCode: 400, code: 'CANNOT_LINK_ACCOUNT' }
        );
      }

      if (payload.target_user_id && payload.target_user_id !== diag.candidate_user.id) {
        throw Object.assign(new Error('Target user ID tidak sesuai dengan kandidat akun hasil diagnosa.'), {
          statusCode: 400,
          code: 'TARGET_MISMATCH'
        });
      }

      const targetUserId = diag.candidate_user.id;

      // Lock and update
      const updateRes = await client.query(
        `UPDATE users
         SET employee_id = $1, updated_at = NOW()
         WHERE id = $2 AND property_id = $3 AND employee_id IS NULL
         RETURNING id, username, email`,
        [employeeId, targetUserId, propertyId]
      );

      if ((updateRes.rowCount ?? 0) === 0) {
        throw Object.assign(
          new Error('Gagal menghubungkan akun: akun mungkin sudah terhubung dengan karyawan lain atau tidak ditemukan.'),
          { statusCode: 409, code: 'LINK_FAILED' }
        );
      }

      // Also ensure employee username/email are synced if previously empty
      await client.query(
        `UPDATE hr_employees
         SET username = COALESCE(username, $1),
             email = COALESCE(email, $2),
             updated_at = NOW()
         WHERE id = $3 AND property_id = $4`,
        [diag.candidate_user.username, diag.candidate_user.email, employeeId, propertyId]
      );

      // Audit log
      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'HRD',
          'AUTH_ACCOUNT_LINKED',
          'USER_AUTH',
          String(targetUserId),
          JSON.stringify({
            employee_id: employeeId,
            target_user_id: targetUserId,
            action: 'LINK_UNAMBIGUOUS_ACCOUNT',
            reason: payload.reason || 'HRD explicit link'
          }),
          actor?.name || 'HRD',
          propertyId
        ]
      );

      return {
        status: 'OK',
        message: `Akun login '${diag.candidate_user.username}' berhasil dihubungkan ke karyawan '${emp.full_name}'.`,
        data: { user_id: targetUserId, employee_id: employeeId }
      };
    }

    case 'SYNC_LOGIN_EMAIL': {
      const userRes = await client.query(
        'SELECT id, email FROM users WHERE employee_id = $1 AND property_id = $2',
        [employeeId, propertyId]
      );
      if (!hasRows(userRes)) {
        throw Object.assign(new Error('Tidak ditemukan akun login yang terhubung dengan karyawan ini.'), {
          statusCode: 400,
          code: 'NO_LINKED_ACCOUNT'
        });
      }
      const u = userRes.rows[0];
      const targetEmail = emp.email ? emp.email.trim().toLowerCase() : '';
      if (!targetEmail) {
        throw Object.assign(new Error('Email pada data karyawan belum diisi.'), {
          statusCode: 400,
          code: 'EMPLOYEE_EMAIL_EMPTY'
        });
      }

      // Check collision
      const col = await client.query(
        'SELECT id FROM users WHERE LOWER(email) = $1 AND id != $2',
        [targetEmail, u.id]
      );
      if ((col.rowCount ?? 0) > 0) {
        throw Object.assign(new Error(`Email '${targetEmail}' sudah digunakan akun pengguna lain.`), {
          statusCode: 400,
          code: 'EMAIL_ALREADY_EXISTS'
        });
      }

      await client.query('UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2', [targetEmail, u.id]);

      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'HRD',
          'LOGIN_EMAIL_SYNCED',
          'USER_AUTH',
          String(u.id),
          JSON.stringify({ old_email: u.email, new_email: targetEmail, employee_id: employeeId }),
          actor?.name || 'HRD',
          propertyId
        ]
      );

      return {
        status: 'OK',
        message: `Email akun login berhasil disinkronkan menjadi '${targetEmail}'.`,
        data: { user_id: u.id, email: targetEmail }
      };
    }

    case 'SYNC_USERNAME': {
      const userRes = await client.query(
        'SELECT id, username FROM users WHERE employee_id = $1 AND property_id = $2',
        [employeeId, propertyId]
      );
      if (!hasRows(userRes)) {
        throw Object.assign(new Error('Tidak ditemukan akun login yang terhubung dengan karyawan ini.'), {
          statusCode: 400,
          code: 'NO_LINKED_ACCOUNT'
        });
      }
      const u = userRes.rows[0];
      const targetUsername = emp.username ? emp.username.trim().toLowerCase() : '';
      if (!targetUsername) {
        throw Object.assign(new Error('Username pada data karyawan belum diisi.'), {
          statusCode: 400,
          code: 'EMPLOYEE_USERNAME_EMPTY'
        });
      }

      // Check collision
      const col = await client.query(
        'SELECT id FROM users WHERE LOWER(username) = $1 AND id != $2',
        [targetUsername, u.id]
      );
      if ((col.rowCount ?? 0) > 0) {
        throw Object.assign(new Error(`Username '${targetUsername}' sudah digunakan akun pengguna lain.`), {
          statusCode: 400,
          code: 'USERNAME_ALREADY_EXISTS'
        });
      }

      await client.query('UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2', [targetUsername, u.id]);

      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'HRD',
          'LOGIN_USERNAME_SYNCED',
          'USER_AUTH',
          String(u.id),
          JSON.stringify({ old_username: u.username, new_username: targetUsername, employee_id: employeeId }),
          actor?.name || 'HRD',
          propertyId
        ]
      );

      return {
        status: 'OK',
        message: `Username akun login berhasil disinkronkan menjadi '${targetUsername}'.`,
        data: { user_id: u.id, username: targetUsername }
      };
    }

    case 'SYNC_ROLE': {
      const userRes = await client.query(
        'SELECT id, role_id FROM users WHERE employee_id = $1 AND property_id = $2',
        [employeeId, propertyId]
      );
      if (!hasRows(userRes)) {
        throw Object.assign(new Error('Tidak ditemukan akun login yang terhubung dengan karyawan ini.'), {
          statusCode: 400,
          code: 'NO_LINKED_ACCOUNT'
        });
      }
      const u = userRes.rows[0];
      if (emp.role?.trim().toLowerCase() === 'crew') {
        throw Object.assign(
          new Error("Role 'Crew' bukan peran otorisasi sistem (Auth Role). Akun login membutuhkan peran otorisasi valid. Untuk staf tanpa hak akses PMS desktop, gunakan tipe akses MOBILE_ONLY."),
          { statusCode: 400, code: 'INVALID_AUTH_ROLE' }
        );
      }
      const targetRoleName = normalizeRoleName(emp.role);
      await validateRoleAssignment(client, propertyId, targetRoleName, actor);
      const targetRoleId = await resolveCanonicalRoleId(client, targetRoleName, propertyId);

      await client.query('UPDATE users SET role_id = $1, updated_at = NOW() WHERE id = $2', [targetRoleId, u.id]);

      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'HRD',
          'LOGIN_ROLE_SYNCED',
          'USER_AUTH',
          String(u.id),
          JSON.stringify({ old_role_id: u.role_id, new_role_id: targetRoleId, role: targetRoleName, employee_id: employeeId }),
          actor?.name || 'HRD',
          propertyId
        ]
      );

      return {
        status: 'OK',
        message: `Role akun login berhasil disinkronkan menjadi '${targetRoleName}'.`,
        data: { user_id: u.id, role_id: targetRoleId, role: targetRoleName }
      };
    }

    case 'REACTIVATE_ACCOUNT': {
      if (emp.is_active === false || emp.status !== 'ACTIVE') {
        throw Object.assign(new Error('Data karyawan berstatus non-aktif. Aktifkan karyawan terlebih dahulu sebelum mengaktifkan akun login.'), {
          statusCode: 400,
          code: 'EMPLOYEE_DISABLED'
        });
      }

      const userRes = await client.query(
        'SELECT id, is_active FROM users WHERE employee_id = $1 AND property_id = $2',
        [employeeId, propertyId]
      );
      if (!hasRows(userRes)) {
        throw Object.assign(new Error('Tidak ditemukan akun login yang terhubung dengan karyawan ini.'), {
          statusCode: 400,
          code: 'NO_LINKED_ACCOUNT'
        });
      }
      const u = userRes.rows[0];

      await client.query('UPDATE users SET is_active = TRUE, updated_at = NOW() WHERE id = $1', [u.id]);

      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'HRD',
          'ACCOUNT_REACTIVATED',
          'USER_AUTH',
          String(u.id),
          JSON.stringify({ is_active: true, employee_id: employeeId }),
          actor?.name || 'HRD',
          propertyId
        ]
      );

      return {
        status: 'OK',
        message: 'Akun login berhasil diaktifkan kembali.',
        data: { user_id: u.id, is_active: true }
      };
    }

    default:
      throw Object.assign(new Error(`Aksi perbaikan '${(payload as any).action}' tidak dikenali.`), {
        statusCode: 400,
        code: 'UNKNOWN_REPAIR_ACTION'
      });
  }
}

export async function resetEmployeePassword(
  client: PoolClient,
  propertyId: number,
  employeeId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<PasswordResetResult> {
  const empRes = await client.query(
    'SELECT * FROM hr_employees WHERE id = $1 AND property_id = $2',
    [employeeId, propertyId]
  );

  if (!hasRows(empRes)) {
    throw Object.assign(new Error(`Karyawan dengan ID ${employeeId} tidak ditemukan pada properti ini.`), {
      statusCode: 404,
      code: 'EMPLOYEE_NOT_FOUND'
    });
  }

  const emp = empRes.rows[0];

  if (emp.is_active === false || emp.status !== 'ACTIVE') {
    throw Object.assign(
      new Error(`Tidak dapat mereset password: data karyawan '${emp.full_name}' berstatus nonaktif. Aktifkan karyawan terlebih dahulu.`),
      { statusCode: 400, code: 'EMPLOYEE_DEACTIVATED' }
    );
  }

  // 1. Resolve user by users.employee_id
  const directUserRes = await client.query(
    'SELECT * FROM users WHERE employee_id = $1 AND property_id = $2',
    [employeeId, propertyId]
  );

  let targetUser: any = null;

  if (hasRows(directUserRes)) {
    targetUser = directUserRes.rows[0];
  } else {
    // Fallback: check if exactly one unambiguous same-property user exists by normalized email where employee_id IS NULL
    const cleanEmail = emp.email ? emp.email.trim().toLowerCase() : '';
    if (!cleanEmail) {
      throw Object.assign(
        new Error('Karyawan belum memiliki akun login yang terhubung dan tidak memiliki email untuk pencarian akun.'),
        { statusCode: 400, code: 'REVIEW_REQUIRED' }
      );
    }

    const candRes = await client.query(
      'SELECT * FROM users WHERE LOWER(email) = $1 AND property_id = $2',
      [cleanEmail, propertyId]
    );

    if (candRes.rows.length === 1 && candRes.rows[0].employee_id === null) {
      // Unambiguous candidate: safely link first
      const linkedRes = await client.query(
        `UPDATE users
         SET employee_id = $1, updated_at = NOW()
         WHERE id = $2 AND property_id = $3 AND employee_id IS NULL
         RETURNING *`,
        [employeeId, candRes.rows[0].id, propertyId]
      );

      if (!hasRows(linkedRes)) {
        throw Object.assign(
          new Error('Gagal menghubungkan akun secara otomatis. Silakan lakukan diagnosa akun.'),
          { statusCode: 409, code: 'REVIEW_REQUIRED' }
        );
      }

      targetUser = linkedRes.rows[0];

      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'HRD',
          'AUTH_ACCOUNT_LINKED',
          'USER_AUTH',
          String(targetUser.id),
          JSON.stringify({ employee_id: employeeId, target_user_id: targetUser.id, context: 'RESET_PASSWORD_AUTO_LINK' }),
          actor?.name || 'HRD',
          propertyId
        ]
      );
    } else {
      throw Object.assign(
        new Error('Karyawan belum terhubung dengan akun login atau terdapat ambiguitas akun. Lakukan diagnosa dan perbaikan akun terlebih dahulu.'),
        { statusCode: 400, code: 'REVIEW_REQUIRED' }
      );
    }
  }

  // Generate secure temporary password
  const tempPassword = generateSecureTemporaryPassword(12);
  const passwordHash = await hashPassword(tempPassword);
  const tempExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Update target user - never assume hr_employees.id == users.id
  const updatedUserRes = await client.query(
    `UPDATE users
     SET password_hash = $1,
         must_change_password = TRUE,
         account_status = 'FIRST_LOGIN_REQUIRED',
         temp_password_expires_at = $2,
         updated_at = NOW()
     WHERE id = $3 AND property_id = $4
     RETURNING id, username, email, account_status, must_change_password`,
    [passwordHash, tempExpiresAt, targetUser.id, propertyId]
  );

  const updatedUser = updatedUserRes.rows[0];

  // Revoke existing ACTIVE face enrollment if present (AUTH-HR-2D: HR_PASSWORD_RESET)
  const revokeFaceRes = await client.query(
    `UPDATE employee_face_enrollments
     SET status = 'REVOKED',
         revoked_at = NOW(),
         revoked_by_user_id = $1,
         revocation_reason = $2,
         updated_at = NOW()
     WHERE employee_id = $3 AND property_id = $4 AND status = 'ACTIVE'
     RETURNING id, reference_photo_storage_key, reference_photo_hash`,
    [actor?.id || null, 'HR_PASSWORD_RESET', employeeId, propertyId]
  );

  // Audit log for each revoked face enrollment (preserve history, do not delete)
  for (const faceRow of revokeFaceRes.rows) {
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'AUTH',
        'FACE_ENROLLMENT_REVOKED_FOR_PASSWORD_RESET',
        'EMPLOYEE_FACE_ENROLLMENT',
        String(faceRow.id),
        JSON.stringify({
          employee_id: employeeId,
          target_user_id: updatedUser.id,
          revoked_by_user_id: actor?.id || null,
          revoked_by_name: actor?.name || 'HRD Admin',
          revocation_reason: 'HR_PASSWORD_RESET',
          storage_key: faceRow.reference_photo_storage_key,
          photo_hash: faceRow.reference_photo_hash
        }),
        actor?.name || 'HRD',
        propertyId
      ]
    );
  }

  // Audit log: Mandatory face re-enrollment required
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'AUTH',
      'FACE_REENROLLMENT_REQUIRED',
      'USER_AUTH',
      String(updatedUser.id),
      JSON.stringify({
        employee_id: employeeId,
        target_user_id: updatedUser.id,
        reason: 'HR_PASSWORD_RESET',
        prior_active_face_revoked: revokeFaceRes.rows.length > 0
      }),
      actor?.name || 'HRD',
      propertyId
    ]
  );

  // Audit log - NEVER log password or hash
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'PASSWORD_RESET',
      'USER_AUTH',
      String(updatedUser.id),
      JSON.stringify({
        target_user_id: updatedUser.id,
        employee_id: employeeId,
        account_status: 'FIRST_LOGIN_REQUIRED',
        must_change_password: true,
        temp_password_expires_at: tempExpiresAt.toISOString(),
        prior_active_face_revoked: revokeFaceRes.rows.length > 0,
        face_revocation_count: revokeFaceRes.rows.length
      }),
      actor?.name || 'HRD',
      propertyId
    ]
  );

  return {
    employee_id: employeeId,
    user_id: Number(updatedUser.id),
    username: updatedUser.username,
    email: updatedUser.email,
    phone: emp.phone || null,
    temporary_password: tempPassword,
    temp_password_expires_at: tempExpiresAt.toISOString(),
    must_change_password: true,
    account_status: updatedUser.account_status,
    face_revoked: revokeFaceRes.rows.length > 0
  };
}

// ============================================================================
// HR-ACCESS-1: DEPARTMENT MASTER SERVICE
// ============================================================================

export async function getDepartments(
  client: PoolClient,
  propertyId: number,
  options?: { include_inactive?: boolean }
): Promise<HrDepartment[]> {
  const includeInactive = Boolean(options?.include_inactive);
  const res = await client.query(
    `SELECT d.*, COUNT(e.id)::int AS employee_count
     FROM hr_departments d
     LEFT JOIN hr_employees e ON e.department_id = d.id AND COALESCE(e.is_active, TRUE) = TRUE
     WHERE d.property_id = $1
       AND ($2 = TRUE OR d.is_active = TRUE)
     GROUP BY d.id
     ORDER BY d.sort_order ASC, d.name ASC`,
    [propertyId, includeInactive]
  );

  return res.rows.map(r => ({
    id: Number(r.id),
    property_id: Number(r.property_id),
    code: r.code,
    name: r.name,
    description: r.description,
    is_active: r.is_active !== false,
    sort_order: Number(r.sort_order || 0),
    employee_count: Number(r.employee_count || 0),
    created_at: r.created_at,
    created_by: r.created_by,
    updated_at: r.updated_at,
    updated_by: r.updated_by
  }));
}

export async function createDepartment(
  client: PoolClient,
  payload: CreateDepartmentPayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<HrDepartment> {
  const code = (payload.code || '').trim().toUpperCase();
  const name = (payload.name || '').trim();

  if (!code || !name) {
    throw Object.assign(new Error('Kode dan nama departemen wajib diisi.'), { statusCode: 400, code: 'INVALID_INPUT' });
  }

  // Check code uniqueness
  const codeCheck = await client.query(
    'SELECT id FROM hr_departments WHERE property_id = $1 AND UPPER(code) = $2',
    [payload.property_id, code]
  );
  if (codeCheck.rows.length > 0) {
    throw Object.assign(new Error(`Kode departemen '${code}' sudah digunakan pada properti ini.`), { statusCode: 409, code: 'DEPARTMENT_CODE_EXISTS' });
  }

  // Check name uniqueness
  const nameCheck = await client.query(
    'SELECT id FROM hr_departments WHERE property_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
    [payload.property_id, name]
  );
  if (nameCheck.rows.length > 0) {
    throw Object.assign(new Error(`Nama departemen '${name}' sudah digunakan pada properti ini.`), { statusCode: 409, code: 'DEPARTMENT_NAME_EXISTS' });
  }

  const res = await client.query(
    `INSERT INTO hr_departments (property_id, code, name, description, sort_order, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      payload.property_id,
      code,
      name,
      payload.description || null,
      payload.sort_order || 0,
      payload.is_active !== false,
      actor?.name || 'HRD'
    ]
  );

  const created = res.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'DEPARTMENT_CREATED',
      'hr_departments',
      String(created.id),
      JSON.stringify({ code: created.code, name: created.name }),
      actor?.name || 'HRD',
      payload.property_id
    ]
  );

  return {
    ...created,
    id: Number(created.id),
    property_id: Number(created.property_id),
    sort_order: Number(created.sort_order || 0),
    employee_count: 0,
    is_active: created.is_active !== false
  };
}

export async function updateDepartment(
  client: PoolClient,
  propertyId: number,
  departmentId: number,
  payload: UpdateDepartmentPayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<HrDepartment> {
  const currentRes = await client.query(
    'SELECT * FROM hr_departments WHERE id = $1 AND property_id = $2',
    [departmentId, propertyId]
  );
  if (currentRes.rows.length === 0) {
    throw Object.assign(new Error('Departemen tidak ditemukan.'), { statusCode: 404, code: 'DEPARTMENT_NOT_FOUND' });
  }
  const current = currentRes.rows[0];

  const code = payload.code !== undefined ? payload.code.trim().toUpperCase() : current.code;
  const name = payload.name !== undefined ? payload.name.trim() : current.name;

  if (code !== current.code) {
    const codeCheck = await client.query(
      'SELECT id FROM hr_departments WHERE property_id = $1 AND UPPER(code) = $2 AND id != $3',
      [propertyId, code, departmentId]
    );
    if (codeCheck.rows.length > 0) {
      throw Object.assign(new Error(`Kode departemen '${code}' sudah digunakan pada properti ini.`), { statusCode: 409, code: 'DEPARTMENT_CODE_EXISTS' });
    }
  }

  if (name !== current.name) {
    const nameCheck = await client.query(
      'SELECT id FROM hr_departments WHERE property_id = $1 AND LOWER(name) = LOWER($2) AND id != $3',
      [propertyId, name, departmentId]
    );
    if (nameCheck.rows.length > 0) {
      throw Object.assign(new Error(`Nama departemen '${name}' sudah digunakan pada properti ini.`), { statusCode: 409, code: 'DEPARTMENT_NAME_EXISTS' });
    }
  }

  const description = payload.description !== undefined ? payload.description : current.description;
  const sortOrder = payload.sort_order !== undefined ? payload.sort_order : current.sort_order;
  const isActive = payload.is_active !== undefined ? Boolean(payload.is_active) : current.is_active;

  const res = await client.query(
    `UPDATE hr_departments
     SET code = $1, name = $2, description = $3, sort_order = $4, is_active = $5, updated_at = NOW(), updated_by = $6
     WHERE id = $7 AND property_id = $8
     RETURNING *`,
    [code, name, description, sortOrder, isActive, actor?.name || 'HRD', departmentId, propertyId]
  );

  const updated = res.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'DEPARTMENT_UPDATED',
      'hr_departments',
      String(updated.id),
      JSON.stringify({ previous: current, updated }),
      actor?.name || 'HRD',
      propertyId
    ]
  );

  return {
    ...updated,
    id: Number(updated.id),
    property_id: Number(updated.property_id),
    sort_order: Number(updated.sort_order || 0),
    is_active: updated.is_active !== false
  };
}

export async function deactivateDepartment(
  client: PoolClient,
  propertyId: number,
  departmentId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; message: string; department: HrDepartment }> {
  const current = await client.query('SELECT * FROM hr_departments WHERE id = $1 AND property_id = $2', [departmentId, propertyId]);
  if (current.rows.length === 0) {
    throw Object.assign(new Error('Departemen tidak ditemukan.'), { statusCode: 404, code: 'DEPARTMENT_NOT_FOUND' });
  }

  const res = await client.query(
    'UPDATE hr_departments SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND property_id = $2 RETURNING *',
    [departmentId, propertyId]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HRD', 'DEPARTMENT_DEACTIVATED', 'hr_departments', String(departmentId), JSON.stringify({ id: departmentId, is_active: false }), actor?.name || 'HRD', propertyId]
  );

  return {
    success: true,
    message: 'Departemen berhasil dinonaktifkan.',
    department: {
      ...res.rows[0],
      id: Number(res.rows[0].id),
      property_id: Number(res.rows[0].property_id),
      is_active: false
    }
  };
}

export async function reactivateDepartment(
  client: PoolClient,
  propertyId: number,
  departmentId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; message: string; department: HrDepartment }> {
  const current = await client.query('SELECT * FROM hr_departments WHERE id = $1 AND property_id = $2', [departmentId, propertyId]);
  if (current.rows.length === 0) {
    throw Object.assign(new Error('Departemen tidak ditemukan.'), { statusCode: 404, code: 'DEPARTMENT_NOT_FOUND' });
  }

  const res = await client.query(
    'UPDATE hr_departments SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND property_id = $2 RETURNING *',
    [departmentId, propertyId]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HRD', 'DEPARTMENT_ACTIVATED', 'hr_departments', String(departmentId), JSON.stringify({ id: departmentId, is_active: true }), actor?.name || 'HRD', propertyId]
  );

  return {
    success: true,
    message: 'Departemen berhasil diaktifkan kembali.',
    department: {
      ...res.rows[0],
      id: Number(res.rows[0].id),
      property_id: Number(res.rows[0].property_id),
      is_active: true
    }
  };
}

export async function hardDeleteDepartment(
  client: PoolClient,
  propertyId: number,
  departmentId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; message: string }> {
  const current = await client.query('SELECT * FROM hr_departments WHERE id = $1 AND property_id = $2', [departmentId, propertyId]);
  if (current.rows.length === 0) {
    throw Object.assign(new Error('Departemen tidak ditemukan.'), { statusCode: 404, code: 'DEPARTMENT_NOT_FOUND' });
  }

  const empCheck = await client.query(
    'SELECT id FROM hr_employees WHERE department_id = $1 LIMIT 1',
    [departmentId]
  );
  if (empCheck.rows.length > 0) {
    throw Object.assign(
      new Error('Departemen tidak dapat dihapus permanen karena masih memiliki data karyawan terhubung. Nonaktifkan departemen alih-alih menghapusnya.'),
      { statusCode: 409, code: 'DEPARTMENT_HAS_EMPLOYEES' }
    );
  }

  const posCheck = await client.query(
    'SELECT id FROM hr_positions WHERE department_id = $1 LIMIT 1',
    [departmentId]
  );
  if (posCheck.rows.length > 0) {
    throw Object.assign(
      new Error('Departemen tidak dapat dihapus permanen karena masih memiliki daftar jabatan terkait.'),
      { statusCode: 409, code: 'DEPARTMENT_HAS_POSITIONS' }
    );
  }

  // Check schedule group departments
  try {
    const groupCheck = await client.query(
      'SELECT group_id FROM schedule_group_departments WHERE department_id = $1 LIMIT 1',
      [departmentId]
    );
    if (groupCheck.rows.length > 0) {
      throw Object.assign(
        new Error('Departemen tidak dapat dihapus permanen karena masih terdaftar dalam group operasional jadwal.'),
        { statusCode: 409, code: 'DEPARTMENT_HAS_SCHEDULE_GROUPS' }
      );
    }
  } catch (err: any) {
    if (err.statusCode === 409) throw err;
  }

  // Clean 1:1 department work pattern if present
  try {
    await client.query('DELETE FROM department_work_patterns WHERE department_id = $1', [departmentId]);
  } catch {}

  await client.query('DELETE FROM hr_departments WHERE id = $1 AND property_id = $2', [departmentId, propertyId]);

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HRD', 'DEPARTMENT_HARD_DELETED', 'hr_departments', String(departmentId), JSON.stringify({ id: departmentId, name: current.rows[0].name }), actor?.name || 'Super Admin', propertyId]
  );

  return { success: true, message: 'Departemen berhasil dihapus permanen.' };
}

export async function deleteDepartment(
  client: PoolClient,
  propertyId: number,
  departmentId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; message: string }> {
  const result = await deactivateDepartment(client, propertyId, departmentId, actor);
  return { success: true, message: result.message };
}

// ============================================================================
// HR-ACCESS-1: POSITION MASTER SERVICE
// ============================================================================

export async function getPositions(
  client: PoolClient,
  propertyId: number,
  options?: { department_id?: number; include_inactive?: boolean }
): Promise<HrPosition[]> {
  const includeInactive = Boolean(options?.include_inactive);
  const deptId = options?.department_id ? Number(options.department_id) : null;

  const res = await client.query(
    `SELECT p.*, d.name AS department_name, d.code AS department_code, COUNT(e.id)::int AS employee_count
     FROM hr_positions p
     LEFT JOIN hr_departments d ON d.id = p.department_id
     LEFT JOIN hr_employees e ON e.position_id = p.id AND COALESCE(e.is_active, TRUE) = TRUE
     WHERE p.property_id = $1
       AND ($2 = TRUE OR p.is_active = TRUE)
       AND ($3::int IS NULL OR p.department_id = $3::int)
     GROUP BY p.id, d.name, d.code, d.sort_order
     ORDER BY COALESCE(d.sort_order, 999) ASC, p.sort_order ASC, p.name ASC`,
    [propertyId, includeInactive, deptId]
  );

  return res.rows.map(r => ({
    id: Number(r.id),
    property_id: Number(r.property_id),
    department_id: r.department_id ? Number(r.department_id) : null,
    department_name: r.department_name || null,
    department_code: r.department_code || null,
    code: r.code || null,
    name: r.name,
    description: r.description || null,
    is_active: r.is_active !== false,
    sort_order: Number(r.sort_order || 0),
    employee_count: Number(r.employee_count || 0),
    created_at: r.created_at,
    created_by: r.created_by,
    updated_at: r.updated_at,
    updated_by: r.updated_by
  }));
}

export async function createPosition(
  client: PoolClient,
  payload: CreatePositionPayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<HrPosition> {
  const name = (payload.name || '').trim();
  if (!name) {
    throw Object.assign(new Error('Nama jabatan wajib diisi.'), { statusCode: 400, code: 'INVALID_INPUT' });
  }

  let deptName = null;
  let deptCode = null;
  if (payload.department_id) {
    const dRes = await client.query('SELECT name, code FROM hr_departments WHERE id = $1 AND property_id = $2', [payload.department_id, payload.property_id]);
    if (dRes.rows.length === 0) {
      throw Object.assign(new Error('Departemen tidak ditemukan.'), { statusCode: 400, code: 'DEPARTMENT_NOT_FOUND' });
    }
    deptName = dRes.rows[0].name;
    deptCode = dRes.rows[0].code;
  }

  const dupCheck = await client.query(
    `SELECT id FROM hr_positions
     WHERE property_id = $1
       AND (department_id = $2 OR ($2::int IS NULL AND department_id IS NULL))
       AND LOWER(name) = LOWER($3)`,
    [payload.property_id, payload.department_id || null, name]
  );
  if (dupCheck.rows.length > 0) {
    throw Object.assign(new Error(`Jabatan '${name}' sudah ada pada departemen yang dipilih.`), { statusCode: 409, code: 'POSITION_NAME_EXISTS' });
  }

  const res = await client.query(
    `INSERT INTO hr_positions (property_id, department_id, code, name, description, sort_order, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      payload.property_id,
      payload.department_id || null,
      payload.code || null,
      name,
      payload.description || null,
      payload.sort_order || 0,
      payload.is_active !== false,
      actor?.name || 'HRD'
    ]
  );

  const created = res.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'POSITION_CREATED',
      'hr_positions',
      String(created.id),
      JSON.stringify({ name: created.name, department_id: created.department_id }),
      actor?.name || 'HRD',
      payload.property_id
    ]
  );

  return {
    ...created,
    id: Number(created.id),
    property_id: Number(created.property_id),
    department_id: created.department_id ? Number(created.department_id) : null,
    department_name: deptName,
    department_code: deptCode,
    sort_order: Number(created.sort_order || 0),
    employee_count: 0,
    is_active: created.is_active !== false
  };
}

export async function updatePosition(
  client: PoolClient,
  propertyId: number,
  positionId: number,
  payload: UpdatePositionPayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<HrPosition> {
  const currentRes = await client.query(
    'SELECT * FROM hr_positions WHERE id = $1 AND property_id = $2',
    [positionId, propertyId]
  );
  if (currentRes.rows.length === 0) {
    throw Object.assign(new Error('Jabatan tidak ditemukan.'), { statusCode: 404, code: 'POSITION_NOT_FOUND' });
  }
  const current = currentRes.rows[0];

  const name = payload.name !== undefined ? payload.name.trim() : current.name;
  const deptId = payload.department_id !== undefined ? (payload.department_id ? Number(payload.department_id) : null) : current.department_id;


  if (name !== current.name || deptId !== current.department_id) {
    const dupCheck = await client.query(
      `SELECT id FROM hr_positions
       WHERE property_id = $1
         AND (department_id = $2 OR ($2::int IS NULL AND department_id IS NULL))
         AND LOWER(name) = LOWER($3)
         AND id != $4`,
      [propertyId, deptId, name, positionId]
    );
    if (dupCheck.rows.length > 0) {
      throw Object.assign(new Error(`Jabatan '${name}' sudah ada pada departemen yang dipilih.`), { statusCode: 409, code: 'POSITION_NAME_EXISTS' });
    }
  }

  const code = payload.code !== undefined ? payload.code : current.code;
  const description = payload.description !== undefined ? payload.description : current.description;
  const sortOrder = payload.sort_order !== undefined ? payload.sort_order : current.sort_order;
  const isActive = payload.is_active !== undefined ? Boolean(payload.is_active) : current.is_active;

  const res = await client.query(
    `UPDATE hr_positions
     SET department_id = $1, code = $2, name = $3, description = $4, sort_order = $5, is_active = $6, updated_at = NOW(), updated_by = $7
     WHERE id = $8 AND property_id = $9
     RETURNING *`,
    [deptId, code, name, description, sortOrder, isActive, actor?.name || 'HRD', positionId, propertyId]
  );

  const updated = res.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'POSITION_UPDATED',
      'hr_positions',
      String(updated.id),
      JSON.stringify({ previous: current, updated }),
      actor?.name || 'HRD',
      propertyId
    ]
  );

  return {
    ...updated,
    id: Number(updated.id),
    property_id: Number(updated.property_id),
    department_id: updated.department_id ? Number(updated.department_id) : null,
    sort_order: Number(updated.sort_order || 0),
    is_active: updated.is_active !== false
  };
}

export async function deactivatePosition(
  client: PoolClient,
  propertyId: number,
  positionId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; message: string; position: HrPosition }> {
  const current = await client.query('SELECT * FROM hr_positions WHERE id = $1 AND property_id = $2', [positionId, propertyId]);
  if (current.rows.length === 0) {
    throw Object.assign(new Error('Jabatan tidak ditemukan.'), { statusCode: 404, code: 'POSITION_NOT_FOUND' });
  }

  const res = await client.query(
    'UPDATE hr_positions SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND property_id = $2 RETURNING *',
    [positionId, propertyId]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HRD', 'POSITION_DEACTIVATED', 'hr_positions', String(positionId), JSON.stringify({ id: positionId, is_active: false }), actor?.name || 'HRD', propertyId]
  );

  return {
    success: true,
    message: 'Jabatan berhasil dinonaktifkan.',
    position: {
      ...res.rows[0],
      id: Number(res.rows[0].id),
      property_id: Number(res.rows[0].property_id),
      department_id: res.rows[0].department_id ? Number(res.rows[0].department_id) : null,
      is_active: false
    }
  };
}

export async function reactivatePosition(
  client: PoolClient,
  propertyId: number,
  positionId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; message: string; position: HrPosition }> {
  const current = await client.query('SELECT * FROM hr_positions WHERE id = $1 AND property_id = $2', [positionId, propertyId]);
  if (current.rows.length === 0) {
    throw Object.assign(new Error('Jabatan tidak ditemukan.'), { statusCode: 404, code: 'POSITION_NOT_FOUND' });
  }

  const res = await client.query(
    'UPDATE hr_positions SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND property_id = $2 RETURNING *',
    [positionId, propertyId]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HRD', 'POSITION_ACTIVATED', 'hr_positions', String(positionId), JSON.stringify({ id: positionId, is_active: true }), actor?.name || 'HRD', propertyId]
  );

  return {
    success: true,
    message: 'Jabatan berhasil diaktifkan kembali.',
    position: {
      ...res.rows[0],
      id: Number(res.rows[0].id),
      property_id: Number(res.rows[0].property_id),
      department_id: res.rows[0].department_id ? Number(res.rows[0].department_id) : null,
      is_active: true
    }
  };
}

export async function hardDeletePosition(
  client: PoolClient,
  propertyId: number,
  positionId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; message: string }> {
  const current = await client.query('SELECT * FROM hr_positions WHERE id = $1 AND property_id = $2', [positionId, propertyId]);
  if (current.rows.length === 0) {
    throw Object.assign(new Error('Jabatan tidak ditemukan.'), { statusCode: 404, code: 'POSITION_NOT_FOUND' });
  }

  const empCheck = await client.query(
    'SELECT id FROM hr_employees WHERE position_id = $1 LIMIT 1',
    [positionId]
  );
  if (empCheck.rows.length > 0) {
    throw Object.assign(
      new Error('Jabatan tidak dapat dihapus permanen karena masih digunakan oleh data karyawan. Nonaktifkan jabatan alih-alih menghapusnya.'),
      { statusCode: 409, code: 'POSITION_HAS_EMPLOYEES' }
    );
  }

  await client.query('DELETE FROM hr_positions WHERE id = $1 AND property_id = $2', [positionId, propertyId]);

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HRD', 'POSITION_HARD_DELETED', 'hr_positions', String(positionId), JSON.stringify({ id: positionId, name: current.rows[0].name }), actor?.name || 'Super Admin', propertyId]
  );

  return { success: true, message: 'Jabatan berhasil dihapus permanen.' };
}

export async function deletePosition(
  client: PoolClient,
  propertyId: number,
  positionId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; message: string }> {
  const result = await deactivatePosition(client, propertyId, positionId, actor);
  return { success: true, message: result.message };
}

// ============================================================================
// HR-ACCESS-1: DYNAMIC ROLE & GRANULAR PERMISSION SERVICE
// ============================================================================

export async function getDynamicRoles(
  client: PoolClient,
  propertyId?: number
): Promise<DynamicRole[]> {
  const targetPropId = propertyId ? Number(propertyId) : 1;
  const res = await client.query(
    `SELECT r.*,
       COUNT(
         CASE
           WHEN u.id IS NOT NULL
             AND u.is_active = TRUE
             AND (
               -- Custom role: only users in its property
               (r.property_id IS NOT NULL AND u.property_id = r.property_id)
               OR
               -- System role: users in requested property context ($1) or global/unscoped users
               (r.property_id IS NULL AND (u.property_id = $1 OR u.property_id IS NULL))
             )
           THEN 1
           ELSE NULL
         END
       )::int AS active_user_count
     FROM roles r
     LEFT JOIN users u ON u.role_id = r.id AND u.is_active = TRUE
     WHERE (r.property_id IS NULL OR r.property_id = $1)
     GROUP BY r.id
     ORDER BY r.is_system_role DESC, r.id ASC`,
    [targetPropId]
  );

  return res.rows.map(r => ({
    id: Number(r.id),
    property_id: r.property_id ? Number(r.property_id) : null,
    name: r.name,
    description: r.description || null,
    is_system_role: Boolean(r.is_system_role),
    is_active: r.is_active !== false,
    active_user_count: Number(r.active_user_count || 0),
    user_count: Number(r.active_user_count || 0),
    created_at: r.created_at,
    created_by: r.created_by,
    updated_at: r.updated_at,
    updated_by: r.updated_by
  }));
}

export async function createDynamicRole(
  client: PoolClient,
  payload: CreateRolePayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<DynamicRole> {
  const name = (payload.name || '').trim();
  if (!name) {
    throw Object.assign(new Error('Nama role wajib diisi.'), { statusCode: 400, code: 'INVALID_INPUT' });
  }

  if (name.toLowerCase() === 'crew') {
    throw Object.assign(new Error("Role 'Crew' bukan peran otorisasi sistem yang valid."), { statusCode: 400, code: 'INVALID_AUTH_ROLE' });
  }

  const compactName = name.toLowerCase().replace(/[\s_-]+/g, '');
  if (compactName === 'superadmin') {
    throw Object.assign(
      new Error('Role Platform Super Admin tidak dapat dibuat dari manajemen properti.'),
      { statusCode: 403, code: 'CANNOT_CREATE_SUPER_ADMIN' }
    );
  }

  const targetPropId = payload.property_id ? Number(payload.property_id) : 1;

  // Custom role uniqueness: within target property OR conflicts with global system role
  const dupCheck = await client.query(
    `SELECT id FROM roles
     WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
       AND (
         is_system_role = TRUE
         OR property_id = $2
       )`,
    [name, targetPropId]
  );
  if (dupCheck.rows.length > 0) {
    throw Object.assign(new Error(`Role dengan nama '${name}' sudah terdaftar untuk properti ini.`), { statusCode: 409, code: 'ROLE_NAME_EXISTS' });
  }

  const res = await client.query(
    `INSERT INTO roles (property_id, name, description, is_system_role, is_active, created_by)
     VALUES ($1, $2, $3, FALSE, $4, $5)
     RETURNING *`,
    [
      targetPropId,
      name,
      payload.description || null,
      payload.is_active !== false,
      actor?.name || 'HRD'
    ]
  );

  const role = res.rows[0];

  if (Array.isArray(payload.permission_keys) && payload.permission_keys.length > 0) {
    for (const key of payload.permission_keys) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
         SELECT $1, id, TRUE, $2 FROM permissions WHERE key = $3
         ON CONFLICT (role_id, permission_id) DO UPDATE SET granted = TRUE`,
        [role.id, actor?.name || 'HRD', key]
      );
    }
  }

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HRD', 'ROLE_CREATED', 'roles', String(role.id), JSON.stringify({ name: role.name }), actor?.name || 'HRD', targetPropId]
  );

  return {
    ...role,
    id: Number(role.id),
    property_id: role.property_id ? Number(role.property_id) : null,
    is_system_role: false,
    is_active: role.is_active !== false,
    active_user_count: 0,
    user_count: 0
  };
}

export async function updateDynamicRole(
  client: PoolClient,
  roleId: number,
  payload: UpdateRolePayload,
  actor?: { id?: number; name?: string; role?: string }
): Promise<DynamicRole> {
  const currentRes = await client.query('SELECT * FROM roles WHERE id = $1', [roleId]);
  if (currentRes.rows.length === 0) {
    throw Object.assign(new Error('Role tidak ditemukan.'), { statusCode: 404, code: 'ROLE_NOT_FOUND' });
  }
  const current = currentRes.rows[0];
  const isCanonicalPlatformSuperAdmin =
    Boolean(current.is_system_role) &&
    current.property_id === null &&
    String(current.name || '').trim().toLowerCase() === 'super admin';

  if (isCanonicalPlatformSuperAdmin) {
    if (payload.name !== undefined && payload.name.trim().toLowerCase() !== 'super admin') {
      throw Object.assign(new Error('Role sistem Super Admin tidak dapat diubah namanya.'), { statusCode: 403, code: 'CANNOT_RENAME_SUPER_ADMIN' });
    }
    if (payload.is_active === false) {
      throw Object.assign(new Error('Role sistem Super Admin tidak dapat dinonaktifkan.'), { statusCode: 403, code: 'CANNOT_DEACTIVATE_SUPER_ADMIN' });
    }
  }

  const name = payload.name !== undefined ? payload.name.trim() : current.name;
  if (name !== current.name) {
    if (name.toLowerCase() === 'crew') {
      throw Object.assign(new Error("Role 'Crew' bukan peran otorisasi sistem yang valid."), { statusCode: 400, code: 'INVALID_AUTH_ROLE' });
    }
    const compactName = name.toLowerCase().replace(/[\s_-]+/g, '');
    if (compactName === 'superadmin' && !isCanonicalPlatformSuperAdmin) {
      throw Object.assign(
        new Error('Role properti tidak dapat diganti menjadi Platform Super Admin.'),
        { statusCode: 403, code: 'CANNOT_PROMOTE_TO_SUPER_ADMIN' }
      );
    }
    const targetPropId = current.property_id ? Number(current.property_id) : null;
    const dupCheck = await client.query(
      `SELECT id FROM roles
       WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
         AND id != $2
         AND (
           is_system_role = TRUE
           OR ($3::int IS NOT NULL AND property_id = $3::int)
           OR ($3::int IS NULL AND property_id IS NULL)
         )`,
      [name, roleId, targetPropId]
    );
    if (dupCheck.rows.length > 0) {
      throw Object.assign(new Error(`Role dengan nama '${name}' sudah digunakan untuk properti ini.`), { statusCode: 409, code: 'ROLE_NAME_EXISTS' });
    }
  }

  const description = payload.description !== undefined ? payload.description : current.description;
  const isActive = payload.is_active !== undefined ? Boolean(payload.is_active) : current.is_active;

  const res = await client.query(
    `UPDATE roles
     SET name = $1, description = $2, is_active = $3, updated_at = NOW(), updated_by = $4
     WHERE id = $5
     RETURNING *`,
    [name, description, isActive, actor?.name || 'HRD', roleId]
  );

  const updated = res.rows[0];

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HRD', 'ROLE_UPDATED', 'roles', String(updated.id), JSON.stringify({ previous: current, updated }), actor?.name || 'HRD', current.property_id || 1]
  );

  return {
    ...updated,
    id: Number(updated.id),
    property_id: updated.property_id ? Number(updated.property_id) : null,
    is_system_role: Boolean(updated.is_system_role),
    is_active: updated.is_active !== false
  };
}

export async function deactivateDynamicRole(
  client: PoolClient,
  roleId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; message: string; role: DynamicRole }> {
  const currentRes = await client.query('SELECT * FROM roles WHERE id = $1', [roleId]);
  if (currentRes.rows.length === 0) {
    throw Object.assign(new Error('Role tidak ditemukan.'), { statusCode: 404, code: 'ROLE_NOT_FOUND' });
  }
  const current = currentRes.rows[0];

  if (Boolean(current.is_system_role) && current.property_id === null && String(current.name).trim().toLowerCase() === 'super admin') {
    throw Object.assign(new Error('Role Super Admin platform tidak dapat dinonaktifkan.'), { statusCode: 403, code: 'CANNOT_DEACTIVATE_SUPER_ADMIN' });
  }

  const res = await client.query(
    'UPDATE roles SET is_active = FALSE WHERE id = $1 RETURNING *',
    [roleId]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HRD', 'ROLE_DEACTIVATED', 'roles', String(roleId), JSON.stringify({ id: roleId, is_active: false }), actor?.name || 'HRD', current.property_id || 1]
  );

  return {
    success: true,
    message: 'Role berhasil dinonaktifkan.',
    role: {
      id: Number(res.rows[0].id),
      name: res.rows[0].name,
      description: res.rows[0].description,
      is_active: false,
      is_system_role: Boolean(res.rows[0].is_system_role),
      property_id: res.rows[0].property_id ? Number(res.rows[0].property_id) : null,
      created_at: res.rows[0].created_at,
      updated_at: res.rows[0].updated_at
    }
  };
}

export async function reactivateDynamicRole(
  client: PoolClient,
  roleId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; message: string; role: DynamicRole }> {
  const currentRes = await client.query('SELECT * FROM roles WHERE id = $1', [roleId]);
  if (currentRes.rows.length === 0) {
    throw Object.assign(new Error('Role tidak ditemukan.'), { statusCode: 404, code: 'ROLE_NOT_FOUND' });
  }
  const current = currentRes.rows[0];

  const res = await client.query(
    'UPDATE roles SET is_active = TRUE WHERE id = $1 RETURNING *',
    [roleId]
  );

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HRD', 'ROLE_ACTIVATED', 'roles', String(roleId), JSON.stringify({ id: roleId, is_active: true }), actor?.name || 'HRD', current.property_id || 1]
  );

  return {
    success: true,
    message: 'Role berhasil diaktifkan kembali.',
    role: {
      id: Number(res.rows[0].id),
      name: res.rows[0].name,
      description: res.rows[0].description,
      is_active: true,
      is_system_role: Boolean(res.rows[0].is_system_role),
      property_id: res.rows[0].property_id ? Number(res.rows[0].property_id) : null,
      created_at: res.rows[0].created_at,
      updated_at: res.rows[0].updated_at
    }
  };
}

export async function hardDeleteDynamicRole(
  client: PoolClient,
  roleId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; message: string }> {
  const currentRes = await client.query('SELECT * FROM roles WHERE id = $1', [roleId]);
  if (currentRes.rows.length === 0) {
    throw Object.assign(new Error('Role tidak ditemukan.'), { statusCode: 404, code: 'ROLE_NOT_FOUND' });
  }
  const current = currentRes.rows[0];

  if (Boolean(current.is_system_role) && current.property_id === null && String(current.name).trim().toLowerCase() === 'super admin') {
    throw Object.assign(new Error('Role Super Admin platform tidak dapat dihapus.'), { statusCode: 403, code: 'CANNOT_DELETE_SUPER_ADMIN' });
  }

  if (Boolean(current.is_system_role)) {
    throw Object.assign(new Error('Role sistem bawaan tidak dapat dihapus permanen.'), { statusCode: 403, code: 'CANNOT_DELETE_SYSTEM_ROLE' });
  }

  const userCheck = await client.query('SELECT id FROM users WHERE role_id = $1 LIMIT 1', [roleId]);
  if (userCheck.rows.length > 0) {
    throw Object.assign(
      new Error('Role masih digunakan oleh pengguna. Pindahkan pengguna ke role lain sebelum menghapus permanen.'),
      { statusCode: 409, code: 'ROLE_HAS_USERS' }
    );
  }

  try {
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
  } catch {}

  await client.query('DELETE FROM roles WHERE id = $1', [roleId]);

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['HRD', 'ROLE_HARD_DELETED', 'roles', String(roleId), JSON.stringify({ id: roleId, name: current.name }), actor?.name || 'Super Admin', current.property_id || 1]
  );

  return { success: true, message: 'Role berhasil dihapus permanen.' };
}

export async function deleteDynamicRole(
  client: PoolClient,
  roleId: number,
  actor?: { id?: number; name?: string; role?: string }
): Promise<{ success: boolean; message: string }> {
  const result = await deactivateDynamicRole(client, roleId, actor);
  return { success: true, message: result.message };
}

export async function getGranularPermissions(client: PoolClient): Promise<GranularPermission[]> {
  const res = await client.query(
    `SELECT id, resource, action, key, description, is_system, created_at
     FROM permissions
     ORDER BY resource ASC, action ASC`
  );

  return res.rows.map(r => ({
    id: Number(r.id),
    resource: r.resource,
    action: r.action,
    key: r.key,
    description: r.description,
    is_system: Boolean(r.is_system),
    created_at: r.created_at
  }));
}

export async function getRoleGranularPermissions(client: PoolClient, roleId: number): Promise<string[]> {
  const res = await client.query(
    `SELECT p.key
     FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = $1 AND rp.granted = TRUE`,
    [roleId]
  );
  return res.rows.map(r => r.key);
}

export async function getGranularPermissionsMatrix(client: PoolClient, propertyId?: number): Promise<{
  roles: DynamicRole[];
  permissions: GranularPermission[];
  matrix: Record<number, Record<string, boolean>>;
}> {
  const roles = await getDynamicRoles(client, propertyId);
  const permissions = await getGranularPermissions(client);

  const grantsRes = await client.query(
    `SELECT rp.role_id, p.key, rp.granted
     FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id`
  );

  const matrix: Record<number, Record<string, boolean>> = {};
  for (const r of roles) {
    matrix[r.id] = {};
  }

  for (const g of grantsRes.rows) {
    const rId = Number(g.role_id);
    if (!matrix[rId]) matrix[rId] = {};
    matrix[rId][g.key] = Boolean(g.granted);
  }

  return { roles, permissions, matrix };
}

export async function updateRoleGranularPermissions(
  client: PoolClient,
  roleId: number,
  permissionKeys: string[],
  actor?: { id?: number; name?: string; role?: string }
): Promise<string[]> {
  const roleRes = await client.query(
    'SELECT id, name, is_system_role, property_id FROM roles WHERE id = $1',
    [roleId]
  );
  if (roleRes.rows.length === 0) {
    throw Object.assign(new Error('Role tidak ditemukan.'), { statusCode: 404, code: 'ROLE_NOT_FOUND' });
  }
  const role = roleRes.rows[0];

  const isCanonicalPlatformSuperAdmin =
    Boolean(role.is_system_role) &&
    role.property_id === null &&
    String(role.name || '').trim().toLowerCase() === 'super admin';

  if (isCanonicalPlatformSuperAdmin) {
    const allPerms = await client.query('SELECT count(*) FROM permissions');
    const totalPerms = Number(allPerms.rows[0].count);
    if (permissionKeys.length < totalPerms) {
      throw Object.assign(new Error('Izin Super Admin tidak dapat dikurangi.'), { statusCode: 403, code: 'CANNOT_ALTER_SUPER_ADMIN_PERMISSIONS' });
    }
  }

  await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);

  for (const key of permissionKeys) {
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
       SELECT $1, id, TRUE, $2 FROM permissions WHERE key = $3
       ON CONFLICT (role_id, permission_id) DO UPDATE SET granted = TRUE`,
      [roleId, actor?.name || 'HRD', key]
    );
  }

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'ROLE_PERMISSIONS_UPDATED',
      'role_permissions',
      String(roleId),
      JSON.stringify({ role_name: role.name, permissions_count: permissionKeys.length }),
      actor?.name || 'HRD',
      1
    ]
  );

  return getRoleGranularPermissions(client, roleId);
}

// ==========================================================================
// TEST DATA PURGE
// ==========================================================================

export interface TestEntitySummary {
  id: number;
  name: string;
  code?: string;
  dependency_count: number;
  dependencies: string[];
}

export interface TestDataListResult {
  employees: TestEntitySummary[];
  departments: TestEntitySummary[];
  positions: TestEntitySummary[];
  roles: TestEntitySummary[];
  schedule_groups: TestEntitySummary[];
  holidays: TestEntitySummary[];
  shift_templates: TestEntitySummary[];
}

export async function listTestDataEntities(
  client: PoolClient,
  propertyId: number
): Promise<TestDataListResult> {
  const empRes = await client.query(
    `SELECT e.id, e.employee_code, e.full_name,
       (SELECT COUNT(*) FROM users u WHERE u.employee_id = e.id) +
       (SELECT COUNT(*) FROM employee_work_schedules ws WHERE ws.employee_id = e.id) +
       (SELECT COUNT(*) FROM employee_work_schedule_audits wa WHERE wa.employee_id = e.id) +
       (SELECT COUNT(*) FROM employee_face_enrollments fe WHERE fe.employee_id = e.id) +
       (SELECT COUNT(*) FROM employee_attendance att WHERE att.employee_id = e.id) +
       (SELECT COUNT(*) FROM employee_attendance_records ar WHERE ar.employee_id = e.id) +
       (SELECT COUNT(*) FROM payroll_records pr WHERE pr.employee_id = e.id) AS dependency_count,
       ARRAY(
         SELECT DISTINCT dep.t FROM (
           SELECT 'users' AS t WHERE EXISTS (SELECT 1 FROM users u WHERE u.employee_id = e.id)
           UNION ALL SELECT 'employee_work_schedules' WHERE EXISTS (SELECT 1 FROM employee_work_schedules ws WHERE ws.employee_id = e.id)
           UNION ALL SELECT 'employee_work_schedule_audits' WHERE EXISTS (SELECT 1 FROM employee_work_schedule_audits wa WHERE wa.employee_id = e.id)
           UNION ALL SELECT 'employee_face_enrollments' WHERE EXISTS (SELECT 1 FROM employee_face_enrollments fe WHERE fe.employee_id = e.id)
           UNION ALL SELECT 'employee_attendance' WHERE EXISTS (SELECT 1 FROM employee_attendance att WHERE att.employee_id = e.id)
           UNION ALL SELECT 'employee_attendance_records' WHERE EXISTS (SELECT 1 FROM employee_attendance_records ar WHERE ar.employee_id = e.id)
           UNION ALL SELECT 'payroll_records' WHERE EXISTS (SELECT 1 FROM payroll_records pr WHERE pr.employee_id = e.id)
         ) dep
       ) AS dependencies
     FROM hr_employees e
     WHERE e.is_test_data = TRUE AND e.property_id = $1
     ORDER BY e.id`,
    [propertyId]
  );

  const deptRes = await client.query(
    `SELECT d.id, d.name, d.code,
       (SELECT COUNT(*) FROM hr_employees emp WHERE emp.department_id = d.id) AS dependency_count,
       ARRAY(
         SELECT DISTINCT dep.t FROM (
           SELECT 'hr_employees' AS t WHERE EXISTS (SELECT 1 FROM hr_employees emp WHERE emp.department_id = d.id)
         ) dep
       ) AS dependencies
     FROM hr_departments d
     WHERE d.is_test_data = TRUE AND d.property_id = $1
     ORDER BY d.id`,
    [propertyId]
  );

  const posRes = await client.query(
    `SELECT p.id, p.name, p.code,
       (SELECT COUNT(*) FROM hr_employees emp WHERE emp.position_id = p.id) AS dependency_count,
       ARRAY(
         SELECT DISTINCT dep.t FROM (
           SELECT 'hr_employees' AS t WHERE EXISTS (SELECT 1 FROM hr_employees emp WHERE emp.position_id = p.id)
         ) dep
       ) AS dependencies
     FROM hr_positions p
     WHERE p.is_test_data = TRUE AND p.property_id = $1
     ORDER BY p.id`,
    [propertyId]
  );

  const roleRes = await client.query(
    `SELECT r.id, r.name, r.description AS code,
       (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS dependency_count,
       ARRAY(
         SELECT DISTINCT dep.t FROM (
           SELECT 'users' AS t WHERE EXISTS (SELECT 1 FROM users u WHERE u.role_id = r.id)
         ) dep
       ) AS dependencies
     FROM roles r
     WHERE r.is_test_data = TRUE AND r.property_id = $1
     ORDER BY r.id`,
    [propertyId]
  );

  const groupRes = await client.query(
    `SELECT g.id, g.name, g.code, 0 AS dependency_count, ARRAY[]::text[] AS dependencies
     FROM schedule_groups g
     WHERE g.is_test_data = TRUE AND g.property_id = $1
     ORDER BY g.id`,
    [propertyId]
  );

  const holidayRes = await client.query(
    `SELECT h.id, h.name, h.holiday_date::text AS code, 0 AS dependency_count, ARRAY[]::text[] AS dependencies
     FROM property_holidays h
     WHERE h.is_test_data = TRUE AND h.property_id = $1
     ORDER BY h.id`,
    [propertyId]
  );

  const shiftRes = await client.query(
    `SELECT s.id, s.name, s.code,
       (SELECT COUNT(*) FROM employee_work_schedules ws WHERE ws.shift_template_id = s.id) AS dependency_count,
       ARRAY(
         SELECT DISTINCT dep.t FROM (
           SELECT 'employee_work_schedules' AS t WHERE EXISTS (SELECT 1 FROM employee_work_schedules ws WHERE ws.shift_template_id = s.id)
         ) dep
       ) AS dependencies
     FROM work_shift_templates s
     WHERE s.is_test_data = TRUE AND s.property_id = $1
     ORDER BY s.id`,
    [propertyId]
  );

  return {
    employees: empRes.rows.map((r: any) => ({
      id: r.id, name: r.full_name, code: r.employee_code,
      dependency_count: Number(r.dependency_count), dependencies: r.dependencies || []
    })),
    departments: deptRes.rows.map((r: any) => ({
      id: r.id, name: r.name, code: r.code,
      dependency_count: Number(r.dependency_count), dependencies: r.dependencies || []
    })),
    positions: posRes.rows.map((r: any) => ({
      id: r.id, name: r.name, code: r.code,
      dependency_count: Number(r.dependency_count), dependencies: r.dependencies || []
    })),
    roles: roleRes.rows.map((r: any) => ({
      id: r.id, name: r.name, code: r.code,
      dependency_count: Number(r.dependency_count), dependencies: r.dependencies || []
    })),
    schedule_groups: groupRes.rows.map((r: any) => ({
      id: r.id, name: r.name, code: r.code,
      dependency_count: Number(r.dependency_count), dependencies: r.dependencies || []
    })),
    holidays: holidayRes.rows.map((r: any) => ({
      id: r.id, name: r.name, code: r.code,
      dependency_count: Number(r.dependency_count), dependencies: r.dependencies || []
    })),
    shift_templates: shiftRes.rows.map((r: any) => ({
      id: r.id, name: r.name, code: r.code,
      dependency_count: Number(r.dependency_count), dependencies: r.dependencies || []
    }))
  };
}

export async function purgeTestDataEmployee(
  client: PoolClient,
  propertyId: number,
  employeeId: number,
  actor?: { id?: number; name?: string }
): Promise<{ success: boolean; message: string; deleted: Record<string, number> }> {
  const empRes = await client.query(
    'SELECT * FROM hr_employees WHERE id = $1 AND property_id = $2',
    [employeeId, propertyId]
  );
  if (!hasRows(empRes)) {
    throw Object.assign(new Error(`Karyawan dengan ID ${employeeId} tidak ditemukan.`), {
      statusCode: 404, code: 'EMPLOYEE_NOT_FOUND'
    });
  }
  const emp = empRes.rows[0];

  if (!emp.is_test_data) {
    throw Object.assign(
      new Error('Karyawan ini bukan data test dan tidak dapat di-purge. Gunakan hard delete biasa.'),
      { statusCode: 409, code: 'NOT_TEST_DATA' }
    );
  }

  // Detect which optional tables exist (safe before any DML inside this transaction)
  const tableCheckRes = await client.query(`
    SELECT
      to_regclass('public.employee_face_enrollments') IS NOT NULL AS has_face,
      to_regclass('public.employee_attendance') IS NOT NULL AS has_attendance,
      to_regclass('public.employee_attendance_records') IS NOT NULL AS has_attendance_records,
      to_regclass('public.payroll_records') IS NOT NULL AS has_payroll,
      to_regclass('public.user_permission_overrides') IS NOT NULL AS has_perm_overrides
  `);
  const tables = tableCheckRes.rows[0];

  // Verify ALL dependencies are also test data (REQUIRED tables — errors propagate)
  const violations: string[] = [];

  const nonTestUsers = await client.query(
    'SELECT COUNT(*) FROM users WHERE employee_id = $1 AND is_test_data = FALSE',
    [employeeId]
  );
  if (Number(nonTestUsers.rows[0].count) > 0) violations.push('users');

  const nonTestSchedules = await client.query(
    'SELECT COUNT(*) FROM employee_work_schedules WHERE employee_id = $1 AND is_test_data = FALSE',
    [employeeId]
  );
  if (Number(nonTestSchedules.rows[0].count) > 0) violations.push('employee_work_schedules');

  const nonTestAudits = await client.query(
    'SELECT COUNT(*) FROM employee_work_schedule_audits WHERE employee_id = $1 AND is_test_data = FALSE',
    [employeeId]
  );
  if (Number(nonTestAudits.rows[0].count) > 0) violations.push('employee_work_schedule_audits');

  // Optional table dependency checks — only query if table exists
  if (tables.has_face) {
    const nonTestFace = await client.query(
      'SELECT COUNT(*) FROM employee_face_enrollments WHERE employee_id = $1 AND is_test_data = FALSE',
      [employeeId]
    );
    if (Number(nonTestFace.rows[0].count) > 0) violations.push('employee_face_enrollments');
  }

  if (tables.has_attendance) {
    const nonTestAtt = await client.query(
      'SELECT COUNT(*) FROM employee_attendance WHERE employee_id = $1 AND is_test_data = FALSE',
      [employeeId]
    );
    if (Number(nonTestAtt.rows[0].count) > 0) violations.push('employee_attendance');
  }

  if (tables.has_attendance_records) {
    const nonTestAttRec = await client.query(
      'SELECT COUNT(*) FROM employee_attendance_records WHERE employee_id = $1 AND is_test_data = FALSE',
      [employeeId]
    );
    if (Number(nonTestAttRec.rows[0].count) > 0) violations.push('employee_attendance_records');
  }

  if (tables.has_payroll) {
    const nonTestPayroll = await client.query(
      'SELECT COUNT(*) FROM payroll_records WHERE employee_id = $1 AND is_test_data = FALSE',
      [employeeId]
    );
    if (Number(nonTestPayroll.rows[0].count) > 0) violations.push('payroll_records');
  }

  if (violations.length > 0) {
    throw Object.assign(
      new Error(`Data test tidak dapat dibersihkan karena memiliki referensi yang tidak teridentifikasi sebagai data test: ${violations.join(', ')}.`),
      { statusCode: 409, code: 'NON_TEST_DEPENDENCY', details: { violations } }
    );
  }

  // Safe to purge — delete in FK-safe order
  // All queries below are on REQUIRED/verified-exist tables. Errors propagate (no try/catch).
  const deleted: Record<string, number> = {};

  // 1. Schedule audit rows (FK → employee_work_schedules, employee)
  {
    const r = await client.query('DELETE FROM employee_work_schedule_audits WHERE employee_id = $1', [employeeId]);
    if (r.rowCount) deleted['employee_work_schedule_audits'] = r.rowCount;
  }

  // 2. Attendance records (optional — only if table exists)
  if (tables.has_attendance_records) {
    const r = await client.query('DELETE FROM employee_attendance_records WHERE employee_id = $1', [employeeId]);
    if (r.rowCount) deleted['employee_attendance_records'] = r.rowCount;
  }

  // 3. Attendance (optional — only if table exists)
  if (tables.has_attendance) {
    const r = await client.query('DELETE FROM employee_attendance WHERE employee_id = $1', [employeeId]);
    if (r.rowCount) deleted['employee_attendance'] = r.rowCount;
  }

  // 4. Face enrollments (optional — only if table exists)
  if (tables.has_face) {
    const r = await client.query('DELETE FROM employee_face_enrollments WHERE employee_id = $1', [employeeId]);
    if (r.rowCount) deleted['employee_face_enrollments'] = r.rowCount;
  }

  // 5. Work schedules (required)
  {
    const r = await client.query('DELETE FROM employee_work_schedules WHERE employee_id = $1', [employeeId]);
    if (r.rowCount) deleted['employee_work_schedules'] = r.rowCount;
  }

  // 6. Payroll (optional — only if table exists)
  if (tables.has_payroll) {
    const r = await client.query('DELETE FROM payroll_records WHERE employee_id = $1', [employeeId]);
    if (r.rowCount) deleted['payroll_records'] = r.rowCount;
  }

  // 7. Linked user — delete permission overrides first, then user
  const linkedUsers = await client.query(
    'SELECT id FROM users WHERE employee_id = $1',
    [employeeId]
  );
  for (const u of linkedUsers.rows) {
    if (tables.has_perm_overrides) {
      await client.query('DELETE FROM user_permission_overrides WHERE user_id = $1', [u.id]);
    }
  }
  {
    const r = await client.query('DELETE FROM users WHERE employee_id = $1', [employeeId]);
    if (r.rowCount) deleted['users'] = r.rowCount;
  }

  // 8. Employee (required)
  await client.query('DELETE FROM hr_employees WHERE id = $1 AND property_id = $2', [employeeId, propertyId]);
  deleted['hr_employees'] = 1;

  // 9. Audit log
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'TEST_DATA_PURGED',
      'hr_employees',
      String(employeeId),
      JSON.stringify({
        id: employeeId,
        employee_code: emp.employee_code,
        full_name: emp.full_name,
        is_test_data: true,
        deleted,
        timestamp: new Date().toISOString()
      }),
      actor?.name || 'Super Admin',
      propertyId
    ]
  );

  return {
    success: true,
    message: `Data test karyawan "${emp.full_name}" berhasil dihapus permanen beserta ${Object.keys(deleted).length} tabel dependency.`,
    deleted
  };
}

export async function purgeTestDataBulk(
  client: PoolClient,
  propertyId: number,
  targets: Array<{ type: string; id: number }>,
  actor?: { id?: number; name?: string }
): Promise<{ success: boolean; results: Array<{ type: string; id: number; success: boolean; message: string; deleted?: Record<string, number> }> }> {
  const results: Array<{ type: string; id: number; success: boolean; message: string; deleted?: Record<string, number> }> = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const spName = `purge_target_${i}`;
    try {
      await client.query(`SAVEPOINT ${spName}`);
      if (target.type === 'employee') {
        const r = await purgeTestDataEmployee(client, propertyId, target.id, actor);
        results.push({ type: target.type, id: target.id, success: true, message: r.message, deleted: r.deleted });
      } else {
        results.push({ type: target.type, id: target.id, success: false, message: `Tipe "${target.type}" belum didukung untuk bulk purge.` });
      }
      await client.query(`RELEASE SAVEPOINT ${spName}`);
    } catch (err: any) {
      await client.query(`ROLLBACK TO SAVEPOINT ${spName}`).catch(() => {});
      results.push({ type: target.type, id: target.id, success: false, message: err.message });
    }
  }

  const allSuccess = results.every(r => r.success);
  return { success: allSuccess, results };
}
