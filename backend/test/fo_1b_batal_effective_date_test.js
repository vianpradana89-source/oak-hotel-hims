/**
 * FO-1B Regression Test: BATAL Effective Date Uses cancelled_at
 *
 * Verifies that cancelled SALE transactions appear in the BATAL tab
 * based on their cancellation date, not transaction creation date.
 *
 * Requires: TEST_DATABASE_URL environment variable
 * Localhost/127.0.0.1 is allowed. Rejects staging/production URLs.
 */

import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { getTransactions } from '../dist/domains/transactions/transactionService.js';

// Require explicit TEST_DATABASE_URL — do NOT fall back to DATABASE_URL
const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl) {
  console.error('SKIP: FO-1B test requires explicit TEST_DATABASE_URL environment variable');
  console.error('      Localhost/127.0.0.1 is allowed.');
  console.error('      Staging/production Cloud SQL URLs are rejected.');
  process.exit(0);
}

// Reject obvious staging/production database identifiers
const suspiciousPatterns = ['staging', 'production', 'cloudsql', 'prod-db', 'live-db'];
const urlLower = testDbUrl.toLowerCase();
if (suspiciousPatterns.some(p => urlLower.includes(p))) {
  console.error('SKIP: TEST_DATABASE_URL appears to be a staging/production database');
  console.error('      Rejecting URL containing suspicious pattern.');
  process.exit(0);
}

const pool = new Pool({ connectionString: testDbUrl });

const PROPERTY_ID = 9999; // Unique ID for test isolation

/**
 * Helper: create minimal property for test isolation
 */
async function ensureTestProperty(client) {
  const check = await client.query('SELECT id FROM properties WHERE id = $1', [PROPERTY_ID]);
  if (check.rows.length > 0) return;

  await client.query(
    `INSERT INTO properties (id, name, property_code, address, timezone)
     VALUES ($1, 'FO-1B Test Property', 'FO1B', 'Test Address', 'Asia/Jakarta')
     ON CONFLICT (id) DO NOTHING`,
    [PROPERTY_ID]
  );
}

/**
 * Helper: create room type for test fixtures
 */
async function ensureRoomType(client) {
  const check = await client.query(
    'SELECT id FROM room_types WHERE property_id = $1 AND code = $2',
    [PROPERTY_ID, 'TEST']
  );
  if (check.rows.length > 0) return check.rows[0].id;

  const rc = await client.query(
    `INSERT INTO room_categories (property_id, code, name)
     VALUES ($1, 'TEST_CAT', 'Test Category') RETURNING id`,
    [PROPERTY_ID]
  );
  const rt = await client.query(
    `INSERT INTO room_types (property_id, code, name, room_category_id, base_rate)
     VALUES ($1, 'TEST', 'Test Room Type', $2, 500000) RETURNING id`,
    [PROPERTY_ID, rc.rows[0].id]
  );
  return Number(rt.rows[0].id);
}

/**
 * Helper: create a booking for the test property
 */
async function createBooking(client) {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const bid = `FO1B-${Date.now()}-${suffix}`;
  const res = await client.query(
    `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
     VALUES ($1, $2, 'Test Guest', 'ACTIVE') RETURNING id`,
    [bid, PROPERTY_ID]
  );
  return { bookingId: Number(res.rows[0].id), bid };
}

async function runTests() {
  console.log('=== FO-1B: BATAL EFFECTIVE DATE REGRESSION TEST ===\n');

  // Use a single client for all operations to ensure transaction safety
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await ensureTestProperty(client);
    const roomTypeId = await ensureRoomType(client);

    // =========================================================================
    // CASE A: Sale tx_date=2026-09-05, cancelled_at=2026-09-09
    // Filter: BATAL, 2026-09-09
    // EXPECTED: included
    // =========================================================================
    console.log('CASE A: Sale tx_date=2026-09-05, cancelled_at=2026-09-09');
    console.log('        Filter: operational_sheet=BATAL, 2026-09-09 to 2026-09-09');
    console.log('        EXPECTED: included\n');

    const { bookingId: bookingIdA } = await createBooking(client);
    const resA = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, status, stay_status,
         check_in, check_out, booked_room_type_id_snapshot, guest_name,
         stay_sequence, total_price, amount_paid, payment_status
       ) VALUES ($1, NULL, 'CANCELLED', 'CANCELLED',
         '2026-09-10'::date, '2026-09-11'::date, $2, 'Test Guest A',
         1, 500000, 500000, 'PAID')
       RETURNING id`,
      [bookingIdA, roomTypeId]
    );
    const reservationIdA = Number(resA.rows[0].id);

    await client.query(
      `UPDATE reservations SET cancelled_at = '2026-09-09 10:00:00+07' WHERE id = $1`,
      [reservationIdA]
    );

    const txResA = await client.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_time,
         transaction_type, transaction_status, net_amount, source_type,
         source_id, reservation_id, booking_id, category_code, category_name,
         description, guest_name_snapshot
       ) VALUES ($1, 'TRX-A-FO1B', '2026-09-05', NOW(), 'SALE', 'POSTED',
         500000, 'RESERVATION', $2, $3, $4, 'ROOM_CHARGE', 'Room Charge',
         'Reservation sale', 'Test Guest A')
       RETURNING id`,
      [PROPERTY_ID, String(reservationIdA), reservationIdA, bookingIdA]
    );
    const transactionIdA = Number(txResA.rows[0].id);

    const resultA = await getTransactions(client, {
      property_id: PROPERTY_ID,
      start_date: '2026-09-09',
      end_date: '2026-09-09',
      operational_sheet: 'BATAL',
    });

    const caseATxIds = resultA.transactions.map(t => Number(t.id));
    assert.ok(
      caseATxIds.includes(transactionIdA),
      `CASE A: Transaction ${transactionIdA} should be included in BATAL for cancellation date`
    );
    console.log(`  ✓ PASS: Transaction ${transactionIdA} included\n`);

    // =========================================================================
    // CASE B: Same sale, filter 2026-09-05
    // EXPECTED: NOT included
    // =========================================================================
    console.log('CASE B: Same sale, filter: BATAL, 2026-09-05');
    console.log('        EXPECTED: not included\n');

    const resultB = await getTransactions(client, {
      property_id: PROPERTY_ID,
      start_date: '2026-09-05',
      end_date: '2026-09-05',
      operational_sheet: 'BATAL',
    });

    const caseBTxIds = resultB.transactions.map(t => Number(t.id));
    assert.ok(
      !caseBTxIds.includes(transactionIdA),
      `CASE B: Transaction ${transactionIdA} should NOT be included in BATAL for original transaction date`
    );
    console.log(`  ✓ PASS: Transaction ${transactionIdA} excluded\n`);

    // =========================================================================
    // CASE C: status=CANCELLED, stay_status=BOOKED, cancelled_at present
    // EXPECTED: uses cancellation date
    // =========================================================================
    console.log('CASE C: status=CANCELLED, stay_status=BOOKED, cancelled_at=2026-09-08');
    console.log('        Filter: BATAL, 2026-09-08');
    console.log('        EXPECTED: included (OR semantics)\n');

    const { bookingId: bookingIdC } = await createBooking(client);
    const resC = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, status, stay_status,
         check_in, check_out, booked_room_type_id_snapshot, guest_name,
         stay_sequence, total_price, amount_paid, payment_status
       ) VALUES ($1, NULL, 'CANCELLED', 'BOOKED',
         '2026-09-10'::date, '2026-09-11'::date, $2, 'Test Guest C',
         1, 500000, 500000, 'PAID')
       RETURNING id`,
      [bookingIdC, roomTypeId]
    );
    const reservationIdC = Number(resC.rows[0].id);

    await client.query(
      `UPDATE reservations SET cancelled_at = '2026-09-08 10:00:00+07' WHERE id = $1`,
      [reservationIdC]
    );

    const txResC = await client.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_time,
         transaction_type, transaction_status, net_amount, source_type,
         source_id, reservation_id, booking_id, category_code, category_name,
         description, guest_name_snapshot
       ) VALUES ($1, 'TRX-C-FO1B', '2026-09-05', NOW(), 'SALE', 'POSTED',
         500000, 'RESERVATION', $2, $3, $4, 'ROOM_CHARGE', 'Room Charge',
         'Sale', 'Test')
       RETURNING id`,
      [PROPERTY_ID, String(reservationIdC), reservationIdC, bookingIdC]
    );
    const transactionIdC = Number(txResC.rows[0].id);

    const resultC = await getTransactions(client, {
      property_id: PROPERTY_ID,
      start_date: '2026-09-08',
      end_date: '2026-09-08',
      operational_sheet: 'BATAL',
    });

    const caseCTxIds = resultC.transactions.map(t => Number(t.id));
    assert.ok(
      caseCTxIds.includes(transactionIdC),
      `CASE C: Transaction ${transactionIdC} should be included when status=CANCELLED (OR semantics)`
    );
    console.log(`  ✓ PASS: OR semantics working for status vs stay_status\n`);

    // =========================================================================
    // CASE D: status=BOOKED, stay_status=CANCELLED, cancelled_at present
    // EXPECTED: uses cancellation date
    // =========================================================================
    console.log('CASE D: status=BOOKED, stay_status=CANCELLED, cancelled_at=2026-09-07');
    console.log('        Filter: BATAL, 2026-09-07');
    console.log('        EXPECTED: included (OR semantics)\n');

    const { bookingId: bookingIdD } = await createBooking(client);
    const resD = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, status, stay_status,
         check_in, check_out, booked_room_type_id_snapshot, guest_name,
         stay_sequence, total_price, amount_paid, payment_status
       ) VALUES ($1, NULL, 'BOOKED', 'CANCELLED',
         '2026-09-10'::date, '2026-09-11'::date, $2, 'Test Guest D',
         1, 500000, 500000, 'PAID')
       RETURNING id`,
      [bookingIdD, roomTypeId]
    );
    const reservationIdD = Number(resD.rows[0].id);

    await client.query(
      `UPDATE reservations SET cancelled_at = '2026-09-07 14:00:00+07' WHERE id = $1`,
      [reservationIdD]
    );

    const txResD = await client.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_time,
         transaction_type, transaction_status, net_amount, source_type,
         source_id, reservation_id, booking_id, category_code, category_name,
         description, guest_name_snapshot
       ) VALUES ($1, 'TRX-D-FO1B', '2026-09-03', NOW(), 'SALE', 'POSTED',
         500000, 'RESERVATION', $2, $3, $4, 'ROOM_CHARGE', 'Room Charge',
         'Sale', 'Test')
       RETURNING id`,
      [PROPERTY_ID, String(reservationIdD), reservationIdD, bookingIdD]
    );
    const transactionIdD = Number(txResD.rows[0].id);

    const resultD = await getTransactions(client, {
      property_id: PROPERTY_ID,
      start_date: '2026-09-07',
      end_date: '2026-09-07',
      operational_sheet: 'BATAL',
    });

    const caseDTxIds = resultD.transactions.map(t => Number(t.id));
    assert.ok(
      caseDTxIds.includes(transactionIdD),
      `CASE D: Transaction ${transactionIdD} should be included when stay_status=CANCELLED (OR semantics)`
    );
    console.log(`  ✓ PASS: OR semantics working for stay_status\n`);

    // =========================================================================
    // CASE E: CANCELLED lifecycle but cancelled_at NULL
    // EXPECTED: fallback to transaction_date
    // =========================================================================
    console.log('CASE E: CANCELLED, cancelled_at=NULL');
    console.log('        Filter: BATAL, 2026-09-05');
    console.log('        EXPECTED: included (fallback to transaction_date)\n');

    const { bookingId: bookingIdE } = await createBooking(client);
    const resE = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, status, stay_status,
         check_in, check_out, booked_room_type_id_snapshot, guest_name,
         stay_sequence, total_price, amount_paid, payment_status
       ) VALUES ($1, NULL, 'CANCELLED', 'CANCELLED',
         '2026-09-10'::date, '2026-09-11'::date, $2, 'Test Guest E',
         1, 500000, 500000, 'PAID')
       RETURNING id`,
      [bookingIdE, roomTypeId]
    );
    const reservationIdE = Number(resE.rows[0].id);
    // cancelled_at stays NULL

    const txResE = await client.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_time,
         transaction_type, transaction_status, net_amount, source_type,
         source_id, reservation_id, booking_id, category_code, category_name,
         description, guest_name_snapshot
       ) VALUES ($1, 'TRX-E-FO1B', '2026-09-05', NOW(), 'SALE', 'POSTED',
         500000, 'RESERVATION', $2, $3, $4, 'ROOM_CHARGE', 'Room Charge',
         'Sale', 'Test')
       RETURNING id`,
      [PROPERTY_ID, String(reservationIdE), reservationIdE, bookingIdE]
    );
    const transactionIdE = Number(txResE.rows[0].id);

    const resultE = await getTransactions(client, {
      property_id: PROPERTY_ID,
      start_date: '2026-09-05',
      end_date: '2026-09-05',
      operational_sheet: 'BATAL',
    });

    const caseETxIds = resultE.transactions.map(t => Number(t.id));
    assert.ok(
      caseETxIds.includes(transactionIdE),
      `CASE E: Transaction ${transactionIdE} should be included with fallback to transaction_date`
    );
    console.log(`  ✓ PASS: Fallback to transaction_date works\n`);

    // =========================================================================
    // CASE F: Active BOOKED SALE
    // EXPECTED: unchanged behavior
    // =========================================================================
    console.log('CASE F: Active BOOKED SALE on 2026-09-05');
    console.log('        Filter: PROSES, 2026-09-05');
    console.log('        EXPECTED: included (unchanged behavior)\n');

    const { bookingId: bookingIdF } = await createBooking(client);
    const resF = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, status, stay_status,
         check_in, check_out, booked_room_type_id_snapshot, guest_name,
         stay_sequence, total_price, amount_paid, payment_status
       ) VALUES ($1, NULL, 'BOOKED', 'CHECKED_IN',
         '2026-09-10'::date, '2026-09-11'::date, $2, 'Test Guest F',
         1, 500000, 500000, 'PAID')
       RETURNING id`,
      [bookingIdF, roomTypeId]
    );
    const reservationIdF = Number(resF.rows[0].id);

    const txResF = await client.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_time,
         transaction_type, transaction_status, net_amount, source_type,
         source_id, reservation_id, booking_id, category_code, category_name,
         description, guest_name_snapshot
       ) VALUES ($1, 'TRX-F-FO1B', '2026-09-05', NOW(), 'SALE', 'POSTED',
         500000, 'RESERVATION', $2, $3, $4, 'ROOM_CHARGE', 'Room Charge',
         'Sale', 'Test')
       RETURNING id`,
      [PROPERTY_ID, String(reservationIdF), reservationIdF, bookingIdF]
    );
    const transactionIdF = Number(txResF.rows[0].id);

    const resultF = await getTransactions(client, {
      property_id: PROPERTY_ID,
      start_date: '2026-09-05',
      end_date: '2026-09-05',
      operational_sheet: 'PROSES',
    });

    const caseFTxIds = resultF.transactions.map(t => Number(t.id));
    assert.ok(
      caseFTxIds.includes(transactionIdF),
      `CASE F: Transaction ${transactionIdF} should still work`
    );
    console.log(`  ✓ PASS: Active bookings unchanged\n`);

    // =========================================================================
    // CASE G: CHECKED_OUT / SELESAI
    // EXPECTED: unchanged
    // =========================================================================
    console.log('CASE G: CHECKED_OUT / SELESAI on 2026-09-05');
    console.log('        Filter: SELESAI, 2026-09-05');
    console.log('        EXPECTED: included (unchanged behavior)\n');

    const { bookingId: bookingIdG } = await createBooking(client);
    const resG = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, status, stay_status,
         check_in, check_out, booked_room_type_id_snapshot, guest_name,
         stay_sequence, total_price, amount_paid, payment_status
       ) VALUES ($1, NULL, 'CHECKED_OUT', 'CHECKED_OUT',
         '2026-09-01'::date, '2026-09-05'::date, $2, 'Test Guest G',
         1, 500000, 500000, 'PAID')
       RETURNING id`,
      [bookingIdG, roomTypeId]
    );
    const reservationIdG = Number(resG.rows[0].id);

    const txResG = await client.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_time,
         transaction_type, transaction_status, net_amount, source_type,
         source_id, reservation_id, booking_id, category_code, category_name,
         description, guest_name_snapshot
       ) VALUES ($1, 'TRX-G-FO1B', '2026-09-05', NOW(), 'SALE', 'POSTED',
         500000, 'RESERVATION', $2, $3, $4, 'ROOM_CHARGE', 'Room Charge',
         'Sale', 'Test')
       RETURNING id`,
      [PROPERTY_ID, String(reservationIdG), reservationIdG, bookingIdG]
    );
    const transactionIdG = Number(txResG.rows[0].id);

    const resultG = await getTransactions(client, {
      property_id: PROPERTY_ID,
      start_date: '2026-09-05',
      end_date: '2026-09-05',
      operational_sheet: 'SELESAI',
    });

    const caseGTxIds = resultG.transactions.map(t => Number(t.id));
    assert.ok(
      caseGTxIds.includes(transactionIdG),
      `CASE G: Transaction ${transactionIdG} should still work`
    );
    console.log(`  ✓ PASS: Checked-out transactions unchanged\n`);

    // =========================================================================
    // CASE H: VOIDED/REVERSED transaction
    // EXPECTED: unchanged (not affected by FO-1B)
    // =========================================================================
    console.log('CASE H: VOIDED transaction on 2026-09-05');
    console.log('        Filter: BATAL, 2026-09-05');
    console.log('        EXPECTED: included (unchanged behavior)\n');

    const { bookingId: bookingIdH } = await createBooking(client);
    const resH = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, status, stay_status,
         check_in, check_out, booked_room_type_id_snapshot, guest_name,
         stay_sequence, total_price, amount_paid, payment_status
       ) VALUES ($1, NULL, 'BOOKED', 'CHECKED_IN',
         '2026-09-10'::date, '2026-09-11'::date, $2, 'Test Guest H',
         1, 500000, 500000, 'PAID')
       RETURNING id`,
      [bookingIdH, roomTypeId]
    );
    const reservationIdH = Number(resH.rows[0].id);

    const txResH = await client.query(
      `INSERT INTO transactions (
         property_id, transaction_no, transaction_date, transaction_time,
         transaction_type, transaction_status, net_amount, source_type,
         source_id, reservation_id, booking_id, category_code, category_name,
         description, guest_name_snapshot
       ) VALUES ($1, 'TRX-H-FO1B', '2026-09-05', NOW(), 'SALE', 'VOIDED',
         -500000, 'RESERVATION', $2, $3, $4, 'ROOM_CHARGE', 'Room Charge',
         'Voided sale', 'Test')
       RETURNING id`,
      [PROPERTY_ID, String(reservationIdH), reservationIdH, bookingIdH]
    );
    const transactionIdH = Number(txResH.rows[0].id);

    const resultH = await getTransactions(client, {
      property_id: PROPERTY_ID,
      start_date: '2026-09-05',
      end_date: '2026-09-05',
      operational_sheet: 'BATAL',
    });

    const caseHTxIds = resultH.transactions.map(t => Number(t.id));
    assert.ok(
      caseHTxIds.includes(transactionIdH),
      `CASE H: Transaction ${transactionIdH} should still work in BATAL`
    );
    console.log(`  ✓ PASS: Voided transactions unchanged\n`);

    console.log('=== ALL REGRESSION TESTS PASSED ===');
  } finally {
    // Always rollback to avoid polluting test DB
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

runTests().catch(err => {
  console.error('TEST FAILED:', err.message);
  process.exit(1);
});
