import type { Pool, PoolClient } from 'pg';
import { isPlatformSuperAdmin, type AuthUserPayload } from '../auth/authService';
import { hasAnyEffectivePermission } from '../settings/accessControlService';

export const ATTENDANCE_FACE_NOT_PROCESSED = 'NOT_PROCESSED';

export interface AuthenticatedAttendanceUser {
  userId: number;
  propertyId: number;
  employeeId: number | null;
  isActive: boolean;
  accountStatus: string;
  fullName: string;
  roleName: string | null;
  isPlatformSuperAdmin: boolean;
}

export interface SelfAttendanceActor {
  userId: number;
  employeeId: number;
  propertyId: number;
  employeeName: string;
  department: string | null;
  roleName: string | null;
  isPlatformSuperAdmin: boolean;
}

function httpError(message: string, statusCode: number, code: string): never {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  throw err;
}

export function requireAuthenticatedUser(user?: AuthUserPayload | null): AuthUserPayload {
  const userId = Number(user?.id);
  if (!user || !Number.isInteger(userId) || userId <= 0) {
    httpError('Akses ditolak. Silakan login terlebih dahulu.', 401, 'UNAUTHORIZED');
  }
  return user;
}

export async function loadAuthenticatedAttendanceUser(
  db: Pool | PoolClient,
  user: AuthUserPayload
): Promise<AuthenticatedAttendanceUser> {
  const userId = Number(user.id);
  const res = await db.query(
    `SELECT u.id, u.property_id, u.employee_id, u.is_active, u.account_status, u.full_name,
            r.name AS role_name
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [userId]
  );

  if (res.rows.length === 0) {
    httpError('Pengguna tidak ditemukan.', 401, 'USER_INACTIVE');
  }

  const row = res.rows[0];
  if (row.is_active === false) {
    httpError('Pengguna tidak ditemukan atau sudah dinonaktifkan.', 401, 'USER_INACTIVE');
  }

  const propertyId = Number(row.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    httpError('Akses ditolak: akun tidak terkait properti yang valid.', 403, 'PROPERTY_SCOPE_REQUIRED');
  }

  const platformAdmin = await isPlatformSuperAdmin(db, userId);

  return {
    userId,
    propertyId,
    employeeId: row.employee_id != null ? Number(row.employee_id) : null,
    isActive: true,
    accountStatus: String(row.account_status || ''),
    fullName: row.full_name || user.full_name || user.username,
    roleName: row.role_name || user.role || null,
    isPlatformSuperAdmin: platformAdmin
  };
}

export async function resolveSelfAttendanceActor(
  db: Pool | PoolClient,
  user: AuthUserPayload
): Promise<SelfAttendanceActor> {
  const authUser = await loadAuthenticatedAttendanceUser(db, user);

  if (!authUser.employeeId || authUser.employeeId <= 0) {
    httpError(
      'Akun tidak terhubung dengan data karyawan HR. Absensi mandiri tidak dapat diproses.',
      400,
      'EMPLOYEE_LINK_REQUIRED'
    );
  }

  const empRes = await db.query(
    `SELECT e.id, e.property_id, e.full_name, e.department, e.position, e.is_active, e.status,
            d.name AS department_name, p.name AS position_name
     FROM hr_employees e
     LEFT JOIN hr_departments d ON d.id = e.department_id
     LEFT JOIN hr_positions p ON p.id = e.position_id
     WHERE e.id = $1`,
    [authUser.employeeId]
  );

  if (empRes.rows.length === 0) {
    httpError('Data karyawan HR terkait tidak ditemukan.', 400, 'EMPLOYEE_NOT_FOUND');
  }

  const emp = empRes.rows[0];
  if (emp.is_active === false || (emp.status && String(emp.status).toUpperCase() !== 'ACTIVE')) {
    httpError('Data karyawan HR terkait sudah tidak aktif.', 403, 'EMPLOYEE_DISABLED');
  }

  const empPropertyId = Number(emp.property_id);
  if (Number.isInteger(empPropertyId) && empPropertyId > 0 && empPropertyId !== authUser.propertyId) {
    httpError(
      'Scope properti akun tidak cocok dengan data properti karyawan.',
      400,
      'PROPERTY_MISMATCH'
    );
  }

  return {
    userId: authUser.userId,
    employeeId: Number(emp.id),
    propertyId: authUser.propertyId,
    employeeName: emp.full_name || authUser.fullName,
    department: emp.department_name || emp.department || null,
    roleName: emp.position_name || emp.position || authUser.roleName,
    isPlatformSuperAdmin: authUser.isPlatformSuperAdmin
  };
}

/**
 * Employee self-attendance never trusts a client employee_id as authority.
 * The clock is always bound to the JWT employee's canonical hr_employees.id.
 *
 * A supplied id equal to users.id is treated as the known mobile-client
 * confusion (users.id != employee_id) and is ignored, not rejected.
 * A supplied id belonging to another employee is impersonation.
 */
export function rejectEmployeeImpersonation(
  actorEmployeeId: number,
  actorUserId: number,
  suppliedEmployeeId?: number | null
): void {
  if (suppliedEmployeeId == null || Number.isNaN(Number(suppliedEmployeeId))) {
    return;
  }
  const supplied = Number(suppliedEmployeeId);
  if (!Number.isInteger(supplied) || supplied <= 0) {
    return;
  }
  if (supplied === actorEmployeeId || supplied === actorUserId) {
    return;
  }
  httpError(
    'Absensi mandiri hanya dapat dicatat untuk karyawan yang sedang login.',
    403,
    'EMPLOYEE_IMPERSONATION_FORBIDDEN'
  );
}

export function resolveAuthoritativePropertyId(params: {
  tokenPropertyId: number;
  requestedPropertyId?: number | null;
  isPlatformSuperAdmin: boolean;
  allowAdminPropertyOverride: boolean;
}): number {
  const requested = params.requestedPropertyId != null ? Number(params.requestedPropertyId) : null;
  const hasRequested = requested != null && Number.isInteger(requested) && requested > 0;

  if (!hasRequested) {
    return params.tokenPropertyId;
  }

  if (requested === params.tokenPropertyId) {
    return params.tokenPropertyId;
  }

  if (params.isPlatformSuperAdmin && params.allowAdminPropertyOverride) {
    return requested;
  }

  httpError(
    'Absensi tidak dapat diproses untuk properti lain.',
    403,
    'CROSS_PROPERTY_FORBIDDEN'
  );
}

export async function canAdministerAttendancePhotos(
  db: Pool | PoolClient,
  userId: number,
  recordPropertyId: number
): Promise<boolean> {
  if (await isPlatformSuperAdmin(db, userId)) {
    return true;
  }
  return hasAnyEffectivePermission(db, recordPropertyId, userId, ['HRD'], 'view');
}

export async function canChangeAttendanceSettings(
  db: Pool | PoolClient,
  userId: number,
  propertyId: number
): Promise<boolean> {
  if (await isPlatformSuperAdmin(db, userId)) {
    return true;
  }
  return hasAnyEffectivePermission(db, propertyId, userId, ['HRD'], 'edit');
}

export function parseOptionalPositiveInt(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}
