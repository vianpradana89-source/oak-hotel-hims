// backend/test/auth_hr2c_hrd_enrollment_test.js
require('dotenv').config();
const assert = require('assert');
const http = require('http');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const { deleteFaceEnrollmentPhoto } = require('../dist/domains/auth/faceEnrollmentStorageService');

const TEST_PREFIX = 'test_hr2c_hrd_';
const TEST_PROPERTY_ID = 1;

function buildMultipartPayload(boundary, fields = {}, files = {}) {
  const parts = [];
  for (const [key, val] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`));
  }
  for (const [fieldName, file] of Object.entries(files)) {
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${file.filename || 'face.jpg'}"\r\nContent-Type: ${file.contentType || 'image/jpeg'}\r\n\r\n`
    );
    parts.push(header);
    parts.push(file.buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

function makeMultipartRequest(server, urlPath, token, files = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const boundary = '----TestBoundary' + Math.random().toString(36).substring(2);
    const body = buildMultipartPayload(boundary, {}, files);
    const headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, raw }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function makeRequest(server, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const payload = body !== null ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (payload) { reqHeaders['Content-Type'] = 'application/json'; reqHeaders['Content-Length'] = Buffer.byteLength(payload); }
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

function createValidJpegBuffer(sizeBytes = 256) {
  const header = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, sizeBytes - header.length), 0x5A)]);
}

async function cleanupTestData(client) {
  const keysRes = await client.query(
    `SELECT reference_photo_storage_key FROM employee_face_enrollments WHERE employee_id IN (SELECT id FROM hr_employees WHERE email LIKE $1 OR username LIKE $1 OR employee_code LIKE $1)`,
    [`%${TEST_PREFIX}%`]
  );
  for (const row of keysRes.rows) {
    if (row.reference_photo_storage_key) await deleteFaceEnrollmentPhoto(row.reference_photo_storage_key).catch(() => {});
  }
  await client.query(`DELETE FROM employee_face_enrollments WHERE employee_id IN (SELECT id FROM hr_employees WHERE email LIKE $1 OR username LIKE $1 OR employee_code LIKE $1)`, [`%${TEST_PREFIX}%`]);
  await client.query("DELETE FROM audit_logs WHERE correlation_id LIKE $1", [`%${TEST_PREFIX}%`]);
  await client.query("DELETE FROM users WHERE email LIKE $1 OR username LIKE $1", [`%${TEST_PREFIX}%`]);
  await client.query("DELETE FROM hr_employees WHERE email LIKE $1 OR username LIKE $1 OR employee_code LIKE $1", [`%${TEST_PREFIX}%`]);
}

async function runHrdEnrollmentTests() {
  console.log('========================================================================');
  console.log('=== OAK HIMS — AUTH-HR-2C HRD ADMIN FACE ENROLLMENT TESTS ==============');
  console.log('========================================================================\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  console.log(`Test server running on port ${server.address().port}\n`);

  const client = await pool.connect();
  let passed = 0;
  let failed = 0;

  try {
    await cleanupTestData(client);

    const deptRes = await client.query('SELECT id FROM hr_departments LIMIT 1');
    const posRes = await client.query('SELECT id FROM hr_positions LIMIT 1');
    const defaultDeptId = deptRes.rows[0]?.id || 1;
    const defaultPosId = posRes.rows[0]?.id || 1;

    async function createFixture(tag, custom = {}) {
      const empRes = await client.query(
        `INSERT INTO hr_employees (property_id, employee_code, full_name, username, email, phone, department_id, position_id, is_active, hire_date)
         VALUES ($1, $2, $3, $4, $5, '081234567890', $6, $7, true, '2026-09-01')
         RETURNING id, property_id, full_name`,
        [custom.property_id || TEST_PROPERTY_ID, `${TEST_PREFIX}EMP_${tag}`, `Test ${tag}`, `${TEST_PREFIX}user_${tag}`, `${TEST_PREFIX}user_${tag}@oakhotel.test`, custom.department_id || defaultDeptId, custom.position_id || defaultPosId]
      );
      const employee = empRes.rows[0];

      const userRes = await client.query(
        `INSERT INTO users (username, email, password_hash, role_id, property_id, employee_id, is_active, account_status, must_change_password, full_name, access_type)
         VALUES ($1, $2, 'dummy_hash', 1, $3, $4, true, $5, false, $6, $7)
         RETURNING id, username, property_id, employee_id, account_status`,
        [`${TEST_PREFIX}user_${tag}`, `${TEST_PREFIX}user_${tag}@oakhotel.test`, custom.user_property_id || TEST_PROPERTY_ID, employee.id, custom.account_status || 'FACE_ENROLLMENT_REQUIRED', `Test ${tag}`, custom.access_type || 'ADMIN']
      );
      const user = userRes.rows[0];

      const token = generateToken({
        id: user.id, username: user.username, email: user.email,
        role: 'Admin', property_id: user.property_id, scope: 'FULL',
        account_status: 'READY', must_change_password: false, access_type: user.access_type
      });

      return { employee, user, token };
    }

    function ok(label) { passed++; console.log(`✓ PASS: ${label}\n`); }
    function fail(label, err) { failed++; console.log(`✗ FAIL: ${label} — ${err}\n`); }

    // TEST 1: Employee without account => 400 NO_LOGIN_ACCOUNT
    try {
      console.log('Test 1: Employee without account returns NO_LOGIN_ACCOUNT...');
      // Create employee WITHOUT a login account
      const empRes = await client.query(
        `INSERT INTO hr_employees (property_id, employee_code, full_name, username, email, phone, department_id, position_id, is_active, hire_date)
         VALUES ($1, $2, $3, $4, $5, '081234567890', $6, $7, true, '2026-09-01')
         RETURNING id, property_id, full_name`,
        [TEST_PROPERTY_ID, `${TEST_PREFIX}EMP_noacc`, 'Test noacc', `${TEST_PREFIX}user_noacc`, `${TEST_PREFIX}user_noacc@oakhotel.test`, defaultDeptId, defaultPosId]
      );
      const noAccEmp = empRes.rows[0];
      // Create a valid admin token for authorization
      const admin = await createFixture('admin1');
      const jpg = createValidJpegBuffer(1024);
      const res = await makeMultipartRequest(server, `/api/hrd/employees/${noAccEmp.id}/face-enrollment`, admin.token, { photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: jpg } });
      assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}: ${JSON.stringify(res.data)}`);
      assert.strictEqual(res.data.code, 'NO_LOGIN_ACCOUNT');
      ok('Test 1 (Employee without account rejected with NO_LOGIN_ACCOUNT).');
    } catch (e) { fail('Test 1', e.message); }

    // TEST 2: Authorized HR can enroll employee in same property
    try {
      console.log('Test 2: Authorized HR can enroll employee in same property...');
      const fx = await createFixture('hrdenroll');
      const jpg = createValidJpegBuffer(2048);
      const res = await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, fx.token, { photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: jpg } });
      assert.strictEqual(res.status, 200, `Got ${res.status}: ${JSON.stringify(res.data)}`);
      assert.strictEqual(res.data.data.account_status, 'READY');
      ok('Test 2 (HRD admin enrollment succeeds, account moves to READY).');
    } catch (e) { fail('Test 2', e.message); }

    // TEST 3: Unauthorized user receives 403
    try {
      console.log('Test 3: Unauthorized MOBILE_ONLY user receives 403...');
      const fx = await createFixture('unauth', { access_type: 'MOBILE_ONLY' });
      // Override token to use MOBILE_ONLY role
      const mobileToken = generateToken({
        id: fx.user.id, username: fx.user.username, email: fx.user.email,
        role: 'Crew', property_id: fx.user.property_id, scope: 'FULL',
        account_status: 'READY', must_change_password: false, access_type: 'MOBILE_ONLY'
      });
      const jpg = createValidJpegBuffer(1024);
      const res = await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, mobileToken, { photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: jpg } });
      assert.strictEqual(res.status, 403, `Got ${res.status}`);
      ok('Test 3 (Unauthorized MOBILE_ONLY user blocked with 403).');
    } catch (e) { fail('Test 3', e.message); }

    // TEST 4: Cross-property enrollment blocked
    try {
      console.log('Test 4: Cross-property enrollment blocked...');
      await client.query("INSERT INTO properties (id, name, property_code) VALUES (99, 'Test Prop 99', 'TP99') ON CONFLICT (id) DO NOTHING");
      const fx = await createFixture('crossprop', { property_id: 99, user_property_id: 99 });
      const target = await createFixture('target1', { property_id: 1 });
      const jpg = createValidJpegBuffer(1024);
      const res = await makeMultipartRequest(server, `/api/hrd/employees/${target.employee.id}/face-enrollment`, fx.token, { photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: jpg } });
      // Cross-property: employee not found in token's property => 404 or 403
      assert.ok(res.status === 403 || res.status === 404, `Expected 403 or 404 for cross-property, got ${res.status}`);
      ok('Test 4 (Cross-property enrollment blocked).');
    } catch (e) { fail('Test 4', e.message); }

    // TEST 5: Platform Super Admin bypass
    try {
      console.log('Test 5: Platform Super Admin bypass...');
      const saRes = await client.query("SELECT id FROM users WHERE role_id IN (SELECT id FROM roles WHERE name = 'Super Admin' LIMIT 1) AND is_active = true LIMIT 1");
      if (saRes.rows.length > 0) {
        const saToken = generateToken({
          id: saRes.rows[0].id, username: 'superadmin', email: 'sa@test',
          role: 'Super Admin', property_id: TEST_PROPERTY_ID, scope: 'FULL',
          account_status: 'READY', must_change_password: false, access_type: 'ADMIN'
        });
        const fx = await createFixture('satest');
        const jpg = createValidJpegBuffer(1024);
        const res = await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, saToken, { photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: jpg } });
        assert.strictEqual(res.status, 200, `Got ${res.status}`);
        ok('Test 5 (Platform Super Admin enrollment succeeds).');
      } else {
        console.log('  ⊘ SKIP: No Platform Super Admin in test DB.\n');
      }
    } catch (e) { fail('Test 5', e.message); }

    // TEST 6: Self-enrollment via /me/ derives identity from session
    try {
      console.log('Test 6: Self-enrollment via /me/ derives identity from session...');
      const fx = await createFixture('selfenroll');
      const selfToken = generateToken({
        id: fx.user.id, username: fx.user.username, email: fx.user.email,
        role: 'Front Office', property_id: fx.user.property_id, scope: 'ONBOARDING',
        account_status: 'FACE_ENROLLMENT_REQUIRED', must_change_password: false, access_type: 'PMS_STAFF'
      });
      const jpg = createValidJpegBuffer(1024);
      const res = await makeMultipartRequest(server, '/api/employee-mobile/me/face-enrollment', selfToken, { photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: jpg } });
      assert.strictEqual(res.status, 200, `Got ${res.status}: ${JSON.stringify(res.data)}`);
      assert.strictEqual(res.data.data.account_status, 'READY');
      ok('Test 6 (Self-enrollment succeeds using authenticated identity).');
    } catch (e) { fail('Test 6', e.message); }

    // TEST 7: Successful enrollment changes lifecycle to READY
    try {
      console.log('Test 7: Enrollment changes eligible lifecycle to READY...');
      const fx = await createFixture('readycheck');
      await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, fx.token, { photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: createValidJpegBuffer(1024) } });
      const dbUser = await client.query('SELECT account_status FROM users WHERE id = $1', [fx.user.id]);
      assert.strictEqual(dbUser.rows[0].account_status, 'READY');
      ok('Test 7 (Account status changed to READY).');
    } catch (e) { fail('Test 7', e.message); }

    // TEST 8: Reset changes lifecycle to FACE_ENROLLMENT_REQUIRED
    try {
      console.log('Test 8: Reset changes lifecycle to FACE_ENROLLMENT_REQUIRED...');
      const fx = await createFixture('reset');
      await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, fx.token, { photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: createValidJpegBuffer(1024) } });
      const res = await makeRequest(server, 'POST', `/api/hrd/employees/${fx.employee.id}/face-enrollment/reset`, { Authorization: `Bearer ${fx.token}`, 'Content-Type': 'application/json' }, { property_id: TEST_PROPERTY_ID, reason: 'TEST_RESET' });
      assert.strictEqual(res.status, 200, `Got ${res.status}`);
      assert.strictEqual(res.data.data.account_status, 'FACE_ENROLLMENT_REQUIRED');
      ok('Test 8 (Reset moves account to FACE_ENROLLMENT_REQUIRED).');
    } catch (e) { fail('Test 8', e.message); }

    // TEST 9: Password reset forces face re-enrollment
    try {
      console.log('Test 9: Password reset forces face re-enrollment...');
      const fx = await createFixture('pwreset');
      await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, fx.token, { photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: createValidJpegBuffer(1024) } });
      const res = await makeRequest(server, 'POST', `/api/hrd/employees/${fx.employee.id}/reset-password`, { Authorization: `Bearer ${fx.token}`, 'Content-Type': 'application/json' }, { property_id: TEST_PROPERTY_ID });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.data.face_revoked, true);
      const faceStatus = await makeRequest(server, 'GET', `/api/hrd/employees/${fx.employee.id}/face-enrollment?property_id=${TEST_PROPERTY_ID}`, { Authorization: `Bearer ${fx.token}` });
      // After password reset: account is FIRST_LOGIN_REQUIRED, enrollment is REVOKED
      // Status is NEEDS_REENROLLMENT (had enrollment that was revoked) or NOT_ENROLLED
      assert.ok(faceStatus.data.data.face_enrollment_status === 'NEEDS_REENROLLMENT' || faceStatus.data.data.face_enrollment_status === 'NOT_ENROLLED',
        `Expected NEEDS_REENROLLMENT or NOT_ENROLLED, got ${faceStatus.data.data.face_enrollment_status}`);
      ok('Test 9 (Password reset forces face re-enrollment).');
    } catch (e) { fail('Test 9', e.message); }

    // TEST 10: Suspended accounts not moved to READY
    try {
      console.log('Test 10: Suspended accounts not incorrectly moved to READY...');
      const fx = await createFixture('suspended', { account_status: 'SUSPENDED' });
      const jpg = createValidJpegBuffer(1024);
      const res = await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, fx.token, { photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: jpg } });
      assert.strictEqual(res.status, 409, `Got ${res.status}`);
      assert.strictEqual(res.data.code, 'INVALID_ACCOUNT_STATUS');
      ok('Test 10 (Suspended account blocked with INVALID_ACCOUNT_STATUS).');
    } catch (e) { fail('Test 10', e.message); }

    // TEST 11: Unsupported MIME rejected
    try {
      console.log('Test 11: Unsupported MIME rejected...');
      const fx = await createFixture('mime');
      const pdfBuf = Buffer.from('%PDF-1.4 fake');
      const res = await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, fx.token, { photo: { filename: 'doc.pdf', contentType: 'application/pdf', buffer: pdfBuf } });
      assert.strictEqual(res.status, 400, `Got ${res.status}`);
      assert.strictEqual(res.data.code, 'UNSUPPORTED_MIME_TYPE');
      ok('Test 11 (Unsupported MIME rejected).');
    } catch (e) { fail('Test 11', e.message); }

    // TEST 12: Oversized image rejected
    try {
      console.log('Test 12: Oversized image rejected...');
      const fx = await createFixture('oversize');
      const bigJpg = createValidJpegBuffer(5.2 * 1024 * 1024);
      const res = await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, fx.token, { photo: { filename: 'big.jpg', contentType: 'image/jpeg', buffer: bigJpg } });
      assert.strictEqual(res.status, 400, `Got ${res.status}`);
      assert.strictEqual(res.data.code, 'FILE_TOO_LARGE');
      ok('Test 12 (Oversized image rejected).');
    } catch (e) { fail('Test 12', e.message); }

    // TEST 13: Private storage key only, no public URL
    try {
      console.log('Test 13: Private storage metadata only, no public URL...');
      const enrollRes = await client.query(
        `SELECT reference_photo_storage_key FROM employee_face_enrollments WHERE employee_id = (SELECT id FROM hr_employees WHERE username = $1 LIMIT 1) AND status = 'ACTIVE' LIMIT 1`,
        [`${TEST_PREFIX}user_hrdenroll`]
      );
      assert.ok(enrollRes.rows.length > 0, 'Must have active enrollment');
      const key = enrollRes.rows[0].reference_photo_storage_key;
      assert.ok(key.startsWith('face-enrollment/'), 'Key must be private relative path');
      assert.ok(!key.startsWith('http'), 'Must not be a URL');
      assert.ok(!key.includes('gs://'), 'Must not contain gs://');
      ok('Test 13 (Storage key is private relative path).');
    } catch (e) { fail('Test 13', e.message); }

    // TEST 14: Re-enrollment preserves audit/history
    try {
      console.log('Test 14: Re-enrollment preserves audit/history...');
      const fx = await createFixture('history');
      await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, fx.token, { photo: { filename: 'face1.jpg', contentType: 'image/jpeg', buffer: createValidJpegBuffer(1024) } });
      await makeRequest(server, 'POST', `/api/hrd/employees/${fx.employee.id}/face-enrollment/reset`, { Authorization: `Bearer ${fx.token}`, 'Content-Type': 'application/json' }, { property_id: TEST_PROPERTY_ID });
      await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, fx.token, { photo: { filename: 'face2.jpg', contentType: 'image/jpeg', buffer: createValidJpegBuffer(2048) } });
      const historyRes = await client.query(`SELECT status FROM employee_face_enrollments WHERE employee_id = $1 ORDER BY created_at ASC`, [fx.employee.id]);
      const statuses = historyRes.rows.map(r => r.status);
      assert.ok(statuses.includes('REVOKED'), 'Must have REVOKED historical record');
      assert.ok(statuses.includes('ACTIVE'), 'Must have ACTIVE current record');
      ok('Test 14 (Re-enrollment preserves audit/history).');
    } catch (e) { fail('Test 14', e.message); }

    // TEST 15: Employee Mobile reads canonical enrollment state
    try {
      console.log('Test 15: Employee Mobile reads canonical enrollment-required state...');
      const fx = await createFixture('mobile');
      const mobileToken = generateToken({
        id: fx.user.id, username: fx.user.username, email: fx.user.email,
        role: 'Front Office', property_id: fx.user.property_id, scope: 'ONBOARDING',
        account_status: 'FACE_ENROLLMENT_REQUIRED', must_change_password: false, access_type: 'PMS_STAFF'
      });
      const res = await makeRequest(server, 'GET', '/api/employee-mobile/me/face-enrollment', { Authorization: `Bearer ${mobileToken}` });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.data.face_enrollment_required, true);
      assert.strictEqual(res.data.data.face_enrollment_status, 'NOT_ENROLLED');
      ok('Test 15 (Employee Mobile reads canonical enrollment state).');
    } catch (e) { fail('Test 15', e.message); }

    // TEST 16: GET face enrollment status returns correct data
    try {
      console.log('Test 16: GET face enrollment status returns correct data...');
      const fx = await createFixture('getstatus');
      await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, fx.token, { photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: createValidJpegBuffer(1024) } });
      const res = await makeRequest(server, 'GET', `/api/hrd/employees/${fx.employee.id}/face-enrollment?property_id=${TEST_PROPERTY_ID}`, { Authorization: `Bearer ${fx.token}` });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.data.face_enrollment_status, 'ENROLLED');
      assert.strictEqual(res.data.data.face_enrollment_label, 'Terdaftar');
      assert.ok(res.data.data.active_enrollment_id, 'Must have active enrollment ID');
      ok('Test 16 (GET face enrollment status correct).');
    } catch (e) { fail('Test 16', e.message); }

    // =========================================================================
    // SECURITY HARDENING TESTS
    // =========================================================================

    // TEST 17: Body-supplied property_id is ignored — token property_id is authoritative
    try {
      console.log('Test 17: Body-supplied property_id ignored, token property_id used...');
      const fx = await createFixture('propforged');
      // Enroll successfully first
      await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, fx.token, { photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: createValidJpegBuffer(1024) } });
      // Reset with body property_id = 999 (forged) — should still use token's property_id
      const res = await makeRequest(server, 'POST', `/api/hrd/employees/${fx.employee.id}/face-enrollment/reset`,
        { Authorization: `Bearer ${fx.token}`, 'Content-Type': 'application/json' },
        { property_id: 999, reason: 'SECURITY_TEST' });
      assert.strictEqual(res.status, 200, `Got ${res.status}: ${JSON.stringify(res.data)}`);
      // Verify account went back to FACE_ENROLLMENT_REQUIRED (proves token property was used)
      assert.strictEqual(res.data.data.account_status, 'FACE_ENROLLMENT_REQUIRED');
      ok('Test 17 (Body-supplied property_id ignored, token property_id authoritative).');
    } catch (e) { fail('Test 17', e.message); }

    // TEST 18: Body-supplied actor fields are ignored in reset — JWT actor is authoritative
    try {
      console.log('Test 18: Body-supplied actor fields ignored in reset, JWT actor authoritative...');
      const fx = await createFixture('actorforged');
      await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, fx.token, { photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: createValidJpegBuffer(1024) } });
      // Reset with forged actor fields in body
      const res = await makeRequest(server, 'POST', `/api/hrd/employees/${fx.employee.id}/face-enrollment/reset`,
        { Authorization: `Bearer ${fx.token}`, 'Content-Type': 'application/json' },
        { reason: 'SECURITY_TEST', actor_id: 99999, actor_name: 'FORGED_HACKER', actor_role: 'SUPER_ADMIN' });
      assert.strictEqual(res.status, 200, `Got ${res.status}`);
      // Check audit log — actor should NOT be FORGED_HACKER
      const auditRes = await client.query(
        `SELECT new_value FROM audit_logs WHERE entity = 'EMPLOYEE_FACE_ENROLLMENT' AND action = 'FACE_ENROLLMENT_RESET' AND record_id = $1`,
        [String(res.data.data.revoked_enrollment_id)]
      );
      if (auditRes.rows.length > 0) {
        const auditData = JSON.parse(auditRes.rows[0].new_value);
        assert.notStrictEqual(auditData.actor_name, 'FORGED_HACKER', 'Audit must not contain forged actor_name');
        assert.notStrictEqual(auditData.actor_user_id, 99999, 'Audit must not contain forged actor_user_id');
      }
      ok('Test 18 (Body-supplied actor fields ignored in reset, JWT actor authoritative).');
    } catch (e) { fail('Test 18', e.message); }

    // TEST 19: Unauthenticated request to employee-mobile gets 401 (not silent pass-through)
    try {
      console.log('Test 19: Unauthenticated request to employee-mobile gets 401...');
      const res = await makeRequest(server, 'GET', '/api/employee-mobile/me/face-enrollment', {});
      assert.strictEqual(res.status, 401, `Expected 401, got ${res.status}`);
      assert.strictEqual(res.data.code, 'UNAUTHORIZED');
      ok('Test 19 (Unauthenticated request to employee-mobile gets 401).');
    } catch (e) { fail('Test 19', e.message); }

    // TEST 20: isOnboardingAllowedPath uses exact-match for face-enrollment paths
    try {
      console.log('Test 20: isOnboardingAllowedPath exact-match for face-enrollment paths...');
      const { isOnboardingAllowedPath } = require('../dist/domains/auth/authMiddleware');
      // Exact face-enrollment paths must be allowed
      assert.strictEqual(isOnboardingAllowedPath('/api/auth/face-enrollment'), true, 'Exact /api/auth/face-enrollment must be allowed');
      assert.strictEqual(isOnboardingAllowedPath('/api/employee-mobile/me/face-enrollment'), true, 'Exact /api/employee-mobile/me/face-enrollment must be allowed');
      // Subpaths must be blocked (exact-match only for face-enrollment)
      assert.strictEqual(isOnboardingAllowedPath('/api/auth/face-enrollment/status'), false, 'Subpath /api/auth/face-enrollment/status must be blocked');
      assert.strictEqual(isOnboardingAllowedPath('/api/auth/face-enrollment/extra'), false, 'Subpath /api/auth/face-enrollment/extra must be blocked');
      assert.strictEqual(isOnboardingAllowedPath('/api/employee-mobile/me/face-enrollment/status'), false, 'Subpath /api/employee-mobile/me/face-enrollment/status must be blocked');
      // Non-face-enrollment paths still use prefix-match
      assert.strictEqual(isOnboardingAllowedPath('/api/auth/me'), true, '/api/auth/me must be allowed');
      assert.strictEqual(isOnboardingAllowedPath('/api/auth/logout'), true, '/api/auth/logout must be allowed');
      // Unknown paths must be blocked
      assert.strictEqual(isOnboardingAllowedPath('/api/hrd/employees/1/face-enrollment'), false, 'HRD path must be blocked for onboarding');
      ok('Test 20 (isOnboardingAllowedPath exact-match for face-enrollment paths).');
    } catch (e) { fail('Test 20', e.message); }

    // TEST 21: HRD status route ignores query property_id — uses token property only
    try {
      console.log('Test 21: HRD status route ignores query property_id...');
      const fx = await createFixture('queryprop');
      // Enroll in property 1
      await makeMultipartRequest(server, `/api/hrd/employees/${fx.employee.id}/face-enrollment`, fx.token, { photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: createValidJpegBuffer(1024) } });
      // Query with forged property_id=999 in query string — should still work using token's property
      const res = await makeRequest(server, 'GET', `/api/hrd/employees/${fx.employee.id}/face-enrollment?property_id=999`, { Authorization: `Bearer ${fx.token}` });
      assert.strictEqual(res.status, 200, `Got ${res.status}: ${JSON.stringify(res.data)}`);
      assert.strictEqual(res.data.data.face_enrollment_status, 'ENROLLED');
      ok('Test 21 (HRD status route ignores query property_id, uses token property).');
    } catch (e) { fail('Test 21', e.message); }

    console.log('========================================================================');
    console.log(`=== RESULTS: ${passed} passed, ${failed} failed =================================`);
    console.log('========================================================================\n');

    if (failed > 0) process.exit(1);

  } finally {
    await cleanupTestData(client).catch(() => {});
    client.release();
    await new Promise((resolve) => server.close(resolve));
  }
}

runHrdEnrollmentTests()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Test suite failed:', err); process.exit(1); });
