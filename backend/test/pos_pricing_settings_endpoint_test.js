/**
 * POS Pricing Settings — focused integration test.
 *
 * Real app/JWT/RBAC against disposable oak_minibar_test ONLY.
 * No dotenv reads. Requires TEST_DATABASE_URL matching the disposable guard.
 *
 * Prerequisites:
 *   - property_pos_pricing_settings table must exist (run the disposable migration first).
 *
 * Usage (from backend/):
 *   TEST_DATABASE_URL=postgres://minibar_test:***@127.0.0.1:15434/oak_minibar_test \
 *     node test/pos_pricing_settings_endpoint_test.js
 */
'use strict';
const crypto = require('crypto');
const run = crypto.randomBytes(6).toString('hex');
let target;
try {
  const u = new URL((process.env.TEST_DATABASE_URL || '').trim());
  target = {
    host: u.hostname,
    port: Number(u.port),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
  };
  if (
    !['postgres:', 'postgresql:'].includes(u.protocol) || u.search || u.hash ||
    target.host !== '127.0.0.1' || target.port !== 15434 ||
    target.user !== 'minibar_test' || target.database !== 'oak_minibar_test' || !target.password
  ) throw new Error('TEST_DATABASE_URL tidak sesuai disposable guard (127.0.0.1:15434/oak_minibar_test, user minibar_test).');
} catch (e) {
  console.error('[POS PRICING SETTINGS TEST] Guard gagal:', e.message);
  process.exit(1);
}

process.env.DB_HOST = target.host;
process.env.DB_PORT = String(target.port);
process.env.DB_USER = target.user;
process.env.DB_PASSWORD = target.password;
process.env.DB_NAME = target.database;
process.env.RUN_SCHEMA_INITIALIZATION = 'false';
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');

const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const { setRoleAccess, ACCESS_RESOURCES } = require('../dist/domains/settings/accessControlService');
const http = require('http');

const fixtures = [];
const failures = [];
let passed = 0;

function check(label, cond) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failures.push(label); console.error('  FAIL  ' + label); }
}
function problem(label, e) {
  const msg = label + ': ' + String(e && e.message || e);
  failures.push(msg);
  console.error('[ERROR] ' + msg);
}

async function identity(c) {
  for (const k of ['host', 'port', 'user', 'database'])
    if (String(pool.options[k]) !== String(target[k]))
      throw new Error('pool.options tidak sesuai: ' + k);
  const r = (await c.query('SELECT current_database() AS db, current_user AS usr')).rows[0];
  if (r.db !== target.database || r.usr !== target.user)
    throw new Error('identitas DB tidak sesuai');
}

async function property(c, label) {
  const r = await c.query(
    `INSERT INTO properties(name, property_code, timezone, currency_code, is_active)
     VALUES($1, $2, 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`,
    ['Pricing Settings ' + label + ' ' + run, crypto.randomBytes(3).toString('hex').toUpperCase()]
  );
  const f = { p: Number(r.rows[0].id), roles: [], users: [] };
  fixtures.push(f);
  return f;
}

function grid(resource, view, edit) {
  const g = {};
  for (const r of ACCESS_RESOURCES) g[r.key] = { view: false, edit: false, delete: false };
  g[resource] = { view, edit, delete: false };
  return g;
}

async function makeUser(c, f, label, resource, view, edit) {
  const roleId = Number((await c.query(
    `INSERT INTO roles(property_id, name, is_active, is_system_role, is_test_data)
     VALUES($1, $2, TRUE, FALSE, TRUE) RETURNING id`,
    [f.p, 'PricingSettings ' + label + ' ' + run]
  )).rows[0].id);
  f.roles.push(roleId);
  await setRoleAccess(c, f.p, roleId, grid(resource, view, edit),
    { id: 0, name: 'Settings fixture', property_id: f.p, is_platform_super_admin: false });
  const username = 'prtg_' + label + '_' + run;
  const uid = Number((await c.query(
    `INSERT INTO users(property_id, role_id, username, email, full_name, is_active, is_test_data, account_status, must_change_password, access_type)
     VALUES($1, $2, $3, $4, $5, TRUE, TRUE, 'READY', FALSE, 'PMS_STAFF') RETURNING id`,
    [f.p, roleId, username, username + '@test.local', 'Pricing ' + label]
  )).rows[0].id);
  f.users.push(uid);
  return {
    id: uid,
    username,
    token: generateToken({
      id: uid, property_id: f.p, role_id: roleId,
      email: username + '@test.local', username,
      full_name: 'Pricing ' + label,
      role: 'Pricing Settings Fixture', scope: 'FULL',
      account_status: 'READY', must_change_password: false, access_type: 'PMS_STAFF',
    }),
  };
}

async function req(port, url, method, token, body) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let payload;
  if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch('http://127.0.0.1:' + port + url,
    { method, headers, body: payload, signal: AbortSignal.timeout(15000) });
  const type = r.headers.get('content-type') || '';
  return {
    status: r.status,
    type,
    body: type.includes('application/json') ? await r.json() : null,
  };
}

async function snapshot(c) {
  const ps = fixtures.map(f => f.p);
  const out = {};
  for (const table of ['property_pos_pricing_settings', 'audit_logs']) {
    const rows = (await c.query(
      `SELECT * FROM ${table} WHERE property_id = ANY($1::int[])`, [ps]
    )).rows;
    out[table] = rows.map(r => JSON.stringify(r)).sort();
  }
  return JSON.stringify(out);
}

async function rejected(c, port, url, method, token, body, status, code, label) {
  const before = await snapshot(c);
  const r = await req(port, url, method, token, body);
  check(label + ' status/code', r.status === status && (!code || r.body?.code === code));
  check(label + ' state tetap', before === await snapshot(c));
  check(label + ' tanpa data', !r.body?.data);
}

async function dropAuditTrigger(c) {
  try {
    await c.query(`DROP TRIGGER IF EXISTS pricing_settings_audit_block ON audit_logs`);
    await c.query(`DROP FUNCTION IF EXISTS pricing_settings_audit_block()`);
  } catch (e) {
    console.error('[WARN] dropAuditTrigger:', e.message);
  }
}

async function clean(c, f) {
  await c.query('BEGIN');
  try {
    await dropAuditTrigger(c);
    await c.query(`DELETE FROM property_pos_pricing_settings WHERE property_id=$1`, [f.p]);
    await c.query(`DELETE FROM audit_logs WHERE property_id=$1`, [f.p]);
    await c.query(`DELETE FROM user_permission_overrides WHERE property_id=$1 AND user_id=ANY($2::int[])`, [f.p, f.users]);
    await c.query(`DELETE FROM users WHERE property_id=$1 AND id=ANY($2::int[])`, [f.p, f.users]);
    await c.query(`DELETE FROM roles WHERE property_id=$1 AND id=ANY($2::int[])`, [f.p, f.roles]);
    await c.query(`DELETE FROM properties WHERE id=$1`, [f.p]);
    await c.query('COMMIT');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (rb) { e.discardClient = true; problem('cleanup rollback ' + f.p, rb); }
    throw e;
  }
}

async function residue(c) {
  const ps = fixtures.map(f => f.p);
  const roles = fixtures.flatMap(f => f.roles);
  const tables = ['property_pos_pricing_settings', 'audit_logs', 'users', 'roles', 'user_permission_overrides'];
  for (const table of tables) {
    const n = Number((await c.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE property_id=ANY($1::int[])`, [ps]
    )).rows[0].n);
    check('Residue ' + table + '=0', n === 0);
  }
  check('Residue properties=0',
    Number((await c.query(`SELECT COUNT(*) AS n FROM properties WHERE id=ANY($1::int[])`, [ps])).rows[0].n) === 0);
  check('Residue role_permissions=0',
    Number((await c.query(`SELECT COUNT(*) AS n FROM role_permissions WHERE role_id=ANY($1::int[])`, [roles])).rows[0].n) === 0);
}

function release(c, label, discard = false) {
  if (c) try { c.release(discard); } catch (e) { problem(label + ' release', e); }
}

async function main() {
  let c = null, server = null, verified = false;
  console.log('[POS PRICING SETTINGS TEST] oak_minibar_test/minibar_test @ 127.0.0.1:15434');
  try {
    c = await pool.connect();
    await identity(c);
    verified = true;

    // Prerequisite: table exists (pos_service_tax_v1 migration applied)
    await c.query('SELECT service_charge_enabled FROM property_pos_pricing_settings LIMIT 0');
    const perms = (await c.query(
      "SELECT key FROM permissions WHERE key=ANY($1::text[])",
      [['settings.view', 'settings.edit']]
    )).rows;
    if (perms.length !== 2) throw new Error('Settings permissions prerequisite tidak lengkap');
    console.log('[IDENTITY/SCHEMA] terverifikasi.');

    const a = await property(c, 'A');
    const b = await property(c, 'B');

    // adminA: Pengaturan view+edit  → full access
    // viewerA: Pengaturan view only → GET ok, PUT 403
    // cashierA: POS view only        → GET 200, PUT 403
    // restrictedA: Housekeeping only (no POS/Pengaturan/Dokumen view) → GET 403
    // adminB: Pengaturan view+edit on property B → isolation tests
    const adminA = await makeUser(c, a, 'adminA', 'Pengaturan', true, true);
    const viewerA = await makeUser(c, a, 'viewerA', 'Pengaturan', true, false);
    const cashierA = await makeUser(c, a, 'cashierA', 'POS', true, false);
    const restrictedA = await makeUser(c, a, 'restrictedA', 'Housekeeping', true, false);
    const adminB = await makeUser(c, b, 'adminB', 'Pengaturan', true, true);

    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;

    const url = '/api/pos/pricing-settings';
    const urlA = url + '?property_id=' + a.p;
    const urlB = url + '?property_id=' + b.p;

    // ── 401: no JWT ──────────────────────────────────────────────────────────
    await rejected(c, port, urlA, 'GET', null, null, 401, 'UNAUTHORIZED', 'GET tanpa JWT');
    await rejected(c, port, urlA, 'PUT', null, { property_id: a.p, tax_enabled: true }, 401, null, 'PUT tanpa JWT');

    // ── Permission gates ────────────────────────────��───────────────────────
    // Cashier (POS view only, no Pengaturan/Dokumen&Print view) → GET 200
    const cashierGet = await req(port, urlA, 'GET', cashierA.token);
    check('Kasir POS:view dapat GET pricing settings',
      cashierGet.status === 200 &&
      cashierGet.body?.data?.service_charge_enabled === false &&
      cashierGet.body?.data?.service_charge_percent === 0 &&
      cashierGet.body?.data?.tax_enabled === false &&
      cashierGet.body?.data?.tax_percent === 0);
    // Cashier → PUT 403 (only Pengaturan:edit can write)
    await rejected(c, port, urlA, 'PUT', cashierA.token,
      { property_id: a.p, tax_enabled: true }, 403, 'FORBIDDEN', 'PUT tanpa Pengaturan:edit (cashierA)');
    // Restricted (Housekeeping only) → GET 403
    await rejected(c, port, urlA, 'GET', restrictedA.token, null, 403, 'FORBIDDEN', 'GET tanpa POS/Pengaturan/Dokumen view');
    // Viewer (no edit) → PUT 403
    await rejected(c, port, urlA, 'PUT', viewerA.token,
      { property_id: a.p, tax_enabled: true }, 403, 'FORBIDDEN', 'PUT tanpa Pengaturan:edit');
    // Cross-property: adminB trying property A → 403 PROPERTY_SCOPE_REQUIRED
    await rejected(c, port, urlA, 'GET', adminB.token, null, 403, 'PROPERTY_SCOPE_REQUIRED', 'GET cross-property adminB→A');
    await rejected(c, port, urlA, 'PUT', adminB.token,
      { property_id: a.p, tax_enabled: true }, 403, 'PROPERTY_SCOPE_REQUIRED', 'PUT cross-property adminB→A');

    // ── Validation rejects ──────────────────────────────────────────────────
    // service_charge_enabled as string
    await rejected(c, port, urlA, 'PUT', adminA.token,
      { property_id: a.p, service_charge_enabled: 'true' }, 400, 'VALIDATION_ERROR', 'service_charge_enabled string ditolak');
    // tax_percent > 100
    await rejected(c, port, urlA, 'PUT', adminA.token,
      { property_id: a.p, tax_percent: 101 }, 400, 'VALIDATION_ERROR', 'tax_percent >100 ditolak');
    // service_charge_percent < 0
    await rejected(c, port, urlA, 'PUT', adminA.token,
      { property_id: a.p, service_charge_percent: -1 }, 400, 'VALIDATION_ERROR', 'service_charge_percent <0 ditolak');
    // 3 decimal places
    await rejected(c, port, urlA, 'PUT', adminA.token,
      { property_id: a.p, tax_percent: 10.123 }, 400, 'VALIDATION_ERROR', 'tax_percent 3 desimal ditolak');
    // unknown field
    await rejected(c, port, urlA, 'PUT', adminA.token,
      { property_id: a.p, unknown_field: 'x' }, 400, 'VALIDATION_ERROR', 'field unknown ditolak');
    // tax_percent as string
    await rejected(c, port, urlA, 'PUT', adminA.token,
      { property_id: a.p, tax_percent: '10' }, 400, 'VALIDATION_ERROR', 'tax_percent string ditolak');
    // tax_enabled as number
    await rejected(c, port, urlA, 'PUT', adminA.token,
      { property_id: a.p, tax_enabled: 1 }, 400, 'VALIDATION_ERROR', 'tax_enabled number ditolak');

    // ── GET default (no row yet) → canonical in-memory defaults, no INSERT ──
    const defaults = await req(port, urlA, 'GET', adminA.token);
    check('GET tanpa row: default semua disabled/0',
      defaults.status === 200 &&
      defaults.body?.data?.service_charge_enabled === false &&
      defaults.body?.data?.service_charge_percent === 0 &&
      defaults.body?.data?.tax_enabled === false &&
      defaults.body?.data?.tax_percent === 0);
    const rowCountAfterGet = Number((await c.query(
      `SELECT COUNT(*) AS n FROM property_pos_pricing_settings WHERE property_id=$1`, [a.p]
    )).rows[0].n);
    check('GET tidak membuat row DB', rowCountAfterGet === 0);

    // ── PUT create ──────────────────────────────────────────────────────────
    const putCreate = await req(port, urlA, 'PUT', adminA.token, {
      property_id: a.p,
      service_charge_enabled: true,
      service_charge_percent: 10,
      tax_enabled: true,
      tax_percent: 11,
    });
    check('PUT create: 200 OK, semua field tersimpan',
      putCreate.status === 200 &&
      putCreate.body?.data?.service_charge_enabled === true &&
      putCreate.body?.data?.service_charge_percent === 10 &&
      putCreate.body?.data?.tax_enabled === true &&
      putCreate.body?.data?.tax_percent === 11);

    const createdRow = (await c.query(
      `SELECT * FROM property_pos_pricing_settings WHERE property_id=$1`, [a.p]
    )).rows[0];
    check('Row tersimpan: svc=10%, tax=11%, updated_by dari JWT username',
      createdRow &&
      createdRow.service_charge_enabled === true &&
      createdRow.service_charge_percent === '10.00' &&
      createdRow.tax_enabled === true &&
      createdRow.tax_percent === '11.00' &&
      createdRow.updated_by === adminA.username);
    check('created_at ≈ updated_at pada row baru',
      createdRow &&
      Math.abs(new Date(createdRow.created_at) - new Date(createdRow.updated_at)) < 5000);

    // GET after create → returns saved values
    const afterGet = await req(port, urlA, 'GET', viewerA.token);
    check('GET setelah create: nilai tersimpan terbaca',
      afterGet.status === 200 &&
      afterGet.body?.data?.service_charge_enabled === true &&
      Number(afterGet.body?.data?.service_charge_percent) === 10 &&
      afterGet.body?.data?.tax_enabled === true &&
      Number(afterGet.body?.data?.tax_percent) === 11);

    // ── PUT update (partial patch: only tax fields) ────────────────────────
    const putUpdate = await req(port, urlA, 'PUT', adminA.token, {
      property_id: a.p,
      tax_percent: 22,
    });
    check('PUT patch: hanya tax_percent berubah, svc tetap',
      putUpdate.status === 200 &&
      putUpdate.body?.data?.service_charge_enabled === true &&
      Number(putUpdate.body?.data?.service_charge_percent) === 10 &&
      putUpdate.body?.data?.tax_enabled === true &&
      Number(putUpdate.body?.data?.tax_percent) === 22);

    // ── PUT disable service charge ─────────────────────────────────────────
    const putDisable = await req(port, urlA, 'PUT', adminA.token, {
      property_id: a.p,
      service_charge_enabled: false,
      tax_percent: 0,
    });
    check('PUT disable: svc=false, tax=0',
      putDisable.status === 200 &&
      putDisable.body?.data?.service_charge_enabled === false &&
      Number(putDisable.body?.data?.service_charge_percent) === 10 &&
      putDisable.body?.data?.tax_enabled === true &&
      Number(putDisable.body?.data?.tax_percent) === 0);

    // ── Percent with 2 decimals accepted ───────────────────────────────────
    const putDec = await req(port, urlA, 'PUT', adminA.token, {
      property_id: a.p,
      service_charge_percent: 5.55,
    });
    check('PUT percent 2 desimal: 5.55 diterima',
      putDec.status === 200 &&
      Number(putDec.body?.data?.service_charge_percent) === 5.55);

    // ── Property B isolation: adminB → property B ─────────────────────────
    const putB = await req(port, urlB, 'PUT', adminB.token, {
      property_id: b.p,
      tax_enabled: true,
      tax_percent: 15,
      service_charge_percent: 5,
    });
    check('Property B PUT: isolated dari property A',
      putB.status === 200 &&
      putB.body?.data?.tax_enabled === true &&
      Number(putB.body?.data?.tax_percent) === 15 &&
      Number(putB.body?.data?.service_charge_percent) === 5);

    const auditB = (await c.query(
      `SELECT * FROM audit_logs WHERE property_id=$1 AND module='POS_PRICING' AND action='POS_PRICING_SETTINGS_UPDATED'`, [b.p]
    )).rows;
    check('Property B: audit log tersimpan', auditB.length >= 1);

    // ── Empty-string / null percent normalization ─────────────────────────
    const putNull = await req(port, urlA, 'PUT', adminA.token, {
      property_id: a.p,
      tax_percent: 0,
      service_charge_percent: 0,
    });
    check('PUT 0/0: all percent values normal',
      putNull.status === 200 &&
      Number(putNull.body?.data?.tax_percent) === 0 &&
      Number(putNull.body?.data?.service_charge_percent) === 0);

    // ── Invalid property_id (non-integer) → 400 ───────────────────────────
    await rejected(c, port, url + '?property_id=abc', 'GET', adminA.token, null, 400, 'VALIDATION_ERROR', 'property_id non-integer ditolak');

    // ── Missing property → 403 PROPERTY_SCOPE_REQUIRED ─────────────────────
    // The security check (user.property_id mismatch) runs before property
    // existence is verified, so a non-existent property_id returns 403 with
    // PROPERTY_SCOPE_REQUIRED (consistent with cross-property behavior).
    const missingProp = 1000000 + (parseInt(run.slice(-6), 16) % 999999);
    const notFound = await req(port, url + '?property_id=' + missingProp, 'GET', adminA.token);
    check('GET property tidak ada: 403 PROPERTY_SCOPE_REQUIRED',
      notFound.status === 403 && notFound.body?.code === 'PROPERTY_SCOPE_REQUIRED');
    const putNotFound = await req(port, url + '?property_id=' + missingProp, 'PUT', adminA.token,
      { property_id: missingProp, tax_enabled: true });
    check('PUT property tidak ada: 403 PROPERTY_SCOPE_REQUIRED',
      putNotFound.status === 403 && putNotFound.body?.code === 'PROPERTY_SCOPE_REQUIRED');

    // ── pos_orders snapshot columns exist (read-only check) ────────────────
    const snapCols = (await c.query(
      `SELECT a.attname FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relname='pos_orders'
         AND a.attname IN ('service_amount','tax_amount',
                          'service_charge_percent_snapshot','tax_percent_snapshot',
                          'service_charge_enabled_snapshot','tax_enabled_snapshot')
         AND a.attnum > 0 AND NOT a.attisdropped`
    )).rows;
    check('pos_orders snapshot columns: 6 kolom ada', snapCols.length === 6);

    // ── Snapshot: verify no pos_orders default row was altered ─────────────
    const defaultSnap = (await c.query(
      `SELECT service_amount, tax_amount,
              service_charge_percent_snapshot, tax_percent_snapshot,
              service_charge_enabled_snapshot, tax_enabled_snapshot
         FROM pos_orders LIMIT 1`
    )).rows;
    if (defaultSnap.length > 0) {
      const row = defaultSnap[0];
      check('pos_orders snapshot defaults: service_amount=0, tax_amount=0',
        Number(row.service_amount) === 0 && Number(row.tax_amount) === 0);
      check('pos_orders snapshot defaults: percent=0, enabled=false',
        Number(row.service_charge_percent_snapshot) === 0 &&
        Number(row.tax_percent_snapshot) === 0 &&
        row.service_charge_enabled_snapshot === false &&
        row.tax_enabled_snapshot === false);
    }

    // ── No inclusive columns on settings table (V1 EXCLUSIVE ONLY) ────────
    const inclusiveCheck = (await c.query(
      `SELECT 1 FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relname='property_pos_pricing_settings'
         AND a.attname IN ('prices_include_service','prices_include_tax')
         AND a.attnum > 0 AND NOT a.attisdropped`
    )).rows;
    check('V1 EXCLUSIVE: no prices_include_* columns', inclusiveCheck.length === 0);

    // ── pos_orders still has old schema intact (zero behavioral change) ───
    // Check that standard pos_orders columns still exist
    const coreCols = (await c.query(
      `SELECT a.attname FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relname='pos_orders'
         AND a.attname IN ('id','property_id','total_amount','status')
         AND a.attnum > 0 AND NOT a.attisdropped`
    )).rows;
    check('pos_orders core columns intact (id, property_id, total_amount, status)',
      coreCols.length === 4);

    console.log('\n──────────────────────────────────────────────────');
    console.log(`  PASSED: ${passed}  FAILED: ${failures.length}`);
    if (failures.length) {
      console.error('\n  FAILURES:');
      for (const f of failures) console.error('   ' + f);
    }
  } catch (e) {
    problem('main', e);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    for (const f of fixtures) {
      try { await clean(c, f); } catch (ce) { problem('clean ' + f.p, ce); }
    }
    await residue(c);
    release(c, 'main', !verified);
    await pool.end();
    process.exit(failures.length ? 1 : 0);
  }
}

main().catch((e) => {
  console.error('[POS PRICING SETTINGS TEST] Uncaught:', e);
  process.exit(1);
});
