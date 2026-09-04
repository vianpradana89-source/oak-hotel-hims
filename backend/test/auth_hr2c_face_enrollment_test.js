// backend/test/auth_hr2c_face_enrollment_test.js
require('dotenv').config();
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const {
  resolveAbsolutePath,
  deleteFaceEnrollmentPhoto,
  saveFaceEnrollmentPhoto,
  calculatePhotoHash,
  LocalStorageAdapter,
  GcsStorageAdapter,
  setStorageAdapterForTesting,
  getActiveStorageProvider,
  getStorageAdapter
} = require('../dist/domains/auth/faceEnrollmentStorageService');
const { enrollFace } = require('../dist/domains/auth/faceEnrollmentService');

const TEST_PREFIX = 'test_hr2c_';
const TEST_PROPERTY_ID = 1;

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

// Generates valid dummy image buffers with correct magic bytes
function createValidJpegBuffer(sizeBytes = 256) {
  const header = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const filler = Buffer.alloc(Math.max(0, sizeBytes - header.length), 0x5A);
  return Buffer.concat([header, filler]);
}

function createValidPngBuffer(sizeBytes = 256) {
  const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const filler = Buffer.alloc(Math.max(0, sizeBytes - header.length), 0x7E);
  return Buffer.concat([header, filler]);
}

function createValidWebpBuffer(sizeBytes = 256) {
  const riff = Buffer.from('RIFF');
  const sizeField = Buffer.alloc(4, 0x00);
  const webp = Buffer.from('WEBP');
  const header = Buffer.concat([riff, sizeField, webp]);
  const filler = Buffer.alloc(Math.max(0, sizeBytes - header.length), 0x3C);
  return Buffer.concat([header, filler]);
}

async function cleanupTestData(client) {
  // Find storage keys to clean
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

  await client.query("DELETE FROM audit_logs WHERE correlation_id LIKE $1 OR correlation_id LIKE $2", [`%${TEST_PREFIX}%`, '%test_hr2c%']);
  await client.query("DELETE FROM users WHERE email LIKE $1 OR username LIKE $1", [`%${TEST_PREFIX}%`]);
  await client.query("DELETE FROM hr_employees WHERE email LIKE $1 OR username LIKE $1 OR employee_code LIKE $1", [`%${TEST_PREFIX}%`]);
}

async function runFaceEnrollmentTests() {
  console.log('========================================================================');
  console.log('=== OAK HIMS — AUTH-HR-2C FACE ENROLLMENT TEST SUITE ===================');
  console.log('========================================================================\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`Test server running on port ${port}\n`);

  const client = await pool.connect();

  try {
    await cleanupTestData(client);

    // Get a department and position
    const deptRes = await client.query('SELECT id FROM hr_departments LIMIT 1');
    const posRes = await client.query('SELECT id FROM hr_positions LIMIT 1');
    const defaultDeptId = deptRes.rows[0]?.id || 1;
    const defaultPosId = posRes.rows[0]?.id || 1;

    // Helper to create an employee + user in FACE_ENROLLMENT_REQUIRED state
    async function createTestAccount(tag, custom = {}) {
      const empRes = await client.query(
        `INSERT INTO hr_employees (
           property_id, employee_code, full_name, username, email, phone,
           department_id, position_id, is_active, hire_date
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, '2026-09-01')
         RETURNING id, property_id, full_name, department_id, position_id`,
        [
          custom.property_id || TEST_PROPERTY_ID,
          `${TEST_PREFIX}EMP_${tag}`,
          `Test User ${tag}`,
          `${TEST_PREFIX}user_${tag}`,
          `${TEST_PREFIX}user_${tag}@oakhotel.test`,
          '081234567890',
          custom.department_id || defaultDeptId,
          custom.position_id || defaultPosId
        ]
      );
      const employee = empRes.rows[0];

      const userRes = await client.query(
        `INSERT INTO users (
           username, email, password_hash, role_id, property_id, employee_id,
           is_active, account_status, must_change_password, full_name, access_type
         ) VALUES ($1, $2, 'dummy_hash', 1, $3, $4, true, $5, false, $6, $7)
         RETURNING id, username, email, property_id, employee_id, role_id, account_status, access_type`,
        [
          `${TEST_PREFIX}user_${tag}`,
          `${TEST_PREFIX}user_${tag}@oakhotel.test`,
          custom.user_property_id || TEST_PROPERTY_ID,
          custom.unlink_employee ? null : employee.id,
          custom.account_status || 'FACE_ENROLLMENT_REQUIRED',
          `Test User ${tag}`,
          custom.access_type || 'PMS_STAFF'
        ]
      );
      const user = userRes.rows[0];

      const token = generateToken({
        id: user.id,
        username: user.username,
        email: user.email,
        role: 'Front Office',
        property_id: user.property_id,
        scope: custom.scope || 'ONBOARDING',
        account_status: user.account_status,
        must_change_password: false,
        access_type: user.access_type
      });

      return { employee, user, token };
    }

    // -------------------------------------------------------------
    // Test A: FACE_ENROLLMENT_REQUIRED user can access face enrollment endpoint
    // -------------------------------------------------------------
    console.log('Test A: FACE_ENROLLMENT_REQUIRED user can access face enrollment endpoint...');
    const accA = await createTestAccount('a');
    const validJpgA = createValidJpegBuffer(1024);
    const resA = await makeMultipartRequest(server, '/api/auth/face-enrollment', accA.token, {}, {
      photo: { filename: 'face_a.jpg', contentType: 'image/jpeg', buffer: validJpgA }
    });
    assert.strictEqual(resA.status, 200, `Expected 200, got ${resA.status}: ${JSON.stringify(resA.data)}`);
    assert.strictEqual(resA.data.status, 'OK');
    assert.strictEqual(resA.data.data.account_status, 'READY');
    console.log('✓ PASS: Test A (FACE_ENROLLMENT_REQUIRED user access granted).\n');

    // -------------------------------------------------------------
    // Test B: ONBOARDING user still cannot access unrelated PMS operational endpoint
    // -------------------------------------------------------------
    console.log('Test B: ONBOARDING user still cannot access unrelated PMS operational endpoint...');
    const accB = await createTestAccount('b');
    const resB = await makeRequest(server, 'GET', `/api/hrd/employees?property_id=${TEST_PROPERTY_ID}`, {
      Authorization: `Bearer ${accB.token}`
    });
    assert.strictEqual(resB.status, 403, `Expected 403, got ${resB.status}`);
    assert.strictEqual(resB.data.code, 'ACCOUNT_ONBOARDING_INCOMPLETE');
    console.log('✓ PASS: Test B (ONBOARDING user blocked from PMS operational endpoint).\n');

    // -------------------------------------------------------------
    // Test C: User without employee link is rejected with EMPLOYEE_LINK_REQUIRED
    // -------------------------------------------------------------
    console.log('Test C: User without employee link is rejected with EMPLOYEE_LINK_REQUIRED...');
    const accC = await createTestAccount('c', { unlink_employee: true });
    const validJpgC = createValidJpegBuffer(1024);
    const resC = await makeMultipartRequest(server, '/api/auth/face-enrollment', accC.token, {}, {
      photo: { filename: 'face_c.jpg', contentType: 'image/jpeg', buffer: validJpgC }
    });
    assert.strictEqual(resC.status, 400, `Expected 400, got ${resC.status}`);
    assert.strictEqual(resC.data.code, 'EMPLOYEE_LINK_REQUIRED');
    console.log('✓ PASS: Test C (Unlinked user rejected with EMPLOYEE_LINK_REQUIRED).\n');

    // -------------------------------------------------------------
    // Test D: Employee / property mismatch is rejected with PROPERTY_MISMATCH
    // -------------------------------------------------------------
    console.log('Test D: Employee / property mismatch is rejected with PROPERTY_MISMATCH...');
    // Create property 2 if not exists
    await client.query("INSERT INTO properties (id, name, property_code) VALUES (2, 'Property 2', 'PROP02') ON CONFLICT (id) DO NOTHING");
    const accD = await createTestAccount('d', { property_id: 2, user_property_id: 1 });
    const validJpgD = createValidJpegBuffer(1024);
    const resD = await makeMultipartRequest(server, '/api/auth/face-enrollment', accD.token, {}, {
      photo: { filename: 'face_d.jpg', contentType: 'image/jpeg', buffer: validJpgD }
    });
    assert.strictEqual(resD.status, 400, `Expected 400, got ${resD.status}`);
    assert.strictEqual(resD.data.code, 'PROPERTY_MISMATCH');
    console.log('✓ PASS: Test D (Property mismatch rejected with PROPERTY_MISMATCH).\n');

    // -------------------------------------------------------------
    // Test E: Missing photo is rejected with FILE_REQUIRED
    // -------------------------------------------------------------
    console.log('Test E: Missing photo is rejected with FILE_REQUIRED...');
    const accE = await createTestAccount('e');
    const resE = await makeMultipartRequest(server, '/api/auth/face-enrollment', accE.token, {}, {});
    assert.strictEqual(resE.status, 400, `Expected 400, got ${resE.status}`);
    assert.strictEqual(resE.data.code, 'FILE_REQUIRED');
    console.log('✓ PASS: Test E (Missing photo rejected with FILE_REQUIRED).\n');

    // -------------------------------------------------------------
    // Test F: Unsupported MIME type is rejected with UNSUPPORTED_MIME_TYPE
    // -------------------------------------------------------------
    console.log('Test F: Unsupported MIME type (PDF) is rejected with UNSUPPORTED_MIME_TYPE...');
    const accF = await createTestAccount('f');
    const pdfBuffer = Buffer.from('%PDF-1.4 dummy pdf document content');
    const resF = await makeMultipartRequest(server, '/api/auth/face-enrollment', accF.token, {}, {
      photo: { filename: 'doc.pdf', contentType: 'application/pdf', buffer: pdfBuffer }
    });
    assert.strictEqual(resF.status, 400, `Expected 400, got ${resF.status}`);
    assert.strictEqual(resF.data.code, 'UNSUPPORTED_MIME_TYPE');
    console.log('✓ PASS: Test F (Unsupported MIME type rejected with UNSUPPORTED_MIME_TYPE).\n');

    // -------------------------------------------------------------
    // Test G: Empty file is rejected with EMPTY_FILE
    // -------------------------------------------------------------
    console.log('Test G: Empty file is rejected with EMPTY_FILE...');
    const accG = await createTestAccount('g');
    const emptyBuffer = Buffer.alloc(0);
    const resG = await makeMultipartRequest(server, '/api/auth/face-enrollment', accG.token, {}, {
      photo: { filename: 'empty.jpg', contentType: 'image/jpeg', buffer: emptyBuffer }
    });
    assert.strictEqual(resG.status, 400, `Expected 400, got ${resG.status}`);
    assert.strictEqual(resG.data.code, 'EMPTY_FILE');
    console.log('✓ PASS: Test G (Empty file rejected with EMPTY_FILE).\n');

    // -------------------------------------------------------------
    // Test H: Oversized file is rejected with FILE_TOO_LARGE
    // -------------------------------------------------------------
    console.log('Test H: Oversized file (> 5MB) is rejected with FILE_TOO_LARGE...');
    const accH = await createTestAccount('h');
    const bigJpg = createValidJpegBuffer(5.2 * 1024 * 1024);
    const resH = await makeMultipartRequest(server, '/api/auth/face-enrollment', accH.token, {}, {
      photo: { filename: 'big.jpg', contentType: 'image/jpeg', buffer: bigJpg }
    });
    assert.strictEqual(resH.status, 400, `Expected 400, got ${resH.status}`);
    assert.strictEqual(resH.data.code, 'FILE_TOO_LARGE');
    console.log('✓ PASS: Test H (Oversized file rejected with FILE_TOO_LARGE).\n');

    // -------------------------------------------------------------
    // Test I: Valid image creates face enrollment row
    // -------------------------------------------------------------
    console.log('Test I: Valid image creates face enrollment row...');
    const accI = await createTestAccount('i');
    const validJpgI = createValidJpegBuffer(2048);
    const resI = await makeMultipartRequest(server, '/api/auth/face-enrollment', accI.token, {}, {
      photo: { filename: 'face_i.jpg', contentType: 'image/jpeg', buffer: validJpgI }
    });
    assert.strictEqual(resI.status, 200, `Expected 200, got ${resI.status}`);
    const enrollIdI = resI.data.data.enrollment.id;
    assert.ok(enrollIdI, 'Must return enrollment id');

    const dbEnrollI = await client.query(
      'SELECT * FROM employee_face_enrollments WHERE id = $1',
      [enrollIdI]
    );
    assert.strictEqual(dbEnrollI.rows.length, 1, 'Row must exist in employee_face_enrollments');
    assert.strictEqual(dbEnrollI.rows[0].status, 'ACTIVE');
    assert.strictEqual(dbEnrollI.rows[0].quality_status, 'VALID_BASIC');
    assert.strictEqual(dbEnrollI.rows[0].review_status, 'AUTO_ACCEPTED');
    console.log('✓ PASS: Test I (Valid image creates face enrollment row).\n');

    // -------------------------------------------------------------
    // Test J: Stored row uses authenticated user's employee_id
    // -------------------------------------------------------------
    console.log("Test J: Stored row uses authenticated user's employee_id...");
    assert.strictEqual(Number(dbEnrollI.rows[0].employee_id), Number(accI.employee.id));
    console.log("✓ PASS: Test J (Stored row uses authenticated user's employee_id).\n");

    // -------------------------------------------------------------
    // Test K: Stored row uses correct property_id
    // -------------------------------------------------------------
    console.log('Test K: Stored row uses correct property_id...');
    assert.strictEqual(Number(dbEnrollI.rows[0].property_id), TEST_PROPERTY_ID);
    console.log('✓ PASS: Test K (Stored row uses correct property_id).\n');

    // -------------------------------------------------------------
    // Test L: reference_photo_storage_key is private relative key, not public URL
    // -------------------------------------------------------------
    console.log('Test L: reference_photo_storage_key is private relative key, not public URL...');
    const storageKey = dbEnrollI.rows[0].reference_photo_storage_key;
    assert.ok(storageKey, 'Storage key must be present');
    assert.ok(storageKey.startsWith('face-enrollment/'), `Must start with face-enrollment/, got: ${storageKey}`);
    assert.ok(!storageKey.startsWith('/uploads'), 'Must not start with /uploads');
    assert.ok(!storageKey.startsWith('http'), 'Must not be a URL');
    assert.ok(!path.isAbsolute(storageKey), 'Must not be an absolute filesystem path');
    const resolvedPath = resolveAbsolutePath(storageKey);
    assert.ok(fs.existsSync(resolvedPath), 'File must exist on disk at private storage location');
    console.log('✓ PASS: Test L (Storage key is private relative key).\n');

    // -------------------------------------------------------------
    // Test M: reference_photo_hash is generated (SHA-256)
    // -------------------------------------------------------------
    console.log('Test M: reference_photo_hash is generated (SHA-256)...');
    const expectedHash = crypto.createHash('sha256').update(validJpgI).digest('hex');
    assert.strictEqual(dbEnrollI.rows[0].reference_photo_hash, expectedHash, 'Hash must match SHA-256 of uploaded buffer');
    console.log('✓ PASS: Test M (reference_photo_hash correctly generated).\n');

    // -------------------------------------------------------------
    // Test N: Successful enrollment changes account_status to READY
    // -------------------------------------------------------------
    console.log('Test N: Successful enrollment changes account_status to READY...');
    const dbUserI = await client.query('SELECT account_status FROM users WHERE id = $1', [accI.user.id]);
    assert.strictEqual(dbUserI.rows[0].account_status, 'READY');
    console.log('✓ PASS: Test N (Account status changed to READY).\n');

    // -------------------------------------------------------------
    // Test O: Successful enrollment returns refreshed non-ONBOARDING token (scope = FULL)
    // -------------------------------------------------------------
    console.log('Test O: Successful enrollment returns refreshed non-ONBOARDING token...');
    const refreshedToken = resI.data.data.token;
    assert.ok(refreshedToken, 'Refreshed token must be returned');
    assert.strictEqual(resI.data.data.user.scope, 'FULL');
    assert.strictEqual(resI.data.data.user.account_status, 'READY');

    // Verify refreshed token can now access PMS
    const pmsAccess = await makeRequest(server, 'GET', `/api/hrd/employees?property_id=${TEST_PROPERTY_ID}`, {
      Authorization: `Bearer ${refreshedToken}`
    });
    assert.strictEqual(pmsAccess.status, 200, 'Refreshed FULL token must access PMS');
    console.log('✓ PASS: Test O (Refreshed token has scope = FULL and can access PMS).\n');

    // -------------------------------------------------------------
    // Test P: Successful enrollment creates audit event
    // -------------------------------------------------------------
    console.log('Test P: Successful enrollment creates audit event...');
    const auditRes = await client.query(
      `SELECT * FROM audit_logs
       WHERE module = 'AUTH' AND action = 'FACE_ENROLLMENT_CREATED' AND entity = 'EMPLOYEE_FACE_ENROLLMENT'
         AND record_id = $1`,
      [String(enrollIdI)]
    );
    assert.strictEqual(auditRes.rows.length, 1, 'Audit log row must exist');
    const auditPayload = JSON.parse(auditRes.rows[0].new_value);
    assert.strictEqual(auditPayload.user_id, accI.user.id);
    assert.strictEqual(auditPayload.employee_id, accI.employee.id);
    assert.strictEqual(auditPayload.new_status, 'READY');
    assert.strictEqual(auditPayload.quality_status, 'VALID_BASIC');
    console.log('✓ PASS: Test P (Audit event FACE_ENROLLMENT_CREATED created).\n');

    // -------------------------------------------------------------
    // Test Q: Duplicate normal onboarding enrollment is rejected with FACE_ENROLLMENT_ALREADY_COMPLETED
    // -------------------------------------------------------------
    console.log('Test Q: Duplicate normal onboarding enrollment is rejected with FACE_ENROLLMENT_ALREADY_COMPLETED...');
    const resQ = await makeMultipartRequest(server, '/api/auth/face-enrollment', refreshedToken, {}, {
      photo: { filename: 'face_q.jpg', contentType: 'image/jpeg', buffer: validJpgI }
    });
    assert.strictEqual(resQ.status, 409, `Expected 409, got ${resQ.status}`);
    assert.strictEqual(resQ.data.code, 'FACE_ENROLLMENT_ALREADY_COMPLETED');
    console.log('✓ PASS: Test Q (Duplicate enrollment rejected with 409 FACE_ENROLLMENT_ALREADY_COMPLETED).\n');

    // -------------------------------------------------------------
    // Test R: Concurrent/duplicate request cannot produce multiple usable master records
    // -------------------------------------------------------------
    console.log('Test R: Concurrent request cannot produce multiple usable master records...');
    const accR = await createTestAccount('r');
    const validJpgR = createValidJpegBuffer(2048);

    // Fire 2 concurrent enrollment requests simultaneously
    const [concurrentRes1, concurrentRes2] = await Promise.all([
      makeMultipartRequest(server, '/api/auth/face-enrollment', accR.token, {}, {
        photo: { filename: 'face_r1.jpg', contentType: 'image/jpeg', buffer: validJpgR }
      }),
      makeMultipartRequest(server, '/api/auth/face-enrollment', accR.token, {}, {
        photo: { filename: 'face_r2.jpg', contentType: 'image/jpeg', buffer: validJpgR }
      })
    ]);

    const statuses = [concurrentRes1.status, concurrentRes2.status].sort();
    assert.strictEqual(statuses[0], 200, 'One concurrent request must succeed with 200');
    assert.strictEqual(statuses[1], 409, 'The second concurrent request must be rejected with 409');

    // Verify DB invariant: exactly 1 active enrollment record exists
    const enrollCountR = await client.query(
      "SELECT count(*)::int AS count FROM employee_face_enrollments WHERE employee_id = $1 AND status = 'ACTIVE'",
      [accR.employee.id]
    );
    assert.strictEqual(enrollCountR.rows[0].count, 1, 'Exactly one ACTIVE record must exist');
    console.log('✓ PASS: Test R (Concurrent requests safe, exactly 1 active record created).\n');

    // -------------------------------------------------------------
    // Test S: DB failure does not leave account READY
    // -------------------------------------------------------------
    console.log('Test S: DB failure does not leave account READY...');
    const accS = await createTestAccount('s');
    const validJpgS = createValidJpegBuffer(1024);

    // Simulate DB failure by passing a mock pool with failing client
    const mockClient = {
      query: async (sql) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO employee_face_enrollments')) {
          throw new Error('Simulated DB failure on insert');
        }
        return client.query(sql);
      },
      release: () => {}
    };
    const mockPool = {
      query: (sql, params) => client.query(sql, params),
      connect: async () => mockClient
    };

    let caughtS = false;
    try {
      await enrollFace(mockPool, accS.user.id, {
        fieldname: 'photo',
        originalname: 'face_s.jpg',
        mimetype: 'image/jpeg',
        size: validJpgS.length,
        buffer: validJpgS
      });
    } catch (err) {
      caughtS = true;
    }
    assert.ok(caughtS, 'Should throw error on DB failure');

    const dbUserS = await client.query('SELECT account_status FROM users WHERE id = $1', [accS.user.id]);
    assert.strictEqual(dbUserS.rows[0].account_status, 'FACE_ENROLLMENT_REQUIRED', 'Account must NOT be READY after DB failure');
    console.log('✓ PASS: Test S (DB failure rolls back, account remains FACE_ENROLLMENT_REQUIRED).\n');

    // -------------------------------------------------------------
    // Test T: DB failure after file save cleans orphan file where practical
    // -------------------------------------------------------------
    console.log('Test T: DB failure after file save cleans orphan file...');
    const accT = await createTestAccount('t');
    const validJpgT = createValidJpegBuffer(1024);

    let savedFileStorageKey = null;
    const mockClientT = {
      query: async (sql, params) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO employee_face_enrollments')) {
          savedFileStorageKey = params[2]; // capture storageKey
          throw new Error('Simulated DB failure in transaction');
        }
        return client.query(sql, params);
      },
      release: () => {}
    };
    const mockPoolT = {
      query: (sql, params) => client.query(sql, params),
      connect: async () => mockClientT
    };

    let caughtT = false;
    try {
      await enrollFace(mockPoolT, accT.user.id, {
        fieldname: 'photo',
        originalname: 'face_t.jpg',
        mimetype: 'image/jpeg',
        size: validJpgT.length,
        buffer: validJpgT
      });
    } catch (err) {
      caughtT = true;
    }
    assert.ok(caughtT, 'Should throw error on simulated failure');
    assert.ok(savedFileStorageKey, 'Storage key must have been captured');

    const orphanDiskPath = resolveAbsolutePath(savedFileStorageKey);
    assert.strictEqual(fs.existsSync(orphanDiskPath), false, 'Orphan file must be deleted from disk upon rollback');
    console.log('✓ PASS: Test T (Orphan file successfully cleaned from disk upon DB failure).\n');

    // -------------------------------------------------------------
    // Test U: Enrollment does not create attendance record
    // -------------------------------------------------------------
    console.log('Test U: Enrollment does not create attendance record...');
    const accU = await createTestAccount('u');
    const countBeforeU = await client.query('SELECT count(*)::int AS count FROM employee_attendance_records');
    const validJpgU = createValidJpegBuffer(1024);
    const resU = await makeMultipartRequest(server, '/api/auth/face-enrollment', accU.token, {}, {
      photo: { filename: 'face_u.jpg', contentType: 'image/jpeg', buffer: validJpgU }
    });
    assert.strictEqual(resU.status, 200);
    const countAfterU = await client.query('SELECT count(*)::int AS count FROM employee_attendance_records');
    assert.strictEqual(countAfterU.rows[0].count, countBeforeU.rows[0].count, 'Attendance record count must not change');
    console.log('✓ PASS: Test U (Attendance records unchanged).\n');

    // -------------------------------------------------------------
    // Test V: Enrollment does not alter employee Department
    // -------------------------------------------------------------
    console.log('Test V: Enrollment does not alter employee Department...');
    const empBeforeV = await client.query('SELECT department_id FROM hr_employees WHERE id = $1', [accU.employee.id]);
    assert.strictEqual(Number(empBeforeV.rows[0].department_id), Number(accU.employee.department_id));
    console.log('✓ PASS: Test V (Department unchanged).\n');

    // -------------------------------------------------------------
    // Test W: Enrollment does not alter employee Position
    // -------------------------------------------------------------
    console.log('Test W: Enrollment does not alter employee Position...');
    const empBeforeW = await client.query('SELECT position_id FROM hr_employees WHERE id = $1', [accU.employee.id]);
    assert.strictEqual(Number(empBeforeW.rows[0].position_id), Number(accU.employee.position_id));
    console.log('✓ PASS: Test W (Position unchanged).\n');

    // -------------------------------------------------------------
    // Test X: Enrollment does not alter Role
    // -------------------------------------------------------------
    console.log('Test X: Enrollment does not alter Role...');
    const userBeforeX = await client.query('SELECT role_id FROM users WHERE id = $1', [accU.user.id]);
    assert.strictEqual(Number(userBeforeX.rows[0].role_id), Number(accU.user.role_id));
    console.log('✓ PASS: Test X (Role unchanged).\n');

    console.log('========================================================================');
    console.log('=== ALL 24 CANONICAL TESTS (A - X) PASSED SUCCESSFULLY! ================');
    console.log('========================================================================\n');

    console.log('========================================================================');
    console.log('=== AUTH-HR-2C-STORAGE-1: GCS & PROVIDER ADAPTER TESTS (A - K) =========');
    console.log('========================================================================\n');

    // -------------------------------------------------------------
    // Storage Test A: Local provider still works
    // -------------------------------------------------------------
    console.log('Storage Test A: Local provider still works...');
    const localAdapter = new LocalStorageAdapter();
    const testLocalKey = `face-enrollment/1/999/${crypto.randomUUID()}.jpg`;
    const localBuf = createValidJpegBuffer(512);
    await localAdapter.savePhoto(testLocalKey, localBuf, 'image/jpeg');
    const localPath = resolveAbsolutePath(testLocalKey);
    assert.strictEqual(fs.existsSync(localPath), true, 'Local file must exist on disk');
    const localExists = await localAdapter.photoExists(testLocalKey);
    assert.strictEqual(localExists, true, 'photoExists must return true');
    await localAdapter.deletePhoto(testLocalKey);
    assert.strictEqual(fs.existsSync(localPath), false, 'Local file must be deleted');
    console.log('✓ PASS: Storage Test A (Local provider verified).\n');

    // -------------------------------------------------------------
    // Storage Test B: Provider selection is deterministic
    // -------------------------------------------------------------
    console.log('Storage Test B: Provider selection is deterministic...');
    const origProvider = process.env.FACE_ENROLLMENT_STORAGE_PROVIDER;
    try {
      delete process.env.FACE_ENROLLMENT_STORAGE_PROVIDER;
      assert.strictEqual(getActiveStorageProvider(), 'local', 'Default provider must be local');
      process.env.FACE_ENROLLMENT_STORAGE_PROVIDER = 'gcs';
      assert.strictEqual(getActiveStorageProvider(), 'gcs', 'Provider gcs must return gcs');
      process.env.FACE_ENROLLMENT_STORAGE_PROVIDER = 'GCS';
      assert.strictEqual(getActiveStorageProvider(), 'gcs', 'Case insensitive GCS must return gcs');
      process.env.FACE_ENROLLMENT_STORAGE_PROVIDER = 'local';
      assert.strictEqual(getActiveStorageProvider(), 'local', 'Provider local must return local');
      process.env.FACE_ENROLLMENT_STORAGE_PROVIDER = 'unknown_foo';
      assert.strictEqual(getActiveStorageProvider(), 'local', 'Unknown provider must safely fall back to local');
    } finally {
      if (origProvider !== undefined) {
        process.env.FACE_ENROLLMENT_STORAGE_PROVIDER = origProvider;
      } else {
        delete process.env.FACE_ENROLLMENT_STORAGE_PROVIDER;
      }
    }
    console.log('✓ PASS: Storage Test B (Provider selection is deterministic).\n');

    // -------------------------------------------------------------
    // Storage Test C: GCS provider requires bucket configuration
    // -------------------------------------------------------------
    console.log('Storage Test C: GCS provider requires bucket configuration...');
    const origBucket = process.env.FACE_ENROLLMENT_GCS_BUCKET;
    const origProvC = process.env.FACE_ENROLLMENT_STORAGE_PROVIDER;
    try {
      process.env.FACE_ENROLLMENT_STORAGE_PROVIDER = 'gcs';
      delete process.env.FACE_ENROLLMENT_GCS_BUCKET;

      let threw = false;
      try {
        getStorageAdapter();
      } catch (err) {
        threw = true;
        assert.strictEqual(err.code, 'STORAGE_CONFIGURATION_ERROR');
        assert.strictEqual(err.statusCode, 500);
      }
      assert.strictEqual(threw, true, 'getStorageAdapter must throw if bucket not configured');

      let saveThrew = false;
      try {
        await saveFaceEnrollmentPhoto(1, 100, {
          mimetype: 'image/jpeg',
          size: localBuf.length,
          buffer: localBuf
        });
      } catch (err) {
        saveThrew = true;
        assert.strictEqual(err.code, 'STORAGE_CONFIGURATION_ERROR');
      }
      assert.strictEqual(saveThrew, true, 'saveFaceEnrollmentPhoto must throw if bucket not configured');
    } finally {
      process.env.FACE_ENROLLMENT_STORAGE_PROVIDER = origProvC || 'local';
      if (origBucket) process.env.FACE_ENROLLMENT_GCS_BUCKET = origBucket;
    }
    console.log('✓ PASS: Storage Test C (GCS requires bucket configuration; fails closed).\n');

    // -------------------------------------------------------------
    // Storage Test D: Storage key remains provider-independent relative key
    // -------------------------------------------------------------
    console.log('Storage Test D: Storage key remains provider-independent relative key...');
    let capturedBucketNameD = null;
    let savedObjectD = null;
    const mockStorageD = {
      bucket: (bName) => {
        capturedBucketNameD = bName;
        return {
          file: (key) => ({
            save: async (buf, opts) => { savedObjectD = { key, buf, opts }; },
            delete: async () => {},
            exists: async () => [true]
          })
        };
      }
    };
    const gcsAdapterD = new GcsStorageAdapter('oak-hims-face-enrollment-staging', mockStorageD);
    setStorageAdapterForTesting(gcsAdapterD);

    const savedD = await saveFaceEnrollmentPhoto(1, 201, {
      mimetype: 'image/jpeg',
      size: localBuf.length,
      buffer: localBuf
    });

    assert.ok(savedD.storageKey.startsWith('face-enrollment/1/201/'), 'Key must be relative canonical pattern');
    assert.strictEqual(savedD.storageKey.startsWith('/'), false, 'Key must not start with slash');
    assert.strictEqual(savedD.storageKey.includes('gs://'), false, 'Key must not include gs://');
    assert.strictEqual(savedD.storageKey.includes('https://'), false, 'Key must not include https://');
    assert.strictEqual(savedD.storageKey.includes('\\'), false, 'Key must not contain backslashes');
    console.log('✓ PASS: Storage Test D (Storage key is provider-independent relative key).\n');

    // -------------------------------------------------------------
    // Storage Test E: GCS save uses configured bucket
    // -------------------------------------------------------------
    console.log('Storage Test E: GCS save uses configured bucket...');
    assert.strictEqual(capturedBucketNameD, 'oak-hims-face-enrollment-staging', 'Must use configured bucket');
    console.log('✓ PASS: Storage Test E (GCS save uses configured bucket).\n');

    // -------------------------------------------------------------
    // Storage Test F: GCS save never requests public ACL/public URL
    // -------------------------------------------------------------
    console.log('Storage Test F: GCS save never requests public ACL/public URL...');
    assert.ok(savedObjectD, 'Object must have been saved');
    assert.strictEqual(savedObjectD.opts.contentType, 'image/jpeg');
    assert.strictEqual(savedObjectD.opts.metadata?.cacheControl, 'private, max-age=0, no-transform');
    assert.strictEqual(savedObjectD.opts.predefinedAcl, undefined, 'No ACL requested');
    console.log('✓ PASS: Storage Test F (Zero public ACL, private metadata enforced).\n');

    // -------------------------------------------------------------
    // Storage Test G: Simulated GCS upload failure leaves account FACE_ENROLLMENT_REQUIRED
    // -------------------------------------------------------------
    console.log('Storage Test G: Simulated GCS upload failure leaves account FACE_ENROLLMENT_REQUIRED...');
    const failingGcsAdapter = {
      provider: 'gcs',
      savePhoto: async () => {
        throw new Error('Simulated GCS connection timeout (503)');
      },
      deletePhoto: async () => {},
      photoExists: async () => false
    };
    setStorageAdapterForTesting(failingGcsAdapter);

    const accStorageG = await createTestAccount('storage_g');
    const resStorageG = await makeMultipartRequest(server, '/api/auth/face-enrollment', accStorageG.token, {}, {
      photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: localBuf }
    });

    assert.strictEqual(resStorageG.status, 500, 'Upload failure must return 500');
    const userCheckG = await client.query('SELECT account_status FROM users WHERE id = $1', [accStorageG.user.id]);
    assert.strictEqual(userCheckG.rows[0].account_status, 'FACE_ENROLLMENT_REQUIRED', 'Account must remain in FACE_ENROLLMENT_REQUIRED');
    console.log('✓ PASS: Storage Test G (Upload failure rolls back, account remains FACE_ENROLLMENT_REQUIRED).\n');

    // -------------------------------------------------------------
    // Storage Test H: Simulated DB failure after GCS save calls object cleanup
    // -------------------------------------------------------------
    console.log('Storage Test H: Simulated DB failure after GCS save calls object cleanup...');
    const cleanupTracking = { saved: [], deleted: [] };
    const trackingGcsAdapter = {
      provider: 'gcs',
      savePhoto: async (key, buf, mime) => {
        cleanupTracking.saved.push({ key, buf, mime });
      },
      deletePhoto: async (key) => {
        cleanupTracking.deleted.push(key);
      },
      photoExists: async () => true
    };
    setStorageAdapterForTesting(trackingGcsAdapter);

    const accStorageH = await createTestAccount('storage_h');
    const mockClientH = {
      query: async (sql, params) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO employee_face_enrollments')) {
          throw new Error('Simulated DB failure after GCS save');
        }
        return client.query(sql, params);
      },
      release: () => {}
    };
    const mockPoolH = {
      query: (sql, params) => client.query(sql, params),
      connect: async () => mockClientH
    };

    let caughtH = false;
    try {
      await enrollFace(mockPoolH, accStorageH.user.id, {
        fieldname: 'photo',
        originalname: 'face_h.jpg',
        mimetype: 'image/jpeg',
        size: localBuf.length,
        buffer: localBuf
      });
    } catch (err) {
      caughtH = true;
    }
    assert.strictEqual(caughtH, true, 'Enrollment must throw error on DB failure');
    assert.strictEqual(cleanupTracking.saved.length, 1, 'Object must have been uploaded');
    assert.strictEqual(cleanupTracking.deleted.length, 1, 'Uploaded object must have been cleaned up');
    assert.strictEqual(cleanupTracking.deleted[0], cleanupTracking.saved[0].key, 'Exact uploaded key must be deleted');
    console.log('✓ PASS: Storage Test H (Transaction failure triggers orphan object cleanup in GCS).\n');

    // -------------------------------------------------------------
    // Storage Test I: Duplicate enrollment does not create extra GCS object
    // -------------------------------------------------------------
    console.log('Storage Test I: Duplicate enrollment does not create extra GCS object...');
    const duplicateTracking = { saved: [] };
    const dupGcsAdapter = {
      provider: 'gcs',
      savePhoto: async (key, buf, mime) => {
        duplicateTracking.saved.push(key);
      },
      deletePhoto: async () => {},
      photoExists: async () => true
    };
    setStorageAdapterForTesting(dupGcsAdapter);

    const accStorageI = await createTestAccount('storage_i');
    const resStorageI1 = await makeMultipartRequest(server, '/api/auth/face-enrollment', accStorageI.token, {}, {
      photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: localBuf }
    });
    assert.strictEqual(resStorageI1.status, 200, 'First enrollment must succeed');
    assert.strictEqual(duplicateTracking.saved.length, 1, 'Exactly 1 GCS save call');

    // Second enrollment attempt
    const resStorageI2 = await makeMultipartRequest(server, '/api/auth/face-enrollment', resStorageI1.data.data.token, {}, {
      photo: { filename: 'face.jpg', contentType: 'image/jpeg', buffer: localBuf }
    });
    assert.strictEqual(resStorageI2.status, 409, 'Second attempt must be rejected with 409');
    assert.strictEqual(duplicateTracking.saved.length, 1, 'No second GCS save call made');
    console.log('✓ PASS: Storage Test I (Duplicate enrollment blocked before creating extra GCS object).\n');

    // -------------------------------------------------------------
    // Storage Test J: SHA-256 behavior remains unchanged
    // -------------------------------------------------------------
    console.log('Storage Test J: SHA-256 behavior remains unchanged...');
    const expectedHashJ = crypto.createHash('sha256').update(localBuf).digest('hex');
    const gcsSavedJ = await saveFaceEnrollmentPhoto(1, 301, {
      mimetype: 'image/jpeg',
      size: localBuf.length,
      buffer: localBuf
    });
    assert.strictEqual(gcsSavedJ.hash, expectedHashJ, 'SHA-256 must match exactly');
    assert.strictEqual(gcsSavedJ.provider, 'gcs', 'Provider must report gcs');
    console.log('✓ PASS: Storage Test J (SHA-256 checksum integrity verified).\n');

    // -------------------------------------------------------------
    // Storage Test K: Response does not expose bucket URL / gs:// URL
    // -------------------------------------------------------------
    console.log('Storage Test K: Response does not expose bucket URL / gs:// URL...');
    const jsonStr = JSON.stringify(resStorageI1.data);
    assert.strictEqual(jsonStr.includes('gs://'), false, 'Response must not contain gs://');
    assert.strictEqual(jsonStr.includes('storage.googleapis.com'), false, 'Response must not contain googleapis URL');
    assert.strictEqual(jsonStr.includes('oak-hims-face-enrollment'), false, 'Response must not contain bucket name');
    assert.strictEqual(jsonStr.includes('backend/storage'), false, 'Response must not contain local storage path');
    console.log('✓ PASS: Storage Test K (Response envelope is strictly sanitized of storage internals).\n');

    // Reset storage adapter back to null (default)
    setStorageAdapterForTesting(null);

    console.log('========================================================================');
    console.log('=== ALL 24 CANONICAL TESTS + 11 STORAGE ADAPTER TESTS (A-K) PASSED! ====');
    console.log('========================================================================\n');
  } finally {
    await cleanupTestData(client).catch(() => {});
    client.release();
    await new Promise((resolve) => server.close(resolve));
  }
}

runFaceEnrollmentTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
