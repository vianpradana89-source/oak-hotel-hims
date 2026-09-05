const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const http = require('http');

const TEST_PORT = 3201;

function makeRequest(method, urlPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    if (token) options.headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTests() {
  console.log('=== TEST DATA PURGE — PLATFORM SUPER ADMIN SECURITY TEST ===\n');

  // Run-scoped unique suffix for ALL fixture identifiers
  const runId = `${Date.now()}_${process.pid}`;

  let server;
  const cleanupUserIds = [];
  const cleanupEmployeeIds = [];
  const cleanupRoleIds = [];

  try {
    const express = require('express');
    const app = express();
    app.use(express.json());

    const { createHrdRouter } = require('../dist/domains/hrd/hrdRouter');
    app.use('/api/hrd', createHrdRouter(pool));

    await new Promise(resolve => {
      server = app.listen(TEST_PORT, () => {
        console.log(`[SETUP] Test server on port ${TEST_PORT}`);
        resolve();
      });
    });

    // ─── SETUP: Platform Super Admin ───
    const saRes = await pool.query(`
      SELECT u.id, u.username, u.full_name, r.id as role_id, r.name as role
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'Super Admin' AND r.property_id IS NULL AND r.is_system_role = TRUE
      LIMIT 1
    `);
    if (saRes.rows.length === 0) throw new Error('Platform Super Admin not found in DB.');
    const superAdminUser = { ...saRes.rows[0], property_id: 1 };
    const superAdminToken = generateToken(superAdminUser);
    console.log(`[SETUP] Super Admin: id=${superAdminUser.id}`);

    // ─── SETUP: Non-SA roles ───
    const roleDefs = [
      { name: `TPURGE_GM_${runId}`, label: 'gm' },
      { name: `TPURGE_ADM_${runId}`, label: 'admin' },
      { name: `TPURGE_OWN_${runId}`, label: 'owner' },
      { name: `TPURGE_HRD_${runId}`, label: 'hrdAdmin' },
      { name: `TPURGE_MGR_${runId}`, label: 'manager' },
      { name: `TPURGE_STF_${runId}`, label: 'staff' },
    ];

    const tokens = {};
    for (const rd of roleDefs) {
      const roleRes = await pool.query(`
        INSERT INTO roles (property_id, name, description, is_active, is_system_role, is_test_data)
        VALUES (1, $1, 'Test', TRUE, FALSE, TRUE) RETURNING id, name
      `, [rd.name]);
      const roleId = roleRes.rows[0].id;
      cleanupRoleIds.push(roleId);

      const userRes = await pool.query(`
        INSERT INTO users (property_id, username, password_hash, full_name, email, role_id, is_active, is_test_data)
        VALUES (1, $1, 'hash', $2, $3, $4, TRUE, TRUE) RETURNING id, username, full_name
      `, [`tpurge_${rd.label}_${runId}`, `Test ${rd.label}`, `tpurge_${rd.label}_${runId}@test.local`, roleId]);
      const user = userRes.rows[0];
      cleanupUserIds.push(user.id);
      tokens[rd.label] = generateToken({
        id: user.id, username: user.username, full_name: user.full_name,
        role: rd.name, role_id: roleId, property_id: 1
      });
      console.log(`[SETUP] User ${rd.label}: id=${user.id}, role=${rd.name}`);
    }

    // Fake property-scoped Super Admin
    const fakeSaRoleName = `TPURGE_FAKE_SA_${runId}`;
    const fakeSaRoleRes = await pool.query(`
      INSERT INTO roles (property_id, name, description, is_active, is_system_role, is_test_data)
      VALUES (1, $1, 'Fake SA', TRUE, FALSE, TRUE) RETURNING id, name
    `, [fakeSaRoleName]);
    cleanupRoleIds.push(fakeSaRoleRes.rows[0].id);
    const fakeSaUserRes = await pool.query(`
      INSERT INTO users (property_id, username, password_hash, full_name, email, role_id, is_active, is_test_data)
      VALUES (1, $1, 'hash', 'Fake SA', $2, $3, TRUE, TRUE)
      RETURNING id, username, full_name
    `, [`tpurge_fake_sa_${runId}`, `tpurge_fake_sa_${runId}@test.local`, fakeSaRoleRes.rows[0].id]);
    cleanupUserIds.push(fakeSaUserRes.rows[0].id);
    tokens.fakeSa = generateToken({
      id: fakeSaUserRes.rows[0].id, username: fakeSaUserRes.rows[0].username,
      full_name: fakeSaUserRes.rows[0].full_name,
      role: fakeSaRoleName, role_id: fakeSaRoleRes.rows[0].id, property_id: 1
    });

    let testNum = 0;
    const pass = (msg) => { testNum++; console.log(`  ✓ ${testNum}. ${msg}`); };
    const fail = (msg) => { throw new Error(`FAIL: ${msg}`); };

    // ═══════════════════════════════════════════════
    // A. TEST DATA LIST ACCESS
    // ═══════════════════════════════════════════════
    console.log('\n--- A. TEST DATA LIST ACCESS ---');

    // A1. Super Admin can list test data
    {
      const res = await makeRequest('GET', '/api/hrd/test-data?property_id=1', null, superAdminToken);
      if (res.status !== 200) fail(`Expected 200, got ${res.status}`);
      if (res.body.status !== 'OK') fail(`Expected OK status, got ${res.body.status}`);
      if (!res.body.data || !Array.isArray(res.body.data.employees)) fail('Expected data.employees array');
      pass('Super Admin can list test data (200)');
    }

    // A2. Non-Super Admin gets 403
    for (const [label, token] of Object.entries(tokens)) {
      if (label === 'fakeSa') continue;
      const res = await makeRequest('GET', '/api/hrd/test-data?property_id=1', null, token);
      if (res.status !== 403) fail(`Expected 403 for ${label}, got ${res.status}`);
    }
    pass('Non-Super Admin roles all get 403 on list');

    // A3. Fake property SA gets 403
    {
      const res = await makeRequest('GET', '/api/hrd/test-data?property_id=1', null, tokens.fakeSa);
      if (res.status !== 403) fail(`Expected 403 for fake SA, got ${res.status}`);
      pass('Fake property-scoped "Super Admin" gets 403 on list');
    }

    // A4. Unauthenticated gets 401/403
    {
      const res = await makeRequest('GET', '/api/hrd/test-data?property_id=1');
      if (res.status !== 401 && res.status !== 403) fail(`Expected 401/403, got ${res.status}`);
      pass('Unauthenticated list returns 401/403');
    }

    // ═══════════════════════════════════════════════
    // B. TEST EMPLOYEE PURGE — SUCCESS
    // ═══════════════════════════════════════════════
    console.log('\n--- B. TEST EMPLOYEE PURGE — SUCCESS ---');

    // B5. TEST employee with TEST dependencies can be purged
    {
      const empRes = await pool.query(`
        INSERT INTO hr_employees (property_id, employee_code, full_name, is_active, is_test_data)
        VALUES (1, $1, 'Purge Test Employee B5', TRUE, TRUE) RETURNING id
      `, [`TPURGE_B5_${runId}`]);
      const empId = empRes.rows[0].id;
      cleanupEmployeeIds.push(empId);

      await pool.query(`
        INSERT INTO employee_work_schedules (property_id, employee_id, work_date, schedule_status, work_status, is_test_data)
        VALUES (1, $1, '2099-03-01', 'PUBLISHED', 'SHIFT', TRUE)
      `, [empId]);
      const userRes = await pool.query(`
        INSERT INTO users (property_id, employee_id, username, password_hash, full_name, email, role_id, is_active, is_test_data)
        VALUES (1, $1, $2, 'hash', 'Purge B5 User', $3, 1, TRUE, TRUE) RETURNING id
      `, [empId, `tpurge_b5_user_${runId}`, `tpurge_b5_${runId}@test.local`]);
      cleanupUserIds.push(userRes.rows[0].id);

      const res = await makeRequest('DELETE', `/api/hrd/test-data/employees/${empId}/purge?property_id=1`, {}, superAdminToken);
      if (res.status !== 200) fail(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      if (!res.body.data?.deleted?.hr_employees) fail('Expected hr_employees in deleted map');

      const checkEmp = await pool.query('SELECT id FROM hr_employees WHERE id = $1', [empId]);
      if (checkEmp.rows.length > 0) fail('Employee should be deleted');
      const checkUser = await pool.query('SELECT id FROM users WHERE employee_id = $1', [empId]);
      if (checkUser.rows.length > 0) fail('Linked user should be deleted');
      const checkSched = await pool.query('SELECT id FROM employee_work_schedules WHERE employee_id = $1', [empId]);
      if (checkSched.rows.length > 0) fail('Work schedule should be deleted');
      pass('TEST employee with TEST dependencies purged successfully');
    }

    // B6. TEST employee with face enrollment can be purged (if table exists)
    {
      const empRes = await pool.query(`
        INSERT INTO hr_employees (property_id, employee_code, full_name, is_active, is_test_data)
        VALUES (1, $1, 'Purge Test Employee B6', TRUE, TRUE) RETURNING id
      `, [`TPURGE_B6_${runId}`]);
      const empId = empRes.rows[0].id;
      cleanupEmployeeIds.push(empId);

      try {
        await pool.query(`
          INSERT INTO employee_face_enrollments (property_id, employee_id, status, is_test_data)
          VALUES (1, $1, 'PENDING', TRUE)
        `, [empId]);
      } catch {}

      const res = await makeRequest('DELETE', `/api/hrd/test-data/employees/${empId}/purge?property_id=1`, {}, superAdminToken);
      if (res.status !== 200) fail(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      const check = await pool.query('SELECT id FROM hr_employees WHERE id = $1', [empId]);
      if (check.rows.length > 0) fail('Employee should be deleted');
      pass('TEST employee with TEST face enrollment purged successfully');
    }

    // ═══════════════════════════════════════════════
    // C. NON-SUPER ADMIN PURGE — 403
    // ═══════════════════════════════════════════════
    console.log('\n--- C. NON-SUPER ADMIN PURGE — 403 ---');

    {
      const empRes = await pool.query(`
        INSERT INTO hr_employees (property_id, employee_code, full_name, is_active, is_test_data)
        VALUES (1, $1, 'Purge C1 Employee', TRUE, TRUE) RETURNING id
      `, [`TPURGE_C1_${runId}`]);
      const empId = empRes.rows[0].id;
      cleanupEmployeeIds.push(empId);

      for (const [label, token] of Object.entries(tokens)) {
        if (label === 'fakeSa') continue;
        const res = await makeRequest('DELETE', `/api/hrd/test-data/employees/${empId}/purge?property_id=1`, {}, token);
        if (res.status !== 403) fail(`Expected 403 for ${label}, got ${res.status}`);
      }
      pass('Non-Super Admin roles all get 403 on purge');
    }

    // C2. Fake property SA gets 403
    {
      const empRes = await pool.query(`
        INSERT INTO hr_employees (property_id, employee_code, full_name, is_active, is_test_data)
        VALUES (1, $1, 'Purge C2 Employee', TRUE, TRUE) RETURNING id
      `, [`TPURGE_C2_${runId}`]);
      const empId = empRes.rows[0].id;
      cleanupEmployeeIds.push(empId);

      const res = await makeRequest('DELETE', `/api/hrd/test-data/employees/${empId}/purge?property_id=1`, {}, tokens.fakeSa);
      if (res.status !== 403) fail(`Expected 403 for fake SA, got ${res.status}`);
      pass('Fake property-scoped "Super Admin" gets 403 on purge');
    }

    // ═══════════════════════════════════════════════
    // D. REAL DATA PROTECTION
    // ═══════════════════════════════════════════════
    console.log('\n--- D. REAL DATA PROTECTION ---');

    // D3. REAL employee (is_test_data=FALSE) returns 409
    {
      const empRes = await pool.query(`
        INSERT INTO hr_employees (property_id, employee_code, full_name, is_active, is_test_data)
        VALUES (1, $1, 'Real Employee D3', TRUE, FALSE) RETURNING id
      `, [`REAL_D3_${runId}`]);
      const empId = empRes.rows[0].id;

      const res = await makeRequest('DELETE', `/api/hrd/test-data/employees/${empId}/purge?property_id=1`, {}, superAdminToken);
      if (res.status !== 409) fail(`Expected 409 for real employee, got ${res.status}: ${JSON.stringify(res.body)}`);
      if (res.body.code !== 'NOT_TEST_DATA') fail(`Expected NOT_TEST_DATA code, got ${res.body.code}`);
      const check = await pool.query('SELECT id FROM hr_employees WHERE id = $1', [empId]);
      if (check.rows.length === 0) fail('Real employee should NOT be deleted');
      await pool.query('DELETE FROM hr_employees WHERE id = $1', [empId]);
      pass('REAL employee (is_test_data=FALSE) purge returns 409 NOT_TEST_DATA');
    }

    // D4. TEST employee with non-test dependency returns 409 + rollback
    {
      const empRes = await pool.query(`
        INSERT INTO hr_employees (property_id, employee_code, full_name, is_active, is_test_data)
        VALUES (1, $1, 'Purge D4 Employee', TRUE, TRUE) RETURNING id
      `, [`TPURGE_D4_${runId}`]);
      const empId = empRes.rows[0].id;

      const schedRes = await pool.query(`
        INSERT INTO employee_work_schedules (property_id, employee_id, work_date, schedule_status, work_status, is_test_data)
        VALUES (1, $1, '2099-04-01', 'PUBLISHED', 'SHIFT', FALSE) RETURNING id
      `, [empId]);

      const res = await makeRequest('DELETE', `/api/hrd/test-data/employees/${empId}/purge?property_id=1`, {}, superAdminToken);
      if (res.status !== 409) fail(`Expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
      if (res.body.code !== 'NON_TEST_DEPENDENCY') fail(`Expected NON_TEST_DEPENDENCY, got ${res.body.code}`);

      const checkEmp = await pool.query('SELECT id FROM hr_employees WHERE id = $1', [empId]);
      if (checkEmp.rows.length === 0) fail('Employee should NOT be deleted after rollback');
      const checkSched = await pool.query('SELECT id FROM employee_work_schedules WHERE id = $1', [schedRes.rows[0].id]);
      if (checkSched.rows.length === 0) fail('Non-test schedule should NOT be deleted after rollback');

      await pool.query('DELETE FROM employee_work_schedules WHERE id = $1', [schedRes.rows[0].id]);
      await pool.query('DELETE FROM hr_employees WHERE id = $1', [empId]);
      pass('TEST employee with non-test dependency returns 409 with rollback');
    }

    // ═══════════════════════════════════════════════
    // E. BODY IMPERSONATION TESTS
    // ═══════════════════════════════════════════════
    console.log('\n--- E. BODY IMPERSONATION TESTS ---');

    // E5. actor_id body field cannot elevate privilege
    {
      const empRes = await pool.query(`
        INSERT INTO hr_employees (property_id, employee_code, full_name, is_active, is_test_data)
        VALUES (1, $1, 'Purge E5 Employee', TRUE, TRUE) RETURNING id
      `, [`TPURGE_E5_${runId}`]);
      const empId = empRes.rows[0].id;
      cleanupEmployeeIds.push(empId);

      const res = await makeRequest('DELETE', `/api/hrd/test-data/employees/${empId}/purge?property_id=1`, {
        actor_id: superAdminUser.id
      }, tokens.gm);
      if (res.status !== 403) fail(`Expected 403, got ${res.status}`);
      pass('actor_id body field cannot elevate non-Super-Admin to purge');
    }

    // E6. actor_role body field cannot elevate privilege
    {
      const empRes = await pool.query(`
        INSERT INTO hr_employees (property_id, employee_code, full_name, is_active, is_test_data)
        VALUES (1, $1, 'Purge E6 Employee', TRUE, TRUE) RETURNING id
      `, [`TPURGE_E6_${runId}`]);
      const empId = empRes.rows[0].id;
      cleanupEmployeeIds.push(empId);

      const res = await makeRequest('DELETE', `/api/hrd/test-data/employees/${empId}/purge?property_id=1`, {
        actor_role: 'Super Admin'
      }, tokens.gm);
      if (res.status !== 403) fail(`Expected 403, got ${res.status}`);
      pass('actor_role body field cannot elevate non-Super-Admin to purge');
    }

    // ═══════════════════════════════════════════════
    // F. AUDIT LOG
    // ═══════════════════════════════════════════════
    console.log('\n--- F. AUDIT LOG ---');

    // F7. Audit record written for purge
    {
      const empRes = await pool.query(`
        INSERT INTO hr_employees (property_id, employee_code, full_name, is_active, is_test_data)
        VALUES (1, $1, 'Purge F7 Employee', TRUE, TRUE) RETURNING id
      `, [`TPURGE_F7_${runId}`]);
      const empId = empRes.rows[0].id;

      const res = await makeRequest('DELETE', `/api/hrd/test-data/employees/${empId}/purge?property_id=1`, {}, superAdminToken);
      if (res.status !== 200) fail(`Expected 200, got ${res.status}`);

      const auditRes = await pool.query(
        `SELECT * FROM audit_logs WHERE module = 'HRD' AND action = 'TEST_DATA_PURGED' AND record_id = $1`,
        [String(empId)]
      );
      if (auditRes.rows.length === 0) fail('Audit record TEST_DATA_PURGED not found');
      const audit = auditRes.rows[0];
      if (audit.property_id !== 1) fail('Audit should have property_id=1');
      const auditValue = typeof audit.new_value === 'string' ? JSON.parse(audit.new_value) : audit.new_value;
      if (!auditValue.deleted) fail('Audit should contain deleted dependency counts');
      pass('Audit record TEST_DATA_PURGED written with correct details');
    }

    // ═══════════════════════════════════════════════
    // G. EXISTING HARD DELETE NOT AFFECTED
    // ═══════════════════════════════════════════════
    console.log('\n--- G. EXISTING HARD DELETE NOT AFFECTED ---');

    // G8. Regular hard-delete still works for Super Admin on real data
    {
      const empRes = await pool.query(`
        INSERT INTO hr_employees (property_id, employee_code, full_name, is_active, is_test_data)
        VALUES (1, $1, 'Real Employee G8', TRUE, FALSE) RETURNING id
      `, [`REAL_G8_${runId}`]);
      const empId = empRes.rows[0].id;

      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/hard-delete?property_id=1`, {}, superAdminToken);
      if (res.status !== 200) fail(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      const check = await pool.query('SELECT id FROM hr_employees WHERE id = $1', [empId]);
      if (check.rows.length > 0) fail('Employee should be hard-deleted');
      pass('Regular hard-delete still works for real data');
    }

    // G9. Regular hard-delete still returns 403 for non-SA
    {
      const empRes = await pool.query(`
        INSERT INTO hr_employees (property_id, employee_code, full_name, is_active, is_test_data)
        VALUES (1, $1, 'Purge G9 Employee', TRUE, TRUE) RETURNING id
      `, [`TPURGE_G9_${runId}`]);
      const empId = empRes.rows[0].id;
      cleanupEmployeeIds.push(empId);

      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/hard-delete?property_id=1`, {}, tokens.gm);
      if (res.status !== 403) fail(`Expected 403 for GM on regular hard-delete, got ${res.status}`);
      pass('Regular hard-delete still returns 403 for non-Super-Admin');
    }

    console.log('\n=======================================================');
    console.log('🎉 ALL TEST DATA PURGE SECURITY TESTS PASSED!');
    console.log('=======================================================');

  } catch (err) {
    console.error('\n❌ TEST FAILURE:', err);
    process.exitCode = 1;
  } finally {
    console.log('\n[TEARDOWN] Cleaning up fixtures...');
    try {
      if (cleanupUserIds.length > 0) {
        await pool.query('DELETE FROM users WHERE id = ANY($1)', [cleanupUserIds]);
      }
      if (cleanupEmployeeIds.length > 0) {
        await pool.query('DELETE FROM hr_employees WHERE id = ANY($1)', [cleanupEmployeeIds]);
      }
      if (cleanupRoleIds.length > 0) {
        await pool.query('DELETE FROM roles WHERE id = ANY($1)', [cleanupRoleIds]);
      }
      console.log('[TEARDOWN] Zero fixture residue confirmed.');
    } catch (cleanupErr) {
      console.error('[TEARDOWN ERROR]', cleanupErr);
    }
    if (server) server.close();
    await pool.end();
  }
}

runTests();
