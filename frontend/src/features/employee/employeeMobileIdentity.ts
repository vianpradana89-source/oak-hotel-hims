export interface CanonicalEmployeeIdentity {
  employeeId: number;
  employeeName: string;
  departmentId: number | null;
  departmentName: string | null;
  positionId: number | null;
  positionName: string | null;
  propertyId: number;
}

const DEMO_IDENTITY_NAMES = [
  'siti rahmawati',
  'siti rahmawati (crew hk)',
  'staff housekeeping'
];

export function isForbiddenDemoIdentityName(name: string | null | undefined): boolean {
  const normalized = String(name || '').trim().toLowerCase();
  return DEMO_IDENTITY_NAMES.includes(normalized);
}

export function parseCanonicalEmployeeIdentity(payload: any): CanonicalEmployeeIdentity | null {
  if (!payload || typeof payload !== 'object') return null;

  const employeeId = Number(payload.employeeId ?? payload.employee_id);
  const propertyId = Number(payload.propertyId ?? payload.property_id);
  const employeeName = String(payload.employeeName ?? payload.employee_name ?? '').trim();
  if (!Number.isInteger(employeeId) || employeeId <= 0) return null;
  if (!Number.isInteger(propertyId) || propertyId <= 0) return null;
  if (!employeeName) return null;
  if (isForbiddenDemoIdentityName(employeeName)) return null;

  const departmentIdRaw = payload.departmentId ?? payload.department_id;
  const positionIdRaw = payload.positionId ?? payload.position_id;
  const rawDepartmentId = departmentIdRaw == null || departmentIdRaw === '' ? null : Number(departmentIdRaw);
  const rawPositionId = positionIdRaw == null || positionIdRaw === '' ? null : Number(positionIdRaw);

  return {
    employeeId,
    employeeName,
    departmentId: rawDepartmentId != null && Number.isInteger(rawDepartmentId) && rawDepartmentId > 0 ? rawDepartmentId : null,
    departmentName: payload.departmentName ?? payload.department_name ?? null,
    positionId: rawPositionId != null && Number.isInteger(rawPositionId) && rawPositionId > 0 ? rawPositionId : null,
    positionName: payload.positionName ?? payload.position_name ?? null,
    propertyId
  };
}

export function formatEmployeeDeptPosition(identity: CanonicalEmployeeIdentity): string {
  const dept = identity.departmentName?.trim() || '';
  const pos = identity.positionName?.trim() || '';
  if (dept && pos) return `${dept} • ${pos}`;
  return dept || pos;
}

export const EMPLOYEE_UNLINKED_MESSAGE = 'Akun belum terhubung ke data karyawan.';

export function canPermitClockIn(identity: CanonicalEmployeeIdentity | null | undefined): boolean {
  return Boolean(
    identity &&
    Number.isInteger(identity.employeeId) &&
    identity.employeeId > 0 &&
    identity.employeeName.trim() &&
    !isForbiddenDemoIdentityName(identity.employeeName) &&
    Number.isInteger(identity.propertyId) &&
    identity.propertyId > 0
  );
}
