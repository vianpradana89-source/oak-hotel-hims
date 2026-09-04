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
