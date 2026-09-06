import type { Pool, PoolClient } from 'pg';

export interface CanonicalEmployeeIdentity {
  employeeId: number;
  employeeName: string;
  departmentId: number | null;
  departmentName: string | null;
  positionId: number | null;
  positionName: string | null;
  propertyId: number;
  userId: number;
}

function httpError(message: string, statusCode: number, code: string): never {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  throw err;
}

/**
 * Authoritative mobile identity:
 * JWT users.id → users.employee_id → hr_employees + department/position masters.
 * Never trusts a client-supplied employee_id.
 */
export async function getCanonicalEmployeeIdentity(
  db: Pool | PoolClient,
  userId: number
): Promise<CanonicalEmployeeIdentity> {
  const numericUserId = Number(userId);
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
    httpError('Akses ditolak. Silakan login terlebih dahulu.', 401, 'UNAUTHORIZED');
  }

  const res = await db.query(
    `SELECT
        u.id AS user_id,
        u.property_id AS user_property_id,
        u.employee_id AS linked_employee_id,
        u.is_active AS user_is_active,
        e.id AS resolved_employee_id,
        e.full_name AS employee_name,
        e.property_id AS employee_property_id,
        e.is_active AS employee_is_active,
        e.status AS employee_status,
        e.department_id,
        e.position_id,
        e.department AS legacy_department,
        e.position AS legacy_position,
        d.id AS department_id_rel,
        d.name AS department_name,
        p.id AS position_id_rel,
        p.name AS position_name
     FROM users u
     LEFT JOIN hr_employees e ON e.id = u.employee_id
     LEFT JOIN hr_departments d ON d.id = e.department_id
     LEFT JOIN hr_positions p ON p.id = e.position_id
     WHERE u.id = $1`,
    [numericUserId]
  );

  if (res.rows.length === 0 || res.rows[0].user_is_active === false) {
    httpError('Pengguna tidak ditemukan atau sudah dinonaktifkan.', 401, 'USER_INACTIVE');
  }

  const row = res.rows[0];
  if (!row.linked_employee_id || !row.resolved_employee_id) {
    httpError('Akun belum terhubung ke data karyawan.', 400, 'NO_EMPLOYEE_LINK');
  }

  if (row.employee_is_active === false || (row.employee_status && String(row.employee_status).toUpperCase() !== 'ACTIVE')) {
    httpError('Akun belum terhubung ke data karyawan.', 400, 'EMPLOYEE_DEACTIVATED');
  }

  const employeeName = String(row.employee_name || '').trim();
  if (!employeeName) {
    httpError('Akun belum terhubung ke data karyawan.', 400, 'NO_EMPLOYEE_LINK');
  }

  const propertyId = Number(row.user_property_id);
  const empPropertyId = row.employee_property_id != null ? Number(row.employee_property_id) : null;
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    httpError('Akses ditolak: akun tidak terkait properti yang valid.', 403, 'PROPERTY_SCOPE_REQUIRED');
  }
  if (empPropertyId != null && Number.isInteger(empPropertyId) && empPropertyId > 0 && empPropertyId !== propertyId) {
    httpError('Scope properti akun tidak cocok dengan data properti karyawan.', 400, 'PROPERTY_MISMATCH');
  }

  const rawDepartmentId = row.department_id_rel != null ? Number(row.department_id_rel) : (row.department_id != null ? Number(row.department_id) : null);
  const rawPositionId = row.position_id_rel != null ? Number(row.position_id_rel) : (row.position_id != null ? Number(row.position_id) : null);

  return {
    userId: numericUserId,
    employeeId: Number(row.resolved_employee_id),
    employeeName,
    departmentId: rawDepartmentId != null && Number.isInteger(rawDepartmentId) && rawDepartmentId > 0 ? rawDepartmentId : null,
    departmentName: row.department_name || row.legacy_department || null,
    positionId: rawPositionId != null && Number.isInteger(rawPositionId) && rawPositionId > 0 ? rawPositionId : null,
    positionName: row.position_name || row.legacy_position || null,
    propertyId
  };
}

export function presentCanonicalEmployeeIdentity(identity: CanonicalEmployeeIdentity) {
  return {
    employeeId: identity.employeeId,
    employeeName: identity.employeeName,
    departmentId: identity.departmentId,
    departmentName: identity.departmentName,
    positionId: identity.positionId,
    positionName: identity.positionName,
    propertyId: identity.propertyId,
    employee_id: identity.employeeId,
    employee_name: identity.employeeName,
    department_id: identity.departmentId,
    department_name: identity.departmentName,
    position_id: identity.positionId,
    position_name: identity.positionName,
    property_id: identity.propertyId,
    user_id: identity.userId
  };
}
