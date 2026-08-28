import type { PoolClient } from 'pg';
import {
  type HrEmployee,
  type HrdRolePolicySettings,
  type CreateEmployeePayload,
  type UpdateEmployeePayload,
  type RoleCategoryDef,
  STANDARD_ROLE_CATEGORIES,
  PRIVILEGED_ROLE_CATEGORIES
} from './hrdTypes';

function hasRows(res: any): boolean {
  return Boolean(res && Array.isArray(res.rows) && res.rows.length > 0);
}

function normalizeRoleName(role?: string | null): string {
  if (!role) return 'Crew';
  const r = role.trim();
  if (r.toLowerCase() === 'gm' || r.toLowerCase() === 'general manager' || r.toLowerCase().includes('general manager')) {
    return 'General Manager';
  }
  if (r.toLowerCase() === 'owner' || r.toLowerCase().includes('direksi')) {
    return 'Owner';
  }
  return r;
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
  options?: { scope?: string; department?: string; role?: string }
): Promise<HrEmployee[]> {
  let sql = 'SELECT * FROM hr_employees WHERE property_id = $1';
  const params: any[] = [propertyId];

  if (options?.scope !== 'all') {
    sql += ' AND COALESCE(is_active, TRUE) = TRUE';
  }

  if (options?.department) {
    params.push(options.department);
    sql += ` AND department = $${params.length}`;
  }

  if (options?.role) {
    params.push(options.role);
    sql += ` AND role = $${params.length}`;
  }

  sql += ' ORDER BY full_name ASC';

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
): Promise<HrEmployee> {
  if (!payload.full_name || !payload.full_name.trim()) {
    throw Object.assign(new Error('Nama lengkap karyawan wajib diisi.'), { statusCode: 400, code: 'NAME_REQUIRED' });
  }

  const requestedRole = normalizeRoleName(payload.role);
  await validateRoleAssignment(client, propertyId, requestedRole, actor);

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
      payload.username || null,
      payload.email || null,
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

  // Privileged role audit
  // Privileged role audit
  const isPrivileged = requestedRole === 'Owner' || requestedRole === 'General Manager';
  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'HRD',
      isPrivileged ? 'PRIVILEGED_ROLE_ASSIGNED' : 'EMPLOYEE_ACCOUNT_CREATED',
      'EMPLOYEE_ROLE',
      String(created.id),
      JSON.stringify({ target_employee: created.full_name, role: created.role, code: created.employee_code }),
      actor?.name || 'HRD',
      propertyId
    ]
  );

  return created;
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
