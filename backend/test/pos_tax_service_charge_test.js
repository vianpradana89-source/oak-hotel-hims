/**
 * POS Tax & Service Charge â€” Backend integration test (Phase 2A)
 *
 * Cakupan (11 kasus wajib):
 *  1. tax OFF + service OFF
 *  2. tax ON  + service OFF
 *  3. tax OFF + service ON
 *  4. tax ON  + service ON
 *  5. discount menjadi basis sebelum tax/service
 *  6. disabled amount = 0
 *  7. replay memakai snapshot lama setelah property rate berubah
 *  8. same idempotency key + toggle berbeda â†’ conflict
 *  9. legacy request tanpa tax/service tetap backward compatible
 * 10. migration marker ordering: first apply + second run already-applied
 * 11. receipt mengembalikan snapshot tax/service
 *
 * DB safety guard (identik dengan pos_order_foundation_test.js):
 * - TEST_DATABASE_URL eksplisit, host localhost/127.0.0.1, port eksplisit,
 *   user & password lengkap, database berakhiran '_test'.
 * - Tanpa query parameter, tanpa fallback .env / DB_* / PG*.
 * - Menolak nama DB/user mengandung staging|production|prod|live.
 * - RUN_SCHEMA_INITIALIZATION=false.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test \
 *   node backend/test/pos_tax_service_charge_test.js
 */

'use strict';

// â”€â”€â”€ DB SAFETY GUARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error(
    'SAFETY: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:PORT/<db>_test ' +
    'node backend/test/pos_tax_service_charge_test.js'
  );
  process.exit(1);
}

const FORBIDDEN = ['staging', 'production', 'prod', 'live'];
let target;
try {
  const u = new URL(testUrl.trim());
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('protocol wajib postgres/postgresql');
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new Error(`host wajib localhost/127.0.0.1 (diterima: ${u.hostname})`);
  if (u.searchParams.size > 0) throw new Error(`query parameter tidak didukung: ${[...u.searchParams.keys()].join(', ')}`);
  const user = u.username ? decodeURIComponent(u.username) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';
  const database = u.pathname ? decodeURIComponent(u.pathname.replace(/^\//, '')) : '';
  if (!user) throw new Error('user wajib lengkap');
  if (!password) throw new Error('password wajib lengkap');
  if (!/^[a-z0-9_]+_test$/.test(database.toLowerCase())) throw new Error(`database wajib berakhiran "_test" (diterima: ${database})`);
  if (FORBIDDEN.some((p) => database.toLowerCase().includes(p))) throw new Error('indikator staging/production/live terdeteksi');
  if (!u.port) throw new Error('port wajib eksplisit');
  const port = Number(u.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`port tidak valid (diterima: ${u.port})`);
  target = { host: u.hostname, port, user, database, password };
  console.log(`[TAX SVC TEST] Target DB: ${database} (user: ${user}, port: ${port})`);
} catch (e) {
  console.error('SAFETY: TEST_DATABASE_URL ditolak â€” ' + e.message);
  process.exit(1);
}

process.env.DB_HOST = target.host;
process.env.DB_PORT = String(target.port);
process.env.DB_USER = target.user;
process.env.DB_PASSWORD = target.password;
process.env.DB_NAME = target.database;
process.env.RUN_SCHEMA_INITIALIZATION = 'false';

const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const { runPosTaxServiceMigration } = require('../dist/db/migrations/pos_tax_service_charge_v1');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

// â”€â”€ Tracked fixture IDs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const tracked = {
  properties: [], users: [], roles: [], items: [], categories: [],
  bookings: [], reservations: [], orders: [], idempotencyKeys: [],
  pricingSettings: [],
};

// â”€â”€ Identitas unik per run â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const RUN_ID = Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();

// â”€â”€ Assertion helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function expect(condition, msg) {
  if (condition) { passed += 1; console.log('PASS | ' + msg); }
  else { failed += 1; console.error('FAIL | ' + msg); }
}

// String/boolean: cocokkan dengan String()
function expectEq(actual, expected, msg) {
  const ok = String(actual) === String(expected);
  if (ok) { passed += 1; console.log('PASS | ' + msg + ` (${actual} === ${expected})`); }
  else { failed += 1; console.error(`FAIL | ${msg} — actual=${actual}, expected=${expected}`); }
}

// Numerik: cocokkan via Number() agar 100000.00 === 100000
function expectNum(actual, expected, msg) {
  const a = Number(actual);
  const ok = a === expected && !Number.isNaN(a);
  if (ok) { passed += 1; console.log('PASS | ' + msg + ` (${actual} == ${expected})`); }
  else { failed += 1; console.error(`FAIL | ${msg} — actual=${actual}, expected=${expected}`); }
}

// â”€â”€ HTTP helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const HTTP_TIMEOUT_MS = 20000;
async function api(method, path, body, opts) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts && opts.auth) headers.Authorization = `Bearer ${opts.auth}`;
  if (opts && opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const finalOpts = { method, headers };
  if (body !== undefined && body !== null && method !== 'GET') finalOpts.body = JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  finalOpts.signal = controller.signal;
  try {
    const res = await fetch(baseUrl + path, finalOpts);
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } finally { clearTimeout(timer); }
}

// â”€â”€ Cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function cleanup() {
  const client = await pool.connect();
  try {
    for (const id of tracked.orders) {
      try { await client.query('DELETE FROM pos_order_items WHERE order_id = $1', [id]); } catch (_) {}
      try { await client.query('DELETE FROM pos_orders WHERE id = $1', [id]); } catch (_) {}
    }
    for (const id of tracked.idempotencyKeys) {
      try { await client.query('DELETE FROM idempotency_keys WHERE key = $1', [id]); } catch (_) {}
    }
    for (const pid of tracked.properties) {
      try { await client.query('DELETE FROM property_pricing_settings WHERE property_id = $1', [pid]); } catch (_) {}
      try { await client.query("DELETE FROM audit_logs WHERE property_id = $1 AND module = 'POS'", [pid]); } catch (_) {}
      for (const id of tracked.items) {
        try { await client.query('DELETE FROM pos_menu_items WHERE id = $1', [id]); } catch (_) {}
      }
      for (const id of tracked.categories) {
        try { await client.query('DELETE FROM pos_menu_categories WHERE id = $1', [id]); } catch (_) {}
      }
      for (const id of tracked.reservations) {
        try { await client.query('DELETE FROM reservations WHERE id = $1', [id]); } catch (_) {}
      }
      for (const id of tracked.bookings) {
        try { await client.query('DELETE FROM bookings WHERE id = $1', [id]); } catch (_) {}
      }
      for (const id of tracked.users) {
        try { await client.query('DELETE FROM users WHERE id = $1', [id]); } catch (_) {}
      }
      for (const id of tracked.roles) {
        try { await client.query('DELETE FROM role_permissions WHERE role_id = $1', [id]); } catch (_) {}
        try { await client.query('DELETE FROM roles WHERE id = $1', [id]); } catch (_) {}
      }
      try { await client.query('DELETE FROM properties WHERE id = $1', [pid]); } catch (_) {}
    }
  } finally { client.release(); }
}

// â”€â”€ Verifikasi identitas DB â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function verifyDbIdentity() {
  const mismatches = [
    ['host', pool.options.host, target.host],
    ['port', String(pool.options.port), String(target.port)],
    ['user', pool.options.user, target.user],
    ['database', pool.options.database, target.database],
  ].filter(([, a, b]) => String(a ?? '').toLowerCase() !== String(b ?? '').toLowerCase());
  if (mismatches.length > 0) {
    for (const [field, got, want] of mismatches)
      console.error(`SAFETY DITOLAK: pool.options.${field}="${got}" != target "${want}"`);
    process.exit(1);
  }
  const client = await pool.connect();
  try {
    const r = await client.query('SELECT current_database() AS db, current_user AS usr');
    const row = r.rows[0] || {};
    if ((row.db ?? '').toLowerCase() !== target.database.toLowerCase()) {
      console.error(`SAFETY DITOLAK: current_database "${row.db}" != target "${target.database}"`);
      process.exit(1);
    }
    if (!/^[a-z0-9_]+_test$/.test((row.db ?? '').toLowerCase())) {
      console.error(`SAFETY DITOLAK: database aktual "${row.db}" bukan *_test`);
      process.exit(1);
    }
    if (FORBIDDEN.some((p) => (row.db ?? '').toLowerCase().includes(p))) {
      console.error('SAFETY DITOLAK: database terindikasi staging/prod/live');
      process.exit(1);
    }
    console.log(`[TAX SVC TEST] DB terverifikasi: db=${row.db} user=${row.usr}`);
  } finally { client.release(); }
}

// â”€â”€ Fixture helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const POS_KEYS = ['pos.view', 'pos.create', 'pos.edit'];
const DISCOUNT_KEY = 'pos.discount.edit';

async function createPosUser(client, propertyId, tag) {
  const roleRes = await client.query(
    `INSERT INTO roles (property_id, name, is_system_role, is_active)
     VALUES ($1, $2, FALSE, TRUE) RETURNING id`,
    [propertyId, `TAX-${tag}-ROLE`]
  );
  const roleId = roleRes.rows[0].id;
  tracked.roles.push(roleId);

  const userRes = await client.query(
    `INSERT INTO users (property_id, role_id, username, email, password_hash, full_name, is_active)
     VALUES ($1, $2, $3, $4, 'x', $5, TRUE) RETURNING id`,
    [propertyId, roleId,
     `tax_${RUN_ID}_${tag.toLowerCase()}`.slice(0, 100),
     `tax_${RUN_ID}_${tag.toLowerCase()}@oak.test`.slice(0, 150),
     `TAX ${tag}`]
  );
  const userId = userRes.rows[0].id;
  tracked.users.push(userId);

  // Grant POS keys + pos.discount.edit (untuk kasus 5 diskon order)
  const allKeys = [...POS_KEYS, DISCOUNT_KEY];
  const permRes = await client.query(
    'SELECT id, key FROM permissions WHERE key = ANY($1)', [allKeys]
  );
  for (const p of permRes.rows) {
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id, granted, created_by)
       VALUES ($1, $2, TRUE, 'tax-test')
       ON CONFLICT (role_id, permission_id) DO NOTHING`,
      [roleId, p.id]
    );
  }
  return { userId, roleId };
}

function tokenFor(userId, propertyId) {
  return generateToken({
    id: userId, email: `tax_${userId}@oak.test`, username: `tax_${userId}`,
    full_name: `TAX ${userId}`, role: 'Front Office', role_id: null,
    property_id: propertyId, scope: 'FULL',
  });
}

async function createPricingSettings(client, propertyId, taxPercent, servicePercent) {
  const res = await client.query(
    `INSERT INTO property_pricing_settings (property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service)
     VALUES ($1, $2, $3, FALSE, FALSE)
     ON CONFLICT (property_id) DO UPDATE SET tax_percent = EXCLUDED.tax_percent,
       service_charge_percent = EXCLUDED.service_charge_percent, updated_at = NOW()
     RETURNING property_id`,
    [propertyId, taxPercent, servicePercent]
  );
  if (!tracked.pricingSettings.includes(propertyId)) tracked.pricingSettings.push(propertyId);
  return res;
}

async function updatePricingSettings(client, propertyId, taxPercent, servicePercent) {
  await client.query(
    `UPDATE property_pricing_settings SET tax_percent = $2, service_charge_percent = $3, updated_at = NOW()
     WHERE property_id = $1`,
    [propertyId, taxPercent, servicePercent]
  );
}

// â”€â”€ Setup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const propRes = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', $3, TRUE) RETURNING id`,
      [`TAX ${RUN_ID}`, `T${RUN_ID.slice(0, 4)}${RUN_ID.slice(-1)}`, `Addr TAX ${RUN_ID}`]
    );
    const pidA = propRes.rows[0].id;
    tracked.properties.push(pidA);

    const catRes = await client.query(
      'INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id',
      [pidA, `TAX ${RUN_ID} Cat`]
    );
    tracked.categories.push(catRes.rows[0].id);

    // Item A: 100000 (harga tinggi untuk test tax/service)
    const itemA = await client.query(
      'INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active) VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id',
      [pidA, catRes.rows[0].id, `TAX${RUN_ID}I`, 'Tax Item A', 100000]
    );
    tracked.items.push(itemA.rows[0].id);

    const user = await createPosUser(client, pidA, 'A');

    await client.query('COMMIT');
    return {
      pidA,
      itemA: itemA.rows[0].id,
      userId: user.userId,
      token: tokenFor(user.userId, pidA),
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// â”€â”€ Helper: buat order POS (POST /api/pos/orders) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function createOrder(fx, body, opts = {}) {
  const r = await api('POST', '/api/pos/orders', body, {
    auth: fx.token,
    idempotencyKey: opts.idempotencyKey || undefined,
  });
  if (r.json && r.json.data && r.json.data.id) {
    tracked.orders.push(r.json.data.id);
  }
  if (opts.idempotencyKey && !tracked.idempotencyKeys.includes(opts.idempotencyKey)) {
    tracked.idempotencyKeys.push(opts.idempotencyKey);
  }
  return r;
}

// =============================================================================
// TEST CASES
// =============================================================================

// Kasus 1: tax OFF + service OFF â†’ total_amount = net, tax=0, service=0
async function testCase1_TaxOff_SvcOff(fx) {
  const item = fx.itemA;
  // pricing settings: tax=0%, service=0%
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await createPricingSettings(client, fx.pidA, 0, 0);
    await client.query('COMMIT');
  } finally { client.release(); }

  const r = await createOrder(fx, {
    property_id: fx.pidA,
    items: [{ menu_item_id: item, quantity: 1 }],
    tax_enabled: false,
    service_charge_enabled: false,
  });

  expectEq(r.status, 201, 'Case1: POST order â†’ 201');
  const d = r.json.data;
  expectNum(d.total_amount, 100000, 'Case1: total_amount = 100000 (net)');
  expectEq(d.tax_enabled, false, 'Case1: tax_enabled = false');
  expectNum(d.tax_rate, 0, 'Case1: tax_rate snapshot = 0');
  expectNum(d.tax_amount, 0, 'Case1: tax_amount = 0');
  expectEq(d.service_charge_enabled, false, 'Case1: service_charge_enabled = false');
  expectNum(d.service_charge_rate, 0, 'Case1: service_charge_rate snapshot = 0');
  expectNum(d.service_charge_amount, 0, 'Case1: service_charge_amount = 0');
}

// Kasus 2: tax ON + service OFF
async function testCase2_TaxOn_SvcOff(fx) {
  // pricing: tax=10%, service=0%
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await createPricingSettings(client, fx.pidA, 10, 0);
    await client.query('COMMIT');
  } finally { client.release(); }

  const r = await createOrder(fx, {
    property_id: fx.pidA,
    items: [{ menu_item_id: fx.itemA, quantity: 1 }],
    tax_enabled: true,
    service_charge_enabled: false,
  });

  expectEq(r.status, 201, 'Case2: POST order â†’ 201');
  const d = r.json.data;
  expectEq(d.tax_enabled, true, 'Case2: tax_enabled = true');
  expectNum(d.tax_rate, 10, 'Case2: tax_rate snapshot = 10');
  expectNum(d.tax_amount, 10000, 'Case2: tax_amount = 100000 * 10/100 = 10000');
  expectNum(d.total_amount, 110000, 'Case2: total = 100000 + 10000 = 110000');
  expectNum(d.service_charge_amount, 0, 'Case2: service_charge_amount = 0 (disabled)');
}

// Kasus 3: tax OFF + service ON
async function testCase3_TaxOff_SvcOn(fx) {
  // pricing: tax=10%, service=5%
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await createPricingSettings(client, fx.pidA, 10, 5);
    await client.query('COMMIT');
  } finally { client.release(); }

  const r = await createOrder(fx, {
    property_id: fx.pidA,
    items: [{ menu_item_id: fx.itemA, quantity: 1 }],
    tax_enabled: false,
    service_charge_enabled: true,
  });

  expectEq(r.status, 201, 'Case3: POST order â†’ 201');
  const d = r.json.data;
  expectEq(d.tax_enabled, false, 'Case3: tax_enabled = false');
  expectNum(d.tax_amount, 0, 'Case3: tax_amount = 0 (disabled)');
  expectEq(d.service_charge_enabled, true, 'Case3: service_charge_enabled = true');
  expectNum(d.service_charge_rate, 5, 'Case3: service_charge_rate snapshot = 5');
  expectNum(d.service_charge_amount, 5000, 'Case3: service = 100000 * 5/100 = 5000');
  expectNum(d.total_amount, 105000, 'Case3: total = 100000 + 5000 = 105000');
}

// Kasus 4: tax ON + service ON (formula penuh)
async function testCase4_TaxOn_SvcOn(fx) {
  // pricing: tax=10%, service=5%
  // net = 100000, service = round(100000*5/100) = 5000, tax_base = 105000,
  // tax = round(105000*10/100) = 10500, total = 100000+5000+10500 = 115500
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await createPricingSettings(client, fx.pidA, 10, 5);
    await client.query('COMMIT');
  } finally { client.release(); }

  const r = await createOrder(fx, {
    property_id: fx.pidA,
    items: [{ menu_item_id: fx.itemA, quantity: 1 }],
    tax_enabled: true,
    service_charge_enabled: true,
  });

  expectEq(r.status, 201, 'Case4: POST order â†’ 201');
  const d = r.json.data;
  expectNum(d.service_charge_amount, 5000, 'Case4: service = 100000*5/100 = 5000');
  expectNum(d.tax_amount, 10500, 'Case4: tax = (100000+5000)*10/100 = 10500');
  expectNum(d.total_amount, 115500, 'Case4: total = 100000+5000+10500 = 115500');
  expectEq(d.tax_enabled, true, 'Case4: tax_enabled = true');
  expectEq(d.service_charge_enabled, true, 'Case4: service_charge_enabled = true');
}

// Kasus 5: discount menjadi basis sebelum tax/service
// Order: item A (100000) + order discount NOMINAL 20000, tax=10%, service=5%
// net = 100000 - 20000 = 80000
// service = round(80000*5/100) = 4000
// tax_base = 84000
// tax = round(84000*10/100) = 8400
// total = 80000 + 4000 + 8400 = 92400
async function testCase5_DiscountBasis(fx) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await createPricingSettings(client, fx.pidA, 10, 5);
    await client.query('COMMIT');
  } finally { client.release(); }

  const r = await createOrder(fx, {
    property_id: fx.pidA,
    items: [{ menu_item_id: fx.itemA, quantity: 1 }],
    discount_type: 'NOMINAL',
    discount_value: 20000,
    tax_enabled: true,
    service_charge_enabled: true,
  });

  expectEq(r.status, 201, 'Case5: POST order with discount â†’ 201');
  const d = r.json.data;
  expectNum(d.discount_amount, 20000, 'Case5: discount_amount = 20000');
  expectNum(d.service_charge_amount, 4000, 'Case5: service = 80000*5/100 = 4000');
  expectNum(d.tax_amount, 8400, 'Case5: tax = (80000+4000)*10/100 = 8400');
  expectNum(d.total_amount, 92400, 'Case5: total = 80000+4000+8400 = 92400');
}

// Kasus 6: disabled amount = 0 (rate snapshot ada, tapi toggle off)
// pricing: tax=10%, service=5%, tapi tax_enabled=false, service_charge_enabled=false
async function testCase6_DisabledAmountZero(fx) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await createPricingSettings(client, fx.pidA, 10, 5);
    await client.query('COMMIT');
  } finally { client.release(); }

  const r = await createOrder(fx, {
    property_id: fx.pidA,
    items: [{ menu_item_id: fx.itemA, quantity: 1 }],
    tax_enabled: false,
    service_charge_enabled: false,
  });

  expectEq(r.status, 201, 'Case6: POST order â†’ 201');
  const d = r.json.data;
  expectEq(d.tax_enabled, false, 'Case6: tax_enabled = false');
  expectNum(d.tax_rate, 10, 'Case6: tax_rate snapshot = 10 (configured rate, bukan 0)');
  expectNum(d.tax_amount, 0, 'Case6: tax_amount = 0 (disabled, bukan 10000)');
  expectEq(d.service_charge_enabled, false, 'Case6: service_charge_enabled = false');
  expectNum(d.service_charge_rate, 5, 'Case6: service_charge_rate snapshot = 5');
  expectNum(d.service_charge_amount, 0, 'Case6: service_charge_amount = 0 (disabled)');
  expectNum(d.total_amount, 100000, 'Case6: total = 100000 (net saja)');
}

// Kasus 7: replay memakai snapshot lama setelah property rate berubah
async function testCase7_ReplaySnapshot(fx) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await createPricingSettings(client, fx.pidA, 10, 5);
    await client.query('COMMIT');
  } finally { client.release(); }

  const key = `tax-replay-${RUN_ID}`;
  const body = {
    property_id: fx.pidA,
    items: [{ menu_item_id: fx.itemA, quantity: 1 }],
    tax_enabled: true,
    service_charge_enabled: true,
  };

  // Create pertama
  const r1 = await createOrder(fx, body, { idempotencyKey: key });
  expectEq(r1.status, 201, 'Case7: first create â†’ 201');
  const orderId1 = r1.json.data.id;

  // Ubah pricing settings (rate berubah)
  const client2 = await pool.connect();
  try {
    await client2.query('BEGIN');
    await updatePricingSettings(client2, fx.pidA, 20, 10);
    await client2.query('COMMIT');
  } finally { client2.release(); }

  // Replay dengan key sama
  const r2 = await createOrder(fx, body, { idempotencyKey: key });
  expectEq(r2.status, 200, 'Case7: replay â†’ 200');
  expectEq(r2.json.status, 'REPLAY', 'Case7: status = REPLAY');
  const d = r2.json.data;
  expectEq(d.id, orderId1, 'Case7: replay order ID sama');
  expectNum(d.tax_rate, 10, 'Case7: tax_rate snapshot lama = 10 (bukan 20)');
  expectNum(d.service_charge_rate, 5, 'Case7: service_charge_rate snapshot lama = 5 (bukan 10)');
  expectNum(d.tax_amount, 10500, 'Case7: tax_amount snapshot lama = 10500');
  expectNum(d.total_amount, 115500, 'Case7: total snapshot lama = 115500 (bukan recompute 20%/10%)');

  // Kembalikan pricing settings ke kondisi awal
  const client3 = await pool.connect();
  try {
    await client3.query('BEGIN');
    await updatePricingSettings(client3, fx.pidA, 10, 5);
    await client3.query('COMMIT');
  } finally { client3.release(); }
}

// Kasus 8: same key + toggle berbeda â†’ 409 conflict
async function testCase8_ToggleConflict(fx) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await createPricingSettings(client, fx.pidA, 10, 5);
    await client.query('COMMIT');
  } finally { client.release(); }

  const key = `tax-conflict-${RUN_ID}`;
  const bodyA = {
    property_id: fx.pidA,
    items: [{ menu_item_id: fx.itemA, quantity: 1 }],
    tax_enabled: true,
    service_charge_enabled: false,
  };
  const bodyB = {
    property_id: fx.pidA,
    items: [{ menu_item_id: fx.itemA, quantity: 1 }],
    tax_enabled: false,  // toggle berbeda
    service_charge_enabled: false,
  };

  const r1 = await createOrder(fx, bodyA, { idempotencyKey: key });
  expectEq(r1.status, 201, 'Case8: first create â†’ 201');

  const r2 = await createOrder(fx, bodyB, { idempotencyKey: key });
  expectEq(r2.status, 409, 'Case8: toggle berbeda dengan key sama â†’ 409');
  expectEq(r2.json.code, 'IDEMPOTENCY_KEY_CONFLICT', 'Case8: code = IDEMPOTENCY_KEY_CONFLICT');
}

// Kasus 9: legacy request tanpa tax/service fields â†’ backward compatible
async function testCase9_LegacyBackwardCompat(fx) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await createPricingSettings(client, fx.pidA, 10, 5);
    await client.query('COMMIT');
  } finally { client.release(); }

  const body = {
    property_id: fx.pidA,
    items: [{ menu_item_id: fx.itemA, quantity: 1 }],
    // Tidak ada tax_enabled, tidak ada service_charge_enabled
  };

  const r = await createOrder(fx, body);
  expectEq(r.status, 201, 'Case9: legacy POST â†’ 201');
  const d = r.json.data;
  expectEq(d.tax_enabled, false, 'Case9: tax_enabled default false');
  expectNum(d.tax_amount, 0, 'Case9: tax_amount = 0');
  expectEq(d.service_charge_enabled, false, 'Case9: service_charge_enabled default false');
  expectNum(d.service_charge_amount, 0, 'Case9: service_charge_amount = 0');
  expectNum(d.total_amount, 100000, 'Case9: total = 100000 (legacy, no tax/service)');
}

// Kasus 10: migration marker ordering
// first apply → 'applied', second run → 'already-applied'
// + verifikasi constraint: lama (_rate_range) hilang, baru (_rate_nonneg) ada
async function testCase10_MigrationMarkerOrdering() {
  const r1 = await runPosTaxServiceMigration(pool);
  expect(r1.ok === true, 'Case10: migration first run ok=true');
  expect(
    r1.status === 'applied' || r1.status === 'already-applied',
    `Case10: migration first run status=${r1.status} (applied|already-applied)`
  );
  expect(
    r1.applied === (r1.status === 'applied'),
    `Case10: applied flag konsisten dengan status (${r1.applied} vs ${r1.status})`
  );

  const r2 = await runPosTaxServiceMigration(pool);
  expect(r2.ok === true, 'Case10: migration second run ok=true');
  expect(r2.applied === false, 'Case10: migration second run applied=false');
  expectEq(r2.status, 'already-applied', 'Case10: migration second run status=already-applied');

  // ── Verifikasi constraint di DB setelah migration applied ─────────────
  const client = await pool.connect();
  try {
    // Constraint lama (_rate_range) TIDAK BOLEH ada
    const oldCon = await client.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'pos_orders'::regclass
         AND conname IN ('chk_pos_orders_tax_rate_range','chk_pos_orders_svc_rate_range')`
    );
    expect(
      (oldCon.rowCount ?? 0) === 0,
      `Case10: constraint lama *_rate_range tidak ada (rowCount=${oldCon.rowCount ?? 0})`
    );

    // Constraint baru (_rate_nonneg) HARUS ada
    const newCon = await client.query(
      `SELECT conname, pg_get_expr(c.conbin, c.conrelid) AS predicate
       FROM pg_constraint c
       WHERE c.conrelid = 'pos_orders'::regclass
         AND c.conname IN ('chk_pos_orders_tax_rate_nonneg','chk_pos_orders_svc_rate_nonneg')
         AND c.contype = 'c'
       ORDER BY conname`
    );
    expect(
      (newCon.rowCount ?? 0) === 2,
      `Case10: constraint baru *_rate_nonneg ada tepat 2 (rowCount=${newCon.rowCount ?? 0})`
    );
    const predMap = {};
    for (const row of newCon.rows) {
      predMap[row.conname] = row.predicate;
    }
    // PostgreSQL menyimpan predicate dengan cast & paren: "(tax_rate >= (0)::numeric)"
    // Normalisasi: buang whitespace, paren ekstra, dan cast ::numeric
    const normalize = (s) => String(s).replace(/\s+/g, '').replace(/\(0\)::numeric/g, '0');
    const taxPred = normalize(predMap['chk_pos_orders_tax_rate_nonneg'] || '');
    const svcPred = normalize(predMap['chk_pos_orders_svc_rate_nonneg'] || '');
    expect(
      taxPred.includes('tax_rate>=0') && !taxPred.includes('<='),
      `Case10: predicate tax_rate_nonneg hanya >= 0 (raw=${predMap['chk_pos_orders_tax_rate_nonneg']})`
    );
    expect(
      svcPred.includes('service_charge_rate>=0') && !svcPred.includes('<='),
      `Case10: predicate svc_rate_nonneg hanya >= 0 (raw=${predMap['chk_pos_orders_svc_rate_nonneg']})`
    );
  } finally {
    client.release();
  }
}

// Kasus 11: receipt mengembalikan snapshot tax/service
async function testCase11_ReceiptSnapshot(fx) {
  // Buat order dengan tax ON + service ON
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await createPricingSettings(client, fx.pidA, 10, 5);
    await client.query('COMMIT');
  } finally { client.release(); }

  const body = {
    property_id: fx.pidA,
    items: [{ menu_item_id: fx.itemA, quantity: 1 }],
    tax_enabled: true,
    service_charge_enabled: true,
  };

  const r1 = await createOrder(fx, body);
  expectEq(r1.status, 201, 'Case11: create order → 201');
  const orderId = r1.json.data.id;

  // Buat settlement CASH via API POST /api/pos/orders/:id/pay
  // Handler settlement WAJIB Idempotency-Key.
  const settleKey = `tax-settle-${RUN_ID}`;
  const r2 = await api('POST', `/api/pos/orders/${orderId}/pay`, {
    property_id: fx.pidA,
    payment_method: 'CASH',
    cash_received: 200000,
  }, { auth: fx.token, idempotencyKey: settleKey });

  if (r2.status === 201 || r2.status === 200) {
    console.log(`Case11: settlement created (status=${r2.status})`);
    if (tracked.idempotencyKeys.indexOf(settleKey) === -1) tracked.idempotencyKeys.push(settleKey);
  } else {
    console.error(`Case11 WARNING: settlement status=${r2.status} json=${JSON.stringify(r2.json)}`);
  }

  // Ambil receipt
  const r3 = await api('GET', `/api/pos/orders/${orderId}/receipt?property_id=${fx.pidA}`, null, { auth: fx.token });
  expectEq(r3.status, 200, 'Case11: GET receipt → 200');
  const receipt = r3.json;
  // Response structure: { status: 'SUCCESS', data: { property, order, items, settlement } }
  const data = receipt && receipt.data;
  const orderBlock = data && data.order;

  expect(!!orderBlock, 'Case11: receipt order block exists');
  if (orderBlock) {
    expectEq(orderBlock.tax_enabled, true, 'Case11: receipt tax_enabled = true');
    expectNum(orderBlock.tax_rate, 10, 'Case11: receipt tax_rate = 10');
    expectNum(orderBlock.tax_amount, 10500, 'Case11: receipt tax_amount = 10500');
    expectEq(orderBlock.service_charge_enabled, true, 'Case11: receipt service_charge_enabled = true');
    expectNum(orderBlock.service_charge_rate, 5, 'Case11: receipt service_charge_rate = 5');
    expectNum(orderBlock.service_charge_amount, 5000, 'Case11: receipt service_charge_amount = 5000');
  }
}

// =============================================================================
// Kasus 12: Transaction Domain — POS tax/service projection
// Verifikasi: setelah POS order tax+service dibayar & projected:
//   transactions.amount          = gross items
//   transactions.discount_amount = total discount
//   transactions.service_amount  = snapshot service POS
//   transactions.tax_amount      = snapshot tax POS
//   transactions.net_amount      = pos_orders.total_amount
// Plus jalur UPDATE: nilai salah di transactions di-overwrite oleh re-projection.
// =============================================================================
async function testCase12_TransactionProjection(fx) {
  // pricing: tax=10%, service=5%
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await createPricingSettings(client, fx.pidA, 10, 5);
    await client.query('COMMIT');
  } finally { client.release(); }

  const body = {
    property_id: fx.pidA,
    items: [{ menu_item_id: fx.itemA, quantity: 1 }],
    tax_enabled: true,
    service_charge_enabled: true,
  };

  const r1 = await createOrder(fx, body);
  expectEq(r1.status, 201, 'Case12: create order tax+svc → 201');
  const orderId = r1.json.data.id;
  const orderTaxAmount = Number(r1.json.data.tax_amount);        // 10500
  const orderSvcAmount = Number(r1.json.data.service_charge_amount); // 5000
  const orderTotal     = Number(r1.json.data.total_amount);       // 115500

  // Bayar order → settlement → projection transaksi
  const settleKey = `tax-tx12-${RUN_ID}`;
  const rPay = await api('POST', `/api/pos/orders/${orderId}/pay`, {
    property_id: fx.pidA,
    payment_method: 'CASH',
    cash_received: 200000,
  }, { auth: fx.token, idempotencyKey: settleKey });
  if (rPay.status === 201 || rPay.status === 200) {
    if (tracked.idempotencyKeys.indexOf(settleKey) === -1) tracked.idempotencyKeys.push(settleKey);
  } else {
    console.error(`Case12 WARNING: pay status=${rPay.status} json=${JSON.stringify(rPay.json)}`);
  }

  // Query transactions langsung
  const c = await pool.connect();
  try {
    const txRes = await c.query(
      `SELECT amount, discount_amount, service_amount, tax_amount, net_amount
       FROM transactions
       WHERE property_id = $1
         AND source_type IN ('POS_ORDER','POS')
         AND source_id = $2
         AND reversal_of_transaction_id IS NULL
       LIMIT 1`,
      [fx.pidA, String(orderId)]
    );
    expect((txRes.rowCount ?? 0) === 1, 'Case12: transaksi POS_ORDER ditemukan (rowCount=1)');
    if ((txRes.rowCount ?? 0) > 0) {
      const tx = txRes.rows[0];
      // amount = gross items (100000, item A qty 1)
      expectNum(tx.amount, 100000, 'Case12: transactions.amount = 100000 (gross items)');
      // discount_amount = 0 (tanpa diskon)
      expectNum(tx.discount_amount, 0, 'Case12: transactions.discount_amount = 0');
      // service_amount = snapshot service (5000)
      expectNum(tx.service_amount, orderSvcAmount, 'Case12: transactions.service_amount = ' + orderSvcAmount + ' (snapshot POS)');
      // tax_amount = snapshot tax (10500)
      expectNum(tx.tax_amount, orderTaxAmount, 'Case12: transactions.tax_amount = ' + orderTaxAmount + ' (snapshot POS)');
      // net_amount = pos_orders.total_amount (115500)
      expectNum(tx.net_amount, orderTotal, 'Case12: transactions.net_amount = pos_orders.total_amount = ' + orderTotal);
    }

    // ── Jalur UPDATE: corrupt transaction, re-project, verifikasi overwrite ──
    if ((txRes.rowCount ?? 0) > 0) {
      const txId = (await c.query(
        `SELECT id FROM transactions
         WHERE property_id = $1 AND source_type IN ('POS_ORDER','POS')
           AND source_id = $2 AND reversal_of_transaction_id IS NULL LIMIT 1`,
        [fx.pidA, String(orderId)]
      )).rows[0].id;

      // Corrupt: set nilai tax/service salah
      await c.query(
        `UPDATE transactions SET tax_amount = 99999, service_amount = 88888 WHERE id = $1`,
        [txId]
      );

      // Re-project via projectPosOrderToTransaction (dist)
      const { projectPosOrderToTransaction } = require('../dist/domains/transactions/transactionService');
      const client2 = await pool.connect();
      try {
        const reProj = await projectPosOrderToTransaction(client2, orderId, {
          propertyId: fx.pidA,
          paymentMethod: 'CASH',
        });
        expect(!!reProj, 'Case12b: re-projection mengembalikan transaction row');

        const verify = await client2.query(
          `SELECT tax_amount, service_amount, net_amount, amount FROM transactions WHERE id = $1`,
          [txId]
        );
        const v = verify.rows[0];
        expectNum(v.tax_amount, orderTaxAmount, 'Case12b: re-projection overwrite tax_amount → ' + orderTaxAmount);
        expectNum(v.service_amount, orderSvcAmount, 'Case12b: re-projection overwrite service_amount → ' + orderSvcAmount);
        expectNum(v.net_amount, orderTotal, 'Case12b: re-projection net_amount tetap ' + orderTotal);
        expectNum(v.amount, 100000, 'Case12b: re-projection amount tetap 100000');
      } finally {
        client2.release();
      }
    }
  } finally {
    c.release();
  }
}

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  await verifyDbIdentity();
  server = app.listen(0);
  await new Promise(resolve => server.on('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.log(`[TAX SVC TEST] Server on ${baseUrl}`);

  const fx = await setupFixtures();

  try {
    await testCase10_MigrationMarkerOrdering();
    await testCase1_TaxOff_SvcOff(fx);
    await testCase2_TaxOn_SvcOff(fx);
    await testCase3_TaxOff_SvcOn(fx);
    await testCase4_TaxOn_SvcOn(fx);
    await testCase5_DiscountBasis(fx);
    await testCase6_DisabledAmountZero(fx);
    await testCase7_ReplaySnapshot(fx);
    await testCase8_ToggleConflict(fx);
    await testCase9_LegacyBackwardCompat(fx);
    await testCase11_ReceiptSnapshot(fx);
    await testCase12_TransactionProjection(fx);
  } finally {
    await cleanup();
    if (server) server.close();
  }

  console.log(`\n[TAX SVC TEST] ${passed} PASS, ${failed} FAIL`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[TAX SVC TEST] Fatal:', e);
  process.exit(1);
});
