// backend/test/auth_hr2b_lifecycle_onboarding_test.js
require('dotenv').config();
const assert = require('assert');
const http = require('http');
const bcrypt = require('bcryptjs');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const { createEmployeeAccount } = require('../dist/domains/hrd/hrdService');

const TEST_PREFIX = 'test_hr2b_';
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

async function runAuthHr2bTests() {
  console.log('========================================================================');
  console.log('=== OAK HIMS — AUTH-HR-2B FIRST LOGIN ONBOARDING & LIFECYCLE TEST ======');
  console.log('========================================================================\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`Test server running on port ${port}\n`);

  const client = await pool.connect();

  try {
    await cleanupTestData(client);

    // Get an admin user for privileged calls
    const adminRes = await client.query(
      "SELECT u.id, u.username, u.email, u.property_id, u.is_active FROM users u JOIN roles r ON r.id = u.role_id WHERE (r.name = 'Super Admin' OR r.name = 'General Manager') AND u.is_active = true LIMIT 1"
    );
    assert.ok(adminRes.rows.length > 0, 'Must have at least one active Super Admin / GM');
    const adminUser = adminRes.rows[0];
    const superAdminToken = generateToken({
      id: adminUser.id,
      username: adminUser.username,
      email: adminUser.email,
      role: 'Super Admin',
      property_id: TEST_PROPERTY_ID,
      scope: 'FULL',
      account_status: 'READY',
      must_change_password: false
    });

    const staffToken = generateToken({
      id: 999998,
      username: 'staff_tester',
      email: 'staff_tester@oakhotel.test',
      role: 'Front Office',
      property_id: TEST_PROPERTY_ID,
      scope: 'FULL',
      account_status: 'READY',
      must_change_password: false
    });

    // -------------------------------------------------------------
    // Scenario A: Login with active READY account without must_change_password
    // -------------------------------------------------------------
    console.log('Test A: Login with active READY account without must_change_password...');
    const hashedPwA = await bcrypt.hash('OakAdmin123!', 10);
    const userARes = await client.query(
      `INSERT INTO users (username, email, password_hash, role_id, property_id, is_active, account_status, must_change_password, full_name)
       VALUES ($1, $2, $3, 1, $4, true, 'READY', false, 'Admin A')
       RETURNING id, username, email`,
      [`${TEST_PREFIX}admin_a`, `${TEST_PREFIX}admin_a@oakhotel.test`, hashedPwA, TEST_PROPERTY_ID]
    );

    const loginResA = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: `${TEST_PREFIX}admin_a`,
      password: 'OakAdmin123!'
    });
    assert.strictEqual(loginResA.status, 200, 'Login A must succeed with 200');
    assert.strictEqual(loginResA.data.data.user.scope, 'FULL', 'Scope must be FULL');
    assert.strictEqual(loginResA.data.data.next_step, 'COMPLETE', 'next_step must be COMPLETE');

    // Verify PMS is accessible with FULL token
    const pmsCheckA = await makeRequest(server, 'GET', `/api/hrd/employees?property_id=${TEST_PROPERTY_ID}`, {
      Authorization: `Bearer ${loginResA.data.data.token}`
    });
    assert.strictEqual(pmsCheckA.status, 200, 'FULL token must access normal PMS endpoints');
    console.log('✓ PASS: Test A (Active account -> scope = FULL, PMS accessible).\n');

    // -------------------------------------------------------------
    // Scenario B: Create employee + temporary password, login with temp password
    // -------------------------------------------------------------
    console.log('Test B: Login with temporary password (must_change_password = TRUE)...');
    const empPayloadB = {
      property_id: TEST_PROPERTY_ID,
      employee_code: `${TEST_PREFIX}EMP_B`,
      full_name: 'Test Onboarding User B',
      username: `${TEST_PREFIX}user_b`,
      email: `${TEST_PREFIX}user_b@oakhotel.test`,
      phone: '081234567891',
      position: 'Staff',
      department: 'Front Office',
      role: 'Front Office',
      hire_date: '2026-09-01',
      create_login_account: true
    };
    const createdEmpB = await createEmployeeAccount(client, TEST_PROPERTY_ID, empPayloadB);
    const tempPwB = createdEmpB.temporary_password;
    assert.ok(tempPwB, 'Must issue temporary password');

    const loginResB = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: `${TEST_PREFIX}user_b`,
      password: tempPwB
    });
    assert.strictEqual(loginResB.status, 200, 'Login B must return 200');
    assert.strictEqual(loginResB.data.data.user.scope, 'ONBOARDING', 'User scope must be ONBOARDING');
    assert.strictEqual(loginResB.data.data.next_step, 'CHANGE_PASSWORD', 'next_step must be CHANGE_PASSWORD');
    const onboardingTokenB = loginResB.data.data.token;
    assert.ok(onboardingTokenB, 'Token must be present');
    console.log('✓ PASS: Test B (Login with temp password -> scope = ONBOARDING, next_step = CHANGE_PASSWORD).\n');

    // -------------------------------------------------------------
    // Scenario C: ONBOARDING token attempting to call PMS operational routes
    // -------------------------------------------------------------
    console.log('Test C: ONBOARDING token attempting to call normal PMS endpoints...');
    const endpointsToBlock = [
      { method: 'GET', path: '/api/reservations' },
      { method: 'GET', path: '/api/folios/1' },
      { method: 'GET', path: '/api/transactions' },
      { method: 'GET', path: '/api/cashier/status' },
      { method: 'GET', path: '/api/housekeeping/tasks' },
      { method: 'GET', path: `/api/hrd/employees?property_id=${TEST_PROPERTY_ID}` }
    ];

    for (const ep of endpointsToBlock) {
      const res = await makeRequest(server, ep.method, ep.path, {
        Authorization: `Bearer ${onboardingTokenB}`
      });
      assert.strictEqual(res.status, 403, `${ep.path} must return 403`);
      assert.strictEqual(res.data.code, 'ACCOUNT_ONBOARDING_INCOMPLETE', `${ep.path} must return ACCOUNT_ONBOARDING_INCOMPLETE code`);
    }
    console.log('✓ PASS: Test C (All PMS operational endpoints correctly blocked with 403 ACCOUNT_ONBOARDING_INCOMPLETE).\n');

    // -------------------------------------------------------------
    // Scenario D: ONBOARDING token calling whitelisted onboarding routes
    // -------------------------------------------------------------
    console.log('Test D: ONBOARDING token calling whitelisted onboarding endpoints...');
    const statusResD = await makeRequest(server, 'GET', '/api/auth/onboarding-status', {
      Authorization: `Bearer ${onboardingTokenB}`
    });
    assert.strictEqual(statusResD.status, 200, 'GET /onboarding-status must return 200');
    assert.strictEqual(statusResD.data.data.account_status, 'FIRST_LOGIN_REQUIRED');
    assert.strictEqual(statusResD.data.data.must_change_password, true);
    assert.strictEqual(statusResD.data.data.next_step, 'CHANGE_PASSWORD');

    const meResD = await makeRequest(server, 'GET', '/api/auth/me', {
      Authorization: `Bearer ${onboardingTokenB}`
    });
    assert.strictEqual(meResD.status, 200, 'GET /me must return 200');
    assert.strictEqual(meResD.data.data.user.scope, 'ONBOARDING');

    const logoutResD = await makeRequest(server, 'POST', '/api/auth/logout', {
      Authorization: `Bearer ${onboardingTokenB}`
    });
    assert.strictEqual(logoutResD.status, 200, 'POST /logout must return 200');
    console.log('✓ PASS: Test D (Whitelisted onboarding endpoints accessible with 200 OK).\n');

    // -------------------------------------------------------------
    // Scenario E: Complete initial password with weak passwords
    // -------------------------------------------------------------
    console.log('Test E: Complete initial password with weak password rejection...');
    const weakPasswords = [
      'short',
      'alllowercase123!',
      'ALLUPPERCASE123!',
      'NoNumberSpecial!',
      'NoSpecialChar123'
    ];
    let lastWeakPwRes = null;
    for (const wp of weakPasswords) {
      const res = await makeRequest(server, 'POST', '/api/auth/complete-initial-password', {
        Authorization: `Bearer ${onboardingTokenB}`
      }, {
        new_password: wp,
        confirm_password: wp
      });
      assert.strictEqual(res.status, 400, `Weak password '${wp}' must be rejected with 400`);
      assert.strictEqual(res.data.code, 'INVALID_PASSWORD');
      lastWeakPwRes = res;
    }
    console.log('✓ PASS: Test E (Weak passwords rejected with 400 INVALID_PASSWORD).\n');

    // -------------------------------------------------------------
    // Scenario F: Complete initial password identical to temporary password
    // -------------------------------------------------------------
    console.log('Test F: Complete initial password identical to temporary password...');
    const samePwRes = await makeRequest(server, 'POST', '/api/auth/complete-initial-password', {
      Authorization: `Bearer ${onboardingTokenB}`
    }, {
      new_password: tempPwB,
      confirm_password: tempPwB
    });
    assert.strictEqual(samePwRes.status, 400, 'Re-using temporary password must be rejected');
    assert.strictEqual(samePwRes.data.code, 'PASSWORD_MUST_BE_NEW');
    console.log('✓ PASS: Test F (Identical password rejected with 400 PASSWORD_MUST_BE_NEW).\n');

    // -------------------------------------------------------------
    // Scenario G: Complete initial password with mismatched confirmation
    // -------------------------------------------------------------
    console.log('Test G: Complete initial password with mismatched confirmation...');
    const mismatchRes = await makeRequest(server, 'POST', '/api/auth/complete-initial-password', {
      Authorization: `Bearer ${onboardingTokenB}`
    }, {
      new_password: 'ValidPassword123!',
      confirm_password: 'DifferentPassword123!'
    });
    assert.strictEqual(mismatchRes.status, 400, 'Mismatched confirmation must be rejected');
    assert.strictEqual(mismatchRes.data.code, 'PASSWORD_CONFIRMATION_MISMATCH');
    console.log('✓ PASS: Test G (Mismatched confirmation rejected with 400 PASSWORD_CONFIRMATION_MISMATCH).\n');

    // -------------------------------------------------------------
    // Scenario H: Complete initial password with valid new personal password
    // -------------------------------------------------------------
    console.log('Test H: Complete initial password with valid new personal password...');
    const validPersonalPw = 'MyStrongPass2026!@#';
    const completeRes = await makeRequest(server, 'POST', '/api/auth/complete-initial-password', {
      Authorization: `Bearer ${onboardingTokenB}`
    }, {
      new_password: validPersonalPw,
      confirm_password: validPersonalPw
    });
    assert.strictEqual(completeRes.status, 200, 'Complete initial password must return 200');
    assert.strictEqual(completeRes.data.data.account_status, 'FACE_ENROLLMENT_REQUIRED');
    assert.strictEqual(completeRes.data.data.must_change_password, false);
    assert.strictEqual(completeRes.data.data.next_step, 'ENROLL_FACE');
    const tokenAfterStep1 = completeRes.data.data.token;
    assert.ok(tokenAfterStep1, 'Updated token must be returned');

    // Verify database record
    const userBCheck = await client.query('SELECT * FROM users WHERE id = $1', [createdEmpB.user_id]);
    assert.strictEqual(userBCheck.rows[0].must_change_password, false, 'must_change_password must be false');
    assert.strictEqual(userBCheck.rows[0].temp_password_expires_at, null, 'temp_password_expires_at must be NULL');
    assert.strictEqual(userBCheck.rows[0].account_status, 'FACE_ENROLLMENT_REQUIRED', 'account_status must be FACE_ENROLLMENT_REQUIRED');

    // Verify bcrypt check on new password
    const pwMatch = await bcrypt.compare(validPersonalPw, userBCheck.rows[0].password_hash);
    assert.strictEqual(pwMatch, true, 'New personal password hash must match');

    // Verify audit log exists without plaintext or hash
    const auditResH = await client.query(
      `SELECT * FROM audit_logs WHERE entity = 'USER_AUTH' AND action = 'INITIAL_PASSWORD_CHANGED' AND record_id = $1 ORDER BY audit_id DESC LIMIT 1`,
      [String(createdEmpB.user_id)]
    );
    assert.strictEqual(auditResH.rows.length, 1, 'Audit record must exist');
    assert.strictEqual(auditResH.rows[0].action, 'INITIAL_PASSWORD_CHANGED');
    const auditStr = typeof auditResH.rows[0].new_value === 'string'
      ? auditResH.rows[0].new_value
      : JSON.stringify(auditResH.rows[0].new_value || {});
    assert.strictEqual(auditStr.includes(validPersonalPw), false, 'Audit log must never contain password');
    assert.strictEqual(auditStr.includes(userBCheck.rows[0].password_hash), false, 'Audit log must never contain password hash');
    console.log('✓ PASS: Test H (Password updated, expires_at set to NULL, status is FACE_ENROLLMENT_REQUIRED, audited safely).\n');

    // -------------------------------------------------------------
    // Scenario I: Post-password-change state remains in restricted ONBOARDING
    // -------------------------------------------------------------
    console.log('Test I: Post-password-change state remains restricted in ONBOARDING...');
    const statusResI = await makeRequest(server, 'GET', '/api/auth/onboarding-status', {
      Authorization: `Bearer ${tokenAfterStep1}`
    });
    assert.strictEqual(statusResI.status, 200);
    assert.strictEqual(statusResI.data.data.account_status, 'FACE_ENROLLMENT_REQUIRED');
    assert.strictEqual(statusResI.data.data.next_step, 'ENROLL_FACE');

    // Normal PMS endpoint still blocked
    const pmsBlockedI = await makeRequest(server, 'GET', '/api/reservations', {
      Authorization: `Bearer ${tokenAfterStep1}`
    });
    assert.strictEqual(pmsBlockedI.status, 403);
    assert.strictEqual(pmsBlockedI.data.code, 'ACCOUNT_ONBOARDING_INCOMPLETE');

    // Authentication regression: login with old temporary password MUST fail
    const oldTempLoginRes = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: `${TEST_PREFIX}user_b`,
      password: tempPwB
    });
    assert.strictEqual(oldTempLoginRes.status, 401, 'Old temporary password must be rejected');
    assert.strictEqual(oldTempLoginRes.data.code, 'INVALID_CREDENTIALS');

    // Authentication regression: login with new personal password MUST succeed into restricted ONBOARDING
    const newPersonalLoginRes = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: `${TEST_PREFIX}user_b`,
      password: validPersonalPw
    });
    assert.strictEqual(newPersonalLoginRes.status, 200, 'New personal password login must succeed');
    assert.strictEqual(newPersonalLoginRes.data.data.user.scope, 'ONBOARDING', 'Scope must remain ONBOARDING');
    assert.strictEqual(newPersonalLoginRes.data.data.user.account_status, 'FACE_ENROLLMENT_REQUIRED');
    assert.strictEqual(newPersonalLoginRes.data.data.next_step, 'ENROLL_FACE');
    console.log('✓ PASS: Test I (Post-password-change user remains restricted in ONBOARDING; old temp pw rejected, new personal pw succeeds into ONBOARDING).\n');

    // -------------------------------------------------------------
    // Scenario J: Login with DISABLED account
    // -------------------------------------------------------------
    console.log('Test J: Login with DISABLED account...');
    await client.query("UPDATE users SET account_status = 'DISABLED', is_active = false WHERE id = $1", [createdEmpB.user_id]);
    const loginDisabledRes = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: `${TEST_PREFIX}user_b`,
      password: validPersonalPw
    });
    assert.strictEqual(loginDisabledRes.status, 403);
    assert.strictEqual(loginDisabledRes.data.code, 'ACCOUNT_DISABLED');
    console.log('✓ PASS: Test J (Login rejected with 403 ACCOUNT_DISABLED).\n');

    // -------------------------------------------------------------
    // Scenario K: Login with SUSPENDED account
    // -------------------------------------------------------------
    console.log('Test K: Login with SUSPENDED account...');
    await client.query("UPDATE users SET account_status = 'SUSPENDED', is_active = true WHERE id = $1", [createdEmpB.user_id]);
    const loginSuspendedRes = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: `${TEST_PREFIX}user_b`,
      password: validPersonalPw
    });
    assert.strictEqual(loginSuspendedRes.status, 403);
    assert.strictEqual(loginSuspendedRes.data.code, 'ACCOUNT_SUSPENDED');
    console.log('✓ PASS: Test K (Login rejected with 403 ACCOUNT_SUSPENDED).\n');

    // -------------------------------------------------------------
    // Scenario L: Login with EXPIRED temporary password
    // -------------------------------------------------------------
    console.log('Test L: Login with EXPIRED temporary password...');
    const hashedPwL = await bcrypt.hash('TempPass123!', 10);
    const userLRes = await client.query(
      `INSERT INTO users (username, email, password_hash, role_id, property_id, is_active, account_status, must_change_password, temp_password_expires_at, full_name)
       VALUES ($1, $2, $3, 2, $4, true, 'FIRST_LOGIN_REQUIRED', true, NOW() - INTERVAL '2 hours', 'User L')
       RETURNING id`,
      [`${TEST_PREFIX}user_l`, `${TEST_PREFIX}user_l@oakhotel.test`, hashedPwL, TEST_PROPERTY_ID]
    );

    const loginExpiredRes = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: `${TEST_PREFIX}user_l`,
      password: 'TempPass123!'
    });
    assert.strictEqual(loginExpiredRes.status, 401);
    assert.strictEqual(loginExpiredRes.data.code, 'TEMP_PASSWORD_EXPIRED');
    console.log('✓ PASS: Test L (Expired temporary password rejected with 401 TEMP_PASSWORD_EXPIRED).\n');

    // -------------------------------------------------------------
    // Scenario M: Personal password never expires
    // -------------------------------------------------------------
    console.log('Test M: Personal password never expires (temp_password_expires_at is NULL)...');
    const userMCheck = await client.query("SELECT temp_password_expires_at, must_change_password FROM users WHERE id = $1", [createdEmpB.user_id]);
    assert.strictEqual(userMCheck.rows[0].temp_password_expires_at, null);
    assert.strictEqual(userMCheck.rows[0].must_change_password, false);
    console.log('✓ PASS: Test M (Personal passwords have NULL temp_password_expires_at and never expire).\n');

    // -------------------------------------------------------------
    // Scenario N: HRD Employee deactivation
    // -------------------------------------------------------------
    console.log('Test N: HRD Employee deactivation...');
    await client.query("UPDATE users SET account_status = 'READY', is_active = true WHERE id = $1", [createdEmpB.user_id]);
    await client.query("UPDATE hr_employees SET status = 'ACTIVE', is_active = true WHERE id = $1", [createdEmpB.id]);

    const deactivateRes = await makeRequest(server, 'POST', `/api/hrd/employees/${createdEmpB.id}/deactivate`, {
      Authorization: `Bearer ${superAdminToken}`
    }, {
      property_id: TEST_PROPERTY_ID,
      reason: 'Resign dari hotel',
      effective_date: '2026-09-04'
    });
    assert.strictEqual(deactivateRes.status, 200);

    const empNCheck = await client.query('SELECT is_active, status FROM hr_employees WHERE id = $1', [createdEmpB.id]);
    assert.strictEqual(empNCheck.rows[0].is_active, false);
    assert.strictEqual(empNCheck.rows[0].status, 'INACTIVE');

    const userNCheck = await client.query('SELECT is_active, account_status FROM users WHERE id = $1', [createdEmpB.user_id]);
    assert.strictEqual(userNCheck.rows[0].is_active, false);
    assert.strictEqual(userNCheck.rows[0].account_status, 'DISABLED');

    const auditResN = await client.query(
      "SELECT * FROM audit_logs WHERE action = 'EMPLOYEE_ACCOUNT_DEACTIVATED' AND record_id = $1 ORDER BY audit_id DESC LIMIT 1",
      [String(createdEmpB.id)]
    );
    assert.strictEqual(auditResN.rows.length, 1);
    const auditNVal = typeof auditResN.rows[0].new_value === 'string'
      ? JSON.parse(auditResN.rows[0].new_value)
      : auditResN.rows[0].new_value;
    assert.strictEqual(auditNVal.reason, 'Resign dari hotel');
    assert.strictEqual(auditNVal.effective_date, '2026-09-04');
    console.log('✓ PASS: Test N (Employee and linked auth account deactivated, audit recorded with reason and effective date).\n');

    // -------------------------------------------------------------
    // Scenario O: Deactivated employee attempts login
    // -------------------------------------------------------------
    console.log('Test O: Deactivated employee attempts login...');
    const loginDeactivatedRes = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: `${TEST_PREFIX}user_b`,
      password: validPersonalPw
    });
    assert.strictEqual(loginDeactivatedRes.status, 403);
    assert.strictEqual(loginDeactivatedRes.data.code, 'ACCOUNT_DISABLED');
    console.log('✓ PASS: Test O (Deactivated employee login rejected with 403 ACCOUNT_DISABLED).\n');

    // -------------------------------------------------------------
    // Scenario P: HRD Employee reactivation (no blind auth restoration)
    // -------------------------------------------------------------
    console.log('Test P: HRD Employee reactivation without blind auth restoration...');
    const reactivateRes = await makeRequest(server, 'POST', `/api/hrd/employees/${createdEmpB.id}/reactivate`, {
      Authorization: `Bearer ${superAdminToken}`
    }, {
      property_id: TEST_PROPERTY_ID
    });
    assert.strictEqual(reactivateRes.status, 200);

    const empPCheck = await client.query('SELECT is_active, status FROM hr_employees WHERE id = $1', [createdEmpB.id]);
    assert.strictEqual(empPCheck.rows[0].is_active, true, 'hr_employees must be reactivated');
    assert.strictEqual(empPCheck.rows[0].status, 'ACTIVE');

    const userPCheck = await client.query('SELECT is_active, account_status FROM users WHERE id = $1', [createdEmpB.user_id]);
    assert.strictEqual(userPCheck.rows[0].is_active, false, 'Linked auth account MUST REMAIN inactive');
    assert.strictEqual(userPCheck.rows[0].account_status, 'DISABLED', 'Linked auth account MUST REMAIN DISABLED');

    // Login still rejected
    const loginPRes = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: `${TEST_PREFIX}user_b`,
      password: validPersonalPw
    });
    assert.strictEqual(loginPRes.status, 403);
    assert.strictEqual(loginPRes.data.code, 'ACCOUNT_DISABLED');
    console.log('✓ PASS: Test P (Personnel record reactivated, auth account safely kept disabled without blind restoration).\n');

    // -------------------------------------------------------------
    // Scenario Q: Hard delete auth account WITH operational history
    // -------------------------------------------------------------
    console.log('Test Q: Hard delete auth account with operational history...');
    await client.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [createdEmpB.user_id]);

    const deleteWithHistoryRes = await makeRequest(server, 'DELETE', `/api/hrd/employees/${createdEmpB.id}/login-account`, {
      Authorization: `Bearer ${superAdminToken}`
    }, {
      property_id: TEST_PROPERTY_ID,
      confirm_identity: `${TEST_PREFIX}user_b`
    });
    assert.strictEqual(deleteWithHistoryRes.status, 409);
    assert.strictEqual(deleteWithHistoryRes.data.code, 'ACCOUNT_HAS_HISTORY');

    // Ensure user record was NOT deleted
    const userQCheck = await client.query('SELECT id FROM users WHERE id = $1', [createdEmpB.user_id]);
    assert.strictEqual(userQCheck.rows.length, 1, 'User record must remain intact when history exists');
    console.log('✓ PASS: Test Q (Hard delete rejected with 409 ACCOUNT_HAS_HISTORY, user preserved).\n');

    // -------------------------------------------------------------
    // Scenario R: Hard delete auth account WITHOUT operational history
    // -------------------------------------------------------------
    console.log('Test R: Hard delete auth account without operational history...');
    const empPayloadR = {
      property_id: TEST_PROPERTY_ID,
      employee_code: `${TEST_PREFIX}EMP_R`,
      full_name: 'Test Hard Delete Employee R',
      username: `${TEST_PREFIX}user_r`,
      email: `${TEST_PREFIX}user_r@oakhotel.test`,
      position: 'Staff',
      department: 'Front Office',
      role: 'Front Office',
      hire_date: '2026-09-01',
      create_login_account: true
    };
    const empR = await createEmployeeAccount(client, TEST_PROPERTY_ID, empPayloadR);
    const userRId = empR.user_id;
    assert.ok(userRId, 'User R must have user_id');

    const deleteWithoutHistoryRes = await makeRequest(server, 'DELETE', `/api/hrd/employees/${empR.id}/login-account`, {
      Authorization: `Bearer ${superAdminToken}`
    }, {
      property_id: TEST_PROPERTY_ID,
      confirm_identity: `${TEST_PREFIX}user_r`
    });
    assert.strictEqual(deleteWithoutHistoryRes.status, 200, 'Delete must return 200 OK');

    // Verify user row deleted
    const userRCheck = await client.query('SELECT * FROM users WHERE id = $1', [userRId]);
    assert.strictEqual(userRCheck.rows.length, 0, 'Users row must be deleted');

    // Verify hr_employees row intact
    const empRCheck = await client.query('SELECT * FROM hr_employees WHERE id = $1', [empR.id]);
    assert.strictEqual(empRCheck.rows.length, 1, 'hr_employees row must remain intact');

    // Verify no linked user exists for this employee
    const linkedUsersCheck = await client.query('SELECT * FROM users WHERE employee_id = $1', [empR.id]);
    assert.strictEqual(linkedUsersCheck.rows.length, 0, 'No linked users should exist for employee');

    // Verify audit log
    const auditResR = await client.query(
      "SELECT * FROM audit_logs WHERE action = 'EMPLOYEE_AUTH_ACCOUNT_DELETED' AND record_id = $1 ORDER BY audit_id DESC LIMIT 1",
      [String(empR.id)]
    );
    assert.strictEqual(auditResR.rows.length, 1);
    console.log('✓ PASS: Test R (Fresh auth account deleted cleanly, hr_employees preserved, audited).\n');

    // -------------------------------------------------------------
    // Scenario S: Non-privileged user attempts hard delete
    // -------------------------------------------------------------
    console.log('Test S: Non-privileged user attempts hard delete...');
    const forbiddenDeleteRes = await makeRequest(server, 'DELETE', `/api/hrd/employees/${createdEmpB.id}/login-account`, {
      Authorization: `Bearer ${staffToken}`
    }, {
      property_id: TEST_PROPERTY_ID,
      confirm_identity: `${TEST_PREFIX}user_b`
    });
    assert.strictEqual(forbiddenDeleteRes.status, 403, 'Non-admin/GM must get 403');
    console.log('✓ PASS: Test S (Non-privileged user rejected with 403 FORBIDDEN).\n');

    // -------------------------------------------------------------
    // Scenario T: Inactive employee onboarding attempt
    // -------------------------------------------------------------
    console.log('Test T: Inactive employee attempting login/onboarding...');
    const empPayloadT = {
      property_id: TEST_PROPERTY_ID,
      employee_code: `${TEST_PREFIX}EMP_T`,
      full_name: 'Test Inactive Onboarding',
      username: `${TEST_PREFIX}inactive_emp`,
      email: `${TEST_PREFIX}inactive_emp@oakhotel.test`,
      phone: '081234567899',
      position: 'Staff',
      department: 'Front Office',
      role: 'Front Office',
      hire_date: '2026-09-01',
      create_login_account: true
    };
    const empT = await createEmployeeAccount(client, TEST_PROPERTY_ID, empPayloadT);
    const tempPwT = empT.temporary_password;
    assert.ok(tempPwT, 'Temporary password must be issued');

    // 1. Employee is_active = FALSE
    await client.query('UPDATE hr_employees SET is_active = FALSE WHERE id = $1', [empT.id]);
    const inactiveLoginRes1 = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: `${TEST_PREFIX}inactive_emp`,
      password: tempPwT
    });
    assert.strictEqual(inactiveLoginRes1.status, 403, 'Inactive employee login must be rejected with 403');
    assert.strictEqual(inactiveLoginRes1.data.code, 'EMPLOYEE_DISABLED');
    assert.strictEqual(inactiveLoginRes1.data.data, undefined, 'No token/user data should be returned');

    // 2. Employee status != ACTIVE (e.g. 'INACTIVE' or 'SUSPENDED') with is_active = TRUE
    await client.query("UPDATE hr_employees SET is_active = TRUE, status = 'INACTIVE' WHERE id = $1", [empT.id]);
    const inactiveLoginRes2 = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: `${TEST_PREFIX}inactive_emp`,
      password: tempPwT
    });
    assert.strictEqual(inactiveLoginRes2.status, 403, 'Non-ACTIVE employee status must be rejected with 403');
    assert.strictEqual(inactiveLoginRes2.data.code, 'EMPLOYEE_DISABLED');

    await client.query("UPDATE hr_employees SET is_active = TRUE, status = 'SUSPENDED' WHERE id = $1", [empT.id]);
    const inactiveLoginRes3 = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: `${TEST_PREFIX}inactive_emp`,
      password: tempPwT
    });
    assert.strictEqual(inactiveLoginRes3.status, 403, 'SUSPENDED employee status must be rejected with 403');
    assert.strictEqual(inactiveLoginRes3.data.code, 'EMPLOYEE_DISABLED');
    console.log('✓ PASS: Test T (Inactive/non-ACTIVE employee login strictly rejected with 403 EMPLOYEE_DISABLED; no ONBOARDING/FULL access).\n');

    // -------------------------------------------------------------
    // Scenario U: Super Admin with employee_id = NULL
    // -------------------------------------------------------------
    console.log('Test U: Super Admin user with employee_id = NULL login...');
    const superAdminNullPw = 'AdminRoot#2026';
    const superAdminNullHash = await bcrypt.hash(superAdminNullPw, 10);
    const saNullRes = await client.query(
      `INSERT INTO users (property_id, username, email, full_name, password_hash, role_id, is_active, account_status, must_change_password, employee_id)
       VALUES ($1, $2, $3, $4, $5, 1, true, 'READY', false, NULL)
       RETURNING id, username, email, employee_id, account_status, is_active`,
      [TEST_PROPERTY_ID, `${TEST_PREFIX}superadmin_null`, `${TEST_PREFIX}superadmin_null@oakhotel.com`, 'Platform Super Admin', superAdminNullHash]
    );
    assert.strictEqual(saNullRes.rows[0].employee_id, null, 'employee_id must be NULL');

    const saLoginRes = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: `${TEST_PREFIX}superadmin_null`,
      password: superAdminNullPw
    });
    assert.strictEqual(saLoginRes.status, 200, 'Super Admin login must return 200');
    assert.strictEqual(saLoginRes.data.data.user.scope, 'FULL', 'Scope must be FULL');
    assert.strictEqual(saLoginRes.data.data.user.account_status, 'READY');
    assert.strictEqual(saLoginRes.data.data.next_step, 'COMPLETE');
    assert.strictEqual(saLoginRes.data.data.user.role, 'Super Admin');

    // Test access to protected operational PMS endpoint
    const saPmsRes = await makeRequest(server, 'GET', `/api/hrd/employees?property_id=${TEST_PROPERTY_ID}`, {
      Authorization: `Bearer ${saLoginRes.data.data.token}`
    });
    assert.strictEqual(saPmsRes.status, 200, 'Super Admin token must successfully access operational PMS endpoints');
    console.log('✓ PASS: Test U (Super Admin with employee_id = NULL succeeds with scope = FULL; no HR employee required).\n');

    // -------------------------------------------------------------
    // Scenario V: Secret leakage check
    // -------------------------------------------------------------
    console.log('Test V: Verify no secret leakage in audit logs and error responses...');
    // 1. Audit logs inspection
    const auditLogsRes = await client.query(
      `SELECT * FROM audit_logs 
       WHERE correlation_id LIKE $1 
          OR record_id IN ($2, $3, $4)`,
      [`%${TEST_PREFIX}%`, String(createdEmpB.user_id), String(createdEmpB.id), String(empT.id)]
    );
    for (const log of auditLogsRes.rows) {
      const fullLogStr = JSON.stringify(log);
      assert.strictEqual(fullLogStr.includes(tempPwB), false, 'Audit log must never contain temp password B');
      assert.strictEqual(fullLogStr.includes(tempPwT), false, 'Audit log must never contain temp password T');
      assert.strictEqual(fullLogStr.includes(validPersonalPw), false, 'Audit log must never contain personal password');
      assert.strictEqual(fullLogStr.includes(userBCheck.rows[0].password_hash), false, 'Audit log must never contain password hash');
    }

    // 2. Error payloads inspection
    const checkedErrorPayloads = [
      lastWeakPwRes,
      samePwRes,
      mismatchRes,
      loginExpiredRes,
      inactiveLoginRes1,
      oldTempLoginRes
    ];
    for (const res of checkedErrorPayloads) {
      const payloadStr = JSON.stringify(res.data);
      assert.strictEqual(payloadStr.includes(tempPwB), false, 'Error payload must not contain temp password');
      assert.strictEqual(payloadStr.includes(validPersonalPw), false, 'Error payload must not contain personal password');
      assert.strictEqual(payloadStr.includes(userBCheck.rows[0].password_hash), false, 'Error payload must not contain password hash');
      assert.strictEqual(payloadStr.includes('token'), false, 'Error payload must not leak tokens');
    }
    console.log('✓ PASS: Test V (Zero secret leakage: temporary passwords, personal passwords, password hashes, and tokens are never exposed in audit logs or error payloads).\n');

    console.log('========================================================================');
    console.log('=== ALL AUTH-HR-2B TESTS (A THROUGH V) PASSED SUCCESSFULLY! ============');
    console.log('========================================================================\n');

  } finally {
    await cleanupTestData(client);
    client.release();
    server.close();
  }
}

runAuthHr2bTests()
  .then(() => {
    console.log('Test suite finished cleanly with zero session residue.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
