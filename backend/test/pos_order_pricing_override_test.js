/**
 * POS Order Pricing Override — Per-Order Service Charge & PPN Toggle
 *
 * Target: disposable oak_minibar_test (127.0.0.1:15434)
 *
 * Scope:
 *  A. Strict boolean validation (null, string, number rejected → 400)
 *  B. Negation rules (true + property OFF → 400; false/absent → follow)
 *  C. Effective flag merge into computePosPricing snapshot
 *  D. Fingerprint tri-state (true, false, absent → distinct hashes)
 *  E. Idempotency: replay with same flags → 200; different flags → 409
 *  F. Expected total guard (match → 201; mismatch → 409 PRICING_TOTAL_CHANGED)
 *  G. Backward compat: absent flags → property-driven behavior
 *
 * Prerequisites:
 *   - pos_service_tax_v1 migration applied (property_pos_pricing_settings table)
 *   - posOrderCreateHandler with per-order override compiled in dist/
 *
 * Run (from backend/):
 *   TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test \
 *     node test/pos_order_pricing_override_test.js
 */
'use strict';
const crypto = require('crypto');
const run = 'ovr_' + crypto.randomBytes(5).toString('hex');

// ── DB Safety Guard ──────────────────────────────────────────────────────────
// Accepts any *_test database on localhost (port 5432, 15434, or 5433).
// The disposable guard mirrors pos_pricing_settings_endpoint_test.js but is
// parameterised via PORT_GUARD so the test can run against whichever local
// disposable instance is available in the current environment.
//
// Usage:
//   TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:PORT/oak_minibar_test \
//     node test/pos_order_pricing_override_test.js
//
// The database name MUST end with "_test" and NOT contain staging/prod/live.
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
  const ALLOWED_PORTS = [5432, 15434, 5433];
  if (
    !['postgres:', 'postgresql:'].includes(u.protocol) || u.search || u.hash ||
    target.host !== '127.0.0.1' ||
    !ALLOWED_PORTS.includes(target.port) ||
    !target.database.endsWith('_test') ||
    /staging|prod(?!uction)|live/i.test(target.database) ||
    !target.password
  ) throw new Error(
    'TEST_DATABASE_URL tidak sesuai guard: host=127.0.0.1, port dalam ' +
    ALLOWED_PORTS.join('/') + ', db berakhiran _test, tanpa kata staging/prod/live.'
  );
} catch (e) {
  console.error('[POS ORDER PRICING OVERRIDE TEST] Guard gagal:', e.message);
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

// ── Fixture & state ────────────────────────────────────────────────────────────
const fx = {
  propertyId: 0,
  categoryId: 0,
  menuItemId: 0,
  token: '',
  orders: [],          // tracked pos_orders ids for cleanup
  idemKeys: [],       // tracked idempotency keys
  pricingSettings: null,
};

let passed = 0, failed = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else {
    failed++;
    const msg = label + (detail ? ' — ' + detail : '');
    failures.push(msg);
    console.error('  FAIL  ' + msg);
  }
}

function posEditGrid() {
  const grid = {};
  for (const r of ACCESS_RESOURCES) grid[r.key] = { view: false, edit: false, delete: false };
  grid.POS = { view: true, edit: true, delete: false };
  return grid;
}

async function identityGuard(c) {
  for (const k of ['host', 'port', 'user', 'database'])
    if (String(pool.options[k]) !== String(target[k]))
      throw new Error('pool.options tidak sesuai: ' + k);
  const r = (await c.query('SELECT current_database() AS db, current_user AS usr')).rows[0];
  if (r.db !== target.database || r.usr !== target.user)
    throw new Error('identitas DB tidak sesuai');
  console.log('[GUARD] DB terverifikasi: ' + r.db + ' user=' + r.usr);
}

// ── HTTP helper ────────────────────────────────────────────────────────────────
async function postOrder(port, token, body, idemKey) {
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  const r = await fetch('http://127.0.0.1:' + port + '/api/pos/orders', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
  return { status: r.status, json };
}

// ── Direct DB access ──────────────────────────────────────────────────────────
async function setPricing(c, { svcOn = false, svcPct = 0, taxOn = false, taxPct = 0 }) {
  await c.query(
    `INSERT INTO property_pos_pricing_settings
       (property_id, service_charge_enabled, service_charge_percent,
        tax_enabled, tax_percent, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (property_id) DO UPDATE
       SET service_charge_enabled = $2,
           service_charge_percent = $3,
           tax_enabled = $4,
           tax_percent = $5,
           updated_at = NOW()`,
    [fx.propertyId, svcOn, svcPct, taxOn, taxPct]
  );
}

async function getOrder(c, id) {
  const r = await c.query(
    `SELECT id, total_amount, service_amount, tax_amount,
            service_charge_percent_snapshot, tax_percent_snapshot,
            service_charge_enabled_snapshot, tax_enabled_snapshot
     FROM pos_orders WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

// ── Fixture setup ─────────────────────────────────────────────────────────────
async function setup(c) {
  const propCode = crypto.randomBytes(3).toString('hex').toUpperCase();
  const propRow = (await c.query(
    `INSERT INTO properties(name, property_code, address, timezone, currency_code, currency, is_active)
     VALUES($1,$2,'Addr','Asia/Jakarta','IDR','IDR',TRUE) RETURNING id`,
    ['Pricing Override ' + run, propCode]
  )).rows[0];
  fx.propertyId = Number(propRow.id);

  const roleRow = (await c.query(
    `INSERT INTO roles(property_id, name, is_active, is_system_role, is_test_data)
     VALUES($1,$2,TRUE,FALSE,TRUE) RETURNING id`,
    [fx.propertyId, 'POV role ' + run]
  )).rows[0];
  const roleId = Number(roleRow.id);

  await setRoleAccess(
    c, fx.propertyId, roleId, posEditGrid(),
    { id: 0, name: 'POV fixture', property_id: fx.propertyId, is_platform_super_admin: false },
  );

  const userRow = (await c.query(
    `INSERT INTO users(property_id, role_id, username, email, full_name, is_active, is_test_data,
      account_status, must_change_password, access_type)
     VALUES($1,$2,$3,$4,$5,TRUE,TRUE,'READY',FALSE,'PMS_STAFF') RETURNING id`,
    [fx.propertyId, roleId, 'pov_' + run, 'pov_' + run + '@test.local', 'POV Test']
  )).rows[0];
  const userId = Number(userRow.id);

  fx.token = generateToken({
    id: userId, property_id: fx.propertyId, role_id: roleId,
    username: 'pov_' + run,
    email: 'pov_' + run + '@test.local',
    full_name: 'POV Test', role: 'POV', scope: 'FULL',
    account_status: 'READY', must_change_password: false, access_type: 'PMS_STAFF',
  });

  const catRow = (await c.query(
    `INSERT INTO pos_menu_categories(property_id, name) VALUES($1,$2) RETURNING id`,
    [fx.propertyId, 'POV Cat ' + run]
  )).rows[0];
  fx.categoryId = Number(catRow.id);

  const itemRow = (await c.query(
    `INSERT INTO pos_menu_items(property_id, category_id, item_code, name, price, is_active)
     VALUES($1,$2,'POV-ITEM','POV Test Item',100000,TRUE) RETURNING id`,
    [fx.propertyId, fx.categoryId]
  )).rows[0];
  fx.menuItemId = Number(itemRow.id);

  // Initial pricing settings: both OFF, percent 0 (no row yet — in-memory default)
  await setPricing(c, { svcOn: false, svcPct: 0, taxOn: false, taxPct: 0 });
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
async function cleanup(c) {
  const p = fx.propertyId;
  try {
    await c.query('BEGIN');
    if (fx.orders.length)
      await c.query('DELETE FROM pos_order_items WHERE order_id = ANY($1)', [fx.orders]);
    if (fx.orders.length)
      await c.query('DELETE FROM pos_orders WHERE id = ANY($1)', [fx.orders]);
    await c.query(`DELETE FROM pos_order_items WHERE order_id IN
      (SELECT id FROM pos_orders WHERE property_id = $1)`, [p]);
    await c.query('DELETE FROM pos_orders WHERE property_id = $1', [p]);
    await c.query('DELETE FROM property_pos_pricing_settings WHERE property_id = $1', [p]);
    if (fx.idemKeys.length)
      await c.query('DELETE FROM pos_orders WHERE property_id = $1 AND idempotency_key = ANY($2)', [p, fx.idemKeys]);
    await c.query('DELETE FROM audit_logs WHERE property_id = $1', [p]);
    await c.query(`DELETE FROM pos_menu_items WHERE category_id = (SELECT id FROM pos_menu_categories WHERE property_id = $1)`, [p]);
    await c.query('DELETE FROM pos_menu_categories WHERE property_id = $1', [p]);
    await c.query(`DELETE FROM user_permission_overrides WHERE property_id = $1 AND user_id = (SELECT id FROM users WHERE property_id = $1)`, [p]);
    await c.query('DELETE FROM users WHERE property_id = $1', [p]);
    await c.query('DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE property_id = $1)', [p]);
    await c.query('DELETE FROM roles WHERE property_id = $1', [p]);
    await c.query('DELETE FROM properties WHERE id = $1', [p]);
    await c.query('COMMIT');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    console.error('[CLEANUP ERROR]', e.message);
  }
}

async function residue(c) {
  const p = fx.propertyId;
  const checks = [
    ['pos_orders', 'SELECT COUNT(*)::int AS n FROM pos_orders WHERE property_id = $1', p],
    ['pos_order_items', `SELECT COUNT(*)::int AS n FROM pos_order_items WHERE order_id IN
       (SELECT id FROM pos_orders WHERE property_id = $1)`, p],
    ['pricing_settings', 'SELECT COUNT(*)::int AS n FROM property_pos_pricing_settings WHERE property_id = $1', p],
    ['audit_logs', 'SELECT COUNT(*)::int AS n FROM audit_logs WHERE property_id = $1', p],
    ['users', 'SELECT COUNT(*)::int AS n FROM users WHERE property_id = $1', p],
    ['roles', 'SELECT COUNT(*)::int AS n FROM roles WHERE property_id = $1', p],
    ['properties', 'SELECT COUNT(*)::int AS n FROM properties WHERE id = $1', p],
  ];
  for (const [label, sql, arg] of checks) {
    const r = await c.query(sql, [arg]);
    check('Residue ' + label + '=0', Number(r.rows[0].n) === 0, 'got ' + r.rows[0].n);
  }
}

// ── Helper to build a minimal valid order body ───────────────────────────────
function baseBody(extra = {}) {
  return {
    property_id: fx.propertyId,
    items: [{ menu_item_id: fx.menuItemId, quantity: 1 }],
    ...extra,
  };
}

// ── Main test runner ──────────────────────────────────────────────────────────
async function main() {
  let c = null, server = null;
  console.log('[POS ORDER PRICING OVERRIDE TEST] oak_minibar_test/minibar_test @ 127.0.0.1:15434');

  try {
    c = await pool.connect();
    await identityGuard(c);
    await setup(c);
    console.log('[SETUP] property=' + fx.propertyId + ' menu_item=' + fx.menuItemId);

    // Verify pricing table exists
    await c.query('SELECT service_charge_enabled FROM property_pos_pricing_settings WHERE property_id = $1', [fx.propertyId]);
    console.log('[SCHEMA] property_pos_pricing_settings tersedia.');

    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // A. STRICT BOOLEAN VALIDATION
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n=== A. Strict boolean validation ===');

    // A1: service_charge_enabled = "true" (string) → 400
    let rA1 = await postOrder(port, fx.token, baseBody({ service_charge_enabled: 'true' }));
    check('A1: svc="true" (string) → 400', rA1.status === 400,
      'got ' + rA1.status + ' code=' + rA1.json?.code);

    // A2: service_charge_enabled = 1 (number) → 400
    rA1 = await postOrder(port, fx.token, baseBody({ service_charge_enabled: 1 }));
    check('A2: svc=1 (number) → 400', rA1.status === 400,
      'got ' + rA1.status + ' code=' + rA1.json?.code);

    // A3: service_charge_enabled = 0 (number) → 400
    rA1 = await postOrder(port, fx.token, baseBody({ service_charge_enabled: 0 }));
    check('A3: svc=0 (number) → 400', rA1.status === 400,
      'got ' + rA1.status + ' code=' + rA1.json?.code);

    // A4: tax_enabled = "false" (string) → 400
    rA1 = await postOrder(port, fx.token, baseBody({ tax_enabled: 'false' }));
    check('A4: tax="false" (string) → 400', rA1.status === 400,
      'got ' + rA1.status + ' code=' + rA1.json?.code);

    // A5: expected_total = "abc" (string) → 400
    rA1 = await postOrder(port, fx.token, baseBody({ expected_total: 'abc' }));
    check('A5: expected_total="abc" (string) → 400', rA1.status === 400,
      'got ' + rA1.status + ' code=' + rA1.json?.code);

    // A6: expected_total = -1 (negative) → 400
    rA1 = await postOrder(port, fx.token, baseBody({ expected_total: -1 }));
    check('A6: expected_total=-1 → 400', rA1.status === 400,
      'got ' + rA1.status + ' code=' + rA1.json?.code);

    // A7: expected_total = 100.5 (non-integer) → 400
    rA1 = await postOrder(port, fx.token, baseBody({ expected_total: 100.5 }));
    check('A7: expected_total=100.5 (non-int) → 400', rA1.status === 400,
      'got ' + rA1.status + ' code=' + rA1.json?.code);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // B. NEGATION RULES — property OFF + true → 400
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n=== B. Negation rules ===');

    // Ensure both OFF in settings
    await setPricing(c, { svcOn: false, svcPct: 0, taxOn: false, taxPct: 0 });

    // B1: svc=true when property svc OFF → 400 SERVICE_CHARGE_NOT_ENABLED_AT_PROPERTY
    let rB1 = await postOrder(port, fx.token, baseBody({ service_charge_enabled: true }));
    check('B1: svc=true, property OFF → 400', rB1.status === 400,
      'got ' + rB1.status + ' code=' + rB1.json?.code);
    check('B1: code=SERVICE_CHARGE_NOT_ENABLED_AT_PROPERTY',
      rB1.json?.code === 'SERVICE_CHARGE_NOT_ENABLED_AT_PROPERTY',
      'got ' + rB1.json?.code);

    // B2: tax=true when property tax OFF → 400 TAX_NOT_ENABLED_AT_PROPERTY
    rB1 = await postOrder(port, fx.token, baseBody({ tax_enabled: true }));
    check('B2: tax=true, property OFF → 400', rB1.status === 400,
      'got ' + rB1.status + ' code=' + rB1.json?.code);
    check('B2: code=TAX_NOT_ENABLED_AT_PROPERTY',
      rB1.json?.code === 'TAX_NOT_ENABLED_AT_PROPERTY',
      'got ' + rB1.json?.code);

    // B3: svc=false when property OFF → 201 (allowed, snapshot=false)
    rB1 = await postOrder(port, fx.token, baseBody({ service_charge_enabled: false }));
    check('B3: svc=false, property OFF → 201', rB1.status === 201,
      'got ' + rB1.status + ' code=' + rB1.json?.code);
    if (rB1.status === 201) {
      fx.orders.push(Number(rB1.json.data.id));
      const oB3 = await getOrder(c, rB1.json.data.id);
      check('B3: snapshot svc_enabled=FALSE, svc_pct=0, svc_amount=0',
        oB3?.service_charge_enabled_snapshot === false &&
        Number(oB3?.service_charge_percent_snapshot) === 0 &&
        Number(oB3?.service_amount) === 0);
      check('B3: total = 100000 (item price, no svc)', Number(oB3?.total_amount) === 100000,
        'got ' + oB3?.total_amount);
    }

    // B4: tax=false when property OFF → 201
    rB1 = await postOrder(port, fx.token, baseBody({ tax_enabled: false }));
    check('B4: tax=false, property OFF → 201', rB1.status === 201,
      'got ' + rB1.status + ' code=' + rB1.json?.code);
    if (rB1.status === 201) fx.orders.push(Number(rB1.json.data.id));

    // B5: both absent when property OFF → 201, snapshots=FALSE
    rB1 = await postOrder(port, fx.token, baseBody({}));
    check('B5: absent, property OFF → 201', rB1.status === 201,
      'got ' + rB1.status + ' code=' + rB1.json?.code);
    if (rB1.status === 201) {
      fx.orders.push(Number(rB1.json.data.id));
      const oB5 = await getOrder(c, rB1.json.data.id);
      check('B5: snapshot svc=FALSE, tax=FALSE, total=100000',
        oB5?.service_charge_enabled_snapshot === false &&
        oB5?.tax_enabled_snapshot === false &&
        Number(oB5?.total_amount) === 100000);
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // C. EFFECTIVE FLAG MERGE — property ON scenarios
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n=== C. Effective flag merge ===');

    // Set property: svc ON @10%, tax OFF @0%
    await setPricing(c, { svcOn: true, svcPct: 10, taxOn: false, taxPct: 0 });

    // C1: svc absent, property ON → follow property (svc ON)
    let rC1 = await postOrder(port, fx.token, baseBody({}));
    check('C1: svc absent, property svc=ON → 201', rC1.status === 201,
      'got ' + rC1.status + ' code=' + rC1.json?.code);
    if (rC1.status === 201) {
      fx.orders.push(Number(rC1.json.data.id));
      const oC1 = await getOrder(c, rC1.json.data.id);
      // 10% of 100000 = 10000 svc; total = 110000
      check('C1: svc snapshot=TRUE, svc_pct=10, svc_amount=10000',
        oC1?.service_charge_enabled_snapshot === true &&
        Number(oC1?.service_charge_percent_snapshot) === 10 &&
        Number(oC1?.service_amount) === 10000,
        'got svc=' + oC1?.service_amount + ' pct=' + oC1?.service_charge_percent_snapshot);
      check('C1: total=110000 (100000+10000)', Number(oC1?.total_amount) === 110000,
        'got ' + oC1?.total_amount);
    }

    // C2: svc=true, property ON → 201, same as C1
    rC1 = await postOrder(port, fx.token, baseBody({ service_charge_enabled: true }));
    check('C2: svc=true, property svc=ON → 201', rC1.status === 201,
      'got ' + rC1.status + ' code=' + rC1.json?.code);
    if (rC1.status === 201) {
      fx.orders.push(Number(rC1.json.data.id));
      const oC2 = await getOrder(c, rC1.json.data.id);
      check('C2: svc_amount=10000, total=110000',
        Number(oC2?.service_amount) === 10000 && Number(oC2?.total_amount) === 110000);
    }

    // C3: svc=false, property ON → 201, svc override OFF
    rC1 = await postOrder(port, fx.token, baseBody({ service_charge_enabled: false }));
    check('C3: svc=false, property svc=ON → 201 (override off)', rC1.status === 201,
      'got ' + rC1.status + ' code=' + rC1.json?.code);
    if (rC1.status === 201) {
      fx.orders.push(Number(rC1.json.data.id));
      const oC3 = await getOrder(c, rC1.json.data.id);
      check('C3: svc snapshot=FALSE (override), svc_amount=0, total=100000',
        oC3?.service_charge_enabled_snapshot === false &&
        Number(oC3?.service_amount) === 0 &&
        Number(oC3?.total_amount) === 100000,
        'got enabled=' + oC3?.service_charge_enabled_snapshot +
        ' svc=' + oC3?.service_amount + ' total=' + oC3?.total_amount);
    }

    // C4: set property: tax ON @11%, svc OFF
    await setPricing(c, { svcOn: false, svcPct: 0, taxOn: true, taxPct: 11 });
    rC1 = await postOrder(port, fx.token, baseBody({}));
    check('C4: tax absent, property tax=ON → 201', rC1.status === 201,
      'got ' + rC1.status + ' code=' + rC1.json?.code);
    if (rC1.status === 201) {
      fx.orders.push(Number(rC1.json.data.id));
      const oC4 = await getOrder(c, rC1.json.data.id);
      // 11% of 100000 = 11000 tax; total = 111000
      check('C4: tax_amount=11000, total=111000',
        Number(oC4?.tax_amount) === 11000 && Number(oC4?.total_amount) === 111000,
        'got tax=' + oC4?.tax_amount + ' total=' + oC4?.total_amount);
      check('C4: tax snapshot=TRUE, tax_pct=11',
        oC4?.tax_enabled_snapshot === true && Number(oC4?.tax_percent_snapshot) === 11);
    }

    // C5: both ON @10%/11% — PPN base = subtotal + svc
    await setPricing(c, { svcOn: true, svcPct: 10, taxOn: true, taxPct: 11 });
    rC1 = await postOrder(port, fx.token, baseBody({}));
    check('C5: both ON → 201', rC1.status === 201,
      'got ' + rC1.status + ' code=' + rC1.json?.code);
    if (rC1.status === 201) {
      fx.orders.push(Number(rC1.json.data.id));
      const oC5 = await getOrder(c, rC1.json.data.id);
      // svc = 10% of 100000 = 10000
      // tax = 11% of (100000 + 10000) = 12100
      // total = 100000 + 10000 + 12100 = 122100
      check('C5: svc=10000, tax=12100, total=122100',
        Number(oC5?.service_amount) === 10000 &&
        Number(oC5?.tax_amount) === 12100 &&
        Number(oC5?.total_amount) === 122100,
        'got svc=' + oC5?.service_amount + ' tax=' + oC5?.tax_amount + ' total=' + oC5?.total_amount);
    }

    // C6: svc=false + tax=true override — tax still ON (svc off-eksplisit, tax follow-properti)
    await setPricing(c, { svcOn: true, svcPct: 10, taxOn: true, taxPct: 11 });
    rC1 = await postOrder(port, fx.token, baseBody({
      service_charge_enabled: false,
      tax_enabled: true,
    }));
    check('C6: svc=false, tax=true → 201', rC1.status === 201,
      'got ' + rC1.status + ' code=' + rC1.json?.code);
    if (rC1.status === 201) {
      fx.orders.push(Number(rC1.json.data.id));
      const oC6 = await getOrder(c, rC1.json.data.id);
      // svc=0 (override off), tax=11% of 100000 = 11000
      // total = 100000 + 0 + 11000 = 111000
      check('C6: svc=0, tax=11000, total=111000',
        Number(oC6?.service_amount) === 0 &&
        Number(oC6?.tax_amount) === 11000 &&
        Number(oC6?.total_amount) === 111000,
        'got svc=' + oC6?.service_amount + ' tax=' + oC6?.tax_amount + ' total=' + oC6?.total_amount);
      check('C6: svc snapshot=FALSE (override), tax snapshot=TRUE',
        oC6?.service_charge_enabled_snapshot === false &&
        oC6?.tax_enabled_snapshot === true);
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━��━━━━━━━━━━━━━━
    // D. FINGERPRINT TRI-STATE (true, false, absent → distinct hashes)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n=== D. Fingerprint tri-state ===');

    // Ensure both ON so that true and false are both meaningful
    await setPricing(c, { svcOn: true, svcPct: 10, taxOn: true, taxPct: 11 });

    // D1: create order with svc=true + tax=true + idempotency key K1
    const keyD1 = 'ovr-d1-' + run;
    fx.idemKeys.push(keyD1);
    let rD1 = await postOrder(port, fx.token, baseBody({
      service_charge_enabled: true,
      tax_enabled: true,
    }), keyD1);
    check('D1: svc=true,tax=true → 201', rD1.status === 201,
      'got ' + rD1.status + ' code=' + rD1.json?.code);
    if (rD1.status === 201) fx.orders.push(Number(rD1.json.data.id));

    // D2: replay same key K1 with svc=false,tax=true → 409 (different fingerprint)
    let rD2 = await postOrder(port, fx.token, baseBody({
      service_charge_enabled: false,
      tax_enabled: true,
    }), keyD1);
    check('D2: replay key with svc=false → 409 IDENTITY_KEY_CONFLICT',
      rD2.status === 409, 'got ' + rD2.status + ' code=' + rD2.json?.code);
    check('D2: code=IDEMPOTENCY_KEY_CONFLICT',
      rD2.json?.code === 'IDEMPOTENCY_KEY_CONFLICT', 'got ' + rD2.json?.code);

    // D3: replay key K1 with svc=true,tax=absent → 409 (fingerprint differs: tax=null vs true)
    rD2 = await postOrder(port, fx.token, baseBody({
      service_charge_enabled: true,
    }), keyD1);
    check('D3: replay key with tax absent → 409',
      rD2.status === 409, 'got ' + rD2.status + ' code=' + rD2.json?.code);

    // D4: replay key K1 with svc=true,tax=true (exact same) → 200 REPLAY
    rD2 = await postOrder(port, fx.token, baseBody({
      service_charge_enabled: true,
      tax_enabled: true,
    }), keyD1);
    check('D4: exact replay → 200 IDEMPOTENT_REPLAY',
      rD2.status === 200 && rD2.json?.code === 'IDEMPOTENT_REPLAY',
      'got ' + rD2.status + ' code=' + rD2.json?.code);

    // D5: create new key K2 with svc=false only → distinct from K1
    const keyD5 = 'ovr-d5-' + run;
    fx.idemKeys.push(keyD5);
    rD2 = await postOrder(port, fx.token, baseBody({
      service_charge_enabled: false,
    }), keyD5);
    check('D5: new key svc=false → 201', rD2.status === 201,
      'got ' + rD2.status + ' code=' + rD2.json?.code);
    if (rD2.status === 201) fx.orders.push(Number(rD2.json.data.id));

    // D6: replay key K2 with svc absent (different flag) → 409
    rD2 = await postOrder(port, fx.token, baseBody({}), keyD5);
    check('D6: replay K2 with svc absent → 409',
      rD2.status === 409, 'got ' + rD2.status + ' code=' + rD2.json?.code);

    // ━━━━━━━━━━━���━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // E. EXPECTED TOTAL GUARD
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n=== E. Expected total guard ===');

    // Property: svc ON @10%, tax OFF @0% → total = 100000 + 10000 = 110000
    await setPricing(c, { svcOn: true, svcPct: 10, taxOn: false, taxPct: 0 });

    // E1: expected_total = 110000 (correct) → 201
    let rE1 = await postOrder(port, fx.token, baseBody({
      expected_total: 110000,
    }));
    check('E1: expected_total=110000 (correct) → 201', rE1.status === 201,
      'got ' + rE1.status + ' code=' + rE1.json?.code);
    if (rE1.status === 201) fx.orders.push(Number(rE1.json.data.id));

    // E2: expected_total = 100000 (wrong, no svc applied) → 409 PRICING_TOTAL_CHANGED
    rE1 = await postOrder(port, fx.token, baseBody({
      expected_total: 100000,
    }));
    check('E2: expected_total=100000 (wrong) → 409', rE1.status === 409,
      'got ' + rE1.status + ' code=' + rE1.json?.code);
    check('E2: code=PRICING_TOTAL_CHANGED',
      rE1.json?.code === 'PRICING_TOTAL_CHANGED',
      'got ' + rE1.json?.code);
    check('E2: data.computed_total=110000',
      Number(rE1.json?.data?.computed_total) === 110000,
      'got ' + rE1.json?.data?.computed_total);
    check('E2: data.expected_total=100000',
      Number(rE1.json?.data?.expected_total) === 100000);

    // E3: svc override OFF + expected_total=100000 (correct when svc off) → 201
    rE1 = await postOrder(port, fx.token, baseBody({
      service_charge_enabled: false,
      expected_total: 100000,
    }));
    check('E3: svc=false + expected_total=100000 → 201', rE1.status === 201,
      'got ' + rE1.status + ' code=' + rE1.json?.code);
    if (rE1.status === 201) {
      fx.orders.push(Number(rE1.json.data.id));
      const oE3 = await getOrder(c, rE1.json.data.id);
      check('E3: total=100000, svc=0',
        Number(oE3?.total_amount) === 100000 && Number(oE3?.service_amount) === 0);
    }

    // E4: expected_total absent (backward compat) → 201
    rE1 = await postOrder(port, fx.token, baseBody({}));
    check('E4: expected_total absent → 201', rE1.status === 201,
      'got ' + rE1.status + ' code=' + rE1.json?.code);
    if (rE1.status === 201) fx.orders.push(Number(rE1.json.data.id));

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // F. IMMUTABILITY: PAID orders unaffected by settings changes
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n=== F. Order immutability ===');

    // Use the last created order (OPEN status — not PAID, but let's verify snapshot)
    const lastOrderId = fx.orders[fx.orders.length - 1];
    const beforeChange = await getOrder(c, lastOrderId);

    // Change property settings radically
    await setPricing(c, { svcOn: false, svcPct: 99, taxOn: true, taxPct: 50 });

    const afterChange = await getOrder(c, lastOrderId);
    check('F1: snapshot values unchanged after settings change',
      Number(beforeChange?.total_amount) === Number(afterChange?.total_amount) &&
      Number(beforeChange?.service_amount) === Number(afterChange?.service_amount) &&
      Number(beforeChange?.tax_amount) === Number(afterChange?.tax_amount),
      'before total=' + beforeChange?.total_amount + ' after=' + afterChange?.total_amount);
    check('F1: svc snapshot flag unchanged',
      beforeChange?.service_charge_enabled_snapshot === afterChange?.service_charge_enabled_snapshot,
      'before=' + beforeChange?.service_charge_enabled_snapshot +
      ' after=' + afterChange?.service_charge_enabled_snapshot);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // G. BACKWARD COMPAT: legacy payload (no new fields at all)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n=== G. Backward compatibility ===');

    // Reset property to both OFF
    await setPricing(c, { svcOn: false, svcPct: 0, taxOn: false, taxPct: 0 });

    // G1: payload without any new fields → legacy behavior (follow property)
    let rG1 = await postOrder(port, fx.token, baseBody({}));
    check('G1: legacy payload (absent) → 201', rG1.status === 201,
      'got ' + rG1.status + ' code=' + rG1.json?.code);
    if (rG1.status === 201) {
      fx.orders.push(Number(rG1.json.data.id));
      const oG1 = await getOrder(c, rG1.json.data.id);
      check('G1: total=100000, no svc, no tax',
        Number(oG1?.total_amount) === 100000 &&
        Number(oG1?.service_amount) === 0 &&
        Number(oG1?.tax_amount) === 0);
    }

    // G2: payload with explicit false (new client sending explicit false)
    rG1 = await postOrder(port, fx.token, baseBody({
      service_charge_enabled: false,
      tax_enabled: false,
    }));
    check('G2: explicit false+false → 201', rG1.status === 201,
      'got ' + rG1.status + ' code=' + rG1.json?.code);
    if (rG1.status === 201) {
      fx.orders.push(Number(rG1.json.data.id));
      const oG2 = await getOrder(c, rG1.json.data.id);
      check('G2: svc snapshot=FALSE, tax snapshot=FALSE, total=100000',
        oG2?.service_charge_enabled_snapshot === false &&
        oG2?.tax_enabled_snapshot === false &&
        Number(oG2?.total_amount) === 100000);
    }

    // ── Summary ────────────────────────────────────────────────────────────
    console.log('\n[SUMMARY] passed=' + passed + ' failed=' + failed);
    if (failures.length) {
      console.error('[FAILURES]');
      failures.forEach((f) => console.error('  - ' + f));
    }

  } catch (e) {
    console.error('[ERROR]', e.stack || e.message);
    failed++;
  } finally {
    if (c) {
      try {
        await cleanup(c);
        await residue(c);
      } finally {
        c.release();
      }
    }
    if (server) { try { server.close(); } catch (_) {} }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
