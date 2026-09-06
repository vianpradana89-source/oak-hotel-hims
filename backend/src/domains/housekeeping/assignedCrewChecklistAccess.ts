import type { Pool, PoolClient } from 'pg';
import type { AuthUserPayload } from '../auth/authService';
import { hasAnyEffectivePermission } from '../settings/accessControlService';

export const ASSIGNED_CREW_ACTIVE_CHECKLIST_STATUSES = ['IN_PROGRESS', 'ACKNOWLEDGED'] as const;

const CHECKLIST_MUTATION_PATH =
  /^\/api\/housekeeping\/tasks\/\d+\/checklist(?:-items)?\/(?:bulk-category|\d+)$/;

function httpError(message: string, statusCode: number, code: string): never {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  throw err;
}

export function isAssignedCrewChecklistMutationPath(path: string, method: string): boolean {
  const verb = (method || '').toUpperCase();
  if (verb !== 'PATCH' && verb !== 'POST') return false;
  return CHECKLIST_MUTATION_PATH.test((path || '').split('?')[0]);
}

export interface HousekeepingChecklistAuthz {
  mode: 'HOUSEKEEPING_EDIT' | 'ASSIGNED_CREW';
  userId: number;
  employeeId: number | null;
  employeeName: string | null;
}

function parsePositiveInt(raw: unknown): number | null {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export async function canReachAssignedCrewChecklistMutation(
  db: Pool | PoolClient,
  propertyId: number,
  userId: number
): Promise<boolean> {
  return hasAnyEffectivePermission(db, propertyId, userId, ['Employee Mobile', 'Housekeeping'], 'view');
}

async function resolveLinkedActiveEmployee(
  db: Pool | PoolClient,
  user: AuthUserPayload
): Promise<{ userId: number; employeeId: number; employeeName: string; employeePropertyId: number; tokenPropertyId: number }> {
  const userId = parsePositiveInt(user.id);
  if (!userId) {
    httpError('Akses ditolak. Silakan login terlebih dahulu.', 401, 'UNAUTHORIZED');
  }

  const userRes = await db.query(
    `SELECT u.id, u.property_id, u.employee_id, u.is_active, u.full_name
     FROM users u
     WHERE u.id = $1`,
    [userId]
  );
  if (userRes.rows.length === 0 || userRes.rows[0].is_active === false) {
    httpError('Akses ditolak. Silakan login terlebih dahulu.', 401, 'USER_INACTIVE');
  }

  const row = userRes.rows[0];
  const tokenPropertyId = parsePositiveInt(row.property_id) || parsePositiveInt(user.property_id);
  if (!tokenPropertyId) {
    httpError('Akses ditolak: akun tidak terkait properti yang valid.', 403, 'PROPERTY_SCOPE_REQUIRED');
  }

  const employeeId = parsePositiveInt(row.employee_id);
  if (!employeeId) {
    httpError(
      'Akun belum terhubung ke data karyawan. Checklist kamar tidak dapat diperbarui.',
      403,
      'EMPLOYEE_LINK_REQUIRED'
    );
  }

  const empRes = await db.query(
    `SELECT id, property_id, full_name, is_active, status
     FROM hr_employees
     WHERE id = $1`,
    [employeeId]
  );
  if (empRes.rows.length === 0) {
    httpError(
      'Akun belum terhubung ke data karyawan. Checklist kamar tidak dapat diperbarui.',
      403,
      'EMPLOYEE_LINK_REQUIRED'
    );
  }

  const emp = empRes.rows[0];
  if (emp.is_active === false || (emp.status && String(emp.status).toUpperCase() !== 'ACTIVE')) {
    httpError('Data karyawan terkait sudah tidak aktif.', 403, 'EMPLOYEE_DISABLED');
  }

  const employeePropertyId = parsePositiveInt(emp.property_id);
  if (!employeePropertyId) {
    httpError('Akses ditolak: akun tidak terkait properti yang valid.', 403, 'PROPERTY_SCOPE_REQUIRED');
  }

  return {
    userId,
    employeeId,
    employeeName: emp.full_name || row.full_name || user.full_name || user.username,
    employeePropertyId,
    tokenPropertyId
  };
}

function taskAssignedToEmployee(task: any, actor: { userId: number; employeeId: number }): boolean {
  const assignedEmployeeId = parsePositiveInt(task.assigned_employee_id);
  if (assignedEmployeeId) {
    return assignedEmployeeId === actor.employeeId;
  }
  const assignedUserId = parsePositiveInt(task.assigned_user_id);
  if (assignedUserId) {
    return assignedUserId === actor.userId;
  }
  return false;
}

export async function authorizeHousekeepingChecklistMutation(
  db: Pool | PoolClient,
  user: AuthUserPayload | null | undefined,
  propertyId: number,
  taskId: number
): Promise<HousekeepingChecklistAuthz> {
  const userId = parsePositiveInt(user?.id);
  if (!user || !userId) {
    httpError('Akses ditolak. Silakan login terlebih dahulu.', 401, 'UNAUTHORIZED');
  }

  const requestedPropertyId = parsePositiveInt(propertyId);
  const requestedTaskId = parsePositiveInt(taskId);
  if (!requestedPropertyId || !requestedTaskId) {
    httpError('Tugas housekeeping tidak ditemukan.', 404, 'TASK_NOT_FOUND');
  }

  const hasHousekeepingEdit = await hasAnyEffectivePermission(
    db,
    requestedPropertyId,
    userId,
    ['Housekeeping'],
    'edit'
  );
  if (hasHousekeepingEdit) {
    return {
      mode: 'HOUSEKEEPING_EDIT',
      userId,
      employeeId: null,
      employeeName: user.full_name || user.username || null
    };
  }

  const actor = await resolveLinkedActiveEmployee(db, user);

  if (actor.tokenPropertyId !== requestedPropertyId || actor.employeePropertyId !== requestedPropertyId) {
    httpError(
      'Checklist kamar tidak dapat diubah untuk properti lain.',
      403,
      'CROSS_PROPERTY_FORBIDDEN'
    );
  }

  const taskRes = await db.query(
    `SELECT id, property_id, status, assigned_employee_id, assigned_user_id
     FROM housekeeping_tasks
     WHERE id = $1`,
    [requestedTaskId]
  );
  if (taskRes.rows.length === 0) {
    httpError('Tugas housekeeping tidak ditemukan.', 404, 'TASK_NOT_FOUND');
  }

  const task = taskRes.rows[0];
  const taskPropertyId = parsePositiveInt(task.property_id);
  if (taskPropertyId !== requestedPropertyId) {
    httpError(
      'Checklist kamar tidak dapat diubah untuk properti lain.',
      403,
      'CROSS_PROPERTY_FORBIDDEN'
    );
  }

  if (!taskAssignedToEmployee(task, actor)) {
    httpError(
      'Tugas housekeeping ini tidak ditugaskan kepada Anda.',
      403,
      'CHECKLIST_ASSIGNMENT_FORBIDDEN'
    );
  }

  const status = String(task.status || '').toUpperCase();
  if (!ASSIGNED_CREW_ACTIVE_CHECKLIST_STATUSES.includes(status as typeof ASSIGNED_CREW_ACTIVE_CHECKLIST_STATUSES[number])) {
    httpError(
      'Checklist hanya dapat diubah saat tugas sedang dikerjakan.',
      403,
      'TASK_NOT_ACTIVE_FOR_CHECKLIST'
    );
  }

  return {
    mode: 'ASSIGNED_CREW',
    userId: actor.userId,
    employeeId: actor.employeeId,
    employeeName: actor.employeeName
  };
}
