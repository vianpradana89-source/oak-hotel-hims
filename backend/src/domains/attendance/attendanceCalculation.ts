// backend/src/domains/attendance/attendanceCalculation.ts
import type { AttendanceStatus, FaceVerificationStatus } from './attendanceTypes';

/**
 * Calculates late minutes based on:
 * late_minutes = max(0, actual_clock_in - scheduled_start - allowed_grace)
 */
export function calculateLateMinutes(
  actualClockIn: Date | string,
  scheduledStart: Date | string,
  allowedGraceMinutes: number = 0
): number {
  const actualTime = new Date(actualClockIn).getTime();
  const scheduledTime = new Date(scheduledStart).getTime();

  if (isNaN(actualTime) || isNaN(scheduledTime)) {
    return 0;
  }

  const diffMs = actualTime - scheduledTime;
  const rawDiffMinutes = Math.floor(diffMs / (1000 * 60));

  const lateMinutes = rawDiffMinutes - Math.max(0, allowedGraceMinutes);
  return Math.max(0, lateMinutes);
}

/**
 * Calculates valid elapsed worked minutes:
 * worked_minutes = max(0, actual_clock_out - actual_clock_in)
 */
export function calculateWorkedMinutes(
  actualClockIn: Date | string,
  actualClockOut: Date | string
): number {
  const inTime = new Date(actualClockIn).getTime();
  const outTime = new Date(actualClockOut).getTime();

  if (isNaN(inTime) || isNaN(outTime)) {
    return 0;
  }

  const diffMs = outTime - inTime;
  return Math.max(0, Math.floor(diffMs / (1000 * 60)));
}

/**
 * Calculates early leave minutes:
 * early_leave_minutes = max(0, scheduled_end - actual_clock_out)
 */
export function calculateEarlyLeaveMinutes(
  actualClockOut: Date | string,
  scheduledEnd: Date | string
): number {
  const outTime = new Date(actualClockOut).getTime();
  const endTime = new Date(scheduledEnd).getTime();

  if (isNaN(outTime) || isNaN(endTime)) {
    return 0;
  }

  const diffMs = endTime - outTime;
  return Math.max(0, Math.floor(diffMs / (1000 * 60)));
}

/**
 * Derives attendance status based on shift, clock times, late minutes, and face verification
 */
export function deriveAttendanceStatus(params: {
  clockInAt?: Date | string | null;
  clockOutAt?: Date | string | null;
  lateMinutes?: number;
  faceVerificationStatus?: FaceVerificationStatus;
  workStatus?: string;
}): AttendanceStatus {
  const { clockInAt, clockOutAt, lateMinutes = 0, faceVerificationStatus, workStatus } = params;

  if (workStatus === 'OFF') return 'OFF';
  if (workStatus === 'LEAVE') return 'LEAVE';
  if (workStatus === 'SICK') return 'SICK';
  if (workStatus === 'PERMISSION') return 'PERMISSION';

  if (!clockInAt) {
    return 'ABSENT';
  }

  if (faceVerificationStatus === 'REVIEW_REQUIRED') {
    return 'REVIEW_REQUIRED';
  }

  if (clockInAt && !clockOutAt) {
    return lateMinutes > 0 ? 'LATE' : 'PRESENT';
  }

  if (lateMinutes > 0) {
    return 'LATE';
  }

  return 'PRESENT';
}
