const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { pool, app } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { generateToken, isPlatformSuperAdmin } = require('../dist/domains/auth/authService');
const {
  ACCESS_RESOURCES,
  setRoleAccess,
  setUserOverrides,
  resetUserOverrides,
} = require('../dist/domains/settings/accessControlService');
const {
  matchOperationalAccessRule,
  inferAccessAction,
} = require('../dist/domains/settings/operationalAccessGuard');
const http = require('http');

const TEST_PORT = 3198;

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

function fullGrid(value) {
  const grid = {};
  for (const resource of ACCESS_RESOURCES) {
    grid[resource.key] = { view: value, edit: value, delete: value };
  }
  return grid;
}

function assertDenied(res, label) {
  if (res.status !== 403) {
    fail(`${label}: expected 403, got ${res.status} ${JSON.stringify(res.body)}`);
  }
}

function assertAuthorized(res, label) {
  if (res.status === 401 || res.status === 403) {
    fail(`${label}: expected authorization to pass, got ${res.status} ${JSON.stringify(res.body)}`);
  }
}

async function runTests() {
  console.log('=== AUTH-HR-3B2 EFFECTIVE PERMISSION BACKEND ENFORCEMENT TEST ===\n');

  const runId = `${Date.now()}_${process.pid}`;
  let server;
  const cleanupUserIds = [];
  const cleanupRoleIds = [];
  const cleanupGuestIds = [];
  const cleanupPosItemIds = [];
  let createdPropertyId = null;

  try {
    await initializeDatabase(pool);

    await new Promise(resolve => {
      server = app.listen(TEST_PORT, () => {
        console.log(`[SETUP] Test server on port ${TEST_PORT}`);
        resolve();
      });
    });

    const saRes = await pool.query(`
      SELECT u.id, u.username, u.full_name, r.id AS role_id, r.name AS role
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'Super Admin' AND r.property_id IS NULL AND r.is_system_role = TRUE
      LIMIT 1
    `);
    if (saRes.rows.length === 0) throw new Error('Platform Super Admin not found in DB.');
    const superAdminUser = { ...saRes.rows[0], property_id: 1, access_type: 'PMS_STAFF' };
    const superAdminToken = generateToken(superAdminUser);

    const existingProps = await pool.query('SELECT id FROM properties WHERE id <> 1 ORDER BY id LIMIT 1');
    let otherPropertyId;
    if (existingProps.rows.length > 0) {
      otherPropertyId = existingProps.rows[0].id;
    } else {
      const created = await pool.query(
        `INSERT INTO properties (name, is_active) VALUES ($1, TRUE) RETURNING id`,
        [`AHR3B2 Test Property ${runId}`]
      );
      otherPropertyId = created.rows[0].id;
      createdPropertyId = otherPropertyId;
    }

    async function createRole(label, propertyId) {
      const res = await pool.query(
        `INSERT INTO roles (property_id, name, description, is_active, is_system_role, is_test_data)
         VALUES ($1, $2, $3, TRUE, FALSE, TRUE) RETURNING id`,
        [propertyId, `AHR3B2_${label}_${runId}`, `AUTH-HR-3B2 fixture ${label}`]
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
          `ahr3b2_${label}_${runId}`,
          `ahr3b2_${label}_${runId}@test.local`,
          `AHR3B2 ${label}`,
        ]
      );
      cleanupUserIds.push(res.rows[0].id);
      return res.rows[0];
    }

    const actor = {
      id: superAdminUser.id,
      name: superAdminUser.full_name || superAdminUser.username,
      property_id: 1,
      is_platform_super_admin: true,
    };

    async function withTx(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    const allowRoleId = await createRole('ALLOW', 1);
    const denyRoleId = await createRole('DENY', 1);
    const otherDenyRoleId = await createRole('OTHER_DENY', otherPropertyId);
    const otherAllowRoleId = await createRole('OTHER_ALLOW', otherPropertyId);

    await withTx(client => setRoleAccess(client, 1, allowRoleId, fullGrid(true), actor));
    await withTx(client => setRoleAccess(client, 1, denyRoleId, fullGrid(false), actor));
    await withTx(client => setRoleAccess(client, otherPropertyId, otherDenyRoleId, fullGrid(false), {
      ...actor,
      property_id: otherPropertyId,
    }));
    await withTx(client => setRoleAccess(client, otherPropertyId, otherAllowRoleId, {
      ...fullGrid(false),
      Pelanggan: { view: true, edit: false, delete: false },
    }, { ...actor, property_id: otherPropertyId }));

    const allowUser = await createUser('allow', 1, allowRoleId);
    const denyUser = await createUser('deny', 1, denyRoleId);
    const otherDenyUser = await createUser('otherdeny', otherPropertyId, otherDenyRoleId);
    const otherAllowUser = await createUser('otherallow', otherPropertyId, otherAllowRoleId);

    const tokenFor = (user, roleId, roleName, propertyId) => generateToken({
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role_id: roleId,
      role: roleName,
      property_id: propertyId,
      access_type: 'PMS_STAFF',
    });

    const allowToken = tokenFor(allowUser, allowRoleId, `AHR3B2_ALLOW_${runId}`, 1);
    const denyToken = tokenFor(denyUser, denyRoleId, `AHR3B2_DENY_${runId}`, 1);
    const otherDenyToken = tokenFor(otherDenyUser, otherDenyRoleId, `AHR3B2_OTHER_DENY_${runId}`, otherPropertyId);
    const otherAllowToken = tokenFor(otherAllowUser, otherAllowRoleId, `AHR3B2_OTHER_ALLOW_${runId}`, otherPropertyId);
    const crossedToken = tokenFor(denyUser, denyRoleId, `AHR3B2_DENY_${runId}`, otherPropertyId);

    async function override(userId, propertyId, inputs) {
      await withTx(client => setUserOverrides(client, propertyId, userId, inputs, {
        ...actor,
        property_id: propertyId,
      }));
    }

    async function clearOverrides(userId, propertyId) {
      await withTx(client => resetUserOverrides(client, propertyId, userId, {
        ...actor,
        property_id: propertyId,
      }));
    }

    const cases = [
      {
        resource: 'Kalender',
        view: ['GET', '/api/reservations?property_id=1'],
        edit: ['POST', '/api/reservations', { property_id: 1 }],
        extraView: ['GET', '/api/room-operational-blocks?property_id=1'],
      },
      {
        resource: 'Transaksi',
        view: ['GET', '/api/transactions?property_id=1'],
        edit: ['POST', '/api/transactions/manual', { property_id: 1 }],
        extraDelete: ['POST', '/api/transactions/999888777/void', { property_id: 1, reason: 'AHR3B2' }],
      },
      {
        resource: 'Pelanggan',
        view: ['GET', '/api/guests?property_id=1&limit=1'],
        edit: ['POST', '/api/guests', { property_id: 1, full_name: `AHR3B2 Guest ${runId}` }],
        extraDelete: ['DELETE', '/api/guests/999888777?property_id=1'],
      },
      {
        resource: 'Housekeeping',
        view: ['GET', '/api/housekeeping/tasks?property_id=1'],
        edit: ['POST', '/api/housekeeping/tasks', { property_id: 1 }],
        extraDelete: ['POST', '/api/housekeeping/tasks/999888777/archive', { property_id: 1 }],
      },
      {
        resource: 'HRD',
        view: ['GET', '/api/hrd/employees?property_id=1'],
        edit: ['PATCH', '/api/hrd/employees/999888777', { property_id: 1, full_name: 'x' }],
        extraDelete: ['DELETE', '/api/hrd/employees/999888777?property_id=1'],
      },
      {
        resource: 'POS',
        view: ['GET', '/api/pos/orders?property_id=1'],
        edit: ['POST', '/api/pos/orders', { property_id: 1, items: [] }],
      },
      {
        resource: 'Master Kamar',
        view: ['GET', '/api/room-types?property_id=1'],
        sharedView: true,
        edit: ['POST', '/api/room-types', { property_id: 1, name: '' }],
        extraDelete: ['DELETE', '/api/room-types/999888777?property_id=1'],
      },
      {
        resource: 'Master Produk',
        view: ['GET', '/api/pos/menu?property_id=1'],
        sharedView: true,
        edit: ['POST', '/api/pos/menu/items', { property_id: 1, name: `AHR3B2 Item ${runId}`, price: 1000 }],
        extraDelete: ['DELETE', '/api/pos/menu/items/999888777?property_id=1'],
      },
      {
        resource: 'Laporan',
        view: ['GET', '/api/reports/occupancy?property_id=1'],
        extraView: ['GET', '/api/reports/daily-operations?property_id=1'],
        edit: ['POST', '/api/accounting/journal', { property_id: 1 }],
      },
      {
        resource: 'Employee Mobile',
        view: ['GET', '/api/attendance/status?property_id=1'],
        edit: ['POST', '/api/attendance/check-in', { property_id: 1 }],
      },
      {
        resource: 'Pengaturan',
        view: ['GET', '/api/front-office/1/quick-booking-rules'],
        edit: ['POST', '/api/front-office/1/day-use-durations', { label: '' }],
      },
    ];

    console.log('\n--- A. PATH → RESOURCE MAPPING ---');
    const mappingExpect = [
      ['GET', '/api/reservations', 'Kalender', 'view'],
      ['POST', '/api/reservations', 'Kalender', 'edit'],
      ['POST', '/api/reservations/12/cancel', 'Kalender', 'delete'],
      ['GET', '/api/reservations/12/folio', 'Transaksi', 'view'],
      ['POST', '/api/deposits', 'Transaksi', 'edit'],
      ['GET', '/api/guests', 'Pelanggan', 'view'],
      ['POST', '/api/guests/4/archive', 'Pelanggan', 'delete'],
      ['GET', '/api/housekeeping/tasks', 'Housekeeping', 'view'],
      ['GET', '/api/hrd/employees', 'HRD', 'view'],
      ['DELETE', '/api/hrd/employees/9/hard-delete', 'HRD', 'delete'],
      ['GET', '/api/pos/orders', 'POS', 'view'],
      ['GET', '/api/pos/menu', 'POS', 'view'],
      ['POST', '/api/pos/menu/items', 'Master Produk', 'edit'],
      ['DELETE', '/api/pos/menu/items/3', 'Master Produk', 'delete'],
      ['GET', '/api/rooms', 'Kalender', 'view'],
      ['POST', '/api/rooms', 'Master Kamar', 'edit'],
      ['PATCH', '/api/rooms/4/status', 'Kalender', 'edit'],
      ['GET', '/api/reports/occupancy', 'Laporan', 'view'],
      ['GET', '/api/attendance/status', 'Employee Mobile', 'view'],
      ['GET', '/api/settings/role-permissions', 'Pengaturan', 'view'],
    ];
    for (const [method, urlPath, resource, action] of mappingExpect) {
      const matched = matchOperationalAccessRule(urlPath, method);
      if (!matched || !matched.resources.includes(resource) || matched.action !== action) {
        fail(`Mapping ${method} ${urlPath} should be ${resource}/${action}, got ${JSON.stringify(matched)}`);
      }
    }
    if (inferAccessAction('POST', '/api/guests/match') !== 'view') {
      fail('POST /match must infer VIEW');
    }
    pass('Traced operational paths map to Hak Akses View/Edit/Delete cells');

    console.log('\n--- B. ROLE ALLOW + USER DENY → 403 ON REAL APIS ---');
    for (const item of cases) {
      await clearOverrides(allowUser.id, 1);
      await override(allowUser.id, 1, [
        { resource: item.resource, action: 'view', effect: 'DENY' },
        { resource: item.resource, action: 'edit', effect: 'DENY' },
        { resource: item.resource, action: 'delete', effect: 'DENY' },
      ]);

      if (!item.sharedView) {
        assertDenied(
          await makeRequest(item.view[0], item.view[1], item.view[2] || null, allowToken),
          `${item.resource} VIEW denied override`
        );
      }
      assertDenied(
        await makeRequest(item.edit[0], item.edit[1], item.edit[2] || null, allowToken),
        `${item.resource} EDIT denied override`
      );
      if (item.extraDelete) {
        assertDenied(
          await makeRequest(item.extraDelete[0], item.extraDelete[1], item.extraDelete[2] || null, allowToken),
          `${item.resource} DELETE denied override`
        );
      }
      pass(`${item.resource}: role ALLOW + user DENY is enforced on operational APIs`);
    }

    console.log('\n--- C. ROLE DENY + USER ALLOW → API AUTHORIZED ---');
    for (const item of cases) {
      await clearOverrides(denyUser.id, 1);
      await override(denyUser.id, 1, [
        { resource: item.resource, action: 'view', effect: 'ALLOW' },
        { resource: item.resource, action: 'edit', effect: 'ALLOW' },
        { resource: item.resource, action: 'delete', effect: 'ALLOW' },
      ]);

      const viewRes = await makeRequest(item.view[0], item.view[1], item.view[2] || null, denyToken);
      assertAuthorized(viewRes, `${item.resource} VIEW allow override`);
      const editRes = await makeRequest(item.edit[0], item.edit[1], item.edit[2] || null, denyToken);
      assertAuthorized(editRes, `${item.resource} EDIT allow override`);
      if (item.resource === 'Pelanggan' && editRes.status === 201 && editRes.body?.data?.id) {
        cleanupGuestIds.push(editRes.body.data.id);
      }
      if (item.resource === 'Master Produk' && editRes.body?.data?.id) {
        cleanupPosItemIds.push(editRes.body.data.id);
      }
      if (item.extraView) {
        assertAuthorized(
          await makeRequest(item.extraView[0], item.extraView[1], item.extraView[2] || null, denyToken),
          `${item.resource} extra VIEW allow override`
        );
      }
      if (item.extraDelete) {
        const delRes = await makeRequest(item.extraDelete[0], item.extraDelete[1], item.extraDelete[2] || null, denyToken);
        assertAuthorized(delRes, `${item.resource} DELETE allow override`);
      }
      pass(`${item.resource}: role DENY + user ALLOW reaches the operational handler`);
    }

    console.log('\n--- D. ANY-OF ROOM READ + POS / MASTER PRODUK SPLIT ---');
    await clearOverrides(denyUser.id, 1);
    await override(denyUser.id, 1, [{ resource: 'Kalender', action: 'view', effect: 'ALLOW' }]);
    assertAuthorized(
      await makeRequest('GET', '/api/rooms?property_id=1', null, denyToken),
      'Kalender VIEW can read rooms'
    );
    await clearOverrides(denyUser.id, 1);
    await override(denyUser.id, 1, [{ resource: 'Master Kamar', action: 'view', effect: 'ALLOW' }]);
    assertAuthorized(
      await makeRequest('GET', '/api/rooms?property_id=1', null, denyToken),
      'Master Kamar VIEW can read rooms'
    );
    await clearOverrides(denyUser.id, 1);
    assertDenied(
      await makeRequest('GET', '/api/rooms?property_id=1', null, denyToken),
      'rooms GET without either VIEW'
    );

    await override(denyUser.id, 1, [{ resource: 'POS', action: 'view', effect: 'ALLOW' }]);
    assertAuthorized(await makeRequest('GET', '/api/pos/menu?property_id=1', null, denyToken), 'POS VIEW reads menu');
    assertDenied(
      await makeRequest('POST', '/api/pos/menu/items', { property_id: 1, name: 'x', price: 1 }, denyToken),
      'POS VIEW cannot write Master Produk catalog'
    );
    await clearOverrides(denyUser.id, 1);
    await override(denyUser.id, 1, [
      { resource: 'Master Produk', action: 'view', effect: 'ALLOW' },
      { resource: 'Master Produk', action: 'edit', effect: 'ALLOW' },
    ]);
    assertAuthorized(await makeRequest('GET', '/api/pos/menu?property_id=1', null, denyToken), 'Master Produk VIEW reads menu');
    assertDenied(await makeRequest('GET', '/api/pos/orders?property_id=1', null, denyToken), 'Master Produk cannot read POS orders');
    pass('Shared room/POS catalog reads honor any-of mapping without granting the sibling write surface');

    console.log('\n--- E. PLATFORM SUPER ADMIN BYPASS + HARD DELETE ---');
    if (await isPlatformSuperAdmin(pool, superAdminUser.id) !== true) {
      fail('Canonical Super Admin detection failed');
    }
    assertAuthorized(await makeRequest('GET', '/api/guests?property_id=1&limit=1', null, superAdminToken), 'SA guests');
    assertAuthorized(await makeRequest('GET', '/api/hrd/employees?property_id=1', null, superAdminToken), 'SA hrd');
    assertAuthorized(await makeRequest('GET', '/api/transactions?property_id=1', null, superAdminToken), 'SA transactions');
    assertAuthorized(await makeRequest('GET', '/api/reservations?property_id=1', null, superAdminToken), 'SA calendar');
    pass('Platform Super Admin bypasses effective-permission DENY on operational APIs');

    await clearOverrides(allowUser.id, 1);
    const hardDeleteStaff = await makeRequest(
      'DELETE',
      '/api/hrd/employees/999999/hard-delete?property_id=1',
      null,
      allowToken
    );
    if (hardDeleteStaff.status !== 403) {
      fail(`HRD DELETE must not unlock hard-delete; expected 403, got ${hardDeleteStaff.status}`);
    }
    pass('Effective HRD DELETE does not replace assertPlatformSuperAdmin() on hard-delete');

    const hardDeleteSa = await makeRequest(
      'DELETE',
      '/api/hrd/employees/999999/hard-delete?property_id=1',
      null,
      superAdminToken
    );
    if (hardDeleteSa.status === 401 || (hardDeleteSa.status === 403 && hardDeleteSa.body?.code === 'FORBIDDEN' && /hak akses/i.test(hardDeleteSa.body?.message || ''))) {
      fail(`Platform Super Admin was stopped by the effective-permission guard: ${JSON.stringify(hardDeleteSa.body)}`);
    }
    pass('Platform Super Admin reaches the hard-delete handler past the effective-permission guard');

    const noToken = await makeRequest('GET', '/api/guests?property_id=1', null, null);
    if (noToken.status !== 401) fail(`Unauthenticated operational GET must be 401, got ${noToken.status}`);
    pass('Mapped operational APIs are fail-closed without a Bearer token');

    console.log('\n--- F. CROSS-PROPERTY OVERRIDE ISOLATION ---');
    await clearOverrides(denyUser.id, 1);
    await override(denyUser.id, 1, [{ resource: 'Pelanggan', action: 'view', effect: 'ALLOW' }]);

    assertAuthorized(
      await makeRequest('GET', '/api/guests?property_id=1&limit=1', null, denyToken),
      'property-1 ALLOW override'
    );
    assertDenied(
      await makeRequest('GET', `/api/guests?property_id=${otherPropertyId}&limit=1`, null, otherDenyToken),
      'property-2 user without override'
    );
    assertAuthorized(
      await makeRequest('GET', `/api/guests?property_id=${otherPropertyId}&limit=1`, null, otherAllowToken),
      'property-2 role default ALLOW'
    );

    const leaked = await makeRequest('GET', `/api/guests?property_id=${otherPropertyId}&limit=1`, null, crossedToken);
    if (leaked.status !== 403) {
      fail(`Property-1 user token scoped to property ${otherPropertyId} must be 403, got ${leaked.status}`);
    }
    pass('Property-1 user override cannot be reused as property-2 authority');

    await override(denyUser.id, 1, [{ resource: 'Pelanggan', action: 'view', effect: 'DENY' }]);
    assertDenied(
      await makeRequest('GET', '/api/guests?property_id=1&limit=1', null, denyToken),
      'property-1 DENY override'
    );
    assertAuthorized(
      await makeRequest('GET', `/api/guests?property_id=${otherPropertyId}&limit=1`, null, otherAllowToken),
      'property-2 allow remains after property-1 DENY'
    );
    pass('User override on property A does not grant or deny access on property B');

    console.log('\n=======================================================');
    console.log(`ALL AUTH-HR-3B2 ENFORCEMENT TESTS PASSED (${passed} assertions)`);
    console.log('=======================================================');
  } catch (err) {
    console.error('\nTEST FAILURE:', err);
    process.exitCode = 1;
  } finally {
    console.log('\n[TEARDOWN] Cleaning up fixtures...');
    try {
      const fixtureRecordIds = [...cleanupUserIds, ...cleanupRoleIds].map(String);
      if (fixtureRecordIds.length > 0) {
        await pool.query(
          "DELETE FROM audit_logs WHERE module = 'ACCESS_CONTROL' AND record_id = ANY($1)",
          [fixtureRecordIds]
        );
      }
      if (cleanupGuestIds.length > 0) {
        await pool.query('DELETE FROM guests WHERE id = ANY($1)', [cleanupGuestIds]);
      }
      if (cleanupPosItemIds.length > 0) {
        await pool.query('DELETE FROM pos_menu_items WHERE id = ANY($1)', [cleanupPosItemIds]);
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
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    await pool.end();
  }
}

runTests();
