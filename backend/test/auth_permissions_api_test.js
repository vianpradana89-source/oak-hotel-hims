'use strict';

/**
 * Focused test for GET /api/auth/permissions endpoint
 * Tests getUserEffectivePermissions helper behavior
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { generateToken } = require('../dist/domains/auth/authService');
const http = require('http');

let server;

// ---------------------------------------------------------------------------
// HTTP request helper
// ---------------------------------------------------------------------------
function request(method, requestPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const port = server.address().port;
    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: requestPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    if (token) options.headers.Authorization = `Bearer ${token}`;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fail(msg) { throw new Error(msg); }
let total = 0;
let passed = 0;
function assert(cond, msg) {
  total++;
  if (!cond) fail(msg);
  passed++;
  console.log(`  [PASS] ${msg}`);
}

let testCounter = 0;

function generateUserToken(userId, roleId, propertyId) {
  return generateToken({
    id: userId,
    email: `user${userId}@oak.test`,
    username: `user_${userId}`,
    full_name: `Test User ${userId}`,
    role: 'Test Role',
    role_id: roleId,
    property_id: propertyId,
    scope: 'FULL',
    account_status: 'READY',
    must_change_password: false,
    access_type: 'PMS_STAFF'
  });
}

// ---------------------------------------------------------------------------
// DB setup helpers
// ---------------------------------------------------------------------------
async function createUser(name, roleId, propertyId, opts = {}) {
  const { is_active = true, account_status = 'READY', email } = opts;
  testCounter++;
  const uid = process.pid;
  const ts = Date.now();
  const uniqueName = `permtst_${name}_${uid}_${ts}_${testCounter}`;
  const uniqueEmail = email || `permtest${uid}_${ts}_${testCounter}@oak.test`;
  const res = await pool.query(
    `INSERT INTO users (username, email, password_hash, full_name, role_id, property_id, is_active, account_status, access_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [uniqueName, uniqueEmail, '$2a$10$UnchangedCustomHashForTest00000000',
     uniqueName, roleId, propertyId, is_active, account_status, 'PMS_STAFF']
  );
  return Number(res.rows[0].id);
}

async function createRole(name, propertyId = 1, isActive = true) {
  testCounter++;
  const uid = process.pid;
  const ts = Date.now();
  const uniqueName = `PermTestRole_${name}_${uid}_${ts}_${testCounter}`;
  const res = await pool.query(
    `INSERT INTO roles (name, property_id, is_active, is_system_role)
     VALUES ($1, $2, $3, false)
     RETURNING id`,
    [uniqueName, propertyId, isActive]
  );
  return Number(res.rows[0].id);
}

async function grantPermission(roleId, permKey) {
  const permRes = await pool.query(`SELECT id FROM permissions WHERE key = $1`, [permKey]);
  let permId;
  if (permRes.rows.length === 0) {
    const ins = await pool.query(
      `INSERT INTO permissions (key, resource, action, description) VALUES ($1, $2, $3, $4) RETURNING id`,
      [permKey, 'test', 'read', `Test permission ${permKey}`]
    );
    permId = Number(ins.rows[0].id);
  } else {
    permId = Number(permRes.rows[0].id);
  }
  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id, granted) VALUES ($1, $2, TRUE)
     ON CONFLICT (role_id, permission_id) DO UPDATE SET granted = TRUE`,
    [roleId, permId]
  );
  return permId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function runTests() {
  console.log('=== AUTH PERMISSIONS API FOCUSED TEST ===\n');

  // ==========================================================================
  // TEST 1: Valid regular user WITH granted permissions
  // ==========================================================================
  console.log('\n--- TEST 1: Valid regular user with granted permissions ---');
  const role1 = await createRole('PermTestRole1');
  await grantPermission(role1, 'test.perm.a');
  await grantPermission(role1, 'test.perm.b');
  await grantPermission(role1, 'test.perm.c');
  const user1 = await createUser('perm_user_with_perms', role1, 1);
  const token1 = generateUserToken(user1, role1, 1);
  const res1 = await request('GET', '/api/auth/permissions', null, token1);
  assert(res1.status === 200, 'TEST 1a: expect 200 OK');
  assert(res1.body.status === 'OK', 'TEST 1b: response status OK');
  assert(Array.isArray(res1.body.data.permissions), 'TEST 1c: permissions is array');
  assert(res1.body.data.permissions.length === 3, `TEST 1d: expect 3 perms, got ${res1.body.data.permissions.length}`);
  assert(res1.body.data.permissions.includes('test.perm.a'), 'TEST 1e: has test.perm.a');
  assert(res1.body.data.permissions.includes('test.perm.b'), 'TEST 1f: has test.perm.b');
  assert(res1.body.data.permissions.includes('test.perm.c'), 'TEST 1g: has test.perm.c');
  const sorted = [...res1.body.data.permissions].sort();
  assert(JSON.stringify(res1.body.data.permissions) === JSON.stringify(sorted), 'TEST 1h: permissions ORDER BY key ASC');

  // ==========================================================================
  // TEST 2: Valid regular user WITHOUT any permissions
  // ==========================================================================
  console.log('\n--- TEST 2: Valid regular user without permissions ---');
  const role2 = await createRole('PermTestRole2');
  const user2 = await createUser('perm_user_no_perms', role2, 1);
  const token2 = generateUserToken(user2, role2, 1);
  const res2 = await request('GET', '/api/auth/permissions', null, token2);
  assert(res2.status === 200, 'TEST 2a: expect 200 OK (not error)');
  assert(res2.body.status === 'OK', 'TEST 2b: response status OK');
  assert(Array.isArray(res2.body.data.permissions), 'TEST 2c: permissions is array');
  assert(res2.body.data.permissions.length === 0, `TEST 2d: expect empty array, got ${JSON.stringify(res2.body.data.permissions)}`);

  // ==========================================================================
  // TEST 3: Platform Super Admin gets ALL permissions
  // ==========================================================================
  console.log('\n--- TEST 3: Platform Super Admin canonical ---');
  const superAdminCheck = await pool.query(
    `SELECT u.id, u.role_id, u.property_id
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.is_system_role = true
     AND r.name ILIKE '%super admin%'
     LIMIT 1`
  );
  if (superAdminCheck.rows.length > 0) {
    const sa = superAdminCheck.rows[0];
    const saToken = generateUserToken(sa.id, sa.role_id, sa.property_id);
    const res3 = await request('GET', '/api/auth/permissions', null, saToken);
    assert(res3.status === 200, 'TEST 3a: expect 200 OK');
    assert(res3.body.status === 'OK', 'TEST 3b: response status OK');
    assert(Array.isArray(res3.body.data.permissions), 'TEST 3c: permissions is array');
    assert(res3.body.data.permissions.length > 0, 'TEST 3d: Super Admin should have permissions');
    const allPerms = await pool.query(`SELECT key FROM permissions ORDER BY key ASC`);
    const expectedKeys = allPerms.rows.map(r => r.key).sort();
    const actualKeys = [...res3.body.data.permissions].sort();
    assert(JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
      `TEST 3e: Super Admin has all permissions (got ${actualKeys.length}, expected ${expectedKeys.length})`);
  } else {
    console.log('  [SKIP] No platform Super Admin user found in DB');
    total += 5;
  }

  // ==========================================================================
  // TEST 4: User not found (invalid userId in token)
  // ==========================================================================
  console.log('\n--- TEST 4: User not found ---');
  const fakeToken = generateUserToken(999999, 1, 1);
  const res4 = await request('GET', '/api/auth/permissions', null, fakeToken);
  assert(res4.status === 401, `TEST 4a: expect 401, got ${res4.status}`);
  assert(res4.body.code === 'USER_NOT_FOUND_OR_INACTIVE', `TEST 4b: expect USER_NOT_FOUND_OR_INACTIVE, got ${res4.body.code}`);

  // ==========================================================================
  // TEST 5: User is_active = false
  // ==========================================================================
  console.log('\n--- TEST 5: User is_active = false ---');
  const role5 = await createRole('PermTestRole5');
  const user5 = await createUser('perm_inactive_user', role5, 1, { is_active: false });
  const token5 = generateUserToken(user5, role5, 1);
  const res5 = await request('GET', '/api/auth/permissions', null, token5);
  assert(res5.status === 401, `TEST 5a: expect 401, got ${res5.status}`);
  assert(res5.body.code === 'USER_NOT_FOUND_OR_INACTIVE', `TEST 5b: expect USER_NOT_FOUND_OR_INACTIVE, got ${res5.body.code}`);

  // ==========================================================================
  // TEST 6: account_status = DISABLED
  // ==========================================================================
  console.log('\n--- TEST 6: account_status DISABLED ---');
  const role6 = await createRole('PermTestRole6');
  const user6 = await createUser('perm_disabled_user', role6, 1, { account_status: 'DISABLED' });
  const token6 = generateUserToken(user6, role6, 1);
  const res6 = await request('GET', '/api/auth/permissions', null, token6);
  assert(res6.status === 403, `TEST 6a: expect 403, got ${res6.status}`);
  assert(res6.body.code === 'ACCOUNT_DISABLED', `TEST 6b: expect ACCOUNT_DISABLED, got ${res6.body.code}`);

  // ==========================================================================
  // TEST 7: account_status = SUSPENDED
  // ==========================================================================
  console.log('\n--- TEST 7: account_status SUSPENDED ---');
  const role7 = await createRole('PermTestRole7');
  const user7 = await createUser('perm_suspended_user', role7, 1, { account_status: 'SUSPENDED' });
  const token7 = generateUserToken(user7, role7, 1);
  const res7 = await request('GET', '/api/auth/permissions', null, token7);
  assert(res7.status === 403, `TEST 7a: expect 403, got ${res7.status}`);
  assert(res7.body.code === 'ACCOUNT_SUSPENDED', `TEST 7b: expect ACCOUNT_SUSPENDED, got ${res7.body.code}`);

  // ==========================================================================
  // TEST 8: Invalid property_id (null)
  // ==========================================================================
  console.log('\n--- TEST 8: Invalid property_id (null) ---');
  const role8 = await createRole('PermTestRole8');
  const user8Res = await pool.query(
    `INSERT INTO users (username, email, password_hash, full_name, role_id, property_id, is_active, account_status, access_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [`perm_null_prop_${process.pid}_${Date.now()}`, `nullprop${Date.now()}@oak.test`, '$2a$10$UnchangedCustomHashForTest00000000',
     `perm_null_prop_${process.pid}_${Date.now()}`, role8, null, true, 'READY', 'PMS_STAFF']
  );
  const user8 = Number(user8Res.rows[0].id);
  const token8 = generateUserToken(user8, role8, null);
  const res8 = await request('GET', '/api/auth/permissions', null, token8);
  assert(res8.status === 403, `TEST 8a: expect 403, got ${res8.status}`);
  assert(res8.body.code === 'ACCOUNT_PROPERTY_INVALID', `TEST 8b: expect ACCOUNT_PROPERTY_INVALID, got ${res8.body.code}`);

  // ==========================================================================
  // TEST 9: Invalid property_id (non-numeric string) - DB type guard
  // PostgreSQL rejects 'abc' at INSERT time for INTEGER column.
  // We still test that our helper handles NaN/invalid safely via direct call.
  // ==========================================================================
  console.log('\n--- TEST 9: Invalid property_id (non-numeric string) ---');
  // Import helper directly to test with synthetic input
  const { getUserEffectivePermissions } = require('../dist/domains/auth/authService');
  // Simulate a row where property_id would be non-numeric (e.g. cast from text)
  const mockPool9 = {
    query: async (sql, params) => {
      if (sql.includes('schema_migrations')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT u.id')) {
        return { rows: [{
          id: 8888,
          property_id: 'abc',  // non-numeric string injected for testing
          role_id: 1,
          is_active: true,
          account_status: 'READY',
          access_type: 'PMS_STAFF',
          role_name: 'Test',
          role_is_active: true,
          is_system_role: false,
          role_property_id: null
        }] };
      }
      if (sql.includes('pg_roles')) return { rows: [], rowCount: 0 };
      if (sql.includes('permissions')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }
  };
  try {
    const result9 = await getUserEffectivePermissions(mockPool9, 8888);
    assert(false, 'TEST 9a: should throw for invalid property_id');
  } catch (err9) {
    assert(err9.statusCode === 403, `TEST 9a: expect 403, got ${err9.statusCode}`);
    assert(err9.code === 'ACCOUNT_PROPERTY_INVALID', `TEST 9b: expect ACCOUNT_PROPERTY_INVALID, got ${err9.code}`);
  }

  // ==========================================================================
  // TEST 10: Invalid role_id (null)
  // ==========================================================================
  console.log('\n--- TEST 10: Invalid role_id (null) ---');
  const user10Res = await pool.query(
    `INSERT INTO users (username, email, password_hash, full_name, role_id, property_id, is_active, account_status, access_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [`perm_null_role_${process.pid}_${Date.now()}`, `nullrole${Date.now()}@oak.test`, '$2a$10$UnchangedCustomHashForTest00000000',
     `perm_null_role_${process.pid}_${Date.now()}`, null, 1, true, 'READY', 'PMS_STAFF']
  );
  const user10 = Number(user10Res.rows[0].id);
  const token10 = generateUserToken(user10, null, 1);
  const res10 = await request('GET', '/api/auth/permissions', null, token10);
  assert(res10.status === 403, `TEST 10a: expect 403, got ${res10.status}`);
  assert(res10.body.code === 'ACCOUNT_ROLE_INVALID', `TEST 10b: expect ACCOUNT_ROLE_INVALID, got ${res10.body.code}`);

  // ==========================================================================
  // TEST 11: Invalid role_id (non-numeric string) - DB type guard
  // PostgreSQL rejects 'invalid' at INSERT time for INTEGER column.
  // Test via direct helper call with synthetic input.
  // ==========================================================================
  console.log('\n--- TEST 11: Invalid role_id (non-numeric string) ---');
  const mockPool11 = {
    query: async (sql, params) => {
      if (sql.includes('schema_migrations')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT u.id')) {
        return { rows: [{
          id: 9999,
          property_id: 1,
          role_id: 'invalid',  // non-numeric string injected for testing
          is_active: true,
          account_status: 'READY',
          access_type: 'PMS_STAFF',
          role_name: 'Test',
          role_is_active: true,
          is_system_role: false,
          role_property_id: null
        }] };
      }
      if (sql.includes('pg_roles')) return { rows: [], rowCount: 0 };
      if (sql.includes('permissions')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }
  };
  try {
    const result11 = await getUserEffectivePermissions(mockPool11, 9999);
    assert(false, 'TEST 11a: should throw for invalid role_id');
  } catch (err11) {
    assert(err11.statusCode === 403, `TEST 11a: expect 403, got ${err11.statusCode}`);
    assert(err11.code === 'ACCOUNT_ROLE_INVALID', `TEST 11b: expect ACCOUNT_ROLE_INVALID, got ${err11.code}`);
  }

  // ==========================================================================
  // TEST 12: Role is_active = false
  // ==========================================================================
  console.log('\n--- TEST 12: Role is_active = false ---');
  const role12 = await createRole('PermTestRole12', null, false);
  const user12 = await createUser('perm_inactive_role_user', role12, 1);
  const token12 = generateUserToken(user12, role12, 1);
  const res12 = await request('GET', '/api/auth/permissions', null, token12);
  assert(res12.status === 403, `TEST 12a: expect 403, got ${res12.status}`);
  assert(res12.body.code === 'ACCOUNT_ROLE_INVALID', `TEST 12b: expect ACCOUNT_ROLE_INVALID, got ${res12.body.code}`);

  // ==========================================================================
  // TEST 13: Non-granted permission (granted = false) should NOT appear
  // ==========================================================================
  console.log('\n--- TEST 13: Non-granted permission excluded ---');
  const role13 = await createRole('PermTestRole13');
  await grantPermission(role13, 'test.perm.granted');
  // Ensure test.perm.notgranted exists
  await pool.query(
    `INSERT INTO permissions (key, resource, action, description) VALUES ('test.perm.notgranted', 'test', 'read', 'Test non-granted perm')
     ON CONFLICT (key) DO NOTHING`
  );
  // Set granted = FALSE for it
  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_id, granted)
     SELECT $1, id, FALSE FROM permissions WHERE key = 'test.perm.notgranted'
     ON CONFLICT (role_id, permission_id) DO UPDATE SET granted = FALSE`,
    [role13]
  );
  const user13 = await createUser('perm_partial_user', role13, 1);
  const token13 = generateUserToken(user13, role13, 1);
  const res13 = await request('GET', '/api/auth/permissions', null, token13);
  assert(res13.status === 200, 'TEST 13a: expect 200 OK');
  assert(res13.body.data.permissions.includes('test.perm.granted'), 'TEST 13b: granted permission present');
  assert(!res13.body.data.permissions.includes('test.perm.notgranted'),
    `TEST 13c: non-granted permission should NOT appear, got ${JSON.stringify(res13.body.data.permissions)}`);

  // ==========================================================================
  // TEST 14: Unauthenticated request
  // ==========================================================================
  console.log('\n--- TEST 14: Unauthenticated request ---');
  const res14 = await request('GET', '/api/auth/permissions');
  assert(res14.status === 401, `TEST 14a: expect 401, got ${res14.status}`);
  assert(res14.body.code === 'UNAUTHORIZED', `TEST 14b: expect UNAUTHORIZED, got ${res14.body.code}`);

  // ==========================================================================
  // TEST 15: MOBILE_ONLY user blocked by requirePmsAccess
  // Generates a token with access_type=MOBILE_ONLY directly (no DB user needed).
  // requireAuth verifies the JWT; requirePmsAccess then blocks MOBILE_ONLY.
  // ==========================================================================
  console.log('\n--- TEST 15: MOBILE_ONLY access_type blocked ---');
  const mobileToken = generateToken({
    id: 999999999,
    email: 'mobile@oak.test',
    username: 'mobile_user',
    full_name: 'Mobile User',
    role: 'Test Role',
    role_id: 1,
    property_id: 1,
    scope: 'FULL',
    account_status: 'READY',
    must_change_password: false,
    access_type: 'MOBILE_ONLY'
  });
  const res15 = await request('GET', '/api/auth/permissions', null, mobileToken);
  assert(res15.status === 403, `TEST 15a: expect 403, got ${res15.status}`);
  assert(res15.body.code === 'MOBILE_ONLY_RESTRICTED', `TEST 15b: expect MOBILE_ONLY_RESTRICTED, got ${res15.body.code}`);

  // ==========================================================================
  // TEST 16: Cross-property custom role (role property != user property)
  // A user in Property A must NOT access a role scoped to Property B.
  // ==========================================================================
  console.log('\n--- TEST 16: Cross-property custom role blocked ---');
  // Create a role scoped to property 2
  testCounter++;
  const crossPropRoleName = `PermTestCrossProp_${process.pid}_${Date.now()}_${testCounter}`;
  const crossRoleRes = await pool.query(
    `INSERT INTO roles (name, property_id, is_active, is_system_role)
     VALUES ($1, $2, $3, false)
     RETURNING id`,
    [crossPropRoleName, 2, true]
  );
  const crossRoleId = Number(crossRoleRes.rows[0].id);
  // Grant a permission to this cross-property role
  await grantPermission(crossRoleId, 'test.perm.crossprop');
  // Create user in property 1 but assigned to property 2's role
  testCounter++;
  const crossUserRes = await pool.query(
    `INSERT INTO users (username, email, password_hash, full_name, role_id, property_id, is_active, account_status, access_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [`perm_cross_prop_${process.pid}_${Date.now()}`, `crossprop${Date.now()}@oak.test`, '$2a$10$UnchangedCustomHashForTest00000000',
     `perm_cross_prop_${process.pid}_${Date.now()}`, crossRoleId, 1, true, 'READY', 'PMS_STAFF']
  );
  const crossUser = Number(crossUserRes.rows[0].id);
  const crossToken = generateUserToken(crossUser, crossRoleId, 1);
  const res16 = await request('GET', '/api/auth/permissions', null, crossToken);
  assert(res16.status === 403, `TEST 16a: expect 403, got ${res16.status}`);
  assert(res16.body.code === 'ACCOUNT_ROLE_INVALID', `TEST 16b: expect ACCOUNT_ROLE_INVALID, got ${res16.body.code}`);
  // Also verify the permission was NOT returned (should not reach handler)
  assert(!res16.body.data || !res16.body.data.permissions.includes('test.perm.crossprop'), 'TEST 16c: cross-prop permission must not be exposed');

  // ==========================================================================
  // TEST 17: Global/system role with null property_id is allowed
  // Platform/system roles should be usable by any property's users.
  // ==========================================================================
  console.log('\n--- TEST 17: Global system role (null property_id) allowed ---');
  testCounter++;
  const globalRoleName = `PermTestGlobal_${process.pid}_${Date.now()}_${testCounter}`;
  const globalRoleRes = await pool.query(
    `INSERT INTO roles (name, property_id, is_active, is_system_role)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [globalRoleName, null, true, true]
  );
  const globalRoleId = Number(globalRoleRes.rows[0].id);
  await grantPermission(globalRoleId, 'test.perm.global');
  testCounter++;
  const globalUserRes = await pool.query(
    `INSERT INTO users (username, email, password_hash, full_name, role_id, property_id, is_active, account_status, access_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [`perm_global_${process.pid}_${Date.now()}`, `global${Date.now()}@oak.test`, '$2a$10$UnchangedCustomHashForTest00000000',
     `perm_global_${process.pid}_${Date.now()}`, globalRoleId, 1, true, 'READY', 'PMS_STAFF']
  );
  const globalUser = Number(globalUserRes.rows[0].id);
  const globalToken = generateUserToken(globalUser, globalRoleId, 1);
  const res17 = await request('GET', '/api/auth/permissions', null, globalToken);
  assert(res17.status === 200, `TEST 17a: expect 200 OK, got ${res17.status}`);
  assert(res17.body.status === 'OK', 'TEST 17b: response status OK');
  assert(res17.body.data.permissions.includes('test.perm.global'), 'TEST 17c: global role permission is accessible');

  // ==========================================================================
  // Bulk cleanup
  // ==========================================================================
  await pool.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name LIKE 'PermTestRole%' OR name LIKE 'PermTestCrossProp%' OR name LIKE 'PermTestGlobal%')`).catch(() => {});
  await pool.query(`DELETE FROM users WHERE username LIKE 'permtst%' OR username LIKE 'perm_null_%' OR username LIKE 'perm_str_%' OR username LIKE 'perm_mobile_%' OR username LIKE 'perm_cross_prop_%' OR username LIKE 'perm_global_%'`).catch(() => {});
  await pool.query(`DELETE FROM roles WHERE name LIKE 'PermTestRole%' OR name LIKE 'PermTestCrossProp%' OR name LIKE 'PermTestGlobal%'`).catch(() => {});

  // ==========================================================================
  // Summary
  // ==========================================================================
  console.log(`\n=== RESULTS: ${passed}/${total} assertions passed ===`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await initializeDatabase(pool);

  server = app.listen(0);
  await once(server, 'listening');
  // port is available via server.address().port but we capture it in request()

  try {
    await runTests();
  } catch (err) {
    console.error('\n=== TEST FAILED ===');
    console.error(err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    server.close();
    await pool.end();
  }
}

main();
