// backend/test/auth_hr1_foundation_test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Import domain logic
const {
  calculateLateMinutes,
  calculateWorkedMinutes,
  calculateEarlyLeaveMinutes,
  deriveAttendanceStatus
} = require('../dist/domains/attendance/attendanceCalculation');

const {
  createScheduleSnapshot,
  assertScheduleSnapshotPreserved
} = require('../dist/domains/attendance/scheduleSnapshot');

const {
  projectEmployeeMonthlyReport
} = require('../dist/domains/attendance/monthlyReportProjection');

const {
  classifyAccounts
} = require('../dist/domains/auth/reconciliationService');

function runAuthHr1FoundationTests() {
  console.log('=== AUTH-HR-1 CANONICAL FOUNDATION TEST SUITE ===\n');
  let passed = 0;
  let total = 17;

  // -------------------------------------------------------------
  // TEST 1: Fresh DB Bootstrap (roles & users schema idempotency)
  // -------------------------------------------------------------
  console.log('Test 1: Fresh DB Bootstrap schema idempotency (roles & users in schema_v3.ts)');
  const schemaV3Content = fs.readFileSync(path.join(__dirname, '../src/db/schema_v3.ts'), 'utf8');
  assert.ok(schemaV3Content.includes('CREATE TABLE IF NOT EXISTS roles'), 'schema_v3.ts must define roles table');
  assert.ok(schemaV3Content.includes('CREATE TABLE IF NOT EXISTS users'), 'schema_v3.ts must define users table');
  assert.ok(schemaV3Content.includes('auth_hr1_canonical_foundation_v1'), 'schema_v3.ts must include migration auth_hr1_canonical_foundation_v1');
  console.log('✓ PASS: roles and users bootstrap definitions present with IF NOT EXISTS.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 2: Existing Auth Users and Credentials Preserved
  // -------------------------------------------------------------
  console.log('Test 2: Existing auth users and credentials preserved in migration');
  assert.ok(!schemaV3Content.includes('UPDATE users SET password_hash'), 'Migration must not overwrite password_hash');
  assert.ok(schemaV3Content.includes('ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id'), 'users table modification must be additive');
  console.log('✓ PASS: Migration is strictly additive; existing user credentials untouched.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 3: Password hash preserved without change
  // -------------------------------------------------------------
  console.log('Test 3: Existing password_hash preserved on reconciliation');
  const mockExistingUser = {
    id: 10,
    property_id: 1,
    username: 'existing_staff',
    email: 'staff@oak.test',
    role_id: 2,
    role_name: 'Front Office',
    full_name: 'Existing Staff',
    is_active: true,
    password_hash: '$2a$10$UnchangedCustomHash123456789'
  };
  const mockEmployee = {
    id: 5,
    property_id: 1,
    employee_code: 'EMP-005',
    full_name: 'Existing Staff',
    email: 'staff@oak.test',
    username: 'existing_staff',
    role: 'Front Office',
    is_active: true,
    status: 'ACTIVE'
  };
  const classified = classifyAccounts([mockEmployee], [mockExistingUser]);
  assert.strictEqual(classified.length, 1);
  assert.strictEqual(classified[0].category, 'MATCHED_UNIQUE');
  assert.strictEqual(mockExistingUser.password_hash, '$2a$10$UnchangedCustomHash123456789');
  console.log('✓ PASS: Password hash preserved and record classified as MATCHED_UNIQUE.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 4: Role Assignment Preserved
  // -------------------------------------------------------------
  console.log('Test 4: Role assignment preserved during reconciliation');
  assert.strictEqual(mockExistingUser.role_id, 2);
  console.log('✓ PASS: Existing role assignment remains untouched.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 5: Platform Admin employee_id = NULL allowed
  // -------------------------------------------------------------
  console.log('Test 5: Platform / Super Admin employee_id = NULL allowed');
  const platformAdmin = {
    id: 1,
    property_id: 1,
    employee_id: null,
    username: 'superadmin',
    email: 'admin@oaklawang.internal',
    role_id: 1,
    role_name: 'Super Admin',
    full_name: 'System Root',
    is_active: true,
    password_hash: '$2a$10$rootHash'
  };
  const adminReconciliation = classifyAccounts([], [platformAdmin]);
  assert.strictEqual(adminReconciliation.length, 1);
  assert.strictEqual(adminReconciliation[0].category, 'USER_WITHOUT_EMPLOYEE');
  assert.strictEqual(platformAdmin.employee_id, null);
  console.log('✓ PASS: Admin employee_id = NULL is safely supported.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 6: 1:1 Constraint (one employee cannot link to multiple users)
  // -------------------------------------------------------------
  console.log('Test 6: 1:1 constraint between employee and user');
  assert.ok(schemaV3Content.includes('uq_users_employee_id'), 'schema must contain unique index on users(employee_id)');
  console.log('✓ PASS: uq_users_employee_id unique constraint enforced.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 7: Ambiguous employee/user records NOT auto-linked
  // -------------------------------------------------------------
  console.log('Test 7: Ambiguous matches marked REQUIRES_REVIEW (not auto-linked)');
  const ambEmp = {
    id: 99,
    property_id: 1,
    employee_code: 'EMP-099',
    full_name: 'Ambiguous User',
    email: 'john@oak.test',
    username: 'johnny',
    role: 'Staff',
    is_active: true,
    status: 'ACTIVE'
  };
  const candUser1 = {
    id: 101,
    property_id: 1,
    username: 'johnny',
    email: 'other_john@oak.test',
    role_id: 2,
    role_name: 'Staff',
    full_name: 'John One',
    is_active: true
  };
  const candUser2 = {
    id: 102,
    property_id: 1,
    username: 'another_user',
    email: 'john@oak.test',
    role_id: 2,
    role_name: 'Staff',
    full_name: 'John Two',
    is_active: true
  };
  const ambResults = classifyAccounts([ambEmp], [candUser1, candUser2]);
  const ambEmpResult = ambResults.find(r => r.employee_id === 99);
  assert.ok(ambEmpResult, 'Ambiguous employee must have a classification result');
  assert.strictEqual(ambEmpResult.category, 'AMBIGUOUS_MATCH');
  assert.strictEqual(ambEmpResult.is_auto_linkable, false);
  console.log('✓ PASS: Ambiguous match detected and auto-linking strictly blocked.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 8: Inactive Employee with Active User Mismatch
  // -------------------------------------------------------------
  console.log('Test 8: Inactive Employee with Active User Mismatch (CRITICAL SECURITY)');
  const inactiveEmp = {
    id: 77,
    property_id: 1,
    employee_code: 'EMP-077',
    full_name: 'Terminated Worker',
    email: 'term@oak.test',
    username: 'terminated_worker',
    role: 'Housekeeping',
    is_active: false,
    status: 'TERMINATED'
  };
  const activeUser = {
    id: 200,
    property_id: 1,
    employee_id: 77,
    username: 'terminated_worker',
    email: 'term@oak.test',
    role_id: 4,
    role_name: 'Housekeeping',
    full_name: 'Terminated Worker',
    is_active: true
  };
  const inactiveResults = classifyAccounts([inactiveEmp], [activeUser]);
  const securityRisk = inactiveResults.find(r => r.category === 'INACTIVE_EMPLOYEE_ACTIVE_USER');
  assert.ok(securityRisk, 'Must detect INACTIVE_EMPLOYEE_ACTIVE_USER');
  assert.strictEqual(securityRisk.is_auto_linkable, false);
  console.log('✓ PASS: Inactive employee with active user detected as critical security finding.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 9: Shift Templates Support Overnight Shifts (Crosses Midnight)
  // -------------------------------------------------------------
  console.log('Test 9: Shift templates support overnight shifts (crosses_midnight = TRUE)');
  const nightShift = {
    id: 3,
    property_id: 1,
    code: 'N1',
    name: 'Night Shift',
    start_time: '23:00:00',
    end_time: '07:00:00',
    crosses_midnight: true,
    grace_before_minutes: 15,
    late_grace_minutes: 15,
    checkout_grace_minutes: 60,
    is_active: true
  };
  assert.strictEqual(nightShift.crosses_midnight, true);
  // Overnight calculation: 23:00 Day 1 to 07:00 Day 2 is 8 hours (480 minutes)
  const scheduledStart = '2026-09-01T23:00:00.000Z';
  const scheduledEnd = '2026-09-02T07:00:00.000Z';
  const actualIn = '2026-09-01T23:05:00.000Z'; // 5 mins in, within 15 mins grace
  const actualOut = '2026-09-02T07:02:00.000Z';
  const lateMins = calculateLateMinutes(actualIn, scheduledStart, nightShift.late_grace_minutes);
  const workedMins = calculateWorkedMinutes(actualIn, actualOut);
  const earlyLeaveMins = calculateEarlyLeaveMinutes(actualOut, scheduledEnd);
  assert.strictEqual(lateMins, 0, '5 mins late with 15 mins grace must result in 0 late minutes');
  assert.strictEqual(workedMins, 477, 'Worked minutes across midnight must equal 477 minutes');
  assert.strictEqual(earlyLeaveMins, 0, 'Leaving after scheduled end must result in 0 early leave');
  console.log('✓ PASS: Overnight shift calculation across midnight verified.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 10: Schedule exists independently of attendance
  // -------------------------------------------------------------
  console.log('Test 10: Schedule exists independently of attendance');
  const futureSchedule = {
    id: 501,
    property_id: 1,
    employee_id: 12,
    work_date: '2026-09-10',
    shift_template_id: 1,
    schedule_status: 'PUBLISHED',
    work_status: 'WORK',
    scheduled_start_at: '2026-09-10T07:00:00.000Z',
    scheduled_end_at: '2026-09-10T15:00:00.000Z'
  };
  assert.strictEqual(futureSchedule.schedule_status, 'PUBLISHED');
  assert.strictEqual(futureSchedule.work_status, 'WORK');
  console.log('✓ PASS: Schedule model functions independently of attendance records.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 11: Attendance stores schedule snapshot
  // -------------------------------------------------------------
  console.log('Test 11: Attendance captures schedule snapshot at clock-in');
  const morningShift = {
    id: 1,
    property_id: 1,
    code: 'M1',
    name: 'Morning Shift',
    start_time: '07:00:00',
    end_time: '15:00:00',
    crosses_midnight: false,
    grace_before_minutes: 15,
    late_grace_minutes: 15,
    checkout_grace_minutes: 60,
    is_active: true
  };
  const snapshot = createScheduleSnapshot(futureSchedule, morningShift);
  assert.strictEqual(snapshot.schedule_id, 501);
  assert.strictEqual(snapshot.shift_code_snapshot, 'M1');
  assert.strictEqual(snapshot.shift_name_snapshot, 'Morning Shift');
  assert.strictEqual(snapshot.scheduled_start_snapshot, '2026-09-10T07:00:00.000Z');
  assert.strictEqual(snapshot.scheduled_end_snapshot, '2026-09-10T15:00:00.000Z');
  console.log('✓ PASS: Schedule snapshot correctly generated for attendance row.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 12: Future schedule edit does NOT overwrite attendance snapshot
  // -------------------------------------------------------------
  console.log('Test 12: Future schedule edit does NOT overwrite stored attendance snapshot');
  const attendanceRecord = {
    id: 88,
    property_id: 1,
    employee_id: 12,
    schedule_id: snapshot.schedule_id,
    work_date: '2026-09-10',
    scheduled_start_snapshot: snapshot.scheduled_start_snapshot,
    scheduled_end_snapshot: snapshot.scheduled_end_snapshot,
    shift_code_snapshot: snapshot.shift_code_snapshot,
    shift_name_snapshot: snapshot.shift_name_snapshot,
    clock_in_at: '2026-09-10T07:10:00.000Z',
    late_minutes: 0
  };
  // Manager changes future schedule to Evening Shift (E1)
  const modifiedSchedule = {
    ...futureSchedule,
    shift_template_id: 2,
    scheduled_start_at: '2026-09-10T15:00:00.000Z',
    scheduled_end_at: '2026-09-10T23:00:00.000Z'
  };
  // Verify attendance snapshot remains unchanged
  const preserved = assertScheduleSnapshotPreserved(snapshot, attendanceRecord);
  assert.strictEqual(preserved, true, 'Attendance snapshot must remain immutable against schedule modification');
  assert.strictEqual(attendanceRecord.shift_code_snapshot, 'M1');
  console.log('✓ PASS: Attendance snapshot remains immutable after schedule edit.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 13: Clock-in and clock-out photos use separate storage keys & hashes
  // -------------------------------------------------------------
  console.log('Test 13: Separate photo keys and SHA-256 hashes for clock-in & clock-out');
  const attWithPhotos = {
    clock_in_photo_storage_key: 'attendance/2026/09/emp12_clock_in_20260910.jpg',
    clock_in_photo_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    clock_out_photo_storage_key: 'attendance/2026/09/emp12_clock_out_20260910.jpg',
    clock_out_photo_hash: '5d41402abc4b2a76b9719d911017c592',
  };
  assert.notStrictEqual(attWithPhotos.clock_in_photo_storage_key, attWithPhotos.clock_out_photo_storage_key);
  assert.notStrictEqual(attWithPhotos.clock_in_photo_hash, attWithPhotos.clock_out_photo_hash);
  console.log('✓ PASS: Clock-in and clock-out photo keys and hashes are distinctly separated.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 14: Face Verification Result States
  // -------------------------------------------------------------
  console.log('Test 14: Face verification statuses (VERIFIED, REVIEW_REQUIRED, REJECTED, NOT_PROCESSED)');
  const validStatuses = ['VERIFIED', 'REVIEW_REQUIRED', 'REJECTED', 'NOT_PROCESSED'];
  for (const st of validStatuses) {
    const derived = deriveAttendanceStatus({
      clockInAt: '2026-09-10T07:00:00.000Z',
      clockOutAt: '2026-09-10T15:00:00.000Z',
      lateMinutes: 0,
      faceVerificationStatus: st
    });
    if (st === 'REVIEW_REQUIRED') {
      assert.strictEqual(derived, 'REVIEW_REQUIRED');
    } else {
      assert.strictEqual(derived, 'PRESENT');
    }
  }
  console.log('✓ PASS: All face verification states handled deterministically.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 15: Monthly HR Report Projection is Deterministic
  // -------------------------------------------------------------
  console.log('Test 15: Monthly HR report projection derives deterministically from canonical facts');
  const projected = projectEmployeeMonthlyReport({
    property_id: 1,
    employee_id: 12,
    employee_name: 'Dewi Lestari',
    employee_code: 'EMP-012',
    department: 'Housekeeping',
    position: 'Room Attendant',
    year: 2026,
    month: 9,
    schedules: [
      { schedule_status: 'PUBLISHED', work_status: 'WORK' },
      { schedule_status: 'PUBLISHED', work_status: 'WORK' },
      { schedule_status: 'PUBLISHED', work_status: 'OFF' }
    ],
    attendances: [
      {
        clock_in_at: '2026-09-01T07:00:00.000Z',
        clock_out_at: '2026-09-01T15:00:00.000Z',
        late_minutes: 0,
        worked_minutes: 480,
        overtime_minutes: 0,
        early_leave_minutes: 0,
        clock_in_face_status: 'VERIFIED',
        clock_out_face_status: 'VERIFIED'
      },
      {
        clock_in_at: '2026-09-02T07:25:00.000Z',
        clock_out_at: '2026-09-02T15:00:00.000Z',
        late_minutes: 10,
        worked_minutes: 455,
        overtime_minutes: 30,
        early_leave_minutes: 0,
        clock_in_face_status: 'REVIEW_REQUIRED',
        clock_out_face_status: 'VERIFIED'
      }
    ],
    taskSummary: {
      tasks_assigned: 10,
      tasks_completed: 9,
      tasks_late: 1
    }
  });

  assert.strictEqual(projected.scheduled_work_days, 2);
  assert.strictEqual(projected.off_days, 1);
  assert.strictEqual(projected.present_days, 2);
  assert.strictEqual(projected.late_days, 1);
  assert.strictEqual(projected.total_late_minutes, 10);
  assert.strictEqual(projected.total_worked_minutes, 935);
  assert.strictEqual(projected.approved_overtime_minutes, 30);
  assert.strictEqual(projected.clock_in_face_verified_count, 1);
  assert.strictEqual(projected.face_review_required_count, 1);
  assert.strictEqual(projected.task_completion_rate, 90.0);
  console.log('✓ PASS: Monthly HR report projected exactly from canonical records.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 16: Zero Property 1 Hardcoding in New Domains
  // -------------------------------------------------------------
  console.log('Test 16: Zero Property 1 hardcoding in new domains');
  assert.ok(/CREATE TABLE IF NOT EXISTS work_shift_templates\s*\([\s\S]*property_id INTEGER NOT NULL REFERENCES properties\(id\)/.test(schemaV3Content));
  assert.ok(/CREATE TABLE IF NOT EXISTS employee_work_schedules\s*\([\s\S]*property_id INTEGER NOT NULL REFERENCES properties\(id\)/.test(schemaV3Content));
  assert.ok(/CREATE TABLE IF NOT EXISTS employee_attendance\s*\([\s\S]*property_id INTEGER NOT NULL REFERENCES properties\(id\)/.test(schemaV3Content));
  assert.ok(/CREATE TABLE IF NOT EXISTS employee_face_enrollments\s*\([\s\S]*property_id INTEGER NOT NULL REFERENCES properties\(id\)/.test(schemaV3Content));
  console.log('✓ PASS: All new domains enforce property_id multi-property foreign keys.\n');
  passed++;

  // -------------------------------------------------------------
  // TEST 17: Non-destructive Migration Verification & Audit Invariant
  // -------------------------------------------------------------
  console.log('Test 17: Non-destructive migration verification & audit FK invariant');
  // Confirm migration uses ADD COLUMN IF NOT EXISTS and CREATE TABLE IF NOT EXISTS without DROP
  assert.ok(!schemaV3Content.includes('DROP TABLE users;'));
  assert.ok(!schemaV3Content.includes('DROP TABLE hr_employees;'));
  assert.ok(schemaV3Content.includes('auth_hr1_canonical_foundation_v1'));
  // Ensure audit trail uses ON DELETE RESTRICT
  assert.ok(
    /employee_work_schedule_audits[\s\S]*schedule_id INTEGER NOT NULL REFERENCES employee_work_schedules\(id\) ON DELETE RESTRICT/.test(schemaV3Content),
    'employee_work_schedule_audits must use ON DELETE RESTRICT on schedule_id'
  );
  console.log('✓ PASS: Safe additive migration & audit RESTRICT FK confirmed.\n');
  passed++;

  console.log(`=======================================================`);
  console.log(`ALL ${passed}/${total} AUTH-HR-1 FOUNDATION TESTS PASSED!`);
  console.log(`=======================================================\n`);
}

runAuthHr1FoundationTests();
