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
const http = require('http');
const { createCanonicalBooking } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');

let authToken = '';

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

// ─── HTTP helper for check-in endpoint (used by T14–T20) ────────────────────
let testServer = null;
let testPort = null;

async function startTestServer() {
  const { app } = require('../dist/index');
  return new Promise((resolve) => {
    testServer = http.createServer(app);
    testServer.listen(0, () => {
      testPort = testServer.address().port;
      resolve(testServer);
    });
  });
}

async function stopTestServer() {
  if (testServer) {
    await new Promise((r) => testServer.close(r));
    testServer = null;
    testPort = null;
  }
}

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) };
    const req = http.request(
      { hostname: '127.0.0.1', port: testPort, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function check(condition, message) {
  if (condition) {
    passed++;
    console.log(`PASS | ${message}`);
  } else {
    failed++;
    console.error(`FAIL | ${message}`);
  }
}

// ─── Auth token setup (for HTTP API tests T14–T20) ───────────────────────────
async function setupAuthToken(pool) {
  const authSuffix = Date.now();
  // Get or create a test super admin user
  const userRes = await pool.query(
    `SELECT u.id, u.username, r.id as role_id, r.name as role_name
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.is_system_role = true AND r.name ILIKE '%super%'
     LIMIT 1`
  );
  let userId;
  if (userRes.rows.length > 0) {
    userId = Number(userRes.rows[0].id);
  } else {
    // Create a test super admin with unique username to avoid constraint hits
    const roleIdRes = await pool.query(
      `SELECT id FROM roles WHERE name ILIKE '%super%' AND is_system_role = true LIMIT 1`
    );
    const roleId = Number(roleIdRes.rows[0]?.id || 1);
    const insertRes = await pool.query(
      `INSERT INTO users (username, email, password_hash, role_id, property_id, is_active)
       VALUES ($1,$2,'dummy','$3',1,true) RETURNING id`,
      [`FO.TEST.${authSuffix}`, `fo.test.${authSuffix}@test.com`, roleId]
    );
    userId = Number(insertRes.rows[0].id);
  }
  authToken = generateToken({
    id: userId,
    email: `fo.test.${authSuffix}@test.com`,
    username: `FO.TEST.${authSuffix}`,
    full_name: 'Test FO Staff',
    role: 'Super Admin',
    role_id: 1,
    property_id: 1,
    scope: 'FULL'
  });
  console.log(`  [AUTH] token generated for user ${userId}`);
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
  // Generate a collision-resistant property_code within varchar(6) limit.
  // Use "T1" prefix + 4 base36 chars → up to 36⁴ = 1.68M candidates.
  const base36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const randChars = () => {
    let r = '';
    for (let i = 0; i < 4; i++) {
      r += base36.charAt(Math.floor(Math.random() * base36.length));
    }
    return r;
  };
  let propCode;
  let propRes;
  let collisions = 0;
  const maxAttempts = 20;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    propCode = `T1${randChars()}`;
    try {
      propRes = await pool.query(
        `INSERT INTO properties (name, property_code) VALUES ($1, $2) RETURNING id`,
        [`1B3C-${suffix}`, propCode]
      );
      break; // Success
    } catch (err) {
      if (err?.code === '23505') {
        collisions++;
        if (collisions >= maxAttempts) {
          throw new Error(`Test setup failed: unable to generate unique property_code after ${maxAttempts} attempts`);
        }
        continue; // Collision — retry with new random suffix
      }
      throw err;
    }
  }
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

// Replicate the folio endpoint's combined evidence-read pattern so tests
// exercise the actual runtime logic, not a hand-copied ad-hoc query.
async function queryFolioEvidences(reservationId, propertyId) {
  return pool.query(
    `SELECT pe.* FROM payment_evidences pe
     WHERE pe.property_id = $2
       AND (
         pe.reservation_id = $1
         OR EXISTS (
           SELECT 1 FROM payment_allocations pa
           JOIN payment_transactions pt ON pt.id = pa.payment_transaction_id
           WHERE pa.payment_transaction_id = pe.payment_transaction_id
             AND pa.reservation_id = $1
             AND pa.status = 'ACTIVE'
             AND pt.scope = 'BOOKING_GROUP'
             AND pt.property_id = $2
         )
       )
     ORDER BY pe.id DESC`,
    [reservationId, propertyId]
  );
}

// Replicate the folio endpoint's combined payments-read pattern so tests
// exercise the actual runtime logic.
async function queryFolioPayments(reservationId, propertyId) {
  return pool.query(
    `SELECT DISTINCT pt.* FROM payment_transactions pt
     WHERE (
       pt.reservation_id = $1
       AND (pt.property_id = $2 OR pt.property_id IS NULL)
     )
     OR (
       pt.scope = 'BOOKING_GROUP'
       AND pt.property_id = $2
       AND EXISTS (
         SELECT 1 FROM payment_allocations pa
         WHERE pa.payment_transaction_id = pt.id
           AND pa.reservation_id = $1
           AND pa.status = 'ACTIVE'
       )
     )
     ORDER BY pt.id DESC`,
    [reservationId, propertyId]
  );
}
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

async function test11_nonAnchorSharedEvidenceRead() {
  console.log('\n--- T11: Non-anchor child sees shared group evidence via folio endpoint ---');
  let bookingId = null;
  let anchorResId = null;
  let nonAnchorResId = null;
  let groupPaymentId = null;
  try {
    const bookingPayload = buildBookingPayload(600000, { bukti_bayar_path: '/test/evidence/t11_receipt.jpg' });
    bookingPayload.reservations = [
      buildRealChildPayload(roomIds[0], 0),
      buildRealChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T11.1: booking created successfully with group payment and evidence');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      // Identify anchor and non-anchor reservations
      const allocRes = await pool.query(
        `SELECT pa.reservation_id, pa.allocated_amount
         FROM payment_allocations pa
         WHERE pa.booking_id = $1 AND pa.status = 'ACTIVE'
         ORDER BY pa.allocation_sequence ASC`,
        [bookingId]
      );
      check(allocRes.rowCount === 2, 'T11.2: two active allocations exist');
      anchorResId = Number(allocRes.rows[0].reservation_id);
      nonAnchorResId = Number(allocRes.rows[1].reservation_id);
      check(nonAnchorResId !== anchorResId, 'T11.3: anchor and non-anchor are different reservations');

      // Identify group payment
      const payRes = await pool.query(
        `SELECT id FROM payment_transactions WHERE booking_id = $1 AND scope = 'BOOKING_GROUP'`,
        [bookingId]
      );
      groupPaymentId = Number(payRes.rows[0]?.id);
      check(groupPaymentId > 0, 'T11.4: BOOKING_GROUP parent payment exists');

      // --- Combined folio read: payments ---
      const folioPaymentsRes = await queryFolioPayments(nonAnchorResId, propertyId);
      const nonAnchorPaymentIds = new Set(folioPaymentsRes.rows.map(r => Number(r.id)));
      check(nonAnchorPaymentIds.has(groupPaymentId), 'T11.5: non-anchor payments includes GROUP parent');
      check(folioPaymentsRes.rowCount === 1, 'T11.6: non-anchor gets exactly 1 payment row (GROUP only, no ROOM_RESERVATION)');
      check(folioPaymentsRes.rows[0].scope === 'BOOKING_GROUP', 'T11.7: non-anchor payment is BOOKING_GROUP scope');

      // --- Combined folio read: evidences ---
      const folioEvidRes = await queryFolioEvidences(nonAnchorResId, propertyId);
      check(folioEvidRes.rowCount === 1, 'T11.8: non-anchor child receives exactly 1 evidence row');
      const ev = folioEvidRes.rows[0];
      check(ev.payment_transaction_id === groupPaymentId, 'T11.9: evidence payment_transaction_id == GROUP parent id');
      check(ev.property_id === propertyId, 'T11.10: evidence is scoped to same property');

      // Verify canonical: exactly one evidence row in database
      const totalEvidRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM payment_evidences WHERE property_id = $1`,
        [propertyId]
      );
      check(Number(totalEvidRes.rows[0].cnt) === 1, 'T11.11: database still has exactly 1 canonical evidence row');

      // Cross-property isolation: a different property cannot see this evidence
      const otherPropRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM payment_evidences WHERE property_id = $1`,
        [(propertyId % 10000) + 9000]
      );
      check(Number(otherPropRes.rows[0].cnt) === 0, 'T11.12: unrelated property sees zero evidence');

      // Same-property unrelated reservation: create a separate single-room booking
      // in the same property that is NOT allocated to the group parent.
      const standlonePayload = buildBookingPayload(500000);
      standlonePayload.reservations = [buildChildPayload(roomIds[0], 99)];
      const standaloneResult = await createBooking(standlonePayload);
      const standaloneBookingId = standaloneResult.result?.booking?.id;
      if (standaloneBookingId) {
        const stResIds = await pool.query('SELECT id FROM reservations WHERE booking_id = $1', [standaloneBookingId]);
        const stResId = Number(stResIds.rows[0]?.id);
        if (stResId > 0) {
          const stPayRes = await queryFolioPayments(stResId, propertyId);
          check(stPayRes.rowCount === 1, 'T11.13: unrelated same-property reservation sees only its own payment');
          check(stPayRes.rows[0].id !== groupPaymentId, 'T11.14: unrelated reservation does NOT see group payment');

          const stEvidRes = await queryFolioEvidences(stResId, propertyId);
          check(stEvidRes.rowCount === 0, 'T11.15: unrelated reservation sees zero group evidence');
        }
        // Clean up standalone booking residue
        await cleanupBooking(standaloneBookingId);
      }
    }
  } catch (err) {
    check(false, `T11: ${err.code || err.message}`);
    console.log('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test12_anchorRegression() {
  console.log('\n--- T12: Anchor reservation still sees shared evidence (regression guard) ---');
  let bookingId = null;
  let anchorResId = null;
  let groupPaymentId = null;
  try {
    const bookingPayload = buildBookingPayload(600000, { bukti_bayar_path: '/test/evidence/t12_receipt.jpg' });
    bookingPayload.reservations = [
      buildRealChildPayload(roomIds[0], 0),
      buildRealChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T12.1: booking created successfully');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      const allocRes = await pool.query(
        `SELECT pa.reservation_id, pa.allocated_amount
         FROM payment_allocations pa
         WHERE pa.booking_id = $1 AND pa.status = 'ACTIVE'
         ORDER BY pa.allocation_sequence ASC`,
        [bookingId]
      );
      anchorResId = Number(allocRes.rows[0]?.reservation_id);
      check(anchorResId > 0, 'T12.2: anchor reservation identified');

      const payRes = await pool.query(
        `SELECT id FROM payment_transactions WHERE booking_id = $1 AND scope = 'BOOKING_GROUP'`,
        [bookingId]
      );
      groupPaymentId = Number(payRes.rows[0]?.id);
      check(groupPaymentId > 0, 'T12.3: BOOKING_GROUP payment exists');

      // --- Combined folio read: payments ---
      const folioPaymentsRes = await queryFolioPayments(anchorResId, propertyId);
      check(folioPaymentsRes.rowCount === 1, 'T12.4: anchor gets exactly 1 payment (GROUP parent, no duplicates)');
      check(Number(folioPaymentsRes.rows[0].id) === groupPaymentId, 'T12.5: anchor payment is GROUP parent id');

      // --- Combined folio read: evidences ---
      const evidRes = await queryFolioEvidences(anchorResId, propertyId);
      check(evidRes.rowCount === 1, 'T12.6: anchor sees exactly 1 evidence');
      check(evidRes.rows[0].payment_transaction_id === groupPaymentId,
        'T12.7: anchor sees same GROUP parent payment');

      // Verify no duplicate evidence rows in database
      const totalEvidRes = await pool.query(
        `SELECT COUNT(*) as cnt FROM payment_evidences WHERE property_id = $1`,
        [propertyId]
      );
      check(Number(totalEvidRes.rows[0].cnt) === 1, 'T12.8: no duplicate evidence rows (still 1)');

      // --- Isolation: set allocation to non-ACTIVE → shared visibility must disappear ---
      const nonAnchorRes = Number(allocRes.rows[1].reservation_id);
      const beforeInactive = await queryFolioEvidences(nonAnchorRes, propertyId);
      check(beforeInactive.rowCount === 1, 'T12.9: non-anchor sees evidence while allocation ACTIVE');

      await pool.query(
        `UPDATE payment_allocations SET status = 'REVERSED' WHERE booking_id = $1 AND reservation_id = $2`,
        [bookingId, nonAnchorRes]
      );
      const afterInactiveEvid = await queryFolioEvidences(nonAnchorRes, propertyId);
      check(afterInactiveEvid.rowCount === 0, 'T12.10: non-ACTIVE allocation removes evidence visibility');

      const afterInactivePay = await queryFolioPayments(nonAnchorRes, propertyId);
      check(afterInactivePay.rowCount === 0, 'T12.11: non-ACTIVE allocation removes group payment visibility');

      // Anchor still sees it after other child's allocation released
      const anchorStillSees = await queryFolioEvidences(anchorResId, propertyId);
      check(anchorStillSees.rowCount === 1, 'T12.12: anchor evidence visibility unaffected');
    }
  } catch (err) {
    check(false, `T12: ${err.code || err.message}`);
    console.log('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test13_legacy_null_property_id() {
  console.log('\n--- T13: Legacy direct ROOM_RESERVATION payment with NULL property_id ---');
  let bookingId = null;
  try {
    const bookingPayload = buildBookingPayload(500000, { bukti_bayar_path: '/test/evidence/t13_legacy.jpg' });
    bookingPayload.reservations = [buildChildPayload(roomIds[0], 0)];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T13.1: single-room booking created');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      // Find the ROOM_RESERVATION payment and zero out its property_id (simulate legacy data)
      const payRes = await pool.query(
        `SELECT id FROM payment_transactions WHERE booking_id = $1 AND scope = 'ROOM_RESERVATION'`,
        [bookingId]
      );
      const payId = Number(payRes.rows[0]?.id);
      check(payId > 0, 'T13.2: ROOM_RESERVATION payment exists');

      await pool.query(`UPDATE payment_transactions SET property_id = NULL WHERE id = $1`, [payId]);
      check(true, 'T13.3: property_id set to NULL (legacy simulation)');

      // Now query folio — should STILL return the payment despite NULL property_id
      const resIds = await pool.query('SELECT id FROM reservations WHERE booking_id = $1', [bookingId]);
      const resId = Number(resIds.rows[0]?.id);
      const folioPayments = await queryFolioPayments(resId, propertyId);

      check(folioPayments.rowCount >= 1, 'T13.4: legacy NULL-property payment still visible in folio');
      check(folioPayments.rows.some(r => Number(r.id) === payId),
        'T13.5: the specific NULL-property payment is in the result');

      // Evidence should also still be visible (evidence table always has property_id set)
      const folioEvid = await queryFolioEvidences(resId, propertyId);
      check(folioEvid.rowCount >= 1, 'T13.6: evidence still visible alongside legacy payment');
    }
  } catch (err) {
    check(false, `T13: ${err.code || err.message}`);
    console.log('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

// ─── T14–T20: Multi-room check-in isolation + derived summary ────────────────

async function test14_multi_room_checkin_isolation() {
  console.log('\n--- T14: Multi-room check-in — first child checks in, sibling stays BOOKED ---');
  let bookingId = null;
  let childResIds = [];
  try {
    const bookingPayload = buildBookingPayload(1000000, { bukti_bayar_path: '/test/evidence/t14.jpg' });
    bookingPayload.reservations = [
      buildRealChildPayload(roomIds[0], 0),
      buildRealChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T14.1: 2-room booking created with group payment');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      const resIds = await pool.query(
        `SELECT id FROM reservations WHERE booking_id = $1 ORDER BY stay_sequence ASC`,
        [bookingId]
      );
      check(resIds.rowCount === 2, 'T14.2: two reservations created');
      childResIds = resIds.rows.map(r => Number(r.id));

      // Check in child A only
      const ciARes = await apiRequest('POST', `/api/reservations/${childResIds[0]}/checkin`, {
        property_id: propertyId,
        force: true,
        override_guest_identity: true,
        override_housekeeping: true
      });
      check(ciARes.status === 200, 'T14.3: child A check-in returns 200');
      check(ciARes.body?.data?.status === 'CHECKED_IN', 'T14.4: child A status is CHECKED_IN');

      // Child B remains BOOKED
      const checkB = await pool.query(
        `SELECT status, room_id, checked_in_at FROM reservations WHERE id = $1`,
        [childResIds[1]]
      );
      check(checkB.rows[0].status === 'BOOKED', 'T14.5: child B remains BOOKED after sibling CI');
      check(checkB.rows[0].checked_in_at === null, 'T14.6: child B checked_in_at is null');

      // Booking status still ACTIVE (not COMPLETED)
      const bookCheck = await pool.query(
        `SELECT booking_status FROM bookings WHERE id = $1`,
        [bookingId]
      );
      check(bookCheck.rows[0].booking_status === 'ACTIVE', 'T14.7: booking stays ACTIVE after 1/2 CI');

      // Room statuses: A → OCCUPIED_CLEAN, B unchanged
      const roomACheck = await pool.query(
        `SELECT status FROM rooms WHERE id = (SELECT room_id FROM reservations WHERE id = $1)`,
        [childResIds[0]]
      );
      check(roomACheck.rows[0].status === 'OCCUPIED_CLEAN', 'T14.8: room A → OCCUPIED_CLEAN');

      const roomBCheck = await pool.query(
        `SELECT status FROM rooms WHERE id = (SELECT room_id FROM reservations WHERE id = $1)`,
        [childResIds[1]]
      );
      check(roomBCheck.rows[0].status !== 'OCCUPIED_CLEAN', 'T14.9: room B NOT OCCUPIED (sibling isolation)');
    }
  } catch (err) {
    check(false, `T14: ${err.code || err.message}`);
    console.log('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test15_sequential_checkin() {
  console.log('\n--- T15: Sequential check-in — both children checked in ---');
  let bookingId = null;
  let childResIds = [];
  try {
    const bookingPayload = buildBookingPayload(1000000, { bukti_bayar_path: '/test/evidence/t15.jpg' });
    bookingPayload.reservations = [
      buildRealChildPayload(roomIds[0], 0),
      buildRealChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T15.1: 2-room booking created');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      const resIds = await pool.query(
        `SELECT id FROM reservations WHERE booking_id = $1 ORDER BY stay_sequence ASC`,
        [bookingId]
      );
      childResIds = resIds.rows.map(r => Number(r.id));

      // Check in both children sequentially
      for (const resId of childResIds) {
        const ciRes = await apiRequest('POST', `/api/reservations/${resId}/checkin`, {
          property_id: propertyId,
          force: true,
          override_guest_identity: true,
          override_housekeeping: true
        });
        check(ciRes.status === 200, `T15.2: reservation ${resId} check-in returns 200`);
      }

      // Both CHECKED_IN
      const bothCheck = await pool.query(
        `SELECT status FROM reservations WHERE booking_id = $1 ORDER BY stay_sequence ASC`,
        [bookingId]
      );
      check(bothCheck.rows.every(r => r.status === 'CHECKED_IN'), 'T15.3: both children CHECKED_IN');

      // Booking still ACTIVE (COMPLETED only after checkout)
      const bookCheck = await pool.query(
        `SELECT booking_status FROM bookings WHERE id = $1`,
        [bookingId]
      );
      check(bookCheck.rows[0].booking_status === 'ACTIVE', 'T15.4: booking stays ACTIVE while all checked in');
    }
  } catch (err) {
    check(false, `T15: ${err.code || err.message}`);
    console.log('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test16_sibling_isolation_after_checkin() {
  console.log('\n--- T16: Sibling isolation — untouched sibling unchanged after first check-in ---');
  let bookingId = null;
  let childResIds = [];
  try {
    const bookingPayload = buildBookingPayload(1000000, { bukti_bayar_path: '/test/evidence/t16.jpg' });
    bookingPayload.reservations = [
      buildRealChildPayload(roomIds[0], 0),
      buildRealChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T16.1: 2-room booking created');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      const resIds = await pool.query(
        `SELECT id, room_id, guest_name, status FROM reservations WHERE booking_id = $1 ORDER BY stay_sequence ASC`,
        [bookingId]
      );
      childResIds = resIds.rows.map(r => ({ id: Number(r.id), roomId: Number(r.room_id), name: r.guest_name }));

      // Snapshot before check-in
      const beforeB = await pool.query(
        `SELECT id, room_id, status, checked_in_at FROM reservations WHERE id = $1`,
        [childResIds[1].id]
      );
      const bRoomBefore = beforeB.rows[0].room_id;
      const bStatusBefore = beforeB.rows[0].status;
      const bCiAtBefore = beforeB.rows[0].checked_in_at;

      // Check in child A
      await apiRequest('POST', `/api/reservations/${childResIds[0].id}/checkin`, {
        property_id: propertyId,
        force: true,
        override_guest_identity: true,
        override_housekeeping: true
      });

      // Sibling B must be unchanged
      const afterB = await pool.query(
        `SELECT id, room_id, status, checked_in_at FROM reservations WHERE id = $1`,
        [childResIds[1].id]
      );
      check(Number(afterB.rows[0].room_id) === bRoomBefore, 'T16.2: sibling room_id unchanged');
      check(afterB.rows[0].status === bStatusBefore, 'T16.3: sibling status unchanged (still BOOKED)');
      check(afterB.rows[0].checked_in_at === bCiAtBefore, 'T16.4: sibling checked_in_at unchanged (null)');
    }
  } catch (err) {
    check(false, `T16: ${err.code || err.message}`);
    console.log('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test17_group_payment_gate_both_children() {
  console.log('\n--- T17: GROUP payment gate — both allocated children pass independently ---');
  let bookingId = null;
  let childResIds = [];
  try {
    const bookingPayload = buildBookingPayload(1000000, { bukti_bayar_path: '/test/evidence/t17.jpg' });
    bookingPayload.reservations = [
      buildRealChildPayload(roomIds[0], 0),
      buildRealChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T17.1: 2-room booking with GROUP payment created');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      const resIds = await pool.query(
        `SELECT id FROM reservations WHERE booking_id = $1 ORDER BY stay_sequence ASC`,
        [bookingId]
      );
      childResIds = resIds.rows.map(r => Number(r.id));

      // Query pre-check-in eligibility for both children
      const { evaluatePreCheckinEligibility } = require('../dist/domains/checkin/checkinGateService');
      for (const resId of childResIds) {
        const elig = await evaluatePreCheckinEligibility(pool, propertyId, resId);
        check(elig.payment_ok === true, `T17.2: child ${resId} payment_ok=true (GROUP allocation)`);
        check(elig.payment_evidence_ok === true, `T17.3: child ${resId} payment_evidence_ok=true (GROUP evidence)`);
        check(!elig.missing.some(m => m.code === 'PAYMENT_MISSING'), `T17.4: child ${resId} no PAYMENT_MISSING`);
        check(!elig.missing.some(m => m.code === 'PAYMENT_EVIDENCE_MISSING'), `T17.5: child ${resId} no PAYMENT_EVIDENCE_MISSING`);
      }
    }
  } catch (err) {
    check(false, `T17: ${err.code || err.message}`);
    console.log('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test18_derived_summary_before_after() {
  console.log('\n--- T18: Derived checkin_progress summary — evolves correctly ---');
  let bookingId = null;
  let childResIds = [];
  try {
    const bookingPayload = buildBookingPayload(1000000, { bukti_bayar_path: '/test/evidence/t18.jpg' });
    bookingPayload.reservations = [
      buildRealChildPayload(roomIds[0], 0),
      buildRealChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T18.1: 2-room booking created');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      const resIds = await pool.query(
        `SELECT id FROM reservations WHERE booking_id = $1 ORDER BY stay_sequence ASC`,
        [bookingId]
      );
      childResIds = resIds.rows.map(r => Number(r.id));

      // Before any check-in: 0/2
      const beforeSummary = await apiRequest('GET', `/api/reservations/${childResIds[0]}?property_id=${propertyId}`);
      check(beforeSummary.status === 200, 'T18.2: GET reservation returns 200');
      const progBefore = beforeSummary.body?.data?.checkin_progress;
      check(progBefore !== null, 'T18.3: checkin_progress is present for multi-room booking');
      check(progBefore.totalChildren === 2, 'T18.4: totalChildren = 2');
      check(progBefore.checkedInCount === 0, 'T18.5: checkedInCount = 0 before any check-in');
      check(progBefore.bookedCount === 2, 'T18.6: bookedCount = 2 before any check-in');
      check(progBefore.pendingCount === 2, 'T18.7: pendingCount = 2 before any check-in');

      // After first check-in: 1/2
      await apiRequest('POST', `/api/reservations/${childResIds[0]}/checkin`, {
        property_id: propertyId,
        force: true,
        override_guest_identity: true,
        override_housekeeping: true
      });
      const afterFirstSummary = await apiRequest('GET', `/api/reservations/${childResIds[0]}?property_id=${propertyId}`);
      const progAfterFirst = afterFirstSummary.body?.data?.checkin_progress;
      check(progAfterFirst.checkedInCount === 1, 'T18.8: checkedInCount = 1 after first check-in');
      check(progAfterFirst.pendingCount === 1, 'T18.9: pendingCount = 1 after first check-in');

      // After second check-in: 2/2
      await apiRequest('POST', `/api/reservations/${childResIds[1]}/checkin`, {
        property_id: propertyId,
        force: true,
        override_guest_identity: true,
        override_housekeeping: true
      });
      const afterAllSummary = await apiRequest('GET', `/api/reservations/${childResIds[0]}?property_id=${propertyId}`);
      const progAfterAll = afterAllSummary.body?.data?.checkin_progress;
      check(progAfterAll.checkedInCount === 2, 'T18.10: checkedInCount = 2 after all checked in');
      check(progAfterAll.pendingCount === 0, 'T18.11: pendingCount = 0 after all checked in');
      check(progAfterAll.bookedCount === 0, 'T18.12: bookedCount = 0 after all checked in');
    }
  } catch (err) {
    check(false, `T18: ${err.code || err.message}`);
    console.log('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test19_single_room_regression() {
  console.log('\n--- T19: Single-room check-in regression (no summary, unchanged behavior) ---');
  let bookingId = null;
  let childResId = null;
  try {
    const bookingPayload = buildBookingPayload(500000);
    bookingPayload.reservations = [buildChildPayload(roomIds[0], 0)];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T19.1: single-room booking created');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      const resIds = await pool.query(
        `SELECT id FROM reservations WHERE booking_id = $1`,
        [bookingId]
      );
      childResId = Number(resIds.rows[0]?.id);

      // Single-room: checkin_progress should be null (no multi-room context)
      const beforeSummary = await apiRequest('GET', `/api/reservations/${childResId}?property_id=${propertyId}`);
      check(beforeSummary.body?.data?.checkin_progress === null, 'T19.2: single-room checkin_progress is null');

      // Check in
      const ciRes = await apiRequest('POST', `/api/reservations/${childResId}/checkin`, {
        property_id: propertyId,
        force: true,
        override_guest_identity: true,
        override_housekeeping: true
      });
      check(ciRes.status === 200, 'T19.3: single-room check-in succeeds');
      check(ciRes.body?.data?.status === 'CHECKED_IN', 'T19.4: single-room status CHECKED_IN');
    }
  } catch (err) {
    check(false, `T19: ${err.code || err.message}`);
    console.log('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

async function test20_group_evidence_visibility_after_checkin() {
  console.log('\n--- T20: Group evidence still visible after child check-in ---');
  let bookingId = null;
  let childResIds = [];
  try {
    const bookingPayload = buildBookingPayload(1000000, { bukti_bayar_path: '/test/evidence/t20.jpg' });
    bookingPayload.reservations = [
      buildRealChildPayload(roomIds[0], 0),
      buildRealChildPayload(roomIds[1], 1)
    ];

    const result = await createBooking(bookingPayload);
    check(result.ok, 'T20.1: 2-room booking with GROUP evidence created');
    bookingId = result.result?.booking?.id;

    if (bookingId) {
      const resIds = await pool.query(
        `SELECT id FROM reservations WHERE booking_id = $1 ORDER BY stay_sequence ASC`,
        [bookingId]
      );
      childResIds = resIds.rows.map(r => Number(r.id));

      // Check in child A
      await apiRequest('POST', `/api/reservations/${childResIds[0]}/checkin`, {
        property_id: propertyId,
        force: true,
        override_guest_identity: true,
        override_housekeeping: true
      });

      // Child B should still see evidence via folio endpoint
      const folioB = await apiRequest('GET', `/api/reservations/${childResIds[1]}/folio?property_id=${propertyId}`);
      check(folioB.status === 200, 'T20.2: folio for child B returns 200 after sibling check-in');
      const evids = folioB.body?.data?.evidences || [];
      check(evids.length >= 1, 'T20.3: child B still sees shared evidence after sibling check-in');
      check(evids[0].is_active === true, 'T20.4: evidence row is_active');
    }
  } catch (err) {
    check(false, `T20: ${err.code || err.message}`);
    console.log('  Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    if (bookingId) await cleanupBooking(bookingId);
  }
}

// ─── Run tests ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== RUNNING MULTI-BOOKING-SCOPE-1B3C TESTS [runId=${runId}] ===\n`);

  // Generate auth token for HTTP API tests (T14–T20)
  await setupAuthToken(pool);

  // Start HTTP server for check-in endpoint tests (T14–T20)
  await startTestServer();

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
    await runWithFixtures(test11_nonAnchorSharedEvidenceRead);
    await runWithFixtures(test12_anchorRegression);
    await runWithFixtures(test13_legacy_null_property_id);
    await runWithFixtures(test14_multi_room_checkin_isolation);
    await runWithFixtures(test15_sequential_checkin);
    await runWithFixtures(test16_sibling_isolation_after_checkin);
    await runWithFixtures(test17_group_payment_gate_both_children);
    await runWithFixtures(test18_derived_summary_before_after);
    await runWithFixtures(test19_single_room_regression);
    await runWithFixtures(test20_group_evidence_visibility_after_checkin);
  } finally {
    await stopTestServer();
    await pool.end();
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
