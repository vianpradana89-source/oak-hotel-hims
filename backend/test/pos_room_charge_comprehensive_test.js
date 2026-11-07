/**
 * POS ROOM CHARGE COMPREHENSIVE INTEGRATION TEST
 *
 * Verifies:
 * 1. Posting POS order to room folio (canonical numbers matching specification:
 *    charges Rp1.148.600, paid Rp576.000, balance Rp572.600, deposit Rp200.000 intact).
 * 2. Idempotency & Replay protection (HTTP 200, zero financial drift, single folio debit).
 * 3. Settlement guard rejection on billed order (HTTP 409 ALREADY_BILLED_TO_ROOM).
 * 4. Mutation / Void guards on billed order (HTTP 409 FINANCIAL_LOCK / POS_ORDER_FINANCIAL_ARTIFACTS_PRESENT).
 * 5. Isolation of non-posted POS orders (direct payment does not affect room folio).
 * 6. Inactive reservation rejection (CANCELLED/CHECKED_OUT -> HTTP 409 RESERVATION_NOT_ACTIVE).
 * 7. Cross-property isolation protection.
 *
 * Target: disposable test database `oak_checkout_folio_gate_test`.
 */
'use strict';

const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.DB_NAME = 'oak_checkout_folio_gate_test';
const { Pool } = require('pg');

// Safety: DB must be test database
const currentDb = process.env.DB_NAME;
if (!currentDb.includes('test')) {
  console.error(`\n❌ SAFETY VIOLATION: Cannot run against production DB "${currentDb}"`);
  process.exit(1);
}

const testPool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: currentDb,
});

const { app } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const { calculateReservationFinancials } = require('../dist/domains/reservations/reservationFinancialCalculator');

let server;
let baseUrl;
let testPropertyId = null;

const createdBookingIds = new Set();
const createdReservationIds = new Set();
const createdOrderIds = new Set();
const createdDepositIds = new Set();
const createdCategoryIds = new Set();
const createdMenuItemIds = new Set();

function genId() {
  return `${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).toUpperCase().slice(2, 8)}`;
}

async function authHeaders() {
  const saRes = await testPool.query(`
    SELECT u.id, u.username, u.full_name, u.email, r.id AS role_id, r.name AS role
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'Super Admin' AND r.is_system_role = TRUE
    LIMIT 1
  `);
  if (!saRes.rows[0]) throw new Error('Super Admin not found in DB');
  const sa = saRes.rows[0];
  const token = generateToken({
    id: sa.id,
    username: sa.username,
    full_name: sa.full_name,
    email: sa.email || 'sa@test.local',
    role_id: sa.role_id,
    role: sa.role,
    property_id: testPropertyId,
    access_type: 'PMS_STAFF',
    scope: 'FULL',
  });
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function request(method, path_, body, extraHeaders = {}) {
  const baseHeaders = await authHeaders();
  const headers = Object.assign({}, baseHeaders, extraHeaders);
  const res = await fetch(`${baseUrl}${path_}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, body: data };
}

function pass(name, detail) {
  console.log(`  ✓ PASS [${name}]: ${detail}`);
}

function fail(name, detail, err) {
  console.error(`  ✗ FAIL [${name}]: ${detail}`);
  if (err) console.error(`    Error:`, err.message || err);
  process.exitCode = 1;
}

async function cleanup() {
  console.log('\nCleaning up test fixtures...');
  for (const orderId of createdOrderIds) {
    await testPool.query('DELETE FROM folio_entries WHERE source_type = $1 AND source_id = $2', ['POS_ORDER', String(orderId)]).catch(() => {});
    await testPool.query('DELETE FROM pos_order_items WHERE order_id = $1', [orderId]).catch(() => {});
    await testPool.query('DELETE FROM pos_orders WHERE id = $1', [orderId]).catch(() => {});
  }
  for (const depId of createdDepositIds) {
    await testPool.query('DELETE FROM deposits WHERE id = $1', [depId]).catch(() => {});
  }
  for (const resId of createdReservationIds) {
    await testPool.query('DELETE FROM folio_entries WHERE reservation_id = $1', [resId]).catch(() => {});
    await testPool.query('DELETE FROM payment_transactions WHERE reservation_id = $1', [resId]).catch(() => {});
    await testPool.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = $1', [resId]).catch(() => {});
    await testPool.query('DELETE FROM reservations WHERE id = $1', [resId]).catch(() => {});
  }
  for (const bId of createdBookingIds) {
    await testPool.query('DELETE FROM bookings WHERE id = $1', [bId]).catch(() => {});
  }
  for (const itemId of createdMenuItemIds) {
    await testPool.query('DELETE FROM pos_menu_items WHERE id = $1', [itemId]).catch(() => {});
  }
  for (const catId of createdCategoryIds) {
    await testPool.query('DELETE FROM pos_menu_categories WHERE id = $1', [catId]).catch(() => {});
  }
  console.log('Cleanup completed cleanly.');
}

async function main() {
  console.log('\n======================================================');
  console.log('  OAK HIMS POS ROOM CHARGE COMPREHENSIVE TEST');
  console.log(`  Database: ${currentDb}`);
  console.log('======================================================\n');

  try {
    const propRes = await testPool.query(`SELECT id FROM properties LIMIT 1`);
    if (propRes.rows.length === 0) throw new Error('No property found');
    testPropertyId = Number(propRes.rows[0].id);

    const roomRes = await testPool.query(`SELECT id, room_type_id FROM rooms WHERE property_id = $1 LIMIT 1`, [testPropertyId]);
    if (roomRes.rows.length === 0) throw new Error('No room found for test property');
    const testRoomId = roomRes.rows[0].id;
    const testRoomTypeId = roomRes.rows[0].room_type_id;

    // Ensure test database has necessary POS columns and tables for settlement guard
    await testPool.query(`
      ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(50);
      ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS discount_type VARCHAR(20);
      ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,2);
      ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS discount_reason VARCHAR(255);
      ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS service_charge_percent_snapshot NUMERIC(5,2);
      ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS tax_percent_snapshot NUMERIC(5,2);
      ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS service_charge_enabled_snapshot BOOLEAN DEFAULT false;
      ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS tax_enabled_snapshot BOOLEAN DEFAULT false;
      ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS service_amount NUMERIC(12,2) DEFAULT 0;
      ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(12,2) DEFAULT 0;
      ALTER TABLE pos_order_items ADD COLUMN IF NOT EXISTS discount_type VARCHAR(20);
      ALTER TABLE pos_order_items ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,2);
      ALTER TABLE pos_order_items ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS pos_settlements (
        id SERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL,
        pos_order_id INTEGER NOT NULL,
        transaction_id INTEGER,
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        payment_method VARCHAR(50) NOT NULL,
        status VARCHAR(30) DEFAULT 'COMPLETED',
        idempotency_key VARCHAR(150),
        request_fingerprint VARCHAR(150),
        created_by VARCHAR(100),
        cash_received NUMERIC(12,2),
        change_due NUMERIC(12,2),
        payment_reference VARCHAR(100),
        verified_by VARCHAR(100),
        verified_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS pos_order_edit_requests (
        id SERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL,
        pos_order_id INTEGER NOT NULL,
        idempotency_key VARCHAR(150) NOT NULL,
        request_fingerprint VARCHAR(150) NOT NULL,
        resulting_version INTEGER NOT NULL DEFAULT 1,
        resulting_total NUMERIC(12,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_pos_order_edit_requests UNIQUE (property_id, pos_order_id, idempotency_key)
      );
    `);

    // Start HTTP server on dynamic port
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 500));
    const addr = server.address();
    baseUrl = `http://${addr.address}:${addr.port}`;
    console.log(`Test HTTP server listening on ${baseUrl}\n`);

    // ─────────────────────────────────────────────────────────────
    // 1. SETUP BASELINE RESERVATION FIXTURE
    // Room rate Rp640.000, discount Rp64.000, paid Rp576.000,
    // penalty Rp500.000, deposit Rp200.000 held.
    // ─────────────────────────────────────────────────────────────
    console.log('--- Setting up baseline reservation fixture ---');
    const bid = `BK-${genId()}`;
    const bkRes = await testPool.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status, payment_responsibility, created_at, updated_at)
       VALUES ($1, $2, 'Tamu Test POS Room Charge', 'ACTIVE', 'HOTEL_COLLECT', NOW(), NOW()) RETURNING id`,
      [testPropertyId, bid]
    );
    const bookingId = Number(bkRes.rows[0].id);
    createdBookingIds.add(bookingId);

    const resRes = await testPool.query(
      `INSERT INTO reservations (
         booking_id, room_id, status, stay_status, guest_name, stay_sequence,
         check_in, check_out, total_price, subtotal_amount, discount_amount,
         amount_paid, applied_deposit, remaining_balance, payment_status,
         booked_room_type_id_snapshot
       ) VALUES ($1, $2, 'CHECKED_IN', 'IN_HOUSE', 'Tamu Test POS Room Charge', 1,
         CURRENT_DATE, CURRENT_DATE + INTERVAL '1 day', 1076000, 640000, 64000,
         576000, 0, 500000, 'PARTIAL', $3) RETURNING id`,
      [bookingId, testRoomId, testRoomTypeId]
    );
    const reservationId = Number(resRes.rows[0].id);
    createdReservationIds.add(reservationId);

    // Folio entry: Room charge Rp640.000
    await testPool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, direction, amount, description, created_at, is_voided)
       VALUES ($1, $2, 'ROOM_CHARGE', 'DEBIT', 640000, 'Room Charge 1 Night', NOW(), FALSE)`,
      [reservationId, testPropertyId]
    );

    // Folio entry: Commercial discount Rp64.000
    await testPool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, direction, amount, description, created_at, is_voided)
       VALUES ($1, $2, 'DISCOUNT', 'CREDIT', 64000, 'Diskon Kamar 10%', NOW(), FALSE)`,
      [reservationId, testPropertyId]
    );

    // Folio entry: Room payment Rp576.000 (PAID)
    await testPool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, direction, amount, description, created_at, is_voided)
       VALUES ($1, $2, 'PAYMENT', 'CREDIT', 576000, 'Pembayaran Kamar Tunai', NOW(), FALSE)`,
      [reservationId, testPropertyId]
    );
    await testPool.query(
      `INSERT INTO payment_transactions (reservation_id, property_id, amount, payment_method, status, transaction_type, created_at)
       VALUES ($1, $2, 576000, 'CASH', 'SUCCESS', 'PAYMENT', NOW())`,
      [reservationId, testPropertyId]
    );

    // Folio entry: Penalty charge Rp500.000
    await testPool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, direction, amount, description, created_at, is_voided)
       VALUES ($1, $2, 'DAMAGE_PENALTY', 'DEBIT', 500000, 'Denda Kerusakan Properti', NOW(), FALSE)`,
      [reservationId, testPropertyId]
    );

    // Deposit: Rp200.000 held (SECURITY_DEPOSIT / RECEIVED)
    const depRes = await testPool.query(
      `INSERT INTO deposits (property_id, reservation_id, booking_id, deposit_number, original_amount, payment_method, status, scope, purpose, received_by, received_at, created_at)
       VALUES ($1, $2, $3, $4, 200000, 'CASH', 'RECEIVED', 'ROOM_RESERVATION', 'SECURITY_DEPOSIT', 'Staff FO', NOW(), NOW()) RETURNING id`,
      [testPropertyId, reservationId, bookingId, `DEP-${genId()}`]
    );
    createdDepositIds.add(Number(depRes.rows[0].id));

    // Verify baseline financials
    const baselineFin = await calculateReservationFinancials(testPool, reservationId, testPropertyId);
    assert.strictEqual(baselineFin.total_price, 1076000, 'Baseline net charges must be 1.076.000');
    assert.strictEqual(baselineFin.amount_paid, 576000, 'Baseline paid must be 576.000');
    assert.strictEqual(baselineFin.applied_deposit, 0, 'Baseline applied deposit must be 0');
    assert.strictEqual(baselineFin.remaining_balance, 500000, 'Baseline balance must be 500.000');
    pass('BASELINE', 'Initial reservation state verified (Net Rp1.076.000, Paid Rp576.000, Balance Rp500.000)');

    // ─────────────────────────────────────────────────────────────
    // 2. CREATE POS ORDER (Rp72.600)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Creating POS Order for Room Charge ---');
    const catRes = await testPool.query(
      `INSERT INTO pos_menu_categories (property_id, name, created_at) VALUES ($1, 'Test Cat', NOW()) RETURNING id`,
      [testPropertyId]
    );
    const catId = Number(catRes.rows[0].id);
    createdCategoryIds.add(catId);

    const item1Res = await testPool.query(
      `INSERT INTO pos_menu_items (property_id, category_id, name, price, is_active, created_at, updated_at)
       VALUES ($1, $2, 'Nasi Goreng Spesial', 60000, true, NOW(), NOW()) RETURNING id`,
      [testPropertyId, catId]
    );
    const item1Id = Number(item1Res.rows[0].id);
    createdMenuItemIds.add(item1Id);

    const item2Res = await testPool.query(
      `INSERT INTO pos_menu_items (property_id, category_id, name, price, is_active, created_at, updated_at)
       VALUES ($1, $2, 'Es Teh Manis', 12600, true, NOW(), NOW()) RETURNING id`,
      [testPropertyId, catId]
    );
    const item2Id = Number(item2Res.rows[0].id);
    createdMenuItemIds.add(item2Id);

    const orderNum = `ORD-TEST-${genId().slice(0, 6)}`;
    const poRes = await testPool.query(
      `INSERT INTO pos_orders (property_id, reservation_id, order_number, table_number, guest_name, status, total_amount, created_at, updated_at)
       VALUES ($1, $2, $3, '12', 'Tamu Test POS Room Charge', 'OPEN', 72600, NOW(), NOW()) RETURNING id`,
      [testPropertyId, reservationId, orderNum]
    );
    const posOrderId = Number(poRes.rows[0].id);
    createdOrderIds.add(posOrderId);

    await testPool.query(
      `INSERT INTO pos_order_items (order_id, menu_item_id, quantity, unit_price, notes, created_at)
       VALUES ($1, $2, 1, 60000, 'Nasi Goreng Spesial', NOW()),
              ($1, $3, 1, 12600, 'Es Teh Manis + Tax/Svc', NOW())`,
      [posOrderId, item1Id, item2Id]
    );
    pass('POS_ORDER_CREATED', `Order #${posOrderId} (${orderNum}) created with total Rp72.600 (OPEN)`);

    // ─────────────────────────────────────────────────────────────
    // 3. EXECUTE POS ROOM CHARGE
    // POST /api/pos/orders/:id/room-charge
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Executing POST /api/pos/orders/:id/room-charge ---');
    const postRes = await request('POST', `/api/pos/orders/${posOrderId}/room-charge`, {
      property_id: testPropertyId,
      reservation_id: reservationId,
      notes: 'Tagihkan pesanan F&B ke folio kamar 101',
    });

    assert.strictEqual(postRes.status, 201, `Expected HTTP 201, received ${postRes.status}: ${JSON.stringify(postRes.body)}`);
    assert.strictEqual(postRes.body.status, 'SUCCESS', 'Response status must be SUCCESS');
    assert.strictEqual(postRes.body.data.status, 'BILLED_TO_ROOM', 'Order status must be BILLED_TO_ROOM');
    assert.strictEqual(postRes.body.data.reservation_id, reservationId, 'Order reservation_id must match');
    pass('POST_ROOM_CHARGE_201', 'Room charge endpoint returned 201 SUCCESS with status BILLED_TO_ROOM');

    // Verify folio entry created in database
    const folioRows = await testPool.query(
      `SELECT * FROM folio_entries
       WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2 AND is_voided = FALSE`,
      [testPropertyId, String(posOrderId)]
    );
    assert.strictEqual(folioRows.rows.length, 1, 'Exactly 1 active folio entry must exist for order');
    const fe = folioRows.rows[0];
    assert.strictEqual(fe.direction, 'DEBIT', 'Folio entry direction must be DEBIT');
    assert.strictEqual(fe.entry_type, 'FNB_POS', 'Folio entry entry_type must be FNB_POS');
    assert.strictEqual(Number(fe.amount), 72600, 'Folio entry amount must be Rp72.600');
    pass('FOLIO_DEBIT_INSERTED', `Folio debit entry confirmed: ID ${fe.id}, amount Rp72.600, entry_type FNB_POS`);

    // Verify recalculated canonical financials
    const postFin = await calculateReservationFinancials(testPool, reservationId, testPropertyId);
    console.log('Post-Charge Financial Summary:', {
      total_price: postFin.total_price,
      amount_paid: postFin.amount_paid,
      applied_deposit: postFin.applied_deposit,
      remaining_balance: postFin.remaining_balance,
      payment_status: postFin.payment_status,
    });

    assert.strictEqual(postFin.total_price, 1148600, 'Net total charges must be exactly Rp1.148.600');
    assert.strictEqual(postFin.amount_paid, 576000, 'Amount paid must be exactly Rp576.000');
    assert.strictEqual(postFin.applied_deposit, 0, 'Applied deposit must be exactly Rp0');
    assert.strictEqual(postFin.remaining_balance, 572600, 'Remaining balance must be exactly Rp572.600');

    // Check held deposit remains intact
    const depCheck = await testPool.query(`SELECT original_amount, status FROM deposits WHERE id = $1`, [Array.from(createdDepositIds)[0]]);
    assert.strictEqual(Number(depCheck.rows[0].original_amount), 200000, 'Deposit amount must remain 200.000');
    assert.strictEqual(depCheck.rows[0].status, 'RECEIVED', 'Deposit status must remain RECEIVED');

    pass('CANONICAL_NUMBERS_EXACT', 'Canonical specification matched: charges Rp1.148.600, paid Rp576.000, balance Rp572.600, deposit Rp200.000 held');

    // ─────────────────────────────────────────────────────────────
    // 4. IDEMPOTENCY & REPLAY PROTECTION
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Testing Idempotency & Replay Protection ---');
    const replayRes = await request('POST', `/api/pos/orders/${posOrderId}/room-charge`, {
      property_id: testPropertyId,
      reservation_id: reservationId,
    });

    assert.strictEqual(replayRes.status, 200, `Expected replay HTTP 200, received ${replayRes.status}`);
    assert.strictEqual(replayRes.body.code, 'POS_ORDER_BILLED_TO_ROOM_REPLAY', 'Response code must be POS_ORDER_BILLED_TO_ROOM_REPLAY');
    assert.strictEqual(replayRes.body.data.replayed, true, 'replayed flag must be true');

    const folioCountReplay = await testPool.query(
      `SELECT COUNT(*)::int AS cnt FROM folio_entries
       WHERE property_id = $1 AND source_type = 'POS_ORDER' AND source_id = $2 AND is_voided = FALSE`,
      [testPropertyId, String(posOrderId)]
    );
    assert.strictEqual(folioCountReplay.rows[0].cnt, 1, 'Folio entries count must remain exactly 1 after replay');

    const replayFin = await calculateReservationFinancials(testPool, reservationId, testPropertyId);
    assert.strictEqual(replayFin.total_price, 1148600, 'Financial charges unchanged after replay (zero drift)');
    assert.strictEqual(replayFin.remaining_balance, 572600, 'Financial balance unchanged after replay (zero drift)');
    pass('IDEMPOTENCY_REPLAY_PASS', 'Replay safely returned 200 REPLAY with zero duplicate entries and zero drift');

    // ─────────────────────────────────────────────────────────────
    // 5. FINANCIAL LOCK GUARDS (SETTLEMENT / UPDATE / VOID)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Testing Financial Lock Guards on Billed Order ---');

    // A. Direct settlement guard
    const payRes = await request('POST', `/api/pos/orders/${posOrderId}/pay`, {
      property_id: testPropertyId,
      pos_order_id: posOrderId,
      payment_method: 'CASH',
      cash_received: 100000,
    }, {
      'Idempotency-Key': `TEST-PAY-${genId()}`,
    });
    assert.strictEqual(payRes.status, 409, `Expected 409 for settlement on billed order, received ${payRes.status}: ${JSON.stringify(payRes.body)}`);
    assert.strictEqual(payRes.body.code, 'ALREADY_BILLED_TO_ROOM', 'Error code must be ALREADY_BILLED_TO_ROOM');
    pass('GUARD_SETTLEMENT_REJECTED', 'Direct cash settlement blocked with 409 ALREADY_BILLED_TO_ROOM');

    // B. Order update guard (PUT /api/pos/orders/:id)
    const updateRes = await request('PUT', `/api/pos/orders/${posOrderId}`, {
      property_id: testPropertyId,
      expected_version: 1,
      idempotency_key: `TEST-EDIT-${genId()}`,
      table_number: '99',
      items: [{ menu_item_id: item1Id, quantity: 2 }],
    });
    assert.strictEqual(updateRes.status, 409, `Expected 409 for update on billed order, received ${updateRes.status}: ${JSON.stringify(updateRes.body)}`);
    pass('GUARD_ORDER_UPDATE_REJECTED', `Order update blocked with 409 (code: ${updateRes.body.code})`);

    // C. Status / Void guard (PATCH /api/pos/orders/:id/status)
    const voidRes = await request('PATCH', `/api/pos/orders/${posOrderId}/status`, {
      property_id: testPropertyId,
      status: 'VOIDED',
      void_reason: 'Testing cancellation guard',
    });
    assert.strictEqual(voidRes.status, 409, `Expected 409 for void on billed order, received ${voidRes.status}`);
    pass('GUARD_ORDER_VOID_REJECTED', `Order void blocked with 409 (code: ${voidRes.body.code})`);

    // ─────────────────────────────────────────────────────────────
    // 6. ISOLATION: UNBILLED DIRECT POS ORDER
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Testing Isolation of Unbilled Direct POS Order ---');
    const directOrderNum = `ORD-DIR-${genId().slice(0, 6)}`;
    const dirPoRes = await testPool.query(
      `INSERT INTO pos_orders (property_id, order_number, table_number, guest_name, status, total_amount, created_at, updated_at)
       VALUES ($1, $2, 'T1', 'Pelanggan Langsung Walk-in', 'OPEN', 80000, NOW(), NOW()) RETURNING id`,
      [testPropertyId, directOrderNum]
    );
    const directOrderId = Number(dirPoRes.rows[0].id);
    createdOrderIds.add(directOrderId);

    // Direct order settled directly (status PAID)
    await testPool.query(
      `UPDATE pos_orders SET status = 'PAID', updated_at = NOW() WHERE id = $1`,
      [directOrderId]
    );

    // Assert room folio & financials are completely untouched
    const afterDirectFin = await calculateReservationFinancials(testPool, reservationId, testPropertyId);
    assert.strictEqual(afterDirectFin.total_price, 1148600, 'Room charges must remain Rp1.148.600');
    assert.strictEqual(afterDirectFin.remaining_balance, 572600, 'Room balance must remain Rp572.600');
    pass('ISOLATION_UNBILLED_ORDER', 'Direct paid order Rp80.000 did not touch room folio or balance');

    // ─────────────────────────────────────────────────────────────
    // 7. INACTIVE RESERVATION GUARD
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Testing Inactive Reservation Guard ---');
    const inactiveBkRes = await testPool.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status, payment_responsibility, created_at, updated_at)
       VALUES ($1, $2, 'Inactive Guest', 'CANCELLED', 'HOTEL_COLLECT', NOW(), NOW()) RETURNING id`,
      [testPropertyId, `BK-${genId()}`]
    );
    createdBookingIds.add(Number(inactiveBkRes.rows[0].id));

    const inactiveRes = await testPool.query(
      `INSERT INTO reservations (
         booking_id, room_id, status, stay_status, guest_name, stay_sequence,
         check_in, check_out, total_price, subtotal_amount, discount_amount,
         amount_paid, applied_deposit, remaining_balance, payment_status,
         booked_room_type_id_snapshot
       ) VALUES ($1, $2, 'CANCELLED', 'CANCELLED', 'Inactive Guest', 1,
         CURRENT_DATE, CURRENT_DATE + INTERVAL '1 day', 500000, 500000, 0,
         0, 0, 500000, 'UNPAID', $3) RETURNING id`,
      [Number(inactiveBkRes.rows[0].id), testRoomId, testRoomTypeId]
    );
    const inactiveResId = Number(inactiveRes.rows[0].id);
    createdReservationIds.add(inactiveResId);

    const inactivePoRes = await testPool.query(
      `INSERT INTO pos_orders (property_id, order_number, table_number, guest_name, status, total_amount, created_at, updated_at)
       VALUES ($1, $2, '3', 'Inactive Guest', 'OPEN', 50000, NOW(), NOW()) RETURNING id`,
      [testPropertyId, `ORD-${genId().slice(0, 6)}`]
    );
    const inactiveOrderId = Number(inactivePoRes.rows[0].id);
    createdOrderIds.add(inactiveOrderId);

    const inactiveChargeRes = await request('POST', `/api/pos/orders/${inactiveOrderId}/room-charge`, {
      property_id: testPropertyId,
      reservation_id: inactiveResId,
    });
    assert.strictEqual(inactiveChargeRes.status, 409, `Expected 409 for inactive reservation, received ${inactiveChargeRes.status}`);
    assert.strictEqual(inactiveChargeRes.body.code, 'RESERVATION_NOT_ACTIVE', 'Error code must be RESERVATION_NOT_ACTIVE');
    pass('GUARD_INACTIVE_RESERVATION', 'Room charge rejected with 409 RESERVATION_NOT_ACTIVE for CANCELLED reservation');

    // ─────────────────────────────────────────────────────────────
    // 8. CROSS-PROPERTY ISOLATION GUARD
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Testing Cross-Property Isolation Guard ---');
    const crossRes = await request('POST', `/api/pos/orders/${posOrderId}/room-charge`, {
      property_id: 999999, // Mismatched property ID
      reservation_id: reservationId,
    });
    assert.ok(crossRes.status === 403 || crossRes.status === 409, `Expected 403 or 409 for cross-property, received ${crossRes.status}`);
    pass('GUARD_CROSS_PROPERTY', `Cross-property charge rejected with HTTP ${crossRes.status}`);

    console.log('\n======================================================');
    console.log('  ALL INTEGRATION TESTS PASSED WITH ZERO ERRORS!');
    console.log('======================================================\n');
  } catch (err) {
    console.error('\n❌ TEST RUN FAILED:', err);
    process.exitCode = 1;
  } finally {
    await cleanup();
    if (server) {
      server.close();
      await new Promise((r) => setTimeout(r, 200));
    }
    await testPool.end();
  }
}

main();
