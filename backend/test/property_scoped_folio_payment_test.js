'use strict';

require('dotenv').config({ path: 'E:/oak-hotel-hims/backend/.env' });
const http = require('http');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');

let server;
let baseUrl;
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

async function api(method, path, body, customHeaders = {}) {
  const opts = {
    method,
    headers: {
      ...customHeaders
    }
  };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body && method !== 'GET') {
    if (path.match(/\/api\/reservations\/\d+\/payments$/) && method === 'POST') {
      const fd = new FormData();
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined && v !== null) fd.append(k, String(v));
      }
      fd.append('file', new Blob([Buffer.from('TEST_PROPERTY_PAYMENT_PROOF_JPEG')], { type: 'image/jpeg' }), 'receipt.jpg');
      opts.body = fd;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(baseUrl + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// ─── FIXTURE STATE ──────────────────────────────────────────────────────────

let propIdA;
let propIdB;
let roomTypeIdA;
let roomTypeIdB;
let roomIdA;
let roomIdB;
let bookingIdA;
let bookingIdB;
let resIdA;
let resIdB;
let resIdCrossRoom;

async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const randA = Math.floor(1000 + Math.random() * 9000);
    const randB = Math.floor(1000 + Math.random() * 9000);
    // Two test properties
    const propA = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('Folio Prop A', 'FA${randA}', 'Asia/Jakarta', 'IDR', 'Address A', TRUE) RETURNING id`
    );
    const propB = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('Folio Prop B', 'FB${randB}', 'Asia/Jakarta', 'IDR', 'Address B', TRUE) RETURNING id`
    );

    propIdA = propA.rows[0].id;
    propIdB = propB.rows[0].id;

    // Room categories
    const catA = await client.query(
      "INSERT INTO room_categories (property_id, code, name, is_active) VALUES ($1, 'CAT-FLA', 'Category FL A', TRUE) RETURNING id",
      [propIdA]
    );
    const catB = await client.query(
      "INSERT INTO room_categories (property_id, code, name, is_active) VALUES ($1, 'CAT-FLB', 'Category FL B', TRUE) RETURNING id",
      [propIdB]
    );

    // Room types
    const rtA = await client.query(
      "INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity) VALUES ($1, $2, 'RTFLA', 'Type FL A', 500000, 2) RETURNING id",
      [propIdA, catA.rows[0].id]
    );
    const rtB = await client.query(
      "INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity) VALUES ($1, $2, 'RTFLB', 'Type FL B', 600000, 2) RETURNING id",
      [propIdB, catB.rows[0].id]
    );

    roomTypeIdA = rtA.rows[0].id;
    roomTypeIdB = rtB.rows[0].id;

    // Rooms
    const rA = await client.query(
      "INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, '911', 'Room 911', 'Ready', TRUE) RETURNING id",
      [propIdA, roomTypeIdA]
    );
    const rB = await client.query(
      "INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, '912', 'Room 912', 'Ready', TRUE) RETURNING id",
      [propIdB, roomTypeIdB]
    );

    roomIdA = rA.rows[0].id;
    roomIdB = rB.rows[0].id;

    // Booking & Reservation for Property A
    const bA = await client.query(
      "INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status) VALUES ($1, $2, 'Guest A Folio', 'ACTIVE') RETURNING id",
      [propIdA, 'BID-FLA-' + Date.now()]
    );
    bookingIdA = bA.rows[0].id;

    const resA = await client.query(
      `INSERT INTO reservations (booking_id, room_id, guest_name, check_in, check_out, total_price, amount_paid, remaining_balance, payment_status, status, stay_sequence)
       VALUES ($1, $2, 'Guest A Folio', '2026-11-01', '2026-11-03', 1000000, 0, 1000000, 'UNPAID', 'BOOKED', 1) RETURNING id`,
      [bookingIdA, roomIdA]
    );
    resIdA = resA.rows[0].id;

    // Initial charge for Reservation A
    await client.query(
      `INSERT INTO folio_entries (reservation_id, entry_type, description, amount, direction)
       VALUES ($1, 'ROOM_CHARGE', 'Room Charge Night 1', 500000, 'DEBIT')`,
      [resIdA]
    );

    // Booking & Reservation for Property B
    const bB = await client.query(
      "INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status) VALUES ($1, $2, 'Guest B Folio', 'ACTIVE') RETURNING id",
      [propIdB, 'BID-FLB-' + Date.now()]
    );
    bookingIdB = bB.rows[0].id;

    const resB = await client.query(
      `INSERT INTO reservations (booking_id, room_id, guest_name, check_in, check_out, total_price, amount_paid, remaining_balance, payment_status, status, stay_sequence)
       VALUES ($1, $2, 'Guest B Folio', '2026-11-01', '2026-11-03', 1200000, 0, 1200000, 'UNPAID', 'BOOKED', 1) RETURNING id`,
      [bookingIdB, roomIdB]
    );
    resIdB = resB.rows[0].id;

    // Initial charge and payment for Reservation B
    await client.query(
      `INSERT INTO folio_entries (reservation_id, entry_type, description, amount, direction)
       VALUES ($1, 'ROOM_CHARGE', 'Room Charge Night 1', 600000, 'DEBIT')`,
      [resIdB]
    );
    await client.query(
      `INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, reference_code, status)
       VALUES ($1, 'PAYMENT', 300000, 'BANK_TRANSFER', 'TXN-INIT-B', 'SUCCESS')`,
      [resIdB]
    );

    // Cross-room reservation: booking belongs to Property B, but room is roomIdA (in Property A)
    const resCross = await client.query(
      `INSERT INTO reservations (booking_id, room_id, guest_name, check_in, check_out, total_price, amount_paid, remaining_balance, payment_status, status, stay_sequence)
       VALUES ($1, $2, 'Guest B CrossRoom', '2026-11-05', '2026-11-07', 1500000, 0, 1500000, 'UNPAID', 'BOOKED', 2) RETURNING id`,
      [bookingIdB, roomIdA]
    );
    resIdCrossRoom = resCross.rows[0].id;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function cleanupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Audit logs & Payment Evidences
    if (propIdA || propIdB) {
      await client.query(
        'DELETE FROM payment_evidences WHERE property_id IN ($1, $2) OR reservation_id IN ($3, $4, $5)',
        [propIdA || 0, propIdB || 0, resIdA || 0, resIdB || 0, resIdCrossRoom || 0]
      );
      await client.query(
        'DELETE FROM audit_logs WHERE property_id IN ($1, $2) OR record_id IN ($3, $4, $5)',
        [propIdA || 0, propIdB || 0, String(resIdA || 0), String(resIdB || 0), String(resIdCrossRoom || 0)]
      );
    }

    // 2. Folio & Payment
    if (resIdA || resIdB || resIdCrossRoom) {
      await client.query('DELETE FROM payment_transactions WHERE reservation_id IN ($1, $2, $3)', [resIdA || 0, resIdB || 0, resIdCrossRoom || 0]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id IN ($1, $2, $3)', [resIdA || 0, resIdB || 0, resIdCrossRoom || 0]);
      await client.query('DELETE FROM reservations WHERE id IN ($1, $2, $3)', [resIdA || 0, resIdB || 0, resIdCrossRoom || 0]);
    }

    // 3. Bookings
    if (bookingIdA || bookingIdB || propIdA || propIdB) {
      await client.query('DELETE FROM bookings WHERE id IN ($1, $2) OR property_id IN ($3, $4)', [bookingIdA || 0, bookingIdB || 0, propIdA || 0, propIdB || 0]);
    }

    // 4. Availability dates
    if (propIdA || propIdB) {
      await client.query('DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id IN ($1, $2))', [propIdA || 0, propIdB || 0]);
    }

    // 5. Rooms, Room Types, Categories
    if (propIdA || propIdB) {
      await client.query('DELETE FROM rooms WHERE property_id IN ($1, $2)', [propIdA || 0, propIdB || 0]);
      await client.query('DELETE FROM room_types WHERE property_id IN ($1, $2)', [propIdA || 0, propIdB || 0]);
      await client.query('DELETE FROM room_categories WHERE property_id IN ($1, $2)', [propIdA || 0, propIdB || 0]);
      await client.query('DELETE FROM properties WHERE id IN ($1, $2)', [propIdA || 0, propIdB || 0]);
    }

    await client.query('COMMIT');

    const storageDir = path.resolve(__dirname, '..', 'storage', 'payment-evidence');
    if (propIdA && fs.existsSync(path.join(storageDir, String(propIdA)))) {
      fs.rmSync(path.join(storageDir, String(propIdA)), { recursive: true, force: true });
    }
    if (propIdB && fs.existsSync(path.join(storageDir, String(propIdB)))) {
      fs.rmSync(path.join(storageDir, String(propIdB)), { recursive: true, force: true });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Cleanup error:', err);
  } finally {
    client.release();
  }
}

// ─── MAIN TEST RUNNER ───────────────────────────────────────────────────────

async function runTests() {
  console.log('\n--- Ensuring Database Schema ---');
  await initializeDatabase(pool);

  console.log('\n--- Setting up Fixtures ---');
  await setupFixtures();

  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  baseUrl = 'http://127.0.0.1:' + port;
  console.log('Test server running at ' + baseUrl);

  try {
    // ==========================================
    // 1. PAYMENT ENDPOINT HARDENING TESTS
    // ==========================================

    // A. Missing property_id on payment POST -> 400
    const payNoProp = await api('POST', `/api/reservations/${resIdA}/payments`, {
      amount: 500000,
      payment_method: 'CASH'
    });
    expect(payNoProp.status === 400, 'A1: POST payment without property_id returns 400');
    expect(payNoProp.json?.code === 'VALIDATION_ERROR', 'A2: error code is VALIDATION_ERROR');

    // B. Unknown property_id on payment POST -> 404
    const payBadProp = await api('POST', `/api/reservations/${resIdA}/payments`, {
      property_id: 999999,
      amount: 500000,
      payment_method: 'CASH'
    });
    expect(payBadProp.status === 404, 'B1: POST payment with unknown property returns 404');
    expect(payBadProp.json?.code === 'PROPERTY_NOT_FOUND', 'B2: error code is PROPERTY_NOT_FOUND');

    // C. Nonexistent reservation on payment POST -> 404
    const payBadRes = await api('POST', '/api/reservations/999999/payments', {
      property_id: propIdA,
      amount: 500000,
      payment_method: 'CASH'
    });
    expect(payBadRes.status === 404, 'C1: POST payment for nonexistent reservation returns 404');
    expect(payBadRes.json?.code === 'RESERVATION_NOT_FOUND', 'C2: error code is RESERVATION_NOT_FOUND');

    // D. Invalid payment amount -> 400
    const payZeroAmt = await api('POST', `/api/reservations/${resIdA}/payments`, {
      property_id: propIdA,
      amount: 0,
      payment_method: 'CASH'
    });
    expect(payZeroAmt.status === 400, 'D1: POST payment with zero amount returns 400');
    expect(payZeroAmt.json?.code === 'VALIDATION_ERROR', 'D2: error code is VALIDATION_ERROR');

    // E. Same-property payment succeeds (Property A, Reservation A)
    const paySuccessA = await api('POST', `/api/reservations/${resIdA}/payments`, {
      property_id: propIdA,
      amount: 400000,
      payment_method: 'CASH',
      reference_code: 'REF-PAY-A-001'
    });
    expect(paySuccessA.status === 200, 'E1: POST same-property payment returns 200');
    expect(paySuccessA.json?.status === 'SUCCESS', 'E2: response status is SUCCESS');
    expect(Number(paySuccessA.json?.data?.payment?.amount) === 400000, 'E3: payment amount matches');
    expect(paySuccessA.json?.data?.payment?.reference_code === 'REF-PAY-A-001', 'E4: reference_code matches');

    // F. DB verification: payment_transactions record exists
    const ptCheck = await pool.query('SELECT * FROM payment_transactions WHERE reservation_id = $1 AND reference_code = $2', [resIdA, 'REF-PAY-A-001']);
    expect(ptCheck.rowCount === 1, 'F1: payment_transactions row inserted in DB');
    expect(Number(ptCheck.rows[0].amount) === 400000, 'F2: DB payment amount is 400,000');
    expect(ptCheck.rows[0].status === 'SUCCESS', 'F3: DB payment status is SUCCESS');

    // G. DB verification: folio_entries credit record exists
    const feCheck = await pool.query('SELECT * FROM folio_entries WHERE reservation_id = $1 AND direction = $2 ORDER BY id DESC LIMIT 1', [resIdA, 'CREDIT']);
    expect(feCheck.rowCount === 1, 'G1: folio_entries CREDIT row inserted in DB');
    expect(Number(feCheck.rows[0].amount) === 400000, 'G2: DB folio credit amount is 400,000');
    expect(feCheck.rows[0].entry_type === 'PAYMENT', 'G3: DB folio entry_type is PAYMENT');

    // H. DB verification: reservation payment fields updated
    const resCheckA = await pool.query('SELECT amount_paid, remaining_balance, payment_status FROM reservations WHERE id = $1', [resIdA]);
    expect(Number(resCheckA.rows[0].amount_paid) === 400000, 'H1: reservation amount_paid updated to 400,000');
    expect(Number(resCheckA.rows[0].remaining_balance) === 600000, 'H2: reservation remaining_balance updated to 600,000');
    expect(resCheckA.rows[0].payment_status === 'PARTIAL', 'H3: reservation payment_status is PARTIAL');

    // H4. Negative payment rejected with 400
    const payNeg = await api('POST', `/api/reservations/${resIdA}/payments`, {
      property_id: propIdA,
      amount: -50000,
      payment_method: 'CASH'
    });
    expect(payNeg.status === 400, 'H4a: POST negative payment rejected with 400');
    expect(payNeg.json?.code === 'VALIDATION_ERROR', 'H4b: negative payment code is VALIDATION_ERROR');

    // H5. Decimal payment rejected with 400
    const payDec = await api('POST', `/api/reservations/${resIdA}/payments`, {
      property_id: propIdA,
      amount: 1000.50,
      payment_method: 'CASH'
    });
    expect(payDec.status === 400, 'H5a: POST non-integer decimal payment rejected with 400');
    expect(payDec.json?.code === 'VALIDATION_ERROR', 'H5b: decimal payment code is VALIDATION_ERROR');

    // H6. Overpayment rejected with 400 OVERPAYMENT_NOT_ALLOWED (attempt 700,000 when remaining is 600,000)
    const payOver = await api('POST', `/api/reservations/${resIdA}/payments`, {
      property_id: propIdA,
      amount: 700000,
      payment_method: 'CASH',
      reference_code: 'REF-OVERPAY-ATTEMPT'
    });
    expect(payOver.status === 400, 'H6a: POST overpayment rejected with 400');
    expect(payOver.json?.code === 'OVERPAYMENT_NOT_ALLOWED', 'H6b: overpayment code is OVERPAYMENT_NOT_ALLOWED');
    expect(payOver.json?.details?.remaining_balance === 600000, 'H6c: details return exact remaining_balance');
    expect(payOver.json?.details?.payment_amount === 700000, 'H6d: details return attempted payment_amount');

    // H7. Atomicity check: overpayment rejection left NO payment row and NO folio row
    const ptOver = await pool.query('SELECT COUNT(*)::int AS count FROM payment_transactions WHERE reference_code = $1', ['REF-OVERPAY-ATTEMPT']);
    expect(ptOver.rows[0].count === 0, 'H7a: rejected overpayment created 0 payment_transactions rows');
    const resCheckA2 = await pool.query('SELECT amount_paid, remaining_balance FROM reservations WHERE id = $1', [resIdA]);
    expect(Number(resCheckA2.rows[0].amount_paid) === 400000, 'H7b: amount_paid unchanged at 400,000 after rejected overpayment');
    expect(Number(resCheckA2.rows[0].remaining_balance) === 600000, 'H7c: remaining_balance unchanged at 600,000 after rejected overpayment');

    // H8. Exact payment succeeds (pay exact remaining 600,000)
    const payExact = await api('POST', `/api/reservations/${resIdA}/payments`, {
      property_id: propIdA,
      amount: 600000,
      payment_method: 'CASH',
      reference_code: 'REF-PAY-A-002-EXACT'
    });
    expect(payExact.status === 200, 'H8a: POST exact payment returns 200');
    expect(payExact.json?.status === 'SUCCESS', 'H8b: response status is SUCCESS');
    const resCheckA3 = await pool.query('SELECT amount_paid, remaining_balance, payment_status FROM reservations WHERE id = $1', [resIdA]);
    expect(Number(resCheckA3.rows[0].amount_paid) === 1000000, 'H8c: reservation amount_paid updated to 1,000,000');
    expect(Number(resCheckA3.rows[0].remaining_balance) === 0, 'H8d: reservation remaining_balance updated to 0');
    expect(resCheckA3.rows[0].payment_status === 'PAID', 'H8e: reservation payment_status is PAID');

    // H9. Overpayment on already paid reservation rejected with 400
    const payAfterPaid = await api('POST', `/api/reservations/${resIdA}/payments`, {
      property_id: propIdA,
      amount: 10000,
      payment_method: 'CASH'
    });
    expect(payAfterPaid.status === 400, 'H9a: payment on fully paid reservation rejected with 400');
    expect(payAfterPaid.json?.code === 'OVERPAYMENT_NOT_ALLOWED', 'H9b: code is OVERPAYMENT_NOT_ALLOWED');

    // I. Cross-property payment: Reservation B with Property A requested -> rejected 403
    const payCross = await api('POST', `/api/reservations/${resIdB}/payments`, {
      property_id: propIdA, // Property A requested for Property B reservation!
      amount: 200000,
      payment_method: 'CASH',
      reference_code: 'REF-CROSS-ATTEMPT'
    });
    expect(payCross.status === 403, 'I1: POST cross-property payment rejected with 403');
    expect(payCross.json?.code === 'CROSS_PROPERTY_RESERVATION', 'I2: error code is CROSS_PROPERTY_RESERVATION');

    // J. Cross-room reservation (Booking in B, Room in A) with Property A requested -> rejected 403 (no room fallback)
    const payCrossRoom = await api('POST', `/api/reservations/${resIdCrossRoom}/payments`, {
      property_id: propIdA, // Property A requested, but booking is in Property B!
      amount: 300000,
      payment_method: 'CASH',
      reference_code: 'REF-CROSS-ROOM-ATTEMPT'
    });
    expect(payCrossRoom.status === 403, 'J1: Cross-room payment rejected with 403');
    expect(payCrossRoom.json?.code === 'CROSS_PROPERTY_RESERVATION', 'J2: error code is CROSS_PROPERTY_RESERVATION (proves no room fallback)');

    // K. Atomicity check: rejected cross-property payment left NO payment row
    const ptGhost = await pool.query('SELECT COUNT(*)::int AS count FROM payment_transactions WHERE reference_code IN ($1, $2)', ['REF-CROSS-ATTEMPT', 'REF-CROSS-ROOM-ATTEMPT']);
    expect(ptGhost.rows[0].count === 0, 'K: rejected payment created 0 payment_transactions rows');

    // L. Atomicity check: rejected cross-property payment left NO folio row
    const feGhost = await pool.query('SELECT COUNT(*)::int AS count FROM folio_entries WHERE reservation_id IN ($1, $2) AND description LIKE $3', [resIdB, resIdCrossRoom, '%Pembayaran tamu%']);
    expect(feGhost.rows[0].count === 0, 'L: rejected payment created 0 folio_entries rows on target reservations');

    // M. Target reservation state remains intact
    const resCheckB = await pool.query('SELECT amount_paid, payment_status FROM reservations WHERE id = $1', [resIdB]);
    expect(Number(resCheckB.rows[0].amount_paid) === 0, 'M: target reservation amount_paid remained 0');

    // ==========================================
    // 2. FOLIO ENDPOINT HARDENING TESTS
    // ==========================================

    // N. Missing property_id on folio GET -> 400
    const folioNoProp = await api('GET', `/api/reservations/${resIdA}/folio`);
    expect(folioNoProp.status === 400, 'N1: GET folio without property_id returns 400');
    expect(folioNoProp.json?.code === 'VALIDATION_ERROR', 'N2: error code is VALIDATION_ERROR');

    // O. Unknown property_id on folio GET -> 404
    const folioBadProp = await api('GET', `/api/reservations/${resIdA}/folio?property_id=999999`);
    expect(folioBadProp.status === 404, 'O1: GET folio with unknown property returns 404');
    expect(folioBadProp.json?.code === 'PROPERTY_NOT_FOUND', 'O2: error code is PROPERTY_NOT_FOUND');

    // P. Nonexistent reservation on folio GET -> 404
    const folioBadRes = await api('GET', `/api/reservations/999999/folio?property_id=${propIdA}`);
    expect(folioBadRes.status === 404, 'P1: GET folio for nonexistent reservation returns 404');
    expect(folioBadRes.json?.code === 'RESERVATION_NOT_FOUND', 'P2: error code is RESERVATION_NOT_FOUND');

    // Q. Same-property GET folio on Reservation A with Property A -> succeeds 200
    const folioA = await api('GET', `/api/reservations/${resIdA}/folio?property_id=${propIdA}`);
    expect(folioA.status === 200, 'Q1: GET same-property folio A returns 200');
    expect(folioA.json?.status === 'OK', 'Q2: response status is OK');
    expect(Array.isArray(folioA.json?.data?.payments), 'Q3: data contains payments array');
    expect(Array.isArray(folioA.json?.data?.folio), 'Q4: data contains folio array');
    expect(folioA.json?.data?.payments?.length === 2, 'Q5: Reservation A has exactly 2 payments (partial + exact)');
    expect(folioA.json?.data?.folio?.length === 3, 'Q6: Reservation A has exactly 3 folio entries (1 debit + 2 credits)');

    // R. Same-property GET folio on Reservation B with Property B -> succeeds 200
    const folioB = await api('GET', `/api/reservations/${resIdB}/folio?property_id=${propIdB}`);
    expect(folioB.status === 200, 'R1: GET same-property folio B returns 200');
    expect(folioB.json?.status === 'OK', 'R2: response status is OK');
    expect(folioB.json?.data?.payments?.length === 1, 'R3: Reservation B has 1 payment');
    expect(folioB.json?.data?.folio?.length === 1, 'R4: Reservation B has 1 folio entry');

    // S. Cross-property GET folio: Reservation B with Property A -> rejected 403
    const folioCrossA = await api('GET', `/api/reservations/${resIdB}/folio?property_id=${propIdA}`);
    expect(folioCrossA.status === 403, 'S1: GET cross-property folio (Res B via Prop A) rejected with 403');
    expect(folioCrossA.json?.code === 'CROSS_PROPERTY_RESERVATION', 'S2: error code is CROSS_PROPERTY_RESERVATION');

    // T. Cross-property GET folio: Reservation A with Property B -> rejected 403
    const folioCrossB = await api('GET', `/api/reservations/${resIdA}/folio?property_id=${propIdB}`);
    expect(folioCrossB.status === 403, 'T1: GET cross-property folio (Res A via Prop B) rejected with 403');
    expect(folioCrossB.json?.code === 'CROSS_PROPERTY_RESERVATION', 'T2: error code is CROSS_PROPERTY_RESERVATION');

    // U. Cross-room reservation (Booking B, Room A) GET folio with Property A -> rejected 403
    const folioCrossRoom = await api('GET', `/api/reservations/${resIdCrossRoom}/folio?property_id=${propIdA}`);
    expect(folioCrossRoom.status === 403, 'U1: GET cross-room folio with Room A property rejected with 403');
    expect(folioCrossRoom.json?.code === 'CROSS_PROPERTY_RESERVATION', 'U2: error code is CROSS_PROPERTY_RESERVATION (proves no room fallback)');

    // V. Property A cannot inspect Property B payments or folio charges
    expect(!folioCrossA.json?.data?.payments, 'V1: Property A cannot inspect Property B payment data');
    expect(!folioCrossA.json?.data?.folio, 'V2: Property A cannot inspect Property B folio data');

    // W. Property B cannot inspect Property A payments or folio charges
    expect(!folioCrossB.json?.data?.payments, 'W1: Property B cannot inspect Property A payment data');
    expect(!folioCrossB.json?.data?.folio, 'W2: Property B cannot inspect Property A folio data');

  } finally {
    if (server) {
      server.close();
      await once(server, 'close');
    }
    console.log('\n--- Cleaning up Fixtures ---');
    await cleanupFixtures();
  }

  // X & Y: Zero fixture residue verification
  const resProp = await pool.query('SELECT COUNT(*)::int AS count FROM properties WHERE id IN ($1, $2)', [propIdA, propIdB]);
  expect(resProp.rows[0].count === 0, 'X1: zero test properties residue');

  const resPay = await pool.query('SELECT COUNT(*)::int AS count FROM payment_transactions WHERE reservation_id IN ($1, $2, $3)', [resIdA, resIdB, resIdCrossRoom]);
  expect(resPay.rows[0].count === 0, 'X2: zero test payment_transactions residue');

  const resFolio = await pool.query('SELECT COUNT(*)::int AS count FROM folio_entries WHERE reservation_id IN ($1, $2, $3)', [resIdA, resIdB, resIdCrossRoom]);
  expect(resFolio.rows[0].count === 0, 'X3: zero test folio_entries residue');

  const resRes = await pool.query('SELECT COUNT(*)::int AS count FROM reservations WHERE id IN ($1, $2, $3)', [resIdA, resIdB, resIdCrossRoom]);
  expect(resRes.rows[0].count === 0, 'X4: zero test reservations residue');

  const resBook = await pool.query('SELECT COUNT(*)::int AS count FROM bookings WHERE id IN ($1, $2) OR property_id IN ($3, $4)', [bookingIdA, bookingIdB, propIdA, propIdB]);
  expect(resBook.rows[0].count === 0, 'X5: zero test bookings residue');

  const resAudit = await pool.query('SELECT COUNT(*)::int AS count FROM audit_logs WHERE property_id IN ($1, $2)', [propIdA, propIdB]);
  expect(resAudit.rows[0].count === 0, 'X6: zero test audit_logs residue');

  console.log(`\nProperty-scoped folio & payment: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
