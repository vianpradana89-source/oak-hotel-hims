/**
 * POS-EDIT-1A — REGRESSION TEST (PUT /api/pos/orders/:id)
 *
 * Scope (wajib):
 *   1.  Edit order OPEN mempertahankan order ID.
 *   2.  Item existing mempertahankan harga snapshot (snapshot ≠ master price).
 *   3.  Retry identik tidak menyebabkan mutasi kedua (version & updated_at tetap).
 *   4.  Replay tetap berhasil setelah order menjadi PAID.
 *   5.  Idempotency key sama + payload berbeda → 409 IDEMPOTENCY_KEY_CONFLICT.
 *   6.  Version conflict → 409 ORDER_VERSION_CONFLICT.
 *   7.  Edit baru terhadap PAID/VOIDED ditolak → 409 ORDER_NOT_OPEN.
 *   8.  Service Charge & PBJT memakai snapshot order lama (bukan setting properti).
 *   9.  PUT tanpa items tidak menghapus item existing (regresi item diff).
 *   10. Property scope berbeda ditolak untuk GET detail dan PUT.
 *
 * Test HANDLER (bukan middleware autentikasi produksi):
 *   - Express lokal 127.0.0.1:port dinamis.
 *   - Middleware test mengisi req.user (actor sintetis + property_id fixture).
 *   - assertPropertyScope adalah adapter test (bandingkan req.user.property_id).
 *   - checkDiscountPermission memakai fungsi PRODUKSI asli
 *     (getUserEffectivePermissions + includes 'pos.discount.edit'), sama
 *     seperti wiring di index.ts — bukan mock.
 *   - Factory handler di-import dari dist/ (hasil build), bukan src.
 *
 * DB SAFETY GUARD (disposable):
 *   TEST_DATABASE_URL eksplisit → 127.0.0.1:15434 / oak_minibar_test /
 *   minibar_test, password wajib, query parameter ditolak.
 *   Tanpa dotenv, tanpa fallback, tanpa mencetak URL/password.
 *
 * Run (dari backend/):
 *   TEST_DATABASE_URL=postgres://minibar_test:PASS@127.0.0.1:15434/oak_minibar_test \
 *     node test/pos_order_edit_regression_test.js
 */
'use strict';

// ─── 1. DB SAFETY GUARD ─────────────────────────────────────────────────────
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error('SAFETY: TEST_DATABASE_URL tidak di-set.');
  process.exit(1);
}

const ALLOWED_HOST = '127.0.0.1', ALLOWED_PORT = 15434;
const ALLOWED_DATABASE = 'oak_minibar_test', ALLOWED_USER = 'minibar_test';

let target;
try {
  const u = new URL(testUrl.trim());
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('protocol wajib postgres');
  if (u.hostname !== ALLOWED_HOST) throw new Error(`host wajib ${ALLOWED_HOST}`);
  if (u.searchParams.size > 0) throw new Error('query parameter ditolak');
  if (!u.port || !/^\d+$/.test(u.port)) throw new Error('port eksplisit wajib');
  const port = Number(u.port);
  if (port !== ALLOWED_PORT) throw new Error(`port wajib ${ALLOWED_PORT}`);
  const user = u.username ? decodeURIComponent(u.username) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';
  const database = u.pathname ? decodeURIComponent(u.pathname.replace(/^\//, '')) : '';
  if (!user) throw new Error('user wajib');
  if (!password) throw new Error('password wajib');
  if (user !== ALLOWED_USER) throw new Error(`user wajib ${ALLOWED_USER}`);
  if (database !== ALLOWED_DATABASE) throw new Error(`database wajib ${ALLOWED_DATABASE}`);
  target = { host: u.hostname, port, user, database, password };
  console.log(`[POS-EDIT-1A] Target: ${database} (user: ${user}, port: ${port})`);
} catch (e) {
  console.error(`SAFETY: TEST_DATABASE_URL tidak valid — ${e.message}`);
  process.exit(1);
}

// ─── 2. Pool eksplisit dari field target (tanpa fallback) ───────────────────
const { Pool } = require('pg');
const pool = new Pool({
  host: target.host,
  port: target.port,
  user: target.user,
  password: target.password,
  database: target.database,
  max: 10,
  connectionTimeoutMillis: 10000,
});

// ─── 3. Verifikasi pool.options + identitas DB ──────────────────────────────
function verifyPoolOptions() {
  const o = pool.options || {};
  for (const [val, field] of [[o.host, 'host'], [o.port, 'port'], [o.user, 'user'], [o.database, 'database']]) {
    if (val !== target[field]) {
      throw new Error(`SAFETY: pool.options.${field}=${JSON.stringify(val)}, expected ${JSON.stringify(target[field])}`);
    }
  }
  console.log('[POS-EDIT-1A] pool.options terverifikasi');
}

async function verifyDatabase() {
  const c = await pool.connect();
  try {
    const r = await c.query('SELECT current_database() AS db, current_user AS usr');
    if (r.rows[0].db !== target.database || r.rows[0].usr !== target.user) {
      throw new Error(`SAFETY: db=${r.rows[0].db} usr=${r.rows[0].usr} tidak cocok dengan target`);
    }
    console.log('[POS-EDIT-1A] Verifikasi DB OK (current_database, current_user)');
  } finally {
    c.release();
  }
}

// ─── 4. Import factory dari dist ────────────────────────────────────────────
const { createPosOrderUpdateHandler } = require('../dist/domains/pos/posOrderUpdateHandler');
if (typeof createPosOrderUpdateHandler !== 'function') {
  throw new Error('SAFETY: createPosOrderUpdateHandler dari dist bukan fungsi');
}
const { createPosOrderDetailHandler } = require('../dist/domains/pos/posOrderDetailHandler');
if (typeof createPosOrderDetailHandler !== 'function') {
  throw new Error('SAFETY: createPosOrderDetailHandler dari dist bukan fungsi');
}
// Permission diskon: fungsi produksi asli (bukan mock).
const { getUserEffectivePermissions } = require('../dist/domains/auth/authService');
if (typeof getUserEffectivePermissions !== 'function') {
  throw new Error('SAFETY: getUserEffectivePermissions dari dist bukan fungsi');
}
console.log('[POS-EDIT-1A] handler + permission fn di-import dari dist');

// ─── 5. Counter + tracked fixture ───────────────────────────────────────────
let passed = 0, failed = 0, blocked = 0;
const failures = [];
const blockedList = [];
const tracked = {
  properties: [],
  posOrders: [],
  posMenuCategories: [],
  posMenuItems: [],
  users: [],
  roles: [],
};

function pass(description) {
  passed++;
  console.log(`  PASS ${description}`);
}
function fail(description, err) {
  failed++;
  const msg = description + (err && err.message ? ` — ${err.message}` : '');
  failures.push(msg);
  console.error(`  FAIL ${msg}`);
}
function check(label, cond, detail) {
  if (cond) pass(label);
  else fail(label + (detail ? ` (${detail})` : ''));
}

/**
 * Skenario yang TIDAK dapat diuji oleh harness ini (bukan PASS, bukan FAIL).
 * Dipakai untuk memenuhi kewajiban pelaporan BLOCKED secara eksplisit —
 * mis. perilaku middleware global produksi yang hanya hidup di index.ts.
 */
function blockedReport(label, reason) {
  blocked++;
  blockedList.push(`${label}: ${reason}`);
  console.log(`  BLOCKED ${label} — ${reason}`);
}

// ─── 6. Fixture helpers ─────────────────────────────────────────────────────
const crypto = require('crypto');

function nextPropertyCode() {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(code)) throw new Error(`SAFETY: property_code tidak valid: ${code}`);
  return code;
}

async function createFixtureProperty(client) {
  const code = nextPropertyCode();
  const r = await client.query(
    `INSERT INTO properties (name, property_code, timezone, currency_code, is_active)
     VALUES ($1, $2, 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`,
    [`POS Edit Reg Prop ${code}`, code]
  );
  const propertyId = Number(r.rows[0].id);
  tracked.properties.push(propertyId);
  return propertyId;
}

async function createFixtureMenuCategory(client, propertyId) {
  const r = await client.query(
    `INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id`,
    [propertyId, `POS Edit Cat ${crypto.randomBytes(3).toString('hex')}`]
  );
  const id = Number(r.rows[0].id);
  tracked.posMenuCategories.push(id);
  return id;
}

async function createFixtureMenuItem(client, propertyId, categoryId, price) {
  const r = await client.query(
    `INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active)
     VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id`,
    [propertyId, categoryId, `EDI-${crypto.randomBytes(3).toString('hex')}`, 'Edit Test Item', price]
  );
  const id = Number(r.rows[0].id);
  tracked.posMenuItems.push(id);
  return id;
}

/**
 * Role fixture (system-level: property_id NULL) + user fixture, agar
 * checkDiscountPermission memakai getUserEffectivePermissions PRODUKSI asli
 * dan benar-benar mengembalikan 'pos.discount.edit' untuk actor sintetis.
 */
async function createFixtureRole(client) {
  const r = await client.query(
    `INSERT INTO roles (name, description, property_id, is_system_role, is_active)
     VALUES ($1, 'POS edit regression role', NULL, FALSE, TRUE) RETURNING id`,
    [`POS Edit Role ${crypto.randomBytes(3).toString('hex')}`]
  );
  const id = Number(r.rows[0].id);
  tracked.roles.push(id);
  return id;
}

/** Grant 'pos.discount.edit' ke role. Return false bila permission tak ada di DB. */
async function grantDiscountPermission(client, roleId) {
  const p = await client.query(`SELECT id FROM permissions WHERE key = 'pos.discount.edit' LIMIT 1`);
  if ((p.rowCount ?? 0) === 0) return false;
  await client.query(
    `INSERT INTO role_permissions (role_id, permission_id, granted) VALUES ($1, $2, TRUE)`,
    [roleId, Number(p.rows[0].id)]
  );
  return true;
}

async function createFixtureUser(client, propertyId, roleId) {
  const tag = crypto.randomBytes(4).toString('hex');
  const r = await client.query(
    `INSERT INTO users (property_id, role_id, username, email, full_name, is_active, account_status)
     VALUES ($1, $2, $3, $4, $5, TRUE, 'READY') RETURNING id`,
    [propertyId, roleId, `pos_edit_${tag}`, `pos_edit_${tag}@example.test`, 'POS Edit Actor']
  );
  const id = Number(r.rows[0].id);
  tracked.users.push(id);
  return id;
}

/**
 * Buat POS order fixture (standalone) + item.
 *   opts.status, opts.svc {enabled,pct}, opts.tax {enabled,pct}
 *   opts.items: [{ menuItemId, quantity, unitPrice, name }]
 * total_amount awal = Σ(qty×unitPrice)  (handler akan hitung ulang saat edit).
 */
async function createFixtureOrder(client, propertyId, opts = {}) {
  const { status = 'OPEN', svc = { enabled: false, pct: 0 }, tax = { enabled: false, pct: 0 }, items = [] } = opts;
  const orderNumber = `POE-${crypto.randomUUID()}`;
  if (orderNumber.length > 50) throw new Error(`SAFETY: order_number > 50 char`);
  const gross = items.reduce((s, it) => s + Number(it.quantity) * Number(it.unitPrice), 0);
  const r = await client.query(
    `INSERT INTO pos_orders (
       property_id, order_number, table_number, guest_name, status, total_amount,
       service_charge_percent_snapshot, tax_percent_snapshot,
       service_charge_enabled_snapshot, tax_enabled_snapshot,
       service_amount, tax_amount, version
     ) VALUES ($1, $2, 'T-01', 'Edit Guest', $3, $4, $5, $6, $7, $8, 0, 0, 1)
     RETURNING id`,
    [propertyId, orderNumber, status, gross, svc.pct, tax.pct, svc.enabled, tax.enabled]
  );
  const orderId = Number(r.rows[0].id);
  tracked.posOrders.push(orderId);

  const itemRows = [];
  for (const it of items) {
    const ir = await client.query(
      `INSERT INTO pos_order_items (
         order_id, menu_item_id, quantity, unit_price, notes,
         item_name_snapshot, item_code_snapshot
       ) VALUES ($1, $2, $3, $4, NULL, $5, NULL) RETURNING id`,
      [orderId, it.menuItemId, Number(it.quantity), Number(it.unitPrice), it.name || 'Edit Test Item']
    );
    itemRows.push(Number(ir.rows[0].id));
  }
  return { orderId, orderNumber, itemIds: itemRows };
}

async function setPricing(client, propertyId, { svcOn, svcPct, taxOn, taxPct }) {
  await client.query(
    `INSERT INTO property_pos_pricing_settings
       (property_id, service_charge_enabled, service_charge_percent, tax_enabled, tax_percent, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (property_id) DO UPDATE
       SET service_charge_enabled = $2, service_charge_percent = $3,
           tax_enabled = $4, tax_percent = $5, updated_at = NOW()`,
    [propertyId, svcOn, svcPct, taxOn, taxPct]
  );
}

// ─── 7. DB read helpers ─────────────────────────────────────────────────────
async function readOrder(orderId) {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT id, status, version, total_amount, service_amount, tax_amount, updated_at,
              table_number, guest_name, guest_phone, notes, discount_reason,
              service_charge_percent_snapshot, tax_percent_snapshot,
              service_charge_enabled_snapshot, tax_enabled_snapshot
       FROM pos_orders WHERE id = $1`,
      [orderId]
    );
    return r.rows[0] || null;
  } finally { c.release(); }
}

async function readItems(orderId) {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT id, menu_item_id, quantity, unit_price,
              discount_type, discount_value, discount_amount,
              item_name_snapshot, item_code_snapshot
       FROM pos_order_items WHERE order_id = $1 ORDER BY id ASC`,
      [orderId]
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      menu_item_id: Number(x.menu_item_id),
      quantity: Number(x.quantity),
      unit_price: Number(x.unit_price),
      discount_type: x.discount_type,
      discount_value: x.discount_value == null ? null : Number(x.discount_value),
      discount_amount: x.discount_amount == null ? null : Number(x.discount_amount),
      item_name_snapshot: x.item_name_snapshot,
      item_code_snapshot: x.item_code_snapshot,
    }));
  } finally { c.release(); }
}

async function readMenuItem(menuItemId) {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT id, name, item_code, price FROM pos_menu_items WHERE id = $1`,
      [menuItemId]
    );
    return r.rows[0] || null;
  } finally { c.release(); }
}

async function readEditRequest(propertyId, orderId, key) {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT request_fingerprint, resulting_version, resulting_total
       FROM pos_order_edit_requests
       WHERE property_id = $1 AND pos_order_id = $2 AND idempotency_key = $3`,
      [propertyId, orderId, key]
    );
    return r.rows[0] || null;
  } finally { c.release(); }
}

async function countEditRequests(propertyId, orderId, key) {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT COUNT(*)::int AS n FROM pos_order_edit_requests
       WHERE property_id = $1 AND pos_order_id = $2 AND idempotency_key = $3`,
      [propertyId, orderId, key]
    );
    return Number(r.rows[0].n);
  } finally { c.release(); }
}

async function setOrderStatus(orderId, status) {
  const c = await pool.connect();
  try {
    await c.query(`UPDATE pos_orders SET status = $1 WHERE id = $2`, [status, orderId]);
  } finally { c.release(); }
}

// ─── 8. HTTP helpers ────────────────────────────────────────────────────────
function putOrder(baseUrl, orderId, body) {
  return fetch(`${baseUrl}/api/pos/orders/${orderId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}

function getDetail(baseUrl, orderId, propertyId) {
  return fetch(`${baseUrl}/api/pos/orders/${orderId}/detail?property_id=${propertyId}`, {
    method: 'GET',
    signal: AbortSignal.timeout(15000),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}

// ─── 9. Fixture cleanup + residue ───────────────────────────────────────────
async function cleanupFixtures(client) {
  await client.query('BEGIN');
  try {
    if (tracked.properties.length) {
      await client.query(`DELETE FROM pos_order_edit_requests WHERE property_id = ANY($1)`, [tracked.properties]);
      await client.query(
        `DELETE FROM pos_order_items WHERE order_id IN (SELECT id FROM pos_orders WHERE property_id = ANY($1))`,
        [tracked.properties]
      );
      await client.query(`DELETE FROM pos_orders WHERE property_id = ANY($1)`, [tracked.properties]);
      await client.query(`DELETE FROM property_pos_pricing_settings WHERE property_id = ANY($1)`, [tracked.properties]);
      await client.query(`DELETE FROM pos_menu_items WHERE property_id = ANY($1)`, [tracked.properties]);
      await client.query(`DELETE FROM pos_menu_categories WHERE property_id = ANY($1)`, [tracked.properties]);
    }
    // User/role fixtures: hapus sebelum roles & properties (FK).
    if (tracked.roles.length) {
      await client.query(`DELETE FROM role_permissions WHERE role_id = ANY($1)`, [tracked.roles]);
    }
    if (tracked.users.length) {
      await client.query(`DELETE FROM users WHERE id = ANY($1)`, [tracked.users]);
    }
    if (tracked.roles.length) {
      await client.query(`DELETE FROM roles WHERE id = ANY($1)`, [tracked.roles]);
    }
    if (tracked.properties.length) {
      await client.query(`DELETE FROM properties WHERE id = ANY($1)`, [tracked.properties]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

async function verifyNoResidue(client) {
  const residue = [];
  const checks = [
    ['pos_order_edit_requests', 'property_id', tracked.properties],
    ['pos_orders', 'property_id', tracked.properties],
    ['pos_menu_items', 'property_id', tracked.properties],
    ['pos_menu_categories', 'property_id', tracked.properties],
    ['property_pos_pricing_settings', 'property_id', tracked.properties],
    ['users', 'id', tracked.users],
    ['role_permissions', 'role_id', tracked.roles],
    ['roles', 'id', tracked.roles],
    ['properties', 'id', tracked.properties],
  ];
  for (const [table, col, param] of checks) {
    if (!param || param.length === 0) continue;
    const r = await client.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${col} = ANY($1)`, [param]);
    if (Number(r.rows[0].n) > 0) residue.push(`${table}: ${r.rows[0].n} row(s) remain`);
  }
  return residue;
}

// ─── 10. Main ───────────────────────────────────────────────────────────────
async function main() {
  let httpServer = null;
  let identityVerified = false;
  let setupClient = null;

  try {
    verifyPoolOptions();
    await verifyDatabase();
    identityVerified = true;

    // ── Fixture setup ──
    setupClient = await pool.connect();
    const propertyA = await createFixtureProperty(setupClient);
    const propertyB = await createFixtureProperty(setupClient);
    const catA = await createFixtureMenuCategory(setupClient, propertyA);
    const menuA = await createFixtureMenuItem(setupClient, propertyA, catA, 100000); // master price 100000

    // oA: OPEN, 1 item snapshot unit_price = 50000 (≠ master 100000), tanpa svc/tax.
    const oA = await createFixtureOrder(setupClient, propertyA, {
      items: [{ menuItemId: menuA, quantity: 1, unitPrice: 50000 }],
    });
    // oPaid: OPEN, 1 item snapshot 50000.
    const oPaid = await createFixtureOrder(setupClient, propertyA, {
      items: [{ menuItemId: menuA, quantity: 1, unitPrice: 50000 }],
    });
    // oVoid: OPEN.
    const oVoid = await createFixtureOrder(setupClient, propertyA, {
      items: [{ menuItemId: menuA, quantity: 1, unitPrice: 50000 }],
    });
    // oB: milik property B (untuk uji cross-property DB-level).
    const catB = await createFixtureMenuCategory(setupClient, propertyB);
    const menuB = await createFixtureMenuItem(setupClient, propertyB, catB, 100000);
    const oB = await createFixtureOrder(setupClient, propertyB, {
      items: [{ menuItemId: menuB, quantity: 1, unitPrice: 50000 }],
    });
    // oSvc: OPEN, snapshot svc 10% ON + tax 11% ON.
    const oSvc = await createFixtureOrder(setupClient, propertyA, {
      svc: { enabled: true, pct: 10 }, tax: { enabled: true, pct: 11 },
      items: [{ menuItemId: menuA, quantity: 1, unitPrice: 50000 }],
    });
    // oNoItems: OPEN, 2 item.
    const oNoItems = await createFixtureOrder(setupClient, propertyA, {
      items: [
        { menuItemId: menuA, quantity: 1, unitPrice: 50000 },
        { menuItemId: menuA, quantity: 2, unitPrice: 25000 },
      ],
    });

    // Setting properti awal: keduanya OFF (untuk membuktikan snapshot menang di S8).
    await setPricing(setupClient, propertyA, { svcOn: false, svcPct: 0, taxOn: false, taxPct: 0 });

    // Fixture role + user (actor) agar getUserEffectivePermissions produksi
    // benar-benar mengembalikan 'pos.discount.edit' untuk actor sintetis.
    const roleA = await createFixtureRole(setupClient);
    const discountGranted = await grantDiscountPermission(setupClient, roleA);
    const actorUserId = await createFixtureUser(setupClient, propertyA, roleA);

    pass('fixture: 2 property, menu, 6 order, setting pricing, role+user dibuat');

    // ── Express lokal + auth sintetis ──
    const express = require('express');
    const app = express();
    app.use(express.json());

    const actor = { id: actorUserId, username: 'edit_actor', full_name: 'Edit Actor', property_id: propertyA };
    app.use((req, _res, next) => {
      req.user = { id: actor.id, username: actor.username, full_name: actor.full_name, property_id: actor.property_id };
      next();
    });

    const assertPropertyScope = async (req, reqPropertyId) => {
      const userPropertyId = Number(req.user?.property_id);
      if (!Number.isInteger(userPropertyId) || userPropertyId <= 0) {
        throw Object.assign(new Error('actor property_id tidak valid'), { statusCode: 403, code: 'PROPERTY_SCOPE_INVALID' });
      }
      if (userPropertyId !== Number(reqPropertyId)) {
        throw Object.assign(new Error('actor tidak memiliki akses ke properti ini'), { statusCode: 403, code: 'PROPERTY_SCOPE_REQUIRED' });
      }
    };

    // Wiring permission diskon SAMA seperti index.ts (fungsi produksi asli).
    const checkDiscountPermission = async (poolArg, userId, propertyId) => {
      try {
        const permKeys = await getUserEffectivePermissions(poolArg, userId);
        return permKeys.includes('pos.discount.edit');
      } catch {
        return false;
      }
    };

    app.put('/api/pos/orders/:id', createPosOrderUpdateHandler({
      pool,
      connect: () => pool.connect(),
      release: (client, discard) => { if (discard) client.release(true); else client.release(); },
      assertPropertyScope,
      checkDiscountPermission,
    }));
    app.get('/api/pos/orders/:id/detail', createPosOrderDetailHandler({
      pool,
      connect: () => pool.connect(),
      release: (client) => client.release(),
      assertPropertyScope,
    }));

    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      httpServer.on('listening', resolve);
      httpServer.on('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
    pass(`Express listening ${baseUrl}`);

    // ── Payload builder deterministik (fingerprint stabil untuk replay) ──
    const mkBody = (extra) => ({ property_id: propertyA, ...extra });

    // ══ S1 + S2: edit OPEN — ID tetap & harga snapshot dipertahankan ══
    console.log('\n=== S1/S2: edit OPEN — ID tetap, harga snapshot ===');
    const k1 = `editreg-k1-${crypto.randomUUID()}`;
    const beforeS1 = await readOrder(oA.orderId);
    const rS1 = await putOrder(baseUrl, oA.orderId, mkBody({
      expected_version: Number(beforeS1.version),
      idempotency_key: k1,
      items: [{ id: oA.itemIds[0], menu_item_id: menuA, quantity: 2 }],
    }));
    check('S1: PUT edit → 200', rS1.status === 200, `got ${rS1.status} code=${rS1.json?.code}`);
    check('S1: order ID dipertahankan', Number(rS1.json?.data?.order?.id) === oA.orderId,
      `got ${rS1.json?.data?.order?.id}`);
    check('S1: version naik 1→2', Number(rS1.json?.data?.order?.version) === 2,
      `got ${rS1.json?.data?.order?.version}`);
    check('S1: replayed=false', rS1.json?.data?.replayed === false);

    const itemsS2 = await readItems(oA.orderId);
    check('S2: item existing tetap ada (1 baris)', itemsS2.length === 1, `got ${itemsS2.length}`);
    check('S2: unit_price snapshot 50000 (≠ master 100000)', itemsS2[0]?.unit_price === 50000,
      `got ${itemsS2[0]?.unit_price}`);
    check('S2: quantity berubah ke 2', itemsS2[0]?.quantity === 2, `got ${itemsS2[0]?.quantity}`);
    const afterS1 = await readOrder(oA.orderId);
    check('S2: total = 2×50000 = 100000 (bukan harga master)', Number(afterS1.total_amount) === 100000,
      `got ${afterS1.total_amount}`);

    // ══ S3: retry identik — tanpa mutasi kedua ══
    console.log('\n=== S3: retry identik → tanpa mutasi kedua ===');
    const rS3 = await putOrder(baseUrl, oA.orderId, mkBody({
      expected_version: Number(beforeS1.version),
      idempotency_key: k1,
      items: [{ id: oA.itemIds[0], menu_item_id: menuA, quantity: 2 }],
    }));
    check('S3: replay → 200', rS3.status === 200, `got ${rS3.status} code=${rS3.json?.code}`);
    check('S3: replayed=true', rS3.json?.data?.replayed === true);
    const afterS3 = await readOrder(oA.orderId);
    check('S3: version TIDAK berubah (tetap 2)', Number(afterS3.version) === 2, `got ${afterS3.version}`);
    check('S3: updated_at TIDAK berubah',
      new Date(afterS3.updated_at).toISOString() === new Date(afterS1.updated_at).toISOString());
    check('S3: total TIDAK berubah', Number(afterS3.total_amount) === Number(afterS1.total_amount));
    check('S3: hanya 1 record idempotency untuk key', (await countEditRequests(propertyA, oA.orderId, k1)) === 1);

    // ══ S5: key sama + payload berbeda → 409 ══
    console.log('\n=== S5: key sama + payload berbeda → 409 ===');
    const rS5 = await putOrder(baseUrl, oA.orderId, mkBody({
      expected_version: Number(beforeS1.version),
      idempotency_key: k1,
      items: [{ id: oA.itemIds[0], menu_item_id: menuA, quantity: 3 }],
    }));
    check('S5: → 409', rS5.status === 409, `got ${rS5.status}`);
    check('S5: code=IDEMPOTENCY_KEY_CONFLICT', rS5.json?.code === 'IDEMPOTENCY_KEY_CONFLICT', `got ${rS5.json?.code}`);
    const afterS5 = await readOrder(oA.orderId);
    check('S5: version tetap 2 (tanpa mutasi)', Number(afterS5.version) === 2, `got ${afterS5.version}`);

    // ══ S6: version conflict → 409 ══
    console.log('\n=== S6: version conflict → 409 ===');
    const rS6 = await putOrder(baseUrl, oA.orderId, mkBody({
      expected_version: 1, // stale (aktual 2)
      idempotency_key: `editreg-k6-${crypto.randomUUID()}`,
      items: [{ id: oA.itemIds[0], menu_item_id: menuA, quantity: 1 }],
    }));
    check('S6: → 409', rS6.status === 409, `got ${rS6.status}`);
    check('S6: code=ORDER_VERSION_CONFLICT', rS6.json?.code === 'ORDER_VERSION_CONFLICT', `got ${rS6.json?.code}`);

    // ══ S4: replay tetap berhasil setelah order PAID ══
    console.log('\n=== S4: replay sukses setelah order PAID ===');
    const k4 = `editreg-k4-${crypto.randomUUID()}`;
    const rS4a = await putOrder(baseUrl, oPaid.orderId, mkBody({
      expected_version: 1,
      idempotency_key: k4,
      items: [{ id: oPaid.itemIds[0], menu_item_id: menuA, quantity: 2 }],
    }));
    check('S4: edit pertama → 200', rS4a.status === 200, `got ${rS4a.status} code=${rS4a.json?.code}`);
    await setOrderStatus(oPaid.orderId, 'PAID');
    const rS4b = await putOrder(baseUrl, oPaid.orderId, mkBody({
      expected_version: 1, // nilai historis — replay tidak boleh peduli version/status
      idempotency_key: k4,
      items: [{ id: oPaid.itemIds[0], menu_item_id: menuA, quantity: 2 }],
    }));
    check('S4: replay setelah PAID → 200', rS4b.status === 200, `got ${rS4b.status} code=${rS4b.json?.code}`);
    check('S4: replayed=true', rS4b.json?.data?.replayed === true);
    check('S4: hasil historis version=2', Number(rS4b.json?.data?.order?.version) === 2,
      `got ${rS4b.json?.data?.order?.version}`);
    const paidRow = await readOrder(oPaid.orderId);
    check('S4: status order tetap PAID (replay tidak mengubah status)', String(paidRow.status).toUpperCase() === 'PAID',
      `got ${paidRow.status}`);

    // ══ S7: edit BARU terhadap PAID/VOIDED → 409 ORDER_NOT_OPEN ══
    console.log('\n=== S7: edit baru PAID/VOIDED ditolak ===');
    const rS7paid = await putOrder(baseUrl, oPaid.orderId, mkBody({
      expected_version: 2,
      idempotency_key: `editreg-k7a-${crypto.randomUUID()}`,
      items: [{ id: oPaid.itemIds[0], menu_item_id: menuA, quantity: 1 }],
    }));
    check('S7: PAID + key baru → 409', rS7paid.status === 409, `got ${rS7paid.status}`);
    check('S7: code=ORDER_NOT_OPEN (PAID)', rS7paid.json?.code === 'ORDER_NOT_OPEN', `got ${rS7paid.json?.code}`);

    await setOrderStatus(oVoid.orderId, 'VOIDED');
    const rS7void = await putOrder(baseUrl, oVoid.orderId, mkBody({
      expected_version: 1,
      idempotency_key: `editreg-k7b-${crypto.randomUUID()}`,
      items: [{ id: oVoid.itemIds[0], menu_item_id: menuA, quantity: 1 }],
    }));
    check('S7: VOIDED + key baru → 409', rS7void.status === 409, `got ${rS7void.status}`);
    check('S7: code=ORDER_NOT_OPEN (VOIDED)', rS7void.json?.code === 'ORDER_NOT_OPEN', `got ${rS7void.json?.code}`);

    // ══ S8: Service Charge & PBJT pakai snapshot order lama ══
    console.log('\n=== S8: svc/PBJT pakai snapshot order lama ===');
    // Ubah setting properti jauh berbeda (svc OFF, tax 50%) — harus DIABAIKAN.
    await setPricing(setupClient, propertyA, { svcOn: false, svcPct: 0, taxOn: true, taxPct: 50 });
    const rS8 = await putOrder(baseUrl, oSvc.orderId, mkBody({
      expected_version: 1,
      idempotency_key: `editreg-k8-${crypto.randomUUID()}`,
      items: [{ id: oSvc.itemIds[0], menu_item_id: menuA, quantity: 2 }],
    }));
    check('S8: edit → 200', rS8.status === 200, `got ${rS8.status} code=${rS8.json?.code}`);
    const svcRow = await readOrder(oSvc.orderId);
    // 2×50000=100000 ; svc 10% = 10000 ; tax 11% of 110000 = 12100 ; total 122100
    check('S8: service_amount=10000 (snapshot 10%, bukan setting baru)', Number(svcRow.service_amount) === 10000,
      `got ${svcRow.service_amount}`);
    check('S8: tax_amount=12100 (snapshot 11%, bukan 50%)', Number(svcRow.tax_amount) === 12100,
      `got ${svcRow.tax_amount}`);
    check('S8: total=122100', Number(svcRow.total_amount) === 122100, `got ${svcRow.total_amount}`);
    check('S8: snapshot flag/percent TIDAK tertimpa',
      svcRow.service_charge_enabled_snapshot === true && svcRow.tax_enabled_snapshot === true &&
      Number(svcRow.service_charge_percent_snapshot) === 10 && Number(svcRow.tax_percent_snapshot) === 11,
      `svc=${svcRow.service_charge_enabled_snapshot}/${svcRow.service_charge_percent_snapshot} tax=${svcRow.tax_enabled_snapshot}/${svcRow.tax_percent_snapshot}`);

    // ══ S9: PUT tanpa items tidak menghapus item existing ══
    console.log('\n=== S9: PUT tanpa items — item existing dipertahankan ===');
    const beforeS9 = await readItems(oNoItems.orderId);
    const rS9 = await putOrder(baseUrl, oNoItems.orderId, mkBody({
      expected_version: 1,
      idempotency_key: `editreg-k9-${crypto.randomUUID()}`,
      notes: 'catatan order diubah tanpa menyentuh item',
    }));
    check('S9: PUT tanpa items → 200', rS9.status === 200, `got ${rS9.status} code=${rS9.json?.code}`);
    const afterS9 = await readItems(oNoItems.orderId);
    check('S9: jumlah item tetap 2', afterS9.length === 2, `got ${afterS9.length}`);
    check('S9: ID item existing tetap sama',
      afterS9.map((x) => x.id).join(',') === beforeS9.map((x) => x.id).join(','),
      `${afterS9.map((x) => x.id)} vs ${beforeS9.map((x) => x.id)}`);
    check('S9: unit_price item tetap sama',
      afterS9.map((x) => x.unit_price).join(',') === beforeS9.map((x) => x.unit_price).join(','),
      `${afterS9.map((x) => x.unit_price)} vs ${beforeS9.map((x) => x.unit_price)}`);
    const s9Order = await readOrder(oNoItems.orderId);
    check('S9: version naik 1→2 (bukan no-op)', Number(s9Order.version) === 2, `got ${s9Order.version}`);

    // ══ S10: property scope berbeda ditolak (GET + PUT) ══
    console.log('\n=== S10: property scope berbeda ditolak ===');
    // (a) actor A minta property B → assertPropertyScope 403
    const rGetScope = await getDetail(baseUrl, oA.orderId, propertyB);
    check('S10: GET detail property lain → 403', rGetScope.status === 403, `got ${rGetScope.status}`);
    const rPutScope = await putOrder(baseUrl, oA.orderId, mkBody({
      property_id: propertyB,
      expected_version: 1,
      idempotency_key: `editreg-k10-${crypto.randomUUID()}`,
      items: [{ id: oA.itemIds[0], menu_item_id: menuA, quantity: 1 }],
    }));
    check('S10: PUT property lain → 403', rPutScope.status === 403, `got ${rPutScope.status}`);

    // (b) actor A minta property A, namun order milik property B → CROSS_PROPERTY_ORDER
    const rPutCross = await putOrder(baseUrl, oB.orderId, mkBody({
      expected_version: 1,
      idempotency_key: `editreg-k10b-${crypto.randomUUID()}`,
      items: [{ id: oB.itemIds[0], menu_item_id: menuB, quantity: 1 }],
    }));
    check('S10: PUT order milik property lain → 403', rPutCross.status === 403, `got ${rPutCross.status}`);
    check('S10: code=CROSS_PROPERTY_ORDER', rPutCross.json?.code === 'CROSS_PROPERTY_ORDER', `got ${rPutCross.json?.code}`);
    const rGetCross = await getDetail(baseUrl, oB.orderId, propertyA);
    check('S10: GET detail order milik property lain → 403', rGetCross.status === 403, `got ${rGetCross.status}`);

    // ══ S11: GET detail mengembalikan items[].id (kontrak identitas) ══
    console.log('\n=== S11: GET detail items[].id tersedia ===');
    const rDetail = await getDetail(baseUrl, oA.orderId, propertyA);
    check('S11: GET detail → 200', rDetail.status === 200, `got ${rDetail.status}`);
    check('S11: items[].id tersedia untuk edit',
      Array.isArray(rDetail.json?.data?.items) && rDetail.json.data.items.every((it) => Number.isInteger(Number(it.id))),
      JSON.stringify(rDetail.json?.data?.items?.[0]));

    // ══ S12: tambah item baru — snapshot identitas + harga dari DB ══
    console.log('\n=== S12: tambah item baru — snapshot & harga dari DB ===');
    const menuArow = await readMenuItem(menuA);
    const oNew = await createFixtureOrder(setupClient, propertyA, {
      items: [{ menuItemId: menuA, quantity: 1, unitPrice: 50000 }],
    });
    const rS12 = await putOrder(baseUrl, oNew.orderId, mkBody({
      expected_version: 1,
      idempotency_key: `editreg-k12-${crypto.randomUUID()}`,
      items: [
        { id: oNew.itemIds[0], menu_item_id: menuA, quantity: 1 },
        { menu_item_id: menuA, quantity: 2 }, // item baru (tanpa id)
      ],
    }));
    check('S12: tambah item baru → 200', rS12.status === 200, `got ${rS12.status} code=${rS12.json?.code}`);
    check('S12: order ID tetap', Number(rS12.json?.data?.order?.id) === oNew.orderId,
      `got ${rS12.json?.data?.order?.id}`);
    const itemsS12 = await readItems(oNew.orderId);
    check('S12: jumlah item jadi 2', itemsS12.length === 2, `got ${itemsS12.length}`);
    const newItemS12 = itemsS12.find((x) => x.id !== oNew.itemIds[0]);
    check('S12: item_name_snapshot dari DB (bukan payload)',
      newItemS12?.item_name_snapshot === menuArow.name, `got ${newItemS12?.item_name_snapshot} want ${menuArow.name}`);
    check('S12: item_code_snapshot dari DB',
      newItemS12?.item_code_snapshot === menuArow.item_code, `got ${newItemS12?.item_code_snapshot} want ${menuArow.item_code}`);
    check('S12: unit_price item baru = harga menu DB (100000)',
      newItemS12?.unit_price === Number(menuArow.price), `got ${newItemS12?.unit_price} want ${menuArow.price}`);
    const oNewRow = await readOrder(oNew.orderId);
    check('S12: total = 1×50000 + 2×harga master',
      Number(oNewRow.total_amount) === 50000 + 2 * Number(menuArow.price), `got ${oNewRow.total_amount}`);
    const dS12 = await getDetail(baseUrl, oNew.orderId, propertyA);
    check('S12: GET detail mengembalikan 2 item dengan id integer',
      Array.isArray(dS12.json?.data?.items) && dS12.json.data.items.length === 2 &&
      dS12.json.data.items.every((it) => Number.isInteger(Number(it.id))));
    const newItemIdFromDetail = Number(
      (dS12.json?.data?.items || []).find((it) => Number(it.id) === newItemS12.id)?.id
    );
    const rS12b = await putOrder(baseUrl, oNew.orderId, mkBody({
      expected_version: Number(oNewRow.version),
      idempotency_key: `editreg-k12b-${crypto.randomUUID()}`,
      items: [
        { id: oNew.itemIds[0], menu_item_id: menuA, quantity: 1 },
        { id: newItemIdFromDetail, menu_item_id: menuA, quantity: 3 },
      ],
    }));
    check('S12: edit lanjutan pakai items[].id item baru → 200', rS12b.status === 200,
      `got ${rS12b.status} code=${rS12b.json?.code}`);

    // ══ S13/S14/S15: diskon item (butuh permission produksi) ══
    if (discountGranted) {
      // S13: PERCENT + perubahan quantity
      console.log('\n=== S13: item PERCENT discount + perubahan quantity ===');
      const oPct = await createFixtureOrder(setupClient, propertyA, {
        svc: { enabled: true, pct: 10 }, tax: { enabled: true, pct: 11 },
        items: [{ menuItemId: menuA, quantity: 1, unitPrice: 50000 }],
      });
      const rS13 = await putOrder(baseUrl, oPct.orderId, mkBody({
        expected_version: 1,
        idempotency_key: `editreg-k13-${crypto.randomUUID()}`,
        items: [{ id: oPct.itemIds[0], menu_item_id: menuA, quantity: 2, discount_type: 'PERCENT', discount_value: 10 }],
      }));
      check('S13: PERCENT qty 2 → 200', rS13.status === 200, `got ${rS13.status} code=${rS13.json?.code}`);
      const itemsS13 = await readItems(oPct.orderId);
      check('S13: discount_amount = round(100000×10%) = 10000',
        Number(itemsS13[0]?.discount_amount) === 10000, `got ${itemsS13[0]?.discount_amount}`);
      const oPctRow = await readOrder(oPct.orderId);
      check('S13: service_amount = 9000 (10% × 90000)', Number(oPctRow.service_amount) === 9000, `got ${oPctRow.service_amount}`);
      check('S13: tax_amount = 10890 (11% × 99000)', Number(oPctRow.tax_amount) === 10890, `got ${oPctRow.tax_amount}`);
      check('S13: total = 109890', Number(oPctRow.total_amount) === 109890, `got ${oPctRow.total_amount}`);

      // S14: NOMINAL + perubahan quantity
      console.log('\n=== S14: item NOMINAL discount + perubahan quantity ===');
      const oNom = await createFixtureOrder(setupClient, propertyA, {
        svc: { enabled: true, pct: 10 }, tax: { enabled: true, pct: 11 },
        items: [{ menuItemId: menuA, quantity: 1, unitPrice: 50000 }],
      });
      const rS14 = await putOrder(baseUrl, oNom.orderId, mkBody({
        expected_version: 1,
        idempotency_key: `editreg-k14-${crypto.randomUUID()}`,
        items: [{ id: oNom.itemIds[0], menu_item_id: menuA, quantity: 3, discount_type: 'NOMINAL', discount_value: 25000 }],
      }));
      check('S14: NOMINAL qty 3 → 200', rS14.status === 200, `got ${rS14.status} code=${rS14.json?.code}`);
      const itemsS14 = await readItems(oNom.orderId);
      check('S14: discount_amount = 25000', Number(itemsS14[0]?.discount_amount) === 25000, `got ${itemsS14[0]?.discount_amount}`);
      const oNomRow = await readOrder(oNom.orderId);
      check('S14: service_amount = 12500 (10% × 125000)', Number(oNomRow.service_amount) === 12500, `got ${oNomRow.service_amount}`);
      check('S14: tax_amount = 15125 (11% × 137500)', Number(oNomRow.tax_amount) === 15125, `got ${oNomRow.tax_amount}`);
      check('S14: total = 152625', Number(oNomRow.total_amount) === 152625, `got ${oNomRow.total_amount}`);

      // S15: NOMINAL melebihi gross → tolak tanpa perubahan parsial
      console.log('\n=== S15: NOMINAL melebihi gross → tolak tanpa partial ===');
      const oEx = await createFixtureOrder(setupClient, propertyA, {
        svc: { enabled: true, pct: 10 }, tax: { enabled: true, pct: 11 },
        items: [{ menuItemId: menuA, quantity: 1, unitPrice: 50000 }],
      });
      const beforeEx = await readOrder(oEx.orderId);
      const keyEx = `editreg-k15-${crypto.randomUUID()}`;
      const rS15 = await putOrder(baseUrl, oEx.orderId, mkBody({
        expected_version: 1,
        idempotency_key: keyEx,
        items: [{ id: oEx.itemIds[0], menu_item_id: menuA, quantity: 1, discount_type: 'NOMINAL', discount_value: 60000 }],
      }));
      check('S15: NOMINAL > gross → 400', rS15.status === 400, `got ${rS15.status} code=${rS15.json?.code}`);
      check('S15: code=ITEM_DISCOUNT_EXCEEDS_GROSS', rS15.json?.code === 'ITEM_DISCOUNT_EXCEEDS_GROSS', `got ${rS15.json?.code}`);
      const afterEx = await readOrder(oEx.orderId);
      check('S15: version tetap 1 (tanpa mutasi)', Number(afterEx.version) === 1, `got ${afterEx.version}`);
      check('S15: total tetap', Number(afterEx.total_amount) === Number(beforeEx.total_amount),
        `${afterEx.total_amount} vs ${beforeEx.total_amount}`);
      const itemsEx = await readItems(oEx.orderId);
      check('S15: item discount tidak tersimpan (no partial)',
        itemsEx[0]?.discount_type === null && itemsEx[0]?.discount_value === null,
        `type=${itemsEx[0]?.discount_type} val=${itemsEx[0]?.discount_value}`);
      check('S15: tidak ada record idempotency', (await countEditRequests(propertyA, oEx.orderId, keyEx)) === 0);
    } else {
      blockedReport('S13/S14/S15: diskon item', "permission 'pos.discount.edit' tidak ada di DB fixture");
    }

    // ══ S16: expected_total cocok / mismatch ══
    console.log('\n=== S16: expected_total cocok / mismatch ===');
    const oEt = await createFixtureOrder(setupClient, propertyA, {
      items: [{ menuItemId: menuA, quantity: 1, unitPrice: 50000 }],
    });
    const rS16a = await putOrder(baseUrl, oEt.orderId, mkBody({
      expected_version: 1,
      idempotency_key: `editreg-k16a-${crypto.randomUUID()}`,
      expected_total: 100000,
      items: [{ id: oEt.itemIds[0], menu_item_id: menuA, quantity: 2 }],
    }));
    check('S16: expected_total cocok → 200', rS16a.status === 200, `got ${rS16a.status} code=${rS16a.json?.code}`);
    const oEtRow = await readOrder(oEt.orderId);
    check('S16: total = 100000', Number(oEtRow.total_amount) === 100000, `got ${oEtRow.total_amount}`);

    const oEt2 = await createFixtureOrder(setupClient, propertyA, {
      items: [{ menuItemId: menuA, quantity: 1, unitPrice: 50000 }],
    });
    const beforeEt2 = await readOrder(oEt2.orderId);
    const keyEt2 = `editreg-k16b-${crypto.randomUUID()}`;
    const rS16b = await putOrder(baseUrl, oEt2.orderId, mkBody({
      expected_version: 1,
      idempotency_key: keyEt2,
      expected_total: 99999,
      items: [{ id: oEt2.itemIds[0], menu_item_id: menuA, quantity: 2 }],
    }));
    check('S16: expected_total mismatch → 409', rS16b.status === 409, `got ${rS16b.status} code=${rS16b.json?.code}`);
    check('S16: code=PRICING_TOTAL_CHANGED', rS16b.json?.code === 'PRICING_TOTAL_CHANGED', `got ${rS16b.json?.code}`);
    const afterEt2 = await readOrder(oEt2.orderId);
    check('S16: version tetap 1 (tanpa mutasi)', Number(afterEt2.version) === 1, `got ${afterEt2.version}`);
    check('S16: total tetap', Number(afterEt2.total_amount) === Number(beforeEt2.total_amount));
    const itemsEt2 = await readItems(oEt2.orderId);
    check('S16: qty item tetap 1 (tanpa mutasi item)', itemsEt2[0]?.quantity === 1, `got ${itemsEt2[0]?.quantity}`);
    check('S16: tidak ada record idempotency', (await countEditRequests(propertyA, oEt2.orderId, keyEt2)) === 0);

    // ══ S17: metadata order — persist, omitted, explicit null, fingerprint ══
    console.log('\n=== S17: metadata order (tri-state) ===');
    const oMeta = await createFixtureOrder(setupClient, propertyA, {
      items: [{ menuItemId: menuA, quantity: 1, unitPrice: 50000 }],
    });
    const keyM1 = `editreg-k17a-${crypto.randomUUID()}`;
    const rM1 = await putOrder(baseUrl, oMeta.orderId, mkBody({
      expected_version: 1,
      idempotency_key: keyM1,
      table_number: 'T-09',
      guest_name: 'Budi',
      guest_phone: '0812000111',
      notes: 'catatan-1',
      discount_reason: 'promo',
    }));
    check('S17: set metadata → 200', rM1.status === 200, `got ${rM1.status} code=${rM1.json?.code}`);
    const dM1 = await getDetail(baseUrl, oMeta.orderId, propertyA);
    const ordM1 = dM1.json?.data?.order;
    check('S17: GET detail: table_number tersimpan', ordM1?.table_number === 'T-09', `got ${ordM1?.table_number}`);
    check('S17: GET detail: guest_name tersimpan', ordM1?.guest_name === 'Budi', `got ${ordM1?.guest_name}`);
    check('S17: GET detail: guest_phone tersimpan', ordM1?.guest_phone === '0812000111', `got ${ordM1?.guest_phone}`);
    check('S17: GET detail: notes tersimpan', ordM1?.notes === 'catatan-1', `got ${ordM1?.notes}`);
    check('S17: GET detail: discount_reason tersimpan', ordM1?.discount_reason === 'promo', `got ${ordM1?.discount_reason}`);

    const ordBeforeOmit = await readOrder(oMeta.orderId);
    const rM2 = await putOrder(baseUrl, oMeta.orderId, mkBody({
      expected_version: Number(ordBeforeOmit.version),
      idempotency_key: `editreg-k17b-${crypto.randomUUID()}`,
      guest_name: 'Budi-2',
    }));
    check('S17: PUT partial (guest_name saja) → 200', rM2.status === 200, `got ${rM2.status} code=${rM2.json?.code}`);
    const ordM2 = await readOrder(oMeta.orderId);
    check('S17: omitted mempertahankan table_number', ordM2.table_number === 'T-09', `got ${ordM2.table_number}`);
    check('S17: omitted mempertahankan guest_phone', ordM2.guest_phone === '0812000111', `got ${ordM2.guest_phone}`);
    check('S17: omitted mempertahankan notes', ordM2.notes === 'catatan-1', `got ${ordM2.notes}`);
    check('S17: omitted mempertahankan discount_reason', ordM2.discount_reason === 'promo', `got ${ordM2.discount_reason}`);
    check('S17: guest_name berubah', ordM2.guest_name === 'Budi-2', `got ${ordM2.guest_name}`);

    const vM3 = Number(ordM2.version);
    const keyM3 = `editreg-k17c-${crypto.randomUUID()}`;
    const rM3 = await putOrder(baseUrl, oMeta.orderId, mkBody({
      expected_version: vM3,
      idempotency_key: keyM3,
      notes: null,
      guest_phone: null,
    }));
    check('S17: explicit null → 200', rM3.status === 200, `got ${rM3.status} code=${rM3.json?.code}`);
    const ordM3 = await readOrder(oMeta.orderId);
    check('S17: notes explicit null → NULL', ordM3.notes === null, `got ${ordM3.notes}`);
    check('S17: guest_phone explicit null → NULL', ordM3.guest_phone === null, `got ${ordM3.guest_phone}`);
    check('S17: table_number tetap (omitted)', ordM3.table_number === 'T-09', `got ${ordM3.table_number}`);
    check('S17: discount_reason tetap (omitted)', ordM3.discount_reason === 'promo', `got ${ordM3.discount_reason}`);

    // (4d) fingerprint omitted ≠ explicit null — beda isi payload hanya `notes`.
    const oFp = await createFixtureOrder(setupClient, propertyA, {
      items: [{ menuItemId: menuA, quantity: 1, unitPrice: 50000 }],
    });
    const keyFp = `editreg-k17d-${crypto.randomUUID()}`;
    const rFpA = await putOrder(baseUrl, oFp.orderId, mkBody({
      expected_version: 1,
      idempotency_key: keyFp,
      guest_phone: '0800000000', // notes OMITTED
    }));
    check('S17: fingerprint A (notes omitted) → 200', rFpA.status === 200, `got ${rFpA.status} code=${rFpA.json?.code}`);
    const fpA = await readEditRequest(propertyA, oFp.orderId, keyFp);
    check('S17: record fingerprint A tersimpan (sha256 64 hex)',
      !!fpA && typeof fpA.request_fingerprint === 'string' && fpA.request_fingerprint.length === 64,
      JSON.stringify(fpA));
    const rFpB = await putOrder(baseUrl, oFp.orderId, mkBody({
      expected_version: 1, // sama dgn A → beda hanya pada presence `notes`
      idempotency_key: keyFp,
      guest_phone: '0800000000',
      notes: null, // notes EXPLICIT NULL
    }));
    check('S17: fingerprint omitted ≠ explicit null → 409', rFpB.status === 409, `got ${rFpB.status} code=${rFpB.json?.code}`);
    check('S17: code=IDEMPOTENCY_KEY_CONFLICT (beda fingerprint)',
      rFpB.json?.code === 'IDEMPOTENCY_KEY_CONFLICT', `got ${rFpB.json?.code}`);

    // ══ S18: field immutable → 400 UNSUPPORTED_FIELD (termasuk null) ══
    console.log('\n=== S18: immutable field → 400 UNSUPPORTED_FIELD ===');
    const oImm = await createFixtureOrder(setupClient, propertyA, {
      items: [{ menuItemId: menuA, quantity: 1, unitPrice: 50000 }],
    });
    const beforeImm = await readOrder(oImm.orderId);
    const immCases = [
      ['reservation_id = 5', { reservation_id: 5 }],
      ['reservation_id = null', { reservation_id: null }],
      ['service_charge_enabled = true', { service_charge_enabled: true }],
      ['service_charge_enabled = null', { service_charge_enabled: null }],
      ['tax_enabled = false', { tax_enabled: false }],
      ['tax_enabled = null', { tax_enabled: null }],
    ];
    for (const [label, extra] of immCases) {
      const r = await putOrder(baseUrl, oImm.orderId, mkBody({
        expected_version: 1,
        idempotency_key: `editreg-k18-${crypto.randomUUID()}`,
        items: [{ id: oImm.itemIds[0], menu_item_id: menuA, quantity: 2 }],
        ...extra,
      }));
      check(`S18: ${label} → 400`, r.status === 400, `got ${r.status} code=${r.json?.code}`);
      check(`S18: ${label} code=UNSUPPORTED_FIELD`, r.json?.code === 'UNSUPPORTED_FIELD', `got ${r.json?.code}`);
    }
    const afterImm = await readOrder(oImm.orderId);
    check('S18: version tetap 1 (tanpa mutasi)', Number(afterImm.version) === 1, `got ${afterImm.version}`);
    check('S18: total tetap', Number(afterImm.total_amount) === Number(beforeImm.total_amount));
    const itemsImm = await readItems(oImm.orderId);
    check('S18: qty item tetap 1 (tanpa mutasi)', itemsImm[0]?.quantity === 1, `got ${itemsImm[0]?.quantity}`);

    // ══ S19: replay identik (metadata) tidak mengubah data ══
    console.log('\n=== S19: replay identik metadata → tanpa mutasi ===');
    const beforeReplay = await readOrder(oMeta.orderId);
    const rS19 = await putOrder(baseUrl, oMeta.orderId, mkBody({
      expected_version: vM3,
      idempotency_key: keyM3,
      notes: null,
      guest_phone: null,
    }));
    check('S19: replay → 200', rS19.status === 200, `got ${rS19.status} code=${rS19.json?.code}`);
    check('S19: replayed=true', rS19.json?.data?.replayed === true);
    const afterReplay = await readOrder(oMeta.orderId);
    check('S19: version tidak berubah', Number(afterReplay.version) === Number(beforeReplay.version),
      `${afterReplay.version} vs ${beforeReplay.version}`);
    check('S19: updated_at tidak berubah',
      new Date(afterReplay.updated_at).toISOString() === new Date(beforeReplay.updated_at).toISOString());
    check('S19: 1 record idempotency untuk key', (await countEditRequests(propertyA, oMeta.orderId, keyM3)) === 1);

    // ══ S20: keamanan idempotency global — BLOCKED (middleware produksi) ══
    console.log('\n=== S20: global idempotency middleware (BLOCKED) ===');
    blockedReport(
      'S20: PUT + header Idempotency-Key tidak HIT sebelum auth/property-scope',
      'middleware idempotency global hanya hidup inline di index.ts (tidak di-export); harness menguji handler, bukan middleware global produksi — tidak diklaim PASS'
    );

  } catch (e) {
    fail('main', e);
    if (e && e.stack) console.error(e.stack);
  } finally {
    if (setupClient) { try { setupClient.release(); } catch (_) {} }
    if (httpServer) { try { await new Promise((r) => httpServer.close(r)); } catch (_) {} }
  }

  // ── Cleanup + residue (hanya bila identitas terverifikasi) ──
  if (identityVerified) {
    let cleanupClient = null;
    try {
      cleanupClient = await pool.connect();
      await cleanupFixtures(cleanupClient);
      const residue = await verifyNoResidue(cleanupClient);
      if (residue.length) {
        residue.forEach((r) => fail(`Residue: ${r}`));
      } else {
        pass('cleanup: zero residue');
      }
    } catch (e) {
      fail('cleanup', e);
    } finally {
      if (cleanupClient) { try { cleanupClient.release(); } catch (_) {} }
    }
  } else {
    console.error('SAFETY: identitas DB tidak terverifikasi — cleanup dilewati.');
  }

  try { await pool.end(); } catch (e) { fail('pool.end', e); }

  console.log(`\n[SUMMARY] passed=${passed} failed=${failed} blocked=${blocked}`);
  if (failures.length) {
    console.error('[FAILURES]');
    failures.forEach((f) => console.error(`  - ${f}`));
  }
  if (blockedList.length) {
    console.error('[BLOCKED]');
    blockedList.forEach((b) => console.error(`  - ${b}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
