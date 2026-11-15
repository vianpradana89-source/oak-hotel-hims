'use strict';

/**
 * linked_payments_deposit_exclusion_test.js
 *
 * Verifies that getTransactionById linked_payments follows canonical
 * reservation payment history semantics.
 * Safety: DB_NAME must contain 'test'.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const currentDb = process.env.DB_NAME || '';
if (!currentDb || !currentDb.toLowerCase().includes('test')) {
  console.error(`SAFETY VIOLATION: DB_NAME="${currentDb || '(unset)'}" does not contain 'test'.`);
  process.exit(1);
}
console.log(`Using test DB: ${currentDb}`);

const { Pool } = require('pg');
const { getTransactionById } = require('../dist/domains/transactions/transactionService');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: currentDb
});

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`PASS | ${msg}`); }
  else      { failed++; console.error(`FAIL | ${msg}`); }
}

const tracked = {
  properties: [],
  categories: [],
  types: [],
  rooms: [],
  availabilities: [],
  bookings: [],
  reservations: [],
  folios: [],
  txs: [],
  pmts: [],
  allocs: [],
};

async function cleanupFixtures() {
  if (tracked.allocs.length) await pool.query('DELETE FROM payment_allocations WHERE id = ANY($1::int[])', [tracked.allocs]);
  if (tracked.pmts.length) await pool.query('DELETE FROM payment_transactions WHERE id = ANY($1::int[])', [tracked.pmts]);
  if (tracked.txs.length) await pool.query('DELETE FROM transactions WHERE id = ANY($1::int[])', [tracked.txs]);
  if (tracked.folios.length) await pool.query('DELETE FROM folio_entries WHERE id = ANY($1::int[])', [tracked.folios]);
  if (tracked.reservations.length) await pool.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [tracked.reservations]);
  if (tracked.bookings.length) await pool.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [tracked.bookings]);
  if (tracked.availabilities.length) await pool.query('DELETE FROM availability_dates WHERE id = ANY($1::int[])', [tracked.availabilities]);
  if (tracked.rooms.length) await pool.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [tracked.rooms]);
  if (tracked.types.length) await pool.query('DELETE FROM room_types WHERE id = ANY($1::int[])', [tracked.types]);
  if (tracked.categories.length) await pool.query('DELETE FROM room_categories WHERE id = ANY($1::int[])', [tracked.categories]);
  if (tracked.properties.length) await pool.query('DELETE FROM properties WHERE id = ANY($1::int[])', [tracked.properties]);
}

async function runTests() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const uniqueSuffix = Date.now().toString(36);
    const propCode = 'LPT' + uniqueSuffix.slice(-3).toUpperCase();

    const prop = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ('LPT Test', $1, 'Asia/Jakarta', 'IDR', 'Test St', TRUE) RETURNING id`,
      [propCode]
    );
    const propertyId = Number(prop.rows[0].id);
    tracked.properties.push(propertyId);

    const cat = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active)
       VALUES ($1, 'CAT-LPT', 'Cat LPT', TRUE) RETURNING id`,
      [propertyId]
    );
    tracked.categories.push(Number(cat.rows[0].id));

    const rt = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity)
       VALUES ($1, $2, 'RTLPT', 'Room LPT', 329728, 2) RETURNING id`,
      [propertyId, cat.rows[0].id]
    );
    const roomTypeId = Number(rt.rows[0].id);
    tracked.types.push(roomTypeId);

    const rm = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, '901', 'Room 901', 'Ready', TRUE) RETURNING id`,
      [propertyId, roomTypeId]
    );
    tracked.rooms.push(Number(rm.rows[0].id));
    await client.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES ($1, 'RTLPT', '2030-11-01', 1, 0), ($1, 'RTLPT', '2030-11-02', 1, 0)`,
      [roomTypeId]
    );
    const availRes = await client.query(
      `SELECT id FROM availability_dates WHERE room_type_id = $1 AND room_type = 'RTLPT'`,
      [roomTypeId]
    );
    if ((availRes.rowCount ?? 0) > 0) {
      tracked.availabilities.push(...availRes.rows.map(row => Number(row.id)));
    }

    const b = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, 'BID-LPT', 'Guest LPT', 'ACTIVE') RETURNING id`,
      [propertyId]
    );
    const bookingId = Number(b.rows[0].id);
    tracked.bookings.push(bookingId);

    const r = await client.query(
      `INSERT INTO reservations (booking_id, guest_name, check_in, check_out,
         total_price, amount_paid, remaining_balance, payment_status, status, stay_sequence)
        VALUES ($1, 'Guest LPT', '2030-11-01', '2030-11-03',
          329728, 0, 329728, 'UNPAID', 'BOOKED', 1) RETURNING id`,
      [bookingId]
    );
    const resId = Number(r.rows[0].id);
    tracked.reservations.push(resId);

    const fe = await client.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction)
       VALUES ($1, $2, 'ROOM_CHARGE', 'Room charge', 329728, 'DEBIT') RETURNING id`,
      [resId, propertyId]
    );
    if ((fe.rowCount ?? 0) > 0) {
      tracked.folios.push(Number(fe.rows[0].id));
    }

    // Create SALE transaction
    const saleTx = await client.query(
      `INSERT INTO transactions
       (property_id, transaction_no, transaction_type, transaction_date, source_type, source_id,
        category_code, category_name, department_code, description, net_amount, transaction_status,
        reservation_id, booking_id, created_by)
       VALUES ($1, 'TX-A-001', 'SALE', CURRENT_DATE, 'ROOM_CHARGE', 'RES-' || $2::text,
        'ROOM', 'Room Charge', 'FRONT_OFFICE', 'Room charge LPT', 329728, 'POSTED',
        $2::integer, $3, 'SYSTEM')
       RETURNING id`,
      [propertyId, resId, bookingId]
    );
    tracked.txs.push(Number(saleTx.rows[0].id));

    // TEST A: DEPOSIT must NOT appear
    const depPmt = await client.query(
      `INSERT INTO payment_transactions
       (reservation_id, property_id, transaction_type, amount, payment_method,
        reference_code, status, booking_id, scope)
       VALUES ($1, $2, 'DEPOSIT', 200000, 'CASH', 'DEP-A-001', 'SUCCESS', $3, 'ROOM_RESERVATION')
       RETURNING id`,
      [resId, propertyId, bookingId]
    );
    tracked.pmts.push(Number(depPmt.rows[0].id));

    const detailA = await getTransactionById(pool, propertyId, saleTx.rows[0].id);
    const depsInA = detailA.linked_payments.filter(p => p.transaction_type === 'DEPOSIT' || p.transaction_type === 'DEPOSIT_REFUND');
    assert(depsInA.length === 0, 'A: DEPOSIT must NOT appear in linked_payments');
    assert(detailA.linked_payments.length === 0, 'A: linked_payments must be empty (no ordinary payments yet)');

    // TEST B: Direct ROOM_RESERVATION PAYMENT
    const payB = await client.query(
      `INSERT INTO payment_transactions
       (reservation_id, property_id, transaction_type, amount, payment_method,
        reference_code, status, booking_id, scope)
       VALUES ($1, $2, 'PAYMENT', 100000, 'CASH', 'PAY-B-001', 'SUCCESS', $3, 'ROOM_RESERVATION')
       RETURNING id`,
      [resId, propertyId, bookingId]
    );
    tracked.pmts.push(Number(payB.rows[0].id));

    const detailB = await getTransactionById(pool, propertyId, saleTx.rows[0].id);
    const payBFound = detailB.linked_payments.find(p => p.id === Number(payB.rows[0].id));
    assert(!!payBFound, 'B: Direct ROOM_RESERVATION PAYMENT must appear');
    assert(Number(payBFound.amount) === 100000, 'B: Direct PAYMENT amount must be 100000');

    // TEST C: BOOKING_GROUP allocated PAYMENT
    const bgPayC = await client.query(
      `INSERT INTO payment_transactions
       (reservation_id, property_id, booking_id, scope, transaction_type,
        amount, payment_method, reference_code, status)
       VALUES ($1, $2, $3, 'BOOKING_GROUP', 'PAYMENT', 500000, 'CASH', 'BGP-C-001', 'SUCCESS')
       RETURNING id`,
      [resId, propertyId, bookingId]
    );
    tracked.pmts.push(Number(bgPayC.rows[0].id));

    const allocC = await client.query(
      `INSERT INTO payment_allocations
       (property_id, booking_id, reservation_id, payment_transaction_id,
        allocated_amount, allocation_sequence, status)
       VALUES ($1, $2, $3, $4, 100000, 1, 'ACTIVE')
       RETURNING id`,
      [propertyId, bookingId, resId, bgPayC.rows[0].id]
    );
    tracked.allocs.push(Number(allocC.rows[0].id));

    const detailC = await getTransactionById(pool, propertyId, saleTx.rows[0].id);
    const bgPayCFound = detailC.linked_payments.find(p => p.id === Number(bgPayC.rows[0].id));
    assert(!!bgPayCFound, 'C: BOOKING_GROUP PAYMENT must appear');
    assert(Number(bgPayCFound.amount) === 100000, 'C: linked payment amount must be allocated_amount=100000, NOT parent=500000');

    // TEST D: DEPOSIT_REFUND must NOT appear
    const depRefD = await client.query(
      `INSERT INTO payment_transactions
       (reservation_id, property_id, transaction_type, amount, payment_method,
        reference_code, status, booking_id, scope)
       VALUES ($1, $2, 'DEPOSIT_REFUND', 50000, 'CASH', 'DEPR-D-001', 'SUCCESS', $3, 'ROOM_RESERVATION')
       RETURNING id`,
      [resId, propertyId, bookingId]
    );
    tracked.pmts.push(Number(depRefD.rows[0].id));

    const detailD = await getTransactionById(pool, propertyId, saleTx.rows[0].id);
    const depositTypesD = detailD.linked_payments.filter(p => p.transaction_type === 'DEPOSIT' || p.transaction_type === 'DEPOSIT_REFUND');
    assert(depositTypesD.length === 0, 'D: DEPOSIT_REFUND must NOT appear');

    // TEST E: Non-reservation transaction-linked PAYMENT
    const nonResTx = await client.query(
      `INSERT INTO transactions
        (property_id, transaction_no, transaction_type, transaction_date, source_type,
         category_code, category_name, department_code, description, net_amount, transaction_status,
         reservation_id, booking_id, created_by)
        VALUES ($1, 'TX-E-001', 'PURCHASE', CURRENT_DATE, 'MANUAL_PURCHASE',
         'OFFICE_SUPPLIES', 'Office Supplies', 'ADMINISTRATION', 'Pembelian LPT', 50000, 'POSTED',
         NULL, NULL, 'SYSTEM')
        RETURNING id`,
      [propertyId]
    );
    tracked.txs.push(Number(nonResTx.rows[0].id));

    const payE = await client.query(
      `INSERT INTO payment_transactions
        (transaction_id, property_id, transaction_type, amount, payment_method,
         reference_code, status, scope)
        VALUES ($1, $2, 'PAYMENT', 50000, 'CASH', 'PAY-E-001', 'SUCCESS', 'TRANSACTION_DIRECT')
        RETURNING id`,
      [nonResTx.rows[0].id, propertyId]
    );
    tracked.pmts.push(Number(payE.rows[0].id));

    // Property-scope regression: create a second property and a payment that
    // shares the same transaction_id but belongs to the other property.
    const otherProp = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ('LPT Other', $1, 'Asia/Jakarta', 'IDR', 'Other St', TRUE) RETURNING id`,
      ['LOP' + uniqueSuffix.slice(-3).toUpperCase()]
    );
    const otherPropertyId = Number(otherProp.rows[0].id);
    tracked.properties.push(otherPropertyId);

    const crossPmt = await client.query(
      `INSERT INTO payment_transactions
       (transaction_id, property_id, transaction_type, amount, payment_method,
        reference_code, status, scope)
       VALUES ($1, $2, 'PAYMENT', 9999, 'CASH', 'PAY-CROSS-E', 'SUCCESS', 'TRANSACTION_DIRECT')
       RETURNING id`,
      [nonResTx.rows[0].id, otherPropertyId]
    );
    tracked.pmts.push(Number(crossPmt.rows[0].id));

    // Re-fetch detailE after the cross-property payment is inserted
    const detailE = await getTransactionById(pool, propertyId, nonResTx.rows[0].id);
    const payEFound = detailE.linked_payments.find(p => p.reference_code === 'PAY-E-001');
    assert(!!payEFound, 'E: Non-reservation linked PAYMENT must appear');
    assert(Number(payEFound.amount) === 50000, 'E: Non-reservation payment amount must be 50000');
    const crossFound = detailE.linked_payments.find(p => p.reference_code === 'PAY-CROSS-E');
    assert(!crossFound, 'E: cross-property payment (different property_id) must NOT leak into target transaction');

    // TEST F: CORRECTION_REPLACEMENT must appear
    const corrPayF = await client.query(
      `INSERT INTO payment_transactions
       (reservation_id, property_id, transaction_type, amount, payment_method,
        reference_code, status, booking_id, scope)
       VALUES ($1, $2, 'CORRECTION_REPLACEMENT', 25000, 'TRANSFER', 'CORR-F-001', 'SUCCESS', $3, 'ROOM_RESERVATION')
       RETURNING id`,
      [resId, propertyId, bookingId]
    );
    tracked.pmts.push(Number(corrPayF.rows[0].id));

    const detailF = await getTransactionById(pool, propertyId, saleTx.rows[0].id);
    const corrFound = detailF.linked_payments.find(p => p.id === Number(corrPayF.rows[0].id));
    assert(!!corrFound, 'F: CORRECTION_REPLACEMENT must appear');
    assert(corrFound.transaction_type === 'CORRECTION_REPLACEMENT', 'F: CORRECTION_REPLACEMENT type preserved');

    // TEST G: No double-counting
    const dupIds = detailF.linked_payments.map(p => p.id);
    const uniqueIds = [...new Set(dupIds)];
    assert(dupIds.length === uniqueIds.length, 'G: No double-counting');
    assert(dupIds.length === 3, 'G: linked_payments must have exactly 3 items — got ' + dupIds.length);

    const typesG = detailF.linked_payments.map(p => p.transaction_type).sort();
    assert(typesG[0] === 'CORRECTION_REPLACEMENT' && typesG[1] === 'PAYMENT' && typesG[2] === 'PAYMENT', 'G: types = [CORRECTION, PAYMENT, PAYMENT]');

    const totalAllocated = detailF.linked_payments.reduce((s, p) => s + Number(p.amount), 0);
    assert(totalAllocated === 225000, 'G: Total = 225000 (100k+100k+25k) — got ' + totalAllocated);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Test error:', err.message);
    failed++;
  } finally {
    try { await cleanupFixtures(); } catch (e) { console.error('Cleanup err:', e.message); }
    client.release();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Result: ${passed} passed, ${failed} failed`);
    console.log(`${'='.repeat(60)}`);
    await pool.end();
    process.exitCode = failed > 0 ? 1 : 0;
  }
}

runTests().catch(err => { console.error('Fatal:', err); process.exit(1); });
