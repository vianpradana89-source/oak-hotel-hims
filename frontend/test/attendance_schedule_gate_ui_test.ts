import assert from 'node:assert/strict';
import {
  attendanceEligibilityReasonText,
  isClockInDisabledByServer,
  nonWorkingScheduleLabel,
  normalizeAttendanceStatus,
  shouldAutoOpenAttendanceTaskGate
} from '../src/features/employee/attendanceEligibilityUi.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== ATTENDANCE-SCHEDULE-GATE-1A Frontend UI ===\n');

const baseStatus = {
  attendance_enabled: true,
  require_employee_attendance: true,
  is_exempt: false,
  attendance_required: true,
  has_checked_in: false,
  has_checked_out: false,
  today_check_in: null,
  today_check_out: null,
  hotel_date: '2026-09-06',
  server_time: '2026-09-06T10:00:00.000Z',
  timezone: 'Asia/Jakarta',
  settings: {
    property_id: 1,
    attendance_enabled: true,
    require_employee_attendance: true,
    require_checkin_photo: false,
    require_checkout_photo: false,
    geofence_enabled: false,
    geofence_latitude: null,
    geofence_longitude: null,
    geofence_radius_meters: 100,
    outside_geofence_policy: 'ALLOW_WITH_REASON' as const,
    exempt_roles: [],
    require_published_schedule_for_attendance: false
  }
};

check(
  shouldAutoOpenAttendanceTaskGate(normalizeAttendanceStatus(baseStatus)) === true,
  'Q/toggle-off: existing task gate still auto-opens when attendance is required'
);

const scheduleOnNoRow = normalizeAttendanceStatus({
  ...baseStatus,
  settings: {
    ...baseStatus.settings,
    require_published_schedule_for_attendance: true
  },
  attendance_eligibility: {
    can_clock_in: false,
    reason_code: 'NO_PUBLISHED_SCHEDULE',
    schedule_required: true,
    schedule_found: false,
    work_date: null,
    shift_start: null,
    shift_end: null,
    schedule_status: null,
    work_status: null
  }
});

check(scheduleOnNoRow !== null, 'normalized no-schedule status exists');
check(shouldAutoOpenAttendanceTaskGate(scheduleOnNoRow) === false, 'Q: schedule gate must not replace the workspace');
check(isClockInDisabledByServer(scheduleOnNoRow?.attendance_eligibility) === true, 'Clock In disabled from server eligibility');
check(
  attendanceEligibilityReasonText(scheduleOnNoRow?.attendance_eligibility) === 'Tidak ada jadwal kerja published untuk saat ini.',
  'Q: no published schedule copy is exact'
);

const leaveStatus = normalizeAttendanceStatus({
  ...baseStatus,
  check_in_record: { id: 9 },
  attendance_eligibility: {
    can_clock_in: false,
    reason_code: 'NON_WORKING_DAY',
    schedule_required: true,
    schedule_found: true,
    work_date: '2026-09-06',
    shift_start: null,
    shift_end: null,
    schedule_status: 'PUBLISHED',
    work_status: 'LEAVE'
  }
});
check(leaveStatus?.today_check_in?.id === 9, 'check_in_record maps to today_check_in');
check(attendanceEligibilityReasonText(leaveStatus?.attendance_eligibility) === 'Jadwal hari ini: Cuti', 'LEAVE uses Cuti label');
check(attendanceEligibilityReasonText({
  can_clock_in: false,
  reason_code: 'NON_WORKING_DAY',
  schedule_required: true,
  schedule_found: true,
  work_date: '2026-09-06',
  shift_start: null,
  shift_end: null,
  schedule_status: 'PUBLISHED',
  work_status: 'SICK'
}) === 'Jadwal hari ini: Sakit', 'SICK uses Sakit label');
check(attendanceEligibilityReasonText({
  can_clock_in: false,
  reason_code: 'NON_WORKING_DAY',
  schedule_required: true,
  schedule_found: true,
  work_date: '2026-09-06',
  shift_start: null,
  shift_end: null,
  schedule_status: 'PUBLISHED',
  work_status: 'PERMISSION'
}) === 'Jadwal hari ini: Ijin', 'PERMISSION uses Ijin label');
check(attendanceEligibilityReasonText({
  can_clock_in: false,
  reason_code: 'NON_WORKING_DAY',
  schedule_required: true,
  schedule_found: true,
  work_date: '2026-09-06',
  shift_start: null,
  shift_end: null,
  schedule_status: 'PUBLISHED',
  work_status: 'HOLIDAY'
}) === 'Jadwal hari ini: Libur', 'HOLIDAY uses Libur label');
check(attendanceEligibilityReasonText({
  can_clock_in: false,
  reason_code: 'NON_WORKING_DAY',
  schedule_required: true,
  schedule_found: true,
  work_date: '2026-09-06',
  shift_start: null,
  shift_end: null,
  schedule_status: 'PUBLISHED',
  work_status: 'OFF'
}) === 'Jadwal hari ini: OFF', 'OFF uses OFF label');
check(nonWorkingScheduleLabel('LEAVE') === 'Cuti', 'non-working label helper');

const missingField = normalizeAttendanceStatus({
  ...baseStatus,
  settings: {
    ...baseStatus.settings,
    require_published_schedule_for_attendance: undefined
  }
});
check(missingField?.settings.require_published_schedule_for_attendance === false, 'missing toggle defaults visual/state FALSE');
check(shouldAutoOpenAttendanceTaskGate(missingField) === true, 'missing toggle keeps current task-gate behavior');

console.log(`\n${assertions} assertions passed.`);
