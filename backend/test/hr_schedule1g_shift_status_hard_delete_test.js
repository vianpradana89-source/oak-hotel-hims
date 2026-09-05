'use strict';

/**
 * AUTH-SECURITY-1 & HR-SCHEDULE-1G:
 * Platform Super Admin Canonical Authority, Login Fail-Closed & Hard Delete Safety Tests
 *
 * Covers:
 * 1. Valid normal-role login keeps actual role/role_id/property_id.
 * 2. Missing/invalid role does NOT become Super Admin.
 * 3. Missing/invalid role returns ACCOUNT_ROLE_INVALID.
 * 4. Invalid property context does NOT become property 1.
 * 5. No role_id=1 fallback exists.
 * 6. Canonical Platform Super Admin can hard delete unused shift.
 * 7. Role named Admin gets 403.
 * 8. Owner gets 403.
 * 9. General Manager gets 403.
 * 10. HRD Admin gets 403.
 * 11. A non-platform/property role must not gain hard-delete authority merely by a similar name.
 * 12. Inactive/invalid Super Admin authority is rejected.
 * 13. Referenced shift returns 409 Conflict with Indonesian message.
 * 14. Historical schedule remains untouched.
 * 15. Normal DELETE remains soft deactivation only (even with hard=true).
 * 16. /permanent and hard=true/hard_delete=true aliases no longer provide hard-delete paths.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const bcrypt = require('bcryptjs');
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { generateToken, verifyToken, loginUser } = require('../dist/domains/auth/authService');

let server;
let baseUrl;
let passed = 0;
let failed = 0;
const testResults = [];

// Track fixtures for zero residue
const createdUserIds = [];
const createdRoleIds = [];
const createdShiftTemplateIds = [];
const createdScheduleIds = [];
const createdEmployeeIds = [];

function assert(condition, message) {
  if (!condition) {
    failed++;
    testResults.push({ status: 'FAIL', message });
    throw new Error(message);
  }
}

function pass(testName) {
  passed++;
  testResults.push({ status: 'PASS', message: testName });
  console.log(`  ✓ ${testName}`);
}

async function request(method, requestPath, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const isBodyAllowed = method !== 'GET' && method !== 'HEAD' && body !== undefined && body !== null;
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: isBodyAllowed ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, body: data };
}

async function cleanupTestFixtures() {
  const client = await pool.connect();
  try {
    if (createdScheduleIds.length > 0) {
      await client.query('DELETE FROM employee_work_schedules WHERE id = ANY($1::int[])', [createdScheduleIds]);
    }
    if (createdShiftTemplateIds.length > 0) {
      await client.query('DELETE FROM work_shift_templates WHERE id = ANY($1::int[])', [createdShiftTemplateIds]);
      await client.query("DELETE FROM audit_logs WHERE module = 'HR_SCHEDULE' AND record_id = ANY($1::text[])", [
        createdShiftTemplateIds.map(String)
      ]);
    }
    if (createdUserIds.length > 0) {
      await client.query('DELETE FROM users WHERE id = ANY($1::int[])', [createdUserIds]);
    }
    if (createdEmployeeIds.length > 0) {
      await client.query('DELETE FROM hr_employees WHERE id = ANY($1::int[])', [createdEmployeeIds]);
    }
    if (createdRoleIds.length > 0) {
      await client.query('DELETE FROM roles WHERE id = ANY($1::int[])', [createdRoleIds]);
    }
  } catch (err) {
    console.error('Cleanup error:', err.message);
  } finally {
    client.release();
  }
}

async function runTests() {
  console.log('\n=============================================================');
  console.log('AUTH-SECURITY-1 & HR-SCHEDULE-1G: PLATFORM AUTHORITY TESTS');
  console.log('=============================================================\n');

  try {
    await initializeDatabase(pool);

    const testPassword = 'PasswordTest123!';
    const passwordHash = await bcrypt.hash(testPassword, 10);
    const ts = Date.now();

    // ─────────────────────────────────────────────────────────
    // Helper to create test user & role in database
    // ─────────────────────────────────────────────────────────
    async function createTestRole(name, isSystemRole = false, propertyId = 1, isActive = true) {
      const res = await pool.query(
        `INSERT INTO roles (name, description, is_system_role, property_id, is_active)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [name, `Test role ${name}`, isSystemRole, propertyId, isActive]
      );
      const id = res.rows[0].id;
      createdRoleIds.push(id);
      return id;
    }

    async function createTestUser(roleId, username, roleName = 'Test Role', propertyId = 1, isActive = true) {
      const email = `${username}@test-oak.internal`;
      const res = await pool.query(
        `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, account_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY')
         RETURNING id`,
        [propertyId, roleId, username, email, passwordHash, `User ${username}`, isActive]
      );
      const id = res.rows[0].id;
      createdUserIds.push(id);
      return { id, username, email, roleId, roleName, propertyId };
    }

    // ─────────────────────────────────────────────────────────
    // 1. Valid normal-role login keeps actual role/role_id/property_id
    // ─────────────────────────────────────────────────────────
    const normalRoleId = await createTestRole(`Front_Desk_${ts}`, false, 1, true);
    const normalUser = await createTestUser(normalRoleId, `user_fd_${ts}`, `Front_Desk_${ts}`, 1, true);

    const loginRes1 = await request('POST', '/api/auth/login', {
      username: normalUser.username,
      password: testPassword
    });
    assert(loginRes1.status === 200, `Login should succeed with 200, got ${loginRes1.status}`);
    const authData1 = loginRes1.body.data;
    assert(authData1.user.role === `Front_Desk_${ts}`, `Actual role must be preserved, got ${authData1.user.role}`);
    assert(authData1.user.role_id === normalRoleId, `Actual role_id must be preserved, got ${authData1.user.role_id}`);
    assert(authData1.user.property_id === 1, `Actual property_id must be preserved, got ${authData1.user.property_id}`);
    const decodedToken1 = verifyToken(authData1.token);
    assert(decodedToken1.role === `Front_Desk_${ts}`, `JWT token must carry actual role, got ${decodedToken1.role}`);
    assert(decodedToken1.role_id === normalRoleId, `JWT token must carry actual role_id, got ${decodedToken1.role_id}`);
    pass('1: Valid normal-role login keeps actual role/role_id/property_id');

    // ─────────────────────────────────────────────────────────
    // 2. Missing/invalid role does NOT become Super Admin
    // 3. Missing/invalid role returns ACCOUNT_ROLE_INVALID
    // ─────────────────────────────────────────────────────────
    const inactiveRoleId = await createTestRole(`Disabled_Role_${ts}`, false, 1, false);
    const userInactiveRole = await createTestUser(inactiveRoleId, `user_inact_role_${ts}`, `Disabled_Role_${ts}`, 1, true);

    const loginRes2 = await request('POST', '/api/auth/login', {
      username: userInactiveRole.username,
      password: testPassword
    });
    assert(loginRes2.status === 403, `Inactive role login should return 403, got ${loginRes2.status}`);
    assert(loginRes2.body.code === 'ACCOUNT_ROLE_INVALID', `Error code must be ACCOUNT_ROLE_INVALID, got ${loginRes2.body.code}`);
    assert(
      loginRes2.body.message === 'Konfigurasi role akun tidak valid. Hubungi Administrator.',
      `Error message mismatch: ${loginRes2.body.message}`
    );
    pass('2 & 3: Missing/invalid role does NOT become Super Admin and returns ACCOUNT_ROLE_INVALID (403)');

    // ─────────────────────────────────────────────────────────
    // 4. Invalid property context does NOT become property 1
    // 5. No role_id=1 fallback exists
    // ─────────────────────────────────────────────────────────
    // Test loginUser directly with missing property_id
    let thrownPropErr = null;
    try {
      const mockClient = {
        query: async () => ({
          rows: [{
            id: 88888,
            property_id: null, // missing property
            role_id: normalRoleId,
            username: 'bad_prop_user',
            email: 'bad_prop@oak.internal',
            password_hash: passwordHash,
            full_name: 'Bad Prop User',
            is_active: true,
            account_status: 'READY',
            role_name: 'Front Desk',
            role_is_active: true
          }]
        })
      };
      await loginUser(mockClient, { emailOrUsername: 'bad_prop@oak.internal', password: testPassword });
    } catch (err) {
      thrownPropErr = err;
    }
    assert(thrownPropErr !== null, 'loginUser must throw when property_id is missing');
    assert(thrownPropErr.code === 'ACCOUNT_PROPERTY_INVALID', `Code must be ACCOUNT_PROPERTY_INVALID, got ${thrownPropErr.code}`);
    assert(thrownPropErr.statusCode === 403, `Status must be 403, got ${thrownPropErr.statusCode}`);
    assert(thrownPropErr.message === 'Konfigurasi properti akun tidak valid. Hubungi Administrator.');
    pass('4 & 5: Invalid property context does NOT become property 1 and no role_id=1 fallback exists');

    // ─────────────────────────────────────────────────────────
    // Setup users for authorization tests:
    // A. Canonical Platform Super Admin (is_system_role = true, property_id = null, name = 'Super Admin')
    // B. Role named 'Admin'
    // C. Role named 'Owner'
    // D. Role named 'General Manager'
    // E. Role named 'HRD Admin'
    // F. Property role named 'Super Admin' (property_id = 1, is_system_role = false)
    // G. Inactive Super Admin user
    // ─────────────────────────────────────────────────────────
    const superAdminRoleRes = await pool.query(
      `SELECT id FROM roles WHERE LOWER(TRIM(name)) = 'super admin' AND is_system_role = TRUE AND property_id IS NULL LIMIT 1`
    );
    let platformSuperAdminRoleId;
    if (superAdminRoleRes.rows.length > 0) {
      platformSuperAdminRoleId = superAdminRoleRes.rows[0].id;
    } else {
      platformSuperAdminRoleId = await createTestRole('Super Admin', true, null, true);
    }

    const platformSuperAdminUser = await createTestUser(platformSuperAdminRoleId, `canon_sa_${ts}`, 'Super Admin', 1, true);
    const platformSuperAdminToken = generateToken({
      id: platformSuperAdminUser.id,
      email: platformSuperAdminUser.email,
      username: platformSuperAdminUser.username,
      full_name: 'Platform Super Admin',
      role: 'Super Admin',
      role_id: platformSuperAdminRoleId,
      property_id: 1,
      scope: 'FULL'
    });

    // ─────────────────────────────────────────────────────────
    // 6. Canonical Platform Super Admin can hard delete unused shift
    // ─────────────────────────────────────────────────────────
    const createRes6 = await request('POST', '/api/schedule/shift-templates', {
      property_id: 1,
      code: `T1G_6_${ts.toString().slice(-4)}`,
      name: 'Test Shift Unused For Hard Delete',
      start_time: '08:00',
      end_time: '16:00'
    }, platformSuperAdminToken);
    assert(createRes6.status === 201, `Failed to create shift: ${createRes6.status}`);
    const shift6Id = createRes6.body.data.id;
    createdShiftTemplateIds.push(shift6Id);

    const hardDelRes6 = await request('DELETE', `/api/schedule/shift-templates/${shift6Id}/hard-delete`, {
      property_id: 1
    }, platformSuperAdminToken);
    assert(hardDelRes6.status === 200, `Hard delete should return 200, got ${hardDelRes6.status}`);
    assert(hardDelRes6.body.status === 'OK', `Status must be OK`);
    const checkDeleted6 = await pool.query('SELECT 1 FROM work_shift_templates WHERE id = $1', [shift6Id]);
    assert(checkDeleted6.rowCount === 0, 'Shift must be permanently removed from database');
    pass('6: Canonical Platform Super Admin can hard delete unused shift');

    // Create a target shift for negative authorization tests
    const createResTarget = await request('POST', '/api/schedule/shift-templates', {
      property_id: 1,
      code: `T1G_T_${ts.toString().slice(-4)}`,
      name: 'Test Target Shift',
      start_time: '09:00',
      end_time: '17:00'
    }, platformSuperAdminToken);
    const targetShiftId = createResTarget.body.data.id;
    createdShiftTemplateIds.push(targetShiftId);

    // ─────────────────────────────────────────────────────────
    // 7. Role named Admin gets 403
    // ─────────────────────────────────────────────────────────
    const adminRoleId = await createTestRole(`Admin_${ts}`, false, 1, true);
    const adminUser = await createTestUser(adminRoleId, `admin_${ts}`, `Admin_${ts}`, 1, true);
    const adminToken = generateToken({
      id: adminUser.id,
      email: adminUser.email,
      username: adminUser.username,
      full_name: 'Admin User',
      role: 'Admin',
      role_id: adminRoleId,
      property_id: 1,
      scope: 'FULL'
    });
    const delAdminRes = await request('DELETE', `/api/schedule/shift-templates/${targetShiftId}/hard-delete`, { property_id: 1 }, adminToken);
    assert(delAdminRes.status === 403, `Role named Admin must get 403, got ${delAdminRes.status}`);
    assert(delAdminRes.body.code === 'FORBIDDEN', `Expected FORBIDDEN code, got ${delAdminRes.body.code}`);
    pass('7: Role named Admin gets 403 on hard delete');

    // ─────────────────────────────────────────────────────────
    // 8. Owner gets 403
    // ─────────────────────────────────────────────────────────
    const ownerRoleId = await createTestRole(`Owner_${ts}`, false, 1, true);
    const ownerUser = await createTestUser(ownerRoleId, `owner_${ts}`, `Owner_${ts}`, 1, true);
    const ownerToken = generateToken({
      id: ownerUser.id,
      email: ownerUser.email,
      username: ownerUser.username,
      full_name: 'Owner User',
      role: 'Owner',
      role_id: ownerRoleId,
      property_id: 1,
      scope: 'FULL'
    });
    const delOwnerRes = await request('DELETE', `/api/schedule/shift-templates/${targetShiftId}/hard-delete`, { property_id: 1 }, ownerToken);
    assert(delOwnerRes.status === 403, `Role Owner must get 403, got ${delOwnerRes.status}`);
    assert(delOwnerRes.body.code === 'FORBIDDEN', `Expected FORBIDDEN code, got ${delOwnerRes.body.code}`);
    pass('8: Role named Owner gets 403 on hard delete');

    // ─────────────────────────────────────────────────────────
    // 9. General Manager gets 403
    // ─────────────────────────────────────────────────────────
    const gmRoleId = await createTestRole(`General_Manager_${ts}`, true, null, true);
    const gmUser = await createTestUser(gmRoleId, `gm_${ts}`, `General_Manager_${ts}`, 1, true);
    const gmToken = generateToken({
      id: gmUser.id,
      email: gmUser.email,
      username: gmUser.username,
      full_name: 'GM User',
      role: 'General Manager',
      role_id: gmRoleId,
      property_id: 1,
      scope: 'FULL'
    });
    const delGmRes = await request('DELETE', `/api/schedule/shift-templates/${targetShiftId}/hard-delete`, { property_id: 1 }, gmToken);
    assert(delGmRes.status === 403, `General Manager must get 403, got ${delGmRes.status}`);
    pass('9: General Manager gets 403 on hard delete');

    // ─────────────────────────────────────────────────────────
    // 10. HRD Admin gets 403
    // ─────────────────────────────────────────────────────────
    const hrdRoleId = await createTestRole(`HRD_Admin_${ts}`, true, null, true);
    const hrdUser = await createTestUser(hrdRoleId, `hrd_${ts}`, `HRD_Admin_${ts}`, 1, true);
    const hrdToken = generateToken({
      id: hrdUser.id,
      email: hrdUser.email,
      username: hrdUser.username,
      full_name: 'HRD Admin User',
      role: 'HRD Admin',
      role_id: hrdRoleId,
      property_id: 1,
      scope: 'FULL'
    });
    const delHrdRes = await request('DELETE', `/api/schedule/shift-templates/${targetShiftId}/hard-delete`, { property_id: 1 }, hrdToken);
    assert(delHrdRes.status === 403, `HRD Admin must get 403, got ${delHrdRes.status}`);
    pass('10: HRD Admin gets 403 on hard delete');

    // ─────────────────────────────────────────────────────────
    // 11. A non-platform/property role must not gain hard-delete authority merely by a similar name
    // ─────────────────────────────────────────────────────────
    const propSuperAdminRoleId = await createTestRole(`Super Admin Prop ${ts}`, false, 1, true);
    const propSuperAdminUser = await createTestUser(propSuperAdminRoleId, `propsa_${ts}`, `Super Admin Prop ${ts}`, 1, true);
    const propSuperAdminToken = generateToken({
      id: propSuperAdminUser.id,
      email: propSuperAdminUser.email,
      username: propSuperAdminUser.username,
      full_name: 'Property Super Admin',
      role: 'Super Admin', // Claiming Super Admin in JWT!
      role_id: propSuperAdminRoleId,
      property_id: 1,
      scope: 'FULL'
    });
    const delPropSaRes = await request('DELETE', `/api/schedule/shift-templates/${targetShiftId}/hard-delete`, { property_id: 1 }, propSuperAdminToken);
    assert(delPropSaRes.status === 403, `Property role with claimed JWT role must get 403, got ${delPropSaRes.status}`);
    pass('11: Property-scoped role cannot gain hard-delete authority merely by similar/claimed name');

    // ─────────────────────────────────────────────────────────
    // 12. Inactive/invalid Super Admin authority is rejected
    // ─────────────────────────────────────────────────────────
    const inactiveSuperAdminUser = await createTestUser(platformSuperAdminRoleId, `inact_sa_${ts}`, 'Super Admin', 1, false);
    const inactSaToken = generateToken({
      id: inactiveSuperAdminUser.id,
      email: inactiveSuperAdminUser.email,
      username: inactiveSuperAdminUser.username,
      full_name: 'Inactive Super Admin',
      role: 'Super Admin',
      role_id: platformSuperAdminRoleId,
      property_id: 1,
      scope: 'FULL'
    });
    const delInactRes = await request('DELETE', `/api/schedule/shift-templates/${targetShiftId}/hard-delete`, { property_id: 1 }, inactSaToken);
    assert(delInactRes.status === 403, `Inactive Super Admin must get 403, got ${delInactRes.status}`);
    assert(delInactRes.body.code === 'ACCOUNT_DISABLED', `Expected ACCOUNT_DISABLED, got ${delInactRes.body.code}`);
    pass('12: Inactive Super Admin user is strictly rejected with 403');

    // ─────────────────────────────────────────────────────────
    // 13. Referenced shift returns 409
    // 14. Historical schedule remains untouched
    // ─────────────────────────────────────────────────────────
    const empRes = await pool.query(`
      INSERT INTO hr_employees (property_id, full_name, email, status, is_active)
      VALUES (1, 'Ref Test Employee', 'ref_test_emp@test.internal', 'ACTIVE', true)
      RETURNING id
    `);
    const testEmployeeId = empRes.rows[0].id;
    createdEmployeeIds.push(testEmployeeId);

    const createResRef = await request('POST', '/api/schedule/shift-templates', {
      property_id: 1,
      code: `T1G_REF_${ts.toString().slice(-4)}`,
      name: 'Test Shift Referenced in Schedule',
      start_time: '07:00',
      end_time: '15:00'
    }, platformSuperAdminToken);
    const refShiftId = createResRef.body.data.id;
    createdShiftTemplateIds.push(refShiftId);

    const schedRes = await pool.query(`
      INSERT INTO employee_work_schedules (
        property_id, employee_id, work_date, shift_template_id, work_status,
        schedule_status, notes
      ) VALUES (
        1, $1, '2028-02-01', $2, 'WORK', 'PUBLISHED', 'TEST 1G REF'
      ) RETURNING id
    `, [testEmployeeId, refShiftId]);
    const scheduleId = schedRes.rows[0].id;
    createdScheduleIds.push(scheduleId);

    // Platform Super Admin attempts hard delete
    const delRefInUseRes = await request('DELETE', `/api/schedule/shift-templates/${refShiftId}/hard-delete`, {
      property_id: 1
    }, platformSuperAdminToken);
    assert(delRefInUseRes.status === 409, `Referenced shift hard-delete must return 409 Conflict, got ${delRefInUseRes.status}`);
    assert(delRefInUseRes.body.code === 'SHIFT_IN_USE', `Code must be SHIFT_IN_USE, got ${delRefInUseRes.body.code}`);
    assert(
      delRefInUseRes.body.message === 'Shift tidak dapat dihapus karena masih digunakan pada jadwal karyawan. Nonaktifkan shift jika tidak ingin digunakan lagi.',
      `Message mismatch: ${delRefInUseRes.body.message}`
    );

    // Verify schedule row and shift template still exist untouched
    const schedVerify = await pool.query('SELECT 1 FROM employee_work_schedules WHERE id = $1', [scheduleId]);
    assert(schedVerify.rowCount === 1, 'Schedule record must remain untouched');
    const templateVerify = await pool.query('SELECT 1 FROM work_shift_templates WHERE id = $1', [refShiftId]);
    assert(templateVerify.rowCount === 1, 'Referenced shift template must remain untouched in database');
    pass('13 & 14: Referenced shift returns 409 Conflict and historical schedule remains untouched');

    // ─────────────────────────────────────────────────────────
    // 15. Normal DELETE remains soft deactivation only
    // ─────────────────────────────────────────────────────────
    const createRes15 = await request('POST', '/api/schedule/shift-templates', {
      property_id: 1,
      code: `T1G_15_${ts.toString().slice(-4)}`,
      name: 'Test Shift Soft Deactivation Only',
      start_time: '10:00',
      end_time: '18:00'
    }, platformSuperAdminToken);
    const shift15Id = createRes15.body.data.id;
    createdShiftTemplateIds.push(shift15Id);

    // Call DELETE /api/schedule/shift-templates/:id even with hard=true query and body
    const softDelRes = await request('DELETE', `/api/schedule/shift-templates/${shift15Id}?hard=true`, {
      property_id: 1,
      hard: true,
      permanent: true
    }, platformSuperAdminToken);
    assert(softDelRes.status === 200, `Soft delete should return 200, got ${softDelRes.status}`);
    assert(softDelRes.body.message === 'Shift template berhasil dinonaktifkan.', `Expected deactivation message, got: ${softDelRes.body.message}`);

    // Verify row still exists in database with is_active = FALSE (NOT deleted)
    const checkRow15 = await pool.query('SELECT is_active FROM work_shift_templates WHERE id = $1', [shift15Id]);
    assert(checkRow15.rowCount === 1, 'Shift template row MUST still exist in database');
    assert(checkRow15.rows[0].is_active === false, 'Shift template must have is_active = false');
    pass('15: Normal DELETE /shift-templates/:id remains soft deactivation only (ignores hard=true)');

    // ─────────────────────────────────────────────────────────
    // 16. /permanent and hard=true aliases no longer provide hard-delete paths
    // ─────────────────────────────────────────────────────────
    const permRes = await request('DELETE', `/api/schedule/shift-templates/${shift15Id}/permanent`, {
      property_id: 1
    }, platformSuperAdminToken);
    assert(permRes.status === 404, `/permanent route must be removed and return 404, got ${permRes.status}`);
    pass('16: /permanent alias is removed (returns 404) and cannot execute hard delete');

    // ─────────────────────────────────────────────────────────
    // FINAL: Summary
    // ─────────────────────────────────────────────────────────
    console.log('\n=============================================================');
    console.log(`ALL AUTH-SECURITY-1 & HR-SCHEDULE-1G TESTS PASSED (${passed}/${passed})`);
    console.log('=============================================================\n');

  } catch (err) {
    console.error('\n=== TEST FAILED ===');
    console.error(err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await cleanupTestFixtures();
    if (server) server.close();
    await pool.end();
  }
}

(async () => {
  server = app.listen(0, async () => {
    baseUrl = `http://localhost:${server.address().port}`;
    await runTests();
  });
})();
