// backend/src/domains/attendance/scheduleSnapshot.ts
import type { EmployeeWorkSchedule, WorkShiftTemplate } from './attendanceTypes';

export interface ScheduleSnapshot {
  schedule_id: number;
  scheduled_start_snapshot: string | null;
  scheduled_end_snapshot: string | null;
  shift_code_snapshot: string;
  shift_name_snapshot: string;
}

/**
 * Creates an immutable schedule snapshot from an active published schedule and shift template.
 * This snapshot is permanently recorded into the attendance row at clock-in time.
 * Even if the manager later changes or edits the employee's schedule, the attendance row
 * maintains its own independent snapshot.
 */
export function createScheduleSnapshot(
  schedule: EmployeeWorkSchedule,
  shiftTemplate: WorkShiftTemplate
): ScheduleSnapshot {
  if (schedule.schedule_status !== 'PUBLISHED') {
    throw new Error(`Cannot snapshot an unpublished schedule (Status: ${schedule.schedule_status})`);
  }

  return {
    schedule_id: schedule.id,
    scheduled_start_snapshot: schedule.scheduled_start_at,
    scheduled_end_snapshot: schedule.scheduled_end_at,
    shift_code_snapshot: shiftTemplate.code,
    shift_name_snapshot: shiftTemplate.name
  };
}

/**
 * Validates that an attendance record preserves its original snapshot when a schedule is updated.
 */
export function assertScheduleSnapshotPreserved(
  originalSnapshot: ScheduleSnapshot,
  currentAttendanceSnapshot: {
    schedule_id: number | null | undefined;
    scheduled_start_snapshot: string | null | undefined;
    scheduled_end_snapshot: string | null | undefined;
    shift_code_snapshot: string | null | undefined;
    shift_name_snapshot: string | null | undefined;
  }
): boolean {
  return (
    originalSnapshot.schedule_id === currentAttendanceSnapshot.schedule_id &&
    originalSnapshot.scheduled_start_snapshot === currentAttendanceSnapshot.scheduled_start_snapshot &&
    originalSnapshot.scheduled_end_snapshot === currentAttendanceSnapshot.scheduled_end_snapshot &&
    originalSnapshot.shift_code_snapshot === currentAttendanceSnapshot.shift_code_snapshot &&
    originalSnapshot.shift_name_snapshot === currentAttendanceSnapshot.shift_name_snapshot
  );
}
