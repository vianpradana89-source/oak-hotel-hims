// frontend/src/features/hrd/scheduleTypes.ts

export interface WorkShiftTemplate {
  id: number;
  property_id: number;
  code: string;
  name: string;
  start_time: string;
  end_time: string;
  crosses_midnight: boolean;
  grace_before_minutes: number;
  late_grace_minutes: number;
  checkout_grace_minutes: number;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
}

export type ScheduleStatus = 'DRAFT' | 'PUBLISHED' | 'CHANGED' | 'CANCELLED';

export type WorkStatusType = 'WORK' | 'OFF' | 'LEAVE' | 'SICK' | 'PERMISSION' | 'HOLIDAY' | 'OTHER';

export interface EmployeeWorkSchedule {
  id: number;
  property_id: number;
  employee_id: number;
  work_date: string;
  shift_template_id: number | null;
  schedule_status: ScheduleStatus;
  work_status: WorkStatusType;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  department_snapshot?: string | null;
  position_snapshot?: string | null;
  published_at?: string | null;
  published_by_user_id?: number | null;
  published_by_name?: string | null;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface WeeklyRosterEmployee {
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  department_id: number | null;
  department_name: string | null;
  position_name: string | null;
  schedules: Record<string, EmployeeWorkSchedule | null>;
}

export interface WeeklyRosterResponse {
  start_date: string;
  end_date: string;
  dates: string[];
  employees: WeeklyRosterEmployee[];
  shift_templates: WorkShiftTemplate[];
}

export interface Department {
  id: number;
  property_id: number;
  code: string;
  name: string;
  is_active: boolean;
}
