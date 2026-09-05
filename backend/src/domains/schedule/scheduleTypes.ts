// backend/src/domains/schedule/scheduleTypes.ts

import type { WorkShiftTemplate, EmployeeWorkSchedule, WorkScheduleAudit, ScheduleStatus, WorkStatusType } from '../attendance/attendanceTypes';

export type { WorkShiftTemplate, EmployeeWorkSchedule, WorkScheduleAudit, ScheduleStatus, WorkStatusType };

export interface ShiftTemplateListQuery {
  property_id: number;
  include_inactive?: boolean;
  department_id?: number | null; // null = all, 0 = global only, >0 = specific dept
}

export interface CreateShiftTemplatePayload {
  property_id: number;
  code: string;
  name: string;
  start_time: string; // HH:MM
  end_time: string;   // HH:MM
  crosses_midnight?: boolean;
  grace_before_minutes?: number;
  late_grace_minutes?: number;
  checkout_grace_minutes?: number;
  is_active?: boolean;
  department_id?: number | null; // null = global, number = department-scoped
  color_key?: string; // manual soft color token
}

export interface UpdateShiftTemplatePayload {
  code?: string;
  name?: string;
  start_time?: string;
  end_time?: string;
  crosses_midnight?: boolean;
  grace_before_minutes?: number;
  late_grace_minutes?: number;
  checkout_grace_minutes?: number;
  is_active?: boolean;
  department_id?: number | null;
  color_key?: string;
}

export interface ShiftTemplateTeamMember {
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  position_name: string | null;
  department_id: number | null;
  department_name: string | null;
  schedule_count: number; // number of scheduled days in the queried period
}

export interface WeeklyRosterQuery {
  property_id: number;
  start_date: string; // YYYY-MM-DD (Monday of the week)
  end_date: string;   // YYYY-MM-DD (Sunday of the week)
  department_id?: number;
  employee_ids?: number[];
}

export interface WeeklyRosterEmployee {
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  department_id: number | null;
  department_name: string | null;
  position_name: string | null;
  schedules: Record<string, EmployeeWorkSchedule | null>; // key: YYYY-MM-DD
}

export interface WeeklyRosterResponse {
  start_date: string;
  end_date: string;
  dates: string[]; // all 7 dates in the range
  employees: WeeklyRosterEmployee[];
  shift_templates: WorkShiftTemplate[];
}

export interface AssignSchedulePayload {
  property_id: number;
  employee_id: number;
  work_date: string; // YYYY-MM-DD
  shift_template_id?: number | null;
  work_status?: WorkStatusType;
  notes?: string;
}

export type ScheduleCorrectionTarget =
  | 'SHIFT'
  | 'OFF'
  | 'HOLIDAY'
  | 'LEAVE'
  | 'SICK'
  | 'PERMISSION'
  | 'REMOVE';

export interface CorrectSchedulePayload {
  target_type: ScheduleCorrectionTarget;
  shift_template_id?: number | null;
  reason: string;
}

export interface BulkAssignSchedulePayload {
  property_id: number;
  employee_ids: number[];
  shift_template_id?: number | null;
  work_status?: WorkStatusType;
  start_date: string;
  end_date: string;
  days_of_week?: number[]; // 0=Sun, 1=Mon, ..., 6=Sat. If omitted, all days in range.
  notes?: string;
}

export interface CopyWeekPayload {
  property_id: number;
  source_start_date: string;
  target_start_date: string;
}

export interface CopyWeekResult {
  copied_count: number;
  skipped_conflicts: number;
  conflicts: Array<{
    employee_id: number;
    employee_name: string;
    work_date: string;
  }>;
}

export interface PublishSchedulePayload {
  property_id: number;
  start_date: string;
  end_date: string;
}

export interface PublishScheduleResult {
  published_count: number;
  already_published_count: number;
}

export interface GetScheduleForAttendanceQuery {
  property_id: number;
  employee_id: number;
  work_date: string; // YYYY-MM-DD
}

export interface AttendanceScheduleResult {
  found: boolean;
  schedule: EmployeeWorkSchedule | null;
  shift_template: WorkShiftTemplate | null;
}

export interface MonthlyRosterQuery {
  property_id: number;
  year: number;
  month: number; // 1-12
  department_id?: number;
}

export interface MonthlyRosterEmployee {
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  department_id: number | null;
  department_name: string | null;
  position_name: string | null;
  schedules: Record<string, EmployeeWorkSchedule | null>; // key: YYYY-MM-DD
}

export interface MonthlyRosterResponse {
  year: number;
  month: number;
  dates: string[]; // all dates in the month
  employees: MonthlyRosterEmployee[];
  shift_templates: WorkShiftTemplate[];
}

// ─── HR-SCHEDULE-1F: Operational/Non-Operational Schedule Groups ───

export type ScheduleCategory = 'OPERATIONAL' | 'NON_OPERATIONAL';

export interface ScheduleGroup {
  id: number;
  property_id: number;
  name: string;
  code: string;
  is_active: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  departments?: ScheduleGroupDepartmentInfo[];
}

export interface ScheduleGroupDepartmentInfo {
  department_id: number;
  department_name: string;
  department_code: string;
}

export interface CreateScheduleGroupPayload {
  property_id: number;
  name: string;
  code: string;
  is_active?: boolean;
  display_order?: number;
  department_ids?: number[];
}

export interface UpdateScheduleGroupPayload {
  name?: string;
  code?: string;
  is_active?: boolean;
  display_order?: number;
  department_ids?: number[];
}

export interface DepartmentWorkPattern {
  id: number;
  property_id: number;
  department_id: number;
  department_name?: string;
  default_start_time: string;
  default_end_time: string;
  crosses_midnight: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateDepartmentWorkPatternPayload {
  property_id: number;
  department_id: number;
  default_start_time: string;
  default_end_time: string;
  crosses_midnight?: boolean;
  is_active?: boolean;
}

export interface UpdateDepartmentWorkPatternPayload {
  default_start_time?: string;
  default_end_time?: string;
  crosses_midnight?: boolean;
  is_active?: boolean;
}

export interface PropertyHoliday {
  id: number;
  property_id: number;
  holiday_date: string;
  name: string;
  holiday_type: 'NATIONAL' | 'LOCAL' | 'PROPERTY';
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface CreatePropertyHolidayPayload {
  property_id: number;
  holiday_date: string;
  name: string;
  holiday_type?: 'NATIONAL' | 'LOCAL' | 'PROPERTY';
  is_active?: boolean;
}

export interface UpdatePropertyHolidayPayload {
  holiday_date?: string;
  name?: string;
  holiday_type?: 'NATIONAL' | 'LOCAL' | 'PROPERTY';
  is_active?: boolean;
}

export interface NonOpBulkPatternPayload {
  property_id: number;
  department_id: number;
  employee_ids: number[];
  start_date: string;
  end_date: string;
  working_days: number[]; // 0=Sun, 1=Mon, ..., 6=Sat
  default_start_time?: string;
  default_end_time?: string;
  crosses_midnight?: boolean;
  notes?: string;
}

export interface NonOpBulkPatternPreview {
  total_dates: number;
  new_schedules: number;
  existing_schedules: number;
  skipped_protected: number;
  conflicts: Array<{
    employee_id: number;
    employee_name: string;
    work_date: string;
    current_status: string;
    current_schedule_status: string;
  }>;
}

export interface NonOpBulkPatternResult {
  created_count: number;
  skipped_count: number;
  skipped_protected: number;
  skipped_holiday: number;
}

export interface OperationalRosterResponse {
  groups: OperationalGroupRoster[];
  non_operational_groups: NonOperationalGroupRoster[];
  dates: string[];
  shift_templates: WorkShiftTemplate[];
}

export interface OperationalGroupRoster {
  group_id: number;
  group_name: string;
  group_code: string;
  department_ids: number[];
  employees: WeeklyRosterEmployee[];
}

export interface NonOperationalGroupRoster {
  department_id: number;
  department_name: string;
  employees: NonOpRosterEmployee[];
}

export interface NonOpRosterEmployee {
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  position_name: string | null;
  schedules: Record<string, EmployeeWorkSchedule | null>;
}

export interface UpdateDepartmentCategoryPayload {
  schedule_category: ScheduleCategory | null;
}

export interface GroupedRosterQuery {
  property_id: number;
  start_date: string;
  end_date: string;
  view_mode?: 'operational' | 'non_operational' | 'all';
  group_id?: number;
  department_id?: number;
}
