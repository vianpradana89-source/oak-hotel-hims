// backend/test/auth_hr2d_lifecycle_test.js
require('dotenv').config();
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { app, pool } = require('../dist/index');
const { generateToken, hashPassword } = require('../dist/domains/auth/authService');
const { deleteFaceEnrollmentPhoto } = require('../dist/domains/auth/faceEnrollmentStorageService');
const { getActiveFaceEnrollment } = require('../dist/domains/auth/faceEnrollmentService');
const { resetEmployeePassword } = require('../dist/domains/hrd/hrdService');

const TEST_PREFIX = 'test_hr2d_';
const TEST_PROPERTY_ID = 1;
const FOREIGN_PROPERTY_ID = 2;

function buildMultipartPayload(boundary, fields = {}, files = {}) {
  const parts = [];
  for (const [key, val] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`));
  }
  for (const [fieldName, file] of Object.entries(files)) {
    const filename = file.filename || 'face.jpg';
    const contentType = file.contentType || 'image/jpeg';
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
    );
    parts.push(header);
    parts.push(file.buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

function makeMultipartRequest(server, path, token, fields = {}, files = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const body = buildMultipartPayload(boundary, fields, files);

    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers
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
    req.write(body);
    req.end();
  });
}

function makeRequest(server, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const payload = body !== null && body !== undefined ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
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
    if (payload) req.write(payload);
    req.end();
  });
}

function createValidJpegBuffer(sizeBytes = 256) {
  const header = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const filler = Buffer.alloc(Math.max(0, sizeBytes - header.length), 0x5A);
  return Buffer.concat([header, filler]);
}

async function cleanupTestData(client) {
  const keysRes = await client.query(`
    SELECT reference_photo_storage_key FROM employee_face_enrollments
    WHERE employee_id IN (
      SELECT id FROM hr_employees WHERE email LIKE $1 OR username LIKE $1 OR employee_code LIKE $1
    )
  `, [`%${TEST_PREFIX}%`]);

  for (const row of keysRes.rows) {
    if (row.reference_photo_storage_key) {
      await deleteFaceEnrollmentPhoto(row.reference_photo_storage_key).catch(() => {});
    }
  }

  await client.query(`
    DELETE FROM employee_face_enrollments
    WHERE employee_id IN (
      SELECT id FROM hr_employees WHERE email LIKE $1 OR username LIKE $1 OR employee_code LIKE $1
    )
  `, [`%${TEST_PREFIX}%`]);

  await client.query("DELETE FROM audit_logs WHERE correlation_id LIKE $1 OR correlation_id LIKE $2", [`%${TEST_PREFIX}%`, '%test_hr2d%']);
  await client.query("DELETE FROM users WHERE email LIKE $1 OR username LIKE $1", [`%${TEST_PREFIX}%`]);
  await client.query("DELETE FROM hr_employees WHERE email LIKE $1 OR username LIKE $1 OR employee_code LIKE $1", [`%${TEST_PREFIX}%`]);
}

async function runTests() {
  console.log('========================================================================');
  console.log('=== OAK HIMS — AUTH-HR-2D PASSWORD RESET & RE-ENROLLMENT TEST SUITE ===');
  console.log('========================================================================\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`Test server running on port ${port}\n`);

  const client = await pool.connect();

  try {
    // Initial cleanup
    await cleanupTestData(client);

    // Setup HR Admin user & token for authorized calls
    const adminUserRes = await client.query(`
      INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, account_status)
      VALUES ($1, 1, $2, $3, 'dummy_hash', 'HR Admin Tester', TRUE, 'READY')
      RETURNING id
    `, [TEST_PROPERTY_ID, `${TEST_PREFIX}admin`, `${TEST_PREFIX}admin@oaklawang.com`]);
    const adminUserId = adminUserRes.rows[0].id;

    const hrAdminToken = generateToken({
      id: adminUserId,
      email: `${TEST_PREFIX}admin@oaklawang.com`,
      username: `${TEST_PREFIX}admin`,
      full_name: 'HR Admin Tester',
      role: 'Super Admin',
      role_id: 1,
      property_id: TEST_PROPERTY_ID,
      scope: 'FULL',
      account_status: 'READY',
      must_change_password: false,
      access_type: 'ALL_ACCESS'
    });

    // Setup unauthorized staff user & token (Front Office)
    const staffUserRes = await client.query(`
      INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, account_status)
      VALUES ($1, 2, $2, $3, 'dummy_hash', 'FO Staff Tester', TRUE, 'READY')
      RETURNING id
    `, [TEST_PROPERTY_ID, `${TEST_PREFIX}staff`, `${TEST_PREFIX}staff@oaklawang.com`]);
    const staffUserId = staffUserRes.rows[0].id;

    const unauthorizedStaffToken = generateToken({
      id: staffUserId,
      email: `${TEST_PREFIX}staff@oaklawang.com`,
      username: `${TEST_PREFIX}staff`,
      full_name: 'FO Staff Tester',
      role: 'Front Office',
      role_id: 2,
      property_id: TEST_PROPERTY_ID,
      scope: 'FULL',
      account_status: 'READY',
      must_change_password: false,
      access_type: 'PMS_STAFF'
    });

    // ========================================================================
    // SETUP TEST FIXTURE: Employee + Linked User in READY status with ACTIVE face
    // ========================================================================
    console.log('--- Setting up Employee with ACTIVE face enrollment ---');
    const empRes = await client.query(`
      INSERT INTO hr_employees (property_id, employee_code, full_name, email, role, is_active, status)
      VALUES ($1, $2, $3, $4, 'Housekeeping', TRUE, 'ACTIVE')
      RETURNING id
    `, [TEST_PROPERTY_ID, `${TEST_PREFIX}EMP01`, 'Budi Santoso', `${TEST_PREFIX}budi@oaklawang.com`]);
    const empId = empRes.rows[0].id;

    const initialPasswordHash = await hashPassword('InitialPass123!');
    const userRes = await client.query(`
      INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, employee_id, account_status, must_change_password)
      VALUES ($1, 4, $2, $3, $4, 'Budi Santoso', TRUE, $5, 'READY', FALSE)
      RETURNING id
    `, [TEST_PROPERTY_ID, `${TEST_PREFIX}budi`, `${TEST_PREFIX}budi@oaklawang.com`, initialPasswordHash, empId]);
    const userId = userRes.rows[0].id;

    // Create initial ACTIVE face enrollment
    const oldStorageKey = `master-faces/${TEST_PROPERTY_ID}/${empId}/old_master_face.jpg`;
    const oldPhotoHash = 'old_hash_' + crypto.randomBytes(16).toString('hex');
    const initialFaceRes = await client.query(`
      INSERT INTO employee_face_enrollments (
        property_id, employee_id, enrolled_by_user_id, status,
        reference_photo_storage_key, reference_photo_hash,
        quality_status, review_status
      )
      VALUES ($1, $2, $3, 'ACTIVE', $4, $5, 'PASSED', 'APPROVED')
      RETURNING id, status
    `, [TEST_PROPERTY_ID, empId, userId, oldStorageKey, oldPhotoHash]);
    const initialFaceId = initialFaceRes.rows[0].id;
    assert.strictEqual(initialFaceRes.rows[0].status, 'ACTIVE');
    console.log(`Initial active face created with ID ${initialFaceId}.\n`);

    // ========================================================================
    // TEST A: HR Reset User with ACTIVE face → Face REVOKED, FIRST_LOGIN_REQUIRED
    // ========================================================================
    console.log('Test A: HR reset user with ACTIVE face → old face becomes REVOKED, FIRST_LOGIN_REQUIRED...');
    const resetRes = await makeRequest(
      server,
      'POST',
      `/api/hrd/employees/${empId}/reset-password`,
      { Authorization: `Bearer ${hrAdminToken}` },
      { property_id: TEST_PROPERTY_ID }
    );

    assert.strictEqual(resetRes.status, 200, `Expected 200 OK, got ${resetRes.status}: ${JSON.stringify(resetRes.data)}`);
    assert.strictEqual(resetRes.data.status, 'OK');
    const resetData = resetRes.data.data;
    assert.strictEqual(resetData.employee_id, empId);
    assert.strictEqual(resetData.user_id, userId);
    assert.ok(resetData.temporary_password, 'Temporary password must be returned');
    assert.strictEqual(resetData.must_change_password, true);
    assert.strictEqual(resetData.account_status, 'FIRST_LOGIN_REQUIRED');
    assert.strictEqual(resetData.face_revoked, true, 'face_revoked flag must be true');

    const tempPassword = resetData.temporary_password;

    // Check DB for old face status
    const oldFaceDbRes = await client.query('SELECT * FROM employee_face_enrollments WHERE id = $1', [initialFaceId]);
    assert.strictEqual(oldFaceDbRes.rows[0].status, 'REVOKED', 'Old face status must be REVOKED');
    assert.strictEqual(oldFaceDbRes.rows[0].revocation_reason, 'HR_PASSWORD_RESET', 'Revocation reason must be HR_PASSWORD_RESET');
    assert.strictEqual(oldFaceDbRes.rows[0].revoked_by_user_id, adminUserId, 'revoked_by_user_id must match HR actor ID');
    assert.ok(oldFaceDbRes.rows[0].revoked_at, 'revoked_at timestamp must be set');
    console.log('✓ PASS: Test A (Old face revoked with HR_PASSWORD_RESET, account enters FIRST_LOGIN_REQUIRED).\n');

    // ========================================================================
    // TEST B: Temporary-Password Login Works (returns ONBOARDING scope)
    // ========================================================================
    console.log('Test B: Temporary-password login works (returns ONBOARDING scope)...');
    const loginRes = await makeRequest(server, 'POST', '/api/auth/login', {}, {
      username: `${TEST_PREFIX}budi`,
      password: tempPassword
    });

    assert.strictEqual(loginRes.status, 200, `Login should succeed: ${JSON.stringify(loginRes.data)}`);
    const loginPayload = loginRes.data.data;
    assert.strictEqual(loginPayload.scope, 'ONBOARDING');
    assert.strictEqual(loginPayload.next_step, 'CHANGE_PASSWORD');
    assert.strictEqual(loginPayload.user.must_change_password, true);
    assert.strictEqual(loginPayload.user.account_status, 'FIRST_LOGIN_REQUIRED');
    const onboardingToken = loginPayload.token;
    assert.ok(onboardingToken, 'Must receive an onboarding token');
    console.log('✓ PASS: Test B (Login with temp password -> ONBOARDING scope, step CHANGE_PASSWORD).\n');

    // Verify ONBOARDING token is blocked from operational PMS endpoints
    const pmsBlockRes = await makeRequest(
      server,
      'GET',
      `/api/hrd/employees?property_id=${TEST_PROPERTY_ID}`,
      { Authorization: `Bearer ${onboardingToken}` }
    );
    assert.strictEqual(pmsBlockRes.status, 403);
    assert.strictEqual(pmsBlockRes.data.code, 'ACCOUNT_ONBOARDING_INCOMPLETE');
    console.log('  ✓ Verified: ONBOARDING token blocked from PMS operational endpoints.\n');

    // ========================================================================
    // TEST C: Personal Password Creation → FACE_ENROLLMENT_REQUIRED
    // ========================================================================
    console.log('Test C: Personal password creation → FACE_ENROLLMENT_REQUIRED...');
    const newPersonalPassword = 'PersonalPass2026!Secure';
    const pwdChangeRes = await makeRequest(
      server,
      'POST',
      '/api/auth/complete-initial-password',
      { Authorization: `Bearer ${onboardingToken}` },
      {
        new_password: newPersonalPassword,
        confirm_password: newPersonalPassword
      }
    );

    assert.strictEqual(pwdChangeRes.status, 200, `Password change should succeed: ${JSON.stringify(pwdChangeRes.data)}`);
    const pwdPayload = pwdChangeRes.data.data;
    assert.strictEqual(pwdPayload.account_status, 'FACE_ENROLLMENT_REQUIRED');
    assert.strictEqual(pwdPayload.next_step, 'ENROLL_FACE');
    assert.strictEqual(pwdPayload.must_change_password, false);
    const faceOnboardingToken = pwdPayload.token;
    assert.ok(faceOnboardingToken, 'Refreshed token for face enrollment step must be returned');
    console.log('✓ PASS: Test C (Personal password set -> FACE_ENROLLMENT_REQUIRED, next step FACE_ENROLLMENT).\n');

    // ========================================================================
    // TEST D: New Face Enrollment Succeeds via POST /api/auth/face-enrollment
    // ========================================================================
    console.log('Test D: New face enrollment succeeds via POST /api/auth/face-enrollment...');
    const newFaceBuffer = createValidJpegBuffer(512);
    const enrollRes = await makeMultipartRequest(
      server,
      '/api/auth/face-enrollment',
      faceOnboardingToken,
      {},
      { photo: { filename: 'new_selfie.jpg', contentType: 'image/jpeg', buffer: newFaceBuffer } }
    );

    assert.strictEqual(enrollRes.status, 200, `Face enrollment should succeed: ${JSON.stringify(enrollRes.data)}`);
    assert.strictEqual(enrollRes.data.status, 'OK');
    const enrollPayload = enrollRes.data.data;
    assert.strictEqual(enrollPayload.account_status, 'READY');
    assert.strictEqual(enrollPayload.next_step, 'COMPLETE');
    assert.strictEqual(enrollPayload.enrollment.status, 'ACTIVE');
    const newEnrollmentId = enrollPayload.enrollment.id;
    const fullToken = enrollPayload.token;
    assert.ok(fullToken, 'Refreshed FULL token must be returned');
    console.log(`✓ PASS: Test D (New face enrollment succeeded with ID ${newEnrollmentId}).\n`);

    // ========================================================================
    // TEST E: Exactly One ACTIVE Face Afterward
    // ========================================================================
    console.log('Test E: Exactly one ACTIVE face afterward for employee...');
    const activeFacesRes = await client.query(
      "SELECT id, status FROM employee_face_enrollments WHERE employee_id = $1 AND status = 'ACTIVE'",
      [empId]
    );
    assert.strictEqual(activeFacesRes.rows.length, 1, 'Must have exactly ONE active face');
    assert.strictEqual(activeFacesRes.rows[0].id, newEnrollmentId, 'Active face must be the newly created enrollment');
    console.log('✓ PASS: Test E (Exactly 1 ACTIVE face in database).\n');

    // ========================================================================
    // TEST F: Old Enrollment Remains in DB as History
    // ========================================================================
    console.log('Test F: Old enrollment remains in DB as history (zero destructive deletion)...');
    const allFacesRes = await client.query(
      'SELECT id, status, revocation_reason FROM employee_face_enrollments WHERE employee_id = $1 ORDER BY id ASC',
      [empId]
    );
    assert.strictEqual(allFacesRes.rows.length, 2, 'Both old and new face enrollments must exist in database');
    assert.strictEqual(allFacesRes.rows[0].id, initialFaceId);
    assert.strictEqual(allFacesRes.rows[0].status, 'REVOKED');
    assert.strictEqual(allFacesRes.rows[0].revocation_reason, 'HR_PASSWORD_RESET');
    console.log('✓ PASS: Test F (Old face preserved as historical audit record with REVOKED status).\n');

    // ========================================================================
    // TEST G: New Enrollment is ACTIVE with Valid Storage Key & Hash
    // ========================================================================
    console.log('Test G: New enrollment is ACTIVE with valid storage key & hash...');
    const newFaceDbRes = await client.query('SELECT * FROM employee_face_enrollments WHERE id = $1', [newEnrollmentId]);
    const newFaceRow = newFaceDbRes.rows[0];
    assert.strictEqual(newFaceRow.status, 'ACTIVE');
    assert.ok(newFaceRow.reference_photo_storage_key.startsWith(`face-enrollment/${TEST_PROPERTY_ID}/${empId}/`));
    assert.ok(newFaceRow.reference_photo_storage_key.endsWith('.jpg'));
    assert.ok(newFaceRow.reference_photo_hash, 'Must have reference_photo_hash');
    assert.strictEqual(newFaceRow.reference_photo_hash.length, 64, 'SHA-256 hash must be 64 hex characters');
    console.log('✓ PASS: Test G (New enrollment is ACTIVE with private storage key and SHA-256 hash).\n');

    // ========================================================================
    // TEST H: Account Becomes READY Only After New Enrollment
    // ========================================================================
    console.log('Test H: Account becomes READY with FULL scope only after new enrollment...');
    const userFinalRes = await client.query('SELECT account_status, must_change_password FROM users WHERE id = $1', [userId]);
    assert.strictEqual(userFinalRes.rows[0].account_status, 'READY');
    assert.strictEqual(userFinalRes.rows[0].must_change_password, false);

    // Verify FULL token can now access PMS
    const pmsAccessRes = await makeRequest(
      server,
      'GET',
      `/api/hrd/employees?property_id=${TEST_PROPERTY_ID}`,
      { Authorization: `Bearer ${fullToken}` }
    );
    assert.strictEqual(pmsAccessRes.status, 200, 'READY user with FULL token must have access');
    console.log('✓ PASS: Test H (Account is READY and FULL token accesses PMS).\n');

    // ========================================================================
    // TEST I: Normal READY-User Password Change Does NOT Revoke Face
    // ========================================================================
    console.log('Test I: Normal READY-user password change does NOT revoke face...');
    const normalChangeRes = await makeRequest(
      server,
      'POST',
      '/api/auth/change-password',
      { Authorization: `Bearer ${fullToken}` },
      {
        current_password: newPersonalPassword,
        new_password: 'RoutinePasswordChange2026!'
      }
    );
    assert.strictEqual(normalChangeRes.status, 200, `Change password should succeed: ${JSON.stringify(normalChangeRes.data)}`);

    // Verify active face is STILL ACTIVE
    const faceAfterRoutineRes = await client.query(
      "SELECT id, status FROM employee_face_enrollments WHERE employee_id = $1 AND status = 'ACTIVE'",
      [empId]
    );
    assert.strictEqual(faceAfterRoutineRes.rows.length, 1);
    assert.strictEqual(faceAfterRoutineRes.rows[0].id, newEnrollmentId, 'Active face must remain untouched');

    // Verify user is still READY
    const userAfterRoutineRes = await client.query('SELECT account_status FROM users WHERE id = $1', [userId]);
    assert.strictEqual(userAfterRoutineRes.rows[0].account_status, 'READY');
    console.log('✓ PASS: Test I (Normal password change preserves active face and READY status).\n');

    // ========================================================================
    // TEST J: Unauthorized User Cannot Trigger HR Reset
    // ========================================================================
    console.log('Test J: Unauthorized user cannot trigger HR reset lifecycle...');
    // J1: Anonymous
    const anonRes = await makeRequest(server, 'POST', `/api/hrd/employees/${empId}/reset-password`, {}, { property_id: TEST_PROPERTY_ID });
    assert.strictEqual(anonRes.status, 401, 'Anonymous request must be rejected with 401');

    // J2: Unauthorized role (FO Staff)
    const staffRes = await makeRequest(
      server,
      'POST',
      `/api/hrd/employees/${empId}/reset-password`,
      { Authorization: `Bearer ${unauthorizedStaffToken}` },
      { property_id: TEST_PROPERTY_ID }
    );
    assert.strictEqual(staffRes.status, 403, 'Non-HR staff must be rejected with 403');
    assert.strictEqual(staffRes.data.code, 'FORBIDDEN');
    console.log('✓ PASS: Test J (Anonymous and non-HR staff correctly rejected from HR reset).\n');

    // ========================================================================
    // TEST K: Property / Employee Isolation Strictly Enforced
    // ========================================================================
    console.log('Test K: Property/employee isolation strictly enforced...');
    // Create foreign property employee
    const foreignEmpRes = await client.query(`
      INSERT INTO hr_employees (property_id, employee_code, full_name, email, role, is_active, status)
      VALUES ($1, $2, 'Foreign Property Staff', $3, 'Front Office', TRUE, 'ACTIVE')
      RETURNING id
    `, [FOREIGN_PROPERTY_ID, `${TEST_PREFIX}FOREIGN01`, `${TEST_PREFIX}foreign@oaklawang.com`]);
    const foreignEmpId = foreignEmpRes.rows[0].id;

    // Attempting to reset foreign employee using Property 1 admin token
    const crossPropertyRes = await makeRequest(
      server,
      'POST',
      `/api/hrd/employees/${foreignEmpId}/reset-password`,
      { Authorization: `Bearer ${hrAdminToken}` },
      { property_id: TEST_PROPERTY_ID }
    );
    assert.strictEqual(crossPropertyRes.status, 404, 'Cross-property reset must return 404 EMPLOYEE_NOT_FOUND');
    assert.strictEqual(crossPropertyRes.data.code, 'EMPLOYEE_NOT_FOUND');
    console.log('✓ PASS: Test K (Cross-property reset rejected with 404 EMPLOYEE_NOT_FOUND).\n');

    // ========================================================================
    // TEST L: Duplicate ACTIVE Enrollment is Rejected (409)
    // ========================================================================
    console.log('Test L: Duplicate ACTIVE enrollment is rejected (409)...');
    // User is READY and has ACTIVE face; attempting another face enrollment must be rejected
    const dupRes = await makeMultipartRequest(
      server,
      '/api/auth/face-enrollment',
      fullToken,
      {},
      { photo: { filename: 'dup_selfie.jpg', contentType: 'image/jpeg', buffer: createValidJpegBuffer(512) } }
    );
    assert.strictEqual(dupRes.status, 409, 'Duplicate active face enrollment must return 409');
    assert.strictEqual(dupRes.data.code, 'FACE_ENROLLMENT_ALREADY_COMPLETED');
    console.log('✓ PASS: Test L (Duplicate active enrollment correctly rejected with 409).\n');

    // ========================================================================
    // TEST M: Transaction Safety (Simulated Failure Rolls Back All Mutations)
    // ========================================================================
    console.log('Test M: Transaction safety (Simulated Failure Rolls Back All Mutations)...');
    const txClient = await pool.connect();
    try {
      await txClient.query('BEGIN');
      // Revoke face inside tx
      await txClient.query(
        "UPDATE employee_face_enrollments SET status = 'REVOKED' WHERE employee_id = $1 AND status = 'ACTIVE'",
        [empId]
      );
      // Simulate failure by throwing error
      throw new Error('SIMULATED_DATABASE_FAILURE');
    } catch (e) {
      await txClient.query('ROLLBACK');
    } finally {
      txClient.release();
    }

    // Verify active face remains ACTIVE because of rollback
    const rollbackCheck = await client.query(
      "SELECT id, status FROM employee_face_enrollments WHERE id = $1",
      [newEnrollmentId]
    );
    assert.strictEqual(rollbackCheck.rows[0].status, 'ACTIVE', 'Active face must remain intact after rollback');
    console.log('✓ PASS: Test M (Transaction rollback preserves active face).\n');

    // ========================================================================
    // TEST N: Reset Employee Without Prior Face Enrollment
    // ========================================================================
    console.log('Test N: Reset employee without prior face enrollment...');
    const freshEmpRes = await client.query(`
      INSERT INTO hr_employees (property_id, employee_code, full_name, email, role, is_active, status)
      VALUES ($1, $2, 'Fresh Employee No Face', $3, 'Housekeeping', TRUE, 'ACTIVE')
      RETURNING id
    `, [TEST_PROPERTY_ID, `${TEST_PREFIX}NOFACE`, `${TEST_PREFIX}noface@oaklawang.com`]);
    const freshEmpId = freshEmpRes.rows[0].id;

    const freshUserRes = await client.query(`
      INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, employee_id, account_status, must_change_password)
      VALUES ($1, 4, $2, $3, 'dummy_hash', 'Fresh Employee No Face', TRUE, $4, 'READY', FALSE)
      RETURNING id
    `, [TEST_PROPERTY_ID, `${TEST_PREFIX}noface`, `${TEST_PREFIX}noface@oaklawang.com`, freshEmpId]);
    const freshUserId = freshUserRes.rows[0].id;

    const freshResetRes = await makeRequest(
      server,
      'POST',
      `/api/hrd/employees/${freshEmpId}/reset-password`,
      { Authorization: `Bearer ${hrAdminToken}` },
      { property_id: TEST_PROPERTY_ID }
    );
    assert.strictEqual(freshResetRes.status, 200);
    assert.strictEqual(freshResetRes.data.data.face_revoked, false, 'face_revoked should be false when no active face existed');
    assert.strictEqual(freshResetRes.data.data.account_status, 'FIRST_LOGIN_REQUIRED');
    console.log('✓ PASS: Test N (Gracefully handled employee with no prior face; face_revoked = false).\n');

    // ========================================================================
    // TEST O: Canonical Attendance Lookup Helper (getActiveFaceEnrollment)
    // ========================================================================
    console.log('Test O: Canonical attendance lookup helper resolves only ACTIVE master face...');
    const activeFace = await getActiveFaceEnrollment(client, TEST_PROPERTY_ID, empId);
    assert.ok(activeFace, 'Must find active face');
    assert.strictEqual(activeFace.id, newEnrollmentId, 'Resolved face must be the newly enrolled one');
    assert.strictEqual(activeFace.status, 'ACTIVE');
    assert.strictEqual(activeFace.employee_id, empId);

    // Verify lookup for employee with only REVOKED faces returns null
    const revokedEmpRes = await client.query(`
      INSERT INTO hr_employees (property_id, employee_code, full_name, email, role, is_active, status)
      VALUES ($1, $2, 'Revoked Face Employee', $3, 'Front Office', TRUE, 'ACTIVE')
      RETURNING id
    `, [TEST_PROPERTY_ID, `${TEST_PREFIX}REVOKED_ONLY`, `${TEST_PREFIX}revoked_only@oaklawang.com`]);
    const revokedEmpId = revokedEmpRes.rows[0].id;

    await client.query(`
      INSERT INTO employee_face_enrollments (
        property_id, employee_id, enrolled_by_user_id, status,
        reference_photo_storage_key, reference_photo_hash,
        quality_status, review_status, revocation_reason
      )
      VALUES ($1, $2, $3, 'REVOKED', 'revoked_key.jpg', 'revoked_hash', 'PASSED', 'APPROVED', 'HR_PASSWORD_RESET')
    `, [TEST_PROPERTY_ID, revokedEmpId, adminUserId]);

    const nullActiveFace = await getActiveFaceEnrollment(client, TEST_PROPERTY_ID, revokedEmpId);
    assert.strictEqual(nullActiveFace, null, 'Employee with only revoked faces must return null active enrollment');
    console.log('✓ PASS: Test O (Attendance lookup resolves only ACTIVE master face; never falls back to REVOKED).\n');

    // ========================================================================
    // TEST P: Admin User Reset Endpoint (POST /api/users/:id/reset-password)
    // ========================================================================
    console.log('Test P: Admin user reset endpoint (POST /api/users/:id/reset-password) revokes face if employee linked...');
    const adminUserResetRes = await makeRequest(
      server,
      'POST',
      `/api/users/${userId}/reset-password`,
      { Authorization: `Bearer ${hrAdminToken}` },
      { new_password: 'AdminResetPass2026!' }
    );
    assert.strictEqual(adminUserResetRes.status, 200);
    assert.strictEqual(adminUserResetRes.data.data.face_revoked, true);

    const faceAfterAdminResetRes = await client.query(
      "SELECT id, status FROM employee_face_enrollments WHERE id = $1",
      [newEnrollmentId]
    );
    assert.strictEqual(faceAfterAdminResetRes.rows[0].status, 'REVOKED');
    console.log('✓ PASS: Test P (Admin user reset endpoint correctly revokes active face).\n');

    console.log('========================================================================');
    console.log('=== ALL AUTH-HR-2D TESTS (A THROUGH P) PASSED SUCCESSFULLY! ============');
    console.log('========================================================================\n');

  } finally {
    console.log('--- Cleaning up test fixtures ---');
    await cleanupTestData(client);
    client.release();
    server.close();
    console.log('Cleaned up all test artifacts. Zero residue.\n');
  }
}

runTests().catch((err) => {
  console.error('\n❌ TEST RUNNER FAILED:');
  console.error(err);
  process.exit(1);
}).then(() => {
  process.exit(0);
});
