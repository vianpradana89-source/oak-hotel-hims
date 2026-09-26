'use strict';

/**
 * deposit_payment_history_regression_test.js
 *
 * Regression test for: deposit receipts MUST NOT appear in
 * "Riwayat Pembayaran" (folio API payments array).
 *
 * Tests:
 *  1. DEPOSIT payment_transactions excluded from folio data.payments
 *  2. DEPOSIT_REFUND also excluded
 *  3. Ordinary PAYMENT / CORRECTION_REPLACEMENT INCLUDED
 *  4. authoritative_financials.amount_paid correct (deposit != payment)
 *
 * FIX APPLIED: backend/src/index.ts:7668-7690
 *   Added AND transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
 *   to both the ROOM_RESERVATION and BOOKING_GROUP query branches.
 *
 * SAFETY: Fails closed BEFORE any database code is loaded.
 *          DB_NAME must contain 'test' or we exit immediately.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ─── DB SAFETY GUARD (MUST RUN BEFORE ANY dist/index IMPORT) ────────────────
// Fail-closed: never connect to or import code that may reach staging/prod DB.
const currentDb = process.env.DB_NAME || '';
if (!currentDb || !currentDb.toLowerCase().includes('test')) {
  console.error(
    `SAFETY VIOLATION: DB_NAME="${currentDb || '(unset)'}" does not contain 'test'. ` +
    'Set DB_NAME to a test database before running this regression test.'
  );
  process.exit(1);
}
console.log(`Using disposable test DB: ${currentDb}`);

const runId = 'DHT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

const http = require('http');
const { once } = require('events');
const { Pool } = require('pg');
const { app } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: currentDb
});

let server;
let baseUrl;
let authToken = null;
let passed = 0;
let failed = 0;

function expect(condition, msg) {
  if (condition) {
    passed += 1;
    console.log('PASS | ' + msg);
  } else {
    failed += 1;
    console.error('FAIL | ' + msg);
  }
}

async function api(method, path_, body, headers = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers }
  };
  if (authToken) {
    opts.headers['Authorization'] = `Bearer ${authToken}`;
  }
  if (body && method !== 'GET') {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(baseUrl + path_, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// ─── FIXTURE STATE ──────────────────────────────────────────────────────────

let propId;
let roomTypeId;
let roomId;
let bookingId;
let resId;
const roomPayIds = [];
const corrPayIds = [];
const bgPayIds = [];
const bgAllocIds = [];
const depositTxIds = [];

async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Derive unique fixture identifiers (zero JS concatenation inside SQL)
    // property_code CHECK: ^[A-Z0-9]{2,6}$ — NO hyphens, max 6 alphanumeric chars.
    const shortToken = runId.replace(/[^A-Za-z0-9]/g, '').slice(-3).toUpperCase();
    const propertyCode = 'DHT' + shortToken;                // 6 chars, fits VARCHAR(6) + CHECK
    const categoryCode = 'CAT-' + shortToken;               // 7 chars, fits VARCHAR(20)
    const categoryName = 'Cat DHT ' + shortToken;            // 12 chars, fits VARCHAR(100)
    const roomTypeCode = 'RT-' + shortToken;                 // 6 chars, fits VARCHAR(20)
    const roomTypeName = 'Type DHT ' + shortToken;           // 13 chars, fits VARCHAR(100)
    const roomNumber = '901-' + shortToken;                  // 8 chars, fits VARCHAR(10)
    const roomName = 'Room 901-' + shortToken;               // 14 chars, fits VARCHAR(100)
    const bookingBidSuffix = runId.toUpperCase().slice(-12); // 12 chars
    const bookingBid = 'BID-' + bookingBidSuffix;            // 15 chars, fits VARCHAR(32)

    // Create test property
    const prop = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'Test St', TRUE)
       RETURNING id`,
      ['DepositHistoryTest', propertyCode]
    );
    propId = prop.rows[0].id;

    // Room category + room type
    const cat = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active)
       VALUES ($1, $2, $3, TRUE) RETURNING id`,
      [propId, categoryCode, categoryName]
    );
    const rt = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity)
       VALUES ($1, $2, $3, $4, 500000, 2) RETURNING id`,
      [propId, cat.rows[0].id, roomTypeCode, roomTypeName]
    );
    roomTypeId = rt.rows[0].id;

    // One room
    const r = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, $3, $4, 'Ready', TRUE) RETURNING id`,
      [propId, roomTypeId, roomNumber, roomName]
    );
    roomId = r.rows[0].id;

    // Availability
    await client.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES ($1, $2, '2030-10-01', 1, 0),
              ($1, $2, '2030-10-02', 1, 0)`,
      [roomTypeId, roomTypeCode]
    );

    // Booking & Reservation
    const b = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, 'Guest Deposit Test', 'ACTIVE') RETURNING id`,
      [propId, bookingBid]
    );
    bookingId = b.rows[0].id;

    const res = await client.query(
      `INSERT INTO reservations (booking_id, room_id, guest_name, check_in, check_out,
        total_price, amount_paid, remaining_balance, payment_status, status, stay_sequence)
       VALUES ($1, $2, 'Guest Deposit Test', '2030-10-01', '2030-10-03',
        1000000, 0, 1000000, 'UNPAID', 'BOOKED', 1) RETURNING id`,
      [bookingId, roomId]
    );
    resId = res.rows[0].id;

    // Room charge so total_price > 0
    await client.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction)
       VALUES ($1, $2, 'ROOM_CHARGE', 'Room charge', 1000000, 'DEBIT')`,
      [resId, propId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── AUTH ───────────────────────────────────────────────────────────────────
// Reuse existing Super Admin from disposable test DB (no INSERT).
async function getAuthToken() {
  const saRes = await pool.query(`
    SELECT u.id, u.username, u.full_name, u.email,
           r.id AS role_id, r.name AS role
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'Super Admin' AND r.is_system_role = TRUE
    LIMIT 1
  `);
  if (!saRes.rows[0]) throw new Error('Super Admin not found in disposable test DB');
  const sa = saRes.rows[0];
  return generateToken({
    id: sa.id,
    username: sa.username,
    full_name: sa.full_name,
    email: sa.email || 'sa@test.local',
    role_id: sa.role_id,
    role: sa.role,
    property_id: propId,
    access_type: 'PMS_STAFF',
    scope: 'FULL'
  });
}

async function cleanupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Cleanup payment_allocations (most specific first)
    if (bgAllocIds.length) {
      await client.query('DELETE FROM payment_allocations WHERE id = ANY($1::int[])', [bgAllocIds]);
    }

    // Cleanup payment_transactions — only those created by this test
    if (bgPayIds.length) {
      await client.query(
        'DELETE FROM payment_transactions WHERE id = ANY($1::int[]) AND scope = \'BOOKING_GROUP\'',
        [bgPayIds]
      );
    }
    if (corrPayIds.length) {
      await client.query(
        'DELETE FROM payment_transactions WHERE id = ANY($1::int[]) AND scope = \'ROOM_RESERVATION\' AND transaction_type = \'CORRECTION_REPLACEMENT\'',
        [corrPayIds]
      );
    }
    if (roomPayIds.length) {
      await client.query(
        'DELETE FROM payment_transactions WHERE id = ANY($1::int[]) AND scope = \'ROOM_RESERVATION\' AND transaction_type = \'PAYMENT\'',
        [roomPayIds]
      );
    }

    if (depositTxIds.length) {
      await client.query(
        'DELETE FROM payment_transactions WHERE id = ANY($1::int[]) AND scope = \'ROOM_RESERVATION\' AND transaction_type IN (\'DEPOSIT\', \'DEPOSIT_REFUND\')',
        [depositTxIds]
      );
    }

    if (resId) {
      await client.query('DELETE FROM folio_entries WHERE reservation_id = $1', [resId]);
      await client.query('DELETE FROM reservations WHERE id = $1', [resId]);
    }
    if (bookingId) {
      await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
    }
    if (propId) {
      await client.query('DELETE FROM availability_dates WHERE room_type_id = $1', [roomTypeId]);
      await client.query('DELETE FROM rooms WHERE id = $1', [roomId]);
      await client.query('DELETE FROM room_types WHERE id = $1', [roomTypeId]);
      await client.query('DELETE FROM room_categories WHERE property_id = $1', [propId]);
      await client.query('DELETE FROM properties WHERE id = $1', [propId]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Cleanup error:', err);
  } finally {
    client.release();
  }
}

// ─── MAIN TEST RUNNER ───────────────────────────────────────────────────────

async function runTests() {
  console.log('\n--- Setting up Fixtures ---');
  await setupFixtures();
  authToken = await getAuthToken();

  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  baseUrl = 'http://127.0.0.1:' + port;
  console.log('Test server running at ' + baseUrl);
  console.log('Auth token available:', !!authToken);

  try {
    // =====================================================================
    // SCENARIO 1: DEPOSIT-only → payments must be empty
    // =====================================================================
    console.log('\n=== Scenario 1: Deposit-only reservation ===');

    // Insert two DEPOSIT payment_transactions (simulating receiveDeposit)
    const dep1 = await pool.query(
      `INSERT INTO payment_transactions
       (reservation_id, property_id, transaction_type, amount, payment_method,
        reference_code, status, booking_id, scope)
       VALUES ($1, $2, 'DEPOSIT', 200000, 'CASH', 'DEP-001', 'SUCCESS', $3, 'ROOM_RESERVATION')
       RETURNING id`,
      [resId, propId, bookingId]
    );
    const dep1Id = dep1.rows[0].id;
    depositTxIds.push(Number(dep1Id));

    const dep2 = await pool.query(
      `INSERT INTO payment_transactions
       (reservation_id, property_id, transaction_type, amount, payment_method,
        reference_code, status, booking_id, scope)
       VALUES ($1, $2, 'DEPOSIT', 200000, 'CASH', 'DEP-002', 'SUCCESS', $3, 'ROOM_RESERVATION')
       RETURNING id`,
      [resId, propId, bookingId]
    );
    depositTxIds.push(Number(dep2.rows[0].id));

    // Also insert a DEPOSIT_REFUND
    const depRefund = await pool.query(
      `INSERT INTO payment_transactions
       (reservation_id, property_id, transaction_type, amount, payment_method,
        reference_code, status, booking_id, scope)
       VALUES ($1, $2, 'DEPOSIT_REFUND', 50000, 'CASH', 'DEP-REF-001', 'SUCCESS', $3, 'ROOM_RESERVATION')
       RETURNING id`,
       [resId, propId, bookingId]
     );
     depositTxIds.push(Number(depRefund.rows[0].id));

     // Call GET /folio
    const folioResp = await api('GET', `/api/reservations/${resId}/folio?property_id=${propId}`);
    if (folioResp.status !== 200) {
      console.error('DEBUG: Folio API returned status', folioResp.status, 'body:', JSON.stringify(folioResp.json).slice(0, 500));
    }
    expect(folioResp.status === 200, 'S1-1: GET folio returns 200');
    expect(folioResp.json?.status === 'OK', 'S1-2: response status is OK');
    expect(Array.isArray(folioResp.json?.data?.payments), 'S1-3: data contains payments array');

    const payments = folioResp.json?.data?.payments || [];

    // CRITICAL: no deposit or deposit_refund in payments
    expect(payments.length === 0,
      'S1-4: payments array is EMPTY (0 items) — deposits must NOT appear in payment history');

    const depositTypesInPayments = payments.filter(p =>
      p.transaction_type === 'DEPOSIT' || p.transaction_type === 'DEPOSIT_REFUND'
    );
    expect(depositTypesInPayments.length === 0,
      'S1-5: no DEPOSIT or DEPOSIT_REFUND entries in payments array');

    // Financials: amount_paid must be 0 (deposit ≠ payment)
    const fin = folioResp.json?.data?.authoritative_financials || {};
    expect(Number(fin.amount_paid) === 0,
      'S1-6: authoritative_financials.amount_paid is 0 (deposit does not count as payment)');
    expect(Number(fin.applied_deposit) === 0,
      'S1-7: applied_deposit is 0 (no deposit was applied)');
    expect(fin.payment_status === 'UNPAID',
      'S1-8: payment_status is UNPAID (only deposits, no ordinary payment)');

    // DB sanity: rows actually exist
    const dbCheck = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM payment_transactions
       WHERE reservation_id = $1 AND transaction_type IN ('DEPOSIT','DEPOSIT_REFUND')`,
      [resId]
    );
    expect(dbCheck.rows[0].cnt === 3,
      'S1-9: 3 deposit/refund rows exist in DB (test fixture valid)');

    // =====================================================================
    // SCENARIO 2: Add ordinary PAYMENT → must appear; deposits stay out
    // =====================================================================
    console.log('\n=== Scenario 2: Ordinary PAYMENT added ===');

    const ordinaryPay = await pool.query(
      `INSERT INTO payment_transactions
       (reservation_id, property_id, transaction_type, amount, payment_method,
        reference_code, status, booking_id, scope)
       VALUES ($1, $2, 'PAYMENT', 300000, 'CASH', 'PAY-001', 'SUCCESS', $3, 'ROOM_RESERVATION')
       RETURNING id`,
      [resId, propId, bookingId]
    );
    const payId = ordinaryPay.rows[0].id;
    roomPayIds.push(Number(payId));

    const folioResp2 = await api('GET', `/api/reservations/${resId}/folio?property_id=${propId}`);
    expect(folioResp2.status === 200, 'S2-1: GET folio returns 200 after payment');

    const payments2 = folioResp2.json?.data?.payments || [];

    expect(payments2.length === 1,
      'S2-2: payments array has exactly 1 item (only the ordinary PAYMENT)');
    expect(payments2[0].id === payId,
      'S2-3: the single payment is the ordinary PAYMENT we just inserted');
    expect(payments2[0].transaction_type === 'PAYMENT',
      'S2-4: transaction_type is PAYMENT');
    expect(Number(payments2[0].amount) === 300000,
      'S2-5: amount is 300,000');

    const fin2 = folioResp2.json?.data?.authoritative_financials || {};
    expect(Number(fin2.amount_paid) === 300000,
      'S2-6: amount_paid is 300,000 (ordinary payment counted)');
    expect(Number(fin2.applied_deposit) === 0,
      'S2-7: applied_deposit remains 0');
    expect(fin2.payment_status === 'PARTIAL',
      'S2-8: payment_status is PARTIAL (300k paid of 1M due)');

    const depositStillAbsent = payments2.every(p =>
      p.transaction_type !== 'DEPOSIT' && p.transaction_type !== 'DEPOSIT_REFUND'
    );
    expect(depositStillAbsent,
      'S2-9: deposits and deposit_refund STILL absent from payments after adding ordinary payment');

    // =====================================================================
    // SCENARIO 3: Add CORRECTION_REPLACEMENT → must also appear
    // =====================================================================
    console.log('\n=== Scenario 3: CORRECTION_REPLACEMENT added ===');

    const corrPay = await pool.query(
      `INSERT INTO payment_transactions
       (reservation_id, property_id, transaction_type, amount, payment_method,
        reference_code, status, booking_id, scope)
       VALUES ($1, $2, 'CORRECTION_REPLACEMENT', 100000, 'TRANSFER', 'CORR-001', 'SUCCESS', $3, 'ROOM_RESERVATION')
       RETURNING id`,
      [resId, propId, bookingId]
    );
    const corrId = corrPay.rows[0].id;
    corrPayIds.push(Number(corrId));

    const folioResp3 = await api('GET', `/api/reservations/${resId}/folio?property_id=${propId}`);
    const payments3 = folioResp3.json?.data?.payments || [];

    expect(payments3.length === 2,
      'S3-1: payments array has exactly 2 items (PAYMENT + CORRECTION_REPLACEMENT)');

    const types3 = payments3.map(p => p.transaction_type).sort();
    expect(types3[0] === 'CORRECTION_REPLACEMENT' && types3[1] === 'PAYMENT',
      'S3-2: both PAYMENT and CORRECTION_REPLACEMENT present');

    const fin3 = folioResp3.json?.data?.authoritative_financials || {};
    expect(Number(fin3.amount_paid) === 400000,
      'S3-3: amount_paid is 400,000 (300k payment + 100k correction)');

    const depositStillAbsent3 = payments3.every(p =>
      p.transaction_type !== 'DEPOSIT' && p.transaction_type !== 'DEPOSIT_REFUND'
    );
    expect(depositStillAbsent3,
      'S3-4: deposits and deposit_refund STILL excluded after adding CORRECTION_REPLACEMENT');

    // =====================================================================
    // SCENARIO 4: BOOKING_GROUP branch — ordinary PAYMENT via allocation
    // =====================================================================
    console.log('\n=== Scenario 4: BOOKING_GROUP PAYMENT via payment_allocations ===');

    // A. Insert a BOOKING_GROUP PAYMENT transaction
    const bgPay = await pool.query(
      `INSERT INTO payment_transactions
       (reservation_id, property_id, booking_id, scope, transaction_type,
        amount, payment_method, reference_code, status)
       VALUES ($1, $2, $3, 'BOOKING_GROUP', 'PAYMENT', 150000, 'CASH', 'BGP-001', 'SUCCESS')
       RETURNING id`,
      [resId, propId, bookingId]
    );
    const bgPayId = Number(bgPay.rows[0].id);
    bgPayIds.push(bgPayId);
    expect(bgPayId > 0, 'S4-0: BOOKING_GROUP PAYMENT transaction created');

    // A. Insert an ACTIVE allocation linking it to the test reservation
    const bgAlloc = await pool.query(
      `INSERT INTO payment_allocations
       (property_id, booking_id, reservation_id, payment_transaction_id,
        allocated_amount, allocation_sequence, status)
       VALUES ($1, $2, $3, $4, 150000, 1, 'ACTIVE')
       RETURNING id`,
      [propId, bookingId, resId, bgPayId]
    );
    const bgAllocId = Number(bgAlloc.rows[0].id);
    bgAllocIds.push(bgAllocId);
    expect(bgAllocId > 0, 'S4-1: payment_allocation created for BOOKING_GROUP PAYMENT');

    // B. GET /folio — the allocated PAYMENT must appear
    const folioResp4 = await api('GET', `/api/reservations/${resId}/folio?property_id=${propId}`);
    expect(folioResp4.status === 200, 'S4-2: GET folio returns 200 after BOOKING_GROUP PAYMENT');
    const payments4 = folioResp4.json?.data?.payments || [];

    // The ordinary PAYMENT (ROOM_RESERVATION 300k + correction 100k + BOOKING_GROUP 150k = 550k total)
    expect(payments4.length === 3,
      'S4-3: payments array has 3 items (ROOM_PAY 300k + CORR 100k + BG_PAY 150k)');

    const hasBgPay = payments4.some(p =>
      p.id === bgPayId &&
      p.transaction_type === 'PAYMENT' &&
      Number(p.amount) === 150000
    );
    expect(hasBgPay,
      'S4-4: BOOKING_GROUP PAYMENT with allocated amount 150,000 is present in payments');

    const fin4 = folioResp4.json?.data?.authoritative_financials || {};
    expect(Number(fin4.amount_paid) === 550000,
      'S4-5: amount_paid is 550,000 (300k room + 100k correction + 150k booking group)');

    // C. Insert a BOOKING_GROUP DEPOSIT — should NOT appear even with allocation
    const bgDep = await pool.query(
      `INSERT INTO payment_transactions
       (reservation_id, property_id, booking_id, scope, transaction_type,
        amount, payment_method, reference_code, status)
       VALUES ($1, $2, $3, 'BOOKING_GROUP', 'DEPOSIT', 50000, 'CASH', 'BGP-DEP-001', 'SUCCESS')
       RETURNING id`,
      [resId, propId, bookingId]
    );
    const bgDepId = Number(bgDep.rows[0].id);
    bgPayIds.push(bgDepId);

    // Only allocate if schema permits (uq_payment_alloc_pt_res prevents re-allocation)
    const alreadyAllocated = await pool.query(
      `SELECT 1 FROM payment_allocations WHERE payment_transaction_id = $1 AND reservation_id = $2 LIMIT 1`,
      [bgDepId, resId]
    );
    let bgDepAllocId = null;
    if (alreadyAllocated.rows.length === 0) {
      const depAlloc = await pool.query(
        `INSERT INTO payment_allocations
         (property_id, booking_id, reservation_id, payment_transaction_id,
          allocated_amount, allocation_sequence, status)
         VALUES ($1, $2, $3, $4, 50000, 2, 'ACTIVE')
         RETURNING id`,
        [propId, bookingId, resId, bgDepId]
      );
      bgDepAllocId = Number(depAlloc.rows[0].id);
      bgAllocIds.push(bgDepAllocId);
    }
    // Whether allocated or not, DEPOSIT must never appear in payments

    // D. GET /folio again — DEPOSIT still absent, count unchanged
    const folioResp5 = await api('GET', `/api/reservations/${resId}/folio?property_id=${propId}`);
    const payments5 = folioResp5.json?.data?.payments || [];
    expect(payments5.length === 3,
      'S4-6: payments array still has 3 items — BOOKING_GROUP DEPOSIT excluded');

    const depositStillAbsent4 = payments5.every(p =>
      p.transaction_type !== 'DEPOSIT' && p.transaction_type !== 'DEPOSIT_REFUND'
    );
    expect(depositStillAbsent4,
      'S4-7: no DEPOSIT or DEPOSIT_REFUND from BOOKING_GROUP branch in payments');

    // Financials unchanged by deposit
    const fin5 = folioResp5.json?.data?.authoritative_financials || {};
    expect(Number(fin5.amount_paid) === 550000,
      'S4-8: amount_paid still 550,000 (deposit does not affect authoritative payments)');

  } catch (err) {
    console.error('Test error:', err);
    failed += 1;
  } finally {
    console.log('\n--- Cleaning up fixtures ---');
    await cleanupFixtures();
    server.close();

    console.log(`\nDeposit payment history regression: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
