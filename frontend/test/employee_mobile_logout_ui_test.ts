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
  attemptCanonicalLogoutOnce,
  canShowEmployeeMobileClockOut,
  canShowEmployeeMobileLogout,
  hasCompletedAttendanceSession,
  hasOpenAttendanceSession,
  logoutAfterSuccessfulCheckOut,
  resolveManualLogoutEnabled,
  shouldAutoLogoutCompletedAttendance,
  shouldLogoutAfterCheckOutResponse
} from '../src/features/employee/employeeMobileLogoutUi.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

console.log('=== EMPLOYEE-MOBILE-LOGIN-LOOP-1 Completed bootstrap vs CHECK_OUT logout ===\n');

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
check(workspaceSrc.includes('attemptCanonicalLogoutOnce(canonicalLogoutGuardRef'), 'E: CHECK_OUT success shares the once-guard');

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

const completedLogoutReady = {
  isPreview: false,
  hasLogoutHandler: true,
  identityUnlinked: false,
  attendanceStateKnown: true,
  hasCheckedIn: true,
  hasCheckedOut: true
};
const bootstrapCompleted = { ...completedLogoutReady, source: 'bootstrap' as const };
const checkoutSuccessCompleted = { ...completedLogoutReady, source: 'checkout_success' as const };
const protectedRouteSrc = readSrc('src/features/auth/ProtectedRoute.tsx');
const authContextSrc = readSrc('src/features/auth/AuthContext.tsx');

check(
  shouldAutoLogoutCompletedAttendance({
    ...bootstrapCompleted,
    hasCheckedIn: false,
    hasCheckedOut: false
  }) === false,
  'A: READY not completed -> no bootstrap logout'
);
check(
  !workspaceSrc.includes('shouldAutoLogoutCompletedAttendance({'),
  'A: workspace does not auto-logout on attendance bootstrap'
);
check(
  protectedRouteSrc.includes("user?.access_type === 'MOBILE_ONLY'")
    && protectedRouteSrc.includes('<EmployeeMobileWorkspace'),
  'A: READY MOBILE_ONLY still enters Employee Mobile'
);

check(
  shouldAutoLogoutCompletedAttendance(completedLogoutReady) === false,
  'B: completed bootstrap (default source) does not logout'
);
check(
  shouldAutoLogoutCompletedAttendance(bootstrapCompleted) === false,
  'B: explicit bootstrap completed attendance does not logout'
);
check(
  workspaceSrc.includes('EMPLOYEE_MOBILE_COMPLETED_SHIFT_TITLE')
    && workspaceSrc.includes('{completedAttendance && ('),
  'B: completed-shift copy remains visible after bootstrap'
);
check(
  canShowEmployeeMobileClockOut({
    attendanceStateKnown: true,
    hasCheckedIn: true,
    hasCheckedOut: true
  }) === false,
  'B: completed bootstrap hides Clock Out'
);

logoutCalls = 0;
const checkoutGuard = { current: false };
check(shouldLogoutAfterCheckOutResponse({ httpOk: true, status: 'OK' }) === true, 'C: successful CHECK_OUT may logout');
check(
  shouldAutoLogoutCompletedAttendance(checkoutSuccessCompleted) === true,
  'C: checkout_success source still allows completed-session logout'
);
check(attemptCanonicalLogoutOnce(checkoutGuard, () => logoutAfterSuccessfulCheckOut(onLogout)) === true, 'C: first CHECK_OUT success consumes the guard');
check(attemptCanonicalLogoutOnce(checkoutGuard, () => logoutAfterSuccessfulCheckOut(onLogout)) === false, 'C: duplicate CHECK_OUT completion does not logout again');
check(logoutCalls === 1, 'C: successful CHECK_OUT total onLogout is exactly once');
check(workspaceSrc.includes('logoutAfterSuccessfulCheckOut(onLogout)'), 'C: workspace still auto-logouts after CHECK_OUT success');
check(workspaceSrc.includes('attemptCanonicalLogoutOnce(canonicalLogoutGuardRef'), 'C: CHECK_OUT success shares the once-guard');

logoutCalls = 0;
check(shouldAutoLogoutCompletedAttendance(bootstrapCompleted) === false, 'D: repeated completed bootstrap still no logout');
check(shouldAutoLogoutCompletedAttendance(bootstrapCompleted) === false, 'D: second completed bootstrap evaluation still no logout');
check(logoutCalls === 0, 'D: repeated completed bootstrap leaves onLogout at zero');

logoutCalls = 0;
check(applyEmployeeMobileLogoutUiEvent(true, 'CONFIRM', onLogout) === false, 'E: manual confirm still logs out');
check(logoutCalls === 1, 'E: manual logout calls onLogout once');

check(
  authContextSrc.includes('localStorage.removeItem(TOKEN_KEY)')
    && authContextSrc.includes("fetch('/api/auth/me'")
    && authContextSrc.includes('setUser(null)'),
  'F: cold-session /me failure still clears JWT and user'
);
check(!authContextSrc.includes('shouldAutoLogoutCompletedAttendance'), 'F: AuthContext is not used for completed-attendance logout');

check(
  protectedRouteSrc.includes("user?.scope === 'ONBOARDING'")
    && protectedRouteSrc.includes('<OnboardingWorkspace />'),
  'G/H: FIRST_LOGIN / FACE_ENROLLMENT stay on authenticated onboarding'
);
check(!protectedRouteSrc.includes('shouldAutoLogoutCompletedAttendance'), 'G/H: ProtectedRoute does not clear session for lifecycle screens');

check(
  shouldAutoLogoutCompletedAttendance({ ...bootstrapCompleted, identityUnlinked: true }) === false,
  'I: unlinked identity does not auto-logout on bootstrap'
);
check(
  canShowEmployeeMobileLogout({
    isPreview: false,
    hasLogoutHandler: true,
    identityUnlinked: true,
    attendanceStateKnown: true,
    hasCheckedIn: true,
    hasCheckedOut: true,
    manualLogoutEnabled: false
  }) === true,
  'I: unlinked identity keeps manual logout'
);
check(workspaceSrc.includes('Identitas Karyawan Tidak Tersedia'), 'I: unlinked UI remains');

check(
  shouldAutoLogoutCompletedAttendance({
    ...checkoutSuccessCompleted,
    hasCheckedOut: false
  }) === false,
  '1D-B: open attendance still does not auto-logout'
);
check(
  canShowEmployeeMobileClockOut({
    attendanceStateKnown: true,
    hasCheckedIn: true,
    hasCheckedOut: false
  }) === true,
  '1D-B: open attendance still shows Clock Out'
);
check(
  shouldAutoLogoutCompletedAttendance({ ...checkoutSuccessCompleted, attendanceStateKnown: false }) === false,
  '1D-F: loading/unknown attendance -> no logout'
);
check(
  shouldAutoLogoutCompletedAttendance({
    ...checkoutSuccessCompleted,
    attendanceStateKnown: false,
    hasCheckedIn: undefined,
    hasCheckedOut: undefined
  }) === false,
  '1D-G: fetch failure/null status -> no logout'
);
check(
  shouldAutoLogoutCompletedAttendance({ ...checkoutSuccessCompleted, identityUnlinked: true }) === false,
  '1D-H: unlinked identity does not auto-logout on checkout_success helper'
);
check(
  shouldAutoLogoutCompletedAttendance({ ...checkoutSuccessCompleted, isPreview: true }) === false,
  '1D-I: preview completed state does not auto-logout'
);
check(!previewMount.includes('onLogout'), '1D-I: desktop preview still does not wire onLogout');

logoutCalls = 0;
check(shouldLogoutAfterCheckOutResponse({ httpOk: false, status: 'ERROR' }) === false, '1D-K: failed CHECK_OUT does not logout');
check(logoutCalls === 0, '1D-K: failed CHECK_OUT leaves onLogout at zero');

check(
  workspaceSrc.includes('canShowEmployeeMobileClockOut({')
    && workspaceSrc.includes('if (!canShowEmployeeMobileClockOut({'),
  '1D-L: completed status cannot create another CHECK_OUT'
);
check(!logoutHelperSrc.includes('/api/attendance/check-in'), '1D-L: completed helper does not POST check-in');
check(workspaceSrc.includes('attemptCanonicalLogoutOnce(canonicalLogoutGuardRef'), 'J: workspace still guards checkout logout with a ref');

console.log(`\n${assertions} assertions passed.`);
