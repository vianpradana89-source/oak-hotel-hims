import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMPLOYEE_MOBILE_COMPLETED_SHIFT_BODY,
  EMPLOYEE_MOBILE_COMPLETED_SHIFT_TITLE,
  EMPLOYEE_MOBILE_LOGOUT_CANCEL_LABEL,
  EMPLOYEE_MOBILE_LOGOUT_CONFIRM_ACTION_LABEL,
  EMPLOYEE_MOBILE_LOGOUT_CONFIRM_TITLE,
  EMPLOYEE_MOBILE_LOGOUT_LABEL,
  applyEmployeeMobileLogoutUiEvent,
  canShowEmployeeMobileClockOut,
  canShowEmployeeMobileLogout,
  hasCompletedAttendanceSession,
  hasOpenAttendanceSession,
  logoutAfterSuccessfulCheckOut,
  resolveManualLogoutEnabled,
  shouldLogoutAfterCheckOutResponse
} from '../src/features/employee/employeeMobileLogoutUi.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

console.log('=== EMPLOYEE-MOBILE-LOGOUT-1C Completed-attendance UI ===\n');

const workspaceSrc = readSrc('src/features/employee/EmployeeMobileWorkspace.tsx');
const logoutHelperSrc = readSrc('src/features/employee/employeeMobileLogoutUi.ts');
const appSrc = readSrc('src/App.tsx');
const previewMount = appSrc.slice(
  appSrc.indexOf("selectedMenu === 'Mobile Portal'"),
  appSrc.indexOf("selectedMenu === 'HRD'")
);

const realReady = {
  isPreview: false,
  hasLogoutHandler: true,
  attendanceStateKnown: true,
  hasCheckedIn: false,
  hasCheckedOut: false
};

check(
  canShowEmployeeMobileLogout({ ...realReady, manualLogoutEnabled: true }) === true,
  'A: not checked in + toggle ON -> manual logout shown'
);
check(
  canShowEmployeeMobileClockOut({
    attendanceStateKnown: true,
    hasCheckedIn: false,
    hasCheckedOut: false
  }) === false,
  'A: not checked in -> Clock Out hidden'
);

check(
  canShowEmployeeMobileLogout({ ...realReady, manualLogoutEnabled: false }) === false,
  'B: not checked in + toggle OFF -> logout hidden'
);
check(
  canShowEmployeeMobileClockOut({
    attendanceStateKnown: true,
    hasCheckedIn: false,
    hasCheckedOut: false
  }) === false,
  'B: not checked in + toggle OFF -> Clock Out still hidden'
);

check(
  canShowEmployeeMobileLogout({
    ...realReady,
    hasCheckedIn: true,
    hasCheckedOut: false,
    manualLogoutEnabled: true
  }) === false,
  'C: open attendance hides manual logout'
);
check(
  canShowEmployeeMobileClockOut({
    attendanceStateKnown: true,
    hasCheckedIn: true,
    hasCheckedOut: false
  }) === true,
  'C: open attendance shows Clock Out'
);
check(hasOpenAttendanceSession({ has_checked_in: true, has_checked_out: false }) === true, 'C: open session detected');

check(
  canShowEmployeeMobileLogout({
    ...realReady,
    hasCheckedIn: true,
    hasCheckedOut: true,
    manualLogoutEnabled: true
  }) === false,
  'D: completed attendance hides manual logout'
);
check(
  canShowEmployeeMobileClockOut({
    attendanceStateKnown: true,
    hasCheckedIn: true,
    hasCheckedOut: true
  }) === false,
  'D: completed attendance hides Clock Out'
);
check(hasCompletedAttendanceSession({ has_checked_in: true, has_checked_out: true }) === true, 'D: completed session detected');
check(EMPLOYEE_MOBILE_COMPLETED_SHIFT_TITLE === 'Shift hari ini telah selesai', 'D: completed title is exact');
check(EMPLOYEE_MOBILE_COMPLETED_SHIFT_BODY === 'Absen masuk dan pulang telah tercatat.', 'D: completed body is exact');
check(workspaceSrc.includes('EMPLOYEE_MOBILE_COMPLETED_SHIFT_TITLE'), 'D: workspace renders completed-shift copy');
check(workspaceSrc.includes('clockOutAvailable &&'), 'D: Clock Out is gated');
check(workspaceSrc.includes('hasCheckedIn !== false') || logoutHelperSrc.includes('hasCheckedIn !== false'), 'D: logout requires has_checked_in === false');

let logoutCalls = 0;
const onLogout = () => {
  logoutCalls += 1;
};
check(shouldLogoutAfterCheckOutResponse({ httpOk: true, status: 'OK' }) === true, 'E: successful CHECK_OUT may logout');
logoutAfterSuccessfulCheckOut(onLogout);
check(logoutCalls === 1, 'E: successful CHECK_OUT calls onLogout once');
check(workspaceSrc.includes('logoutAfterSuccessfulCheckOut(onLogout)'), 'E: workspace auto-logouts after success');

logoutCalls = 0;
check(shouldLogoutAfterCheckOutResponse({ httpOk: false, status: 'ERROR' }) === false, 'F: failed CHECK_OUT does not logout');
check(logoutCalls === 0, 'F: failed CHECK_OUT leaves onLogout at zero');

check(workspaceSrc.includes('canShowEmployeeMobileClockOut({'), 'G: CHECK_OUT submit is re-gated');
check(
  workspaceSrc.includes('hasCheckedOut: attendanceStatus?.has_checked_out')
    && workspaceSrc.includes('if (!canShowEmployeeMobileClockOut({'),
  'G: completed attendance cannot send another CHECK_OUT'
);

check(
  canShowEmployeeMobileLogout({
    isPreview: false,
    hasLogoutHandler: true,
    attendanceStateKnown: false,
    hasCheckedIn: false,
    manualLogoutEnabled: true
  }) === false,
  'H: unknown attendance hides manual logout'
);
check(
  canShowEmployeeMobileClockOut({
    attendanceStateKnown: false,
    hasCheckedIn: true,
    hasCheckedOut: false
  }) === false,
  'H: unknown attendance hides Clock Out'
);

check(
  canShowEmployeeMobileLogout({
    isPreview: false,
    hasLogoutHandler: true,
    identityUnlinked: true,
    attendanceStateKnown: false,
    hasCheckedIn: true,
    hasCheckedOut: true,
    manualLogoutEnabled: false
  }) === true,
  'I: unlinked identity may still logout'
);

check(
  canShowEmployeeMobileLogout({
    ...realReady,
    isPreview: true,
    manualLogoutEnabled: true
  }) === false,
  'J: preview hides logout'
);
check(!previewMount.includes('onLogout'), 'J: desktop preview does not wire onLogout');

check(EMPLOYEE_MOBILE_LOGOUT_LABEL === 'Keluar Akun', 'logout label unchanged');
check(EMPLOYEE_MOBILE_LOGOUT_CONFIRM_TITLE === 'Keluar dari akun ini?', 'confirm title unchanged');
check(EMPLOYEE_MOBILE_LOGOUT_CANCEL_LABEL === 'Batal', 'cancel label unchanged');
check(EMPLOYEE_MOBILE_LOGOUT_CONFIRM_ACTION_LABEL === 'Keluar', 'confirm action unchanged');
check(applyEmployeeMobileLogoutUiEvent(true, 'CANCEL', onLogout) === false, 'Batal still does not logout');
check(resolveManualLogoutEnabled(null) === false, 'missing status fails closed');
check(!logoutHelperSrc.includes('/api/attendance/check-out'), 'visibility helper does not POST attendance');

console.log(`\n${assertions} assertions passed.`);
