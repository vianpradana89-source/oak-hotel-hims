import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMPLOYEE_MOBILE_LOGOUT_CANCEL_LABEL,
  EMPLOYEE_MOBILE_LOGOUT_CONFIRM_ACTION_LABEL,
  EMPLOYEE_MOBILE_LOGOUT_CONFIRM_TITLE,
  EMPLOYEE_MOBILE_LOGOUT_LABEL,
  applyEmployeeMobileLogoutUiEvent,
  canShowEmployeeMobileLogout,
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

console.log('=== EMPLOYEE-MOBILE-LOGOUT-1B Manual logout visibility toggle ===\n');

const workspaceSrc = readSrc('src/features/employee/EmployeeMobileWorkspace.tsx');
const protectedRouteSrc = readSrc('src/features/auth/ProtectedRoute.tsx');
const appSrc = readSrc('src/App.tsx');
const authContextSrc = readSrc('src/features/auth/AuthContext.tsx');
const logoutHelperSrc = readSrc('src/features/employee/employeeMobileLogoutUi.ts');
const globalBarSrc = readSrc('src/features/shell/GlobalOperationsBar.tsx');
const gateSrc = readSrc('src/features/employee/AttendanceGateScreen.tsx');
const settingsTabSrc = readSrc('src/features/settings/AttendanceSettingsTab.tsx');

const realReady = {
  isPreview: false,
  hasLogoutHandler: true,
  attendanceStateKnown: true,
  hasCheckedIn: false,
  hasCheckedOut: false
};

const previewMount = appSrc.slice(
  appSrc.indexOf("selectedMenu === 'Mobile Portal'"),
  appSrc.indexOf("selectedMenu === 'HRD'")
);

check(
  canShowEmployeeMobileLogout({ ...realReady, manualLogoutEnabled: true }) === true,
  'A: toggle ON + not clocked in -> manual logout visible'
);
check(EMPLOYEE_MOBILE_LOGOUT_LABEL === 'Keluar Akun', 'A: label is Keluar Akun');

check(
  canShowEmployeeMobileLogout({ ...realReady, manualLogoutEnabled: false }) === false,
  'B: toggle OFF + not clocked in -> manual logout hidden'
);

check(
  canShowEmployeeMobileLogout({
    ...realReady,
    hasCheckedIn: true,
    hasCheckedOut: false,
    manualLogoutEnabled: true
  }) === false,
  'C: toggle ON + open attendance -> hidden'
);
check(hasOpenAttendanceSession({ has_checked_in: true, has_checked_out: false }) === true, 'C: open session detected');

check(
  canShowEmployeeMobileLogout({
    ...realReady,
    hasCheckedIn: true,
    hasCheckedOut: false,
    manualLogoutEnabled: false
  }) === false,
  'D: toggle OFF + open attendance -> hidden'
);

check(
  canShowEmployeeMobileLogout({
    isPreview: false,
    hasLogoutHandler: true,
    attendanceStateKnown: false,
    hasCheckedIn: false,
    manualLogoutEnabled: true
  }) === false,
  'E: attendance loading/unknown -> hidden'
);
check(resolveManualLogoutEnabled(null) === false, 'E: missing status fails closed');
check(workspaceSrc.includes('attendanceStateKnown: !attendanceLoading && attendanceStatus !== null'), 'E: workspace waits for known status');

check(
  canShowEmployeeMobileLogout({
    isPreview: false,
    hasLogoutHandler: true,
    identityUnlinked: true,
    attendanceStateKnown: false,
    manualLogoutEnabled: false
  }) === true,
  'F: unlinked identity + toggle OFF -> logout still visible'
);

check(
  canShowEmployeeMobileLogout({
    ...realReady,
    isPreview: true,
    manualLogoutEnabled: true
  }) === false,
  'G: preview + toggle ON -> hidden'
);
check(!previewMount.includes('onLogout'), 'G: desktop preview does not wire onLogout');

let logoutCalls = 0;
const onLogout = () => {
  logoutCalls += 1;
};
check(
  shouldLogoutAfterCheckOutResponse({ httpOk: true, status: 'OK', manualLogoutEnabled: false }) === true,
  'H: toggle OFF does not block CHECK_OUT auto logout'
);
logoutAfterSuccessfulCheckOut(onLogout);
check(logoutCalls === 1, 'H: successful CHECK_OUT still calls onLogout once when toggle is OFF');

logoutCalls = 0;
check(
  shouldLogoutAfterCheckOutResponse({ httpOk: true, status: 'OK', manualLogoutEnabled: true }) === true,
  'I: toggle ON + successful CHECK_OUT still auto-logouts'
);
logoutAfterSuccessfulCheckOut(onLogout);
check(logoutCalls === 1, 'I: successful CHECK_OUT calls onLogout once when toggle is ON');
check(workspaceSrc.includes('logoutAfterSuccessfulCheckOut(onLogout)'), 'I: workspace auto-logout ignores the toggle');
check(!clockOutUsesToggle(workspaceSrc), 'I: CHECK_OUT success path does not read the visibility toggle');

logoutCalls = 0;
check(shouldLogoutAfterCheckOutResponse({ httpOk: false, status: 'ERROR', manualLogoutEnabled: true }) === false, 'J: failed CHECK_OUT does not logout');
check(shouldLogoutAfterCheckOutResponse({ httpOk: true, status: 'ERROR' }) === false, 'J: non-OK body does not logout');
check(logoutCalls === 0, 'J: failed CHECK_OUT leaves onLogout at zero');

check(!logoutHelperSrc.includes('/api/attendance/check-out'), 'K: visibility helper does not POST attendance');
check(!logoutHelperSrc.includes('CHECK_OUT'), 'K: visibility helper does not create attendance events');
check(
  !workspaceSrc.includes("applyEmployeeMobileLogoutUiEvent(showLogoutConfirm, 'CONFIRM', handleClockOut)"),
  'K: confirmed Keluar does not Clock Out'
);
check(gateSrc.includes("attendance_type', 'CHECK_IN'"), 'K: attendance gate remains CHECK_IN only');

check(settingsTabSrc.includes('Tampilkan Tombol Keluar Akun di Employee Mobile'), 'R: settings toggle label is exact');
check(
  settingsTabSrc.includes('Jika aktif, crew yang belum Clock In dapat keluar akun secara manual.'),
  'R: settings description is exact'
);
check(settingsTabSrc.includes('employee_mobile_manual_logout_enabled'), 'R: settings field is persisted in PATCH body via settings object');
check(settingsTabSrc.includes("setSaveSuccess(false)"), 'R: save starts without optimistic success');
check(settingsTabSrc.includes("if (res.ok && data.status === 'OK')"), 'R: success is only shown after backend OK');
check(settingsTabSrc.includes('authenticatedFetch(\'/api/attendance/settings\''), 'R: save uses authenticated PATCH');

check(applyEmployeeMobileLogoutUiEvent(false, 'REQUEST', onLogout) === true, 'confirm still opens');
check(applyEmployeeMobileLogoutUiEvent(true, 'CANCEL', onLogout) === false, 'Batal still does not logout');
check(EMPLOYEE_MOBILE_LOGOUT_CONFIRM_TITLE === 'Keluar dari akun ini?', 'confirm title is exact');
check(EMPLOYEE_MOBILE_LOGOUT_CANCEL_LABEL === 'Batal', 'cancel label is Batal');
check(EMPLOYEE_MOBILE_LOGOUT_CONFIRM_ACTION_LABEL === 'Keluar', 'confirm action is Keluar');
check(globalBarSrc.includes('Keluar (Logout)'), 'desktop logout label unchanged');
check(globalBarSrc.includes('if (onLogout) onLogout()'), 'desktop logout still has no confirmation');
check(authContextSrc.includes("localStorage.removeItem(TOKEN_KEY)"), 'AuthContext.logout unchanged');
check(protectedRouteSrc.includes('onLogout={logout}'), 'MOBILE_ONLY still wires canonical logout');
check(protectedRouteSrc.includes('<LoginPage />'), 'unauthenticated gate still renders LoginPage');
check(workspaceSrc.includes('resolveManualLogoutEnabled(attendanceStatus)'), 'workspace uses server-authoritative toggle');
check(resolveManualLogoutEnabled({ manual_logout_enabled: false }) === false, 'status.manual_logout_enabled is trusted');
check(resolveManualLogoutEnabled({ settings: { employee_mobile_manual_logout_enabled: true } }) === true, 'settings fallback works');
check(resolveManualLogoutEnabled({ settings: {} }) === true, 'P: missing loaded setting defaults TRUE');

console.log(`\n${assertions} assertions passed.`);

function clockOutUsesToggle(src: string): boolean {
  const clockOutFn = src.slice(src.indexOf('const handleClockOut'), src.indexOf('if (identityLoading'));
  return clockOutFn.includes('employee_mobile_manual_logout_enabled') || clockOutFn.includes('manualLogoutEnabled');
}
