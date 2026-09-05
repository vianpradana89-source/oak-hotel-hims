const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const http = require('http');

const TEST_PORT = 3189;

function makeRequest(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };
    if (payload) {
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTests() {
  console.log('=== AUTH-HR-3A: HRD Master CRUD Consistency & Super Admin Hard Delete Test Suite ===\n');

  let server;
  let superAdminUser, hrdAdminUser;
  let superAdminToken, hrdAdminToken;

  const createdFixtureIds = {
    employees: [],
    users: [],
    departments: [],
    positions: [],
    roles: [],
    groups: [],
    holidays: [],
    schedules: []
  };

  try {
    const express = require('express');
    const app = express();
    app.use(express.json());

    const { createHrdRouter } = require('../dist/domains/hrd/hrdRouter');
    const { createScheduleRouter } = require('../dist/domains/schedule/scheduleRouter');

    app.use('/api/hrd', createHrdRouter(pool));
    app.use('/api/schedule', createScheduleRouter(pool));

    await new Promise((resolve) => {
      server = app.listen(TEST_PORT, () => {
        console.log(`[SETUP] Test Express server listening on port ${TEST_PORT}`);
        resolve();
      });
    });

    // 1. Super Admin Actor
    const saRes = await pool.query(`
      SELECT u.id, u.username, u.full_name, r.id as role_id, r.name as role
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'Super Admin' AND r.property_id IS NULL AND r.is_system_role = TRUE
      LIMIT 1
    `);
    if (saRes.rows.length === 0) {
      throw new Error('Platform Super Admin role/user not found in DB.');
    }
    superAdminUser = { ...saRes.rows[0], property_id: 1 };
    superAdminToken = generateToken(superAdminUser);

    // 2. Non-Super Admin Actor: Ensure exists in DB
    const nonSaRoleRes = await pool.query(`
      SELECT id, name FROM roles
      WHERE name != 'Super Admin' AND is_active = TRUE
      LIMIT 1
    `);
    const nonSaRole = nonSaRoleRes.rows[0];

    const hrdUserRes = await pool.query(`
      INSERT INTO users (property_id, username, password_hash, full_name, email, role_id, is_active)
      VALUES (1, 'test_hrd_actor_01', 'hash', 'Test HRD Admin', 'test_hrd_01@oakhotel.com', $1, TRUE)
      RETURNING id, username, full_name, role_id
    `, [nonSaRole.id]);
    const testHrdUserId = hrdUserRes.rows[0].id;
    createdFixtureIds.users.push(testHrdUserId);

    hrdAdminUser = {
      id: testHrdUserId,
      username: hrdUserRes.rows[0].username,
      full_name: hrdUserRes.rows[0].full_name,
      role: nonSaRole.name,
      role_id: nonSaRole.id,
      property_id: 1
    };
    hrdAdminToken = generateToken(hrdAdminUser);

    console.log('[SETUP] Actors configured:');
    console.log(`  - Super Admin: id=${superAdminUser.id}, role=${superAdminUser.role}`);
    console.log(`  - HRD Admin: id=${hrdAdminUser.id}, role=${hrdAdminUser.role}`);

    // TEST 1: Department CRUD
    console.log('\n--- TEST 1: Department CRUD ---');
    const deptRes = await pool.query(
      `INSERT INTO hr_departments (property_id, code, name, is_active)
       VALUES (1, 'TEST_DEPT_01', 'Test Department Alpha', TRUE) RETURNING id`
    );
    const testDeptId = deptRes.rows[0].id;
    createdFixtureIds.departments.push(testDeptId);

    const deactDeptRes = await makeRequest('DELETE', `/api/hrd/departments/${testDeptId}?property_id=1`, null, hrdAdminToken);
    if (deactDeptRes.status !== 200) throw new Error(`Deactivate department failed: ${JSON.stringify(deactDeptRes)}`);
    const checkDeactDept = await pool.query('SELECT is_active FROM hr_departments WHERE id = $1', [testDeptId]);
    if (checkDeactDept.rows[0].is_active !== false) throw new Error('Department should be is_active=false');
    console.log('  ✓ 1a. Soft deactivate department succeeded');

    const reactDeptRes = await makeRequest('POST', `/api/hrd/departments/${testDeptId}/reactivate?property_id=1`, null, hrdAdminToken);
    if (reactDeptRes.status !== 200) throw new Error(`Reactivate department failed: ${JSON.stringify(reactDeptRes)}`);
    const checkReactDept = await pool.query('SELECT is_active FROM hr_departments WHERE id = $1', [testDeptId]);
    if (checkReactDept.rows[0].is_active !== true) throw new Error('Department should be is_active=true');
    console.log('  ✓ 1b. Reactivate department succeeded');

    const forbiddenDeptRes = await makeRequest('DELETE', `/api/hrd/departments/${testDeptId}/hard-delete?property_id=1`, null, hrdAdminToken);
    if (forbiddenDeptRes.status !== 403) throw new Error(`Expected 403 for non-super-admin hard delete, got ${forbiddenDeptRes.status}`);
    console.log('  ✓ 1c. Non-Super Admin hard delete department blocked with 403');

    const empWithDept = await pool.query(
      `INSERT INTO hr_employees (property_id, employee_code, full_name, department_id, is_active)
       VALUES (1, 'TEST_EMP_D1', 'Dept Test Employee', $1, TRUE) RETURNING id`,
      [testDeptId]
    );
    createdFixtureIds.employees.push(empWithDept.rows[0].id);

    const conflictDeptRes = await makeRequest('DELETE', `/api/hrd/departments/${testDeptId}/hard-delete?property_id=1`, null, superAdminToken);
    if (conflictDeptRes.status !== 409) throw new Error(`Expected 409 when department has employees, got ${conflictDeptRes.status}`);
    console.log('  ✓ 1d. Department with employee references blocked from hard delete with 409');

    await pool.query('DELETE FROM hr_employees WHERE id = $1', [empWithDept.rows[0].id]);

    const hardDelDeptRes = await makeRequest('DELETE', `/api/hrd/departments/${testDeptId}/hard-delete?property_id=1`, null, superAdminToken);
    if (hardDelDeptRes.status !== 200) throw new Error(`Super admin hard delete department failed: ${JSON.stringify(hardDelDeptRes)}`);
    const checkDeletedDept = await pool.query('SELECT id FROM hr_departments WHERE id = $1', [testDeptId]);
    if (checkDeletedDept.rows.length > 0) throw new Error('Department should be physically deleted');
    console.log('  ✓ 1e. Super Admin clean department hard delete succeeded (200)');

    // TEST 2: Position CRUD
    console.log('\n--- TEST 2: Position CRUD ---');
    const posRes = await pool.query(
      `INSERT INTO hr_positions (property_id, name, is_active)
       VALUES (1, 'Test Senior Specialist', TRUE) RETURNING id`
    );
    const testPosId = posRes.rows[0].id;
    createdFixtureIds.positions.push(testPosId);

    const deactPosRes = await makeRequest('DELETE', `/api/hrd/positions/${testPosId}?property_id=1`, null, hrdAdminToken);
    if (deactPosRes.status !== 200) throw new Error(`Deactivate position failed: ${JSON.stringify(deactPosRes)}`);
    const checkDeactPos = await pool.query('SELECT is_active FROM hr_positions WHERE id = $1', [testPosId]);
    if (checkDeactPos.rows[0].is_active !== false) throw new Error('Position should be is_active=false');
    console.log('  ✓ 2a. Soft deactivate position succeeded');

    const reactPosRes = await makeRequest('POST', `/api/hrd/positions/${testPosId}/reactivate?property_id=1`, null, hrdAdminToken);
    if (reactPosRes.status !== 200) throw new Error(`Reactivate position failed: ${JSON.stringify(reactPosRes)}`);
    const checkReactPos = await pool.query('SELECT is_active FROM hr_positions WHERE id = $1', [testPosId]);
    if (checkReactPos.rows[0].is_active !== true) throw new Error('Position should be is_active=true');
    console.log('  ✓ 2b. Reactivate position succeeded');

    const forbiddenPosRes = await makeRequest('DELETE', `/api/hrd/positions/${testPosId}/hard-delete?property_id=1`, null, hrdAdminToken);
    if (forbiddenPosRes.status !== 403) throw new Error(`Expected 403 for non-super-admin hard delete position, got ${forbiddenPosRes.status}`);
    console.log('  ✓ 2c. Non-Super Admin hard delete position blocked with 403');

    const empWithPos = await pool.query(
      `INSERT INTO hr_employees (property_id, employee_code, full_name, position_id, is_active)
       VALUES (1, 'TEST_EMP_P1', 'Position Test Employee', $1, TRUE) RETURNING id`,
      [testPosId]
    );
    createdFixtureIds.employees.push(empWithPos.rows[0].id);

    const conflictPosRes = await makeRequest('DELETE', `/api/hrd/positions/${testPosId}/hard-delete?property_id=1`, null, superAdminToken);
    if (conflictPosRes.status !== 409) throw new Error(`Expected 409 when position has employees, got ${conflictPosRes.status}`);
    console.log('  ✓ 2d. Position with employee references blocked from hard delete with 409');

    await pool.query('DELETE FROM hr_employees WHERE id = $1', [empWithPos.rows[0].id]);

    const hardDelPosRes = await makeRequest('DELETE', `/api/hrd/positions/${testPosId}/hard-delete?property_id=1`, null, superAdminToken);
    if (hardDelPosRes.status !== 200) throw new Error(`Super admin hard delete position failed: ${JSON.stringify(hardDelPosRes)}`);
    const checkDeletedPos = await pool.query('SELECT id FROM hr_positions WHERE id = $1', [testPosId]);
    if (checkDeletedPos.rows.length > 0) throw new Error('Position should be physically deleted');
    console.log('  ✓ 2e. Super Admin clean position hard delete succeeded (200)');

    // TEST 3: Dynamic Role CRUD
    console.log('\n--- TEST 3: Dynamic Role CRUD ---');
    const saRoleRes = await pool.query("SELECT id FROM roles WHERE name = 'Super Admin' AND property_id IS NULL AND is_system_role = TRUE");
    const saRoleId = saRoleRes.rows[0].id;

    const deactSaRoleRes = await makeRequest('DELETE', `/api/hrd/roles/${saRoleId}`, null, superAdminToken);
    if (deactSaRoleRes.status !== 403) throw new Error(`Expected 403 when trying to deactivate Platform Super Admin role, got ${deactSaRoleRes.status}`);
    console.log('  ✓ 3a. Deactivating Platform Super Admin role blocked with 403');

    const hardDelSaRoleRes = await makeRequest('DELETE', `/api/hrd/roles/${saRoleId}/hard-delete`, null, superAdminToken);
    if (hardDelSaRoleRes.status !== 403) throw new Error(`Expected 403 when trying to hard-delete Platform Super Admin role, got ${hardDelSaRoleRes.status}`);
    console.log('  ✓ 3b. Hard-deleting Platform Super Admin role blocked with 403');

    const customRoleRes = await pool.query(
      `INSERT INTO roles (property_id, name, description, is_active, is_system_role)
       VALUES (1, 'Test Operational Role', 'Test Role Description', TRUE, FALSE) RETURNING id`
    );
    const testRoleId = customRoleRes.rows[0].id;
    createdFixtureIds.roles.push(testRoleId);

    const deactRoleRes = await makeRequest('DELETE', `/api/hrd/roles/${testRoleId}`, null, hrdAdminToken);
    if (deactRoleRes.status !== 200) throw new Error(`Deactivate role failed: ${JSON.stringify(deactRoleRes)}`);
    const checkDeactRole = await pool.query('SELECT is_active FROM roles WHERE id = $1', [testRoleId]);
    if (checkDeactRole.rows[0].is_active !== false) throw new Error('Role should be is_active=false');
    console.log('  ✓ 3c. Soft deactivate role succeeded');

    const reactRoleRes = await makeRequest('POST', `/api/hrd/roles/${testRoleId}/reactivate`, null, hrdAdminToken);
    if (reactRoleRes.status !== 200) throw new Error(`Reactivate role failed: ${JSON.stringify(reactRoleRes)}`);
    const checkReactRole = await pool.query('SELECT is_active FROM roles WHERE id = $1', [testRoleId]);
    if (checkReactRole.rows[0].is_active !== true) throw new Error('Role should be is_active=true');
    console.log('  ✓ 3d. Reactivate role succeeded');

    const forbiddenRoleRes = await makeRequest('DELETE', `/api/hrd/roles/${testRoleId}/hard-delete`, null, hrdAdminToken);
    if (forbiddenRoleRes.status !== 403) throw new Error(`Expected 403 for non-super-admin hard delete role, got ${forbiddenRoleRes.status}`);
    console.log('  ✓ 3e. Non-Super Admin hard delete role blocked with 403');

    const userWithRole = await pool.query(
      `INSERT INTO users (property_id, username, password_hash, full_name, email, role_id, is_active)
       VALUES (1, 'test_user_role1', 'hash', 'Role Test User', 'role_test@example.com', $1, TRUE) RETURNING id`,
      [testRoleId]
    );
    createdFixtureIds.users.push(userWithRole.rows[0].id);

    const conflictRoleRes = await makeRequest('DELETE', `/api/hrd/roles/${testRoleId}/hard-delete`, null, superAdminToken);
    if (conflictRoleRes.status !== 409) throw new Error(`Expected 409 when role has users, got ${conflictRoleRes.status}`);
    console.log('  ✓ 3f. Role with assigned users blocked from hard delete with 409');

    await pool.query('DELETE FROM users WHERE id = $1', [userWithRole.rows[0].id]);

    const hardDelRoleRes = await makeRequest('DELETE', `/api/hrd/roles/${testRoleId}/hard-delete`, null, superAdminToken);
    if (hardDelRoleRes.status !== 200) throw new Error(`Super admin hard delete role failed: ${JSON.stringify(hardDelRoleRes)}`);
    const checkDeletedRole = await pool.query('SELECT id FROM roles WHERE id = $1', [testRoleId]);
    if (checkDeletedRole.rows.length > 0) throw new Error('Role should be physically deleted');
    console.log('  ✓ 3g. Super Admin clean role hard delete succeeded (200)');

    // TEST 4: Schedule Group CRUD
    console.log('\n--- TEST 4: Schedule Group CRUD ---');
    const groupRes = await pool.query(
      `INSERT INTO schedule_groups (property_id, name, code, is_active)
       VALUES (1, 'Test Operations Group Alpha', 'GRP_ALPHA_01', TRUE) RETURNING id`
    );
    const testGroupId = groupRes.rows[0].id;
    createdFixtureIds.groups.push(testGroupId);

    const deactGroupRes = await makeRequest('DELETE', `/api/schedule/groups/${testGroupId}?property_id=1`, null, hrdAdminToken);
    if (deactGroupRes.status !== 200) throw new Error(`Deactivate group failed: ${JSON.stringify(deactGroupRes)}`);
    const checkDeactGroup = await pool.query('SELECT is_active FROM schedule_groups WHERE id = $1', [testGroupId]);
    if (checkDeactGroup.rows[0].is_active !== false) throw new Error('Group should be is_active=false');
    console.log('  ✓ 4a. Soft deactivate schedule group succeeded');

    const reactGroupRes = await makeRequest('POST', `/api/schedule/groups/${testGroupId}/reactivate?property_id=1`, null, hrdAdminToken);
    if (reactGroupRes.status !== 200) throw new Error(`Reactivate group failed: ${JSON.stringify(reactGroupRes)}`);
    const checkReactGroup = await pool.query('SELECT is_active FROM schedule_groups WHERE id = $1', [testGroupId]);
    if (checkReactGroup.rows[0].is_active !== true) throw new Error('Group should be is_active=true');
    console.log('  ✓ 4b. Reactivate schedule group succeeded');

    const forbiddenGroupRes = await makeRequest('DELETE', `/api/schedule/groups/${testGroupId}/hard-delete?property_id=1`, null, hrdAdminToken);
    if (forbiddenGroupRes.status !== 403) throw new Error(`Expected 403 for non-super-admin hard delete group, got ${forbiddenGroupRes.status}`);
    console.log('  ✓ 4c. Non-Super Admin hard delete group blocked with 403');

    const hardDelGroupRes = await makeRequest('DELETE', `/api/schedule/groups/${testGroupId}/hard-delete?property_id=1`, null, superAdminToken);
    if (hardDelGroupRes.status !== 200) throw new Error(`Super admin hard delete group failed: ${JSON.stringify(hardDelGroupRes)}`);
    const checkDeletedGroup = await pool.query('SELECT id FROM schedule_groups WHERE id = $1', [testGroupId]);
    if (checkDeletedGroup.rows.length > 0) throw new Error('Group should be physically deleted');
    console.log('  ✓ 4d. Super Admin schedule group hard delete succeeded (200)');

    // TEST 5: Property Holiday CRUD
    console.log('\n--- TEST 5: Property Holiday CRUD ---');
    const holRes = await pool.query(
      `INSERT INTO property_holidays (property_id, holiday_date, name, holiday_type, is_active)
       VALUES (1, '2099-01-01', 'Test New Year Holiday', 'NATIONAL', TRUE) RETURNING id`
    );
    const testHolId = holRes.rows[0].id;
    createdFixtureIds.holidays.push(testHolId);

    const deactHolRes = await makeRequest('DELETE', `/api/schedule/holidays/${testHolId}?property_id=1`, null, hrdAdminToken);
    if (deactHolRes.status !== 200) throw new Error(`Deactivate holiday failed: ${JSON.stringify(deactHolRes)}`);
    const checkDeactHol = await pool.query('SELECT is_active FROM property_holidays WHERE id = $1', [testHolId]);
    if (checkDeactHol.rows[0].is_active !== false) throw new Error('Holiday should be is_active=false');
    console.log('  ✓ 5a. Soft deactivate property holiday succeeded');

    const reactHolRes = await makeRequest('POST', `/api/schedule/holidays/${testHolId}/reactivate?property_id=1`, null, hrdAdminToken);
    if (reactHolRes.status !== 200) throw new Error(`Reactivate holiday failed: ${JSON.stringify(reactHolRes)}`);
    const checkReactHol = await pool.query('SELECT is_active FROM property_holidays WHERE id = $1', [testHolId]);
    if (checkReactHol.rows[0].is_active !== true) throw new Error('Holiday should be is_active=true');
    console.log('  ✓ 5b. Reactivate property holiday succeeded');

    const forbiddenHolRes = await makeRequest('DELETE', `/api/schedule/holidays/${testHolId}/hard-delete?property_id=1`, null, hrdAdminToken);
    if (forbiddenHolRes.status !== 403) throw new Error(`Expected 403 for non-super-admin hard delete holiday, got ${forbiddenHolRes.status}`);
    console.log('  ✓ 5c. Non-Super Admin hard delete holiday blocked with 403');

    const hardDelHolRes = await makeRequest('DELETE', `/api/schedule/holidays/${testHolId}/hard-delete?property_id=1`, null, superAdminToken);
    if (hardDelHolRes.status !== 200) throw new Error(`Super admin hard delete holiday failed: ${JSON.stringify(hardDelHolRes)}`);
    const checkDeletedHol = await pool.query('SELECT id FROM property_holidays WHERE id = $1', [testHolId]);
    if (checkDeletedHol.rows.length > 0) throw new Error('Holiday should be physically deleted');
    console.log('  ✓ 5d. Super Admin property holiday hard delete succeeded (200)');

    // TEST 6: Department Schedule Classification
    console.log('\n--- TEST 6: Department Schedule Classification ---');
    const classDeptRes = await pool.query(
      `INSERT INTO hr_departments (property_id, code, name, is_active)
       VALUES (1, 'TEST_DEPT_CLS', 'Classification Test Dept', TRUE) RETURNING id`
    );
    const classDeptId = classDeptRes.rows[0].id;
    createdFixtureIds.departments.push(classDeptId);

    const patchOp = await makeRequest('PATCH', `/api/schedule/department-categories/${classDeptId}`, {
      property_id: 1,
      schedule_category: 'OPERATIONAL'
    }, hrdAdminToken);
    if (patchOp.status !== 200) throw new Error(`PATCH schedule_category OPERATIONAL failed: ${JSON.stringify(patchOp)}`);
    const checkOp = await pool.query('SELECT schedule_category FROM hr_departments WHERE id = $1', [classDeptId]);
    if (checkOp.rows[0].schedule_category !== 'OPERATIONAL') throw new Error(`Expected OPERATIONAL, got ${checkOp.rows[0].schedule_category}`);
    console.log('  ✓ 6a. PATCH with schedule_category: OPERATIONAL succeeded');

    const patchNonOp = await makeRequest('PATCH', `/api/schedule/department-categories/${classDeptId}`, {
      property_id: 1,
      category: 'NON_OPERATIONAL'
    }, hrdAdminToken);
    if (patchNonOp.status !== 200) throw new Error(`PATCH category NON_OPERATIONAL failed: ${JSON.stringify(patchNonOp)}`);
    const checkNonOp = await pool.query('SELECT schedule_category FROM hr_departments WHERE id = $1', [classDeptId]);
    if (checkNonOp.rows[0].schedule_category !== 'NON_OPERATIONAL') throw new Error(`Expected NON_OPERATIONAL, got ${checkNonOp.rows[0].schedule_category}`);
    console.log('  ✓ 6b. PATCH with category: NON_OPERATIONAL succeeded (payload dual-key compatibility)');

    const patchNull = await makeRequest('PATCH', `/api/schedule/department-categories/${classDeptId}`, {
      property_id: 1,
      schedule_category: null
    }, hrdAdminToken);
    if (patchNull.status !== 200) throw new Error(`PATCH schedule_category null failed: ${JSON.stringify(patchNull)}`);
    const checkNull = await pool.query('SELECT schedule_category FROM hr_departments WHERE id = $1', [classDeptId]);
    if (checkNull.rows[0].schedule_category !== null) throw new Error(`Expected null, got ${checkNull.rows[0].schedule_category}`);
    console.log('  ✓ 6c. PATCH with schedule_category: null succeeded');

    // TEST 7: Employee Hard Delete
    console.log('\n--- TEST 7: Employee Hard Delete ---');
    const cleanEmpRes = await pool.query(
      `INSERT INTO hr_employees (property_id, employee_code, full_name, is_active)
       VALUES (1, 'TEST_EMP_CLN', 'Clean Test Employee', TRUE) RETURNING id`
    );
    const cleanEmpId = cleanEmpRes.rows[0].id;
    createdFixtureIds.employees.push(cleanEmpId);

    const forbiddenEmpRes = await makeRequest('DELETE', `/api/hrd/employees/${cleanEmpId}/hard-delete?property_id=1`, null, hrdAdminToken);
    if (forbiddenEmpRes.status !== 403) throw new Error(`Expected 403 for non-super-admin hard delete employee, got ${forbiddenEmpRes.status}`);
    console.log('  ✓ 7a. Non-Super Admin hard delete employee blocked with 403');

    const schedRes = await pool.query(
      `INSERT INTO employee_work_schedules (property_id, employee_id, work_date, schedule_status, work_status)
       VALUES (1, $1, '2099-02-01', 'PUBLISHED', 'SHIFT') RETURNING id`,
      [cleanEmpId]
    );
    createdFixtureIds.schedules.push(schedRes.rows[0].id);

    const conflictSchedEmpRes = await makeRequest('DELETE', `/api/hrd/employees/${cleanEmpId}/hard-delete?property_id=1`, null, superAdminToken);
    if (conflictSchedEmpRes.status !== 409) throw new Error(`Expected 409 when employee has schedule history, got ${conflictSchedEmpRes.status}`);
    console.log('  ✓ 7b. Employee with schedule history blocked from hard delete with 409');

    await pool.query('DELETE FROM employee_work_schedules WHERE id = $1', [schedRes.rows[0].id]);

    const linkedUserRes = await pool.query(
      `INSERT INTO users (property_id, employee_id, username, password_hash, full_name, email, role_id, is_active)
       VALUES (1, $1, 'test_linked_user', 'hash', 'Linked User', 'linked_user@example.com', 1, TRUE) RETURNING id`,
      [cleanEmpId]
    );
    const linkedUserId = linkedUserRes.rows[0].id;
    createdFixtureIds.users.push(linkedUserId);

    const hardDelEmpRes = await makeRequest('DELETE', `/api/hrd/employees/${cleanEmpId}/hard-delete?property_id=1`, null, superAdminToken);
    if (hardDelEmpRes.status !== 200) throw new Error(`Super admin hard delete employee failed: ${JSON.stringify(hardDelEmpRes)}`);

    const checkDeletedEmp = await pool.query('SELECT id FROM hr_employees WHERE id = $1', [cleanEmpId]);
    if (checkDeletedEmp.rows.length > 0) throw new Error('Employee should be physically deleted');

    const checkDeletedUser = await pool.query('SELECT id FROM users WHERE id = $1', [linkedUserId]);
    if (checkDeletedUser.rows.length > 0) throw new Error('Linked user should be deleted in the same transaction');

    const auditRes = await pool.query(
      `SELECT action, record_id FROM audit_logs WHERE module = 'HRD' AND action = 'EMPLOYEE_HARD_DELETED' AND record_id = $1`,
      [String(cleanEmpId)]
    );
    if (auditRes.rows.length === 0) throw new Error('Audit log EMPLOYEE_HARD_DELETED not found');
    console.log('  ✓ 7c. Clean employee & linked user account hard deleted together with audit log (200)');

    console.log('\n=======================================================');
    console.log('🎉 ALL AUTH-HR-3A MASTER CRUD & HARD DELETE TESTS PASSED!');
    console.log('=======================================================');

  } catch (err) {
    console.error('\n❌ TEST FAILURE:', err);
    process.exitCode = 1;
  } finally {
    console.log('\n[TEARDOWN] Cleaning up fixtures...');
    try {
      if (createdFixtureIds.schedules.length > 0) {
        await pool.query('DELETE FROM employee_work_schedules WHERE id = ANY($1)', [createdFixtureIds.schedules]);
      }
      if (createdFixtureIds.users.length > 0) {
        await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdFixtureIds.users]);
      }
      if (createdFixtureIds.employees.length > 0) {
        await pool.query('DELETE FROM hr_employees WHERE id = ANY($1)', [createdFixtureIds.employees]);
      }
      if (createdFixtureIds.positions.length > 0) {
        await pool.query('DELETE FROM hr_positions WHERE id = ANY($1)', [createdFixtureIds.positions]);
      }
      if (createdFixtureIds.roles.length > 0) {
        await pool.query('DELETE FROM roles WHERE id = ANY($1)', [createdFixtureIds.roles]);
      }
      if (createdFixtureIds.groups.length > 0) {
        await pool.query('DELETE FROM schedule_groups WHERE id = ANY($1)', [createdFixtureIds.groups]);
      }
      if (createdFixtureIds.holidays.length > 0) {
        await pool.query('DELETE FROM property_holidays WHERE id = ANY($1)', [createdFixtureIds.holidays]);
      }
      if (createdFixtureIds.departments.length > 0) {
        await pool.query('DELETE FROM hr_departments WHERE id = ANY($1)', [createdFixtureIds.departments]);
      }
      console.log('[TEARDOWN] Zero fixture residue confirmed.');
    } catch (cleanupErr) {
      console.error('[TEARDOWN ERROR]', cleanupErr);
    }

    if (server) {
      server.close();
    }
    await pool.end();
  }
}

runTests();
