/** POS RECIPT ENDPOINT TEST  S1 happy path CASH receipt. Disposable oak_minibar_test ONLY; no dotenv reads. */
'use strict';
const crypto = require('crypto');
const run = crypto.randomBytes(6).toString('hex');

//  DB Safety Guard
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

//  Load production app & services
const { app, pool } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const { setRoleAccess, ACCESS_RESOURCES } = require('../dist/domains/settings/accessControlService');
const http = require('http');

//  Test state
const failures = [];
let passed = 0;
const fixture = {
  propertyId: 0,
  roleId: 0,
  userId: 0,
  categoryId: 0,
  menuItemId: 0,
  orderId: 0,
  itemId: 0,
  settlementId: 0,
  transactionId: 0,
  token: '',
  preserve: false,
};

function check(label, cond) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failures.push(label); console.error('  FAIL  ' + label); }
}
function posViewGrid() {
  const grid = {};
  for (const r of ACCESS_RESOURCES) {
    grid[r.key] = { view: false, edit: false, delete: false };
  }
  grid.POS = { view: true, edit: false, delete: false };
  return grid;
}
function problem(label, e) {
  failures.push(label + ': ' + String(e && e.message || e));
  console.error('[ERROR] ' + failures[failures.length - 1]);
}

//  Identity guard
async function identity(c) {
  for (const k of ['host', 'port', 'user', 'database']) {
    if (String(pool.options[k]) !== String(target[k]))
      throw new Error('pool.options tidak sesuai: ' + k);
  }
  const r = (await c.query('SELECT current_database() AS db, current_user AS usr')).rows[0];
  if (r.db !== target.database || r.usr !== target.user)
    throw new Error('identitas DB tidak sesuai');
}

//  Fixture creation
async function createFixtures(c) {
  // 1. Property
  const propRow = (await c.query(
    `INSERT INTO properties(name, property_code, address, phone, timezone, currency_code, currency, is_active)
     VALUES($1,$2,'Jl. Fixture Test 1','+622112345678','Asia/Jakarta','IDR','IDR',TRUE)
     RETURNING id`,
    ['Receipt S1 ' + run, crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6)],
  )).rows[0];
  fixture.propertyId = Number(propRow.id);

  // 2. Property branding (optional  table may exist)
  try {
    await c.query(
      `INSERT INTO property_brandings(property_id, display_name, short_name, primary_color, accent_color)
       VALUES($1,'OAK Test Hotel','OT','#1b4332','#c5a880')`,
      [fixture.propertyId],
    );
  } catch (e) {
    // Table may not exist  not critical for S1
    console.log('  INFO  property_brandings insert skipped: ' + e.message);
  }

  // 3. Role (property-scoped, is_test_data=TRUE)
  const roleRow = (await c.query(
    `INSERT INTO roles(property_id, name, is_active, is_system_role, is_test_data)
     VALUES($1,$2,TRUE,FALSE,TRUE) RETURNING id`,
    [fixture.propertyId, 'Receipt S1 ' + run],
  )).rows[0];
  fixture.roleId = Number(roleRow.id);

  await setRoleAccess(
    c,
    fixture.propertyId,
    fixture.roleId,
    posViewGrid(),
    {
      id: 0,
      name: 'Receipt S1 RBAC fixture',
      property_id: fixture.propertyId,
      is_platform_super_admin: false,
    },
  );

  // 4. User with JWT (no password needed  generateToken directly)
  const userRow = (await c.query(
    `INSERT INTO users(property_id, role_id, username, email, full_name, is_active, is_test_data,
      account_status, must_change_password, access_type)
     VALUES($1,$2,$3,$4,$5,TRUE,TRUE,'READY',FALSE,'PMS_STAFF') RETURNING id`,
    [
      fixture.propertyId,
      fixture.roleId,
      'receipt_s1_' + run,
      'receipt_s1_' + run + '@test.local',
      'Receipt S1 Fixture',
    ],
  )).rows[0];
  fixture.userId = Number(userRow.id);

  const payload = {
    id: fixture.userId,
    property_id: fixture.propertyId,
    role_id: fixture.roleId,
    username: 'receipt_s1_' + run,
    email: 'receipt_s1_' + run + '@test.local',
    full_name: 'Receipt S1 Fixture',
    role: 'Fixture',
    scope: 'FULL',
    account_status: 'READY',
    must_change_password: false,
    access_type: 'PMS_STAFF',
  };
  fixture.token = generateToken(payload);

  // 5. Menu category
  const catRow = (await c.query(
    `INSERT INTO pos_menu_categories(property_id, name) VALUES($1,'S1 ' || $2) RETURNING id`,
    [fixture.propertyId, run],
  )).rows[0];
  fixture.categoryId = Number(catRow.id);

  // 6. Menu item
  const itemRow = (await c.query(
    `INSERT INTO pos_menu_items(property_id, category_id, item_code, name, price, is_active)
     VALUES($1,$2,'NG-001','Nasi Goreng Original',15000,TRUE) RETURNING id`,
    [fixture.propertyId, fixture.categoryId],
  )).rows[0];
  fixture.menuItemId = Number(itemRow.id);

  // 7. POS Order (PAID)
  const totalAmount = 30000; // 2  15000, whole rupiah
  const orderRow = (await c.query(
    `INSERT INTO pos_orders(property_id, order_number, guest_name, guest_phone, table_number, status, total_amount, notes)
     VALUES($1,$2,'Tamu S1','+628123456789','T-1','PAID',$3,'S1 test note')
     RETURNING id`,
    [fixture.propertyId, 'ORD-S1-' + run, totalAmount],
  )).rows[0];
  fixture.orderId = Number(orderRow.id);

  // 8. Order item with immutable snapshot
  const orderItemRow = (await c.query(
    `INSERT INTO pos_order_items(order_id, menu_item_id, quantity, unit_price,
      item_name_snapshot, item_code_snapshot)
     VALUES($1,$2,2,15000,'Nasi Goreng Original','NG-001')
     RETURNING id`,
    [fixture.orderId, fixture.menuItemId],
  )).rows[0];
  fixture.itemId = Number(orderItemRow.id);

  // 9. SALE transaction (canonical)
  const txNo = 'TX-S1-' + run;
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
       'POS','POS Fixture','POS Receipt S1 Fixture',
       $4,0,0,0,$4,
       'PAID','CASH','POSTED')
     RETURNING id`,
    [fixture.propertyId, txNo, String(fixture.orderId), totalAmount],
  )).rows[0];
  fixture.transactionId = String(txRow.id); // BIGINT  string

  // 10. Settlement (SUCCESS, CASH)
  const cashReceived = 50000;
  const changeDue = 20000;
  const settlementRow = (await c.query(
    `INSERT INTO pos_settlements(
       property_id, pos_order_id, transaction_id,
       amount, payment_method, status,
       idempotency_key, request_fingerprint,
       created_by, cash_received, change_due, payment_reference
     )
     VALUES($1,$2,$3,$4,'CASH','SUCCESS',$5,$6,'receipt_s1_test',$7,$8,$9)
     RETURNING id`,
    [
      fixture.propertyId,
      fixture.orderId,
      fixture.transactionId,
      totalAmount,
      'idem-s1-' + run,
      'fp-s1-' + run,
      cashReceived,
      changeDue,
      'REF-S1-' + run,
    ],
  )).rows[0];
  fixture.settlementId = Number(settlementRow.id);

  console.log('[FIXTURE] semua fixture dibuat: property=' + fixture.propertyId +
    ' role=' + fixture.roleId + ' user=' + fixture.userId +
    ' order=' + fixture.orderId + ' tx=' + fixture.transactionId +
    ' settlement=' + fixture.settlementId);
}

//  Read-only count snapshot
async function tableCounts(c) {
  const p = fixture.propertyId;
  const results = {};
  const tables = [
    ['pos_orders', 'property_id'],
    ['pos_order_items', null], // filtered via order_id subquery
    ['pos_settlements', 'property_id'],
    ['transactions', 'property_id'],
    ['audit_logs', 'property_id'],
    ['payment_transactions', 'property_id'],
    ['folio_entries', 'property_id'],
  ];
  for (const [table, scopeCol] of tables) {
    let sql;
    if (table === 'pos_order_items') {
      sql = `SELECT COUNT(*)::int AS n FROM pos_order_items WHERE order_id IN
               (SELECT id FROM pos_orders WHERE property_id = $1)`;
    } else {
      sql = `SELECT COUNT(*)::int AS n FROM ${table} WHERE property_id = $1`;
    }
    results[table] = Number((await c.query(sql, [p])).rows[0].n);
  }
  return results;
}

//  HTTP request helper
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

//  Cleanup
async function clean(c) {
  if (fixture.preserve) return;
  await c.query('BEGIN');
  try {
    // Settlement first (FK to transaction, order, property)
    await c.query('DELETE FROM pos_settlements WHERE property_id=$1', [fixture.propertyId]);
    // Order items (FK to order)
    await c.query('DELETE FROM pos_order_items WHERE order_id=$1', [fixture.orderId]);
    // Order
    await c.query('DELETE FROM pos_orders WHERE property_id=$1', [fixture.propertyId]);
    // Transaction
    await c.query('DELETE FROM transactions WHERE property_id=$1', [fixture.propertyId]);
    // Audit logs created by RBAC fixture setup
    await c.query('DELETE FROM audit_logs WHERE property_id=$1', [fixture.propertyId]);
    // Menu
    await c.query('DELETE FROM pos_menu_items WHERE property_id=$1', [fixture.propertyId]);
    await c.query('DELETE FROM pos_menu_categories WHERE property_id=$1', [fixture.propertyId]);
    // Branding
    await c.query('DELETE FROM property_brandings WHERE property_id=$1', [fixture.propertyId]);
    // User & role
    await c.query('DELETE FROM users WHERE property_id=$1 AND id=$2', [fixture.propertyId, fixture.userId]);
    await c.query('DELETE FROM role_permissions WHERE role_id=$1', [fixture.roleId]);
    await c.query('DELETE FROM roles WHERE property_id=$1 AND id=$2', [fixture.propertyId, fixture.roleId]);
    // Property last (FK constraint)
    await c.query('DELETE FROM properties WHERE id=$1', [fixture.propertyId]);
    await c.query('COMMIT');
    console.log('[CLEANUP] fixture dihapus.');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (rb) { e.discardClient = true; problem('cleanup rollback', rb); }
    fixture.preserve = true;
    throw e;
  }
}

//  Residue check
async function residue(c) {
  const p = fixture.propertyId;
  const checks = [
    ['pos_orders', 'SELECT COUNT(*)::int AS n FROM pos_orders WHERE property_id=$1', [p]],
    ['pos_order_items', 'SELECT COUNT(*)::int AS n FROM pos_order_items WHERE order_id IN (SELECT id FROM pos_orders WHERE property_id=$1)', [p]],
    ['pos_settlements', 'SELECT COUNT(*)::int AS n FROM pos_settlements WHERE property_id=$1', [p]],
    ['transactions', 'SELECT COUNT(*)::int AS n FROM transactions WHERE property_id=$1', [p]],
    ['audit_logs', 'SELECT COUNT(*)::int AS n FROM audit_logs WHERE property_id=$1', [p]],
    ['payment_transactions', 'SELECT COUNT(*)::int AS n FROM payment_transactions WHERE property_id=$1', [p]],
    ['folio_entries', 'SELECT COUNT(*)::int AS n FROM folio_entries WHERE property_id=$1', [p]],
    ['pos_menu_items', 'SELECT COUNT(*)::int AS n FROM pos_menu_items WHERE property_id=$1', [p]],
    ['pos_menu_categories', 'SELECT COUNT(*)::int AS n FROM pos_menu_categories WHERE property_id=$1', [p]],
    ['property_brandings', 'SELECT COUNT(*)::int AS n FROM property_brandings WHERE property_id=$1', [p]],
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

//  Release helper
function release(c, label, discard = false) {
  if (c) try { c.release(discard); } catch (e) { problem(label + ' release', e); }
}

//  Main
async function main() {
  let c = null, server = null, verified = false;
  console.log('[POS RECEIPT ENDPOINT TEST  S1] oak_minibar_test/minibar_test @ 127.0.0.1:15434');
  try {
    c = await pool.connect();
    await identity(c);
    verified = true;
    console.log('[IDENTITY] terverifikasi.');

    // Create all fixtures
    await createFixtures(c);

    // Start HTTP server
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    console.log('[SERVER] listening @ ' + port);

    //  S1: Happy path CASH receipt
    console.log('\n S1: Happy path CASH receipt ');

    // Read-only: capture table counts BEFORE
    const before = await tableCounts(c);

    // GET receipt
    const r = await getReceipt(port, fixture.orderId, fixture.propertyId, fixture.token);

    // HTTP 200 & body.status = SUCCESS
    check('S1 HTTP 200', r.status === 200);
    check('S1 body.status=SUCCESS', r.body && r.body.status === 'SUCCESS');

    if (r.status !== 200 || !r.body || r.body.status !== 'SUCCESS') {
      console.error('[S1 RESPONSE]', JSON.stringify({
        http_status: r.status,
        body: r.body,
      }, null, 2));
    }

    // Property fields
    const data = r.body && r.body.data ? r.body.data : null;
    check('S1 property.id', data && data.property && data.property.id === fixture.propertyId);
    check('S1 property.name', data && data.property && data.property.name.includes('Receipt S1'));
    check('S1 property.property_code=6char', data && data.property && typeof data.property.property_code === 'string' && data.property.property_code.length === 6);
    check('S1 property.address', data && data.property && data.property.address === 'Jl. Fixture Test 1');
    check('S1 property.phone', data && data.property && data.property.phone === '+622112345678');
    check('S1 property.currency=IDR', data && data.property && (data.property.currency === 'IDR'));

    // Branding (optional  check if present)
    if (data && data.property && data.property.branding) {
      check('S1 branding.display_name', data.property.branding.display_name === 'OAK Test Hotel');
      check('S1 branding.primary_color', data.property.branding.primary_color === '#1b4332');
    } else {
      console.log('  INFO  branding tidak ada (tabel/fixture mungkin belum tersedia)');
    }

    // Order fields
    check('S1 order.id', data.order && Number(data.order.id) === fixture.orderId);
    check('S1 order.status=PAID', data.order && data.order.status === 'PAID');
    check('S1 order.order_number', data.order && data.order.order_number === 'ORD-S1-' + run);
    check('S1 order.guest_name', data.order && data.order.guest_name === 'Tamu S1');
    check('S1 order.guest_phone', data.order && data.order.guest_phone === '+628123456789');
    check('S1 order.table_number', data.order && data.order.table_number === 'T-1');
    check('S1 order.notes', data.order && data.order.notes === 'S1 test note');

    // Triple amount integrity
    const orderTotal = Number(data.order.total_amount);
    const settlementAmount = Number(data.settlement.amount);
    const saleNetAmount = Number(data.sale.net_amount);
    check('S1 order.total_amount=30000', orderTotal === 30000);
    check('S1 settlement.amount=30000', settlementAmount === 30000);
    check('S1 sale.net_amount=30000', saleNetAmount === 30000);
    check('S1 triple amount EXACT', orderTotal === settlementAmount && orderTotal === saleNetAmount);

    // Items  immutable snapshot
    check('S1 items.length=1', data.items && data.items.length === 1);
    if (data.items && data.items.length === 1) {
      const item = data.items[0];
      check('S1 item.item_name_snapshot', item.item_name_snapshot === 'Nasi Goreng Original');
      check('S1 item.item_code_snapshot', item.item_code_snapshot === 'NG-001');
      check('S1 item.quantity=2', Number(item.quantity) === 2);
      check('S1 item.unit_price=15000', Number(item.unit_price) === 15000);
    }

    // Settlement fields
    check('S1 settlement.payment_method=CASH', data.settlement && data.settlement.payment_method === 'CASH');
    check('S1 settlement.status=SUCCESS', data.settlement && data.settlement.status === 'SUCCESS');
    check('S1 settlement.cash_received=50000', data.settlement && Number(data.settlement.cash_received) === 50000);
    check('S1 settlement.change_due=20000', data.settlement && Number(data.settlement.change_due) === 20000);
    check('S1 settlement.payment_reference', data.settlement && data.settlement.payment_reference === 'REF-S1-' + run);
    check('S1 settlement.created_by', data.settlement && data.settlement.created_by === 'receipt_s1_test');

    // Sale transaction
    check('S1 sale.transaction_type=SALE', data.sale && data.sale.transaction_type === 'SALE');
    check('S1 sale.source_type=POS_ORDER', data.sale && data.sale.source_type === 'POS_ORDER');
    check('S1 sale.source_id=orderId', data.sale && data.sale.source_id === String(fixture.orderId));
    check('S1 sale.payment_status=PAID', data.sale && data.sale.payment_status === 'PAID');
    check('S1 sale.payment_method=CASH', data.sale && data.sale.payment_method === 'CASH');
    check('S1 sale.transaction_no', data.sale && data.sale.transaction_no === 'TX-S1-' + run);
    check('S1 sale.id=string', data.sale && typeof data.sale.id === 'string');

    // Read-only: table counts unchanged
    const after = await tableCounts(c);
    for (const table of Object.keys(before)) {
      check('S1 read-only ' + table + ' unchanged (' + before[table] + ')', after[table] === before[table]);
    }

    // Second GET (reprint proof)  counts must still be unchanged
    const r2 = await getReceipt(port, fixture.orderId, fixture.propertyId, fixture.token);
    check('S1 reprint HTTP 200', r2.status === 200);
    check('S1 reprint body.status=SUCCESS', r2.body && r2.body.status === 'SUCCESS');
    const after2 = await tableCounts(c);
    for (const table of Object.keys(before)) {
      check('S1 reprint ' + table + ' unchanged', after2[table] === before[table]);
    }

    // S2: OPEN order must not expose receipt
    console.log('\n-- S2: OPEN order receipt rejected --');
    await c.query(
      `UPDATE pos_orders
       SET status='OPEN'
       WHERE id=$1 AND property_id=$2`,
      [fixture.orderId, fixture.propertyId],
    );

    const s2 = await getReceipt(
      port,
      fixture.orderId,
      fixture.propertyId,
      fixture.token,
    );

    check('S2 HTTP 409', s2.status === 409);
    check(
      'S2 code=RECEIPT_NOT_AVAILABLE',
      s2.body && s2.body.code === 'RECEIPT_NOT_AVAILABLE',
    );
    check('S2 tanpa data receipt', !s2.body || !s2.body.data);

    await c.query(
      `UPDATE pos_orders
       SET status='PAID'
       WHERE id=$1 AND property_id=$2`,
      [fixture.orderId, fixture.propertyId],
    );

    // S3: PAID order without successful settlement must not expose receipt
    console.log('\n-- S3: PAID order without settlement rejected --');

    const settlementBackup = (await c.query(
      `SELECT
         transaction_id,
         amount,
         payment_method,
         status,
         created_by,
         cash_received,
         change_due,
         payment_reference,
         verified_by,
         verified_at
       FROM pos_settlements
       WHERE id=$1 AND property_id=$2`,
      [fixture.settlementId, fixture.propertyId],
    )).rows[0];

    if (!settlementBackup) {
      throw new Error('S3 settlement backup tidak ditemukan');
    }

    await c.query(
      `DELETE FROM pos_settlements
       WHERE id=$1 AND property_id=$2`,
      [fixture.settlementId, fixture.propertyId],
    );

    const s3 = await getReceipt(
      port,
      fixture.orderId,
      fixture.propertyId,
      fixture.token,
    );

    check('S3 HTTP 409', s3.status === 409);
    check(
      'S3 code=RECEIPT_NOT_AVAILABLE',
      s3.body && s3.body.code === 'RECEIPT_NOT_AVAILABLE',
    );
    check('S3 tanpa data receipt', !s3.body || !s3.body.data);

    const restoredSettlement = (await c.query(
      `INSERT INTO pos_settlements(
         property_id,
         pos_order_id,
         transaction_id,
         amount,
         payment_method,
         status,
         idempotency_key,
         request_fingerprint,
         created_by,
         cash_received,
         change_due,
         payment_reference,
         verified_by,
         verified_at
       )
       VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
       )
       RETURNING id`,
      [
        fixture.propertyId,
        fixture.orderId,
        settlementBackup.transaction_id,
        settlementBackup.amount,
        settlementBackup.payment_method,
        settlementBackup.status,
        'idem-s3-restore-' + run,
        'fp-s3-restore-' + run,
        settlementBackup.created_by,
        settlementBackup.cash_received,
        settlementBackup.change_due,
        settlementBackup.payment_reference,
        settlementBackup.verified_by,
        settlementBackup.verified_at,
      ],
    )).rows[0];

    fixture.settlementId = Number(restoredSettlement.id);

    // S4: amount mismatch must be treated as receipt integrity failure
    console.log('\n-- S4: Amount mismatch rejected --');

    await c.query(
      `UPDATE pos_settlements
       SET amount = amount + 1000
       WHERE id=$1 AND property_id=$2`,
      [fixture.settlementId, fixture.propertyId],
    );

    const s4 = await getReceipt(
      port,
      fixture.orderId,
      fixture.propertyId,
      fixture.token,
    );

    check('S4 HTTP 500', s4.status === 500);
    check(
      'S4 code=RECEIPT_INTEGRITY_ERROR',
      s4.body && s4.body.code === 'RECEIPT_INTEGRITY_ERROR',
    );
    check('S4 tanpa data receipt', !s4.body || !s4.body.data);

    await c.query(
      `UPDATE pos_settlements
       SET amount = 30000
       WHERE id=$1 AND property_id=$2`,
      [fixture.settlementId, fixture.propertyId],
    );

    // S5: settlement and SALE payment methods must match
    console.log('\n-- S5: Payment method mismatch rejected --');

    await c.query(
      `UPDATE transactions
       SET payment_method='QRIS'
       WHERE id=$1 AND property_id=$2`,
      [fixture.transactionId, fixture.propertyId],
    );

    const s5 = await getReceipt(
      port,
      fixture.orderId,
      fixture.propertyId,
      fixture.token,
    );

    check('S5 HTTP 500', s5.status === 500);
    check(
      'S5 code=RECEIPT_INTEGRITY_ERROR',
      s5.body && s5.body.code === 'RECEIPT_INTEGRITY_ERROR',
    );
    check('S5 tanpa data receipt', !s5.body || !s5.body.data);

    await c.query(
      `UPDATE transactions
       SET payment_method='CASH'
       WHERE id=$1 AND property_id=$2`,
      [fixture.transactionId, fixture.propertyId],
    );

    // S6: SALE source must point back to the same POS order
    console.log('\n-- S6: SALE source mismatch rejected --');

    await c.query(
      `UPDATE transactions
       SET source_id = '999999999'
       WHERE id=$1 AND property_id=$2`,
      [fixture.transactionId, fixture.propertyId],
    );

    const s6 = await getReceipt(
      port,
      fixture.orderId,
      fixture.propertyId,
      fixture.token,
    );

    check('S6 HTTP 500', s6.status === 500);
    check(
      'S6 code=RECEIPT_INTEGRITY_ERROR',
      s6.body && s6.body.code === 'RECEIPT_INTEGRITY_ERROR',
    );
    check('S6 tanpa data receipt', !s6.body || !s6.body.data);

    await c.query(
      `UPDATE transactions
       SET source_id=$3
       WHERE id=$1 AND property_id=$2`,
      [fixture.transactionId, fixture.propertyId, fixture.orderId],
    );

    // S7: nonexistent order in a valid property must return 404
    console.log('\n-- S7: Order not found --');

    const s7 = await getReceipt(
      port,
      fixture.orderId + 999999,
      fixture.propertyId,
      fixture.token,
    );

    check('S7 HTTP 404', s7.status === 404);
    check(
      'S7 code=ORDER_NOT_FOUND',
      s7.body && s7.body.code === 'ORDER_NOT_FOUND',
    );
    check('S7 tanpa data receipt', !s7.body || !s7.body.data);

    // S8: invalid non-numeric order id must be rejected
    console.log('\n-- S8: Invalid order id --');

    const s8 = await getReceipt(
      port,
      'abc',
      fixture.propertyId,
      fixture.token,
    );

    check('S8 HTTP 400', s8.status === 400);
    check(
      'S8 code=VALIDATION_ERROR',
      s8.body && s8.body.code === 'VALIDATION_ERROR',
    );
    check('S8 tanpa data receipt', !s8.body || !s8.body.data);

    // S9: invalid property_id must be rejected
    console.log('\n-- S9: Invalid property_id --');

    const s9 = await getReceipt(
      port,
      fixture.orderId,
      0,
      fixture.token,
    );

    check('S9 HTTP 400', s9.status === 400);
    check(
      'S9 code=VALIDATION_ERROR',
      s9.body && s9.body.code === 'VALIDATION_ERROR',
    );
    check('S9 tanpa data receipt', !s9.body || !s9.body.data);

    // S10: cross-property request must be rejected before scoped order read
    console.log('\n-- S10: Cross-property scope rejected --');

    const s10 = await getReceipt(
      port,
      fixture.orderId,
      fixture.propertyId + 999999,
      fixture.token,
    );

    check('S10 HTTP 403', s10.status === 403);
    check(
      'S10 code=PROPERTY_SCOPE_REQUIRED',
      s10.body && s10.body.code === 'PROPERTY_SCOPE_REQUIRED',
    );
    check('S10 tanpa data receipt', !s10.body || !s10.body.data);

    // S11: QRIS paid receipt exposes non-CASH settlement metadata
    console.log('\n-- S11: QRIS receipt happy path --');

    const qrisReference = 'QRIS-REF-S11-' + run;
    const qrisVerifier = 'receipt_qris_verifier';

    await c.query(
      `UPDATE transactions
       SET payment_method='QRIS'
       WHERE id=$1 AND property_id=$2`,
      [fixture.transactionId, fixture.propertyId],
    );

    await c.query(
      `UPDATE pos_settlements
       SET payment_method='QRIS',
           cash_received=NULL,
           change_due=NULL,
           payment_reference=$1,
           verified_by=$2,
           verified_at=NOW()
       WHERE id=$3 AND property_id=$4`,
      [
        qrisReference,
        qrisVerifier,
        fixture.settlementId,
        fixture.propertyId,
      ],
    );

    const s11 = await getReceipt(
      port,
      fixture.orderId,
      fixture.propertyId,
      fixture.token,
    );

    check('S11 HTTP 200', s11.status === 200);
    check('S11 body.status=SUCCESS', s11.body && s11.body.status === 'SUCCESS');

    const s11Data = s11.body && s11.body.data;

    check(
      'S11 settlement.payment_method=QRIS',
      s11Data &&
      s11Data.settlement &&
      s11Data.settlement.payment_method === 'QRIS',
    );

    check(
      'S11 sale.payment_method=QRIS',
      s11Data &&
      s11Data.sale &&
      s11Data.sale.payment_method === 'QRIS',
    );

    check(
      'S11 settlement.cash_received=null',
      s11Data &&
      s11Data.settlement &&
      s11Data.settlement.cash_received == null,
    );

    check(
      'S11 settlement.change_due=null',
      s11Data &&
      s11Data.settlement &&
      s11Data.settlement.change_due == null,
    );

    check(
      'S11 settlement.payment_reference',
      s11Data &&
      s11Data.settlement &&
      s11Data.settlement.payment_reference === qrisReference,
    );

    check(
      'S11 settlement.verified_by',
      s11Data &&
      s11Data.settlement &&
      s11Data.settlement.verified_by === qrisVerifier,
    );

    check(
      'S11 settlement.verified_at',
      s11Data &&
      s11Data.settlement &&
      typeof s11Data.settlement.verified_at === 'string' &&
      s11Data.settlement.verified_at.length > 0,
    );

    // S12: TRANSFER paid receipt exposes non-CASH settlement metadata
    console.log('\n-- S12: TRANSFER receipt happy path --');

    const transferReference = 'TRF-REF-S12-' + run;
    const transferVerifier = 'receipt_transfer_verifier';

    await c.query(
      `UPDATE transactions
       SET payment_method='TRANSFER'
       WHERE id=$1 AND property_id=$2`,
      [fixture.transactionId, fixture.propertyId],
    );

    await c.query(
      `UPDATE pos_settlements
       SET payment_method='TRANSFER',
           cash_received=NULL,
           change_due=NULL,
           payment_reference=$1,
           verified_by=$2,
           verified_at=NOW()
       WHERE id=$3 AND property_id=$4`,
      [
        transferReference,
        transferVerifier,
        fixture.settlementId,
        fixture.propertyId,
      ],
    );

    const s12 = await getReceipt(
      port,
      fixture.orderId,
      fixture.propertyId,
      fixture.token,
    );

    check('S12 HTTP 200', s12.status === 200);
    check('S12 body.status=SUCCESS', s12.body && s12.body.status === 'SUCCESS');

    const s12Data = s12.body && s12.body.data;

    check(
      'S12 settlement.payment_method=TRANSFER',
      s12Data &&
      s12Data.settlement &&
      s12Data.settlement.payment_method === 'TRANSFER',
    );

    check(
      'S12 sale.payment_method=TRANSFER',
      s12Data &&
      s12Data.sale &&
      s12Data.sale.payment_method === 'TRANSFER',
    );

    check(
      'S12 settlement.cash_received=null',
      s12Data &&
      s12Data.settlement &&
      s12Data.settlement.cash_received == null,
    );

    check(
      'S12 settlement.change_due=null',
      s12Data &&
      s12Data.settlement &&
      s12Data.settlement.change_due == null,
    );

    check(
      'S12 settlement.payment_reference',
      s12Data &&
      s12Data.settlement &&
      s12Data.settlement.payment_reference === transferReference,
    );

    check(
      'S12 settlement.verified_by',
      s12Data &&
      s12Data.settlement &&
      s12Data.settlement.verified_by === transferVerifier,
    );

    check(
      'S12 settlement.verified_at',
      s12Data &&
      s12Data.settlement &&
      typeof s12Data.settlement.verified_at === 'string' &&
      s12Data.settlement.verified_at.length > 0,
    );

    // S13: DEBIT paid receipt exposes non-CASH settlement metadata
    console.log('\n-- S13: DEBIT receipt happy path --');

    const debitReference = 'DEBIT-REF-S13-' + run;
    const debitVerifier = 'receipt_debit_verifier';

    await c.query(
      `UPDATE transactions
       SET payment_method='DEBIT'
       WHERE id=$1 AND property_id=$2`,
      [fixture.transactionId, fixture.propertyId],
    );

    await c.query(
      `UPDATE pos_settlements
       SET payment_method='DEBIT',
           cash_received=NULL,
           change_due=NULL,
           payment_reference=$1,
           verified_by=$2,
           verified_at=NOW()
       WHERE id=$3 AND property_id=$4`,
      [
        debitReference,
        debitVerifier,
        fixture.settlementId,
        fixture.propertyId,
      ],
    );

    const s13 = await getReceipt(
      port,
      fixture.orderId,
      fixture.propertyId,
      fixture.token,
    );

    check('S13 HTTP 200', s13.status === 200);
    check('S13 body.status=SUCCESS', s13.body && s13.body.status === 'SUCCESS');

    const s13Data = s13.body && s13.body.data;

    check(
      'S13 settlement.payment_method=DEBIT',
      s13Data &&
      s13Data.settlement &&
      s13Data.settlement.payment_method === 'DEBIT',
    );

    check(
      'S13 sale.payment_method=DEBIT',
      s13Data &&
      s13Data.sale &&
      s13Data.sale.payment_method === 'DEBIT',
    );

    check(
      'S13 settlement.cash_received=null',
      s13Data &&
      s13Data.settlement &&
      s13Data.settlement.cash_received == null,
    );

    check(
      'S13 settlement.change_due=null',
      s13Data &&
      s13Data.settlement &&
      s13Data.settlement.change_due == null,
    );

    check(
      'S13 settlement.payment_reference',
      s13Data &&
      s13Data.settlement &&
      s13Data.settlement.payment_reference === debitReference,
    );

    check(
      'S13 settlement.verified_by',
      s13Data &&
      s13Data.settlement &&
      s13Data.settlement.verified_by === debitVerifier,
    );

    check(
      'S13 settlement.verified_at',
      s13Data &&
      s13Data.settlement &&
      typeof s13Data.settlement.verified_at === 'string' &&
      s13Data.settlement.verified_at.length > 0,
    );

    // S14: zero financial amount must be rejected as receipt integrity failure
    console.log('\n-- S14: Zero amount rejected --');

    await c.query(
      `UPDATE pos_orders
       SET total_amount=0
       WHERE id=$1 AND property_id=$2`,
      [fixture.orderId, fixture.propertyId],
    );

    const s14 = await getReceipt(
      port,
      fixture.orderId,
      fixture.propertyId,
      fixture.token,
    );

    check('S14 HTTP 500', s14.status === 500);
    check(
      'S14 code=RECEIPT_INTEGRITY_ERROR',
      s14.body && s14.body.code === 'RECEIPT_INTEGRITY_ERROR',
    );
    check('S14 tanpa data receipt', !s14.body || !s14.body.data);

  } catch (e) {
    problem('main', e);
  } finally {
    if (server) try {
      await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    } catch (e) { problem('server.close', e); }

    release(c, 'main', true);
    c = null;

    if (verified) {
      let cc = null;
      let cleanupErr = null;
      try {
        cc = await pool.connect();
        await identity(cc);
        await clean(cc);
      } catch (e) {
        cleanupErr = e;
        problem('cleanup', e);
      } finally {
        release(cc, 'cleanup', Boolean(cleanupErr && cleanupErr.discardClient));
      }

      let rc = null;
      try {
        rc = await pool.connect();
        await identity(rc);
        await residue(rc);
      } catch (e) { problem('residue', e); } finally { release(rc, 'residue'); }
    }

    try { await pool.end(); } catch (e) { problem('pool.end', e); }
  }

  console.log('\n[RESULT] ' + passed + ' PASS, ' + failures.length + ' FAIL');
  for (const f of failures) console.error('  - ' + f);
  if (!failures.length) console.log('[CLEANUP/RESIDUE] 0  seluruh fixture bersih.');
  process.exitCode = failures.length ? 1 : 0;
}

main().catch(e => {
  console.error('[CRASH]', e.message);
  process.exitCode = 1;
});
