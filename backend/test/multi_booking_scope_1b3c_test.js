/**
 * multi_booking_scope_1b3c_test.js
 *
 * MULTI-BOOKING-SCOPE-1B3C — Runtime Booking-Creation Activation
 *
 * Tests the actual createCanonicalBooking runtime for multi-room group payment.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const { createCanonicalBooking } = require('../dist/index');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const runId = `1B3C-${String(Date.now()).slice(-8)}`;
let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    passed++;
    console.log(`PASS | ${message}`);
  } else {
    failed++;
    console.error(`FAIL | ${message}`);
  }
}

// ─── Fixture setup (following booking_payment_allocation_contract_test pattern) ─
let propertyId = null;
let roomIds = [];
let roomTypeIds = [];
let suffix = Date.now();
const checkIn = '2028-06-10';
const checkOut = '2028-06-11';

async function setupFixtures() {
  suffix = Date.now();
  roomIds = [];
  roomTypeIds = [];
  // Create property and rooms with proper rates (500000 per room)
  const propRes = await pool.query(
    `INSERT INTO properties (name, property_code) VALUES ($1, $2) RETURNING id`,
    [`1B3C-${suffix}`, `P${String(suffix).slice(-4)}`]
  );
  propertyId = Number(propRes.rows[0].id);

  for (let i = 0; i < 2; i++) {
    const rt = await pool.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, is_active)
       VALUES ($1, $2, $3, 500000, true) RETURNING id`,
      [propertyId, `RT${suffix}-${i}`, `RT-${suffix}-${i}`]
    );
    const rtId = Number(rt.rows[0].id);
    roomTypeIds.push(rtId);

    const rm = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, $3, $3, 'VACANT_CLEAN', true) RETURNING id`,
      [propertyId, rtId, `R${suffix}-${i}`]
    );
    roomIds.push(Number(rm.rows[0].id));

    // Create rate plan with canonical gross
    await pool.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, meal_plan, rate_type, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, 'RO', 'OVERNIGHT', true, 0)`,
      [propertyId, rtId, `RP${suffix}-${i}`, `RP-${suffix}-${i}`, 500000]
    );

    // Insert availability
    await pool.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES ($1, $2, $3::date, 5, 0)
       ON CONFLICT (room_type, date) DO UPDATE SET total_rooms = 5, reserved_qty = 0`,
      [rtId, `RT-${suffix}-${i}`, checkIn]
    );
  }
}

async function runWithFixtures(testFn) {
  await setupFixtures();
  try {
    await testFn();
  } finally {
    await cleanupProperty(propertyId);
    await assertZeroResidue(propertyId, testFn.name);
  }
}

// Assert zero fixture residue for the test property. Cleanup failures are
// NOT silently treated as success — they surface as explicit FAIL checks.
async function assertZeroResidue(pid, testName) {
  const residueChecks = [
    ['bookings', `SELECT COUNT(*) as cnt FROM bookings WHERE property_id = $1`],
    ['reservations', `SELECT COUNT(*) as cnt FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE b.property_id = $1`],
    ['payment_transactions', `SELECT COUNT(*) as cnt FROM payment_transactions WHERE property_id = $1`],
    ['payment_allocations', `SELECT COUNT(*) as cnt FROM payment_allocations WHERE property_id = $1`],
    ['payment_evidences', `SELECT COUNT(*) as cnt FROM payment_evidences WHERE property_id = $1`],
    ['folio_entries', `SELECT COUNT(*) as cnt FROM folio_entries WHERE property_id = $1`],
    ['rooms', `SELECT COUNT(*) as cnt FROM rooms WHERE property_id = $1`],
    ['room_types', `SELECT COUNT(*) as cnt FROM room_types WHERE property_id = $1`]
  ];
  for (const [label, sql] of residueChecks) {
    const r = await pool.query(sql, [pid]).catch(() => null);
    const cnt = r ? Number(r.rows[0].cnt) : -1;
    check(cnt === 0, `RESIDUE[${testName}]: zero ${label} residue (found ${cnt})`);
  }
}

function fakeReq(payload) {
  return {
    user: { username: 'FO.TEST', name: 'Front Office Test' },
    body: payload,
    headers: { 'x-correlation-id': `CORR-${suffix}` }
  };
}

async function createBooking(payload) {
  try {
    const result = await createCanonicalBooking(fakeReq(payload), payload, payload.reservations, { requirePropertyId: true });
    return { ok: true, result, error: null };
  } catch (err) {
    return { ok: false, error: err };
  }
}

async function cleanupBooking(bookingId) {
  if (!bookingId) return;
  const resIds = await pool.query('SELECT id FROM reservations WHERE booking_id = $1', [bookingId]);
  const ids = resIds.rows.map(r => r.id);
  if (ids.length > 0) {
    await pool.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
    await pool.query('DELETE FROM payment_allocations WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
    await pool.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
    // Also delete any BOOKING_GROUP payments for this booking
    await pool.query('DELETE FROM payment_transactions WHERE booking_id = $1', [bookingId]).catch(() => {});
    await pool.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [ids]).catch(() => {});
    await pool.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = ANY($2::int[])', ['RESERVATION', ids]).catch(() => {});
    await pool.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [ids]);
  }
  await pool.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = $2', ['BOOKING', bookingId]).catch(() => {});
  await pool.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
}

async function cleanupProperty(pid) {
  if (!pid) return;
  // Children before parents — FK-safe deletion order
  await pool.query('DELETE FROM payment_evidences WHERE property_id = $1', [pid]).catch(() => {});
  await pool.query('DELETE FROM payment_allocations WHERE property_id = $1', [pid]).catch(() => {});
  await pool.query(
    `DELETE FROM payment_transactions WHERE property_id = $1
     OR booking_id IN (SELECT id FROM bookings WHERE property_id = $1)
     OR reservation_id IN (SELECT r.id FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE b.property_id = $1)`,
    [pid]
  ).catch(() => {});
  await pool.query('DELETE FROM folio_entries WHERE property_id = $1', [pid]).catch(() => {});
  await pool.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [pid]).catch(() => {});
  await pool.query('DELETE FROM bookings WHERE property_id = $1', [pid]).catch(() => {});
  await pool.query('DELETE FROM audit_logs WHERE property_id = $1', [pid]).catch(() => {});
  // Must delete room-level tables BEFORE room_types (FK: rooms/rate_plans/availability_dates → room_types)
  await pool.query('DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = $1)', [pid]).catch(() => {});
  await pool.query('DELETE FROM rate_plans WHERE property_id = $1', [pid]).catch(() => {});
  await pool.query('DELETE FROM rooms WHERE property_id = $1', [pid]).catch(() => {});
  await pool.query('DELETE FROM room_types WHERE property_id = $1', [pid]).catch(() => {});
  await pool.query('DELETE FROM properties WHERE id = $1', [pid]).catch(() => {});
}

// ─── Payload builders ──────────────────────────────────────────────────────────
function buildChildPayload(roomId, index) {
  return {
    room_id: roomId,
    check_in: checkIn,
    check_out: checkOut,
    stay_type: 'OVERNIGHT',
    guest_name: `Guest ${index}`,
    subtotal_amount: 1, // decoy
    total_price: 1,     // decoy
    is_manual_override: false,
    qty: 1
  };
}

// Build a payload that passes createCanonicalBooking validation but has
// canonical due = 500000 (same as room rate plan)
function buildRealChildPayload(roomId, index) {
  return {
    room_id: roomId,
    check_in: checkIn,
    check_out: checkOut,
    stay_type: 'OVERNIGHT',
    guest_name: `Guest ${index}`,
    subtotal_amount: 500000,
    total_price: 500000,
    is_manual_override: true,
    qty: 1
  };
}

function buildBookingPayload(amountPaid, extras = {}) {
  return {
    property_id: propertyId,
    guest_name: 'Group Guest',
    guest_phone: '09171234567',
    guest_segment: 'Walk-in',
    booker_name: 'Booker',
    booker_phone: '09171234568',
    booking_source: 'WALKIN',
    booking_channel: 'WALK_IN',
    has_valid_identity: true,
    identity_number: '3171010101990001',
    ktp_path: '/uploads/ktp-test.jpg',
    payment_method: 'CASH',
    amount_paid: amountPaid,
    ...extras
  };
}

// ─── Test cases ────────────────────────────────────────────────────────────────

async function test1_singleRoomWithPayment() {
  console.log('\n--- T1: Single-room + payment (should stay unchanged) ---');
  let bookingId = null;
  try {
    const bookingPayload = buildBookingPayload(500000);
    bookingPayload.reservations = [buildChildPayload(roomIds[0], 0)];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T1.1: booking created successfully');
    bookingId = result.result?.booking?.id;
    check(bookingId !== undefined, 'T1.2: booking has ID');
    check(result.result?.reservations?.length === 1, 'T1.3: exactly 1 reservation');

    if (bookingId) {
      const payRes = await pool.query(
        `SELECT scope, COUNT(*) as cnt FROM payment_transactions
         WHERE booking_id = $1 GROUP BY scope`,
        [bookingId]
      );
      const scopes = {};
      for (const row of payRes.rows) scopes[row.scope] = Number(row.cnt);
      check(scopes['ROOM_RESERVATION'] === 1, 'T1.4: exactly 1 ROOM_RESERVATION payment');
      check((scopes['BOOKING_GROUP'] || 0) === 0, 'T1.5: zero BOOKING_GROUP payments');

      const allocRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM payment_allocations WHERE booking_id = $1`,
        [bookingId]
      );
      check(Number(allocRes.rows[0].cnt) === 0, 'T1.6: zero allocations for single-room');
    }
  } catch (err) {
    check(false, `T1: unexpected error: ${err.code || err.message}`);
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test2_twoRoomFullPayment() {
  console.log('\n--- T2: Two-room + full payment (group payment) ---');
  let bookingId = null;
  try {
    const bookingPayload = buildBookingPayload(1000000);
    bookingPayload.reservations = [
      buildChildPayload(roomIds[0], 0),
      buildChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T2.1: booking created successfully');
    bookingId = result.result?.booking?.id;
    check(bookingId !== undefined, 'T2.2: booking has ID');
    check(result.result?.reservations?.length === 2, 'T2.3: exactly 2 reservations');

    if (bookingId) {
      const payRes = await pool.query(
        `SELECT scope, COUNT(*) as cnt FROM payment_transactions
         WHERE booking_id = $1 GROUP BY scope`,
        [bookingId]
      );
      const scopes = {};
      for (const row of payRes.rows) scopes[row.scope] = Number(row.cnt);
      check((scopes['BOOKING_GROUP'] || 0) === 1, 'T2.4: exactly 1 BOOKING_GROUP payment');
      check((scopes['ROOM_RESERVATION'] || 0) === 0, 'T2.5: zero synthetic ROOM_RESERVATION child payments');

      const allocRes = await pool.query(
        `SELECT pa.reservation_id, pa.allocated_amount, pt.amount as parent_amount
         FROM payment_allocations pa
         JOIN payment_transactions pt ON pt.id = pa.payment_transaction_id
         WHERE pa.booking_id = $1 AND pa.status = 'ACTIVE'`,
        [bookingId]
      );
      check(allocRes.rowCount >= 1, 'T2.6: at least 1 allocation created');
      const totalAllocated = allocRes.rows.reduce((sum, r) => sum + Number(r.allocated_amount), 0);
      const parentAmount = allocRes.rows.length > 0 ? Number(allocRes.rows[0].parent_amount) : 0;
      check(totalAllocated === parentAmount, 'T2.7: allocation sum equals parent amount');
      check(parentAmount === 1000000, 'T2.8: parent amount equals bookingLevelCash');
    }
  } catch (err) {
    check(false, `T2: unexpected error: ${err.code || err.message}`);
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test3_twoRoomPartialPayment() {
  console.log('\n--- T3: Two-room + partial payment (deterministic first-fit) ---');
  let bookingId = null;
  try {
    const bookingPayload = buildBookingPayload(600000);
    bookingPayload.reservations = [
      buildChildPayload(roomIds[0], 0),
      buildChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T3.1: booking created successfully');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      const allocRes = await pool.query(
        `SELECT pa.reservation_id, pa.allocated_amount, pa.allocation_sequence
          FROM payment_allocations pa
          JOIN reservations r ON r.id = pa.reservation_id
          WHERE pa.booking_id = $1 AND pa.status = 'ACTIVE'
          ORDER BY pa.allocation_sequence ASC`,
        [bookingId]
      );

      // Exact first-fit: room1 gets 500000 (full due), room2 gets 100000 (remaining)
      check(allocRes.rowCount === 2, 'T3.2: exactly 2 allocations');
      check(Number(allocRes.rows[0].allocated_amount) === 500000, 'T3.3: first allocation = 500000 (full room due)');
      check(Number(allocRes.rows[1].allocated_amount) === 100000, 'T3.4: second allocation = 100000 (remainder)');
      const totalAllocated = allocRes.rows.reduce((sum, r) => sum + Number(r.allocated_amount), 0);
      check(totalAllocated === 600000, 'T3.5: allocation sum equals 600000 (conservation)');
    }
  } catch (err) {
    check(false, `T3: unexpected error: ${err.code || err.message}`);
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test4_twoRoomNoPayment() {
  console.log('\n--- T4: Two-room + no payment (no payment rows) ---');
  let bookingId = null;
  try {
    const bookingPayload = buildBookingPayload(0);
    bookingPayload.reservations = [
      buildChildPayload(roomIds[0], 0),
      buildChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T4.1: booking created successfully without payment');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      const payRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM payment_transactions WHERE booking_id = $1`,
        [bookingId]
      );
      check(Number(payRes.rows[0].cnt) === 0, 'T4.2: zero payment rows for no-payment booking');

      const allocRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM payment_allocations WHERE booking_id = $1`,
        [bookingId]
      );
      check(Number(allocRes.rows[0].cnt) === 0, 'T4.3: zero allocations for no-payment booking');
    }
  } catch (err) {
    check(false, `T4: unexpected error: ${err.code || err.message}`);
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test5_overpayment() {
  console.log('\n--- T5: Overpayment (should throw OVERPAYMENT_NOT_ALLOWED, full rollback) ---');
  let bookingId = null;
  try {
    // Snapshot availability before (per test-property room types)
    const availBefore = await pool.query(
      `SELECT room_type_id, reserved_qty FROM availability_dates
       WHERE room_type_id = ANY($1::int[])`,
      [roomTypeIds]
    );
    const reservedBefore = {};
    for (const row of availBefore.rows) reservedBefore[row.room_type_id] = Number(row.reserved_qty);

    const bookingPayload = buildBookingPayload(1500000); // Overpay (total due = 1000000)
    bookingPayload.reservations = [
      buildRealChildPayload(roomIds[0], 0),
      buildRealChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(!result.ok, 'T5.1: throws on overpayment');
    check(result.error?.code === 'OVERPAYMENT_NOT_ALLOWED', 'T5.2: correct error code');

    // ── Full rollback residue check (scoped to test property) ──
    const residueTables = [
      ['bookings', `SELECT COUNT(*) as cnt FROM bookings WHERE property_id = $1`],
      ['reservations', `SELECT COUNT(*) as cnt FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE b.property_id = $1`],
      ['payment_transactions', `SELECT COUNT(*) as cnt FROM payment_transactions WHERE property_id = $1`],
      ['payment_allocations', `SELECT COUNT(*) as cnt FROM payment_allocations WHERE property_id = $1`],
      ['payment_evidences', `SELECT COUNT(*) as cnt FROM payment_evidences WHERE property_id = $1`],
      ['folio_entries BOOKING_PAYMENT', `SELECT COUNT(*) as cnt FROM folio_entries WHERE property_id = $1 AND entry_type = 'PAYMENT' AND source_type = 'BOOKING_PAYMENT'`]
    ];
    for (const [label, sql] of residueTables) {
      const r = await pool.query(sql, [propertyId]);
      check(Number(r.rows[0].cnt) === 0, `T5.3.${label}: zero residue after rollback`);
    }

    // Availability restored
    const availAfter = await pool.query(
      `SELECT room_type_id, reserved_qty FROM availability_dates
       WHERE room_type_id = ANY($1::int[])`,
      [roomTypeIds]
    );
    for (const row of availAfter.rows) {
      check(Number(row.reserved_qty) === reservedBefore[row.room_type_id],
        `T5.4: availability restored for room_type ${row.room_type_id} (${reservedBefore[row.room_type_id]} → ${row.reserved_qty})`);
    }
  } catch (err) {
    check(false, `T5: unexpected error: ${err.code || err.message}`);
  } finally {
    // Cleanup any partial bookings
    const bookings = await pool.query('SELECT id FROM bookings WHERE property_id = $1', [propertyId]);
    for (const b of bookings.rows) {
      await cleanupBooking(Number(b.id));
    }
  }
}

async function test6_groupFolioBehavior() {
  console.log('\n--- T6: Group folio behavior (no duplicate payment folio entries) ---');
  let bookingId = null;
  try {
    const bookingPayload = buildBookingPayload(1000000);
    bookingPayload.reservations = [
      buildChildPayload(roomIds[0], 0),
      buildChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T6.1: booking created successfully');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      const folioRes = await pool.query(
        `SELECT fe.reservation_id, fe.entry_type, fe.direction,
                COUNT(*) as cnt
         FROM folio_entries fe
         JOIN reservations r ON r.id = fe.reservation_id
         WHERE r.booking_id = $1
           AND fe.entry_type = 'PAYMENT'
         GROUP BY fe.reservation_id, fe.entry_type, fe.direction`,
        [bookingId]
      );

      check(folioRes.rowCount === 2, 'T6.2: exactly 2 folio entries (one per reservation)');
      check(folioRes.rows.every(r => r.direction === 'CREDIT'), 'T6.3: all folio entries are CREDIT');

      // No duplicates
      const dupCheck = await pool.query(
        `SELECT reservation_id, COUNT(*) as cnt FROM folio_entries
         WHERE reservation_id IN (
           SELECT id FROM reservations WHERE booking_id = $1
         ) AND entry_type = 'PAYMENT'
         GROUP BY reservation_id HAVING COUNT(*) > 1`,
        [bookingId]
      );
      check(dupCheck.rowCount === 0, 'T6.4: no duplicate payment folio entries per reservation');
    }
  } catch (err) {
    check(false, `T6: unexpected error: ${err.code || err.message}`);
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test7_canonicalPaidRemaining() {
  console.log('\n--- T7: Canonical paid/remaining (each child reflects only its allocation) ---');
  let bookingId = null;
  try {
    const bookingPayload = buildBookingPayload(1000000);
    bookingPayload.reservations = [
      buildChildPayload(roomIds[0], 0),
      buildChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T7.1: booking created successfully');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      const resPayRes = await pool.query(
        `SELECT r.id as reservation_id, r.amount_paid, r.total_price,
                COALESCE(pa.allocated_amount, 0) as allocated
         FROM reservations r
         LEFT JOIN payment_allocations pa ON pa.reservation_id = r.id AND pa.status = 'ACTIVE'
         WHERE r.booking_id = $1
         ORDER BY r.stay_sequence ASC`,
        [bookingId]
      );

      check(resPayRes.rowCount === 2, 'T7.2: two reservations exist');
      for (const row of resPayRes.rows) {
        check(Number(row.amount_paid) === Number(row.allocated),
          `T7.3: reservation ${row.reservation_id} amount_paid=${row.amount_paid} matches allocation`);
      }

      const totalPaid = resPayRes.rows.reduce((sum, r) => sum + Number(r.amount_paid), 0);
      const totalDue = resPayRes.rows.reduce((sum, r) => sum + Number(r.total_price), 0);
      check(totalPaid <= totalDue, 'T7.4: total paid does not exceed total due');
    }
  } catch (err) {
    check(false, `T7: booking failed: ${err.code || err.message}`);
    console.log('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test8_evidenceLinkedToGroupParent() {
  console.log('\n--- T8: Evidence linked to group parent, anchored to first allocation ---');
  let bookingId = null;
  try {
    const bookingPayload = buildBookingPayload(1000000, { bukti_bayar_path: '/test/evidence/receipt_1b3c.jpg' });
    bookingPayload.reservations = [
      buildChildPayload(roomIds[0], 0),
      buildChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T8.1: booking created successfully with evidence');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      const evidRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM payment_evidences WHERE property_id = $1`,
        [propertyId]
      );
      check(Number(evidRes.rows[0].cnt) === 1, 'T8.2: exactly 1 evidence row');

      const payRes = await pool.query(
        `SELECT id FROM payment_transactions WHERE booking_id = $1 AND scope = 'BOOKING_GROUP'`,
        [bookingId]
      );
      const groupPaymentId = Number(payRes.rows[0]?.id);
      check(groupPaymentId > 0, 'T8.3: BOOKING_GROUP payment exists');

      const evidLinkedRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM payment_evidences
         WHERE property_id = $1 AND payment_transaction_id = $2`,
        [propertyId, groupPaymentId]
      );
      check(Number(evidLinkedRes.rows[0].cnt) === 1, 'T8.4: evidence linked to group parent');

      const allocRes = await pool.query(
        `SELECT reservation_id FROM payment_allocations
         WHERE payment_transaction_id = $1 AND allocated_amount > 0
         ORDER BY allocation_sequence ASC LIMIT 1`,
        [groupPaymentId]
      );
      const anchorReservationId = Number(allocRes.rows[0]?.reservation_id);
      check(anchorReservationId > 0, 'T8.5: anchor reservation exists');

      const evidAnchorRes = await pool.query(
        `SELECT reservation_id FROM payment_evidences WHERE property_id = $1`,
        [propertyId]
      );
      check(Number(evidAnchorRes.rows[0].reservation_id) === anchorReservationId,
        'T8.6: evidence anchored to first positive allocation reservation');
    }
  } catch (err) {
    check(false, `T8: booking failed: ${err.code || err.message}`);
    console.log('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test9_singleRoomEvidenceRegression() {
  console.log('\n--- T9: Single-room evidence regression (unchanged direct behavior) ---');
  let bookingId = null;
  try {
    const bookingPayload = buildBookingPayload(500000, { bukti_bayar_path: '/test/evidence/single_receipt.jpg' });
    bookingPayload.reservations = [buildChildPayload(roomIds[0], 0)];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T9.1: single-room booking created successfully');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      const payRes = await pool.query(
        `SELECT scope, COUNT(*) as cnt FROM payment_transactions
         WHERE booking_id = $1 GROUP BY scope`,
        [bookingId]
      );
      const scopes = {};
      for (const row of payRes.rows) scopes[row.scope] = Number(row.cnt);
      check(scopes['ROOM_RESERVATION'] === 1, 'T9.2: exactly 1 ROOM_RESERVATION payment');
      check((scopes['BOOKING_GROUP'] || 0) === 0, 'T9.3: zero BOOKING_GROUP payments');

      const evidRes = await pool.query(
        `SELECT pe.payment_transaction_id, pt.scope
         FROM payment_evidences pe
         JOIN payment_transactions pt ON pt.id = pe.payment_transaction_id
         WHERE pe.property_id = $1`,
        [propertyId]
      );
      check(evidRes.rowCount === 1, 'T9.4: exactly 1 evidence row');
      check(evidRes.rows[0].scope === 'ROOM_RESERVATION', 'T9.5: evidence linked to ROOM_RESERVATION');
    }
  } catch (err) {
    check(false, `T9: booking failed: ${err.code || err.message}`);
    console.log('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test10_zeroValueChild() {
  console.log('\n--- T10: Zero-value child (real zero-due via discount) ---');
  let bookingId = null;
  try {
    // Build a payload where one child gets 100% discount (zero due), another is payable
    const bookingPayload = buildBookingPayload(500000); // Pay for one room only
    bookingPayload.reservations = [
      // Child 0: full price room (500000)
      {
        room_id: roomIds[0],
        check_in: checkIn,
        check_out: checkOut,
        stay_type: 'OVERNIGHT',
        guest_name: 'Guest 0',
        subtotal_amount: 500000,
        total_price: 500000,
        is_manual_override: true,
        qty: 1
      },
      // Child 1: zero-value child via legit booking pricing mechanism
      // (100% room-level discount → canonical net total = 0)
      {
        room_id: roomIds[1],
        check_in: checkIn,
        check_out: checkOut,
        stay_type: 'OVERNIGHT',
        guest_name: 'Guest 1',
        subtotal_amount: 500000,
        total_price: 500000, // gross; net becomes 0 after 100% discount
        is_manual_override: true,
        discount_percent: 100,
        discount_reason: 'Promo 1B3C T10',
        qty: 1
      }
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T10.1: booking created successfully');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      // Verify each reservation's canonical total_price (net after discount)
      const resPrices = await pool.query(
        `SELECT r.id as reservation_id, r.total_price, r.discount_amount
          FROM reservations r
          WHERE r.booking_id = $1
          ORDER BY r.stay_sequence ASC`,
        [bookingId]
      );
      check(Number(resPrices.rows[1].discount_amount) === 500000, 'T10.2: second child discount_amount = 500000 (100% discount applied)');
      check(Number(resPrices.rows[1].total_price) === 0, 'T10.3: second child total_price = 0 (real zero-due)');

      // Verify allocation: only positive-due child gets allocation
      const allocRes = await pool.query(
        `SELECT pa.reservation_id, pa.allocated_amount
          FROM payment_allocations pa
          WHERE pa.booking_id = $1 AND pa.status = 'ACTIVE'
          ORDER BY pa.allocation_sequence ASC`,
        [bookingId]
      );

      check(allocRes.rowCount === 1, 'T10.4: exactly 1 positive allocation (zero-due child skipped)');
      check(Number(allocRes.rows[0].allocated_amount) === 500000, 'T10.5: payable child gets full 500000');

      // Verify zero-due child has no positive allocation and stays financially correct
      const allAllocRes = await pool.query(
        `SELECT r.id as reservation_id, r.total_price, r.amount_paid, r.remaining_balance, COALESCE(pa.allocated_amount, 0) as allocated
          FROM reservations r
          LEFT JOIN payment_allocations pa ON pa.reservation_id = r.id AND pa.status = 'ACTIVE'
          WHERE r.booking_id = $1
          ORDER BY r.stay_sequence ASC`,
        [bookingId]
      );
      const zeroDueChild = allAllocRes.rows.find(r => Number(r.total_price) === 0);
      check(zeroDueChild && Number(zeroDueChild.allocated) === 0, 'T10.6: zero-due child receives no positive allocation');
      check(zeroDueChild && Number(zeroDueChild.amount_paid) === 0 && Number(zeroDueChild.remaining_balance) === 0,
        'T10.7: zero-due child financially correct (paid=0, remaining=0)');

      // Conservation: total allocation equals parent amount
      const totalAllocated = allAllocRes.rows.reduce((sum, r) => sum + Number(r.allocated), 0);
      check(totalAllocated === 500000, 'T10.8: allocation conservation equals parent amount');
    }
  } catch (err) {
    check(false, `T10: booking failed: ${err.code || err.message}`);
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

// ─── Run tests ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== RUNNING MULTI-BOOKING-SCOPE-1B3C TESTS [runId=${runId}] ===\n`);

  try {
    await runWithFixtures(test1_singleRoomWithPayment);
    await runWithFixtures(test2_twoRoomFullPayment);
    await runWithFixtures(test3_twoRoomPartialPayment);
    await runWithFixtures(test4_twoRoomNoPayment);
    await runWithFixtures(test5_overpayment);
    await runWithFixtures(test6_groupFolioBehavior);
    await runWithFixtures(test7_canonicalPaidRemaining);
    await runWithFixtures(test8_evidenceLinkedToGroupParent);
    await runWithFixtures(test9_singleRoomEvidenceRegression);
    await runWithFixtures(test10_zeroValueChild);
  } finally {
    await pool.end();
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
