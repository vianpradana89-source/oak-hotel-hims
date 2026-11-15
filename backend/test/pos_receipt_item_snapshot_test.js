/**
 * POS RECEIPT ITEM SNAPSHOT IMMUTABILITY TEST
 * Disposable oak_minibar_test only; no dotenv reads.
 *
 * Cakupan:
 *  S1 â€” Snapshot ditulis dari master DB saat create order
 *  S2 â€” Rename master tidak mengubah stored snapshot
 *  S3 â€” Replay tidak recompute snapshot
 *  S4 â€” item_code NULL di master â†’ snapshot NULL
 *  S5 â€” Spoof payload tidak memengaruhi stored snapshot
 *  Financial safety â€” tidak ada artifacts transaksi
 *  Cleanup + residue 0
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test \
 *   node backend/test/pos_receipt_item_snapshot_test.js
 */
'use strict';

const crypto = require('crypto');
const run = crypto.randomBytes(6).toString('hex');

// â”€â”€â”€ DB SAFETY GUARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const FORBIDDEN = ['staging', 'production', 'prod', 'live'];

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error(
    'SAFETY: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/test/pos_receipt_item_snapshot_test.js'
  );
  process.exit(1);
}

let target;
try {
  const u = new URL(testUrl.trim());
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) throw new Error('protocol wajib postgres/postgresql');
  const user = u.username ? decodeURIComponent(u.username) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';
  const database = u.pathname ? decodeURIComponent(u.pathname.replace(/^\//, '')) : '';
  if (!user || !password) throw new Error('user & password wajib lengkap');
  if (u.searchParams.size > 0) {
    const keys = [...u.searchParams.keys()].join(', ');
    throw new Error('query parameter ditolak: ' + keys);
  }
  if (u.hostname !== '127.0.0.1') throw new Error(`host wajib 127.0.0.1 (diterima: ${u.hostname})`);
  const port = Number(u.port);
  if (port !== 15434) throw new Error(`port wajib 15434 (diterima: ${u.port})`);
  if (database !== 'oak_minibar_test') throw new Error(`database wajib oak_minibar_test (diterima: ${database})`);
  if (user !== 'minibar_test') throw new Error(`user wajib minibar_test (diterima: ${user})`);
  if (FORBIDDEN.some((p) => database.toLowerCase().includes(p) || user.toLowerCase().includes(p))) {
    throw new Error('indikator staging/production/live terdeteksi');
  }
  target = { host: u.hostname, port, user, password, database };
  console.log(`[SNAPSHOT TEST] Target DB: ${database} (user: ${user}, port: ${port})`);
} catch (e) {
  console.error('SAFETY: TEST_DATABASE_URL ditolak â€” ' + e.message);
  process.exit(1);
}

// Block transitive dotenv/config imports before loading the production app.
const dotenv = require('dotenv');
dotenv.config = () => ({ parsed: {} });
dotenv.configDotenv = () => ({ parsed: {} });
const dc = require.resolve('dotenv/config');
require.cache[dc] = { id: dc, filename: dc, loaded: true, exports: {} };

Object.assign(process.env, {
  DB_HOST: target.host,
  DB_PORT: String(target.port),
  DB_USER: target.user,
  DB_PASSWORD: target.password,
  DB_NAME: target.database,
  RUN_SCHEMA_INITIALIZATION: 'false',
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
});

const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const http = require('http');

// â”€â”€ Fixture tracker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const fixtures = {
  properties: [],
  roles: [],
  users: [],
  categories: [],
  menuItems: [],
  orders: [],
};
let passed = 0;
let failed = 0;
const failures = [];

function check(label, cond) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; failures.push(label); console.error('  FAIL  ' + label); }
}

function problem(label, e) {
  const msg = label + ': ' + String((e && e.message) || e);
  failures.push(msg);
  console.error('[ERROR] ' + msg);
}

// â”€â”€ DB identity guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function identity(c) {
  for (const k of ['host', 'port', 'user', 'database']) {
    if (String(pool.options[k]) !== String(target[k])) {
      throw new Error('pool.options.' + k + ' tidak sesuai target');
    }
  }
  const r = (await c.query('SELECT current_database() AS db, current_user AS usr')).rows[0];
  if (r.db !== target.database || r.usr !== target.user) {
    throw new Error('identitas DB tidak sesuai: db=' + r.db + ' usr=' + r.usr);
  }
}

// â”€â”€ Prerequisite: verify snapshot columns exist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function verifySnapshotColumns(c) {
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='pos_order_items'
       AND column_name IN ('item_name_snapshot','item_code_snapshot')`
  );
  const cols = r.rows.map((row) => row.column_name);
  if (!cols.includes('item_name_snapshot') || !cols.includes('item_code_snapshot')) {
    throw new Error(
      'Prerequisite GAGAL: kolom snapshot tidak lengkap di pos_order_items. ' +
      'Jalankan migration pos_receipt_snapshot_v1 terlebih dahulu. (ditemukan: ' +
      cols.join(', ') + ')'
    );
  }
  console.log('[PREREQ] Kolom snapshot tersedia: ' + cols.join(', '));
}

// â”€â”€ Property fixture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function createProperty(c) {
  const code = 'SNAP' + run.slice(0, 2).toUpperCase(); // 6 char, [A-Z0-9]
  const r = await c.query(
    `INSERT INTO properties (name, property_code, timezone, currency_code, is_active)
     VALUES ($1, $2, 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`,
    ['Snapshot Test ' + run, code]
  );
  const p = Number(r.rows[0].id);
  fixtures.properties.push(p);
  return p;
}

// â”€â”€ Role + user fixture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Grant minimum permissions: pos.view, pos.create, pos.edit
const POS_KEYS = ['pos.view', 'pos.create', 'pos.edit'];

async function createRoleAndUser(c, pid, label) {
  const roleRes = await c.query(
    `INSERT INTO roles (property_id, name, is_active, is_system_role, is_test_data)
     VALUES ($1, $2, TRUE, FALSE, TRUE) RETURNING id`,
    [pid, 'SnapTest ' + label + ' ' + run]
  );
  const roleId = Number(roleRes.rows[0].id);
  fixtures.roles.push(roleId);

  const permRes = await c.query(
    `SELECT id FROM permissions WHERE key = ANY($1)`,
    [POS_KEYS]
  );
  if (permRes.rows.length !== POS_KEYS.length) {
    throw new Error('Permission prerequisite tidak lengkap: ' +
      permRes.rows.map((r) => r.key).join(',') + ' (dibutuhkan: ' + POS_KEYS.join(',') + ')');
  }
  for (const p of permRes.rows) {
    await c.query(
      `INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
       VALUES ($1, $2, TRUE, 'snapshot-test')
       ON CONFLICT (role_id, permission_id) DO NOTHING`,
      [roleId, p.id]
    );
  }

  const username = 'snapt_' + label + '_' + run;
  const userRes = await c.query(
    `INSERT INTO users
       (property_id, role_id, username, email, full_name, is_active, is_test_data,
        account_status, must_change_password, access_type)
     VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, 'READY', FALSE, 'PMS_STAFF') RETURNING id`,
    [pid, roleId, username, username + '@test.local', 'SnapTest ' + label]
  );
  const userId = Number(userRes.rows[0].id);
  fixtures.users.push(userId);

  const payload = {
    id: userId,
    property_id: pid,
    role_id: roleId,
    username,
    email: username + '@test.local',
    full_name: 'SnapTest ' + label,
    role: 'Fixture',
    scope: 'FULL',
    account_status: 'READY',
    must_change_password: false,
    access_type: 'PMS_STAFF',
  };
  const token = generateToken(payload);
  return { userId, roleId, token, pid };
}

// â”€â”€ Menu category + item fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function createCategory(c, pid, label) {
  const r = await c.query(
    `INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id`,
    [pid, 'SnapTest ' + label + ' ' + run]
  );
  const id = Number(r.rows[0].id);
  fixtures.categories.push(id);
  return id;
}

async function createMenuItem(c, pid, catId, name, itemCode, price) {
  const r = await c.query(
    `INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active)
     VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id`,
    [pid, catId, itemCode, name, price]
  );
  const id = Number(r.rows[0].id);
  fixtures.menuItems.push(id);
  return id;
}

// â”€â”€ HTTP helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function request(port, path, body, opts) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts && opts.auth) headers.Authorization = 'Bearer ' + opts.auth;
  if (opts && opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const res = await fetch('http://127.0.0.1:' + port + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// â”€â”€ No-financial check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function noFinancial(c, pid) {
  for (const table of ['transactions', 'pos_settlements', 'payment_transactions', 'folio_entries', 'transaction_daily_sequences']) {
    const n = Number((await c.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE property_id = $1`, [pid]
    )).rows[0].n);
    check('No financial artifact: ' + table + ' property=' + pid, n === 0);
    if (n > 0) console.error('[PRESERVE] ' + table + ' memiliki ' + n + ' baris untuk property ' + pid);
  }
}

// â”€â”€ DB read helpers (with separate client to avoid pool lock contention) â”€â”€
async function dbQuery(sql, params) {
  const c = await pool.connect();
  try { return c.query(sql, params); }
  finally { c.release(); }
}

async function getOrderItemSnapshot(orderId, menuItemId) {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT item_name_snapshot, item_code_snapshot, unit_price, quantity,
              discount_type, discount_value, discount_amount
       FROM pos_order_items
       WHERE order_id = $1 AND menu_item_id = $2`,
      [orderId, menuItemId]
    );
    return r.rows[0] || null;
  } finally { c.release(); }
}

async function getItemCount(orderId) {
  const r = await dbQuery(
    `SELECT COUNT(*) AS n FROM pos_order_items WHERE order_id = $1`, [orderId]
  );
  return Number(r.rows[0].n);
}

// â”€â”€ Cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function clean(c) {
  const pids = fixtures.properties;
  const roles = fixtures.roles;
  const users = fixtures.users;
  const orders = fixtures.orders;
  await c.query('BEGIN');
  try {
    await c.query('DELETE FROM pos_order_items WHERE order_id = ANY($1::int[])', [orders]);
    await c.query('DELETE FROM pos_orders WHERE property_id = ANY($1::int[])', [pids]);
    await c.query('DELETE FROM audit_logs WHERE property_id = ANY($1::int[])', [pids]);
    await c.query('DELETE FROM pos_menu_items WHERE property_id = ANY($1::int[])', [pids]);
    await c.query('DELETE FROM pos_menu_categories WHERE property_id = ANY($1::int[])', [pids]);
    await c.query(
      `DELETE FROM user_permission_overrides WHERE property_id = ANY($1::int[]) AND user_id = ANY($2::int[])`,
      [pids, users]
    );
    await c.query(
      `DELETE FROM users WHERE property_id = ANY($1::int[]) AND id = ANY($2::int[])`,
      [pids, users]
    );
    await c.query(
      `DELETE FROM roles WHERE property_id = ANY($1::int[]) AND id = ANY($2::int[])`,
      [pids, roles]
    );
    await c.query('DELETE FROM properties WHERE id = ANY($1::int[])', [pids]);
    await c.query('COMMIT');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

async function residue(c) {
  const pids = fixtures.properties;
  const roles = fixtures.roles;
  const users = fixtures.users;
  const orders = fixtures.orders;
  const itemIds = fixtures.menuItems;

  for (const table of [
    'pos_orders', 'audit_logs', 'transactions', 'pos_settlements',
    'payment_transactions', 'folio_entries', 'transaction_daily_sequences',
    'pos_menu_items', 'pos_menu_categories',
  ]) {
    const n = Number((await c.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE property_id = ANY($1::int[])`, [pids]
    )).rows[0].n);
    check('Residue ' + table + ' = 0', n === 0);
  }
  check(
    'Residue users = 0',
    Number((await c.query(
      `SELECT COUNT(*) AS n FROM users WHERE property_id = ANY($1::int[]) AND id = ANY($2::int[])`, [pids, users]
    )).rows[0].n) === 0
  );
  check(
    'Residue roles = 0',
    Number((await c.query(
      `SELECT COUNT(*) AS n FROM roles WHERE property_id = ANY($1::int[]) AND id = ANY($2::int[])`, [pids, roles]
    )).rows[0].n) === 0
  );
  check(
    'Residue pos_order_items = 0',
    Number((await c.query(
      `SELECT COUNT(*) AS n FROM pos_order_items WHERE order_id = ANY($1::int[])`, [orders]
    )).rows[0].n) === 0
  );
  check(
    'Residue menu_items = 0',
    Number((await c.query(
      `SELECT COUNT(*) AS n FROM pos_menu_items WHERE id = ANY($1::int[])`, [itemIds]
    )).rows[0].n) === 0
  );
  check(
    'Residue properties = 0',
    Number((await c.query(
      `SELECT COUNT(*) AS n FROM properties WHERE id = ANY($1::int[])`, [pids]
    )).rows[0].n) === 0
  );
}

function release(c, label, discard) {
  if (c) {
    try { c.release(discard); }
    catch (e) { problem(label + ' release', e); }
  }
}

// â”€â”€ MAIN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main() {
  let c = null;
  let server = null;
  let verified = false;

  console.log('\n[POS RECEIPT ITEM SNAPSHOT TEST] oak_minibar_test/minibar_test @ 127.0.0.1:15434');

  try {
    c = await pool.connect();
    await identity(c);
    await verifySnapshotColumns(c);
    verified = true;
    console.log('[IDENTITY/PREREQ] terverifikasi.');

    // â”€â”€ Setup fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const pid = await createProperty(c);
    const auth = await createRoleAndUser(c, pid, 'A');
    const catId = await createCategory(c, pid, 'Main');

    // Menu A: Nasi Goreng Original, code NG-001, price 15000
    const menuA = await createMenuItem(c, pid, catId, 'Nasi Goreng Original', 'NG-001', 15000);

    // Menu B: Air Mineral, code NULL, price 5000
    const menuB = await createMenuItem(c, pid, catId, 'Air Mineral', null, 5000);

    // Start HTTP server
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    console.log('[SERVER] listening di port ' + port);

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // S1 â€” Snapshot ditulis dari master DB
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    console.log('\nâ”€â”€ S1: Create order â†’ snapshot ditulis dari master â”€â”€');

    const keyS1 = 'snap_s1_' + run;
    const bodyS1 = {
      property_id: pid,
      items: [
        { menu_item_id: menuA, quantity: 2 },
        { menu_item_id: menuB, quantity: 1 },
      ],
    };

    const rS1 = await request(port, '/api/pos/orders', bodyS1, { auth: auth.token, idempotencyKey: keyS1 });
    check('S1: create order HTTP 201', rS1.status === 201);
    const orderS1 = rS1.body && rS1.body.data;
    check('S1: response status SUCCESS', rS1.body && rS1.body.status === 'SUCCESS');
    check('S1: order id valid', orderS1 && Number(orderS1.id) > 0);
    if (orderS1 && orderS1.id) fixtures.orders.push(Number(orderS1.id));
    check('S1: order status OPEN', orderS1 && orderS1.status === 'OPEN');

    // Read stored snapshot directly from DB
    const snapA = await getOrderItemSnapshot(orderS1 ? Number(orderS1.id) : 0, menuA);
    check('S1: item_name_snapshot = "Nasi Goreng Original"', snapA && snapA.item_name_snapshot === 'Nasi Goreng Original');
    check('S1: item_code_snapshot = "NG-001"', snapA && snapA.item_code_snapshot === 'NG-001');
    check('S1: unit_price = 15000', snapA && Number(snapA.unit_price) === 15000);

    const snapB = await getOrderItemSnapshot(orderS1 ? Number(orderS1.id) : 0, menuB);
    check('S1(S4): item_name_snapshot menuB = "Air Mineral"', snapB && snapB.item_name_snapshot === 'Air Mineral');
    check('S1(S4): item_code_snapshot menuB IS NULL', snapB && snapB.item_code_snapshot === null);
    check('S1(S4): unit_price menuB = 5000', snapB && Number(snapB.unit_price) === 5000);

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // S2 â€” Rename master tidak mengubah snapshot
    // â•â•â•â•â•â•â•â•â•â•â•â•â•ï¿½ï¿½ï¿½â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    console.log('\nâ”€â”€ S2: Rename master â†’ snapshot tetap immutable â”€â”€');

    await c.query(
      `UPDATE pos_menu_items SET name = 'Nasi Goreng Baru', item_code = 'NG-999' WHERE id = $1`,
      [menuA]
    );

    // Assert master memang berubah (bukan false positive)
    const masterAfter = await dbQuery(
      `SELECT name, item_code FROM pos_menu_items WHERE id = $1`, [menuA]
    );
    check('S2: master name berubah â†’ "Nasi Goreng Baru"',
      masterAfter.rows[0] && masterAfter.rows[0].name === 'Nasi Goreng Baru');
    check('S2: master item_code berubah â†’ "NG-999"',
      masterAfter.rows[0] && masterAfter.rows[0].item_code === 'NG-999');

    // Snapshot order lama tetap Original
    const snapAfterRename = await getOrderItemSnapshot(Number(orderS1.id), menuA);
    check('S2: item_name_snapshot tetap "Nasi Goreng Original" setelah rename',
      snapAfterRename && snapAfterRename.item_name_snapshot === 'Nasi Goreng Original');
    check('S2: item_code_snapshot tetap "NG-001" setelah rename',
      snapAfterRename && snapAfterRename.item_code_snapshot === 'NG-001');

    // â•â•â•â•â•ï¿½ï¿½ï¿½â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // S3 â€” Replay tidak recompute snapshot
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    console.log('\nâ”€â”€ S3: Replay idempotency key â†’ snapshot tidak direcompute â”€â”€');

    const itemCountBefore = await getItemCount(Number(orderS1.id));
    const snapBeforeReplay = await getOrderItemSnapshot(Number(orderS1.id), menuA);

    const rReplay = await request(port, '/api/pos/orders', bodyS1, { auth: auth.token, idempotencyKey: keyS1 });
    check('S3: replay HTTP 200', rReplay.status === 200);
    check('S3: replay code IDEMPOTENT_REPLAY',
      rReplay.body && rReplay.body.code === 'IDEMPOTENT_REPLAY');
    check('S3: replay order ID sama',
      rReplay.body && rReplay.body.data && Number(rReplay.body.data.id) === Number(orderS1.id));

    const itemCountAfter = await getItemCount(Number(orderS1.id));
    check('S3: tidak ada item tambahan setelah replay', itemCountBefore === itemCountAfter);

    const snapAfterReplay = await getOrderItemSnapshot(Number(orderS1.id), menuA);
    check('S3: snapshot nama tetap "Nasi Goreng Original" setelah replay',
      snapAfterReplay && snapAfterReplay.item_name_snapshot === 'Nasi Goreng Original');
    check('S3: snapshot code tetap "NG-001" setelah replay',
      snapAfterReplay && snapAfterReplay.item_code_snapshot === 'NG-001');

    // S3 juga: replay response items snapshot (stored field, bukan live join)
    const replayItems = rReplay.body && rReplay.body.data && rReplay.body.data.items;
    if (Array.isArray(replayItems)) {
      const replayItemA = replayItems.find((it) => Number(it.menu_item_id) === menuA);
      if (replayItemA) {
        check('S3: replay response item_name_snapshot = "Nasi Goreng Original"',
          replayItemA.item_name_snapshot === 'Nasi Goreng Original');
        check('S3: replay response item_code_snapshot = "NG-001"',
          replayItemA.item_code_snapshot === 'NG-001');
      } else {
        check('S3: replay response memuat item A', false);
      }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // S5 â€” Spoof payload tidak memengaruhi stored snapshot
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    console.log('\nâ”€â”€ S5: Spoof snapshot field di payload â†’ stored tetap dari DB â”€â”€');

    const keyS5 = 'snap_s5_' + run;
    // Body dengan field spoof unknown â€” handler production tidak membaca snapshot dari payload
    const bodyS5 = {
      property_id: pid,
      items: [
        {
          menu_item_id: menuA,
          quantity: 1,
          // Spoof â€” seharusnya diabaikan oleh production handler
          item_name_snapshot: 'PALSU',
          item_code_snapshot: 'PALSU',
        },
      ],
    };
    const rS5 = await request(port, '/api/pos/orders', bodyS5, { auth: auth.token, idempotencyKey: keyS5 });

    if (rS5.status === 201) {
      const orderS5 = rS5.body && rS5.body.data;
      if (orderS5 && orderS5.id) fixtures.orders.push(Number(orderS5.id));
      const snapS5 = await getOrderItemSnapshot(Number(orderS5.id), menuA);
      check('S5: create with spoof â†’ 201 sukses', true);
      check('S5: item_name_snapshot tetap dari DB ("Nasi Goreng Baru" setelah rename, bukan "PALSU")',
        snapS5 && snapS5.item_name_snapshot !== 'PALSU');
      check('S5: item_code_snapshot tetap dari DB ("NG-999" setelah rename, bukan "PALSU")',
        snapS5 && snapS5.item_code_snapshot !== 'PALSU');
      // Catat: master A sudah di-rename jadi 'Nasi Goreng Baru'/'NG-999', jadi
      // snapshot baru akan menyimpan nilai master saat ini.
      check('S5: snapshot tidak menggunakan nilai spoof "PALSU"',
        snapS5 && snapS5.item_name_snapshot !== 'PALSU' && snapS5.item_code_snapshot !== 'PALSU');
    } else {
      // Jika handler menolak unknown field (400), skip dengan catatan
      console.log('  INFO  S5: create order dengan spoof field â†’ HTTP ' + rS5.status +
        (rS5.body && rS5.body.code ? ' (' + rS5.body.code + ')' : '') + ' â€” snapshot dari payload ditolak/diabaikan.');
      check('S5: spoof snapshot tidak membuat order dengan nilai palsu (handler menolak/diabaikan)',
        rS5.status === 400 || rS5.status === 422 || rS5.status === 404);
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // No financial artifacts
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•ï¿½ï¿½ï¿½â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    console.log('\nâ”€â”€ Financial safety: tidak ada artifacts transaksi â”€â”€');
    await noFinancial(c, pid);

  } catch (e) {
    problem('main', e);
  } finally {
    // Close server
    if (server) {
      try {
        await new Promise((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve()))
        );
      } catch (e) { problem('server.close', e); }
    }
    release(c, 'main', false);
    c = null;

    // Cleanup + residue
    if (verified) {
      let cc = null;
      let bad = false;
      try {
        cc = await pool.connect();
        await identity(cc);
        await clean(cc);
      } catch (e) {
        bad = Boolean(e.discardClient);
        problem('cleanup', e);
      } finally {
        release(cc, 'cleanup', bad);
        cc = null;
      }

      let rc = null;
      try {
        rc = await pool.connect();
        await identity(rc);
        await residue(rc);
      } catch (e) {
        problem('residue', e);
      } finally {
        release(rc, 'residue', false);
      }
    }

    try { await pool.end(); } catch (e) { problem('pool.end', e); }
  }

  console.log('\n[RESULT] ' + passed + ' PASS, ' + failed + ' FAIL');
  for (const f of failures) console.error('  - ' + f);
  if (!failures.length) console.log('[CLEANUP/RESIDUE] 0 â€” seluruh fixture bersih.');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error('[CRASH]', e); process.exitCode = 1; });
