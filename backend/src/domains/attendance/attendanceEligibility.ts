import type { Pool, PoolClient } from 'pg';
import type {
  AttendanceEligibility,
  PropertyAttendanceSettings,
  ScheduleStatus,
  WorkStatusType
} from './attendanceTypes';
import type { AttendanceWorkCycleResult } from '../schedule/scheduleTypes';

export const NON_WORKING_SCHEDULE_STATUSES: readonly WorkStatusType[] = [
  'OFF',
  'LEAVE',
  'SICK',
  'PERMISSION',
  'HOLIDAY',
  'OTHER'
];

export function isWorkingScheduleStatus(status: string | null | undefined): boolean {
  return status === 'WORK';
}

function emptyScheduleFields() {
  return {
    schedule_found: false,
    work_date: null as string | null,
    shift_start: null as string | null,
    shift_end: null as string | null,
    schedule_status: null as ScheduleStatus | null,
    work_status: null as WorkStatusType | null
  };
}

function cycleFields(cycle: AttendanceWorkCycleResult | null) {
  if (!cycle?.found || !cycle.schedule) {
    return emptyScheduleFields();
  }
  return {
    schedule_found: true,
    work_date: cycle.schedule.work_date || null,
    shift_start: cycle.schedule.scheduled_start_at || null,
    shift_end: cycle.schedule.scheduled_end_at || null,
    schedule_status: cycle.schedule.schedule_status || null,
    work_status: cycle.schedule.work_status || null
  };
}

export function resolveAttendanceEligibility(params: {
  settings: PropertyAttendanceSettings;
  alreadyClockedIn: boolean;
  cycle: AttendanceWorkCycleResult | null;
}): AttendanceEligibility {
  const scheduleRequired = Boolean(params.settings.require_published_schedule_for_attendance);
  const fields = scheduleRequired ? cycleFields(params.cycle) : emptyScheduleFields();

  if (params.alreadyClockedIn) {
    return {
      can_clock_in: false,
      reason_code: 'ALREADY_CLOCKED_IN',
      schedule_required: scheduleRequired,
      ...fields
    };
  }

  if (!scheduleRequired) {
    return {
      can_clock_in: true,
      reason_code: 'SCHEDULE_NOT_REQUIRED',
      schedule_required: false,
      ...emptyScheduleFields()
    };
  }

  if (!params.cycle?.found || !params.cycle.schedule) {
    return {
      can_clock_in: false,
      reason_code: 'NO_PUBLISHED_SCHEDULE',
      schedule_required: true,
      ...emptyScheduleFields()
    };
  }

  if (!isWorkingScheduleStatus(params.cycle.schedule.work_status)) {
    return {
      can_clock_in: false,
      reason_code: 'NON_WORKING_DAY',
      schedule_required: true,
      ...fields
    };
  }

  return {
    can_clock_in: true,
    reason_code: 'ELIGIBLE',
    schedule_required: true,
    ...fields
  };
}

export async function findOpenAttendanceWorkDate(
  db: Pool | PoolClient,
  propertyId: number,
  employeeId: number
): Promise<string | null> {
  const canonical = await db.query(
    `SELECT work_date::text AS work_date
     FROM employee_attendance
     WHERE property_id = $1
       AND employee_id = $2
       AND clock_in_at IS NOT NULL
       AND clock_out_at IS NULL
     ORDER BY work_date DESC
     LIMIT 1`,
    [propertyId, employeeId]
  );
  if ((canonical.rowCount ?? 0) > 0 && canonical.rows[0].work_date) {
    return String(canonical.rows[0].work_date).slice(0, 10);
  }

  const events = await db.query(
    `SELECT attendance_date::text AS attendance_date
     FROM employee_attendance_records
     WHERE property_id = $1
       AND employee_id = $2
       AND attendance_type = 'CHECK_IN'
       AND attendance_date >= (CURRENT_DATE - INTERVAL '2 days')
     ORDER BY attendance_date DESC, id DESC`,
    [propertyId, employeeId]
  );

  for (const row of events.rows) {
    const attendanceDate = String(row.attendance_date || '').slice(0, 10);
    if (!attendanceDate) continue;
    const checkout = await db.query(
      `SELECT 1
       FROM employee_attendance_records
       WHERE property_id = $1
         AND employee_id = $2
         AND attendance_date = $3
         AND attendance_type = 'CHECK_OUT'
       LIMIT 1`,
      [propertyId, employeeId, attendanceDate]
    );
    if ((checkout.rowCount ?? 0) === 0) {
      return attendanceDate;
    }
  }

  return null;
}

export function scheduleGateMessage(reasonCode: AttendanceEligibility['reason_code']): string {
  if (reasonCode === 'NO_PUBLISHED_SCHEDULE') {
    return 'Tidak ada jadwal kerja published untuk saat ini.';
  }
  if (reasonCode === 'NON_WORKING_DAY') {
    return 'Jadwal hari ini bukan hari kerja.';
  }
  if (reasonCode === 'ALREADY_CLOCKED_IN') {
    return 'Sudah melakukan absen masuk.';
  }
  return 'Clock In tidak tersedia.';
}

export function scheduleGateHttpError(reasonCode: AttendanceEligibility['reason_code'], message?: string): never {
  const err: any = new Error(message || scheduleGateMessage(reasonCode));
  err.statusCode = 409;
  err.code = reasonCode;
  throw err;
}
