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
    if ((path.match(/\/api\/reservations\/\d+\/payments$/) || path.includes('/correct')) && method === 'POST') {
      const fd = new FormData();
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined && v !== null) fd.append(k, String(v));
      }
      fd.append('file', new Blob([Buffer.from('TEST_PAYMENT_PROOF_JPEG_DATA')], { type: 'image/jpeg' }), 'proof.jpg');
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
let catIdA;
let catIdB;
let roomTypeIdA;
let roomTypeIdB;
let roomIdA;
let roomIdB;
let bookingIdA;
let bookingIdB;
let resIdA;
let resIdB;

async function setupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const randA = Math.floor(1000 + Math.random() * 9000);
    const randB = Math.floor(1000 + Math.random() * 9000);
    // Two test properties
    const propA = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('Correction Prop A', 'CA${randA}', 'Asia/Jakarta', 'IDR', 'Address A', TRUE) RETURNING id`
    );
    const propB = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('Correction Prop B', 'CB${randB}', 'Asia/Jakarta', 'IDR', 'Address B', TRUE) RETURNING id`
    );

    propIdA = propA.rows[0].id;
    propIdB = propB.rows[0].id;

    // Room categories
    const catA = await client.query(
      "INSERT INTO room_categories (property_id, code, name, is_active) VALUES ($1, 'CAT-CPA', 'Category CP A', TRUE) RETURNING id",
      [propIdA]
    );
    const catB = await client.query(
      "INSERT INTO room_categories (property_id, code, name, is_active) VALUES ($1, 'CAT-CPB', 'Category CP B', TRUE) RETURNING id",
      [propIdB]
    );
    catIdA = catA.rows[0].id;
    catIdB = catB.rows[0].id;

    // Room types
    const rtA = await client.query(
      "INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity) VALUES ($1, $2, 'RTCPA', 'Deluxe King', 1000000, 2) RETURNING id",
      [propIdA, catIdA]
    );
    const rtB = await client.query(
      "INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity) VALUES ($1, $2, 'RTCPB', 'Standard Queen', 800000, 2) RETURNING id",
      [propIdB, catIdB]
    );

    roomTypeIdA = rtA.rows[0].id;
    roomTypeIdB = rtB.rows[0].id;

    // Physical rooms
    const rA = await client.query(
      "INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, 'CORR-101', 'Room CORR 101', 'Ready', TRUE) RETURNING id",
      [propIdA, roomTypeIdA]
    );
    const rB = await client.query(
      "INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, 'CORR-201', 'Room CORR 201', 'Ready', TRUE) RETURNING id",
      [propIdB, roomTypeIdB]
    );

    roomIdA = rA.rows[0].id;
    roomIdB = rB.rows[0].id;

    // Booking & Reservation A (Total: 1.000.000, 1 night)
    const bA = await client.query(
      "INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status) VALUES ($1, $2, 'Guest Alpha', 'ACTIVE') RETURNING id",
      [propIdA, 'BID-CPA-' + Date.now()]
    );
    bookingIdA = bA.rows[0].id;

    const resA = await client.query(
      `INSERT INTO reservations (
        booking_id, room_id, guest_name, check_in, check_out,
        total_price, amount_paid, remaining_balance, status,
        payment_status, stay_sequence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        bookingIdA, roomIdA, 'Guest Alpha', '2026-09-01', '2026-09-02',
        1000000, 0, 1000000, 'BOOKED', 'UNPAID', 1
      ]
    );
    resIdA = resA.rows[0].id;

    // Booking & Reservation B (Total: 800.000, 1 night)
    const bB = await client.query(
      "INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status) VALUES ($1, $2, 'Guest Beta', 'ACTIVE') RETURNING id",
      [propIdB, 'BID-CPB-' + Date.now()]
    );
    bookingIdB = bB.rows[0].id;

    const resB = await client.query(
      `INSERT INTO reservations (
        booking_id, room_id, guest_name, check_in, check_out,
        total_price, amount_paid, remaining_balance, status,
        payment_status, stay_sequence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        bookingIdB, roomIdB, 'Guest Beta', '2026-09-01', '2026-09-02',
        800000, 0, 800000, 'BOOKED', 'UNPAID', 1
      ]
    );
    resIdB = resB.rows[0].id;

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
        'DELETE FROM payment_evidences WHERE property_id IN ($1, $2) OR reservation_id IN ($3, $4)',
        [propIdA || 0, propIdB || 0, resIdA || 0, resIdB || 0]
      );
      await client.query(
        'DELETE FROM audit_logs WHERE property_id IN ($1, $2) OR record_id IN ($3, $4)',
        [propIdA || 0, propIdB || 0, String(resIdA || 0), String(resIdB || 0)]
      );
    }

    // 2. Folio & Payment
    if (resIdA || resIdB) {
      await client.query('DELETE FROM payment_transactions WHERE reservation_id IN ($1, $2)', [resIdA || 0, resIdB || 0]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id IN ($1, $2)', [resIdA || 0, resIdB || 0]);
      await client.query('DELETE FROM reservations WHERE id IN ($1, $2)', [resIdA || 0, resIdB || 0]);
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

async function runTests() {
  console.log('=== Starting Payment Correction, Void & Reversal Integration Tests ===\n');

  try {
    await initializeDatabase(pool);
    await setupFixtures();

    server = http.createServer(app);
    server.listen(0);
    await once(server, 'listening');
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // ────────────────────────────────────────────────────────────────────────
    // TEST 1: Initial Payment Record Creation & Audit Logging
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 1: Initial Payment Creation ---');
    const initialPayRes = await api('POST', `/api/reservations/${resIdA}/payments`, {
      property_id: propIdA,
      amount: 500000,
      payment_method: 'CASH',
      reference_code: 'INIT-PAY-001'
    });

    expect(initialPayRes.status === 200, '1.1 Payment creation returns 200');
    expect(initialPayRes.json.status === 'SUCCESS', '1.2 JSON response status is SUCCESS');
    expect(Number(initialPayRes.json.data.reservation.amount_paid) === 500000, '1.3 Reservation amount_paid updated to 500.000');
    expect(Number(initialPayRes.json.data.reservation.remaining_balance) === 500000, '1.4 Reservation remaining_balance updated to 500.000');
    expect(initialPayRes.json.data.reservation.payment_status === 'PARTIAL', '1.5 Reservation payment_status is PARTIAL');

    const payment1 = initialPayRes.json.data.payment;
    const payment1Id = payment1.id;
    expect(payment1Id > 0, '1.6 Payment transaction ID returned');

    // Verify Audit log
    const auditRes1 = await api('GET', `/api/reservations/${resIdA}/audit?property_id=${propIdA}`);
    expect(auditRes1.status === 200, '1.7 Audit fetch returns 200');
    const createdAudit = (auditRes1.json.data || []).find(a => a.action === 'PAYMENT_CREATED');
    expect(createdAudit !== undefined, '1.8 PAYMENT_CREATED audit event found');

    // ────────────────────────────────────────────────────────────────────────
    // TEST 2: Payment Correction to Lower Amount (500k -> 100k)
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 2: Payment Correction (500k -> 100k) ---');
    const correctRes1 = await api('POST', `/api/reservations/${resIdA}/payments/${payment1Id}/correct`, {
      property_id: propIdA,
      amount: 100000,
      payment_method: 'CASH',
      reason_code: 'WRONG_AMOUNT',
      reason_text: 'Tamu sebenarnya hanya bayar 100k',
      actor_name: 'Receptionist Budi',
      actor_role: 'Front Office'
    });

    expect(correctRes1.status === 200, '2.1 Correction returns 200');
    expect(correctRes1.json.status === 'SUCCESS', '2.2 Correction JSON status is SUCCESS');
    expect(Number(correctRes1.json.data.reservation.amount_paid) === 100000, '2.3 Reservation amount_paid reduced to 100.000');
    expect(Number(correctRes1.json.data.reservation.remaining_balance) === 900000, '2.4 Reservation remaining_balance increased to 900.000');
    expect(correctRes1.json.data.reservation.payment_status === 'PARTIAL', '2.5 Reservation payment_status remains PARTIAL');

    // Check transactions ledger
    const pmtDbRows = await pool.query(
      'SELECT id, transaction_type, amount, status, reference_payment_id, correction_group_id, reason_code FROM payment_transactions WHERE reservation_id = $1 ORDER BY id ASC',
      [resIdA]
    );

    expect(pmtDbRows.rows.length === 3, '2.6 Exactly 3 payment transaction rows exist (Original, Reversal, Replacement)');

    const [rowOriginal, rowReversal, rowReplacement] = pmtDbRows.rows;
    expect(rowOriginal.status === 'CORRECTED', '2.7 Original payment status is CORRECTED');
    expect(Number(rowOriginal.amount) === 500000, '2.8 Original payment amount preserved as 500.000 (Immutable)');

    expect(rowReversal.transaction_type === 'REVERSAL', '2.9 Second row is REVERSAL');
    expect(Number(rowReversal.amount) === 500000, '2.10 Reversal amount is 500.000');
    expect(rowReversal.reference_payment_id === rowOriginal.id, '2.11 Reversal points to original payment ID');
    expect(rowReversal.reason_code === 'WRONG_AMOUNT', '2.12 Reversal captures reason code');

    expect(rowReplacement.transaction_type === 'CORRECTION_REPLACEMENT', '2.13 Third row is CORRECTION_REPLACEMENT');
    expect(Number(rowReplacement.amount) === 100000, '2.14 Replacement amount is 100.000');
    expect(rowReplacement.reference_payment_id === rowOriginal.id, '2.15 Replacement points to original payment ID');
    expect(rowReplacement.correction_group_id === rowReversal.correction_group_id, '2.16 Shared correction_group_id links Reversal and Replacement');

    // Check Folio entries
    const folioRes1 = await api('GET', `/api/reservations/${resIdA}/folio?property_id=${propIdA}`);
    expect(folioRes1.status === 200, '2.17 Folio fetch returns 200');
    const folioEntries = folioRes1.json.data.folio || [];
    const reversalFolio = folioEntries.find(e => e.entry_type === 'PAYMENT_REVERSAL');
    const replacementFolio = folioEntries.find(e => e.entry_type === 'PAYMENT' && Number(e.amount) === 100000);
    expect(reversalFolio !== undefined, '2.18 PAYMENT_REVERSAL folio entry found');
    expect(replacementFolio !== undefined, '2.19 Replacement PAYMENT folio entry found');

    // Check Audit trail
    const auditRes2 = await api('GET', `/api/reservations/${resIdA}/audit?property_id=${propIdA}`);
    const corrAudit = (auditRes2.json.data || []).find(a => a.action === 'PAYMENT_CORRECTED');
    expect(corrAudit !== undefined, '2.20 PAYMENT_CORRECTED audit log entry found');
    const corrAuditPayload = typeof corrAudit?.new_value === 'string' ? JSON.parse(corrAudit.new_value) : corrAudit?.new_value;
    expect(corrAuditPayload?.actor_name === 'Receptionist Budi', '2.21 Audit actor_name preserved');

    // ────────────────────────────────────────────────────────────────────────
    // TEST 3: Correction to Higher Amount (100k -> 750k) on the Replacement
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 3: Correcting Replacement Payment (100k -> 750k) ---');
    const paymentReplacementId = rowReplacement.id;
    const correctRes2 = await api('POST', `/api/reservations/${resIdA}/payments/${paymentReplacementId}/correct`, {
      property_id: propIdA,
      amount: 750000,
      payment_method: 'TRANSFER',
      reason_code: 'WRONG_AMOUNT',
      reason_text: 'Tambahan transfer masuk',
      actor_name: 'Receptionist Siti'
    });

    expect(correctRes2.status === 200, '3.1 Subsequent correction returns 200');
    expect(Number(correctRes2.json.data.reservation.amount_paid) === 750000, '3.2 Reservation amount_paid updated to 750.000');
    expect(Number(correctRes2.json.data.reservation.remaining_balance) === 250000, '3.3 Reservation remaining_balance updated to 250.000');
    expect(correctRes2.json.data.reservation.payment_status === 'PARTIAL', '3.4 Reservation payment_status remains PARTIAL');

    const updatedReplRow = await pool.query('SELECT status FROM payment_transactions WHERE id = $1', [paymentReplacementId]);
    expect(updatedReplRow.rows[0].status === 'CORRECTED', '3.5 Previous replacement is now CORRECTED');

    // ────────────────────────────────────────────────────────────────────────
    // TEST 4: Anti-Double Correction Protection (409 Conflict)
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 4: Anti-Double Action Protection ---');
    // Attempting to correct rowOriginal again
    const doubleCorrectRes = await api('POST', `/api/reservations/${resIdA}/payments/${payment1Id}/correct`, {
      property_id: propIdA,
      amount: 200000,
      reason_code: 'WRONG_AMOUNT'
    });
    expect(doubleCorrectRes.status === 409, '4.1 Double correction on already CORRECTED payment returns 409');
    expect(doubleCorrectRes.json.code === 'PAYMENT_ALREADY_REVERSED', '4.2 Error code is PAYMENT_ALREADY_REVERSED');

    // Attempting to correct a REVERSAL transaction
    const reverseCorrectRes = await api('POST', `/api/reservations/${resIdA}/payments/${rowReversal.id}/correct`, {
      property_id: propIdA,
      amount: 200000,
      reason_code: 'WRONG_AMOUNT'
    });
    expect(reverseCorrectRes.status === 409, '4.3 Correcting a REVERSAL row returns 409 CANNOT_REVERSE_REVERSAL');

    // ────────────────────────────────────────────────────────────────────────
    // TEST 5: Overpayment Safety on Correction (400 Bad Request)
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 5: Overpayment Safety on Correction ---');
    // Latest active payment is rowReplacement2 with 750.000. Total price is 1.000.000.
    const latestRepl = await pool.query(
      "SELECT id FROM payment_transactions WHERE reservation_id = $1 AND transaction_type = 'CORRECTION_REPLACEMENT' AND status = 'SUCCESS'",
      [resIdA]
    );
    const latestReplId = latestRepl.rows[0].id;

    const overpayCorrectRes = await api('POST', `/api/reservations/${resIdA}/payments/${latestReplId}/correct`, {
      property_id: propIdA,
      amount: 1500000, // exceeds 1.000.000
      reason_code: 'WRONG_AMOUNT'
    });
    expect(overpayCorrectRes.status === 400, '5.1 Overpayment on correction returns 400');
    expect(overpayCorrectRes.json.code === 'OVERPAYMENT_NOT_ALLOWED', '5.2 Error code is OVERPAYMENT_NOT_ALLOWED');

    // ────────────────────────────────────────────────────────────────────────
    // TEST 6: Reason Validation & Mandatory Notes for OTHER
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 6: Reason Validation ---');
    const emptyReasonRes = await api('POST', `/api/reservations/${resIdA}/payments/${latestReplId}/correct`, {
      property_id: propIdA,
      amount: 600000,
      reason_code: ''
    });
    expect(emptyReasonRes.status === 400, '6.1 Empty reason code returns 400 INVALID_REASON_CODE');

    const otherNoTextRes = await api('POST', `/api/reservations/${resIdA}/payments/${latestReplId}/correct`, {
      property_id: propIdA,
      amount: 600000,
      reason_code: 'OTHER',
      reason_text: '   '
    });
    expect(otherNoTextRes.status === 400, '6.2 Reason OTHER with empty notes returns 400 REASON_TEXT_REQUIRED');

    // ────────────────────────────────────────────────────────────────────────
    // TEST 7: Cross-Property Security Guard (403 Forbidden)
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 7: Cross-Property Security Guard ---');
    const crossPropRes = await api('POST', `/api/reservations/${resIdA}/payments/${latestReplId}/correct`, {
      property_id: propIdB, // Belongs to Property A, calling with Property B
      amount: 600000,
      reason_code: 'WRONG_AMOUNT'
    });
    expect(crossPropRes.status === 403, '7.1 Cross-property correction returns 403 CROSS_PROPERTY_RESERVATION');

    // ────────────────────────────────────────────────────────────────────────
    // TEST 8: Void Payment (Batalkan Pembayaran) & Balance Reversion
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 8: Void Payment ---');
    const voidRes = await api('POST', `/api/reservations/${resIdA}/payments/${latestReplId}/void`, {
      property_id: propIdA,
      reason_code: 'PAYMENT_CANCELLED',
      reason_text: 'Tamu membatalkan seluruh transaksi pembayaran',
      actor_name: 'Receptionist Budi'
    });

    expect(voidRes.status === 200, '8.1 Void returns 200');
    expect(voidRes.json.status === 'SUCCESS', '8.2 Void JSON status is SUCCESS');
    expect(Number(voidRes.json.data.reservation.amount_paid) === 0, '8.3 Reservation amount_paid reset to 0');
    expect(Number(voidRes.json.data.reservation.remaining_balance) === 1000000, '8.4 Reservation remaining_balance restored to 1.000.000');
    expect(voidRes.json.data.reservation.payment_status === 'UNPAID', '8.5 Reservation payment_status returned to UNPAID');

    const voidedRow = await pool.query('SELECT status FROM payment_transactions WHERE id = $1', [latestReplId]);
    expect(voidedRow.rows[0].status === 'VOIDED', '8.6 Payment row status is VOIDED');

    const voidReversal = await pool.query(
      "SELECT transaction_type, amount, reference_payment_id FROM payment_transactions WHERE reference_payment_id = $1 AND transaction_type = 'REVERSAL'",
      [latestReplId]
    );
    expect(voidReversal.rows.length === 1, '8.7 Void created exactly 1 REVERSAL row');
    expect(Number(voidReversal.rows[0].amount) === 750000, '8.8 Void reversal amount matches original 750.000');

    // Verify Void Audit trail
    const auditRes3 = await api('GET', `/api/reservations/${resIdA}/audit?property_id=${propIdA}`);
    const voidAudit = (auditRes3.json.data || []).find(a => a.action === 'PAYMENT_VOIDED');
    expect(voidAudit !== undefined, '8.9 PAYMENT_VOIDED audit log found');

    // Attempting to void again -> 409
    const doubleVoidRes = await api('POST', `/api/reservations/${resIdA}/payments/${latestReplId}/void`, {
      property_id: propIdA,
      reason_code: 'PAYMENT_CANCELLED'
    });
    expect(doubleVoidRes.status === 409, '8.10 Voiding already VOIDED payment returns 409 PAYMENT_ALREADY_REVERSED');

    // ────────────────────────────────────────────────────────────────────────
    // TEST 9: Exact Payment Corrected to Lower (PAID -> PARTIAL)
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 9: Exact Payment Corrected Lower on Reservation B ---');
    // Pay in full: 800.000
    const payBRes = await api('POST', `/api/reservations/${resIdB}/payments`, {
      property_id: propIdB,
      amount: 800000,
      payment_method: 'CASH',
      reference_code: 'FULL-001'
    });
    expect(payBRes.json.data.reservation.payment_status === 'PAID', '9.1 Initial payment sets status to PAID');
    expect(Number(payBRes.json.data.reservation.remaining_balance) === 0, '9.2 Remaining balance is 0');

    const payBId = payBRes.json.data.payment.id;
    // Correct to 500.000
    const correctBRes = await api('POST', `/api/reservations/${resIdB}/payments/${payBId}/correct`, {
      property_id: propIdB,
      amount: 500000,
      payment_method: 'CASH',
      reason_code: 'WRONG_AMOUNT'
    });
    expect(correctBRes.status === 200, '9.3 Correction on PAID reservation returns 200');
    expect(Number(correctBRes.json.data.reservation.amount_paid) === 500000, '9.4 amount_paid reduced to 500.000');
    expect(Number(correctBRes.json.data.reservation.remaining_balance) === 300000, '9.5 remaining_balance restored to 300.000');
    expect(correctBRes.json.data.reservation.payment_status === 'PARTIAL', '9.6 payment_status transitioned from PAID to PARTIAL');

    // ────────────────────────────────────────────────────────────────────────
    // TEST 10: Audit Actor Authenticity & Non-Fabrication Gate
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- Scenario 10: Audit Actor Authenticity & Non-Fabrication ---');

    // 10.1: Explicit actor info provided
    const actorPayRes = await api('POST', `/api/reservations/${resIdB}/payments`, {
      property_id: propIdB,
      amount: 100000,
      payment_method: 'CASH',
      reference_code: 'ACT-001',
      actor_user_id: 'USR-77',
      actor_name_snapshot: 'Sarah Connor',
      actor_role_snapshot: 'Cashier'
    });
    expect(actorPayRes.status === 200, '10.1 Payment with explicit actor returns 200');
    const actorPayId = actorPayRes.json.data.payment.id;

    const auditResB = await api('GET', `/api/reservations/${resIdB}/audit?property_id=${propIdB}`);
    const auditListB = auditResB.json.data || [];
    const actorAuditItem = auditListB.find(a => {
      const v = typeof a.new_value === 'string' ? JSON.parse(a.new_value) : a.new_value;
      return v?.payment_id === actorPayId && a.action === 'PAYMENT_CREATED';
    });
    const actorPayload = typeof actorAuditItem?.new_value === 'string' ? JSON.parse(actorAuditItem.new_value) : actorAuditItem?.new_value;
    expect(actorPayload?.actor_name_snapshot === 'Sarah Connor', '10.2 Provided actor name persists exactly');
    expect(actorPayload?.actor_role_snapshot === 'Cashier', '10.3 Provided actor role persists exactly');
    expect(actorPayload?.actor_user_id === 'USR-77', '10.4 Provided actor user ID persists exactly');

    // 10.5: Legacy created_by provided -> actor_name persists, actor_user_id is NULL
    const legacyPayRes = await api('POST', `/api/reservations/${resIdB}/payments`, {
      property_id: propIdB,
      amount: 50000,
      payment_method: 'CASH',
      reference_code: 'LEG-001',
      created_by: 'Legacy Operator John'
    });
    expect(legacyPayRes.status === 200, '10.5 Legacy created_by payment returns 200');
    const legacyPayId = legacyPayRes.json.data.payment.id;
    const legacyDbRow = await pool.query('SELECT created_by FROM payment_transactions WHERE id = $1', [legacyPayId]);
    expect(legacyDbRow.rows[0].created_by === 'Legacy Operator John', '10.6 created_by preserved in payment row');

    const auditResB2 = await api('GET', `/api/reservations/${resIdB}/audit?property_id=${propIdB}`);
    const legacyAuditItem = (auditResB2.json.data || []).find(a => {
      const v = typeof a.new_value === 'string' ? JSON.parse(a.new_value) : a.new_value;
      return v?.payment_id === legacyPayId && a.action === 'PAYMENT_CREATED';
    });
    const legacyPayload = typeof legacyAuditItem?.new_value === 'string' ? JSON.parse(legacyAuditItem.new_value) : legacyAuditItem?.new_value;
    expect(legacyPayload?.actor_name_snapshot === 'Legacy Operator John', '10.7 Legacy created_by mapped to actor_name_snapshot');
    expect(legacyPayload?.actor_user_id === null, '10.8 Missing actor user ID persists NULL without fabrication');
    expect(legacyPayload?.actor_role_snapshot === null, '10.9 Missing actor role persists NULL without fabrication');

    // 10.10: Completely omitted actor info -> ALL actor fields persist NULL (NEVER "Front Office" or "Receptionist")
    const anonPayRes = await api('POST', `/api/reservations/${resIdB}/payments`, {
      property_id: propIdB,
      amount: 50000,
      payment_method: 'CASH',
      reference_code: 'ANON-001'
    });
    expect(anonPayRes.status === 200, '10.10 Anonymous payment creation returns 200');
    const anonPayId = anonPayRes.json.data.payment.id;
    const anonDbRow = await pool.query('SELECT created_by FROM payment_transactions WHERE id = $1', [anonPayId]);
    expect(anonDbRow.rows[0].created_by === null, '10.11 Missing created_by persists NULL in payment_transactions');

    const auditResB3 = await api('GET', `/api/reservations/${resIdB}/audit?property_id=${propIdB}`);
    const anonAuditItem = (auditResB3.json.data || []).find(a => {
      const v = typeof a.new_value === 'string' ? JSON.parse(a.new_value) : a.new_value;
      return v?.payment_id === anonPayId && a.action === 'PAYMENT_CREATED';
    });
    const anonPayload = typeof anonAuditItem?.new_value === 'string' ? JSON.parse(anonAuditItem.new_value) : anonAuditItem?.new_value;
    expect(anonPayload?.actor_user_id === null, '10.12 Omitted actor_user_id persists NULL');
    expect(anonPayload?.actor_name_snapshot === null, '10.13 Omitted actor_name does NOT persist "Front Office"');
    expect(anonPayload?.actor_name === null, '10.14 Omitted actor_name is strictly NULL');
    expect(anonPayload?.actor_role_snapshot === null, '10.15 Omitted actor_role does NOT persist "Receptionist"');
    expect(anonPayload?.actor_role === null, '10.16 Omitted actor_role is strictly NULL');
    expect(anonPayload?.property_id === propIdB, '10.17 Authoritative property_id preserved');
    expect(anonPayload?.reservation_id === resIdB, '10.18 Authoritative reservation_id preserved');
    expect(Boolean(anonPayload?.correlation_id), '10.19 Correlation ID generated and preserved');
    expect(Boolean(anonPayload?.created_at), '10.20 Authoritative timestamp preserved');

    console.log(`\n========================================`);
    console.log(`Integration Test Summary: ${passed} PASSED, ${failed} FAILED`);
    console.log(`========================================\n`);

  } finally {
    if (server) {
      server.close();
      await once(server, 'close');
    }
    console.log('\n--- Cleaning up Fixtures ---');
    await cleanupFixtures();
  }

  // 11. Zero-Residue Test Assertions
  const resProp = await pool.query('SELECT COUNT(*)::int AS count FROM properties WHERE id IN ($1, $2)', [propIdA, propIdB]);
  expect(resProp.rows[0].count === 0, '11.1: zero test properties residue');

  const resBook = await pool.query('SELECT COUNT(*)::int AS count FROM bookings WHERE id IN ($1, $2) OR property_id IN ($3, $4)', [bookingIdA, bookingIdB, propIdA, propIdB]);
  expect(resBook.rows[0].count === 0, '11.2: zero test bookings residue');

  const resRes = await pool.query('SELECT COUNT(*)::int AS count FROM reservations WHERE id IN ($1, $2)', [resIdA, resIdB]);
  expect(resRes.rows[0].count === 0, '11.3: zero test reservations residue');

  const resPay = await pool.query('SELECT COUNT(*)::int AS count FROM payment_transactions WHERE reservation_id IN ($1, $2)', [resIdA, resIdB]);
  expect(resPay.rows[0].count === 0, '11.4: zero test payment_transactions residue');

  const resFolio = await pool.query('SELECT COUNT(*)::int AS count FROM folio_entries WHERE reservation_id IN ($1, $2)', [resIdA, resIdB]);
  expect(resFolio.rows[0].count === 0, '11.5: zero test folio_entries residue');

  const resAudit = await pool.query('SELECT COUNT(*)::int AS count FROM audit_logs WHERE property_id IN ($1, $2)', [propIdA, propIdB]);
  expect(resAudit.rows[0].count === 0, '11.6: zero test audit_logs residue');

  console.log(`\nFinal Payment-Correction Test Summary: ${passed} PASSED, ${failed} FAILED`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal error running tests:', err);
  process.exit(1);
});
