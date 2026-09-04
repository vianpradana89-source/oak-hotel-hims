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
  department_id: number | null; // null = global/shared, number = department-scoped
  color_key: string; // manual soft color token
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

export type ViewMode = 'weekly' | 'monthly';

export interface MonthlyRosterEmployee {
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  department_id: number | null;
  department_name: string | null;
  position_name: string | null;
  schedules: Record<string, EmployeeWorkSchedule | null>;
}

export interface MonthlyRosterResponse {
  year: number;
  month: number;
  dates: string[];
  employees: MonthlyRosterEmployee[];
  shift_templates: WorkShiftTemplate[];
}

export interface ShiftTemplateTeamMember {
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  position_name: string | null;
  department_id: number | null;
  department_name: string | null;
  schedule_count: number;
}

export const VALID_COLOR_KEYS = [
  'soft_green', 'soft_blue', 'soft_amber', 'soft_purple',
  'soft_rose', 'soft_cyan', 'soft_slate',
] as const;

export type ColorKey = typeof VALID_COLOR_KEYS[number];

export const COLOR_KEY_STYLES: Record<ColorKey, { bg: string; text: string; border: string; swatch: string }> = {
  soft_green:  { bg: 'bg-emerald-100', text: 'text-emerald-800', border: 'border-emerald-300', swatch: 'bg-emerald-300' },
  soft_blue:   { bg: 'bg-blue-100',    text: 'text-blue-800',    border: 'border-blue-300',    swatch: 'bg-blue-300' },
  soft_amber:  { bg: 'bg-amber-100',   text: 'text-amber-800',   border: 'border-amber-300',   swatch: 'bg-amber-300' },
  soft_purple: { bg: 'bg-purple-100',  text: 'text-purple-800',  border: 'border-purple-300',  swatch: 'bg-purple-300' },
  soft_rose:   { bg: 'bg-rose-100',    text: 'text-rose-800',    border: 'border-rose-300',    swatch: 'bg-rose-300' },
  soft_cyan:   { bg: 'bg-cyan-100',    text: 'text-cyan-800',    border: 'border-cyan-300',    swatch: 'bg-cyan-300' },
  soft_slate:  { bg: 'bg-slate-100',   text: 'text-slate-600',   border: 'border-slate-300',   swatch: 'bg-slate-300' },
};

export interface HrEmployee {
  id: number;
  property_id: number;
  employee_code: string | null;
  full_name: string;
  department_id: number | null;
  department_name: string | null;
  position_id: number | null;
  position_name: string | null;
  is_active: boolean;
}
