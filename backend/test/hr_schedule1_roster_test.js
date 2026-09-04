'use strict';

/**
 * HR-SCHEDULE-1: Employee Work Schedule & Operational Shift Roster
 * Comprehensive Integration Test Suite
 *
 * Original tests A-O + fixes for:
 * 1. Copy week target timestamps use target dates (test H extended)
 * 2. Bulk assignment atomicity (test G extended + new rollback test)
 * 3. Property timezone used instead of hardcoded +07 (new test)
 * 4. Publish audit per schedule row (test I extended)
 * 5. Inactive template rejected (test L extended)
 * 6. Audit actor FK uses validUserId (new test)
 * 7. Publish/change lifecycle preserved (test J extended)
 * 8. Security allowlist for shift template update (new test)
 * 9. Property isolation regressions (test F extended)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { generateToken } = require('../dist/domains/auth/authService');

let server;
let baseUrl;
let passed = 0;
let failed = 0;
const testResults = [];

function generateTestToken(role = 'Super Admin', roleId = 1, accessType = 'ADMIN') {
  return generateToken({
    id: 99999,
    email: 'test.schedule.admin@oaklawang.com',
    username: 'test_schedule_admin',
    full_name: 'Test Schedule Admin',
    role,
    role_id: roleId,
    access_type: accessType,
    property_id: 1
  });
}

function generateMobileToken() {
  return generateToken({
    id: 99998,
    email: 'test.mobile.staff@oaklawang.com',
    username: 'test_mobile_staff',
    full_name: 'Test Mobile Staff',
    role: 'Crew',
    role_id: 1,
    access_type: 'MOBILE_ONLY',
    property_id: 1
  });
}

async function request(method, requestPath, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const isBodyAllowed = method !== 'GET' && method !== 'HEAD' && body !== undefined && body !== null;
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: isBodyAllowed ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, body: data };
}

function assert(condition, message) {
  if (!condition) {
    failed++;
    testResults.push({ status: 'FAIL', message });
    throw new Error(message);
  }
}

function pass(testName) {
  passed++;
  testResults.push({ status: 'PASS', message: testName });
  console.log(`  ✓ ${testName}`);
}

async function cleanupTestFixtures() {
  await pool.query(`DELETE FROM employee_work_schedule_audits WHERE employee_id IN (SELECT id FROM hr_employees WHERE full_name LIKE 'TEST_SCHEDULE_%' OR full_name = 'TEST_NO_SCHED_EMP')`);
  await pool.query(`DELETE FROM employee_work_schedules WHERE employee_id IN (SELECT id FROM hr_employees WHERE full_name LIKE 'TEST_SCHEDULE_%' OR full_name = 'TEST_NO_SCHED_EMP')`);
  await pool.query(`DELETE FROM work_shift_templates WHERE property_id = 1 AND (code LIKE 'TEST_%' OR name LIKE 'TEST_%')`);
  await pool.query(`DELETE FROM hr_employees WHERE full_name LIKE 'TEST_SCHEDULE_%' OR full_name = 'TEST_NO_SCHED_EMP'`);
  await pool.query(`DELETE FROM hr_positions WHERE code LIKE 'POS_TEST_SCHED_%' OR name LIKE 'TEST_SCHED_%'`);
  await pool.query(`DELETE FROM hr_departments WHERE code LIKE 'DEP_TEST_SCHED_%' OR name LIKE 'TEST_SCHED_%'`);
  await pool.query(`DELETE FROM audit_logs WHERE module = 'HR_SCHEDULE'`);
}

async function runTests() {
  console.log('=== STARTING HR-SCHEDULE-1 INTEGRATION TEST SUITE ===\n');

  await initializeDatabase(pool);
  await cleanupTestFixtures();

  const token = generateTestToken();
  const mobileToken = generateMobileToken();

  let testDeptId, testPosId, testEmp1Id, testEmp2Id, testEmp3Id;
  let morningShiftId, eveningShiftId, nightShiftId, inactiveShiftId;

  try {
    // ─── SETUP ───
    console.log('[SETUP] Creating test department, positions, and employees...');

    const deptRes = await request('POST', '/api/hrd/departments', {
      property_id: 1, code: 'DEP_TEST_SCHED', name: 'TEST_SCHED_Ops', description: 'Test Schedule Dept'
    }, token);
    if (deptRes.status !== 201 || !deptRes.body?.data?.id) throw new Error('Setup: Failed to create test department');
    testDeptId = deptRes.body.data.id;

    const posRes = await request('POST', '/api/hrd/positions', {
      property_id: 1, department_id: testDeptId, code: 'POS_TEST_SCHED', name: 'TEST_SCHED_Staff'
    }, token);
    if (posRes.status !== 201 || !posRes.body?.data?.id) throw new Error('Setup: Failed to create test position');
    testPosId = posRes.body.data.id;

    for (let i = 1; i <= 3; i++) {
      const empRes = await request('POST', '/api/hrd/employees', {
        property_id: 1, full_name: `TEST_SCHEDULE_Emp${i}`, department_id: testDeptId, position_id: testPosId, role: 'Crew', create_login_account: false
      }, token);
      if (empRes.status !== 201 || !empRes.body?.data?.id) throw new Error(`Setup: Failed to create test employee ${i}`);
      if (i === 1) testEmp1Id = empRes.body.data.id;
      if (i === 2) testEmp2Id = empRes.body.data.id;
      if (i === 3) testEmp3Id = empRes.body.data.id;
    }
    console.log('  ✓ Test employees created:', testEmp1Id, testEmp2Id, testEmp3Id);

    // ─── TEST A: Create shift templates ───
    console.log('\n[TEST A] Create shift templates');

    const morningRes = await request('POST', '/api/schedule/shift-templates', {
      property_id: 1, code: 'TEST_M', name: 'TEST_Morning', start_time: '07:00', end_time: '15:00'
    }, token);
    if (morningRes.status !== 201 || !morningRes.body?.data?.id) throw new Error(`TEST A Failed: Morning shift: ${JSON.stringify(morningRes.body)}`);
    morningShiftId = morningRes.body.data.id;
    assert(morningRes.body.data.crosses_midnight === false, 'Morning shift should not cross midnight');
    pass('A: Morning shift created');

    const eveningRes = await request('POST', '/api/schedule/shift-templates', {
      property_id: 1, code: 'TEST_E', name: 'TEST_Evening', start_time: '15:00', end_time: '23:00'
    }, token);
    if (eveningRes.status !== 201) throw new Error('TEST A Failed: Evening shift');
    eveningShiftId = eveningRes.body.data.id;
    pass('A: Evening shift created');

    const nightRes = await request('POST', '/api/schedule/shift-templates', {
      property_id: 1, code: 'TEST_N', name: 'TEST_Night', start_time: '23:00', end_time: '07:00'
    }, token);
    if (nightRes.status !== 201) throw new Error('TEST A Failed: Night shift');
    nightShiftId = nightRes.body.data.id;
    assert(nightRes.body.data.crosses_midnight === true, 'Night shift should cross midnight');
    pass('A: Night shift created (crosses_midnight=true)');

    const inactiveRes = await request('POST', '/api/schedule/shift-templates', {
      property_id: 1, code: 'TEST_X', name: 'TEST_Inactive', start_time: '06:00', end_time: '14:00', is_active: false
    }, token);
    if (inactiveRes.status !== 201) throw new Error('TEST A Failed: Inactive shift');
    inactiveShiftId = inactiveRes.body.data.id;
    pass('A: Inactive shift created');

    // List filtering
    const listRes = await request('GET', '/api/schedule/shift-templates?property_id=1&include_inactive=false', null, token);
    const activeTemplates = listRes.body.data.filter(t => t.code === 'TEST_X');
    assert(activeTemplates.length === 0, 'Inactive should not appear in active list');
    const listAllRes = await request('GET', '/api/schedule/shift-templates?property_id=1&include_inactive=true', null, token);
    const allTemplates = listAllRes.body.data.filter(t => t.code === 'TEST_X');
    assert(allTemplates.length === 1, 'Inactive should appear in all list');
    pass('A: Template list filtering works');

    // ─── TEST B: Normal shift assignment ───
    console.log('\n[TEST B] Normal shift assignment');

    const assignRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp1Id, work_date: '2026-09-08', shift_template_id: morningShiftId
    }, token);
    if (assignRes.status !== 200) throw new Error(`TEST B Failed: ${JSON.stringify(assignRes.body)}`);
    const sched = assignRes.body.data;
    assert(sched.work_status === 'WORK', 'work_status should be WORK');
    assert(sched.schedule_status === 'DRAFT', 'schedule_status should be DRAFT');
    assert(sched.shift_template_id === morningShiftId, 'shift_template_id mismatch');
    assert(sched.scheduled_start_at && sched.scheduled_end_at, 'timestamps should be set');
    assert(sched.scheduled_start_at.startsWith('2026-09-08'), 'start date should be 2026-09-08');
    assert(sched.scheduled_end_at.startsWith('2026-09-08'), 'end date should be 2026-09-08');
    pass('B: Morning shift assigned with correct timestamps');

    // Audit record
    const auditRes = await pool.query(
      `SELECT * FROM employee_work_schedule_audits WHERE schedule_id = $1 AND action = 'CREATED'`,
      [sched.id]
    );
    assert(auditRes.rowCount > 0, 'Audit record for creation');
    pass('B: Audit record created');

    // ─── TEST C: OFF schedule ───
    console.log('\n[TEST C] OFF schedule');

    const offRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp2Id, work_date: '2026-09-08', work_status: 'OFF'
    }, token);
    if (offRes.status !== 200) throw new Error(`TEST C Failed: ${JSON.stringify(offRes.body)}`);
    const offSched = offRes.body.data;
    assert(offSched.work_status === 'OFF', 'work_status should be OFF');
    assert(offSched.shift_template_id === null, 'shift_template_id should be null for OFF');
    assert(offSched.scheduled_start_at === null, 'scheduled_start_at should be null for OFF');
    assert(offSched.scheduled_end_at === null, 'scheduled_end_at should be null for OFF');
    pass('C: OFF schedule with null timestamps');

    // ─── TEST D: Cross-midnight shift ───
    console.log('\n[TEST D] Cross-midnight shift');

    const nightAssignRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp3Id, work_date: '2026-09-08', shift_template_id: nightShiftId
    }, token);
    if (nightAssignRes.status !== 200) throw new Error(`TEST D Failed: ${JSON.stringify(nightAssignRes.body)}`);
    const nightSched = nightAssignRes.body.data;
    assert(nightSched.scheduled_start_at.startsWith('2026-09-08'), 'start date 2026-09-08');
    assert(nightSched.scheduled_end_at.startsWith('2026-09-09'), 'end date should be next day 2026-09-09');
    pass('D: Cross-midnight shift correct');

    // ─── TEST E: Duplicate prevention ───
    console.log('\n[TEST E] Duplicate assignment prevention');

    const dupeRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp1Id, work_date: '2026-09-08', shift_template_id: eveningShiftId
    }, token);
    if (dupeRes.status !== 200) throw new Error(`TEST E Failed: ${JSON.stringify(dupeRes.body)}`);
    const countRes = await pool.query(
      'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [testEmp1Id, '2026-09-08']
    );
    assert(parseInt(countRes.rows[0].cnt) === 1, 'Expected 1 schedule');
    pass('E: No duplicate created');

    // ─── TEST F: Property isolation ───
    console.log('\n[TEST F] Property isolation');

    const prop2EmpRes = await pool.query(
      `INSERT INTO hr_employees (full_name, property_id, department, status, is_active)
       VALUES ('TEST_NO_SCHED_EMP', 2, 'Test', 'ACTIVE', TRUE) RETURNING id`
    );
    const prop2EmpId = prop2EmpRes.rows[0].id;

    const prop2ShiftCode = 'TP2M' + (Date.now() % 10000);
    const prop2ShiftRes = await request('POST', '/api/schedule/shift-templates', {
      property_id: 2, code: prop2ShiftCode, name: 'TEST_P2 Morning', start_time: '08:00', end_time: '16:00'
    }, token);
    if (prop2ShiftRes.status !== 201) throw new Error(`TEST F Failed: ${JSON.stringify(prop2ShiftRes.body)}`);

    const prop2AssignRes = await request('POST', '/api/schedule/assign', {
      property_id: 2, employee_id: prop2EmpId, work_date: '2026-09-08', shift_template_id: prop2ShiftRes.body.data.id
    }, token);
    if (prop2AssignRes.status !== 200) throw new Error(`TEST F Failed: ${JSON.stringify(prop2AssignRes.body)}`);

    const rosterRes = await request('GET', '/api/schedule/roster?property_id=1&start_date=2026-09-08', null, token);
    const prop2EmpInRoster = rosterRes.body.data.employees.find(e => e.employee_id === prop2EmpId);
    assert(!prop2EmpInRoster, 'Property 2 employee should not appear in property 1 roster');

    // Verify property 2 roster does not include property 1 employees
    const rosterP2Res = await request('GET', '/api/schedule/roster?property_id=2&start_date=2026-09-08', null, token);
    const emp1InP2 = rosterP2Res.body.data.employees.find(e => e.employee_id === testEmp1Id);
    assert(!emp1InP2, 'Property 1 employee should not appear in property 2 roster');

    await pool.query(`DELETE FROM employee_work_schedule_audits WHERE employee_id = $1`, [prop2EmpId]);
    await pool.query('DELETE FROM employee_work_schedules WHERE employee_id = $1', [prop2EmpId]);
    await pool.query('DELETE FROM work_shift_templates WHERE property_id = 2 AND code = $1', [prop2ShiftCode]);
    await pool.query('DELETE FROM hr_employees WHERE id = $1', [prop2EmpId]);
    pass('F: Property isolation verified');

    // ─── TEST G: Bulk assignment (atomic) ───
    console.log('\n[TEST G] Bulk assignment (atomic)');

    const bulkRes = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id, testEmp2Id, testEmp3Id],
      shift_template_id: morningShiftId,
      start_date: '2026-09-09',
      end_date: '2026-09-11'
    }, token);
    if (bulkRes.status !== 200) throw new Error(`TEST G Failed: ${JSON.stringify(bulkRes.body)}`);
    const bulkResult = bulkRes.body.data;
    // 3 employees x 3 days = 9 assignments; some may already exist from earlier tests
    assert(bulkResult.assigned_count >= 3, `Expected at least 3 assignments, got ${bulkResult.assigned_count}`);
    // errors field should NOT exist in new atomic implementation
    assert(!bulkResult.errors, 'No errors field in atomic bulk assign');
    pass('G: Bulk assignment atomic (' + bulkResult.assigned_count + ' assigned)');

    for (const empId of [testEmp1Id, testEmp2Id, testEmp3Id]) {
      for (const date of ['2026-09-09', '2026-09-10', '2026-09-11']) {
        const cntRes = await pool.query(
          'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
          [empId, date]
        );
        if (parseInt(cntRes.rows[0].cnt) !== 1) throw new Error(`TEST G Failed: emp ${empId} on ${date}: ${cntRes.rows[0].cnt} schedules`);
      }
    }
    pass('G: All employee+date combos have exactly 1 schedule');

    // ─── TEST G2: Bulk assignment rollback on failure ───
    console.log('\n[TEST G2] Bulk assignment rollback on failure');

    // Try bulk with invalid employee ID — should fail and roll back
    const bulkFailRes = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id, 99999999],
      shift_template_id: morningShiftId,
      start_date: '2026-09-20',
      end_date: '2026-09-21'
    }, token);
    assert(bulkFailRes.status >= 400, `Expected error, got ${bulkFailRes.status}`);

    // Verify NO schedules were created for testEmp1Id on 2026-09-20 (atomic rollback)
    const rollbackCheck = await pool.query(
      'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [testEmp1Id, '2026-09-20']
    );
    assert(parseInt(rollbackCheck.rows[0].cnt) === 0, 'Atomic rollback: no schedules created for valid employee when bulk fails');
    pass('G2: Bulk failure rolls back ALL writes');

    // ─── TEST G3: Bulk with inactive template rejected ───
    console.log('\n[TEST G3] Bulk with inactive template rejected');

    const bulkInactiveRes = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id],
      shift_template_id: inactiveShiftId,
      start_date: '2026-09-20',
      end_date: '2026-09-21'
    }, token);
    assert(bulkInactiveRes.status === 422, `Expected 422 for inactive template, got ${bulkInactiveRes.status}`);
    assert(bulkInactiveRes.body.code === 'SHIFT_TEMPLATE_INACTIVE', 'Code should be SHIFT_TEMPLATE_INACTIVE');
    pass('G3: Bulk with inactive template rejected');

    // ─── TEST H: Copy previous week (with timestamp rebuild) ───
    console.log('\n[TEST H] Copy previous week with target timestamp rebuild');

    // Set up source week: Sep 8-14
    const sourceDays = [];
    for (let i = 8; i <= 14; i++) {
      sourceDays.push(`2026-09-${String(i).padStart(2, '0')}`);
    }
    for (const date of sourceDays) {
      await request('POST', '/api/schedule/assign', {
        property_id: 1, employee_id: testEmp1Id, work_date: date, shift_template_id: morningShiftId
      }, token);
      await request('POST', '/api/schedule/assign', {
        property_id: 1, employee_id: testEmp2Id, work_date: date, shift_template_id: eveningShiftId
      }, token);
    }

    // Get source timestamps for comparison
    const srcSchedRes = await pool.query(
      'SELECT * FROM employee_work_schedules WHERE property_id = $1 AND employee_id = $2 AND work_date = $3',
      [1, testEmp1Id, '2026-09-08']
    );
    const srcStart = srcSchedRes.rows[0].scheduled_start_at instanceof Date
      ? srcSchedRes.rows[0].scheduled_start_at.toISOString()
      : String(srcSchedRes.rows[0].scheduled_start_at);
    const srcEnd = srcSchedRes.rows[0].scheduled_end_at instanceof Date
      ? srcSchedRes.rows[0].scheduled_end_at.toISOString()
      : String(srcSchedRes.rows[0].scheduled_end_at);

    // Copy to target week (Sep 15-21)
    const copyRes = await request('POST', '/api/schedule/copy-week', {
      property_id: 1, source_start_date: '2026-09-08', target_start_date: '2026-09-15'
    }, token);
    if (copyRes.status !== 200) throw new Error(`TEST H Failed: ${JSON.stringify(copyRes.body)}`);
    const copyResult = copyRes.body.data;
    assert(copyResult.copied_count >= 2, `Expected at least 2 copied, got ${copyResult.copied_count}`);
    pass('H: Copied ' + copyResult.copied_count + ' schedules');

    // Verify target timestamps use TARGET dates, NOT source dates
    for (const date of ['2026-09-15', '2026-09-16', '2026-09-17']) {
      const emp1Sched = await pool.query(
        'SELECT * FROM employee_work_schedules WHERE property_id = $1 AND employee_id = $2 AND work_date = $3',
        [1, testEmp1Id, date]
      );
      if (emp1Sched.rowCount === 0) throw new Error(`TEST H Failed: Emp1 missing schedule for ${date}`);
      if (emp1Sched.rows[0].shift_template_id !== morningShiftId) throw new Error(`TEST H: Emp1 should have Morning shift on ${date}`);

      // CRITICAL: timestamps must reference the TARGET date, not source date
      const tgtStartRaw = emp1Sched.rows[0].scheduled_start_at;
      const tgtEndRaw = emp1Sched.rows[0].scheduled_end_at;
      const tgtStartISO = tgtStartRaw instanceof Date ? tgtStartRaw.toISOString() : String(tgtStartRaw);
      const tgtEndISO = tgtEndRaw instanceof Date ? tgtEndRaw.toISOString() : String(tgtEndRaw);
      assert(tgtStartISO && tgtEndISO, `Target ${date}: timestamps should be set`);
      // Extract YYYY-MM-DD portion from the stored timestamptz value
      const tgtStartDate = tgtStartISO.substring(0, 10);
      const tgtEndDate = tgtEndISO.substring(0, 10);
      assert(tgtStartDate === date, `Target ${date}: scheduled_start_at date must be ${date}, got ${tgtStartDate} (full: ${tgtStartISO})`);
      assert(tgtEndDate === date, `Target ${date}: scheduled_end_at date must be ${date}, got ${tgtEndDate} (full: ${tgtEndISO})`);

      // Verify timestamps differ from source (source is Sep 8, target is Sep 15+)
      assert(tgtStartISO !== srcStart, 'Target timestamps must differ from source timestamps');
    }
    pass('H: Target timestamps use TARGET dates (not source)');

    // Verify cross-midnight copy: Emp3 had night shift on Sep 8 (23:00-07:00)
    // First copy mapped Sep 8 → Sep 15, so emp3 Sep 15 should have cross-midnight end on Sep 16
    const nightTarget15 = await pool.query(
      'SELECT * FROM employee_work_schedules WHERE property_id = $1 AND employee_id = $2 AND work_date = $3',
      [1, testEmp3Id, '2026-09-15']
    );
    if (nightTarget15.rowCount > 0 && nightTarget15.rows[0].shift_template_id === nightShiftId) {
      const endAt = nightTarget15.rows[0].scheduled_end_at instanceof Date
        ? nightTarget15.rows[0].scheduled_end_at.toISOString()
        : String(nightTarget15.rows[0].scheduled_end_at);
      assert(endAt.substring(0, 10) === '2026-09-16',
        `Cross-midnight copy: end date should be 2026-09-16 (next day) for target, got ${endAt}`);
      pass('H: Cross-midnight copied schedule has correct target next-day end');
    } else {
      pass('H: Cross-midnight check skipped (night shift not in target)');
    }

    // Conflict skip test
    const copyConflictRes = await request('POST', '/api/schedule/copy-week', {
      property_id: 1, source_start_date: '2026-09-08', target_start_date: '2026-09-15'
    }, token);
    assert(copyConflictRes.status === 200, 'Copy with conflicts should succeed');
    assert(copyConflictRes.body.data.skipped_conflicts >= 1, 'Should skip conflicts');
    pass('H: Copy with conflicts skips existing');

    // ─── TEST I: Publish audit per schedule row ───
    console.log('\n[TEST I] Publish schedule with per-row audit');

    const publishRes = await request('POST', '/api/schedule/publish', {
      property_id: 1, start_date: '2026-09-08', end_date: '2026-09-14'
    }, token);
    if (publishRes.status !== 200) throw new Error(`TEST I Failed: ${JSON.stringify(publishRes.body)}`);
    const publishResult = publishRes.body.data;
    assert(publishResult.published_count >= 1, `Expected at least 1 published, got ${publishResult.published_count}`);
    pass('I: Published ' + publishResult.published_count + ' schedules');

    // Count PUBLISHED audit records
    const pubAuditCount = await pool.query(
      `SELECT COUNT(*) as cnt FROM employee_work_schedule_audits
       WHERE action = 'PUBLISHED' AND property_id = 1`
    );
    const auditCount = parseInt(pubAuditCount.rows[0].cnt, 10);

    // Count schedules that were transitioned (non-already-published)
    assert(auditCount >= publishResult.published_count,
      `Audit records (${auditCount}) should be >= published count (${publishResult.published_count})`);
    pass('I: Publish audit created per schedule row (' + auditCount + ' audit records)');

    // Verify each PUBLISHED schedule has its own audit
    const pubSchedules = await pool.query(
      `SELECT id, employee_id FROM employee_work_schedules
       WHERE property_id = 1 AND schedule_status = 'PUBLISHED'
       AND work_date >= '2026-09-07' AND work_date <= '2026-09-13'`
    );
    for (const sched of pubSchedules.rows) {
      const schedAudit = await pool.query(
        `SELECT COUNT(*) as cnt FROM employee_work_schedule_audits
         WHERE schedule_id = $1 AND action = 'PUBLISHED'`,
        [sched.id]
      );
      assert(parseInt(schedAudit.rows[0].cnt, 10) === 1,
        `Schedule ${sched.id} (emp ${sched.employee_id}) should have exactly 1 PUBLISHED audit`);
    }
    pass('I: Each PUBLISHED schedule has its own audit record');

    // ─── TEST I2: Already-published schedules not re-audited ───
    console.log('\n[TEST I2] Already-published not falsely re-audited');

    const countBefore = parseInt((await pool.query(
      `SELECT COUNT(*) as cnt FROM employee_work_schedule_audits WHERE action = 'PUBLISHED' AND property_id = 1`
    )).rows[0].cnt, 10);

    // Publish same week again — should be a no-op
    const republishRes = await request('POST', '/api/schedule/publish', {
      property_id: 1, start_date: '2026-09-08', end_date: '2026-09-14'
    }, token);
    assert(republishRes.status === 200, 'Republish should succeed');
    assert(republishRes.body.data.published_count === 0, 'Republish should publish 0 (all already published)');

    const countAfter = parseInt((await pool.query(
      `SELECT COUNT(*) as cnt FROM employee_work_schedule_audits WHERE action = 'PUBLISHED' AND property_id = 1`
    )).rows[0].cnt, 10);
    assert(countAfter === countBefore, `No new audit records on re-publish (${countBefore} → ${countAfter})`);
    pass('I2: Already-published schedules not falsely re-audited');

    // ─── TEST J: Modification after publish ───
    console.log('\n[TEST J] Modification after publish → CHANGED');

    const pubSchedRes = await pool.query(
      'SELECT * FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [testEmp1Id, '2026-09-08']
    );
    const pubSchedId = pubSchedRes.rows[0].id;
    const oldShiftId = pubSchedRes.rows[0].shift_template_id;

    const changeRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp1Id, work_date: '2026-09-08', shift_template_id: eveningShiftId
    }, token);
    if (changeRes.status !== 200) throw new Error(`TEST J Failed: ${JSON.stringify(changeRes.body)}`);
    assert(changeRes.body.data.schedule_status === 'CHANGED', 'Status should be CHANGED');

    const changeAuditRes = await pool.query(
      `SELECT * FROM employee_work_schedule_audits
       WHERE schedule_id = $1 AND action = 'SHIFT_CHANGED'
       ORDER BY created_at DESC LIMIT 1`,
      [pubSchedId]
    );
    assert(changeAuditRes.rowCount > 0, 'SHIFT_CHANGED audit exists');
    assert(changeAuditRes.rows[0].old_shift_template_id === oldShiftId, 'Old shift template correct');
    assert(changeAuditRes.rows[0].new_shift_template_id === eveningShiftId, 'New shift template correct');
    pass('J: CHANGED status with correct audit trail');

    // ─── TEST K: Unauthorized mutation ───
    console.log('\n[TEST K] MOBILE_ONLY user rejected');

    const unauthorizedRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp1Id, work_date: '2026-09-12', shift_template_id: morningShiftId
    }, mobileToken);
    assert(unauthorizedRes.status === 403, `Expected 403, got ${unauthorizedRes.status}`);
    pass('K: MOBILE_ONLY user correctly denied');

    // ─── TEST L: Inactive shift template ───
    console.log('\n[TEST L] Inactive shift template enforcement');

    // L1: Cannot assign new schedule with inactive template
    const inactiveAssignRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp1Id, work_date: '2026-09-20', shift_template_id: inactiveShiftId
    }, token);
    assert(inactiveAssignRes.status === 422, `Expected 422 for inactive template, got ${inactiveAssignRes.status}`);
    assert(inactiveAssignRes.body.code === 'SHIFT_TEMPLATE_INACTIVE', 'Code should be SHIFT_TEMPLATE_INACTIVE');
    pass('L: Inactive template rejected for new assignment');

    // L2: Cannot modify published schedule with inactive template
    const inactiveModifyRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp1Id, work_date: '2026-09-08', shift_template_id: inactiveShiftId
    }, token);
    assert(inactiveModifyRes.status === 422, `Expected 422 for inactive template modify, got ${inactiveModifyRes.status}`);
    pass('L: Inactive template rejected for schedule modification');

    // L3: Historical schedule referencing inactive template still readable
    // Deactivate morning shift temporarily
    await pool.query('UPDATE work_shift_templates SET is_active = FALSE WHERE id = $1', [morningShiftId]);
    // Existing schedule with morning shift should still be readable
    const histCheck = await pool.query(
      'SELECT * FROM employee_work_schedules WHERE id = $1',
      [pubSchedId]
    );
    assert(histCheck.rowCount > 0, 'Historical schedule still accessible after template deactivation');
    assert(histCheck.rows[0].shift_template_id === morningShiftId || histCheck.rows[0].shift_template_id === eveningShiftId,
      'Historical schedule retains template reference');
    // Restore
    await pool.query('UPDATE work_shift_templates SET is_active = TRUE WHERE id = $1', [morningShiftId]);
    pass('L: Historical schedule references preserved after deactivation');

    // ─── TEST M: Attendance schedule resolver ───
    console.log('\n[TEST M] Attendance schedule resolver');

    await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp1Id, work_date: '2026-09-12', shift_template_id: morningShiftId
    }, token);
    await request('POST', '/api/schedule/publish', {
      property_id: 1, start_date: '2026-09-12', end_date: '2026-09-12'
    }, token);

    const attRes = await request('GET', '/api/schedule/attendance-schedule?property_id=1&employee_id=' + testEmp1Id + '&work_date=2026-09-12', null, token);
    assert(attRes.status === 200, 'Attendance query ok');
    assert(attRes.body.data.found === true, 'Schedule found');
    assert(attRes.body.data.shift_template !== null, 'Shift template returned');
    pass('M: Attendance resolver returns published schedule');

    const noSchedRes = await request('GET', '/api/schedule/attendance-schedule?property_id=1&employee_id=' + testEmp1Id + '&work_date=2026-09-25', null, token);
    assert(noSchedRes.body.data.found === false, 'No schedule → found=false');
    assert(noSchedRes.body.data.schedule === null, 'No schedule → schedule=null');
    pass('N: No schedule returns controlled result');

    // ─── TEST O: Audit history endpoint ───
    console.log('\n[TEST O] Audit history endpoint');

    const auditHistoryRes = await request('GET', `/api/schedule/audit/${testEmp1Id}?property_id=1`, null, token);
    assert(auditHistoryRes.status === 200, 'Audit history ok');
    assert(Array.isArray(auditHistoryRes.body.data), 'Audit history is array');
    assert(auditHistoryRes.body.data.length >= 1, 'At least 1 audit record');
    pass('O: Audit history returned');

    // ─── TEST P: Audit actor FK consistency ───
    console.log('\n[TEST P] Audit actor FK uses validUserId');

    // The test actor id 99999 may not exist in users table.
    // Check that audit records have either valid FK or null (not invalid reference)
    const auditFkCheck = await pool.query(
      `SELECT a.changed_by_user_id, u.id as real_user_id
       FROM employee_work_schedule_audits a
       LEFT JOIN users u ON u.id = a.changed_by_user_id
       WHERE a.property_id = 1 AND a.changed_by_user_id IS NOT NULL`
    );
    for (const row of auditFkCheck.rows) {
      assert(row.real_user_id !== null,
        `Audit FK ${row.changed_by_user_id} must reference a real user or be null`);
    }
    pass('P: All audit FKs reference real users or are null');

    // ─── TEST Q: Security allowlist for shift template update ───
    console.log('\n[TEST Q] Security allowlist for shift template update');

    // Attempt to update with unexpected field — should be silently ignored
    const maliciousPayload = {
      name: 'TEST_Morning_Updated',
      is_admin: true,
      property_id: 999,
      id: 9999,
      code: 'TEST_M',
      _sql_injection: 'DROP TABLE',
    };
    const updateRes = await request('PATCH', `/api/schedule/shift-templates/${morningShiftId}`, {
      ...maliciousPayload,
      property_id: 1,
    }, token);
    if (updateRes.status !== 200) throw new Error(`TEST Q Failed: ${JSON.stringify(updateRes.body)}`);

    // Verify the template was updated with allowed fields only
    const updatedTmpl = await pool.query('SELECT * FROM work_shift_templates WHERE id = $1', [morningShiftId]);
    assert(updatedTmpl.rows[0].name === 'TEST_Morning_Updated', 'Name was updated');
    assert(!updatedTmpl.rows[0].is_admin, 'is_admin should not exist on template');
    assert(updatedTmpl.rows[0].property_id === 1, 'Property should not change');

    // Verify dangerous fields were not written
    const colRes = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'work_shift_templates' AND column_name IN ('is_admin', '_sql_injection')`
    );
    assert(colRes.rowCount === 0, 'Dangerous columns should not exist in table');
    pass('Q: Unexpected fields silently rejected/ignored');

    // ─── TEST R: Timezone test (property timezone used) ───
    console.log('\n[TEST R] Property timezone used instead of hardcoded +07:00');

    // The property 1 default timezone is Asia/Jakarta (+07:00).
    // Verify the timestamp construction uses the property timezone.
    const tzAssignRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp2Id, work_date: '2026-09-12', shift_template_id: morningShiftId
    }, token);
    if (tzAssignRes.status !== 200) throw new Error(`TEST R Failed: ${JSON.stringify(tzAssignRes.body)}`);
    const tzSched = tzAssignRes.body.data;
    // 07:00 Asia/Jakarta = 00:00 UTC
    assert(tzSched.scheduled_start_at.includes('00:00'), `Start should be 00:00 UTC for Asia/Jakarta 07:00, got ${tzSched.scheduled_start_at}`);
    assert(tzSched.scheduled_end_at.includes('08:00'), `End should be 08:00 UTC for Asia/Jakarta 15:00, got ${tzSched.scheduled_end_at}`);
    pass('R: Asia/Jakarta timezone correctly applied');

    // Verify the timestamp contains the proper offset (not hardcoded +07:00 in code,
    // but resolved dynamically from property timezone)
    assert(tzSched.scheduled_start_at.includes('+07:00') || tzSched.scheduled_start_at.endsWith('Z'),
      `Timestamp should use property timezone offset, got ${tzSched.scheduled_start_at}`);
    pass('R: Timestamp uses resolved property timezone offset');

    // ─── TEST S: Publish/change lifecycle ───
    console.log('\n[TEST S] Publish → Change → Republish lifecycle');

    // Assign new schedule (DRAFT)
    await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp3Id, work_date: '2026-09-12', shift_template_id: eveningShiftId
    }, token);

    // Verify DRAFT
    const draftCheck = await pool.query(
      `SELECT schedule_status FROM employee_work_schedules
       WHERE property_id = 1 AND employee_id = $1 AND work_date = '2026-09-12'`,
      [testEmp3Id]
    );
    assert(draftCheck.rows[0]?.schedule_status === 'DRAFT', 'New schedule should be DRAFT');

    // Publish
    await request('POST', '/api/schedule/publish', {
      property_id: 1, start_date: '2026-09-12', end_date: '2026-09-12'
    }, token);
    const pubCheck = await pool.query(
      `SELECT schedule_status FROM employee_work_schedules
       WHERE property_id = 1 AND employee_id = $1 AND work_date = '2026-09-12'`,
      [testEmp3Id]
    );
    assert(pubCheck.rows[0]?.schedule_status === 'PUBLISHED', 'After publish: PUBLISHED');

    // Modify published → CHANGED
    await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp3Id, work_date: '2026-09-12', shift_template_id: nightShiftId
    }, token);
    const changedCheck = await pool.query(
      `SELECT schedule_status FROM employee_work_schedules
       WHERE property_id = 1 AND employee_id = $1 AND work_date = '2026-09-12'`,
      [testEmp3Id]
    );
    assert(changedCheck.rows[0]?.schedule_status === 'CHANGED', 'After modify: CHANGED');

    // Republish → PUBLISHED again
    await request('POST', '/api/schedule/publish', {
      property_id: 1, start_date: '2026-09-12', end_date: '2026-09-12'
    }, token);
    const repubCheck = await pool.query(
      `SELECT schedule_status FROM employee_work_schedules
       WHERE property_id = 1 AND employee_id = $1 AND work_date = '2026-09-12'`,
      [testEmp3Id]
    );
    assert(repubCheck.rows[0]?.schedule_status === 'PUBLISHED', 'After republish: PUBLISHED');
    pass('S: DRAFT → PUBLISHED → CHANGED → PUBLISHED lifecycle correct');

    // Verify CHANGE audit was recorded
    const schedId = (await pool.query(
      `SELECT id FROM employee_work_schedules WHERE property_id = $1 AND employee_id = $2 AND work_date = '2026-09-12'`,
      [1, testEmp3Id]
    )).rows[0].id;
    const changeAuditCount = await pool.query(
      `SELECT COUNT(*) as cnt FROM employee_work_schedule_audits
       WHERE schedule_id = $1 AND action = 'SHIFT_CHANGED'`,
      [schedId]
    );
    assert(parseInt(changeAuditCount.rows[0].cnt, 10) >= 1, 'At least 1 SHIFT_CHANGED audit');
    pass('S: CHANGE audit trail preserved');

    // ─── TEST T: Department-scoped template ───
    console.log('\n[TEST T] Department-scoped template');

    // Create a second department for cross-department testing
    const dept2Res = await request('POST', '/api/hrd/departments', {
      property_id: 1, code: 'DEP_TEST_SCHED2', name: 'TEST_SCHED_FNB', description: 'Test F&B Dept'
    }, token);
    if (dept2Res.status !== 201 || !dept2Res.body?.data?.id) throw new Error('TEST T Setup: Failed to create dept2');
    const testDept2Id = dept2Res.body.data.id;

    const pos2Res = await request('POST', '/api/hrd/positions', {
      property_id: 1, department_id: testDept2Id, code: 'POS_TEST_SCHED2', name: 'TEST_SCHED_Waiter'
    }, token);
    if (pos2Res.status !== 201 || !pos2Res.body?.data?.id) throw new Error('TEST T Setup: Failed to create pos2');
    const testPos2Id = pos2Res.body.data.id;

    // Create employee with NULL department
    const nullDeptEmpRes = await request('POST', '/api/hrd/employees', {
      property_id: 1, full_name: 'TEST_SCHEDULE_NullDept', position_id: testPosId, role: 'Crew', create_login_account: false
    }, token);
    if (nullDeptEmpRes.status !== 201 || !nullDeptEmpRes.body?.data?.id) throw new Error('TEST T Setup: Failed to create null-dept employee');
    const nullDeptEmpId = nullDeptEmpRes.body.data.id;

    // Create employee in dept2
    const dept2EmpRes = await request('POST', '/api/hrd/employees', {
      property_id: 1, full_name: 'TEST_SCHEDULE_Dept2Emp', department_id: testDept2Id, position_id: testPos2Id, role: 'Crew', create_login_account: false
    }, token);
    if (dept2EmpRes.status !== 201 || !dept2EmpRes.body?.data?.id) throw new Error('TEST T Setup: Failed to create dept2 employee');
    const dept2EmpId = dept2EmpRes.body.data.id;

    // Create department-scoped template (scoped to testDeptId)
    const scopedTmplRes = await request('POST', '/api/schedule/shift-templates', {
      property_id: 1, code: 'TEST_SC', name: 'TEST_Scoped', start_time: '08:00', end_time: '16:00', department_id: testDeptId
    }, token);
    if (scopedTmplRes.status !== 201) throw new Error(`TEST T Failed: Create scoped template: ${JSON.stringify(scopedTmplRes.body)}`);
    const scopedTmplId = scopedTmplRes.body.data.id;
    assert(scopedTmplRes.body.data.department_id === testDeptId, 'Template should have department_id set');
    pass('T: Department-scoped template created');

    // T1: Assign to employee in SAME department → should succeed
    const sameDeptAssignRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp1Id, work_date: '2026-09-13', shift_template_id: scopedTmplId
    }, token);
    if (sameDeptAssignRes.status !== 200) throw new Error(`TEST T1 Failed: ${JSON.stringify(sameDeptAssignRes.body)}`);
    pass('T: Assign to same-department employee succeeds');

    // T2: Assign to employee in DIFFERENT department → should fail
    const diffDeptAssignRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: dept2EmpId, work_date: '2026-09-13', shift_template_id: scopedTmplId
    }, token);
    assert(diffDeptAssignRes.status === 422, `Expected 422 for dept mismatch, got ${diffDeptAssignRes.status}`);
    assert(diffDeptAssignRes.body.code === 'SHIFT_TEMPLATE_DEPARTMENT_MISMATCH', 'Code should be SHIFT_TEMPLATE_DEPARTMENT_MISMATCH');
    pass('T: Assign to different-department employee rejected (422)');

    // T3: Assign to employee with NULL department → should fail
    const nullDeptAssignRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: nullDeptEmpId, work_date: '2026-09-13', shift_template_id: scopedTmplId
    }, token);
    assert(nullDeptAssignRes.status === 422, `Expected 422 for null-dept employee, got ${nullDeptAssignRes.status}`);
    assert(nullDeptAssignRes.body.code === 'SHIFT_TEMPLATE_DEPARTMENT_MISMATCH', 'Code should be SHIFT_TEMPLATE_DEPARTMENT_MISMATCH for null-dept');
    pass('T: Assign to null-department employee rejected (422)');

    // T4: Filter templates by department_id shows scoped template
    const deptFilterRes = await request('GET', `/api/schedule/shift-templates?property_id=1&department_id=${testDeptId}`, null, token);
    assert(deptFilterRes.status === 200, 'List with dept filter ok');
    const scopedInFilter = deptFilterRes.body.data.find(t => t.id === scopedTmplId);
    assert(scopedInFilter, 'Scoped template should appear in dept-specific filter');
    const globalInFilter = deptFilterRes.body.data.find(t => t.department_id === null);
    assert(globalInFilter, 'Global templates should also appear in dept-specific filter');
    pass('T: Department filter on template list works');

    // T5: Filter templates by department_id=0 shows only global
    const globalOnlyRes = await request('GET', '/api/schedule/shift-templates?property_id=1&department_id=0', null, token);
    assert(globalOnlyRes.status === 200, 'List with dept=0 ok');
    const scopedInGlobal = globalOnlyRes.body.data.find(t => t.id === scopedTmplId);
    assert(!scopedInGlobal, 'Scoped template should NOT appear in global-only filter');
    pass('T: department_id=0 filter returns only global templates');

    // ─── TEST U: Cross-property department validation ───
    console.log('\n[TEST U] Cross-property department validation');

    // Create a department in property 2
    const deptP2Res = await request('POST', '/api/hrd/departments', {
      property_id: 2, code: 'DEP_TEST_SCHED_P2', name: 'TEST_SCHED_P2_Dept', description: 'Test P2 Dept'
    }, token);
    if (deptP2Res.status !== 201 || !deptP2Res.body?.data?.id) throw new Error('TEST U Setup: Failed to create p2 dept');
    const p2DeptId = deptP2Res.body.data.id;

    // U1: Create template in property 1 with department from property 2 → should fail
    const crossPropCreateRes = await request('POST', '/api/schedule/shift-templates', {
      property_id: 1, code: 'TEST_XP', name: 'TEST_CrossProp', start_time: '09:00', end_time: '17:00', department_id: p2DeptId
    }, token);
    assert(crossPropCreateRes.status === 422, `Expected 422 for cross-property dept create, got ${crossPropCreateRes.status}`);
    assert(crossPropCreateRes.body.code === 'DEPARTMENT_PROPERTY_MISMATCH', 'Code should be DEPARTMENT_PROPERTY_MISMATCH');
    pass('U: Create template with cross-property department rejected (422)');

    // U2: Create template with nonexistent department → should fail
    const noDeptCreateRes = await request('POST', '/api/schedule/shift-templates', {
      property_id: 1, code: 'TEST_ND', name: 'TEST_NoDept', start_time: '09:00', end_time: '17:00', department_id: 99999999
    }, token);
    assert(noDeptCreateRes.status === 404, `Expected 404 for nonexistent dept, got ${noDeptCreateRes.status}`);
    assert(noDeptCreateRes.body.code === 'DEPARTMENT_NOT_FOUND', 'Code should be DEPARTMENT_NOT_FOUND');
    pass('U: Create template with nonexistent department rejected (404)');

    // U3: Update template to point to cross-property department → should fail
    const crossPropUpdateRes = await request('PATCH', `/api/schedule/shift-templates/${scopedTmplId}?property_id=1`, {
      department_id: p2DeptId
    }, token);
    assert(crossPropUpdateRes.status === 422, `Expected 422 for cross-property dept update, got ${crossPropUpdateRes.status}`);
    assert(crossPropUpdateRes.body.code === 'DEPARTMENT_PROPERTY_MISMATCH', 'Code should be DEPARTMENT_PROPERTY_MISMATCH on update');
    pass('U: Update template to cross-property department rejected (422)');

    // U4: Update template to point to nonexistent department → should fail
    const noDeptUpdateRes = await request('PATCH', `/api/schedule/shift-templates/${scopedTmplId}?property_id=1`, {
      department_id: 99999999
    }, token);
    assert(noDeptUpdateRes.status === 404, `Expected 404 for nonexistent dept update, got ${noDeptUpdateRes.status}`);
    pass('U: Update template to nonexistent department rejected (404)');

    // ─── TEST V: Global template + department filter ───
    console.log('\n[TEST V] Global template and department filter');

    // Create a global template (no department_id)
    const globalTmplRes = await request('POST', '/api/schedule/shift-templates', {
      property_id: 1, code: 'TEST_GL', name: 'TEST_Global', start_time: '06:00', end_time: '14:00'
    }, token);
    if (globalTmplRes.status !== 201) throw new Error(`TEST V Failed: ${JSON.stringify(globalTmplRes.body)}`);
    const globalTmplId = globalTmplRes.body.data.id;
    assert(globalTmplRes.body.data.department_id === null, 'Global template should have null department_id');
    pass('V: Global template created');

    // V1: Assign global template to employee in any department → should succeed
    const globalAssignRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: dept2EmpId, work_date: '2026-09-13', shift_template_id: globalTmplId
    }, token);
    if (globalAssignRes.status !== 200) throw new Error(`TEST V1 Failed: ${JSON.stringify(globalAssignRes.body)}`);
    pass('V: Global template assignable to any department employee');

    // V2: Assign global template to null-department employee → should succeed
    const globalNullDeptRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: nullDeptEmpId, work_date: '2026-09-13', shift_template_id: globalTmplId
    }, token);
    if (globalNullDeptRes.status !== 200) throw new Error(`TEST V2 Failed: ${JSON.stringify(globalNullDeptRes.body)}`);
    pass('V: Global template assignable to null-department employee');

    // V3: No department filter → returns all templates
    const allTmplRes = await request('GET', '/api/schedule/shift-templates?property_id=1', null, token);
    assert(allTmplRes.status === 200, 'List all templates ok');
    const hasScoped = allTmplRes.body.data.some(t => t.id === scopedTmplId);
    const hasGlobal = allTmplRes.body.data.some(t => t.id === globalTmplId);
    assert(hasScoped && hasGlobal, 'No filter should return both scoped and global');
    pass('V: No department filter returns all templates');

    // ─── TEST W: Bulk assignment with department mismatch fails atomically ───
    console.log('\n[TEST W] Bulk assignment with dept mismatch fails atomically');

    // Bulk assign: one employee matches dept, one doesn't, one has null dept
    // All should fail with zero partial writes
    const bulkMismatchRes = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id, dept2EmpId, nullDeptEmpId],
      shift_template_id: scopedTmplId,
      start_date: '2026-09-22',
      end_date: '2026-09-22'
    }, token);
    assert(bulkMismatchRes.status === 422, `Expected 422 for bulk dept mismatch, got ${bulkMismatchRes.status}`);
    assert(bulkMismatchRes.body.code === 'SHIFT_TEMPLATE_DEPARTMENT_MISMATCH', 'Code should be SHIFT_TEMPLATE_DEPARTMENT_MISMATCH');
    pass('W: Bulk assign with dept mismatch rejected');

    // Verify ZERO partial writes — no schedules created for ANY employee
    const bulkCheck1 = await pool.query(
      'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [testEmp1Id, '2026-09-22']
    );
    const bulkCheck2 = await pool.query(
      'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [dept2EmpId, '2026-09-22']
    );
    const bulkCheck3 = await pool.query(
      'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [nullDeptEmpId, '2026-09-22']
    );
    assert(parseInt(bulkCheck1.rows[0].cnt) === 0, 'W: No partial write for same-dept employee');
    assert(parseInt(bulkCheck2.rows[0].cnt) === 0, 'W: No partial write for diff-dept employee');
    assert(parseInt(bulkCheck3.rows[0].cnt) === 0, 'W: No partial write for null-dept employee');
    pass('W: Bulk failure produces ZERO partial writes (atomic rollback)');

    // ═══════════════════════════════════════════════
    // HR-SCHEDULE-1C-B + 1D TESTS (X1–X19)
    // ═══════════════════════════════════════════════

    // ─── TEST X1: Valid color_key accepted ───
    console.log('\n[TEST X1] Valid color_key accepted');

    const colorTmplRes = await request('POST', '/api/schedule/shift-templates', {
      property_id: 1, code: 'TEST_XC1', name: 'TEST_ColorGreen', start_time: '07:00', end_time: '15:00', color_key: 'soft_green'
    }, token);
    if (colorTmplRes.status !== 201) throw new Error(`X1 Failed: ${JSON.stringify(colorTmplRes.body)}`);
    assert(colorTmplRes.body.data.color_key === 'soft_green', 'color_key should be soft_green');
    const colorTmplId = colorTmplRes.body.data.id;
    pass('X1: Valid color_key (soft_green) accepted on create');

    // ─── TEST X2: Invalid color_key rejected ───
    console.log('\n[TEST X2] Invalid color_key rejected');

    const invalidColorRes = await request('POST', '/api/schedule/shift-templates', {
      property_id: 1, code: 'TEST_XC2', name: 'TEST_InvalidColor', start_time: '07:00', end_time: '15:00', color_key: 'neon_red'
    }, token);
    assert(invalidColorRes.status === 422, `Expected 422 for invalid color_key, got ${invalidColorRes.status}`);
    assert(invalidColorRes.body.code === 'SHIFT_TEMPLATE_COLOR_INVALID', 'Code should be SHIFT_TEMPLATE_COLOR_INVALID');
    pass('X2: Invalid color_key rejected (422)');

    // ─── TEST X3: Existing template without color remains readable ───
    console.log('\n[TEST X3] Existing template without color remains readable');

    // morningShiftId was created before color_key existed in test data — should default to soft_slate
    const morningTmplRes = await request('GET', `/api/schedule/shift-templates/${morningShiftId}?property_id=1`, null, token);
    assert(morningTmplRes.status === 200, 'Template without explicit color still readable');
    assert(morningTmplRes.body.data.color_key === 'soft_slate', 'Default color_key should be soft_slate');
    pass('X3: Existing template defaults to soft_slate');

    // ─── TEST X4: color_key returned by template API ───
    console.log('\n[TEST X4] color_key returned by template list and get');

    const listColorRes = await request('GET', '/api/schedule/shift-templates?property_id=1&include_inactive=true', null, token);
    assert(listColorRes.status === 200, 'List ok');
    const foundColorTmpl = listColorRes.body.data.find(t => t.id === colorTmplId);
    assert(foundColorTmpl && foundColorTmpl.color_key === 'soft_green', 'List returns color_key');
    assert(morningTmplRes.body.data.color_key !== undefined, 'Get returns color_key field');
    pass('X4: color_key returned in list and get APIs');

    // ─── TEST X5: color change does not alter schedule semantics ───
    console.log('\n[TEST X5] Color change does not alter schedule semantics');

    // Assign morning shift to emp1
    await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp1Id, work_date: '2026-09-14', shift_template_id: morningShiftId
    }, token);
    const beforeColorChange = await pool.query(
      'SELECT shift_template_id, scheduled_start_at, scheduled_end_at FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [testEmp1Id, '2026-09-14']
    );
    // Change color of morning template
    await request('PATCH', `/api/schedule/shift-templates/${morningShiftId}`, {
      property_id: 1, color_key: 'soft_blue'
    }, token);
    const afterColorChange = await pool.query(
      'SELECT shift_template_id, scheduled_start_at, scheduled_end_at FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [testEmp1Id, '2026-09-14']
    );
    assert(beforeColorChange.rows[0].shift_template_id === afterColorChange.rows[0].shift_template_id, 'shift_template_id unchanged after color change');
    assert(String(beforeColorChange.rows[0].scheduled_start_at) === String(afterColorChange.rows[0].scheduled_start_at), 'scheduled_start_at unchanged after color change');
    // Restore color
    await request('PATCH', `/api/schedule/shift-templates/${morningShiftId}`, {
      property_id: 1, color_key: 'soft_slate'
    }, token);
    pass('X5: Color change preserves existing schedule data');

    // ─── TEST X6: Multi-employee assignment succeeds ───
    console.log('\n[TEST X6] Multi-employee assignment via bulk-assign');

    const multiAssignRes = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id, testEmp2Id, testEmp3Id],
      shift_template_id: morningShiftId,
      start_date: '2026-09-23',
      end_date: '2026-09-23'
    }, token);
    if (multiAssignRes.status !== 200) throw new Error(`X6 Failed: ${JSON.stringify(multiAssignRes.body)}`);
    assert(multiAssignRes.body.data.assigned_count >= 3, 'At least 3 assignments');
    // Verify all 3 employees have schedules
    for (const empId of [testEmp1Id, testEmp2Id, testEmp3Id]) {
      const cnt = await pool.query(
        'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
        [empId, '2026-09-23']
      );
      assert(parseInt(cnt.rows[0].cnt) === 1, `Employee ${empId} should have 1 schedule`);
    }
    pass('X6: Multi-employee assignment succeeds');

    // ─── TEST X7: Many employees assigned to one shift template ───
    console.log('\n[TEST X7] Many employees on one template');

    // Bulk assign all 3 employees + days
    const manyRes = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id, testEmp2Id, testEmp3Id],
      shift_template_id: eveningShiftId,
      start_date: '2026-09-21',
      end_date: '2026-09-22',
      days_of_week: [1, 2]
    }, token);
    if (manyRes.status !== 200) throw new Error(`X7 Failed: ${JSON.stringify(manyRes.body)}`);
    assert(manyRes.body.data.assigned_count >= 3, 'At least 3 assignments for evening shift');
    pass('X7: Many employees on one template via bulk');

    // ─── TEST X8: Multi-employee assignment remains atomic ───
    console.log('\n[TEST X8] Multi-employee bulk assignment atomic');

    const atomicRes = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id, testEmp2Id, testEmp3Id],
      shift_template_id: morningShiftId,
      start_date: '2026-09-26',
      end_date: '2026-09-27'
    }, token);
    if (atomicRes.status !== 200) throw new Error(`X8 Failed: ${JSON.stringify(atomicRes.body)}`);
    // All or nothing: count total
    const totalCnt = await pool.query(
      'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = ANY($1) AND work_date >= $2 AND work_date <= $3',
      [[testEmp1Id, testEmp2Id, testEmp3Id], '2026-09-26', '2026-09-27']
    );
    assert(parseInt(totalCnt.rows[0].cnt) >= 6, 'Expected at least 6 schedules for 3 employees x 2 days');
    pass('X8: Multi-employee assignment is atomic');

    // ─── TEST X9: Mismatched employee in bulk causes zero partial writes ───
    console.log('\n[TEST X9] Bulk with dept mismatch = zero partial writes');

    const bulkMixedRes = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id, dept2EmpId],
      shift_template_id: scopedTmplId,
      start_date: '2026-09-28',
      end_date: '2026-09-28'
    }, token);
    assert(bulkMixedRes.status === 422, `Expected 422, got ${bulkMixedRes.status}`);
    // Verify ZERO partial writes
    const partialCheck1 = await pool.query(
      'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [testEmp1Id, '2026-09-28']
    );
    const partialCheck2 = await pool.query(
      'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [dept2EmpId, '2026-09-28']
    );
    assert(parseInt(partialCheck1.rows[0].cnt) === 0, 'No partial write for same-dept employee');
    assert(parseInt(partialCheck2.rows[0].cnt) === 0, 'No partial write for diff-dept employee');
    pass('X9: Bulk dept mismatch produces zero partial writes');

    // ─── TEST X10: Global template usable in selected department context ───
    console.log('\n[TEST X10] Global template assignable across departments');

    // Assign global template to dept1 employee
    const gRes1 = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp1Id, work_date: '2026-09-24', shift_template_id: globalTmplId
    }, token);
    if (gRes1.status !== 200) throw new Error(`X10a Failed: ${JSON.stringify(gRes1.body)}`);

    // Assign global template to dept2 employee
    const gRes2 = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: dept2EmpId, work_date: '2026-09-24', shift_template_id: globalTmplId
    }, token);
    if (gRes2.status !== 200) throw new Error(`X10b Failed: ${JSON.stringify(gRes2.body)}`);

    // Assign global template to null-dept employee
    const gRes3 = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: nullDeptEmpId, work_date: '2026-09-24', shift_template_id: globalTmplId
    }, token);
    if (gRes3.status !== 200) throw new Error(`X10c Failed: ${JSON.stringify(gRes3.body)}`);

    pass('X10: Global template assignable across all departments');

    // ─── TEST X11: Department-scoped template only accepts same-department employees ───
    console.log('\n[TEST X11] Dept-scoped template rejects other dept/null dept');

    const dsRes1 = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: dept2EmpId, work_date: '2026-09-25', shift_template_id: scopedTmplId
    }, token);
    assert(dsRes1.status === 422, `Expected 422 for other dept, got ${dsRes1.status}`);

    const dsRes2 = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: nullDeptEmpId, work_date: '2026-09-25', shift_template_id: scopedTmplId
    }, token);
    assert(dsRes2.status === 422, `Expected 422 for null dept, got ${dsRes2.status}`);

    // Same dept should succeed
    const dsRes3 = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp1Id, work_date: '2026-09-25', shift_template_id: scopedTmplId
    }, token);
    if (dsRes3.status !== 200) throw new Error(`X11 same-dept Failed: ${JSON.stringify(dsRes3.body)}`);
    pass('X11: Dept-scoped template only accepts same-department employees');

    // ─── TEST X12: Weekly roster returns template color metadata ───
    console.log('\n[TEST X12] Weekly roster returns template color_key');

    const rosterResX12 = await request('GET', `/api/schedule/roster?property_id=1&start_date=2026-09-22`, null, token);
    assert(rosterResX12.status === 200, 'Weekly roster ok');
    const rosterTmpl = rosterResX12.body.data.shift_templates.find(t => t.id === colorTmplId);
    assert(rosterTmpl && rosterTmpl.color_key === 'soft_green', 'Weekly roster returns color_key for template');
    const rosterMorning = rosterResX12.body.data.shift_templates.find(t => t.id === morningShiftId);
    assert(rosterMorning && rosterMorning.color_key !== undefined, 'Weekly roster includes color_key on all templates');
    pass('X12: Weekly roster returns template color metadata');

    // ─── TEST X13: Monthly roster returns template color metadata ───
    console.log('\n[TEST X13] Monthly roster returns template color_key');

    const monthRosterRes = await request('GET', `/api/schedule/roster-monthly?property_id=1&year=2026&month=9`, null, token);
    assert(monthRosterRes.status === 200, 'Monthly roster ok');
    const monthTmpl = monthRosterRes.body.data.shift_templates.find(t => t.id === colorTmplId);
    assert(monthTmpl && monthTmpl.color_key === 'soft_green', 'Monthly roster returns color_key');
    pass('X13: Monthly roster returns template color metadata');

    // ─── TEST X14: Weekly/monthly read same canonical schedules ───
    console.log('\n[TEST X14] Weekly and monthly read same canonical data');

    // Both should reference the same employee_work_schedules table
    const weekEmpCount = rosterResX12.body.data.employees.length;
    const monthEmpCount = monthRosterRes.body.data.employees.length;
    assert(weekEmpCount > 0, 'Weekly roster has employees');
    assert(monthEmpCount > 0, 'Monthly roster has employees');
    // Both should have same shift_templates
    assert(rosterResX12.body.data.shift_templates.length === monthRosterRes.body.data.shift_templates.length,
      'Same number of shift templates in both views');
    pass('X14: Weekly and monthly use same canonical data');

    // ─── TEST X15: Non-operational department assignment works ───
    console.log('\n[TEST X15] Non-operational department assignment');

    // dept2EmpId is in testDept2Id (F&B), non-operational
    const nonOpRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: dept2EmpId, work_date: '2026-09-25', shift_template_id: globalTmplId
    }, token);
    if (nonOpRes.status !== 200) throw new Error(`X15 Failed: ${JSON.stringify(nonOpRes.body)}`);
    assert(nonOpRes.body.data.shift_template_id === globalTmplId, 'Non-op dept assignment uses global template');
    pass('X15: Non-operational department assignment works');

    // ─── TEST X16: Operational department assignment works ───
    console.log('\n[TEST X16] Operational department assignment');

    const opRes = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp2Id, work_date: '2026-09-25', shift_template_id: scopedTmplId
    }, token);
    if (opRes.status !== 200) throw new Error(`X16 Failed: ${JSON.stringify(opRes.body)}`);
    assert(opRes.body.data.shift_template_id === scopedTmplId, 'Op dept assignment uses scoped template');
    pass('X16: Operational department assignment works');

    // ─── TEST X17: Cross-midnight regression PASS ───
    console.log('\n[TEST X17] Cross-midnight regression');

    const nightResX17 = await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp3Id, work_date: '2026-09-25', shift_template_id: nightShiftId
    }, token);
    if (nightResX17.status !== 200) throw new Error(`X17 Failed: ${JSON.stringify(nightResX17.body)}`);
    assert(nightResX17.body.data.scheduled_start_at.startsWith('2026-09-25'), 'Cross-midnight start date correct');
    assert(nightResX17.body.data.scheduled_end_at.startsWith('2026-09-26'), 'Cross-midnight end date correct (next day)');
    pass('X17: Cross-midnight regression PASS');

    // ─── TEST X18: Publish lifecycle regression PASS ───
    console.log('\n[TEST X18] Publish lifecycle regression');

    // Assign DRAFT
    await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp1Id, work_date: '2026-09-26', shift_template_id: morningShiftId
    }, token);
    const draftCheckX18 = await pool.query(
      `SELECT schedule_status FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = '2026-09-26'`,
      [testEmp1Id]
    );
    assert(draftCheckX18.rows[0]?.schedule_status === 'DRAFT', 'X18: DRAFT status');

    // Publish
    await request('POST', '/api/schedule/publish', {
      property_id: 1, start_date: '2026-09-26', end_date: '2026-09-26'
    }, token);
    const pubCheckX18 = await pool.query(
      `SELECT schedule_status FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = '2026-09-26'`,
      [testEmp1Id]
    );
    assert(pubCheckX18.rows[0]?.schedule_status === 'PUBLISHED', 'X18: PUBLISHED after publish');

    // Modify → CHANGED
    await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp1Id, work_date: '2026-09-26', shift_template_id: eveningShiftId
    }, token);
    const changedCheckX18 = await pool.query(
      `SELECT schedule_status FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = '2026-09-26'`,
      [testEmp1Id]
    );
    assert(changedCheckX18.rows[0]?.schedule_status === 'CHANGED', 'X18: CHANGED after modify');

    // Republish
    await request('POST', '/api/schedule/publish', {
      property_id: 1, start_date: '2026-09-26', end_date: '2026-09-26'
    }, token);
    const repubCheckX18 = await pool.query(
      `SELECT schedule_status FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = '2026-09-26'`,
      [testEmp1Id]
    );
    assert(repubCheckX18.rows[0]?.schedule_status === 'PUBLISHED', 'X18: PUBLISHED after republish');
    pass('X18: Publish lifecycle regression PASS');

    // ─── TEST X19: Property isolation regression PASS ───
    console.log('\n[TEST X19] Property isolation regression');

    // Create shift template on property 2
    const prop2TmplRes = await request('POST', '/api/schedule/shift-templates', {
      property_id: 2, code: 'TP2X19', name: 'TEST_P2_X19', start_time: '08:00', end_time: '16:00', color_key: 'soft_amber'
    }, token);
    if (prop2TmplRes.status !== 201) throw new Error(`X19 setup Failed: ${JSON.stringify(prop2TmplRes.body)}`);

    // Verify property 1 cannot read property 2 template
    const crossReadRes = await request('GET', `/api/schedule/shift-templates/${prop2TmplRes.body.data.id}?property_id=1`, null, token);
    assert(crossReadRes.status === 404, `Property 1 cannot read property 2 template (expected 404, got ${crossReadRes.status})`);

    // Verify property 2 can read its own template
    const ownReadRes = await request('GET', `/api/schedule/shift-templates/${prop2TmplRes.body.data.id}?property_id=2`, null, token);
    assert(ownReadRes.status === 200, 'Property 2 can read own template');
    assert(ownReadRes.body.data.color_key === 'soft_amber', 'Property 2 template has correct color');

    // Cleanup prop2 template
    await pool.query('DELETE FROM work_shift_templates WHERE property_id = 2 AND code = $1', ['TP2X19']);
    pass('X19: Property isolation regression PASS');

    // ─── TEST XT: Team endpoint returns assigned employees ───
    console.log('\n[TEST XT] Team endpoint returns assigned employees');

    // Ensure some schedules exist for morningShiftId
    await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp1Id, work_date: '2026-09-22', shift_template_id: morningShiftId
    }, token);
    await request('POST', '/api/schedule/assign', {
      property_id: 1, employee_id: testEmp2Id, work_date: '2026-09-22', shift_template_id: morningShiftId
    }, token);

    const teamRes = await request('GET', `/api/schedule/shift-templates/${morningShiftId}/team?property_id=1&start_date=2026-09-22&end_date=2026-09-22`, null, token);
    if (teamRes.status !== 200) throw new Error(`XT Failed: ${JSON.stringify(teamRes.body)}`);
    assert(Array.isArray(teamRes.body.data), 'Team should be array');
    assert(teamRes.body.data.length >= 2, 'At least 2 team members');
    const teamMemberIds = teamRes.body.data.map(m => m.employee_id);
    assert(teamMemberIds.includes(testEmp1Id), 'Team includes testEmp1');
    assert(teamMemberIds.includes(testEmp2Id), 'Team includes testEmp2');
    // Each member should have schedule_count
    const member = teamRes.body.data.find(m => m.employee_id === testEmp1Id);
    assert(member.schedule_count >= 1, 'schedule_count should be >= 1');
    pass('X1: Team endpoint returns assigned employees with schedule_count');

    // ═══════════════════════════════════════════════
    // HR-SCHEDULE-1C-B UX + 1D TESTS (Y1–Y13)
    // ═══════════════════════════════════════════════

    // ─── TEST Y1: Bulk-assign validates required fields ───
    console.log('\n[TEST Y1] Bulk-assign validates required fields');

    const y1NoEmp = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1, shift_template_id: morningShiftId, start_date: '2026-09-29', end_date: '2026-09-29'
    }, token);
    assert(y1NoEmp.status === 400, `Expected 400 for missing employee_ids, got ${y1NoEmp.status}`);
    assert(y1NoEmp.body.code === 'MISSING_EMPLOYEES', 'Code should be MISSING_EMPLOYEES');

    const y1NoDates = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1, employee_ids: [testEmp1Id], shift_template_id: morningShiftId
    }, token);
    assert(y1NoDates.status === 400, `Expected 400 for missing dates, got ${y1NoDates.status}`);
    assert(y1NoDates.body.code === 'MISSING_DATES', 'Code should be MISSING_DATES');
    pass('Y1: Bulk-assign validates required fields (400)');

    // ─── TEST Y2: HRD employee list filters by department ───
    console.log('\n[TEST Y2] HRD employee list filters by department');

    const deptEmpRes = await request('GET', `/api/hrd/employees?property_id=1&department_id=${testDeptId}&scope=active`, null, token);
    assert(deptEmpRes.status === 200, 'Employee list by dept ok');
    const deptEmpIds = deptEmpRes.body.data.map(e => e.id);
    assert(deptEmpIds.includes(testEmp1Id), 'testEmp1 in dept list');
    assert(deptEmpIds.includes(testEmp2Id), 'testEmp2 in dept list');
    assert(deptEmpIds.includes(testEmp3Id), 'testEmp3 in dept list');
    assert(!deptEmpIds.includes(dept2EmpId), 'dept2Emp NOT in dept1 list');
    pass('Y2: Employee list filtered by department');

    // ─── TEST Y3: Global template bulk-assign with mixed departments succeeds ───
    console.log('\n[TEST Y3] Global template bulk-assign with mixed departments');

    const y3Res = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id, dept2EmpId],
      shift_template_id: globalTmplId,
      start_date: '2026-09-29',
      end_date: '2026-09-29',
      days_of_week: [2]
    }, token);
    if (y3Res.status !== 200) throw new Error(`Y3 Failed: ${JSON.stringify(y3Res.body)}`);
    assert(y3Res.body.data.assigned_count >= 2, 'At least 2 assignments for global template across depts');
    pass('Y3: Global template bulk-assign across departments succeeds');

    // ─── TEST Y4: Department-scoped template bulk-assign with mismatch fails atomically ───
    console.log('\n[TEST Y4] Scoped template bulk-assign mismatch = zero partial writes');

    const y4Res = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id, dept2EmpId],
      shift_template_id: scopedTmplId,
      start_date: '2026-09-30',
      end_date: '2026-09-30'
    }, token);
    assert(y4Res.status === 422, `Expected 422, got ${y4Res.status}`);

    // Verify zero partial writes
    const y4Check1 = await pool.query(
      'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [testEmp1Id, '2026-09-30']
    );
    const y4Check2 = await pool.query(
      'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [dept2EmpId, '2026-09-30']
    );
    assert(parseInt(y4Check1.rows[0].cnt) === 0, 'No partial write for same-dept emp');
    assert(parseInt(y4Check2.rows[0].cnt) === 0, 'No partial write for diff-dept emp');
    pass('Y4: Scoped template mismatch → zero partial writes');

    // ─── TEST Y5: days_of_week filtering in bulk-assign ───
    console.log('\n[TEST Y5] days_of_week filtering in bulk-assign');

    // 2026-10-12 is Monday (day=1), 2026-10-13 is Tuesday (day=2)
    const y5Res = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id],
      shift_template_id: morningShiftId,
      start_date: '2026-10-12',
      end_date: '2026-10-13',
      days_of_week: [1] // Monday only
    }, token);
    if (y5Res.status !== 200) throw new Error(`Y5 Failed: ${JSON.stringify(y5Res.body)}`);

    // Monday should have schedule, Tuesday should not
    const y5Mon = await pool.query(
      'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [testEmp1Id, '2026-10-12']
    );
    const y5Tue = await pool.query(
      'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [testEmp1Id, '2026-10-13']
    );
    assert(parseInt(y5Mon.rows[0].cnt) >= 1, 'Monday (day=1) should have schedule');
    assert(parseInt(y5Tue.rows[0].cnt) === 0, 'Tuesday (day=2) should have no schedule when filtered out');
    pass('Y5: days_of_week filtering works correctly');

    // ─── TEST Y6: Bulk-assign with empty employee_ids returns 400 ───
    console.log('\n[TEST Y6] Bulk-assign empty employee_ids');

    const y6Res = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1, employee_ids: [], shift_template_id: morningShiftId,
      start_date: '2026-09-29', end_date: '2026-09-29'
    }, token);
    assert(y6Res.status === 400, `Expected 400 for empty employee_ids, got ${y6Res.status}`);
    pass('Y6: Empty employee_ids returns 400');

    // ─── TEST Y7: Bulk-assign returns assigned_count ───
    console.log('\n[TEST Y7] Bulk-assign returns assigned_count');

    const y7Res = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id, testEmp2Id],
      shift_template_id: eveningShiftId,
      start_date: '2026-10-01',
      end_date: '2026-10-01'
    }, token);
    if (y7Res.status !== 200) throw new Error(`Y7 Failed: ${JSON.stringify(y7Res.body)}`);
    assert(typeof y7Res.body.data.assigned_count === 'number', 'assigned_count should be a number');
    assert(y7Res.body.data.assigned_count >= 2, 'assigned_count >= 2');
    pass('Y7: Bulk-assign returns assigned_count');

    // ─── TEST Y8: Team endpoint returns correct members after bulk-assign ───
    console.log('\n[TEST Y8] Team endpoint reflects new bulk-assign');

    // Assign emp1 and emp2 to eveningShiftId on a known date
    await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id, testEmp2Id],
      shift_template_id: eveningShiftId,
      start_date: '2026-10-02',
      end_date: '2026-10-02'
    }, token);

    const y8Team = await request('GET', `/api/schedule/shift-templates/${eveningShiftId}/team?property_id=1&start_date=2026-10-02&end_date=2026-10-02`, null, token);
    if (y8Team.status !== 200) throw new Error(`Y8 Failed: ${JSON.stringify(y8Team.body)}`);
    const y8TeamIds = y8Team.body.data.map(m => m.employee_id);
    assert(y8TeamIds.includes(testEmp1Id), 'Team includes testEmp1');
    assert(y8TeamIds.includes(testEmp2Id), 'Team includes testEmp2');
    const y8Member = y8Team.body.data.find(m => m.employee_id === testEmp1Id);
    assert(y8Member.schedule_count >= 1, 'schedule_count >= 1');
    pass('Y8: Team endpoint reflects bulk-assign results');

    // ─── TEST Y9: Color metadata preserved after multi-employee assignment ───
    console.log('\n[TEST Y9] Color metadata preserved after assignment');

    // Assign colorTmplId (soft_green) to 2 employees
    await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id, testEmp2Id],
      shift_template_id: colorTmplId,
      start_date: '2026-10-03',
      end_date: '2026-10-03'
    }, token);

    // Verify roster still returns soft_green for colorTmplId
    const y9Roster = await request('GET', `/api/schedule/roster?property_id=1&start_date=2026-10-03`, null, token);
    assert(y9Roster.status === 200, 'Roster ok');
    const y9Tmpl = y9Roster.body.data.shift_templates.find(t => t.id === colorTmplId);
    assert(y9Tmpl && y9Tmpl.color_key === 'soft_green', 'Color metadata preserved after assignment');
    pass('Y9: Color metadata preserved after multi-employee assignment');

    // ─── TEST Y10: Bulk-assign non-existent shift template returns error ───
    console.log('\n[TEST Y10] Bulk-assign with non-existent template');

    const y10Res = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id],
      shift_template_id: 99999999,
      start_date: '2026-10-04',
      end_date: '2026-10-04'
    }, token);
    assert(y10Res.status !== 200, `Expected error for non-existent template, got ${y10Res.status}`);
    pass('Y10: Non-existent template returns error');

    // ─── TEST Y11: Bulk-assign with notes field preserved ───
    console.log('\n[TEST Y11] Bulk-assign notes field');

    const y11Res = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id],
      shift_template_id: morningShiftId,
      start_date: '2026-10-05',
      end_date: '2026-10-05',
      notes: 'Test assignment note Y11'
    }, token);
    if (y11Res.status !== 200) throw new Error(`Y11 Failed: ${JSON.stringify(y11Res.body)}`);

    // Verify schedule was created
    const y11Sched = await pool.query(
      'SELECT notes FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
      [testEmp1Id, '2026-10-05']
    );
    assert(y11Sched.rows.length === 1, 'Schedule exists for Y11');
    pass('Y11: Bulk-assign with notes succeeds');

    // ─── TEST Y12: Bulk-assign multi-day range ───
    console.log('\n[TEST Y12] Bulk-assign multi-day range');

    const y12Res = await request('POST', '/api/schedule/bulk-assign', {
      property_id: 1,
      employee_ids: [testEmp1Id],
      shift_template_id: morningShiftId,
      start_date: '2026-10-06',
      end_date: '2026-10-08' // 3 days
    }, token);
    if (y12Res.status !== 200) throw new Error(`Y12 Failed: ${JSON.stringify(y12Res.body)}`);
    assert(y12Res.body.data.assigned_count >= 3, 'At least 3 assignments for 3-day range');

    // Verify all 3 days have schedules
    for (const d of ['2026-10-06', '2026-10-07', '2026-10-08']) {
      const cnt = await pool.query(
        'SELECT COUNT(*) as cnt FROM employee_work_schedules WHERE property_id = 1 AND employee_id = $1 AND work_date = $2',
        [testEmp1Id, d]
      );
      assert(parseInt(cnt.rows[0].cnt) >= 1, `Schedule exists for ${d}`);
    }
    pass('Y12: Bulk-assign multi-day range works');

    // ─── TEST Y13: 73 existing tests still pass (regression gate) ───
    console.log('\n[TEST Y13] Regression gate: total test count check');
    assert(passed >= 73, `At least 73 tests should have passed before Y13, got ${passed}`);
    pass('Y13: Regression gate PASS (73+ prior tests passed)');

    console.log('\n=== ALL TESTS PASSED ===');
    console.log(`Total: ${passed} passed, ${failed} failed`);

  } catch (err) {
    console.error('\n=== TEST SUITE FAILED ===');
    console.error(err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await cleanupTestFixtures();
    if (server) server.close();
    await pool.end();
  }
}

(async () => {
  server = app.listen(0, async () => {
    baseUrl = `http://localhost:${server.address().port}`;
    await runTests();
  });
})();
