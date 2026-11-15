/**
 * POS RECEIPT CANONICAL WHOLE-RUPIAH SERIALIZATION TEST
 * Disposable oak_minibar_test only; no dotenv reads.
 *
 * Akar masalah (root cause) yang dibuktikan test ini:
 *  - kolom monetary POS adalah numeric(12,2) → driver pg mengembalikan
 *    string decimal ("45000.00"), sementara kontrak receipt frontend
 *    adalah whole-rupiah string kanonik ("45000").
 *  - Handler receipt harus MENORMALISASI value numerik (yang sudah
 *    tervalidasi) ke string whole-rupiah, bukan meneruskan raw string DB.
 *
 * Coverage:
 *  C1 — response memuat "45000" (bukan "45000.00") untuk ketiga authoritative amount
 *  C2 — DB raw terbukti mengembalikan "45000.00" (numeric(12,2) scale 2)
 *  C3 — item.unit_price & item.discount_amount dinormalisasi
 *  C4 — settlement.cash_received & change_due dinormalisasi
 *  C5 — mismatch tetap fail-closed (RECEIPT_INTEGRITY_ERROR)
 *  C6 — field sekunder non-kanonik (decimal) ditolak sebagai integrity error
 *  C7 — discount_value tidak dinormalisasi (bisa desimal bila PERCENT)
 *  Cleanup + residue 0
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://minibar_test:***@127.0.0.1:15434/oak_minibar_test \
 *   node backend/test/pos_receipt_canonical_serialization_test.js
 */
'use strict';
const crypto = require('crypto');
const run = crypto.randomBytes(6).toString('hex');

// ─── DB Safety Guard ─────────────────────────────────────────────────────
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
    !['postgres:', 'postgresql:'].includes(u.protocol) ||
    u.search || u.hash ||
    target.host !== '127.0.0.1' ||
    target.port !== 15434 ||
    target.user !== 'minibar_test' ||
    target.database !== 'oak_minibar_test' ||
    !target.password
  ) throw new Error();
} catch (_) {
  console.error('SAFETY: TEST_DATABASE_URL tidak sesuai target disposable (127.0.0.1:15434/minibar_test/oak_minibar_test).');
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
const { setRoleAccess, ACCESS_RESOURCES } = require('../dist/domains/settings/accessControlService');
const http = require('http');

// ─── Test state ──────────────────────────────────────────────────────────
const failures = [];
let passed = 0;
const fixture = {
  propertyId: 0,
  roleId: 0,
  userId: 0,
  categoryId: 0,
  menuItemId: 0,
  orderId: 0,
  settlementId: 0,
  transactionId: '',
  token: '',
  preserve: false,
};

function check(label, cond) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failures.push(label); console.error('  FAIL  ' + label); }
}
function problem(label, e) {
  failures.push(label + ': ' + String(e && e.message || e));
  console.error('[ERROR] ' + failures[failures.length - 1]);
}

function posViewGrid() {
  const grid = {};
  for (const r of ACCESS_RESOURCES) {
    grid[r.key] = { view: false, edit: false, delete: false };
  }
  grid.POS = { view: true, edit: false, delete: false };
  return grid;
}

async function identity(c) {
  for (const k of ['host', 'port', 'user', 'database']) {
    if (String(pool.options[k]) !== String(target[k]))
      throw new Error('pool.options tidak sesuai: ' + k);
  }
  const r = (await c.query('SELECT current_database() AS db, current_user AS usr')).rows[0];
  if (r.db !== target.database || r.usr !== target.user)
    throw new Error('identitas DB tidak sesuai');
}

// ─── Fixture creation ────────────────────────────────────────────────────
async function createFixtures(c) {
  const propRow = (await c.query(
    `INSERT INTO properties(name, property_code, address, phone, timezone, currency_code, currency, is_active)
     VALUES($1,$2,'Jl. Canonical Test','+622111122233','Asia/Jakarta','IDR','IDR',TRUE)
     RETURNING id`,
    ['Canonical ' + run, crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6)],
  )).rows[0];
  fixture.propertyId = Number(propRow.id);

  const roleRow = (await c.query(
    `INSERT INTO roles(property_id, name, is_active, is_system_role, is_test_data)
     VALUES($1,$2,TRUE,FALSE,TRUE) RETURNING id`,
    [fixture.propertyId, 'Canonical ' + run],
  )).rows[0];
  fixture.roleId = Number(roleRow.id);

  await setRoleAccess(
    c,
    fixture.propertyId,
    fixture.roleId,
    posViewGrid(),
    {
      id: 0,
      name: 'Canonical fixture',
      property_id: fixture.propertyId,
      is_platform_super_admin: false,
    },
  );

  const userRow = (await c.query(
    `INSERT INTO users(property_id, role_id, username, email, full_name, is_active, is_test_data,
      account_status, must_change_password, access_type)
     VALUES($1,$2,$3,$4,$5,TRUE,TRUE,'READY',FALSE,'PMS_STAFF') RETURNING id`,
    [
      fixture.propertyId,
      fixture.roleId,
      'canonical_' + run,
      'canonical_' + run + '@test.local',
      'Canonical Fixture',
    ],
  )).rows[0];
  fixture.userId = Number(userRow.id);

  const payload = {
    id: fixture.userId,
    property_id: fixture.propertyId,
    role_id: fixture.roleId,
    username: 'canonical_' + run,
    email: 'canonical_' + run + '@test.local',
    full_name: 'Canonical Fixture',
    role: 'Fixture',
    scope: 'FULL',
    account_status: 'READY',
    must_change_password: false,
    access_type: 'PMS_STAFF',
  };
  fixture.token = generateToken(payload);

  const catRow = (await c.query(
    `INSERT INTO pos_menu_categories(property_id, name) VALUES($1,'Canonical ' || $2) RETURNING id`,
    [fixture.propertyId, run],
  )).rows[0];
  fixture.categoryId = Number(catRow.id);

  const itemRow = (await c.query(
    `INSERT INTO pos_menu_items(property_id, category_id, item_code, name, price, is_active)
     VALUES($1,$2,'CNS-001','Item Kanonik',25000,TRUE) RETURNING id`,
    [fixture.propertyId, fixture.categoryId],
  )).rows[0];
  fixture.menuItemId = Number(itemRow.id);

  // Order PAID: 2 x 25000 = 50000, discount 5000 → total 45000
  const TOTAL = 45000;
  const DISCOUNT = 5000;
  const orderRow = (await c.query(
    `INSERT INTO pos_orders(property_id, order_number, guest_name, guest_phone, table_number, status,
      total_amount, discount_type, discount_value, discount_reason, discount_amount, notes)
     VALUES($1,$2,'Tamu Kanonik','+628123456789','T-C','PAID',$3,'NOMINAL',NULL,'PROMO',$4,'canonical test')
     RETURNING id`,
    [fixture.propertyId, 'ORD-CAN-' + run, TOTAL, DISCOUNT],
  )).rows[0];
  fixture.orderId = Number(orderRow.id);

  // Item 1: 25000 x 2, item discount 5000 → net 45000
  await c.query(
    `INSERT INTO pos_order_items(order_id, menu_item_id, quantity, unit_price,
      item_name_snapshot, item_code_snapshot, discount_amount)
     VALUES($1,$2,2,25000,'Item Kanonik','CNS-001',$3)`,
    [fixture.orderId, fixture.menuItemId, DISCOUNT],
  );

  // SALE transaction
  const txRow = (await c.query(
    `INSERT INTO transactions(
       property_id, transaction_no, transaction_date,
       transaction_type, source_type, source_id,
       category_code, category_name, description,
       amount, discount_amount, service_amount, tax_amount, net_amount,
       payment_status, payment_method, transaction_status
     )
     VALUES($1,$2,CURRENT_DATE,
       'SALE','POS_ORDER',$3,
       'POS','POS Canonical','POS receipt canonical test',
       $4,$5,0,0,$4,
       'PAID','CASH','POSTED')
     RETURNING id`,
    [fixture.propertyId, 'TX-CAN-' + run, String(fixture.orderId), TOTAL, DISCOUNT],
  )).rows[0];
  fixture.transactionId = String(txRow.id);

  // Settlement CASH: cash 50000, change 5000
  const settlementRow = (await c.query(
    `INSERT INTO pos_settlements(
       property_id, pos_order_id, transaction_id,
       amount, payment_method, status,
       idempotency_key, request_fingerprint,
       created_by, cash_received, change_due, payment_reference
     )
     VALUES($1,$2,$3,$4,'CASH','SUCCESS',$5,$6,'canonical_test',50000,5000,'REF-CAN-' || $7)
     RETURNING id`,
    [
      fixture.propertyId,
      fixture.orderId,
      fixture.transactionId,
      TOTAL,
      'idem-can-' + run,
      'fp-can-' + run,
      run,
    ],
  )).rows[0];
  fixture.settlementId = Number(settlementRow.id);

  console.log('[FIXTURE] canonical fixture: property=' + fixture.propertyId +
    ' order=' + fixture.orderId + ' tx=' + fixture.transactionId +
    ' settlement=' + fixture.settlementId + ' (total=' + TOTAL + ')');
}

// ─── HTTP helper ─────────────────────────────────────────────────────────
async function getReceipt(port, orderId, propertyId, token) {
  const url = `http://127.0.0.1:${port}/api/pos/orders/${orderId}/receipt?property_id=${propertyId}`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + token },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = { _raw: text }; }
  return { status: r.status, body };
}

// ─── Cleanup ─────────────────────────────────────────────────────────────
async function clean(c) {
  if (fixture.preserve) return;
  await c.query('BEGIN');
  try {
    await c.query('DELETE FROM pos_settlements WHERE property_id=$1', [fixture.propertyId]);
    await c.query('DELETE FROM pos_order_items WHERE order_id=$1', [fixture.orderId]);
    await c.query('DELETE FROM pos_orders WHERE property_id=$1', [fixture.propertyId]);
    await c.query('DELETE FROM transactions WHERE property_id=$1', [fixture.propertyId]);
    await c.query('DELETE FROM audit_logs WHERE property_id=$1', [fixture.propertyId]);
    await c.query('DELETE FROM pos_menu_items WHERE property_id=$1', [fixture.propertyId]);
    await c.query('DELETE FROM pos_menu_categories WHERE property_id=$1', [fixture.propertyId]);
    await c.query('DELETE FROM users WHERE property_id=$1 AND id=$2', [fixture.propertyId, fixture.userId]);
    await c.query('DELETE FROM role_permissions WHERE role_id=$1', [fixture.roleId]);
    await c.query('DELETE FROM roles WHERE property_id=$1 AND id=$2', [fixture.propertyId, fixture.roleId]);
    await c.query('DELETE FROM properties WHERE id=$1', [fixture.propertyId]);
    await c.query('COMMIT');
    console.log('[CLEANUP] fixture dihapus.');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (rb) { e.discardClient = true; problem('cleanup rollback', rb); }
    fixture.preserve = true;
    throw e;
  }
}

// ─── Residue ─────────────────────────────────────────────────────────────
async function residue(c) {
  const p = fixture.propertyId;
  const checks = [
    ['pos_orders', 'SELECT COUNT(*)::int AS n FROM pos_orders WHERE property_id=$1', [p]],
    ['pos_order_items', 'SELECT COUNT(*)::int AS n FROM pos_order_items WHERE order_id IN (SELECT id FROM pos_orders WHERE property_id=$1)', [p]],
    ['pos_settlements', 'SELECT COUNT(*)::int AS n FROM pos_settlements WHERE property_id=$1', [p]],
    ['transactions', 'SELECT COUNT(*)::int AS n FROM transactions WHERE property_id=$1', [p]],
    ['audit_logs', 'SELECT COUNT(*)::int AS n FROM audit_logs WHERE property_id=$1', [p]],
    ['pos_menu_items', 'SELECT COUNT(*)::int AS n FROM pos_menu_items WHERE property_id=$1', [p]],
    ['pos_menu_categories', 'SELECT COUNT(*)::int AS n FROM pos_menu_categories WHERE property_id=$1', [p]],
    ['users', 'SELECT COUNT(*)::int AS n FROM users WHERE property_id=$1 AND id=$2', [p, fixture.userId]],
    ['roles', 'SELECT COUNT(*)::int AS n FROM roles WHERE property_id=$1 AND id=$2', [p, fixture.roleId]],
    ['role_permissions', 'SELECT COUNT(*)::int AS n FROM role_permissions WHERE role_id=$1', [fixture.roleId]],
    ['properties', 'SELECT COUNT(*)::int AS n FROM properties WHERE id=$1', [p]],
  ];
  for (const [label, sql, params] of checks) {
    const n = Number((await c.query(sql, params)).rows[0].n);
    check('Residue ' + label + '=0', n === 0);
  }
}

function release(c, label, discard = false) {
  if (c) try { c.release(discard); } catch (e) { problem(label + ' release', e); }
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  let c = null, server = null, verified = false;
  console.log('[POS RECEIPT CANONICAL SERIALIZATION TEST] oak_minibar_test @ 127.0.0.1:15434');
  const TOTAL = '45000';
  const DISCOUNT = '5000';
  const CASH_RECEIVED = '50000';
  const CHANGE_DUE = '5000';
  const UNIT_PRICE = '25000';

  try {
    c = await pool.connect();
    await identity(c);
    verified = true;
    console.log('[IDENTITY] terverifikasi.');

    await createFixtures(c);

    // C2: bukti DB raw — numeric(12,2) mengembalikan string dengan 2 decimal
    const rawCheck = (await c.query(
      `SELECT total_amount::text AS total,
              (SELECT amount::text FROM pos_settlements WHERE pos_order_id = $1 LIMIT 1) AS settlement_amt,
              (SELECT cash_received::text FROM pos_settlements WHERE pos_order_id = $1 LIMIT 1) AS cash,
              (SELECT change_due::text FROM pos_settlements WHERE pos_order_id = $1 LIMIT 1) AS change_due,
              (SELECT net_amount::text FROM transactions WHERE id = $2 LIMIT 1) AS net
       FROM pos_orders WHERE id = $1`,
      [fixture.orderId, fixture.transactionId],
    )).rows[0];
    check('C2 DB raw total_amount="45000.00" (numeric scale 2)', rawCheck.total === TOTAL + '.00');
    check('C2 DB raw settlement.amount="45000.00"', rawCheck.settlement_amt === TOTAL + '.00');
    check('C2 DB raw cash_received="50000.00"', rawCheck.cash === CASH_RECEIVED + '.00');
    check('C2 DB raw change_due="5000.00"', rawCheck.change_due === CHANGE_DUE + '.00');
    check('C2 DB raw net_amount="45000" (bigint, tanpa decimal)', rawCheck.net === TOTAL);

    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    console.log('[SERVER] listening @ ' + port);

    // C1: canonical triple amounts in response
    console.log('\n-- C1: response whole-rupiah canonical --');
    const r1 = await getReceipt(port, fixture.orderId, fixture.propertyId, fixture.token);
    check('C1 HTTP 200', r1.status === 200);
    check('C1 body.status=SUCCESS', r1.body && r1.body.status === 'SUCCESS');
    if (r1.status !== 200) console.error('[C1 RESPONSE]', JSON.stringify(r1.body, null, 2));
    const d1 = r1.body && r1.body.data;
    check('C1 order.total_amount="45000"', d1 && d1.order.total_amount === TOTAL);
    check('C1 settlement.amount="45000"', d1 && d1.settlement.amount === TOTAL);
    check('C1 sale.net_amount="45000"', d1 && d1.sale.net_amount === TOTAL);
    check('C1 triple EXACT equal (string)', d1 &&
      d1.order.total_amount === d1.settlement.amount && d1.order.total_amount === d1.sale.net_amount);
    check('C1 tidak ada format "45000.00" di triple amount', d1 &&
      d1.order.total_amount !== TOTAL + '.00' &&
      d1.settlement.amount !== TOTAL + '.00' &&
      d1.sale.net_amount !== TOTAL + '.00');

    // C3: item fields
    check('C3 item.unit_price="25000"', d1 && d1.items && d1.items[0].unit_price === UNIT_PRICE);
    check('C3 item.discount_amount="5000"', d1 && d1.items && d1.items[0].discount_amount === DISCOUNT);

    // C4: settlement secondary fields
    check('C4 settlement.cash_received="50000"', d1 && d1.settlement.cash_received === CASH_RECEIVED);
    check('C4 settlement.change_due="5000"', d1 && d1.settlement.change_due === CHANGE_DUE);

    // C7: discount_value semantics — order fixture sets discount_value NULL
    // (NOMINAL discount carried by discount_amount only).  PERCENT value is
    // never canonicalized (e.g. "10.50" stays "10.50").
    check('C7 order.discount_type=NOMINAL', d1 && d1.order.discount_type === 'NOMINAL');
    check('C7 order.discount_amount="5000" (canonical, dari "5000.00")', d1 && d1.order.discount_amount === DISCOUNT);
    check('C7 order.discount_value=null (fixture NULL; PERCENT tidak akan dinormalisasi)', d1 && d1.order.discount_value === null);

    // C5: mismatch tetap fail-closed (settlement.amount 45000 vs order.total 45000 vs tx.net 50000)
    console.log('\n-- C5: amount mismatch tetap fail-closed --');
    await c.query(
      `UPDATE transactions SET net_amount = 50000 WHERE id=$1`,
      [fixture.transactionId],
    );
    const r5 = await getReceipt(port, fixture.orderId, fixture.propertyId, fixture.token);
    check('C5 HTTP 500', r5.status === 500);
    check('C5 code=RECEIPT_INTEGRITY_ERROR', r5.body && r5.body.code === 'RECEIPT_INTEGRITY_ERROR');
    check('C5 tanpa data', !r5.body || !r5.body.data);
    check('C5 message menyebut mismatch', r5.body && /mismatch|equal/i.test(String(r5.body.message)));
    await c.query(
      `UPDATE transactions SET net_amount = $1 WHERE id=$2`,
      [TOTAL, fixture.transactionId],
    );

    // C6: secondary monetary field desimal → integrity error
    console.log('\n-- C6: decimal secondary monetary field rejected --');
    await c.query(
      `UPDATE pos_settlements SET cash_received = 45000.50 WHERE id=$1 AND property_id=$2`,
      [fixture.settlementId, fixture.propertyId],
    );
    const r6 = await getReceipt(port, fixture.orderId, fixture.propertyId, fixture.token);
    check('C6 HTTP 500', r6.status === 500);
    check('C6 code=RECEIPT_INTEGRITY_ERROR', r6.body && r6.body.code === 'RECEIPT_INTEGRITY_ERROR');
    check('C6 message menyebut cash_received', r6.body && /cash_received/.test(String(r6.body.message)));
    // restore — set NULL (dual-valid: non-cash path), C1 fixture tetap CASH 50000
    await c.query(
      `UPDATE pos_settlements SET cash_received = NULL, change_due = NULL WHERE id=$1 AND property_id=$2`,
      [fixture.settlementId, fixture.propertyId],
    );
    const r6b = await getReceipt(port, fixture.orderId, fixture.propertyId, fixture.token);
    check('C6b setelah restore HTTP 200', r6b.status === 200);
    check('C6b cash_received=null (non-cash path tetap valid)', r6b.body && r6b.body.data && r6b.body.data.settlement.cash_received === null);
    check('C6b change_due=null', r6b.body && r6b.body.data && r6b.body.data.settlement.change_due === null);

  } catch (e) {
    problem('main', e);
  } finally {
    if (server) try {
      await new Promise((resolve, reject) => server.close(e2 => e2 ? reject(e2) : resolve()));
    } catch (e2) { problem('server.close', e2); }

    release(c, 'main', true);
    c = null;

    if (verified) {
      let cc = null;
      let cleanupErr = null;
      try {
        cc = await pool.connect();
        await identity(cc);
        await clean(cc);
      } catch (e2) {
        cleanupErr = e2;
        problem('cleanup', e2);
      } finally {
        release(cc, 'cleanup', Boolean(cleanupErr && cleanupErr.discardClient));
      }

      let rc = null;
      try {
        rc = await pool.connect();
        await identity(rc);
        await residue(rc);
      } catch (e2) { problem('residue', e2); } finally { release(rc, 'residue'); }
    }

    try { await pool.end(); } catch (e2) { problem('pool.end', e2); }
  }

  console.log('\n[RESULT] ' + passed + ' PASS, ' + failures.length + ' FAIL');
  for (const f of failures) console.error('  - ' + f);
  if (!failures.length) console.log('[CLEANUP/RESIDUE] 0 - seluruh fixture bersih.');
  process.exitCode = failures.length ? 1 : 0;
}

main().catch(e => {
  console.error('[CRASH]', e.message);
  process.exitCode = 1;
});
