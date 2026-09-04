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

export async function resolveCanonicalRoleId(client: PoolClient, roleName: string): Promise<number> {
  if (!roleName || !roleName.trim()) {
    throw Object.assign(new Error('Role name wajib diisi untuk menentukan peran otorisasi akun login.'), {
      statusCode: 400,
      code: 'ROLE_REQUIRED'
    });
  }

  const rawTrimmed = roleName.trim();
  const norm = normalizeRoleName(rawTrimmed);

  // 1. Query canonical role from roles table by normalized name
  const qNorm = await client.query(
    'SELECT id, name FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1',
    [norm]
  );
  if (qNorm.rows.length > 0) {
    return Number(qNorm.rows[0].id);
  }

  // 2. Query canonical role by raw name if different from normalized
  if (norm.toLowerCase() !== rawTrimmed.toLowerCase()) {
    const qRaw = await client.query(
      'SELECT id, name FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1',
      [rawTrimmed]
    );
    if (qRaw.rows.length > 0) {
      return Number(qRaw.rows[0].id);
    }
  }

  // 3. ZERO GUESSING. Reject any role that does not map to a real canonical auth role row!
  throw Object.assign(
    new Error(`Role '${roleName}' tidak memiliki peran otorisasi sistem (Auth Role) yang valid di database. Peran yang tersedia: Front Office, Accounting, Housekeeping, General Manager, atau POS / Resto.`),
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

  // Authoritative dynamic role lookup from roles table (exclude Super Admin / platform admins)
  const dbRoles = await client.query(
    `SELECT id, name, description
     FROM roles
     WHERE id != 1 AND LOWER(name) NOT LIKE '%admin%'
     ORDER BY id ASC`
  );

  const roles: RoleCategoryDef[] = [];

  for (const r of dbRoles.rows) {
    if (r.name.toLowerCase() === 'general manager' && !policies.allow_hrd_assign_gm_role) {
      continue;
    }
    let department = 'Operations';
    const lower = r.name.toLowerCase();
    if (lower.includes('account') || lower.includes('finance')) department = 'Finance';
    else if (lower.includes('pos') || lower.includes('resto') || lower.includes('f&b')) department = 'F&B';
    else if (lower.includes('general') || lower.includes('gm')) department = 'Executive';

    roles.push({
      key: r.name,
      label: r.name,
      department,
      is_privileged: r.name.toLowerCase() === 'general manager',
      description: r.description || ''
    });
  }

  // General employment category without HIMS login account
  roles.push({
    key: 'Crew',
    label: 'Crew (Staf Operasional Tanpa Akun Login)',
    department: 'Operations',
    is_privileged: false,
    description: 'Staf pelaksana operasional harian tanpa akses login HIMS'
  });

  return roles;
}

export async function getEmployees(
  client: PoolClient,
  propertyId: number,
  options?: { scope?: string; department?: string; role?: string }
): Promise<HrEmployee[]> {
  let sql = `
    SELECT e.*,
           u.id AS user_id,
           u.account_status,
           u.is_active AS user_is_active
    FROM hr_employees e
    LEFT JOIN users u ON u.employee_id = e.id
    WHERE e.property_id = $1
  `;
  const params: any[] = [propertyId];

  if (options?.scope !== 'all') {
    sql += ' AND COALESCE(e.is_active, TRUE) = TRUE';
  }

  if (options?.department) {
    params.push(options.department);
    sql += ` AND e.department = $${params.length}`;
  }

  if (options?.role) {
    params.push(options.role);
    sql += ` AND e.role = $${params.length}`;
  }

  sql += ' ORDER BY e.full_name ASC';

  const res = await client.query(sql, params);
  return res.rows.map((row: any) => ({
    id: Number(row.id),
    property_id: Number(row.property_id),
    employee_code: row.employee_code,
    full_name: row.full_name,
    position: row.position,
    department: row.department,
    role: row.role || 'Crew',
    username: row.username,
    email: row.email,
    phone: row.phone,
    hire_date: row.hire_date ? String(row.hire_date).slice(0, 10) : null,
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
    upper.includes('ADMIN') ||
    upper.includes('PLATFORM') ||
    upper.includes('SUPER') ||
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

  const requestedRole = normalizeRoleName(payload.role);
  await validateRoleAssignment(client, propertyId, requestedRole, actor);

  const shouldCreateLogin = Boolean(payload.create_login_account);
  const cleanEmail = payload.email ? payload.email.trim().toLowerCase() : null;

  let finalUsername: string | null = null;
  let canonicalRoleId: number = 2;
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

    // Resolve canonical role_id
    canonicalRoleId = await resolveCanonicalRoleId(client, requestedRole);

    // Generate secure temporary password
    tempPassword = generateSecureTemporaryPassword(12);
    tempExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  } else {
    finalUsername = payload.username && payload.username.trim() ? payload.username.trim().toLowerCase() : null;
  }

  const employeeCode = payload.employee_code && payload.employee_code.trim()
    ? payload.employee_code.trim()
    : `EMP-${propertyId}-${Date.now().toString().slice(-4)}`;

  const res = await client.query(
    `INSERT INTO hr_employees (
      property_id, employee_code, full_name, position, department,
      role, username, email, phone, hire_date, monthly_salary, status, is_active
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE)
    RETURNING *`,
    [
      propertyId,
      employeeCode,
      payload.full_name.trim(),
      payload.position || 'Staff',
      payload.department || 'Operations',
      requestedRole,
      finalUsername,
      cleanEmail,
      payload.phone || null,
      payload.hire_date || null,
      payload.monthly_salary || 0,
      payload.status || 'ACTIVE'
    ]
  );

  const created: HrEmployee = {
    ...res.rows[0],
    id: Number(res.rows[0].id),
    property_id: Number(res.rows[0].property_id),
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
        local_password_enabled, temp_password_expires_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, 'FIRST_LOGIN_REQUIRED', TRUE, TRUE, $8, NOW(), NOW())
      RETURNING id`,
      [
        propertyId,
        created.id,
        canonicalRoleId,
        finalUsername,
        cleanEmail,
        passwordHash,
        created.full_name,
        tempExpiresAt
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
  let targetRole = current.role;

  if (payload.role !== undefined) {
    targetRole = normalizeRoleName(payload.role);

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

  const fullName = payload.full_name !== undefined ? payload.full_name.trim() : current.full_name;
  const position = payload.position !== undefined ? payload.position : current.position;
  const department = payload.department !== undefined ? payload.department : current.department;
  const username = payload.username !== undefined ? payload.username : current.username;
  const email = payload.email !== undefined ? payload.email : current.email;
  const phone = payload.phone !== undefined ? payload.phone : current.phone;
  const hireDate = payload.hire_date !== undefined ? payload.hire_date : current.hire_date;
  const monthlySalary = payload.monthly_salary !== undefined ? payload.monthly_salary : current.monthly_salary;
  const status = payload.status !== undefined ? payload.status : current.status;
  const isActive = payload.is_active !== undefined ? Boolean(payload.is_active) : (current.is_active !== false);

  const res = await client.query(
    `UPDATE hr_employees
     SET full_name = $1, position = $2, department = $3, role = $4,
         username = $5, email = $6, phone = $7, hire_date = $8,
         monthly_salary = $9, status = $10, is_active = $11, updated_at = NOW()
     WHERE id = $12 AND property_id = $13
     RETURNING *`,
    [
      fullName, position, department, targetRole,
      username, email, phone, hireDate,
      monthlySalary, status, isActive, employeeId, propertyId
    ]
  );

  const updated: HrEmployee = {
    ...res.rows[0],
    id: Number(res.rows[0].id),
    property_id: Number(res.rows[0].property_id),
    is_active: res.rows[0].is_active !== false,
    monthly_salary: Number(res.rows[0].monthly_salary || 0)
  };

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

  return updated;
}

export async function deactivateEmployeeAccount(
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

  const res = await client.query(
    `UPDATE hr_employees
     SET is_active = FALSE, status = 'INACTIVE', updated_at = NOW()
     WHERE id = $1 AND property_id = $2
     RETURNING *`,
    [employeeId, propertyId]
  );

  const deactivated: HrEmployee = {
    ...res.rows[0],
    id: Number(res.rows[0].id),
    property_id: Number(res.rows[0].property_id),
    is_active: false,
    monthly_salary: Number(res.rows[0].monthly_salary || 0)
  };

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      'EMPLOYEE_ACCOUNT_DEACTIVATED',
      'EMPLOYEE_ROLE',
      String(deactivated.id),
      JSON.stringify({ is_active: false, status: 'INACTIVE', previous_status: current.status }),
      actor?.name || 'HRD',
      propertyId
    ]
  );

  return deactivated;
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
      const targetRoleName = normalizeRoleName(emp.role);
      await validateRoleAssignment(client, propertyId, targetRoleName, actor);
      const targetRoleId = await resolveCanonicalRoleId(client, targetRoleName);

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
        temp_password_expires_at: tempExpiresAt.toISOString()
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
    account_status: updatedUser.account_status
  };
}
