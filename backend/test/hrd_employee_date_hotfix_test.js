// backend/test/hrd_employee_date_hotfix_test.js
require('dotenv').config();
const assert = require('assert');
const http = require('http');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');

const TEST_PREFIX = 'test_date_hotfix_';
const TEST_PROPERTY_ID = 1;

function makeRequest(server, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const payload = body !== null && body !== undefined ? JSON.stringify(body) : null;
    const reqHeaders = {
      ...headers
    };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: reqHeaders
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            resolve({ status: res.statusCode, data: json });
          } catch (e) {
            resolve({ status: res.statusCode, raw });
          }
        });
      }
    );

    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function cleanupTestData(client) {
  await client.query("DELETE FROM audit_logs WHERE correlation_id LIKE $1", [`%${TEST_PREFIX}%`]);
  await client.query("DELETE FROM users WHERE email LIKE $1 OR username LIKE $1", [`%${TEST_PREFIX}%`]);
  await client.query("DELETE FROM hr_employees WHERE email LIKE $1 OR username LIKE $1 OR employee_code LIKE $1", [`%${TEST_PREFIX}%`]);
}

async function runTests() {
  console.log('=== HRD EMPLOYEE EDIT DATE HOTFIX INTEGRATION TEST ===\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  const client = await pool.connect();
  let passed = 0;
  let failed = 0;

  try {
    await cleanupTestData(client);

    // Create HRD Admin token for auth
    const hrdToken = generateToken({
      userId: 9991,
      email: `${TEST_PREFIX}admin@oak.com`,
      role: 'HRD',
      propertyId: TEST_PROPERTY_ID
    });
    const authHeaders = {
      Authorization: `Bearer ${hrdToken}`
    };

    // ------------------------------------------------------------------------
    // SETUP: Create base employee with initial hire_date = 2025-06-15
    // ------------------------------------------------------------------------
    console.log('[Setup] Creating test employee with hire_date 2025-06-15...');
    const createRes = await makeRequest(server, 'POST', '/api/hrd/employees', authHeaders, {
      property_id: TEST_PROPERTY_ID,
      employee_code: `${TEST_PREFIX}EMP01`,
      full_name: 'Budi Santoso Hotfix Test',
      position: 'Staff Front Desk',
      department: 'Front Office',
      role: 'Front Office',
      username: `${TEST_PREFIX}budi`,
      email: `${TEST_PREFIX}budi@oak.com`,
      phone: '081234567890',
      hire_date: '2025-06-15',
      create_login_account: false
    });

    assert.strictEqual(createRes.status, 201, `Create failed: ${JSON.stringify(createRes.data)}`);
    const empId = createRes.data.data.id;
    assert(empId > 0, 'Invalid employee id');
    assert.strictEqual(createRes.data.data.hire_date, '2025-06-15', 'hire_date formatted as YYYY-MM-DD on create');
    console.log(`  ✓ Employee created with ID ${empId}, hire_date: ${createRes.data.data.hire_date}`);

    // Verify in database directly
    const dbCheck1 = await client.query(
      "SELECT to_char(hire_date, 'YYYY-MM-DD') AS hire_date_formatted FROM hr_employees WHERE id = $1",
      [empId]
    );
    assert.strictEqual(dbCheck1.rows[0].hire_date_formatted, '2025-06-15', 'Database persisted exact YYYY-MM-DD');

    // ------------------------------------------------------------------------
    // TEST A: Edit employee without changing any date -> succeeds
    // ------------------------------------------------------------------------
    console.log('\n[Test A] Edit employee without changing any date (omit hire_date)...');
    const testARes = await makeRequest(server, 'PATCH', `/api/hrd/employees/${empId}`, authHeaders, {
      property_id: TEST_PROPERTY_ID,
      full_name: 'Budi Santoso Hotfix Edited Name',
      position: 'Senior Receptionist'
    });
    assert.strictEqual(testARes.status, 200, `Test A failed: ${JSON.stringify(testARes.data)}`);
    assert.strictEqual(testARes.data.data.hire_date, '2025-06-15', 'hire_date remains intact as 2025-06-15');
    assert.strictEqual(testARes.data.data.position, 'Senior Receptionist');
    console.log('  ✓ Test A PASSED: Employee edited without changing date, hire_date intact.');
    passed++;

    // ------------------------------------------------------------------------
    // TEST B: Edit employee with hire_date = '2026-09-01' -> database persists exactly 2026-09-01
    // ------------------------------------------------------------------------
    console.log('\n[Test B] Edit employee with hire_date = 2026-09-01...');
    const testBRes = await makeRequest(server, 'PATCH', `/api/hrd/employees/${empId}`, authHeaders, {
      property_id: TEST_PROPERTY_ID,
      hire_date: '2026-09-01'
    });
    assert.strictEqual(testBRes.status, 200, `Test B failed: ${JSON.stringify(testBRes.data)}`);
    assert.strictEqual(testBRes.data.data.hire_date, '2026-09-01', 'API response returns exactly 2026-09-01');

    const dbCheckB = await client.query(
      "SELECT to_char(hire_date, 'YYYY-MM-DD') AS hire_date_formatted FROM hr_employees WHERE id = $1",
      [empId]
    );
    assert.strictEqual(dbCheckB.rows[0].hire_date_formatted, '2026-09-01', 'Database persisted exact 2026-09-01');
    console.log('  ✓ Test B PASSED: hire_date = 2026-09-01 persisted exactly.');
    passed++;

    // ------------------------------------------------------------------------
    // TEST C: Empty optional date (null, empty string) -> succeeds safely
    // ------------------------------------------------------------------------
    console.log('\n[Test C1] Edit employee with hire_date = null...');
    const testC1Res = await makeRequest(server, 'PATCH', `/api/hrd/employees/${empId}`, authHeaders, {
      property_id: TEST_PROPERTY_ID,
      hire_date: null
    });
    assert.strictEqual(testC1Res.status, 200, `Test C1 failed: ${JSON.stringify(testC1Res.data)}`);
    assert.strictEqual(testC1Res.data.data.hire_date, null, 'API response returns null');

    const dbCheckC1 = await client.query(
      "SELECT hire_date FROM hr_employees WHERE id = $1",
      [empId]
    );
    assert.strictEqual(dbCheckC1.rows[0].hire_date, null, 'Database column set to NULL');

    console.log('[Test C2] Edit employee with hire_date = "" (empty string normalized to null)...');
    const testC2Res = await makeRequest(server, 'PATCH', `/api/hrd/employees/${empId}`, authHeaders, {
      property_id: TEST_PROPERTY_ID,
      hire_date: ''
    });
    assert.strictEqual(testC2Res.status, 200, `Test C2 failed: ${JSON.stringify(testC2Res.data)}`);
    assert.strictEqual(testC2Res.data.data.hire_date, null, 'Empty string normalized to null');
    console.log('  ✓ Test C PASSED: Optional empty date handled safely.');
    passed++;

    // ------------------------------------------------------------------------
    // TEST D: Invalid date input -> controlled 400 response. No raw PostgreSQL error.
    // ------------------------------------------------------------------------
    console.log('\n[Test D1] Invalid date string: "Tue Sep 01" (original bug payload)...');
    const testD1Res = await makeRequest(server, 'PATCH', `/api/hrd/employees/${empId}`, authHeaders, {
      property_id: TEST_PROPERTY_ID,
      hire_date: 'Tue Sep 01'
    });
    assert.strictEqual(testD1Res.status, 400, 'Must return HTTP 400');
    assert.strictEqual(testD1Res.data.status, 'ERROR');
    assert.strictEqual(testD1Res.data.code, 'INVALID_DATE_FORMAT');
    assert(!testD1Res.data.message.includes('syntax error'), 'Must not leak raw PostgreSQL syntax error');
    assert(!testD1Res.data.message.includes('pg'), 'Must not leak database driver details');

    console.log('[Test D2] Non-existent calendar date: "2026-02-31"...');
    const testD2Res = await makeRequest(server, 'PATCH', `/api/hrd/employees/${empId}`, authHeaders, {
      property_id: TEST_PROPERTY_ID,
      hire_date: '2026-02-31'
    });
    assert.strictEqual(testD2Res.status, 400, 'Must return HTTP 400');
    assert.strictEqual(testD2Res.data.status, 'ERROR');
    assert.strictEqual(testD2Res.data.code, 'INVALID_CALENDAR_DATE');

    console.log('[Test D3] Date.toString() full string...');
    const testD3Res = await makeRequest(server, 'PATCH', `/api/hrd/employees/${empId}`, authHeaders, {
      property_id: TEST_PROPERTY_ID,
      hire_date: 'Tue Sep 01 2026 00:00:00 GMT+0700'
    });
    assert.strictEqual(testD3Res.status, 400, 'Must return HTTP 400');
    assert.strictEqual(testD3Res.data.code, 'INVALID_DATE_FORMAT');
    console.log('  ✓ Test D PASSED: Controlled HTTP 400 returned, zero raw PostgreSQL leak.');
    passed++;

    // ------------------------------------------------------------------------
    // TEST E: Existing employee dates remain unchanged when unrelated fields are edited
    // ------------------------------------------------------------------------
    console.log('\n[Test E] Restore hire_date to 2024-03-10, then update unrelated fields...');
    await makeRequest(server, 'PATCH', `/api/hrd/employees/${empId}`, authHeaders, {
      property_id: TEST_PROPERTY_ID,
      hire_date: '2024-03-10'
    });

    // Update phone and position only
    const testERes = await makeRequest(server, 'PATCH', `/api/hrd/employees/${empId}`, authHeaders, {
      property_id: TEST_PROPERTY_ID,
      phone: '089999888777',
      position: 'Night Auditor'
    });
    assert.strictEqual(testERes.status, 200);
    assert.strictEqual(testERes.data.data.hire_date, '2024-03-10', 'hire_date remains exactly 2024-03-10');

    const dbCheckE = await client.query(
      "SELECT to_char(hire_date, 'YYYY-MM-DD') AS hire_date_formatted FROM hr_employees WHERE id = $1",
      [empId]
    );
    assert.strictEqual(dbCheckE.rows[0].hire_date_formatted, '2024-03-10');
    console.log('  ✓ Test E PASSED: Date preserved when updating unrelated fields.');
    passed++;

    // ------------------------------------------------------------------------
    // TEST F: Employee creation date serialization also uses YYYY-MM-DD
    // ------------------------------------------------------------------------
    console.log('\n[Test F] Create employee with valid YYYY-MM-DD hire_date...');
    const testFRes = await makeRequest(server, 'POST', '/api/hrd/employees', authHeaders, {
      property_id: TEST_PROPERTY_ID,
      employee_code: `${TEST_PREFIX}EMP02`,
      full_name: 'Dewi Lestari Hotfix Test',
      position: 'Housekeeping',
      department: 'Housekeeping',
      role: 'Housekeeping',
      username: `${TEST_PREFIX}dewi`,
      email: `${TEST_PREFIX}dewi@oak.com`,
      hire_date: '2026-01-15',
      create_login_account: false
    });
    assert.strictEqual(testFRes.status, 201);
    assert.strictEqual(testFRes.data.data.hire_date, '2026-01-15');

    const dbCheckF = await client.query(
      "SELECT to_char(hire_date, 'YYYY-MM-DD') AS hire_date_formatted FROM hr_employees WHERE id = $1",
      [testFRes.data.data.id]
    );
    assert.strictEqual(dbCheckF.rows[0].hire_date_formatted, '2026-01-15');

    console.log('[Test F2] Create employee with invalid hire_date returns 400...');
    const testF2Res = await makeRequest(server, 'POST', '/api/hrd/employees', authHeaders, {
      property_id: TEST_PROPERTY_ID,
      employee_code: `${TEST_PREFIX}EMP03`,
      full_name: 'Invalid Date Employee',
      role: 'Front Office',
      username: `${TEST_PREFIX}invalid`,
      email: `${TEST_PREFIX}invalid@oak.com`,
      hire_date: 'Wed Oct 15',
      create_login_account: false
    });
    assert.strictEqual(testF2Res.status, 400);
    assert.strictEqual(testF2Res.data.code, 'INVALID_DATE_FORMAT');
    console.log('  ✓ Test F PASSED: Employee creation date serialization validated.');
    passed++;

    // ------------------------------------------------------------------------
    // TEST G: GET /employees returns clean YYYY-MM-DD format (no "Tue Sep 01" slice bug)
    // ------------------------------------------------------------------------
    console.log('\n[Test G] GET /api/hrd/employees returns formatted YYYY-MM-DD strings...');
    const listRes = await makeRequest(server, 'GET', `/api/hrd/employees?property_id=${TEST_PROPERTY_ID}`, authHeaders);
    assert.strictEqual(listRes.status, 200);
    const listedEmp = listRes.data.data.find(e => e.id === empId);
    assert(listedEmp, 'Created employee found in list');
    assert.strictEqual(listedEmp.hire_date, '2024-03-10', 'hire_date is clean YYYY-MM-DD in GET list');
    assert(!listedEmp.hire_date.includes(' '), 'hire_date does not contain spaces');
    console.log('  ✓ Test G PASSED: GET list produces clean YYYY-MM-DD without slice(0, 10) bug.');
    passed++;

    // Clean up
    await cleanupTestData(client);
    console.log('\n======================================================');
    console.log(`ALL TESTS PASSED: ${passed} passed, ${failed} failed`);
    console.log('======================================================\n');
  } catch (err) {
    console.error('\n❌ TEST SUITE FAILED with error:', err);
    process.exitCode = 1;
  } finally {
    await cleanupTestData(client).catch(() => {});
    client.release();
    server.close();
  }
}

runTests();
