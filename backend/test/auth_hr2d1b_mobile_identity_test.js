require('dotenv').config();
const assert = require('assert');
const http = require('http');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');

const TEST_PREFIX = 'test_hr2d1b_';
const TEST_PROPERTY_ID = 1;
const UNLINKED_MESSAGE = 'Akun belum terhubung ke data karyawan.';

function makeRequest(server, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const payload = body !== null && body !== undefined ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: reqHeaders }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function tokenFor(user, roleName, extra = {}) {
  return generateToken({
    id: Number(user.id),
    username: user.username,
    email: user.email,
    full_name: extra.full_name || user.full_name || user.username,
    role: roleName,
    role_id: Number(user.role_id),
    property_id: Number(user.property_id),
    scope: 'FULL',
    account_status: extra.account_status || 'READY',
    access_type: extra.access_type || 'MOBILE_ONLY'
  });
}

async function cleanup(client) {
  const empRes = await client.query(
    `SELECT id FROM hr_employees WHERE employee_code LIKE $1 OR username LIKE $1 OR email LIKE $1`,
    [`${TEST_PREFIX}%`]
  );
  const empIds = empRes.rows.map((r) => r.id);
  if (empIds.length > 0) {
    await client.query(`DELETE FROM employee_attendance_records WHERE employee_id = ANY($1::int[])`, [empIds]);
    await client.query(`DELETE FROM employee_attendance WHERE employee_id = ANY($1::int[])`, [empIds]);
    await client.query(`DELETE FROM employee_face_enrollments WHERE employee_id = ANY($1::int[])`, [empIds]);
    await client.query(`DELETE FROM users WHERE employee_id = ANY($1::int[]) OR username LIKE $2`, [empIds, `${TEST_PREFIX}%`]);
    await client.query(`DELETE FROM hr_employees WHERE id = ANY($1::int[])`, [empIds]);
  }
  await client.query(`DELETE FROM users WHERE username LIKE $1`, [`${TEST_PREFIX}%`]);
  await client.query(`DELETE FROM hr_positions WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
  await client.query(`DELETE FROM hr_departments WHERE code LIKE $1 OR name LIKE $1`, [`${TEST_PREFIX}%`]);
}

async function runTests() {
  console.log('=== AUTH-HR-2D1B EMPLOYEE MOBILE IDENTITY CORRECTION ===\n');
  const { initializeDatabase } = require('../dist/db/schema_v3');
  await initializeDatabase(pool);

  const client = await pool.connect();
  let server;
  try {
    await cleanup(client);

    const hkRole = await client.query(
      `SELECT id FROM roles WHERE name = 'Housekeeping' AND is_system_role = TRUE AND property_id IS NULL LIMIT 1`
    );
    assert.ok(hkRole.rows[0]?.id, 'Housekeeping system role must exist');
    const housekeepingRoleId = hkRole.rows[0].id;

    const deptRes = await client.query(
      `INSERT INTO hr_departments (property_id, code, name, is_active, sort_order)
       VALUES ($1, $2, $3, TRUE, 99)
       RETURNING id, name`,
      [TEST_PROPERTY_ID, `${TEST_PREFIX}FO`, `${TEST_PREFIX}Front Office`]
    );
    const department = deptRes.rows[0];

    const posRes = await client.query(
      `INSERT INTO hr_positions (property_id, department_id, name, is_active, sort_order)
       VALUES ($1, $2, $3, TRUE, 99)
       RETURNING id, name`,
      [TEST_PROPERTY_ID, department.id, `${TEST_PREFIX}Receptionist`]
    );
    const position = posRes.rows[0];

    async function createEmployeeUser(tag, opts = {}) {
      const empRes = await client.query(
        `INSERT INTO hr_employees (
           property_id, employee_code, full_name, username, email, phone,
           department, position, department_id, position_id, is_active, status, hire_date
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '2026-09-01')
         RETURNING id, property_id, full_name, department_id, position_id`,
        [
          TEST_PROPERTY_ID,
          `${TEST_PREFIX}EMP_${tag}`,
          opts.employeeName || `Canonical ${tag}`,
          `${TEST_PREFIX}user_${tag}`,
          `${TEST_PREFIX}user_${tag}@oakhotel.test`,
          '081234567890',
          opts.legacyDepartment || 'Housekeeping',
          opts.legacyPosition || 'Housekeeping',
          opts.withRelations === false ? null : department.id,
          opts.withRelations === false ? null : position.id,
          opts.employeeActive !== false,
          opts.employeeStatus || 'ACTIVE'
        ]
      );
      const employee = empRes.rows[0];
      const userRes = await client.query(
        `INSERT INTO users (
           username, email, password_hash, role_id, property_id, employee_id,
           is_active, account_status, must_change_password, full_name, access_type
         ) VALUES ($1, $2, 'dummy_hash', $3, $4, $5, TRUE, 'READY', FALSE, $6, 'MOBILE_ONLY')
         RETURNING id, username, email, property_id, employee_id, role_id, full_name`,
        [
          `${TEST_PREFIX}user_${tag}`,
          `${TEST_PREFIX}user_${tag}@oakhotel.test`,
          housekeepingRoleId,
          TEST_PROPERTY_ID,
          employee.id,
          opts.userFullName || `Login Display ${tag}`
        ]
      );
      const user = userRes.rows[0];
      assert.notStrictEqual(Number(user.id), Number(employee.id), 'Fixture must have users.id != hr_employees.id');
      return {
        employee,
        user,
        token: tokenFor(user, 'Housekeeping', { full_name: user.full_name })
      };
    }

    const accA = await createEmployeeUser('a', { employeeName: 'Andi Pratama' });
    const accB = await createEmployeeUser('b', { employeeName: 'Budi Santoso' });
    const inactive = await createEmployeeUser('inactive', {
      employeeName: 'Inactive Crew',
      employeeActive: false,
      employeeStatus: 'INACTIVE'
    });

    const unlinkedUserRes = await client.query(
      `INSERT INTO users (
         username, email, password_hash, role_id, property_id, employee_id,
         is_active, account_status, must_change_password, full_name, access_type
       ) VALUES ($1, $2, 'dummy_hash', $3, $4, NULL, TRUE, 'READY', FALSE, $5, 'MOBILE_ONLY')
       RETURNING id, username, email, property_id, employee_id, role_id, full_name`,
      [
        `${TEST_PREFIX}user_unlinked`,
        `${TEST_PREFIX}user_unlinked@oakhotel.test`,
        housekeepingRoleId,
        TEST_PROPERTY_ID,
        'Siti Rahmawati'
      ]
    );
    const unlinkedUser = unlinkedUserRes.rows[0];
    const unlinkedToken = tokenFor(unlinkedUser, 'Housekeeping', { full_name: 'Siti Rahmawati' });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const authA = { Authorization: `Bearer ${accA.token}` };
    const authB = { Authorization: `Bearer ${accB.token}` };

    console.log('Test 1: /me returns linked employee identity, not users.id or login display name...');
    const meA = await makeRequest(server, 'GET', '/api/employee-mobile/me', authA);
    assert.strictEqual(meA.status, 200, `Expected 200, got ${meA.status}: ${JSON.stringify(meA.data)}`);
    assert.strictEqual(meA.data.status, 'OK');
    const identityA = meA.data.data;
    assert.strictEqual(Number(identityA.employeeId), Number(accA.employee.id));
    assert.notStrictEqual(Number(identityA.employeeId), Number(accA.user.id));
    assert.strictEqual(identityA.employeeName, 'Andi Pratama');
    assert.notStrictEqual(identityA.employeeName, accA.user.full_name);
    assert.notStrictEqual(identityA.employeeName, 'Siti Rahmawati');
    assert.strictEqual(Number(identityA.propertyId), TEST_PROPERTY_ID);
    console.log('✓ PASS: Test 1 (canonical linked employee, users.id is not employeeId).\n');

    console.log('Test 2: department and position come from canonical relations, not leftover Housekeeping varchar...');
    assert.strictEqual(Number(identityA.departmentId), Number(department.id));
    assert.strictEqual(identityA.departmentName, department.name);
    assert.strictEqual(Number(identityA.positionId), Number(position.id));
    assert.strictEqual(identityA.positionName, position.name);
    assert.notStrictEqual(identityA.departmentName, 'Housekeeping');
    assert.notStrictEqual(identityA.positionName, 'Housekeeping');
    console.log('✓ PASS: Test 2 (department/position from hr_departments / hr_positions).\n');

    console.log('Test 3: query/body employee_id cannot select another employee...');
    const spoofQuery = await makeRequest(
      server,
      'GET',
      `/api/employee-mobile/me?employee_id=${accB.employee.id}`,
      authA
    );
    assert.strictEqual(spoofQuery.status, 200);
    assert.strictEqual(Number(spoofQuery.data.data.employeeId), Number(accA.employee.id));
    assert.strictEqual(spoofQuery.data.data.employeeName, 'Andi Pratama');
    assert.notStrictEqual(Number(spoofQuery.data.data.employeeId), Number(accB.employee.id));

    const spoofBody = await makeRequest(
      server,
      'GET',
      '/api/employee-mobile/me',
      authA,
      { employee_id: accB.employee.id, employeeId: accB.employee.id }
    );
    assert.strictEqual(spoofBody.status, 200);
    assert.strictEqual(Number(spoofBody.data.data.employeeId), Number(accA.employee.id));
    assert.strictEqual(spoofBody.data.data.employeeName, 'Andi Pratama');
    console.log('✓ PASS: Test 3 (payload/query cannot impersonate another employee).\n');

    console.log('Test 4: missing employee link fails closed...');
    const unlinked = await makeRequest(server, 'GET', '/api/employee-mobile/me', {
      Authorization: `Bearer ${unlinkedToken}`
    });
    assert.strictEqual(unlinked.status, 400, `Expected 400, got ${unlinked.status}: ${JSON.stringify(unlinked.data)}`);
    assert.strictEqual(unlinked.data.code, 'NO_EMPLOYEE_LINK');
    assert.strictEqual(unlinked.data.message, UNLINKED_MESSAGE);
    assert.ok(!unlinked.data.data || !unlinked.data.data.employeeId, 'unlinked account must not receive employee identity');
    console.log('✓ PASS: Test 4 (missing link fails closed).\n');

    console.log('Test 5: inactive/broken employee link fails closed...');
    const inactiveMe = await makeRequest(server, 'GET', '/api/employee-mobile/me', {
      Authorization: `Bearer ${inactive.token}`
    });
    assert.strictEqual(inactiveMe.status, 400, `Expected 400, got ${inactiveMe.status}: ${JSON.stringify(inactiveMe.data)}`);
    assert.ok(['EMPLOYEE_DEACTIVATED', 'NO_EMPLOYEE_LINK'].includes(inactiveMe.data.code));
    assert.strictEqual(inactiveMe.data.message, UNLINKED_MESSAGE);
    console.log('✓ PASS: Test 5 (inactive employee fails closed).\n');

    console.log('Test 6: employee B sees only B identity...');
    const meB = await makeRequest(server, 'GET', '/api/employee-mobile/me', authB);
    assert.strictEqual(meB.status, 200);
    assert.strictEqual(Number(meB.data.data.employeeId), Number(accB.employee.id));
    assert.strictEqual(meB.data.data.employeeName, 'Budi Santoso');
    assert.notStrictEqual(meB.data.data.employeeName, 'Andi Pratama');
    assert.notStrictEqual(meB.data.data.employeeName, 'Siti Rahmawati');
    console.log('✓ PASS: Test 6 (displayed identity belongs to authenticated linked employee).\n');

    console.log('Test 7: unauthenticated /me is rejected...');
    const anon = await makeRequest(server, 'GET', '/api/employee-mobile/me');
    assert.strictEqual(anon.status, 401);
    console.log('✓ PASS: Test 7 (unauthenticated rejected).\n');

    console.log('=============================================');
    console.log('ALL AUTH-HR-2D1B MOBILE IDENTITY TESTS PASSED');
    console.log('=============================================\n');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      await cleanup(client);
    } catch (cleanErr) {
      console.error('Cleanup error:', cleanErr);
    }
    client.release();
  }
}

runTests()
  .then(() => {
    pool.end();
    process.exit(0);
  })
  .catch((err) => {
    console.error('TEST FAILED:', err);
    pool.end().finally(() => process.exit(1));
  });
