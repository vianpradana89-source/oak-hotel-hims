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
): CellAssignmentEmployee[] {
  const employees = new Map<number, WeeklyRosterEmployee>();

  for (const employee of roster?.employees || []) {
    employees.set(employee.employee_id, employee);
  }
  for (const group of groupedRoster?.groups || []) {
    for (const employee of group.employees) {
      employees.set(employee.employee_id, employee);
    }
  }

  const assignments: CellAssignmentEmployee[] = [];
  for (const employee of employees.values()) {
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
