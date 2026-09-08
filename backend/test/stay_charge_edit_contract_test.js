'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const http = require('http');
const { pool, app } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { generateToken } = require('../dist/domains/auth/authService');
const {
  ACCESS_RESOURCES,
  setRoleAccess
} = require('../dist/domains/settings/accessControlService');
const {
  matchOperationalAccessRule
} = require('../dist/domains/settings/operationalAccessGuard');

const TEST_PORT = 3227;

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
      headers: { 'Content-Type': 'application/json' }
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    if (token) options.headers.Authorization = `Bearer ${token}`;

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const contentType = String(res.headers['content-type'] || '');
        let parsed = data;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, contentType, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function gridFor(masterKamar, transaksi = { view: false, edit: false, delete: false }) {
  const grid = {};
  for (const resource of ACCESS_RESOURCES) {
    grid[resource.key] = { view: false, edit: false, delete: false };
  }
  grid['Master Kamar'] = masterKamar;
  grid['Transaksi'] = transaksi;
  return grid;
}

async function runTests() {
  console.log('=== STAY-CHARGE-EDIT-1 HTTP CONTRACT + AUTH TEST ===\n');

  const runId = `${Date.now()}_${process.pid}`;
  let server;
  const cleanupUserIds = [];
  const cleanupRoleIds = [];
  const cleanupPropertyIds = [];
  const cleanupRuleIds = [];

  try {
    await initializeDatabase(pool);
    await new Promise(resolve => {
      server = app.listen(TEST_PORT, () => resolve());
    });

    const saRes = await pool.query(`
      SELECT u.id, u.username, u.full_name, u.email, r.id AS role_id, r.name AS role
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'Super Admin' AND r.property_id IS NULL AND r.is_system_role = TRUE
      LIMIT 1
    `);
    if (!saRes.rows[0]) throw new Error('Platform Super Admin not found');
    const sa = saRes.rows[0];

    const propA = await pool.query(
      `INSERT INTO properties (name, address, phone, property_code, timezone, currency)
       VALUES ($1, 'A', '0800', $2, 'Asia/Jakarta', 'IDR') RETURNING id`,
      [`SCE1 Prop A ${runId}`, `A${Math.floor(10000 + Math.random() * 90000)}`]
    );
    const propB = await pool.query(
      `INSERT INTO properties (name, address, phone, property_code, timezone, currency)
       VALUES ($1, 'B', '0801', $2, 'Asia/Jakarta', 'IDR') RETURNING id`,
      [`SCE1 Prop B ${runId}`, `B${Math.floor(10000 + Math.random() * 90000)}`]
    );
    const propIdA = propA.rows[0].id;
    const propIdB = propB.rows[0].id;
    cleanupPropertyIds.push(propIdA, propIdB);

    async function insertExtraBed(propertyId, amount = 150000) {
      const res = await pool.query(
        `INSERT INTO stay_charge_rules (
           property_id, charge_type, code, name, description, charge_method,
           default_amount, percentage_rate, taxable, service_chargeable,
           is_active, is_archived, sort_order, created_by
         ) VALUES (
           $1, 'EXTRA_BED', 'EXTRA_BED_STD', 'Extra Bed Standard',
           'Kasur tambahan dewasa', 'FIXED_AMOUNT', $2, 0, TRUE, TRUE,
           TRUE, FALSE, 1, 'SCE1_TEST'
         ) RETURNING id`,
        [propertyId, amount]
      );
      cleanupRuleIds.push(res.rows[0].id);
      return res.rows[0].id;
    }

    const extraBedA = await insertExtraBed(propIdA, 150000);
    const extraBedB = await insertExtraBed(propIdB, 150000);

    const actor = {
      id: sa.id,
      name: sa.full_name || sa.username,
      property_id: propIdA,
      is_platform_super_admin: true
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

    async function createRole(label, propertyId) {
      const res = await pool.query(
        `INSERT INTO roles (property_id, name, description, is_active, is_system_role, is_test_data)
         VALUES ($1, $2, $3, TRUE, FALSE, TRUE) RETURNING id`,
        [propertyId, `SCE1_${label}_${runId}`, `stay-charge-edit fixture ${label}`]
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
          `sce1_${label}_${runId}`,
          `sce1_${label}_${runId}@test.local`,
          `SCE1 ${label}`
        ]
      );
      cleanupUserIds.push(res.rows[0].id);
      return res.rows[0];
    }

    const viewRoleA = await createRole('VIEW', propIdA);
    const editRoleA = await createRole('EDIT', propIdA);
    const deleteRoleA = await createRole('DEL', propIdA);
    const editRoleB = await createRole('EDITB', propIdB);

    await withTx(client => setRoleAccess(client, propIdA, viewRoleA, gridFor({ view: true, edit: false, delete: false }), actor));
    await withTx(client => setRoleAccess(client, propIdA, editRoleA, gridFor({ view: true, edit: true, delete: false }), actor));
    await withTx(client => setRoleAccess(client, propIdA, deleteRoleA, gridFor({ view: true, edit: true, delete: true }), actor));
    await withTx(client => setRoleAccess(client, propIdB, editRoleB, gridFor({ view: true, edit: true, delete: true }), { ...actor, property_id: propIdB }));

    const viewUserA = await createUser('view', propIdA, viewRoleA);
    const editUserA = await createUser('edit', propIdA, editRoleA);
    const deleteUserA = await createUser('del', propIdA, deleteRoleA);
    const editUserB = await createUser('editb', propIdB, editRoleB);

    const tokenFor = (user, roleId, roleName, propertyId) => generateToken({
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      email: `${user.username}@test.local`,
      role_id: roleId,
      role: roleName,
      property_id: propertyId,
      access_type: 'PMS_STAFF',
      scope: 'FULL'
    });

    const viewTokenA = tokenFor(viewUserA, viewRoleA, `SCE1_VIEW_${runId}`, propIdA);
    const editTokenA = tokenFor(editUserA, editRoleA, `SCE1_EDIT_${runId}`, propIdA);
    const deleteTokenA = tokenFor(deleteUserA, deleteRoleA, `SCE1_DEL_${runId}`, propIdA);
    const editTokenB = tokenFor(editUserB, editRoleB, `SCE1_EDITB_${runId}`, propIdB);
    const saTokenA = generateToken({
      id: sa.id,
      username: sa.username,
      full_name: sa.full_name,
      email: sa.email || 'sa@test.local',
      role_id: sa.role_id,
      role: sa.role,
      property_id: propIdA,
      access_type: 'PMS_STAFF',
      scope: 'FULL'
    });

    console.log('--- Route mapping ---');
    const mapping = [
      ['GET', '/api/stay-charges/rules', 'Master Kamar', 'view'],
      ['PATCH', '/api/stay-charges/rules/1', 'Master Kamar', 'edit'],
      ['DELETE', '/api/stay-charges/rules/1', 'Master Kamar', 'delete'],
      ['POST', '/api/stay-charges/post-charge', 'Transaksi', 'edit']
    ];
    for (const [method, urlPath, resource, action] of mapping) {
      const matched = matchOperationalAccessRule(urlPath, method);
      if (!matched || !matched.resources.includes(resource) || matched.action !== action) {
        fail(`Mapping ${method} ${urlPath} should be ${resource}/${action}, got ${JSON.stringify(matched)}`);
      }
    }
    pass('stay-charge routes are not shadowed and map to the intended resources');

    console.log('--- Auth: no token ---');
    const noToken = await makeRequest('PATCH', `/api/stay-charges/rules/${extraBedA}`, {
      property_id: propIdA,
      default_amount: 160000
    });
    if (noToken.status !== 401) fail(`no token expected 401, got ${noToken.status} ${JSON.stringify(noToken.body)}`);
    if (String(noToken.raw || '').includes('<!DOCTYPE')) fail('401 must be JSON, not HTML');
    pass('N. no token => 401 JSON');

    console.log('--- GET view permission ---');
    const viewOk = await makeRequest('GET', `/api/stay-charges/rules?property_id=${propIdA}`, null, viewTokenA);
    if (viewOk.status !== 200) fail(`view GET expected 200, got ${viewOk.status} ${JSON.stringify(viewOk.body)}`);
    pass('S. GET with Master Kamar view succeeds');

    const viewPatch = await makeRequest('PATCH', `/api/stay-charges/rules/${extraBedA}`, {
      property_id: propIdA,
      default_amount: 160000
    }, viewTokenA);
    if (viewPatch.status !== 403) fail(`view PATCH expected 403, got ${viewPatch.status}`);
    pass('PATCH without edit permission is 403');

    console.log('--- PATCH extra bed amount ---');
    const patchAmount = await makeRequest('PATCH', `/api/stay-charges/rules/${extraBedA}`, {
      property_id: propIdA,
      default_amount: 175000
    }, editTokenA);
    if (patchAmount.status !== 200) fail(`PATCH amount expected 200, got ${patchAmount.status} ${JSON.stringify(patchAmount.body)}`);
    if (Number(patchAmount.body.default_amount) !== 175000) fail(`PATCH did not persist default_amount, got ${patchAmount.body.default_amount}`);
    pass('A/D. PATCH Extra Bed default_amount persists');

    const getAfter = await makeRequest('GET', `/api/stay-charges/rules/${extraBedA}?property_id=${propIdA}`, null, editTokenA);
    if (getAfter.status !== 200) fail(`GET after update expected 200, got ${getAfter.status}`);
    if (Number(getAfter.body.default_amount) !== 175000) fail(`GET after update expected 175000, got ${getAfter.body.default_amount}`);
    pass('E. GET after update returns new amount');

    console.log('--- Toggle active ---');
    const deactivate = await makeRequest('PATCH', `/api/stay-charges/rules/${extraBedA}`, {
      property_id: propIdA,
      is_active: false
    }, editTokenA);
    if (deactivate.status !== 200 || deactivate.body.is_active !== false) {
      fail(`deactivate failed: ${deactivate.status} ${JSON.stringify(deactivate.body)}`);
    }
    const activate = await makeRequest('PATCH', `/api/stay-charges/rules/${extraBedA}`, {
      property_id: propIdA,
      is_active: true
    }, editTokenA);
    if (activate.status !== 200 || activate.body.is_active !== true) {
      fail(`activate failed: ${activate.status} ${JSON.stringify(activate.body)}`);
    }
    pass('F. toggle active works via PATCH');

    console.log('--- Field mapping persist ---');
    const fieldPatch = await makeRequest('PATCH', `/api/stay-charges/rules/${extraBedA}`, {
      property_id: propIdA,
      name: 'Extra Bed Deluxe',
      charge_type: 'EXTRA_PERSON',
      calculation_type: 'PERCENT_ROOM_RATE',
      percentage_of_rate: 25,
      is_taxable: false,
      is_service_chargeable: false,
      display_order: 9
    }, editTokenA);
    if (fieldPatch.status !== 200) fail(`field PATCH expected 200, got ${fieldPatch.status} ${JSON.stringify(fieldPatch.body)}`);
    if (fieldPatch.body.name !== 'Extra Bed Deluxe') fail('L. name did not persist');
    if (fieldPatch.body.charge_type !== 'EXTRA_PERSON') fail('M. charge_type did not persist');
    if (fieldPatch.body.charge_method !== 'PERCENTAGE_OF_NIGHTLY_RATE') fail('G. charge_method did not persist');
    if (Number(fieldPatch.body.percentage_rate) !== 25) fail('H. percentage_rate did not persist');
    if (fieldPatch.body.taxable !== false) fail('I. taxable did not persist');
    if (fieldPatch.body.service_chargeable !== false) fail('J. service_chargeable did not persist');
    if (Number(fieldPatch.body.sort_order) !== 9) fail('K. sort_order did not persist');
    pass('G-M. mapped fields persist on PATCH');

    const restore = await makeRequest('PATCH', `/api/stay-charges/rules/${extraBedA}`, {
      property_id: propIdA,
      name: 'Extra Bed Standard',
      charge_type: 'EXTRA_BED',
      charge_method: 'FIXED_AMOUNT',
      default_amount: 175000,
      percentage_rate: 0,
      taxable: true,
      service_chargeable: true,
      sort_order: 1
    }, editTokenA);
    if (restore.status !== 200) fail(`restore extra bed failed ${restore.status}`);

    console.log('--- Property scope ---');
    const crossProp = await makeRequest('PATCH', `/api/stay-charges/rules/${extraBedA}`, {
      property_id: propIdB,
      default_amount: 180000
    }, editTokenA);
    if (crossProp.status !== 403) fail(`ordinary cross-property expected 403, got ${crossProp.status} ${JSON.stringify(crossProp.body)}`);
    pass('O. ordinary cross-property update => 403');

    const wrongRule = await makeRequest('PATCH', `/api/stay-charges/rules/${extraBedB}`, {
      property_id: propIdA,
      default_amount: 180000
    }, editTokenA);
    if (wrongRule.status !== 403) fail(`other-property rule id expected 403, got ${wrongRule.status} ${JSON.stringify(wrongRule.body)}`);
    pass('cross-property rule id is 403, not silent not found');

    const sameProp = await makeRequest('PATCH', `/api/stay-charges/rules/${extraBedA}`, {
      property_id: propIdA,
      default_amount: 176000
    }, editTokenA);
    if (sameProp.status !== 200 || Number(sameProp.body.default_amount) !== 176000) {
      fail(`P. same-property edit failed ${sameProp.status} ${JSON.stringify(sameProp.body)}`);
    }
    pass('P. same-property edit succeeds');

    const saCross = await makeRequest('PATCH', `/api/stay-charges/rules/${extraBedB}`, {
      property_id: propIdB,
      default_amount: 188000
    }, saTokenA);
    if (saCross.status !== 200 || Number(saCross.body.default_amount) !== 188000) {
      fail(`Q. Super Admin cross-property failed ${saCross.status} ${JSON.stringify(saCross.body)}`);
    }
    const saLeak = await makeRequest('GET', `/api/stay-charges/rules/${extraBedB}?property_id=${propIdA}`, null, saTokenA);
    if (saLeak.status !== 403) fail(`Super Admin still cannot mix property_id with another property rule, got ${saLeak.status}`);
    pass('Q. Super Admin can edit another property with matching property_id; mixed ids stay 403');

    console.log('--- Delete permission ---');
    const deleteDenied = await makeRequest(
      'DELETE',
      `/api/stay-charges/rules/${extraBedA}?property_id=${propIdA}`,
      null,
      editTokenA
    );
    if (deleteDenied.status !== 403) fail(`delete without permission expected 403, got ${deleteDenied.status}`);
    pass('R. delete requires Master Kamar delete');

    const deleteOk = await makeRequest(
      'DELETE',
      `/api/stay-charges/rules/${extraBedA}?property_id=${propIdA}`,
      null,
      deleteTokenA
    );
    if (deleteOk.status !== 200) fail(`delete with permission expected 200, got ${deleteOk.status} ${JSON.stringify(deleteOk.body)}`);
    pass('R. delete with Master Kamar delete succeeds');

    const otherEditor = await makeRequest('GET', `/api/stay-charges/rules?property_id=${propIdA}`, null, editTokenB);
    if (otherEditor.status !== 403) fail(`property B editor reading A expected 403, got ${otherEditor.status}`);
    pass('ordinary user cannot read another property rules list');

    const historical = await pool.query(
      `SELECT default_amount FROM stay_charge_rules WHERE id = $1`,
      [extraBedB]
    );
    if (Number(historical.rows[0].default_amount) !== 188000) fail('property B amount should remain Super Admin update');
    pass('master price updates do not rewrite other property rows');

    console.log(`\n=== PASSED: ${passed} assertions ===`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      if (cleanupRuleIds.length) {
        await pool.query('DELETE FROM stay_charge_rules WHERE id = ANY($1::int[])', [cleanupRuleIds]);
      }
      if (cleanupUserIds.length) {
        await pool.query('DELETE FROM user_permission_overrides WHERE user_id = ANY($1::int[])', [cleanupUserIds]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanupUserIds]);
      }
      if (cleanupRoleIds.length) {
        await pool.query('DELETE FROM role_permissions WHERE role_id = ANY($1::int[])', [cleanupRoleIds]).catch(() => {});
        await pool.query('DELETE FROM roles WHERE id = ANY($1::int[])', [cleanupRoleIds]);
      }
      if (cleanupPropertyIds.length) {
        await pool.query('DELETE FROM audit_logs WHERE property_id = ANY($1::int[])', [cleanupPropertyIds]).catch(() => {});
        await pool.query('DELETE FROM stay_charge_rules WHERE property_id = ANY($1::int[])', [cleanupPropertyIds]);
        await pool.query('DELETE FROM properties WHERE id = ANY($1::int[])', [cleanupPropertyIds]);
      }
    } catch (err) {
      console.error('cleanup warning:', err.message);
    }
    await pool.end();
  }
}

runTests().catch(err => {
  console.error('\n[FAIL]', err);
  process.exit(1);
});
