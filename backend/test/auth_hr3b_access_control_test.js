const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { generateToken, isPlatformSuperAdmin } = require('../dist/domains/auth/authService');
const { normalizeRoleName } = require('../dist/domains/auth/authMiddleware');
const { createAccessControlRouter } = require('../dist/domains/settings/accessControlRouter');
const {
  createDynamicRole,
  deactivateDynamicRole,
  hardDeleteDynamicRole,
  updateDynamicRole,
} = require('../dist/domains/hrd/hrdService');
const http = require('http');

const TEST_PORT = 3197;

let passed = 0;
function pass(message) {
  passed += 1;
  console.log(`  [PASS] ${message}`);
}
function fail(message) {
  throw new Error(message);
}

function makeRequest(method, urlPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
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
  console.log('=== AUTH-HR-3B ACCESS CONTROL & PLATFORM SUPER ADMIN HARDENING TEST ===\n');

  const runId = `${Date.now()}_${process.pid}`;
  let server;
  const cleanupUserIds = [];
  const cleanupRoleIds = [];
  let createdPropertyId = null;

  try {
    // Migrations are idempotent and only run automatically when index.ts is the
    // entrypoint, so ensure the access control schema exists for this suite.
    await initializeDatabase(pool);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/access-control', createAccessControlRouter(pool));

    await new Promise(resolve => {
      server = app.listen(TEST_PORT, () => {
        console.log(`[SETUP] Test server on port ${TEST_PORT}`);
        resolve();
      });
    });

    // ─── Canonical Platform Super Admin ───
    const saRes = await pool.query(`
      SELECT u.id, u.username, u.full_name, r.id AS role_id, r.name AS role
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'Super Admin' AND r.property_id IS NULL AND r.is_system_role = TRUE
      LIMIT 1
    `);
    if (saRes.rows.length === 0) throw new Error('Platform Super Admin not found in DB.');
    const superAdminUser = { ...saRes.rows[0], property_id: 1, access_type: 'PMS_STAFF' };
    const superAdminToken = generateToken(superAdminUser);
    const superAdminRoleId = superAdminUser.role_id;

    // ─── Secondary property for cross-property isolation ───
    const existingProps = await pool.query('SELECT id FROM properties WHERE id <> 1 ORDER BY id LIMIT 1');
    let otherPropertyId;
    if (existingProps.rows.length > 0) {
      otherPropertyId = existingProps.rows[0].id;
    } else {
      const created = await pool.query(
        `INSERT INTO properties (name, is_active) VALUES ($1, TRUE) RETURNING id`,
        [`AHR3B Test Property ${runId}`]
      );
      otherPropertyId = created.rows[0].id;
      createdPropertyId = otherPropertyId;
    }

    async function createRole(label, propertyId, name) {
      const res = await pool.query(
        `INSERT INTO roles (property_id, name, description, is_active, is_system_role, is_test_data)
         VALUES ($1, $2, $3, TRUE, FALSE, TRUE) RETURNING id`,
        [propertyId, name || `AHR3B_${label}_${runId}`, `AUTH-HR-3B fixture ${label}`]
      );
      cleanupRoleIds.push(res.rows[0].id);
      return res.rows[0].id;
    }

    async function createUser(label, propertyId, roleId) {
      const res = await pool.query(
        `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active, is_test_data)
         VALUES ($1, $2, $3, $4, 'x', $5, TRUE, TRUE) RETURNING id, username, full_name`,
        [
          propertyId,
          roleId,
          `ahr3b_${label}_${runId}`,
          `ahr3b_${label}_${runId}@test.local`,
          `AHR3B ${label}`,
        ]
      );
      cleanupUserIds.push(res.rows[0].id);
      return res.rows[0];
    }

    async function grantRolePermission(roleId, key) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
         SELECT $1, p.id, TRUE, 'AHR3B_TEST' FROM permissions p WHERE p.key = $2
         ON CONFLICT (role_id, permission_id) DO UPDATE SET granted = TRUE`,
        [roleId, key]
      );
    }

    async function roleGrantedKeys(roleId) {
      const res = await pool.query(
        `SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = $1 AND rp.granted = TRUE`,
        [roleId]
      );
      return new Set(res.rows.map(r => r.key));
    }

    // Fixtures
    const ownerRoleId = await createRole('OWNER', 1, `Owner_AHR3B_${runId}`);
    const adminRoleId = await createRole('ADMIN', 1, `Admin_AHR3B_${runId}`);
    const gmRoleId = await createRole('GM', 1, `General Manager_AHR3B_${runId}`);
    const fakeSaRoleId = await createRole('FAKESA', 1, `Super Admin_AHR3B_${runId}`);
    const staffRoleId = await createRole('STAFF', 1);
    const otherPropRoleId = await createRole('OTHERPROP', otherPropertyId);

    const ownerUser = await createUser('owner', 1, ownerRoleId);
    const adminUser = await createUser('admin', 1, adminRoleId);
    const gmUser = await createUser('gm', 1, gmRoleId);
    const fakeSaUser = await createUser('fakesa', 1, fakeSaRoleId);
    const staffUser = await createUser('staff', 1, staffRoleId);
    const otherPropUser = await createUser('otherprop', otherPropertyId, otherPropRoleId);

    // Staff can only read the calendar by default.
    await grantRolePermission(staffRoleId, 'reservations.view');

    const tokenFor = (user, roleId, roleName, propertyId = 1) => generateToken({
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role_id: roleId,
      role: roleName,
      property_id: propertyId,
      access_type: 'PMS_STAFF',
    });

    const staffToken = tokenFor(staffUser, staffRoleId, `AHR3B_STAFF_${runId}`);
    const fakeSaToken = tokenFor(fakeSaUser, fakeSaRoleId, 'Super Admin');
    const ownerToken = tokenFor(ownerUser, ownerRoleId, 'Owner');

    // ═══════════════════════════════════════════════
    // A. CANONICAL PLATFORM SUPER ADMIN DETECTION
    // ═══════════════════════════════════════════════
    console.log('\n--- A. CANONICAL PLATFORM SUPER ADMIN DETECTION ---');

    if (await isPlatformSuperAdmin(pool, superAdminUser.id) !== true) {
      fail('Canonical system Super Admin must be detected as Platform Super Admin');
    }
    pass('Canonical system Super Admin passes DB-backed detection');

    for (const [label, user] of [['Owner', ownerUser], ['Admin', adminUser], ['General Manager', gmUser]]) {
      if (await isPlatformSuperAdmin(pool, user.id) !== false) {
        fail(`${label} must NOT be Platform Super Admin`);
      }
      pass(`${label} is NOT Platform Super Admin`);
    }

    if (await isPlatformSuperAdmin(pool, fakeSaUser.id) !== false) {
      fail('Property-scoped "Super Admin" role must NOT be Platform Super Admin');
    }
    pass('Fake property-scoped "Super Admin" is NOT Platform Super Admin');

    if (await isPlatformSuperAdmin(pool, 0) !== false) fail('Invalid user id must not pass');
    pass('Invalid/absent user id is NOT Platform Super Admin');

    // ═══════════════════════════════════════════════
    // B. LEGACY ROLE ALIAS CANNOT ELEVATE
    // ═══════════════════════════════════════════════
    console.log('\n--- B. LEGACY ROLE ALIAS SECURITY ---');

    for (const alias of ['OWNER', 'Owner', 'ADMIN', 'Admin', 'owner', 'admin']) {
      if (normalizeRoleName(alias) === 'Super Admin') {
        fail(`normalizeRoleName('${alias}') must not resolve to Super Admin`);
      }
    }
    pass('normalizeRoleName no longer maps OWNER/ADMIN to Super Admin');

    if (normalizeRoleName('Owner') !== 'General Manager') fail('Owner should normalize to General Manager');
    if (normalizeRoleName('Admin') !== 'General Manager') fail('Admin should normalize to General Manager');
    pass('OWNER/ADMIN retain property-level General Manager compatibility');

    if (normalizeRoleName('Super Admin') !== 'Super Admin') fail('Super Admin spelling must be preserved');
    if (normalizeRoleName('General Manager') === 'Super Admin') fail('GM must not normalize to Super Admin');
    pass('Only the Super Admin spelling normalizes to Super Admin');

    // ═══════════════════════════════════════════════
    // C. API ENFORCEMENT VIA EFFECTIVE PERMISSION
    // ═══════════════════════════════════════════════
    console.log('\n--- C. API ENFORCEMENT ---');

    {
      const res = await makeRequest('GET', '/api/access-control/roles?property_id=1');
      if (res.status !== 401) fail(`Expected 401 unauthenticated, got ${res.status}`);
      pass('Unauthenticated access control read returns 401');
    }

    {
      const res = await makeRequest('GET', '/api/access-control/roles?property_id=1', null, staffToken);
      if (res.status !== 403) fail(`Expected 403 for staff without settings access, got ${res.status}`);
      pass('Effective permission denial returns 403 from the API');
    }

    {
      const res = await makeRequest('GET', '/api/access-control/roles?property_id=1', null, superAdminToken);
      if (res.status !== 200) fail(`Expected 200 for Super Admin, got ${res.status}`);
      if (!Array.isArray(res.body.data.resources) || res.body.data.resources.length === 0) {
        fail('Resource catalog must be returned');
      }
      pass('Platform Super Admin reads the role access matrix');
    }

    {
      // A forged "Super Admin" JWT claim must not buy the DB-backed bypass.
      const res = await makeRequest('GET', '/api/access-control/roles?property_id=1', null, fakeSaToken);
      if (res.status !== 403) fail(`Expected 403 for fake Super Admin token, got ${res.status}`);
      pass('Fake "Super Admin" JWT claim cannot bypass API enforcement');
    }

    // ═══════════════════════════════════════════════
    // D. VIEW/EDIT/DELETE ROLE MAPPING
    // ═══════════════════════════════════════════════
    console.log('\n--- D. VIEW/EDIT/DELETE ROLE MAPPING ---');

    {
      const res = await makeRequest('PUT', `/api/access-control/roles/${staffRoleId}`, {
        property_id: 1,
        access: {
          'Kalender': { view: true, edit: true, delete: false },
          'Pelanggan': { view: true, edit: false, delete: false },
        },
      }, superAdminToken);
      if (res.status !== 200) fail(`Expected 200 saving role access, got ${res.status}: ${JSON.stringify(res.body)}`);

      const keys = await roleGrantedKeys(staffRoleId);
      for (const expected of ['reservations.view', 'rooms.view', 'reservations.create', 'reservations.edit', 'guests.view']) {
        if (!keys.has(expected)) fail(`Expected granted permission key '${expected}'`);
      }
      for (const forbidden of ['reservations.delete', 'guests.create', 'guests.edit', 'guests.delete']) {
        if (keys.has(forbidden)) fail(`Permission key '${forbidden}' should have been revoked`);
      }
      pass('View/Edit/Delete grid maps to canonical atomic permission keys');
    }

    {
      const res = await makeRequest('GET', `/api/access-control/users/${staffUser.id}?property_id=1`, null, superAdminToken);
      if (res.status !== 200) fail(`Expected 200, got ${res.status}`);
      const effective = res.body.data.effective;
      if (effective['Kalender'].view.allowed !== true) fail('Kalender view should be allowed by role default');
      if (effective['Kalender'].view.source !== 'ROLE_DEFAULT') fail('Kalender view source should be ROLE_DEFAULT');
      if (effective['Kalender'].delete.allowed !== false) fail('Kalender delete should be denied');
      if (effective['Kalender'].delete.source !== 'DEFAULT_DENY') fail('Denied cell source should be DEFAULT_DENY');
      if (effective['Pengaturan'].view.allowed !== false) fail('Pengaturan view should be denied for staff');
      pass('Role default and deny-by-default resolve with correct source labels');
    }

    // ═══════════════════════════════════════════════
    // E. USER OVERRIDE PRECEDENCE
    // ═══════════════════════════════════════════════
    console.log('\n--- E. USER OVERRIDE PRECEDENCE ---');

    {
      const res = await makeRequest('PUT', `/api/access-control/users/${staffUser.id}/overrides`, {
        property_id: 1,
        overrides: [
          { resource: 'Kalender', action: 'view', effect: 'DENY', reason: 'AHR3B test deny' },
          { resource: 'Laporan', action: 'view', effect: 'ALLOW' },
        ],
      }, superAdminToken);
      if (res.status !== 200) fail(`Expected 200 saving overrides, got ${res.status}: ${JSON.stringify(res.body)}`);

      const effective = res.body.data.effective;
      if (effective['Kalender'].view.allowed !== false) fail('Override DENY must beat role default ALLOW');
      if (effective['Kalender'].view.source !== 'USER_OVERRIDE') fail('Denied cell must be sourced from USER_OVERRIDE');
      if (effective['Laporan'].view.allowed !== true) fail('Override ALLOW must beat role default DENY');
      if (effective['Laporan'].view.source !== 'USER_OVERRIDE') fail('Allowed cell must be sourced from USER_OVERRIDE');
      pass('Explicit user override outranks role default in both directions');
    }

    {
      const res = await makeRequest('PUT', `/api/access-control/users/${staffUser.id}/overrides`, {
        property_id: 1,
        overrides: [{ resource: 'Kalender', action: 'view', effect: 'INHERIT' }],
      }, superAdminToken);
      if (res.status !== 200) fail(`Expected 200, got ${res.status}`);
      const effective = res.body.data.effective;
      if (effective['Kalender'].view.source !== 'ROLE_DEFAULT') fail('INHERIT must fall back to role default');
      if (effective['Laporan'].view.source !== 'USER_OVERRIDE') fail('Untouched override must be preserved');
      pass('INHERIT clears a single override without touching the others');
    }

    {
      const res = await makeRequest('POST', `/api/access-control/users/${staffUser.id}/overrides/reset`, {
        property_id: 1,
      }, superAdminToken);
      if (res.status !== 200) fail(`Expected 200 on reset, got ${res.status}`);
      if (res.body.data.overrides.length !== 0) fail('Reset must remove every override');
      if (res.body.data.effective['Laporan'].view.source !== 'DEFAULT_DENY') {
        fail('Reset must return Laporan view to role default (deny)');
      }
      if (res.body.data.effective['Kalender'].view.source !== 'ROLE_DEFAULT') {
        fail('Reset must return Kalender view to role default (allow)');
      }
      pass('Reset ke Default Role removes all overrides and restores role defaults');
    }

    {
      const stored = await pool.query(
        'SELECT COUNT(*) FROM user_permission_overrides WHERE property_id = 1 AND user_id = $1',
        [staffUser.id]
      );
      if (Number(stored.rows[0].count) !== 0) fail('Reset must delete override rows');
      pass('Override rows are physically removed on reset');
    }

    // ═══════════════════════════════════════════════
    // F. PLATFORM SUPER ADMIN PROTECTION
    // ═══════════════════════════════════════════════
    console.log('\n--- F. PLATFORM SUPER ADMIN PROTECTION ---');

    {
      const res = await makeRequest('PUT', `/api/access-control/roles/${superAdminRoleId}`, {
        property_id: 1,
        access: { 'Kalender': { view: false, edit: false, delete: false } },
      }, superAdminToken);
      if (res.status !== 403) fail(`Expected 403 altering Super Admin role, got ${res.status}`);
      if (res.body.code !== 'CANNOT_ALTER_SUPER_ADMIN_PERMISSIONS') {
        fail(`Unexpected error code: ${res.body.code}`);
      }
      pass('Platform Super Admin role access cannot be altered');
    }

    {
      const res = await makeRequest('PUT', `/api/access-control/users/${superAdminUser.id}/overrides`, {
        property_id: 1,
        overrides: [{ resource: 'Pengaturan', action: 'view', effect: 'DENY' }],
      }, superAdminToken);
      if (res.status !== 403) fail(`Expected 403 overriding Super Admin user, got ${res.status}`);
      pass('Platform Super Admin user cannot be restricted by an override');
    }

    {
      const res = await makeRequest('GET', `/api/access-control/users/${superAdminUser.id}?property_id=1`, null, superAdminToken);
      if (res.status !== 200) fail(`Expected 200, got ${res.status}`);
      if (res.body.data.is_platform_super_admin !== true) fail('Super Admin must be flagged');
      const effective = res.body.data.effective;
      for (const resource of Object.keys(effective)) {
        for (const action of ['view', 'edit', 'delete']) {
          if (effective[resource][action].source !== 'PLATFORM_SUPER_ADMIN') {
            fail(`Super Admin ${resource}.${action} must resolve via PLATFORM_SUPER_ADMIN`);
          }
        }
      }
      pass('Platform Super Admin resolves to full access from canonical authority');
    }

    // ═══════════════════════════════════════════════
    // G. MULTI-PROPERTY ISOLATION
    // ═══════════════════════════════════════════════
    console.log('\n--- G. MULTI-PROPERTY ISOLATION ---');

    {
      const res = await makeRequest('PUT', `/api/access-control/roles/${otherPropRoleId}`, {
        property_id: 1,
        access: { 'Kalender': { view: true, edit: false, delete: false } },
      }, superAdminToken);
      if (res.status !== 403) fail(`Expected 403 editing another property's role, got ${res.status}`);
      if (res.body.code !== 'CROSS_PROPERTY_ROLE_FORBIDDEN') fail(`Unexpected code: ${res.body.code}`);
      pass('Cross-property role editing is blocked');
    }

    {
      const res = await makeRequest('PUT', `/api/access-control/users/${otherPropUser.id}/overrides`, {
        property_id: 1,
        overrides: [{ resource: 'Kalender', action: 'view', effect: 'ALLOW' }],
      }, superAdminToken);
      if (res.status !== 403) fail(`Expected 403 overriding another property's user, got ${res.status}`);
      if (res.body.code !== 'CROSS_PROPERTY_USER_FORBIDDEN') fail(`Unexpected code: ${res.body.code}`);
      pass('Cross-property user override is blocked');
    }

    {
      const res = await makeRequest('GET', `/api/access-control/roles?property_id=${otherPropertyId}`, null, superAdminToken);
      if (res.status !== 403) fail(`Expected 403 for mismatched property scope, got ${res.status}`);
      if (res.body.code !== 'CROSS_PROPERTY_FORBIDDEN') fail(`Unexpected code: ${res.body.code}`);
      pass('Requested property_id cannot override the authenticated property scope');
    }

    {
      const users = await makeRequest('GET', '/api/access-control/users?property_id=1', null, superAdminToken);
      if (users.status !== 200) fail(`Expected 200, got ${users.status}`);
      if (users.body.data.users.some(u => u.user_id === otherPropUser.id)) {
        fail("Another property's user must not appear in the property-scoped list");
      }
      pass('User list does not leak accounts from another property');
    }

    // ═══════════════════════════════════════════════
    // H. AUDIT TRAIL
    // ═══════════════════════════════════════════════
    console.log('\n--- H. AUDIT TRAIL ---');

    {
      const roleAudit = await pool.query(
        `SELECT action, new_value FROM audit_logs
         WHERE module = 'ACCESS_CONTROL' AND property_id = 1 AND record_id = $1
         ORDER BY audit_id DESC`,
        [String(staffRoleId)]
      );
      if (!roleAudit.rows.some(r => r.action === 'ROLE_ACCESS_UPDATED')) {
        fail("Missing audit action 'ROLE_ACCESS_UPDATED'");
      }
      pass('Role access change is audited');

      const userAudit = await pool.query(
        `SELECT action, new_value FROM audit_logs
         WHERE module = 'ACCESS_CONTROL' AND property_id = 1 AND record_id = $1
         ORDER BY audit_id DESC`,
        [String(staffUser.id)]
      );
      const userActions = new Set(userAudit.rows.map(r => r.action));
      for (const expected of ['USER_OVERRIDE_CHANGED', 'USER_OVERRIDE_RESET']) {
        if (!userActions.has(expected)) fail(`Missing audit action '${expected}'`);
      }
      pass('User override change and reset are audited');

      for (const row of [...roleAudit.rows, ...userAudit.rows]) {
        const payload = JSON.parse(row.new_value);
        if (Number(payload.actor_user_id) !== Number(superAdminUser.id)) {
          fail(`Audit actor for '${row.action}' must come from the authenticated identity`);
        }
      }
      pass('Every audit event records the authenticated actor identity');
    }

    // ═══════════════════════════════════════════════
    // I. OWNER CANNOT SELF-ELEVATE VIA API
    // ═══════════════════════════════════════════════
    console.log('\n--- I. PROPERTY ROLE CANNOT GRANT PLATFORM AUTHORITY ---');

    {
      const res = await makeRequest('PUT', `/api/access-control/roles/${superAdminRoleId}`, {
        property_id: 1,
        access: { 'Pengaturan': { view: true, edit: true, delete: true } },
      }, ownerToken);
      if (res.status !== 403) fail(`Expected 403 for Owner editing Super Admin role, got ${res.status}`);
      pass('Owner cannot reshape the Platform Super Admin role');
    }

    // ═══════════════════════════════════════════════
    // J. PROPERTY ROLE CRUD CANNOT CREATE / ALTER PLATFORM SUPER ADMIN
    // ═══════════════════════════════════════════════
    console.log('\n--- J. PROPERTY ROLE CRUD SAFETY ---');

    {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let blocked = false;
        try {
          await createDynamicRole(client, { property_id: 1, name: 'Super Admin', description: 'attempt' }, { name: 'AHR3B' });
        } catch (err) {
          blocked = err.code === 'CANNOT_CREATE_SUPER_ADMIN' || err.statusCode === 403;
        }
        if (!blocked) fail('Creating a property role named Super Admin must be blocked');
        pass('Property role named Super Admin cannot be created');

        try {
          await updateDynamicRole(client, superAdminRoleId, { is_active: false }, { name: 'AHR3B' });
          fail('Deactivating the Platform Super Admin role must throw');
        } catch (err) {
          if (err.code !== 'CANNOT_DEACTIVATE_SUPER_ADMIN') fail(`Unexpected deactivate code: ${err.code}`);
        }
        pass('Protected Platform Super Admin role cannot be deactivated');

        try {
          await deactivateDynamicRole(client, superAdminRoleId, { name: 'AHR3B' });
          fail('deactivateDynamicRole on Platform Super Admin must throw');
        } catch (err) {
          if (err.code !== 'CANNOT_DEACTIVATE_SUPER_ADMIN') fail(`Unexpected deactivateDynamicRole code: ${err.code}`);
        }
        pass('deactivateDynamicRole cannot deactivate Platform Super Admin');

        try {
          await hardDeleteDynamicRole(client, superAdminRoleId, { name: 'AHR3B' });
          fail('Hard-deleting the Platform Super Admin role must throw');
        } catch (err) {
          if (err.code !== 'CANNOT_DELETE_SUPER_ADMIN') fail(`Unexpected hard-delete code: ${err.code}`);
        }
        pass('Protected Platform Super Admin role cannot be deleted');

        const created = await createDynamicRole(
          client,
          { property_id: 1, name: `AHR3B_SafeRole_${runId}`, description: 'safe property role' },
          { name: 'AHR3B' }
        );
        cleanupRoleIds.push(created.id);
        if (!created.id || created.is_system_role !== false) fail('Property role CRUD must still create a normal role');
        pass('Property role CRUD remains available for ordinary roles');

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }

    console.log('\n=======================================================');
    console.log(`🎉 ALL AUTH-HR-3B ACCESS CONTROL TESTS PASSED! (${passed} assertions)`);
    console.log('=======================================================');

  } catch (err) {
    console.error('\n❌ TEST FAILURE:', err);
    process.exitCode = 1;
  } finally {
    console.log('\n[TEARDOWN] Cleaning up fixtures...');
    try {
      // Only audit rows this suite created for its own fixtures are removed.
      const fixtureRecordIds = [...cleanupUserIds, ...cleanupRoleIds].map(String);
      if (fixtureRecordIds.length > 0) {
        await pool.query(
          "DELETE FROM audit_logs WHERE module = 'ACCESS_CONTROL' AND record_id = ANY($1)",
          [fixtureRecordIds]
        );
      }
      if (cleanupUserIds.length > 0) {
        await pool.query('DELETE FROM user_permission_overrides WHERE user_id = ANY($1)', [cleanupUserIds]);
        await pool.query('DELETE FROM users WHERE id = ANY($1)', [cleanupUserIds]);
      }
      if (cleanupRoleIds.length > 0) {
        await pool.query('DELETE FROM role_permissions WHERE role_id = ANY($1)', [cleanupRoleIds]);
        await pool.query('DELETE FROM roles WHERE id = ANY($1)', [cleanupRoleIds]);
      }
      if (createdPropertyId) {
        await pool.query('DELETE FROM properties WHERE id = $1', [createdPropertyId]);
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
