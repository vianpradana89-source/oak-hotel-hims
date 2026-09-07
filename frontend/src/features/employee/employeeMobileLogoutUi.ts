export const EMPLOYEE_MOBILE_LOGOUT_LABEL = 'Keluar Akun';
export const EMPLOYEE_MOBILE_LOGOUT_CONFIRM_TITLE = 'Keluar dari akun ini?';
export const EMPLOYEE_MOBILE_LOGOUT_CANCEL_LABEL = 'Batal';
export const EMPLOYEE_MOBILE_LOGOUT_CONFIRM_ACTION_LABEL = 'Keluar';
export const EMPLOYEE_MOBILE_COMPLETED_SHIFT_TITLE = 'Shift hari ini telah selesai';
export const EMPLOYEE_MOBILE_COMPLETED_SHIFT_BODY = 'Absen masuk dan pulang telah tercatat.';

export type EmployeeMobileLogoutUiEvent = 'REQUEST' | 'CANCEL' | 'CONFIRM';

export function hasOpenAttendanceSession(status: {
  has_checked_in?: boolean | null;
  has_checked_out?: boolean | null;
} | null | undefined): boolean {
  return status?.has_checked_in === true && status?.has_checked_out !== true;
}

export function hasCompletedAttendanceSession(status: {
  has_checked_in?: boolean | null;
  has_checked_out?: boolean | null;
} | null | undefined): boolean {
  return status?.has_checked_in === true && status?.has_checked_out === true;
}

export function canShowEmployeeMobileClockOut(input: {
  attendanceStateKnown?: boolean;
  hasCheckedIn?: boolean;
  hasCheckedOut?: boolean;
}): boolean {
  return input.attendanceStateKnown === true
    && input.hasCheckedIn === true
    && input.hasCheckedOut !== true;
}

export function resolveManualLogoutEnabled(status: {
  manual_logout_enabled?: boolean | null;
  settings?: { employee_mobile_manual_logout_enabled?: boolean | null } | null;
} | null | undefined): boolean {
  if (!status) {
    return false;
  }
  if (typeof status.manual_logout_enabled === 'boolean') {
    return status.manual_logout_enabled;
  }
  if (typeof status.settings?.employee_mobile_manual_logout_enabled === 'boolean') {
    return status.settings.employee_mobile_manual_logout_enabled;
  }
  return true;
}

export function canShowEmployeeMobileLogout(input: {
  isPreview?: boolean;
  hasLogoutHandler?: boolean;
  identityUnlinked?: boolean;
  attendanceStateKnown?: boolean;
  hasCheckedIn?: boolean;
  hasCheckedOut?: boolean;
  manualLogoutEnabled?: boolean;
  hasSchedule?: boolean;
  taskCount?: number;
  departmentName?: string | null;
  workStatus?: string | null;
}): boolean {
  if (input.isPreview === true || !input.hasLogoutHandler) {
    return false;
  }
  if (input.identityUnlinked) {
    return true;
  }
  if (input.attendanceStateKnown !== true) {
    return false;
  }
  if (input.hasCheckedIn !== false) {
    return false;
  }
  return input.manualLogoutEnabled === true;
}

export function applyEmployeeMobileLogoutUiEvent(
  confirmOpen: boolean,
  event: EmployeeMobileLogoutUiEvent,
  onLogout?: () => void
): boolean {
  if (event === 'REQUEST') {
    return true;
  }
  if (event === 'CANCEL') {
    return false;
  }
  if (event === 'CONFIRM') {
    onLogout?.();
    return false;
  }
  return confirmOpen;
}

export function shouldLogoutAfterCheckOutResponse(input: {
  httpOk?: boolean;
  status?: string | null;
  photoRequired?: boolean;
  photoAttached?: boolean;
  photoValidationFailed?: boolean;
  duplicateOrFailed?: boolean;
  manualLogoutEnabled?: boolean;
}): boolean {
  if (input.photoValidationFailed === true) {
    return false;
  }
  if (input.duplicateOrFailed === true) {
    return false;
  }
  if (input.photoRequired === true && input.photoAttached !== true) {
    return false;
  }
  return input.httpOk === true && input.status === 'OK';
}

export function logoutAfterSuccessfulCheckOut(onLogout?: () => void): void {
  onLogout?.();
}

/**
 * Real Employee Mobile only. Property manual-logout toggle must not suppress this.
 * Never auto-logout while loading, on fetch failure, in preview, or for unlinked identity.
 */
export function shouldAutoLogoutCompletedAttendance(input: {
  isPreview?: boolean;
  hasLogoutHandler?: boolean;
  identityUnlinked?: boolean;
  attendanceStateKnown?: boolean;
  hasCheckedIn?: boolean;
  hasCheckedOut?: boolean;
  manualLogoutEnabled?: boolean;
}): boolean {
  if (input.isPreview === true) return false;
  if (input.hasLogoutHandler !== true) return false;
  if (input.identityUnlinked === true) return false;
  if (input.attendanceStateKnown !== true) return false;
  return input.hasCheckedIn === true && input.hasCheckedOut === true;
}

export function attemptCanonicalLogoutOnce(
  guard: { current: boolean },
  onLogout?: () => void
): boolean {
  if (guard.current) return false;
  if (typeof onLogout !== 'function') return false;
  guard.current = true;
  onLogout();
  return true;
}
