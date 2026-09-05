import type {
  EmployeeWorkSchedule,
  HrEmployee,
  OperationalRosterResponse,
  WeeklyRosterEmployee,
  WeeklyRosterResponse,
} from './scheduleTypes';

export interface CellAssignmentEmployee extends HrEmployee {
  schedule_id: number;
  schedule_status: EmployeeWorkSchedule['schedule_status'];
  schedule: EmployeeWorkSchedule;
}

export interface CellAssignmentPermissions {
  canToggle: boolean;
  canCorrect: boolean;
  correctionBlockedReason: string | null;
}

export function getCellAssignmentPermissions(
  assignment: CellAssignmentEmployee,
): CellAssignmentPermissions {
  if (assignment.schedule_status === 'DRAFT') {
    return { canToggle: true, canCorrect: false, correctionBlockedReason: null };
  }
  if (assignment.schedule_status === 'PUBLISHED') {
    return { canToggle: false, canCorrect: true, correctionBlockedReason: null };
  }
  if (assignment.schedule_status === 'CHANGED') {
    return {
      canToggle: false,
      canCorrect: false,
      correctionBlockedReason: 'Publish ulang jadwal CHANGED sebelum melakukan koreksi berikutnya.',
    };
  }
  return {
    canToggle: false,
    canCorrect: false,
    correctionBlockedReason: 'Penugasan CANCELLED tidak dapat diubah dari sel aktif ini.',
  };
}

export function getCorrectionTarget(
  assignment: CellAssignmentEmployee,
): CellAssignmentEmployee | null {
  return getCellAssignmentPermissions(assignment).canCorrect ? assignment : null;
}

function matchesCell(
  schedule: EmployeeWorkSchedule | null | undefined,
  shiftType: string,
  templateId: number | null,
): schedule is EmployeeWorkSchedule {
  if (!schedule || schedule.schedule_status === 'CANCELLED') return false;
  if (shiftType === 'shift') {
    return schedule.work_status === 'WORK' && schedule.shift_template_id === templateId;
  }
  return schedule.work_status.toLowerCase() === shiftType;
}

function toAssignment(
  employee: WeeklyRosterEmployee,
  schedule: EmployeeWorkSchedule,
): CellAssignmentEmployee {
  return {
    id: employee.employee_id,
    property_id: schedule.property_id,
    employee_code: employee.employee_code,
    full_name: employee.employee_name,
    department_id: employee.department_id,
    department_name: employee.department_name,
    position_id: null,
    position_name: employee.position_name,
    is_active: true,
    schedule_id: schedule.id,
    schedule_status: schedule.schedule_status,
    schedule,
  };
}

export function getCellAssignments(
  roster: WeeklyRosterResponse | null | undefined,
  groupedRoster: OperationalRosterResponse | null | undefined,
  date: string,
  shiftType: string,
  templateId: number | null,
  groupId?: number,
): CellAssignmentEmployee[] {
  const employees = groupId !== undefined
    ? groupedRoster?.groups.find(group => group.group_id === groupId)?.employees || []
    : roster?.employees || [];

  const assignments: CellAssignmentEmployee[] = [];
  for (const employee of employees) {
    const schedule = employee.schedules[date];
    if (matchesCell(schedule, shiftType, templateId)) {
      assignments.push(toAssignment(employee, schedule));
    }
  }
  return assignments;
}

export function mergeCandidatesWithAssignments(
  candidates: HrEmployee[],
  assignments: CellAssignmentEmployee[],
): HrEmployee[] {
  const merged = new Map<number, HrEmployee>();
  for (const employee of candidates) merged.set(employee.id, employee);
  for (const employee of assignments) {
    if (!merged.has(employee.id)) merged.set(employee.id, employee);
  }
  return [...merged.values()];
}
