// backend/src/domains/schedule/scheduleTypes.ts

import type { WorkShiftTemplate, EmployeeWorkSchedule, WorkScheduleAudit, ScheduleStatus, WorkStatusType } from '../attendance/attendanceTypes';

export type { WorkShiftTemplate, EmployeeWorkSchedule, WorkScheduleAudit, ScheduleStatus, WorkStatusType };

export interface ShiftTemplateListQuery {
  property_id: number;
  include_inactive?: boolean;
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
