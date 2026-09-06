require('dotenv').config();
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const { getActiveFaceEnrollment } = require('../dist/domains/auth/faceEnrollmentService');
const { deleteAttendanceSelfie, isPrivateAttendanceSelfieKey } = require('../dist/domains/attendance/attendancePhotoStorageService');
const { resolveAbsolutePath } = require('../dist/domains/auth/faceEnrollmentStorageService');

const TEST_PREFIX = 'test_hr2d1_';
const TEST_PROPERTY_ID = 1;

function createValidJpegBuffer(sizeBytes = 512) {
  const header = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const filler = Buffer.alloc(Math.max(0, sizeBytes - header.length), 0x5A);
  return Buffer.concat([header, filler]);
}

function buildMultipartPayload(boundary, fields = {}, files = {}) {
  const parts = [];
  for (const [key, val] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`));
  }
  for (const [fieldName, file] of Object.entries(files)) {
    const filename = file.filename || 'selfie.jpg';
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

function makeMultipartRequest(server, urlPath, token, fields = {}, files = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const boundary = '----Hr2d1Boundary' + Math.random().toString(36).substring(2);
    const body = buildMultipartPayload(boundary, fields, files);
    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    };
    if (token) headers.Authorization = `Bearer ${token}`;
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
    const payload = body !== null && body !== undefined ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: reqHeaders }, (res) => {
      let raw = '';
      const chunks = [];
      res.on('data', (chunk) => {
        chunks.push(chunk);
        raw += chunk;
      });
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        try { resolve({ status: res.statusCode, data: JSON.parse(raw), buffer, headers: res.headers }); }
        catch { resolve({ status: res.statusCode, raw, buffer, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function cleanup(client) {
  const empRes = await client.query(
    `SELECT id FROM hr_employees WHERE employee_code LIKE $1 OR username LIKE $1 OR email LIKE $1`,
    [`${TEST_PREFIX}%`]
  );
  const empIds = empRes.rows.map((r) => r.id);
  if (empIds.length === 0) return;

  const keysRes = await client.query(
    `SELECT photo_storage_key FROM employee_attendance_records WHERE employee_id = ANY($1::int[])`,
    [empIds]
  );
  for (const row of keysRes.rows) {
    if (row.photo_storage_key) await deleteAttendanceSelfie(row.photo_storage_key).catch(() => {});
  }

  await client.query(`DELETE FROM employee_attendance_records WHERE employee_id = ANY($1::int[])`, [empIds]);
  await client.query(`DELETE FROM employee_attendance WHERE employee_id = ANY($1::int[])`, [empIds]);
  await client.query(`DELETE FROM employee_face_enrollments WHERE employee_id = ANY($1::int[])`, [empIds]);
  await client.query(`DELETE FROM users WHERE employee_id = ANY($1::int[]) OR username LIKE $2`, [empIds, `${TEST_PREFIX}%`]);
  await client.query(`DELETE FROM hr_employees WHERE id = ANY($1::int[])`, [empIds]);
  await client.query(`DELETE FROM properties WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
}

async function runTests() {
  console.log('=== AUTH-HR-2D1 ATTENDANCE IDENTITY & BIOMETRIC SECURITY FOUNDATION ===\n');
  const { initializeDatabase } = require('../dist/db/schema_v3');
  await initializeDatabase(pool);

  const client = await pool.connect();
  let server;
  try {
    await cleanup(client);

    const hkRole = await client.query(
      `SELECT id FROM roles WHERE name = 'Housekeeping' AND is_system_role = TRUE AND property_id IS NULL LIMIT 1`
    );
    const housekeepingRoleId = hkRole.rows[0]?.id;
    assert.ok(housekeepingRoleId, 'Housekeeping system role must exist');

    const saRes = await client.query(`
      SELECT u.id, u.username, u.full_name, u.email, u.property_id, r.id AS role_id, r.name AS role
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'Super Admin' AND r.property_id IS NULL AND r.is_system_role = TRUE
      LIMIT 1
    `);
    assert.ok(saRes.rows.length > 0, 'Platform Super Admin must exist');
    const superAdmin = saRes.rows[0];
    const superAdminToken = generateToken({
      id: Number(superAdmin.id),
      username: superAdmin.username,
      email: superAdmin.email,
      full_name: superAdmin.full_name,
      role: 'Super Admin',
      role_id: Number(superAdmin.role_id),
      property_id: Number(superAdmin.property_id || TEST_PROPERTY_ID),
      scope: 'FULL',
      access_type: 'ADMIN'
    });

    let foreignPropertyId;
    const existingForeign = await client.query('SELECT id FROM properties WHERE id <> $1 ORDER BY id LIMIT 1', [TEST_PROPERTY_ID]);
    if (existingForeign.rows.length > 0) {
      foreignPropertyId = Number(existingForeign.rows[0].id);
    } else {
      const created = await client.query(
        `INSERT INTO properties (name, is_active) VALUES ($1, TRUE) RETURNING id`,
        [`${TEST_PREFIX}foreign_property`]
      );
      foreignPropertyId = Number(created.rows[0].id);
    }

    async function createLinkedAccount(tag, propertyId) {
      const empRes = await client.query(
        `INSERT INTO hr_employees (
           property_id, employee_code, full_name, username, email, phone,
           department, position, is_active, status, hire_date
         ) VALUES ($1, $2, $3, $4, $5, $6, 'Housekeeping', 'Room Attendant', TRUE, 'ACTIVE', '2026-09-01')
         RETURNING id, property_id, full_name`,
        [
          propertyId,
          `${TEST_PREFIX}EMP_${tag}`,
          `Crew ${tag}`,
          `${TEST_PREFIX}user_${tag}`,
          `${TEST_PREFIX}user_${tag}@oakhotel.test`,
          '081234567890'
        ]
      );
      const employee = empRes.rows[0];
      const userRes = await client.query(
        `INSERT INTO users (
           username, email, password_hash, role_id, property_id, employee_id,
           is_active, account_status, must_change_password, full_name, access_type
         ) VALUES ($1, $2, 'dummy_hash', $3, $4, $5, TRUE, 'READY', FALSE, $6, 'MOBILE_ONLY')
         RETURNING id, username, email, property_id, employee_id, role_id`,
        [
          `${TEST_PREFIX}user_${tag}`,
          `${TEST_PREFIX}user_${tag}@oakhotel.test`,
          housekeepingRoleId,
          propertyId,
          employee.id,
          `Crew ${tag}`
        ]
      );
      const user = userRes.rows[0];
      assert.notStrictEqual(Number(user.id), Number(employee.id), 'Fixture must have users.id != employee_id');
      const token = generateToken({
        id: Number(user.id),
        username: user.username,
        email: user.email,
        full_name: `Crew ${tag}`,
        role: 'Housekeeping',
        role_id: Number(user.role_id),
        property_id: Number(user.property_id),
        scope: 'FULL',
        account_status: 'READY',
        access_type: 'MOBILE_ONLY'
      });
      return { employee, user, token };
    }

    const accA = await createLinkedAccount('a', TEST_PROPERTY_ID);
    const accB = await createLinkedAccount('b', TEST_PROPERTY_ID);
    const accC = await createLinkedAccount('c', foreignPropertyId);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    await client.query(
      `INSERT INTO property_attendance_settings (
         property_id, attendance_enabled, require_employee_attendance,
         require_checkin_photo, require_checkout_photo, geofence_enabled
       ) VALUES ($1, TRUE, TRUE, TRUE, FALSE, FALSE)
       ON CONFLICT (property_id) DO UPDATE SET
         attendance_enabled = TRUE,
         require_checkin_photo = TRUE,
         require_checkout_photo = FALSE,
         geofence_enabled = FALSE`,
      [TEST_PROPERTY_ID]
    );
    await client.query(
      `INSERT INTO property_features (property_id, feature_key, enabled)
       VALUES ($1, 'hrd.enabled', TRUE), ($1, 'hrd.attendance', TRUE), ($1, 'hrd.attendance_photo', TRUE)
       ON CONFLICT (property_id, feature_key) DO UPDATE SET enabled = TRUE`,
      [TEST_PROPERTY_ID]
    );

    console.log('Test 1: users.id != employee_id still clocks against canonical employee_id...');
    const selfieA = createValidJpegBuffer(640);
    const checkInA = await makeMultipartRequest(
      server,
      '/api/attendance/check-in',
      accA.token,
      { property_id: String(TEST_PROPERTY_ID), employee_id: String(accA.user.id) },
      { photo: { filename: 'selfie_a.jpg', contentType: 'image/jpeg', buffer: selfieA } }
    );
    assert.strictEqual(checkInA.status, 201, `Expected 201, got ${checkInA.status}: ${JSON.stringify(checkInA.data)}`);
    assert.strictEqual(Number(checkInA.data.data.employee_id), Number(accA.employee.id));
    assert.notStrictEqual(Number(checkInA.data.data.employee_id), Number(accA.user.id));
    assert.strictEqual(checkInA.data.data.face_status, 'NOT_PROCESSED');
    assert.strictEqual(checkInA.data.data.liveness_status, 'NOT_PROCESSED');
    assert.notStrictEqual(checkInA.data.data.face_status, 'VERIFIED');
    assert.ok(!['MATCH', 'VERIFIED'].includes(String(checkInA.data.data.face_status)));
    console.log('✓ PASS: Test 1 (canonical employee_id used; users.id ignored as authority).\n');

    console.log('Test 2: employee A cannot submit attendance for employee B...');
    const impersonate = await makeMultipartRequest(
      server,
      '/api/attendance/check-in',
      accA.token,
      { property_id: String(TEST_PROPERTY_ID), employee_id: String(accB.employee.id) },
      { photo: { filename: 'stolen.jpg', contentType: 'image/jpeg', buffer: createValidJpegBuffer(400) } }
    );
    assert.strictEqual(impersonate.status, 403, `Expected 403, got ${impersonate.status}: ${JSON.stringify(impersonate.data)}`);
    assert.strictEqual(impersonate.data.code, 'EMPLOYEE_IMPERSONATION_FORBIDDEN');
    const bRecords = await client.query(
      `SELECT id FROM employee_attendance_records WHERE employee_id = $1`,
      [accB.employee.id]
    );
    assert.strictEqual(bRecords.rows.length, 0, 'Employee B must have no attendance written by A');
    console.log('✓ PASS: Test 2 (impersonation rejected).\n');

    console.log('Test 3: cross-property clock-in is rejected...');
    const cross = await makeMultipartRequest(
      server,
      '/api/attendance/check-in',
      accA.token,
      { property_id: String(foreignPropertyId) },
      { photo: { filename: 'cross.jpg', contentType: 'image/jpeg', buffer: createValidJpegBuffer(400) } }
    );
    assert.strictEqual(cross.status, 403, `Expected 403, got ${cross.status}: ${JSON.stringify(cross.data)}`);
    assert.strictEqual(cross.data.code, 'CROSS_PROPERTY_FORBIDDEN');
    console.log('✓ PASS: Test 3 (cross-property rejected).\n');

    console.log('Test 4: new selfie is private, hashed, and not under /uploads...');
    const stored = checkInA.data.data;
    assert.ok(stored.photo_storage_key, 'photo_storage_key must be stored');
    assert.ok(isPrivateAttendanceSelfieKey(stored.photo_storage_key), 'new selfie must use attendance-selfie/ prefix');
    assert.ok(
      stored.photo_storage_key.startsWith(`attendance-selfie/${TEST_PROPERTY_ID}/${accA.employee.id}/`),
      'storage key must be property + employee scoped'
    );
    assert.ok(!stored.photo_storage_key.startsWith('/uploads'), 'must not persist a public /uploads URL');
    assert.ok(!String(stored.photo_storage_key).includes('/uploads/'), 'storage key must not contain /uploads/');
    assert.ok(stored.photo_hash && stored.photo_hash.length === 64, 'SHA-256 hash must be 64 hex chars');
    assert.ok(stored.photo_mime_type === 'image/jpeg', 'MIME type must be persisted');
    assert.ok(stored.photo_captured_at, 'captured timestamp must be persisted');

    const absPath = resolveAbsolutePath(stored.photo_storage_key);
    assert.ok(fs.existsSync(absPath), 'private local object must exist');
    assert.ok(!absPath.replace(/\\/g, '/').includes('/uploads/attendance/'), 'file must not live under public uploads');
    const publicGuess = path.resolve(__dirname, '../uploads', stored.photo_storage_key);
    assert.strictEqual(fs.existsSync(publicGuess), false, 'object must not be reachable via uploads path');
    console.log('✓ PASS: Test 4 (private storage + hash).\n');

    console.log('Test 5: authenticated owner can stream own selfie...');
    const ownerPhoto = await makeRequest(
      server,
      'GET',
      `/api/attendance/records/${stored.id}/photo`,
      { Authorization: `Bearer ${accA.token}` }
    );
    assert.strictEqual(ownerPhoto.status, 200, `Owner photo expected 200, got ${ownerPhoto.status}`);
    assert.ok(ownerPhoto.buffer && ownerPhoto.buffer.length > 0, 'photo bytes must be returned');
    assert.ok(String(ownerPhoto.headers['cache-control'] || '').includes('private'), 'photo cache must be private');
    console.log('✓ PASS: Test 5 (owner photo access).\n');

    console.log('Test 6: unauthorized employee cannot fetch another selfie...');
    const peerPhoto = await makeRequest(
      server,
      'GET',
      `/api/attendance/records/${stored.id}/photo`,
      { Authorization: `Bearer ${accB.token}` }
    );
    assert.strictEqual(peerPhoto.status, 403, `Peer photo expected 403, got ${peerPhoto.status}`);
    assert.strictEqual(peerPhoto.data.code, 'FORBIDDEN');
    console.log('✓ PASS: Test 6 (peer selfie access denied).\n');

    console.log('Test 7: Super Admin can fetch employee selfie...');
    const adminPhoto = await makeRequest(
      server,
      'GET',
      `/api/attendance/records/${stored.id}/photo`,
      { Authorization: `Bearer ${superAdminToken}` }
    );
    assert.strictEqual(adminPhoto.status, 200, `Admin photo expected 200, got ${adminPhoto.status}`);
    console.log('✓ PASS: Test 7 (admin photo access).\n');

    console.log('Test 8: canonical work-cycle dual-write stays NOT_PROCESSED...');
    const cycleRes = await client.query(
      `SELECT * FROM employee_attendance WHERE property_id = $1 AND employee_id = $2`,
      [TEST_PROPERTY_ID, accA.employee.id]
    );
    assert.strictEqual(cycleRes.rows.length, 1, 'exactly one canonical attendance row');
    assert.strictEqual(cycleRes.rows[0].clock_in_face_status, 'NOT_PROCESSED');
    assert.strictEqual(cycleRes.rows[0].clock_in_liveness_status, 'NOT_PROCESSED');
    assert.strictEqual(cycleRes.rows[0].clock_in_photo_hash, stored.photo_hash);
    assert.ok(isPrivateAttendanceSelfieKey(cycleRes.rows[0].clock_in_photo_storage_key));
    console.log('✓ PASS: Test 8 (canonical row exists; no biometric claim).\n');

    console.log('Test 9: status ignores client employee_id and binds to JWT employee...');
    const statusRes = await makeRequest(
      server,
      'GET',
      `/api/attendance/status?property_id=${TEST_PROPERTY_ID}&employee_id=${accB.employee.id}`,
      { Authorization: `Bearer ${accA.token}` }
    );
    assert.strictEqual(statusRes.status, 403);
    assert.strictEqual(statusRes.data.code, 'EMPLOYEE_IMPERSONATION_FORBIDDEN');

    const ownStatus = await makeRequest(
      server,
      'GET',
      `/api/attendance/status?property_id=${TEST_PROPERTY_ID}`,
      { Authorization: `Bearer ${accA.token}` }
    );
    assert.strictEqual(ownStatus.status, 200);
    assert.strictEqual(Number(ownStatus.data.data.employee_id), Number(accA.employee.id));
    assert.strictEqual(ownStatus.data.data.has_checked_in, true);
    assert.strictEqual(ownStatus.data.data.check_in_record.face_status, 'NOT_PROCESSED');
    console.log('✓ PASS: Test 9 (status identity authoritative).\n');

    console.log('Test 10: unauthenticated clock-in is rejected...');
    const anon = await makeMultipartRequest(
      server,
      '/api/attendance/check-in',
      null,
      { property_id: String(TEST_PROPERTY_ID) },
      { photo: { filename: 'anon.jpg', contentType: 'image/jpeg', buffer: createValidJpegBuffer(300) } }
    );
    assert.strictEqual(anon.status, 401);
    console.log('✓ PASS: Test 10 (unauthenticated rejected).\n');

    console.log('Test 11: face enrollment lookup remains unchanged...');
    const activeFace = await getActiveFaceEnrollment(pool, TEST_PROPERTY_ID, Number(accA.employee.id));
    assert.strictEqual(activeFace, null, '2D1 must not invent an enrollment');
    console.log('✓ PASS: Test 11 (enrollment helper unchanged).\n');

    console.log('Test 12: foreign-property employee cannot clock into property 1...');
    const foreignIn = await makeMultipartRequest(
      server,
      '/api/attendance/check-in',
      accC.token,
      { property_id: String(TEST_PROPERTY_ID) },
      { photo: { filename: 'foreign.jpg', contentType: 'image/jpeg', buffer: createValidJpegBuffer(300) } }
    );
    assert.strictEqual(foreignIn.status, 403);
    assert.strictEqual(foreignIn.data.code, 'CROSS_PROPERTY_FORBIDDEN');
    console.log('✓ PASS: Test 12 (foreign employee blocked from property 1).\n');

    console.log('=============================================');
    console.log('ALL AUTH-HR-2D1 SECURITY FOUNDATION TESTS PASSED');
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
