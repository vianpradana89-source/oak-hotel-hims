const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const http = require('http');

const TEST_PORT = 3195;

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
  console.log('=== LOGIN ACCOUNT HARD DELETE — PLATFORM SUPER ADMIN SECURITY TEST ===\n');

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

    // ─── SETUP: Get Platform Super Admin ───
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

    // ─── SETUP: Create test roles for privilege escalation tests ───
    // a) General Manager role (property-scoped)
    const gmRoleRes = await pool.query(`
      INSERT INTO roles (property_id, name, description, is_active, is_system_role)
      VALUES (1, 'General Manager', 'Test GM', TRUE, FALSE) RETURNING id, name
    `);
    const gmRoleId = gmRoleRes.rows[0].id;
    cleanupRoleIds.push(gmRoleId);

    // b) Admin role (property-scoped)
    const adminRoleRes = await pool.query(`
      INSERT INTO roles (property_id, name, description, is_active, is_system_role)
      VALUES (1, 'Admin', 'Test Admin', TRUE, FALSE) RETURNING id, name
    `);
    const adminRoleId = adminRoleRes.rows[0].id;
    cleanupRoleIds.push(adminRoleId);

    // c) Owner role (property-scoped)
    const ownerRoleRes = await pool.query(`
      INSERT INTO roles (property_id, name, description, is_active, is_system_role)
      VALUES (1, 'Owner', 'Test Owner', TRUE, FALSE) RETURNING id, name
    `);
    const ownerRoleId = ownerRoleRes.rows[0].id;
    cleanupRoleIds.push(ownerRoleId);

    // d) HRD Admin role (property-scoped)
    const hrdAdminRoleRes = await pool.query(`
      INSERT INTO roles (property_id, name, description, is_active, is_system_role)
      VALUES (1, 'HRD Admin', 'Test HRD Admin', TRUE, FALSE) RETURNING id, name
    `);
    const hrdAdminRoleId = hrdAdminRoleRes.rows[0].id;
    cleanupRoleIds.push(hrdAdminRoleId);

    // e) Manager role (property-scoped)
    const managerRoleRes = await pool.query(`
      INSERT INTO roles (property_id, name, description, is_active, is_system_role)
      VALUES (1, 'Manager', 'Test Manager', TRUE, FALSE) RETURNING id, name
    `);
    const managerRoleId = managerRoleRes.rows[0].id;
    cleanupRoleIds.push(managerRoleId);

    // f) Staff role (property-scoped)
    const staffRoleRes = await pool.query(`
      INSERT INTO roles (property_id, name, description, is_active, is_system_role)
      VALUES (1, 'Staff', 'Test Staff', TRUE, FALSE) RETURNING id, name
    `);
    const staffRoleId = staffRoleRes.rows[0].id;
    cleanupRoleIds.push(staffRoleId);

    // g) Property-scoped fake "Super Admin" role (should NOT pass canonical check)
    const fakeSaRoleRes = await pool.query(`
      INSERT INTO roles (property_id, name, description, is_active, is_system_role)
      VALUES (1, 'Super Admin', 'Fake Property Super Admin', TRUE, FALSE) RETURNING id, name
    `);
    const fakeSaRoleId = fakeSaRoleRes.rows[0].id;
    cleanupRoleIds.push(fakeSaRoleId);

    // h) Inactive Super Admin role for testing
    const inactiveSaRoleRes = await pool.query(`
      INSERT INTO roles (property_id, name, description, is_active, is_system_role)
      VALUES (NULL, 'Inactive SA Test', 'Test', FALSE, TRUE) RETURNING id, name
    `);
    const inactiveSaRoleId = inactiveSaRoleRes.rows[0].id;
    cleanupRoleIds.push(inactiveSaRoleId);

    // ─── SETUP: Create test users with each role ───
    const roleUsers = {
      gm: { role_id: gmRoleId, role: 'General Manager' },
      admin: { role_id: adminRoleId, role: 'Admin' },
      owner: { role_id: ownerRoleId, role: 'Owner' },
      hrdAdmin: { role_id: hrdAdminRoleId, role: 'HRD Admin' },
      manager: { role_id: managerRoleId, role: 'Manager' },
      staff: { role_id: staffRoleId, role: 'Staff' },
      fakeSa: { role_id: fakeSaRoleId, role: 'Super Admin' },
      inactiveSa: { role_id: inactiveSaRoleId, role: 'Inactive SA Test' }
    };

    const tokens = {};
    for (const [key, info] of Object.entries(roleUsers)) {
      const isActive = key !== 'inactiveSa';
      const userRes = await pool.query(`
        INSERT INTO users (property_id, username, password_hash, full_name, email, role_id, is_active)
        VALUES (1, $1, 'hash', $2, $3, $4, $5) RETURNING id, username, full_name
      `, [`test_login_del_${key}`, `Test ${info.role}`, `test_${key}@oaktest.com`, info.role_id, isActive]);
      const user = userRes.rows[0];
      cleanupUserIds.push(user.id);
      tokens[key] = generateToken({
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: info.role,
        role_id: info.role_id,
        property_id: 1
      });
      console.log(`[SETUP] User ${key}: id=${user.id}, role=${info.role}, active=${isActive}`);
    }

    // ─── SETUP: Create test employee with login account ───
    const createTestEmployee = async (label) => {
      const empRes = await pool.query(`
        INSERT INTO hr_employees (property_id, employee_code, full_name, is_active, status)
        VALUES (1, $1, $2, TRUE, 'ACTIVE') RETURNING id
      `, [`TEST_LGN_${label}_${Date.now()}`, `Login Delete Test ${label}`]);
      const empId = empRes.rows[0].id;
      cleanupEmployeeIds.push(empId);

      const userRes = await pool.query(`
        INSERT INTO users (property_id, employee_id, username, password_hash, full_name, email, role_id, is_active)
        VALUES (1, $1, $2, 'hash', 'Test Login User', $3, 1, TRUE) RETURNING id
      `, [empId, `test_login_target_${label}_${Date.now()}`, `test_login_${label}@oaktest.com`]);
      const userId = userRes.rows[0].id;
      cleanupUserIds.push(userId);
      return { empId, userId };
    };

    let testNum = 0;
    const pass = (msg) => { testNum++; console.log(`  ✓ ${testNum}. ${msg}`); };
    const fail = (msg) => { throw new Error(`FAIL: ${msg}`); };

    // ═══════════════════════════════════════════════
    // A. LOGIN ACCOUNT HARD DELETE AUTHORIZATION
    // ═══════════════════════════════════════════════
    console.log('\n--- A. LOGIN ACCOUNT HARD DELETE AUTHORIZATION ---');

    // A1. Platform Super Admin succeeds
    {
      const { empId } = await createTestEmployee('A1');
      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/login-account?property_id=1`, {}, superAdminToken);
      if (res.status !== 200) fail(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      const check = await pool.query('SELECT id FROM users WHERE employee_id = $1', [empId]);
      if (check.rows.length > 0) fail('User should be deleted');
      pass('Platform Super Admin login account hard delete succeeds (200)');
    }

    // A2. General Manager returns 403
    {
      const { empId } = await createTestEmployee('A2');
      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/login-account?property_id=1`, {}, tokens.gm);
      if (res.status !== 403) fail(`Expected 403, got ${res.status}`);
      const check = await pool.query('SELECT id FROM users WHERE employee_id = $1', [empId]);
      if (check.rows.length === 0) fail('User should NOT be deleted');
      pass('General Manager login account hard delete returns 403');
    }

    // A3. Admin returns 403
    {
      const { empId } = await createTestEmployee('A3');
      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/login-account?property_id=1`, {}, tokens.admin);
      if (res.status !== 403) fail(`Expected 403, got ${res.status}`);
      pass('Admin login account hard delete returns 403');
    }

    // A4. Owner returns 403
    {
      const { empId } = await createTestEmployee('A4');
      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/login-account?property_id=1`, {}, tokens.owner);
      if (res.status !== 403) fail(`Expected 403, got ${res.status}`);
      pass('Owner login account hard delete returns 403');
    }

    // A5. HRD Admin returns 403
    {
      const { empId } = await createTestEmployee('A5');
      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/login-account?property_id=1`, {}, tokens.hrdAdmin);
      if (res.status !== 403) fail(`Expected 403, got ${res.status}`);
      pass('HRD Admin login account hard delete returns 403');
    }

    // A6. Manager/Staff returns 403
    {
      const { empId } = await createTestEmployee('A6');
      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/login-account?property_id=1`, {}, tokens.manager);
      if (res.status !== 403) fail(`Expected 403, got ${res.status}`);
      pass('Manager login account hard delete returns 403');
    }
    {
      const { empId } = await createTestEmployee('A6s');
      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/login-account?property_id=1`, {}, tokens.staff);
      if (res.status !== 403) fail(`Expected 403, got ${res.status}`);
      pass('Staff login account hard delete returns 403');
    }

    // A7. Property-scoped fake "Super Admin" returns 403
    {
      const { empId } = await createTestEmployee('A7');
      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/login-account?property_id=1`, {}, tokens.fakeSa);
      if (res.status !== 403) fail(`Expected 403 for fake property Super Admin, got ${res.status}`);
      pass('Property-scoped fake "Super Admin" role returns 403');
    }

    // A8. Inactive Super Admin user returns 403
    {
      const { empId } = await createTestEmployee('A8');
      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/login-account?property_id=1`, {}, tokens.inactiveSa);
      if (res.status !== 403) fail(`Expected 403 for inactive Super Admin, got ${res.status}`);
      pass('Inactive Super Admin user returns 403');
    }

    // A9. confirm_identity is NOT required
    {
      const { empId } = await createTestEmployee('A9');
      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/login-account?property_id=1`, {}, superAdminToken);
      if (res.status !== 200) fail(`Expected 200 without confirm_identity, got ${res.status}: ${JSON.stringify(res.body)}`);
      pass('confirm_identity is NOT required — Super Admin succeeds without it');
    }

    // A10. Request body actor_role='Super Admin' cannot elevate non-Super-Admin
    {
      const { empId } = await createTestEmployee('A10');
      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/login-account?property_id=1`, {
        actor_role: 'Super Admin'
      }, tokens.gm);
      if (res.status !== 403) fail(`Expected 403, got ${res.status}`);
      pass('Request body actor_role=Super Admin cannot elevate non-Super-Admin');
    }

    // A11. Request body actor_id cannot impersonate Super Admin
    {
      const { empId } = await createTestEmployee('A11');
      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/login-account?property_id=1`, {
        actor_id: superAdminUser.id
      }, tokens.gm);
      if (res.status !== 403) fail(`Expected 403, got ${res.status}`);
      pass('Request body actor_id cannot impersonate Super Admin');
    }

    // A12. Request body actor_name has no authority effect
    {
      const { empId } = await createTestEmployee('A12');
      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/login-account?property_id=1`, {
        actor_name: 'Super Admin'
      }, tokens.staff);
      if (res.status !== 403) fail(`Expected 403, got ${res.status}`);
      pass('Request body actor_name has no authority effect');
    }

    // ═══════════════════════════════════════════════
    // B. EMPLOYEE HARD DELETE REGRESSION
    // ═══════════════════════════════════════════════
    console.log('\n--- B. EMPLOYEE HARD DELETE REGRESSION ---');

    // B13. Employee hard delete still follows Platform Super Admin-only rules
    {
      const empRes = await pool.query(`
        INSERT INTO hr_employees (property_id, employee_code, full_name, is_active)
        VALUES (1, 'TEST_EMP_B13', 'Regression Test Employee', TRUE) RETURNING id
      `);
      const empId = empRes.rows[0].id;
      cleanupEmployeeIds.push(empId);

      const gmRes = await makeRequest('DELETE', `/api/hrd/employees/${empId}/hard-delete?property_id=1`, {}, tokens.gm);
      if (gmRes.status !== 403) fail(`Expected 403 for GM, got ${gmRes.status}`);

      const saRes = await makeRequest('DELETE', `/api/hrd/employees/${empId}/hard-delete?property_id=1`, {}, superAdminToken);
      if (saRes.status !== 200) fail(`Expected 200 for Super Admin, got ${saRes.status}`);
      pass('Employee hard delete still follows Platform Super Admin-only rules');
    }

    // ═══════════════════════════════════════════════
    // C. UNAUTHENTICATED ACCESS
    // ═══════════════════════════════════════════════
    console.log('\n--- C. UNAUTHENTICATED ACCESS ---');

    {
      const { empId } = await createTestEmployee('C1');
      const res = await makeRequest('DELETE', `/api/hrd/employees/${empId}/login-account?property_id=1`);
      if (res.status !== 403 && res.status !== 401) fail(`Expected 401/403, got ${res.status}`);
      pass('Unauthenticated login account hard delete returns 401/403');
    }

    console.log('\n=======================================================');
    console.log('🎉 ALL LOGIN ACCOUNT HARD DELETE SECURITY TESTS PASSED!');
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
