/**
 * POS DISCOUNT PERMISSION & AUDIT TEST
 *
 * Target: disposable PostgreSQL (host 127.0.0.1, port 15434,
 *         database oak_minibar_test, user minibar_test).
 *
 * Uji createPosOrderCreateHandler (dist):
 *   S1: Tanpa izin diskon → 403, tanpa mutasi DB.
 *   S2: Dengan izin → diskon item + order dihitung, audit mencatat actor.
 *   S3: Replay → order sama dikembalikan, tanpa audit tambahan.
 *   S4: Order tanpa diskon → perilaku lama, tanpa audit diskon.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test \
 *   node backend/test/pos_discount_permission_audit_test.js
 */

'use strict';

// ─── 1. DB SAFETY GUARD (tanpa dotenv/fallback) ─────────────────────────────
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !testUrl.trim()) {
  console.error(
    'SAFETY: TEST_DATABASE_URL tidak di-set.\n' +
    'Jalankan: TEST_DATABASE_URL=postgres://USER:PASS@127.0.0.1:15434/oak_minibar_test ' +
    'node backend/test/pos_discount_permission_audit_test.js'
  );
  process.exit(1);
}

const ALLOWED_HOST = '127.0.0.1';
const ALLOWED_PORT = 15434;
const ALLOWED_DATABASE = 'oak_minibar_test';
const ALLOWED_USER = 'minibar_test';
const FORBIDDEN = ['staging', 'production', 'prod', 'live'];

let target;
try {
  const u = new URL(testUrl.trim());
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error('protocol wajib postgres/postgresql');
  }
  if (u.hostname !== ALLOWED_HOST) {
    throw new Error(`host wajib ${ALLOWED_HOST} (diterima: ${u.hostname})`);
  }
  if (u.searchParams.size > 0) {
    throw new Error('query parameter tidak didukung');
  }
  if (!u.port || !/^\d+$/.test(u.port)) {
    throw new Error('port eksplisit wajib');
  }
  const port = Number(u.port);
  const user = u.username ? decodeURIComponent(u.username) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';
  const database = u.pathname ? decodeURIComponent(u.pathname.replace(/^\//, '')) : '';
  if (port !== ALLOWED_PORT) {
    throw new Error(`port wajib ${ALLOWED_PORT} (diterima: ${port})`);
  }
  if (!user) throw new Error('user wajib lengkap');
  if (!password) throw new Error('password wajib lengkap');
  if (user !== ALLOWED_USER) {
    throw new Error(`user wajib ${ALLOWED_USER} (diterima: ${user})`);
  }
  if (database !== ALLOWED_DATABASE) {
    throw new Error(`database wajib ${ALLOWED_DATABASE} (diterima: ${database})`);
  }
  if (FORBIDDEN.some((p) => database.toLowerCase().includes(p))) {
    throw new Error('indikator staging/production/live terdeteksi');
  }
  target = { host: u.hostname, port, user, database, password };
  console.log(
    `[POS DISCOUNT TEST] Target DB: ${database} (user: ${user}, port: ${port})`
  );
} catch (e) {
  console.error('SAFETY: TEST_DATABASE_URL ditolak — ' + e.message);
  process.exit(1);
}

// ─── 2. Pool dari field eksplisit ────────────────────────────────────────────
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  host: target.host,
  port: target.port,
  user: target.user,
  password: target.password,
  database: target.database,
  max: 5,
});

// ─── 3. Import factory dari dist ────────────────────────────────────────────
const { createPosOrderCreateHandler } = require('../dist/domains/pos/posOrderCreateHandler');
if (typeof createPosOrderCreateHandler !== 'function') {
  console.error(
    'GUARD: dist/domains/pos/posOrderCreateHandler tidak mengexport createPosOrderCreateHandler.\n' +
    'Jalankan build (tsc) lebih dulu sebelum test.'
  );
  process.exit(1);
}

// ─── Helper ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ' — ' + detail : ''}`);
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

// Tracking fixture — semua scoped per property_id
const trackedProperties = [];
const tracked = {
  properties: [],
  menuCategories: [],
  menuItems: [],
  posOrders: [],
  posOrderItems: [],
  auditLogs: [],
};

function trackPropIds(table, propertyId, id) {
  if (id == null) return;
  const textId = String(id);
  if (!tracked[table].some((row) => row.property_id === propertyId && row.id === textId)) {
    tracked[table].push({ property_id: propertyId, id: textId });
  }
}

function trackProperty(id) {
  trackedProperties.push(id);
}

function trackedPropIds() {
  return trackedProperties.slice();
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────
const RUN_ID =
  Date.now().toString(36).toUpperCase() +
  Math.random().toString(36).slice(2, 5).toUpperCase();

const PROPERTY_CODE_PREFIX =
  crypto.randomBytes(2).toString('hex').slice(0, 3).toUpperCase();
let propertyCounter = 0;
const usedPropertyCodes = new Set();

function nextPropertyCode() {
  propertyCounter++;
  const code = PROPERTY_CODE_PREFIX + propertyCounter.toString(36).toUpperCase().padStart(3, '0');
  if (usedPropertyCodes.has(code)) throw new Error(`duplikat property code '${code}'`);
  usedPropertyCodes.add(code);
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error(`property code '${code}' tidak valid`);
  return code;
}

async function createFixtureProperty(client, label) {
  const code = nextPropertyCode();
  const q = await client.query(
    `INSERT INTO properties (name, property_code, timezone, currency_code, is_active)
     VALUES ($1, $2, 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`,
    [`DiscTst ${label} ${RUN_ID}`, code]
  );
  const id = Number(q.rows[0].id);
  trackProperty(id);
  trackPropIds('properties', id, id);
  return id;
}

async function createFixtureMenu(client, propertyId, name, price) {
  const catQ = await client.query(
    `INSERT INTO pos_menu_categories (property_id, name) VALUES ($1, $2) RETURNING id`,
    [propertyId, `${name}_cat_${RUN_ID}`]
  );
  const catId = Number(catQ.rows[0].id);
  trackPropIds('menuCategories', propertyId, catId);

  const itemQ = await client.query(
    `INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active)
     VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id`,
    [propertyId, catId, `${name.toUpperCase()}_${RUN_ID}`, name, price]
  );
  const itemId = Number(itemQ.rows[0].id);
  trackPropIds('menuItems', propertyId, itemId);
  return { categoryId: catId, itemId };
}

// Collect committed order/audit IDs even when the response or assertion fails.
async function collectFixtureArtifacts(collectionClient) {
  const propIds = trackedPropIds();
  if (!propIds.length) return;
  const errors = [];
  const queries = [
    ['posOrders', 'SELECT property_id, id FROM pos_orders WHERE property_id = ANY($1)'],
    ['auditLogs', 'SELECT property_id, audit_id AS id FROM audit_logs WHERE property_id = ANY($1)'],
  ];
  for (const [table, sql] of queries) {
    try {
      const result = await collectionClient.query(sql, [propIds]);
      for (const row of result.rows) trackPropIds(table, Number(row.property_id), row.id);
    } catch (err) {
      errors.push(`${table}: ${String((err && err.message) || err)}`);
    }
  }
  if (errors.length) throw new Error('Artifact collection failed: ' + errors.join(' | '));
}

// Creation must not project a SALE, settlement, payment, folio entry or sequence.
async function verifyNoFinancialArtifacts(verificationClient) {
  const propIds = trackedPropIds();
  if (!propIds.length) return;
  for (const table of ['transactions', 'pos_settlements', 'payment_transactions',
                        'folio_entries', 'transaction_daily_sequences']) {
    const result = await verificationClient.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE property_id = ANY($1)`, [propIds]
    );
    ok(`No unexpected financial artifacts: ${table}`, Number(result.rows[0].n) === 0,
       `n=${result.rows[0].n}`);
  }
}

// ─── Cleanup (scoped per property_id) ────────────────────────────────────────
async function cleanupFixtures(cleanupClient) {
  const propIds = trackedPropIds();
  if (!propIds.length) return { removed: 'ok' };

  let txnActive = false;
  try {
    await cleanupClient.query('BEGIN');
    txnActive = true;

    // audit_logs
    {
      const aud = tracked.auditLogs.filter((r) => propIds.includes(r.property_id));
      const ids = aud.map((r) => r.id).filter((v) => v);
      if (ids.length) {
        await cleanupClient.query(
          `DELETE FROM audit_logs WHERE audit_id::text = ANY($1) AND property_id = ANY($2)`,
          [ids, propIds]
        );
      }
    }

    // pos_order_items — scope lewat pos_orders
    {
      await cleanupClient.query(
        `DELETE FROM pos_order_items WHERE order_id IN (
           SELECT id FROM pos_orders WHERE property_id = ANY($1)
         )`,
        [propIds]
      );
    }

    // pos_orders
    {
      const orders = tracked.posOrders.filter((r) => propIds.includes(r.property_id));
      const ids = orders.map((r) => r.id).filter((v) => v);
      if (ids.length) {
        await cleanupClient.query(
          `DELETE FROM pos_orders WHERE id::text = ANY($1) AND property_id = ANY($2)`,
          [ids, propIds]
        );
      }
    }

    // Do not erase unexpected financial artifacts. They are checked before
    // cleanup and remain visible to the independent residue check.

    // pos_menu_items
    {
      const mi = tracked.menuItems.filter((r) => propIds.includes(r.property_id));
      const ids = mi.map((r) => r.id).filter((v) => v);
      if (ids.length) {
        await cleanupClient.query(
          `DELETE FROM pos_menu_items WHERE id::text = ANY($1) AND property_id = ANY($2)`,
          [ids, propIds]
        );
      }
    }

    // pos_menu_categories
    {
      const mc = tracked.menuCategories.filter((r) => propIds.includes(r.property_id));
      const ids = mc.map((r) => r.id).filter((v) => v);
      if (ids.length) {
        await cleanupClient.query(
          `DELETE FROM pos_menu_categories WHERE id::text = ANY($1) AND property_id = ANY($2)`,
          [ids, propIds]
        );
      }
    }

    // properties
    {
      await cleanupClient.query(
        `DELETE FROM properties WHERE id = ANY($1)`, [propIds]
      );
    }

    await cleanupClient.query('COMMIT');
    txnActive = false;
    return { removed: 'ok' };
  } catch (err) {
    if (txnActive) {
      try {
        await cleanupClient.query('ROLLBACK');
        txnActive = false;
      } catch (rbErr) {
        console.error('[CLEANUP] ROLLBACK gagal: ' + String((rbErr && rbErr.message) || rbErr));
        return { removed: 'error', error: String((err && err.message) || err), discardClient: true };
      }
    }
    return { removed: 'error', error: String((err && err.message) || err) };
  }
}

// ─── Residue check ───────────────────────────────────────────────────────────
async function verifyNoResidue(residueClient) {
  const residue = [];
  const propIds = trackedPropIds();
  if (!propIds.length) return residue;

  {
    const r = await residueClient.query(
      `SELECT COUNT(*) AS n FROM pos_orders WHERE property_id = ANY($1)`, [propIds]
    );
    if (Number(r.rows[0].n) > 0) residue.push(`pos_orders: ${r.rows[0].n} residu`);
  }
  {
    const r = await residueClient.query(
      `SELECT COUNT(*) AS n FROM pos_order_items WHERE order_id IN (
         SELECT id FROM pos_orders WHERE property_id = ANY($1))`, [propIds]
    );
    if (Number(r.rows[0].n) > 0) residue.push(`pos_order_items: ${r.rows[0].n} residu`);
  }
  {
    const r = await residueClient.query(
      `SELECT COUNT(*) AS n FROM pos_menu_items WHERE property_id = ANY($1)`, [propIds]
    );
    if (Number(r.rows[0].n) > 0) residue.push(`pos_menu_items: ${r.rows[0].n} residu`);
  }
  {
    const r = await residueClient.query(
      `SELECT COUNT(*) AS n FROM pos_menu_categories WHERE property_id = ANY($1)`, [propIds]
    );
    if (Number(r.rows[0].n) > 0) residue.push(`pos_menu_categories: ${r.rows[0].n} residu`);
  }
  {
    const r = await residueClient.query(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE property_id = ANY($1)`, [propIds]
    );
    if (Number(r.rows[0].n) > 0) residue.push(`audit_logs: ${r.rows[0].n} residu`);
  }
  {
    const r = await residueClient.query(
      `SELECT COUNT(*) AS n FROM transactions WHERE property_id = ANY($1)`, [propIds]
    );
    if (Number(r.rows[0].n) > 0) residue.push(`transactions: ${r.rows[0].n} residu`);
  }
  {
    const r = await residueClient.query(
      `SELECT COUNT(*) AS n FROM pos_settlements WHERE property_id = ANY($1)`, [propIds]
    );
    if (Number(r.rows[0].n) > 0) residue.push(`pos_settlements: ${r.rows[0].n} residu`);
  }
  {
    const r = await residueClient.query(
      `SELECT COUNT(*) AS n FROM payment_transactions WHERE property_id = ANY($1)`, [propIds]
    );
    if (Number(r.rows[0].n) > 0) residue.push(`payment_transactions: ${r.rows[0].n} residu`);
  }
  {
    const r = await residueClient.query(
      `SELECT COUNT(*) AS n FROM folio_entries WHERE property_id = ANY($1)`, [propIds]
    );
    if (Number(r.rows[0].n) > 0) residue.push(`folio_entries: ${r.rows[0].n} residu`);
  }
  {
    const r = await residueClient.query(
      `SELECT COUNT(*) AS n FROM transaction_daily_sequences WHERE property_id = ANY($1)`, [propIds]
    );
    if (Number(r.rows[0].n) > 0) residue.push(`transaction_daily_sequences: ${r.rows[0].n} residu`);
  }
  {
    const r = await residueClient.query(
      `SELECT COUNT(*) AS n FROM properties WHERE id = ANY($1)`, [propIds]
    );
    if (Number(r.rows[0].n) > 0) residue.push(`properties: ${r.rows[0].n} residu`);
  }
  return residue;
}

// ─── Handler factory builder (mimics production wiring) ─────────────────────
function buildHandler(opts) {
  const { denyDiscount = false } = opts || {};
  return createPosOrderCreateHandler({
    pool,
    connect: () => pool.connect(),
    release: (c) => c.release(),
    assertPropertyScope: async (_req, _pid) => { /* no-op in test */ },
    broadcastEvent: () => { /* no-op */ },
    checkDiscountPermission: async () => !denyDiscount,
  });
}

// ─── Mock req/res helpers ────────────────────────────────────────────────────
function mockReq(body, headers) {
  return { body, headers: headers || {}, user: { id: 42, username: 'test_actor', full_name: 'Test Actor', property_id: 1 } };
}
function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

// ─── Main test flow ──────────────────────────────────────────────────────────
(async function main() {
  let identityVerified = false;
  let client = null;
  let cleanupClient = null;
  const released = { client: false, cleanup: false };

  try {
    // Identity verification
    client = await pool.connect();
    // Verify pool.options before mutation
    if (pool.options.host !== target.host || pool.options.port !== target.port ||
        pool.options.user !== target.user || pool.options.database !== target.database) {
      throw new Error('pool.options tidak cocok dengan TEST_DATABASE_URL — abort');
    }
    const dbCheck = await client.query('SELECT current_database() AS db, current_user AS usr');
    identityVerified = dbCheck.rows[0].db === target.database && dbCheck.rows[0].usr === target.user;
    if (!identityVerified) {
      throw new Error('DB/user tidak cocok — identitas gagal terverifikasi');
    }
    console.log('[IDENTITY] DB terverifikasi.');

    // Ensure required schema exists (test env prerequisite)
    const schemaCheck = await client.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='pos_orders'`
    );
    if (Number(schemaCheck.rows[0].n) === 0) {
      throw new Error('pos_orders tidak ada di DB target. Jalankan schema_v3 migration dulu.');
    }

    // ── Create shared fixtures ──
    let s2OrderId = null; // hoisted for S3 cross-reference
    const prop1 = await createFixtureProperty(client, 'S1');
    const menu1 = await createFixtureMenu(client, prop1, 'Menasah', 50000);
    const menu2 = await createFixtureMenu(client, prop1, 'Es Teh', 10000);

    // =====================================================================
    //  S1: Tanpa izin diskon → 403 DISCOUNT_PERMISSION_DENIED
    // =====================================================================
    console.log('\n── S1: Tanpa izin diskon ──');
    {
      const handler = buildHandler({ denyDiscount: true });
      const req = mockReq({
        property_id: prop1,
        items: [{ menu_item_id: menu1.itemId, quantity: 2, discount_type: 'NOMINAL', discount_value: 5000 }],
      }, { 'Idempotency-Key': `disc-s1-${RUN_ID}` });
      const res = mockRes();
      await handler(req, res);

      ok('S1: status 403', res.statusCode === 403, `got ${res.statusCode}`);
      ok('S1: code DISCOUNT_PERMISSION_DENIED', res.body && res.body.code === 'DISCOUNT_PERMISSION_DENIED', JSON.stringify(res.body && res.body.code));

      // Verify no pos_orders created
      const orderCheck = await client.query(
        'SELECT COUNT(*) AS n FROM pos_orders WHERE property_id = $1', [prop1]
      );
      ok('S1: tidak ada pos_orders dibuat', Number(orderCheck.rows[0].n) === 0, `n=${orderCheck.rows[0].n}`);

      // Verify no audit_logs
      const auditCheck = await client.query(
        'SELECT COUNT(*) AS n FROM audit_logs WHERE property_id = $1', [prop1]
      );
      ok('S1: tidak ada audit_logs dibuat', Number(auditCheck.rows[0].n) === 0, `n=${auditCheck.rows[0].n}`);
    }

    // =====================================================================
    //  S2: Dengan izin → diskon item + order benar, audit mencatat actor
    // =====================================================================
    console.log('\n── S2: Dengan izin diskon ──');
    {
      const handler = buildHandler({ denyDiscount: false });
      const idemKey = `disc-s2-${RUN_ID}`;
      const req = mockReq({
        property_id: prop1,
        items: [
          { menu_item_id: menu1.itemId, quantity: 2, discount_type: 'NOMINAL', discount_value: 5000 },
          { menu_item_id: menu2.itemId, quantity: 3, discount_type: 'PERCENT', discount_value: 10 },
        ],
        discount_type: 'PERCENT',
        discount_value: 5,
        discount_reason: 'Promo member',
      }, { 'Idempotency-Key': idemKey });
      const res = mockRes();
      await handler(req, res);

      ok('S2: status 201', res.statusCode === 201, `got ${res.statusCode} ${JSON.stringify(res.body)}`);
      if (res.statusCode === 201 && res.body.data) {
        const order = res.body.data;
        s2OrderId = order.id;
        // Item1: 2 × 50000 = 100000, discount 5000 → net 95000
        // Item2: 3 × 10000 = 30000, discount PERCENT 10% = 3000 → net 27000
        // Subtotal after item discounts = 95000 + 27000 = 122000
        // Order discount PERCENT 5% of 122000 = 6100
        // Final total = 122000 - 6100 = 115900
        const expectedTotal = 115900;
        ok('S2: total_amount benar', Number(order.total_amount) === expectedTotal,
          `got ${order.total_amount}, expected ${expectedTotal}`);
        ok('S2: discount_amount = 6100', Number(order.discount_amount) === 6100,
          `got ${order.discount_amount}`);
        // Track order immediately
        trackPropIds('posOrders', prop1, order.id);
      }

      // B6: S2 periksa snapshot item/order dari DB
      if (s2OrderId) {
        const snapQ = await client.query(
          `SELECT po.id, po.total_amount, po.discount_amount, po.discount_type, po.discount_value,
                  poi.quantity, poi.unit_price, poi.discount_type AS item_disc_type,
                  poi.discount_value AS item_disc_val, poi.discount_amount AS item_disc_amt
           FROM pos_orders po
           JOIN pos_order_items poi ON poi.order_id = po.id
           WHERE po.id = $1
           ORDER BY poi.id`,
          [s2OrderId]
        );
        ok('S2: DB snapshot 2 item rows', snapQ.rowCount === 2, `rowCount=${snapQ.rowCount}`);
        if (snapQ.rowCount === 2) {
          const r1 = snapQ.rows[0];
          const r2 = snapQ.rows[1];
          ok('S2: item1 discount NOMINAL 5000', r1.item_disc_type === 'NOMINAL' && Number(r1.item_disc_amt) === 5000,
            JSON.stringify({ t: r1.item_disc_type, a: r1.item_disc_amt }));
          ok('S2: item2 discount PERCENT 10 → 3000', r2.item_disc_type === 'PERCENT' && Number(r2.item_disc_amt) === 3000,
            JSON.stringify({ t: r2.item_disc_type, a: r2.item_disc_amt }));
          ok('S2: DB item1 quantity/price/value', Number(r1.quantity) === 2 &&
            Number(r1.unit_price) === 50000 && Number(r1.item_disc_val) === 5000);
          ok('S2: DB item2 quantity/price/value', Number(r2.quantity) === 3 &&
            Number(r2.unit_price) === 10000 && Number(r2.item_disc_val) === 10);
          ok('S2: DB order total/value', Number(r1.total_amount) === 115900 &&
            Number(r1.discount_value) === 5);
          ok('S2: order discount_type PERCENT', r1.discount_type === 'PERCENT', `got ${r1.discount_type}`);
          ok('S2: order discount_amount = 6100', Number(r1.discount_amount) === 6100, `got ${r1.discount_amount}`);
        }
      }

      // Verify audit log exists with correct data
      const auditQ = await client.query(
        `SELECT * FROM audit_logs WHERE property_id = $1 AND action = 'ORDER_DISCOUNT_APPLIED' AND entity = 'pos_orders'`,
        [prop1]
      );
      ok('S2: 1 audit log ORDER_DISCOUNT_APPLIED', auditQ.rowCount === 1, `rowCount=${auditQ.rowCount}`);
      // Track audit immediately (even if assertions below fail)
      if (auditQ.rowCount > 0) {
        for (const r of auditQ.rows) {
          trackPropIds('auditLogs', prop1, r.audit_id);
        }
      }
      if (auditQ.rowCount === 1) {
        const audRow = auditQ.rows[0];
        const audVal = JSON.parse(audRow.new_value);
        ok('S2: audit actor_user_id = 42', String(audVal.actor_user_id) === '42', `got ${audVal.actor_user_id}`);
        ok('S2: audit actor_name = test_actor', audVal.actor_name === 'test_actor', `got ${audVal.actor_name}`);
        ok('S2: audit item_discounts length = 2', audVal.item_discounts.length === 2, `got ${audVal.item_discounts.length}`);
        ok('S2: audit order_discount.discount_amount = 6100', audVal.order_discount && audVal.order_discount.discount_amount === 6100,
          JSON.stringify(audVal.order_discount && audVal.order_discount.discount_amount));
        ok('S2: audit order_discount.reason = Promo member', audVal.order_discount && audVal.order_discount.reason === 'Promo member',
          JSON.stringify(audVal.order_discount && audVal.order_discount.reason));
        ok('S2: audit total_discount = 14100', audVal.total_discount === 14100, `got ${audVal.total_discount}`);
      }
    }

    // =====================================================================
    //  S3: Replay → tidak ada order/audit tambahan
    // =====================================================================
    console.log('\n── S3: Replay idempotent ──');
    {
      const handler = buildHandler({ denyDiscount: false });
      const idemKey = `disc-s2-${RUN_ID}`; // same key as S2
      const req = mockReq({
        property_id: prop1,
        items: [
          { menu_item_id: menu1.itemId, quantity: 2, discount_type: 'NOMINAL', discount_value: 5000 },
          { menu_item_id: menu2.itemId, quantity: 3, discount_type: 'PERCENT', discount_value: 10 },
        ],
        discount_type: 'PERCENT',
        discount_value: 5,
        discount_reason: 'Promo member',
      }, { 'Idempotency-Key': idemKey });
      const res = mockRes();
      await handler(req, res);

      ok('S3: status 200 (REPLAY)', res.statusCode === 200, `got ${res.statusCode}`);
      ok('S3: body.status = REPLAY', res.body && res.body.status === 'REPLAY', JSON.stringify(res.body && res.body.status));
      ok('S3: body.code = IDEMPOTENT_REPLAY', res.body && res.body.code === 'IDEMPOTENT_REPLAY');

      // B6: S3 wajib membuktikan ID order sama
      ok('S3: replay order ID sama dengan S2', s2OrderId != null &&
        res.body && res.body.data && Number(res.body.data.id) === Number(s2OrderId));

      // Verify only 1 audit log still
      const auditQ = await client.query(
        `SELECT COUNT(*) AS n FROM audit_logs WHERE property_id = $1 AND action = 'ORDER_DISCOUNT_APPLIED'`,
        [prop1]
      );
      ok('S3: masih 1 audit log (tidak duplikasi)', Number(auditQ.rows[0].n) === 1, `n=${auditQ.rows[0].n}`);

      // Verify only 1 pos_orders still
      const orderQ = await client.query(
        `SELECT COUNT(*) AS n FROM pos_orders WHERE property_id = $1`,
        [prop1]
      );
      ok('S3: masih 1 pos_orders', Number(orderQ.rows[0].n) === 1, `n=${orderQ.rows[0].n}`);
    }

    // =====================================================================
    //  S4: Order tanpa diskon → perilaku lama, tanpa audit diskon
    // =====================================================================
    console.log('\n── S4: Order tanpa diskon ──');
    {
      const prop2 = await createFixtureProperty(client, 'S4');
      const menu3 = await createFixtureMenu(client, prop2, 'Nasi Goreng', 35000);

      const handler = buildHandler({ denyDiscount: false });
      const req = mockReq({
        property_id: prop2,
        items: [{ menu_item_id: menu3.itemId, quantity: 2 }],
      }, { 'Idempotency-Key': `disc-s4-${RUN_ID}` });
      const res = mockRes();
      await handler(req, res);

      ok('S4: status 201', res.statusCode === 201, `got ${res.statusCode}`);
      if (res.statusCode === 201 && res.body.data) {
        const order = res.body.data;
        ok('S4: total_amount = 70000 (2×35000)', Number(order.total_amount) === 70000, `got ${order.total_amount}`);
        ok('S4: discount_amount = 0', Number(order.discount_amount) === 0, `got ${order.discount_amount}`);
        trackPropIds('posOrders', prop2, order.id);
      }

      // Verify NO discount audit log for prop2
      const auditQ = await client.query(
        `SELECT COUNT(*) AS n FROM audit_logs WHERE property_id = $1 AND action = 'ORDER_DISCOUNT_APPLIED'`,
        [prop2]
      );
      ok('S4: tidak ada audit diskon', Number(auditQ.rows[0].n) === 0, `n=${auditQ.rows[0].n}`);
    }

  } catch (err) {
    console.error('\n[EXCEPTION]', err && err.stack ? err.stack : err);
    failed++;
    failures.push('exception pada alur utama: ' + (err && err.message));
  } finally {
    // ── Cleanup + Residue ─────────────────────────────────────────────────
    if (identityVerified) {
      // Collection precedes cleanup and runs after every scenario/error path.
      let collectionClient = null;
      try {
        collectionClient = await pool.connect();
        await collectFixtureArtifacts(collectionClient);
      } catch (collectErr) {
        failed++;
        failures.push('artifact collection gagal: ' + String((collectErr && collectErr.message) || collectErr));
      } finally {
        if (collectionClient) {
          try { collectionClient.release(); }
          catch (relErr) {
            failed++;
            failures.push('release collectionClient gagal: ' + String((relErr && relErr.message) || relErr));
          }
        }
      }
      // Check before any cleanup can remove evidence of unexpected side effects.
      let verificationClient = null;
      try {
        verificationClient = await pool.connect();
        await verifyNoFinancialArtifacts(verificationClient);
      } catch (verifyErr) {
        failed++;
        failures.push('financial artifact check gagal: ' + String((verifyErr && verifyErr.message) || verifyErr));
      } finally {
        if (verificationClient) {
          try { verificationClient.release(); }
          catch (relErr) {
            failed++;
            failures.push('release verificationClient gagal: ' + String((relErr && relErr.message) || relErr));
          }
        }
      }
      let cleanupReleaseDiscard = false;
      try {
        cleanupClient = await pool.connect();
        const cr = await cleanupFixtures(cleanupClient);
        if (cr.error) {
          failed++;
          failures.push('cleanup gagal: ' + cr.error);
          console.error('[CLEANUP] GAGAL: ' + cr.error);
          if (cr.discardClient) cleanupReleaseDiscard = true;
        } else {
          console.log('[CLEANUP] Berhasil.');
        }
      } catch (cleanErr) {
        failed++;
        failures.push('cleanup exception: ' + String((cleanErr && cleanErr.message) || cleanErr));
        cleanupReleaseDiscard = true;
      }

      // Residue check — client terpisah, tetap dicoba saat cleanup gagal
      let residueClient = null;
      try {
        residueClient = await pool.connect();
        const residue = await verifyNoResidue(residueClient);
        if (residue.length) {
          failed++;
          failures.push('residu: ' + residue.join(' | '));
          console.error('[RESIDUE] ' + residue.join(' | '));
        } else {
          console.log('[RESIDUE] 0 — seluruh fixture bersih.');
        }
      } catch (resErr) {
        failed++;
        failures.push('residue check gagal: ' + String((resErr && resErr.message) || resErr));
      } finally {
        if (residueClient) {
          try {
            residueClient.release();
          } catch (relErr) {
            failed++;
            failures.push('release residueClient gagal: ' + String((relErr && relErr.message) || relErr));
            console.error('[RELEASE] residueClient: ' + String((relErr && relErr.message) || relErr));
          }
        }
      }

      // Release cleanup client
      if (cleanupClient) {
        try {
          cleanupClient.release(cleanupReleaseDiscard);
          released.cleanup = true;
        } catch (relErr) {
          failed++;
          failures.push('release cleanupClient gagal: ' + String((relErr && relErr.message) || relErr));
        }
      }
    }

    // Release main client
    if (client && !released.client) {
      try {
        client.release();
        released.client = true;
      } catch (relErr) {
        failed++;
        failures.push('release client gagal: ' + String((relErr && relErr.message) || relErr));
      }
    }

    let poolEndFailed = false;
    try {
      await pool.end();
    } catch (endErr) {
      failed++;
      failures.push('pool.end gagal: ' + String((endErr && endErr.message) || endErr));
      poolEndFailed = true;
    }
    if (poolEndFailed) process.exitCode = 1;
  }

  // ── Ringkasan ────────────────────────────────────────────────────────────
  console.log(`\n[RESULT] ${passed} PASS, ${failed} FAIL`);
  if (failed > 0) {
    console.log('Gagal:');
    for (const f of failures) console.log('  - ' + f);
  }
  if (failed > 0) process.exitCode = 1;
})();
