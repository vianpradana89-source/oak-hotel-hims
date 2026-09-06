import type { AttendanceEligibility, EmployeeAttendanceStatus } from './attendanceTypes';

const NON_WORKING_LABELS: Record<string, string> = {
  OFF: 'OFF',
  LEAVE: 'Cuti',
  SICK: 'Sakit',
  PERMISSION: 'Ijin',
  HOLIDAY: 'Libur',
  OTHER: 'Lainnya'
};

export function normalizeAttendanceStatus(raw: any): EmployeeAttendanceStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const eligibility = raw.attendance_eligibility && typeof raw.attendance_eligibility === 'object'
    ? raw.attendance_eligibility
    : null;

  return {
    ...raw,
    today_check_in: raw.today_check_in || raw.check_in_record || null,
    today_check_out: raw.today_check_out || raw.check_out_record || null,
    settings: {
      ...settings,
      require_published_schedule_for_attendance: Boolean(settings.require_published_schedule_for_attendance),
      employee_mobile_manual_logout_enabled: settings.employee_mobile_manual_logout_enabled !== false
    },
    manual_logout_enabled: raw.manual_logout_enabled !== false
      && settings.employee_mobile_manual_logout_enabled !== false,
    attendance_eligibility: eligibility
      ? {
          can_clock_in: Boolean(eligibility.can_clock_in),
          reason_code: eligibility.reason_code || 'SCHEDULE_NOT_REQUIRED',
          schedule_required: Boolean(eligibility.schedule_required),
          schedule_found: Boolean(eligibility.schedule_found),
          work_date: eligibility.work_date || null,
          shift_start: eligibility.shift_start || null,
          shift_end: eligibility.shift_end || null,
          schedule_status: eligibility.schedule_status || null,
          work_status: eligibility.work_status || null
        }
      : {
          can_clock_in: true,
          reason_code: 'SCHEDULE_NOT_REQUIRED',
          schedule_required: false,
          schedule_found: false,
          work_date: null,
          shift_start: null,
          shift_end: null,
          schedule_status: null,
          work_status: null
        }
  };
}

export function shouldAutoOpenAttendanceTaskGate(status: EmployeeAttendanceStatus | null | undefined): boolean {
  if (!status) return false;
  const scheduleRequired = Boolean(
    status.settings?.require_published_schedule_for_attendance
    || status.attendance_eligibility?.schedule_required
  );
  if (scheduleRequired) return false;
  return Boolean(status.attendance_required && !status.has_checked_in);
}

export function isClockInDisabledByServer(eligibility: AttendanceEligibility | null | undefined): boolean {
  if (!eligibility) return false;
  return eligibility.can_clock_in === false;
}

export function attendanceEligibilityReasonText(eligibility: AttendanceEligibility | null | undefined): string | null {
  if (!eligibility || eligibility.can_clock_in) return null;
  if (eligibility.reason_code === 'NO_PUBLISHED_SCHEDULE') {
    return 'Tidak ada jadwal kerja published untuk saat ini.';
  }
  if (eligibility.reason_code === 'NON_WORKING_DAY') {
    const label = eligibility.work_status ? (NON_WORKING_LABELS[eligibility.work_status] || eligibility.work_status) : null;
    return label ? `Jadwal hari ini: ${label}` : 'Jadwal hari ini bukan hari kerja.';
  }
  if (eligibility.reason_code === 'ALREADY_CLOCKED_IN') {
    return 'Sudah melakukan absen masuk.';
  }
  return 'Clock In tidak tersedia.';
}

export function nonWorkingScheduleLabel(workStatus: string | null | undefined): string {
  if (!workStatus) return '—';
  return NON_WORKING_LABELS[workStatus] || workStatus;
}
