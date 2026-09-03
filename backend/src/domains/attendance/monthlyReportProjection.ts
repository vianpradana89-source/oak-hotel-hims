// backend/src/domains/attendance/monthlyReportProjection.ts
import type { EmployeeMonthlyReportProjection, EmployeeAttendance, EmployeeWorkSchedule } from './attendanceTypes';

export interface OperationalTaskSummary {
  tasks_assigned: number;
  tasks_completed: number;
  tasks_late: number;
}

export function projectEmployeeMonthlyReport(params: {
  property_id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string;
  department: string;
  position: string;
  year: number;
  month: number;
  schedules: EmployeeWorkSchedule[];
  attendances: EmployeeAttendance[];
  taskSummary?: OperationalTaskSummary;
}): EmployeeMonthlyReportProjection {
  const {
    property_id,
    employee_id,
    employee_name,
    employee_code,
    department,
    position,
    year,
    month,
    schedules,
    attendances,
    taskSummary = { tasks_assigned: 0, tasks_completed: 0, tasks_late: 0 }
  } = params;

  let scheduled_work_days = 0;
  let off_days = 0;
  let leave_days = 0;
  let sick_days = 0;
  let permission_days = 0;

  for (const s of schedules) {
    if (s.schedule_status === 'PUBLISHED') {
      if (s.work_status === 'WORK') scheduled_work_days++;
      else if (s.work_status === 'OFF') off_days++;
      else if (s.work_status === 'LEAVE') leave_days++;
      else if (s.work_status === 'SICK') sick_days++;
      else if (s.work_status === 'PERMISSION') permission_days++;
    }
  }

  let present_days = 0;
  let late_days = 0;
  let total_late_minutes = 0;
  let total_worked_minutes = 0;
  let approved_overtime_minutes = 0;
  let early_leave_count = 0;
  let clock_in_face_verified_count = 0;
  let clock_out_face_verified_count = 0;
  let face_review_required_count = 0;

  for (const att of attendances) {
    if (att.clock_in_at) {
      present_days++;
    }
    if (att.late_minutes > 0) {
      late_days++;
      total_late_minutes += att.late_minutes;
    }
    if (att.worked_minutes > 0) {
      total_worked_minutes += att.worked_minutes;
    }
    if (att.overtime_minutes > 0) {
      approved_overtime_minutes += att.overtime_minutes;
    }
    if (att.early_leave_minutes > 0) {
      early_leave_count++;
    }
    if (att.clock_in_face_status === 'VERIFIED') {
      clock_in_face_verified_count++;
    } else if (att.clock_in_face_status === 'REVIEW_REQUIRED') {
      face_review_required_count++;
    }
    if (att.clock_out_face_status === 'VERIFIED') {
      clock_out_face_verified_count++;
    } else if (att.clock_out_face_status === 'REVIEW_REQUIRED') {
      face_review_required_count++;
    }
  }

  const absent_days = Math.max(0, scheduled_work_days - present_days - leave_days - sick_days - permission_days);
  const task_completion_rate = taskSummary.tasks_assigned > 0
    ? Math.round((taskSummary.tasks_completed / taskSummary.tasks_assigned) * 1000) / 10
    : 100.0;

  return {
    property_id,
    employee_id,
    employee_name,
    employee_code,
    department,
    position,
    year,
    month,
    scheduled_work_days,
    present_days,
    late_days,
    total_late_minutes,
    absent_days,
    leave_days,
    sick_days,
    permission_days,
    off_days,
    total_worked_minutes,
    approved_overtime_minutes,
    early_leave_count,
    clock_in_face_verified_count,
    clock_out_face_verified_count,
    face_review_required_count,
    tasks_assigned: taskSummary.tasks_assigned,
    tasks_completed: taskSummary.tasks_completed,
    tasks_late: taskSummary.tasks_late,
    task_completion_rate
  };
}
