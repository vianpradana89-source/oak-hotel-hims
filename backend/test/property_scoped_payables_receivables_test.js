'use strict';

require('dotenv').config({ path: 'E:/oak-hotel-hims/backend/.env' });
const http = require('http');
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

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
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

    // Two test properties
    const propA = await client.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('APAR Prop A', 'APRA', 'Asia/Jakarta', 'IDR', 'Address A', TRUE) RETURNING id"
    );
    const propB = await client.query(
      "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('APAR Prop B', 'APRB', 'Asia/Jakarta', 'IDR', 'Address B', TRUE) RETURNING id"
    );

    propIdA = propA.rows[0].id;
    propIdB = propB.rows[0].id;

    // Room categories
    const catA = await client.query(
      "INSERT INTO room_categories (property_id, code, name, is_active) VALUES ($1, 'CAT-A', 'Category A', TRUE) RETURNING id",
      [propIdA]
    );
    const catB = await client.query(
      "INSERT INTO room_categories (property_id, code, name, is_active) VALUES ($1, 'CAT-B', 'Category B', TRUE) RETURNING id",
      [propIdB]
    );

    // Room types
    const rtA = await client.query(
      "INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity) VALUES ($1, $2, 'RTA', 'Type A', 500000, 2) RETURNING id",
      [propIdA, catA.rows[0].id]
    );
    const rtB = await client.query(
      "INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity) VALUES ($1, $2, 'RTB', 'Type B', 600000, 2) RETURNING id",
      [propIdB, catB.rows[0].id]
    );

    roomTypeIdA = rtA.rows[0].id;
    roomTypeIdB = rtB.rows[0].id;

    // Rooms
    const rA = await client.query(
      "INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, '901', 'Type A', 'Ready', TRUE) RETURNING id",
      [propIdA, roomTypeIdA]
    );
    const rB = await client.query(
      "INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, '902', 'Type B', 'Ready', TRUE) RETURNING id",
      [propIdB, roomTypeIdB]
    );

    roomIdA = rA.rows[0].id;
    roomIdB = rB.rows[0].id;

    // Bookings & Reservations for Property A
    const bA = await client.query(
      "INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status) VALUES ($1, $2, 'Guest A Snapshot', 'ACTIVE') RETURNING id",
      [propIdA, 'BID-TEST-A-' + Date.now()]
    );
    bookingIdA = bA.rows[0].id;

    const resA = await client.query(
      `INSERT INTO reservations (booking_id, room_id, guest_name, check_in, check_out, total_price, status, stay_sequence)
       VALUES ($1, $2, 'Guest A', '2026-11-01', '2026-11-03', 1000000, 'BOOKED', 1) RETURNING id`,
      [bookingIdA, roomIdA]
    );
    resIdA = resA.rows[0].id;

    // Bookings & Reservations for Property B
    const bB = await client.query(
      "INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status) VALUES ($1, $2, 'Guest B Snapshot', 'ACTIVE') RETURNING id",
      [propIdB, 'BID-TEST-B-' + Date.now()]
    );
    bookingIdB = bB.rows[0].id;

    const resB = await client.query(
      `INSERT INTO reservations (booking_id, room_id, guest_name, check_in, check_out, total_price, status, stay_sequence)
       VALUES ($1, $2, 'Guest B', '2026-11-01', '2026-11-03', 1200000, 'BOOKED', 1) RETURNING id`,
      [bookingIdB, roomIdB]
    );
    resIdB = resB.rows[0].id;

    // Cross-room reservation: booking belongs to Property B, but room is roomIdA (in Property A)
    const resCross = await client.query(
      `INSERT INTO reservations (booking_id, room_id, guest_name, check_in, check_out, total_price, status, stay_sequence)
       VALUES ($1, $2, 'Guest B in Room A', '2026-11-05', '2026-11-07', 1500000, 'BOOKED', 2) RETURNING id`,
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

    // Delete payables and receivables
    await client.query('DELETE FROM vendor_payables WHERE property_id IN ($1, $2)', [propIdA, propIdB]);
    await client.query('DELETE FROM guest_receivables WHERE property_id IN ($1, $2)', [propIdA, propIdB]);

    // Delete reservations & bookings
    await client.query('DELETE FROM reservations WHERE id IN ($1, $2, $3)', [resIdA, resIdB, resIdCrossRoom]);
    await client.query('DELETE FROM bookings WHERE id IN ($1, $2)', [bookingIdA, bookingIdB]);

    // Delete rooms & room types & categories
    await client.query('DELETE FROM rooms WHERE property_id IN ($1, $2)', [propIdA, propIdB]);
    await client.query('DELETE FROM room_types WHERE property_id IN ($1, $2)', [propIdA, propIdB]);
    await client.query('DELETE FROM room_categories WHERE property_id IN ($1, $2)', [propIdA, propIdB]);

    // Delete properties
    await client.query('DELETE FROM properties WHERE id IN ($1, $2)', [propIdA, propIdB]);

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
    // A. Missing property on payable POST -> 400
    const payNoProp = await api('POST', '/api/accounting/payables', {
      vendor_name: 'Vendor X',
      amount: 500000,
      invoice_number: 'INV-001'
    });
    expect(payNoProp.status === 400, 'A1: POST /api/accounting/payables without property_id returns 400');
    expect(payNoProp.json?.code === 'VALIDATION_ERROR', 'A2: error code is VALIDATION_ERROR');

    // B. Unknown property on payable POST -> 404
    const payBadProp = await api('POST', '/api/accounting/payables', {
      property_id: 999999,
      vendor_name: 'Vendor X',
      amount: 500000,
      invoice_number: 'INV-001'
    });
    expect(payBadProp.status === 404, 'B1: POST /api/accounting/payables with unknown property returns 404');
    expect(payBadProp.json?.code === 'PROPERTY_NOT_FOUND', 'B2: error code is PROPERTY_NOT_FOUND');

    // C. Valid payable A succeeds
    const payA = await api('POST', '/api/accounting/payables', {
      property_id: propIdA,
      vendor_name: 'Vendor A1',
      invoice_number: 'INV-A1',
      amount: 750000,
      status: 'OPEN'
    });
    expect(payA.status === 201, 'C1: POST payable A returns 201');
    expect(Number(payA.json?.data?.property_id) === propIdA, 'C2: payable A has correct property_id');
    expect(Number(payA.json?.data?.amount) === 750000, 'C3: payable A amount is 750,000');

    // D. Valid payable B succeeds
    const payB = await api('POST', '/api/accounting/payables', {
      property_id: propIdB,
      vendor_name: 'Vendor B1',
      invoice_number: 'INV-B1',
      amount: 1200000,
      status: 'OPEN'
    });
    expect(payB.status === 201, 'D1: POST payable B returns 201');
    expect(Number(payB.json?.data?.property_id) === propIdB, 'D2: payable B has correct property_id');
    expect(Number(payB.json?.data?.amount) === 1200000, 'D3: payable B amount is 1,200,000');

    // E. Accounting summary A sees only A payable total
    const sumA1 = await api('GET', '/api/accounting/summary?property_id=' + propIdA);
    expect(sumA1.status === 200, 'E1: GET summary A returns 200');
    expect(Number(sumA1.json?.data?.total_payable) === 750000, 'E2: Property A total_payable is 750,000 (got ' + sumA1.json?.data?.total_payable + ')');

    // F. Accounting summary B sees only B payable total
    const sumB1 = await api('GET', '/api/accounting/summary?property_id=' + propIdB);
    expect(sumB1.status === 200, 'F1: GET summary B returns 200');
    expect(Number(sumB1.json?.data?.total_payable) === 1200000, 'F2: Property B total_payable is 1,200,000 (got ' + sumB1.json?.data?.total_payable + ')');

    // G. Missing property on receivable POST -> 400
    const recNoProp = await api('POST', '/api/accounting/receivables', {
      guest_name: 'Guest Direct',
      total_amount: 300000,
      paid_amount: 100000
    });
    expect(recNoProp.status === 400, 'G1: POST /api/accounting/receivables without property_id returns 400');
    expect(recNoProp.json?.code === 'VALIDATION_ERROR', 'G2: error code is VALIDATION_ERROR');

    // H. Unknown property on receivable POST -> 404
    const recBadProp = await api('POST', '/api/accounting/receivables', {
      property_id: 999999,
      guest_name: 'Guest Direct',
      total_amount: 300000
    });
    expect(recBadProp.status === 404, 'H1: POST /api/accounting/receivables with unknown property returns 404');
    expect(recBadProp.json?.code === 'PROPERTY_NOT_FOUND', 'H2: error code is PROPERTY_NOT_FOUND');

    // I. Valid non-reservation receivable A succeeds
    const recA_direct = await api('POST', '/api/accounting/receivables', {
      property_id: propIdA,
      guest_name: 'Guest Direct A',
      total_amount: 400000,
      paid_amount: 100000,
      status: 'OPEN'
    });
    expect(recA_direct.status === 201, 'I1: POST direct receivable A returns 201');
    expect(Number(recA_direct.json?.data?.property_id) === propIdA, 'I2: direct receivable A has correct property_id');
    expect(recA_direct.json?.data?.reservation_id === null, 'I3: direct receivable A reservation_id is null');

    // J. Valid non-reservation receivable B succeeds
    const recB_direct = await api('POST', '/api/accounting/receivables', {
      property_id: propIdB,
      guest_name: 'Guest Direct B',
      total_amount: 600000,
      paid_amount: 200000,
      status: 'OPEN'
    });
    expect(recB_direct.status === 201, 'J1: POST direct receivable B returns 201');
    expect(Number(recB_direct.json?.data?.property_id) === propIdB, 'J2: direct receivable B has correct property_id');

    // K. Valid same-property reservation receivable succeeds
    const recA_res = await api('POST', '/api/accounting/receivables', {
      property_id: propIdA,
      reservation_id: resIdA,
      guest_name: 'Guest A',
      total_amount: 1000000,
      paid_amount: 500000,
      status: 'OPEN'
    });
    expect(recA_res.status === 201, 'K1: POST reservation receivable A returns 201');
    expect(Number(recA_res.json?.data?.property_id) === propIdA, 'K2: reservation receivable A has correct property_id');
    expect(Number(recA_res.json?.data?.reservation_id) === resIdA, 'K3: reservation receivable A has correct reservation_id');

    // L. Cross-property reservation receivable rejected 403
    const recCross = await api('POST', '/api/accounting/receivables', {
      property_id: propIdA, // property A
      reservation_id: resIdB, // reservation from property B!
      guest_name: 'Guest B in Prop A',
      total_amount: 500000
    });
    expect(recCross.status === 403, 'L1: POST cross-property reservation receivable rejected with 403');
    expect(recCross.json?.code === 'CROSS_PROPERTY_RESERVATION', 'L2: error code is CROSS_PROPERTY_RESERVATION');

    // L2b: Cross-room reservation (Booking in B, Room in A) requested for Property A MUST be rejected 403 (no room fallback)
    const recCrossRoom = await api('POST', '/api/accounting/receivables', {
      property_id: propIdA, // Property A requested
      reservation_id: resIdCrossRoom, // Booking in B, Room in A!
      guest_name: 'Guest B Room A rejected',
      total_amount: 1500000
    });
    expect(recCrossRoom.status === 403, 'L3: Cross-room reservation (Booking B, Room A) rejected for Property A receivable with 403');
    expect(recCrossRoom.json?.code === 'CROSS_PROPERTY_RESERVATION', 'L4: error code is CROSS_PROPERTY_RESERVATION (proves no room fallback)');

    // M. Nonexistent reservation rejected 404
    const recNonExist = await api('POST', '/api/accounting/receivables', {
      property_id: propIdA,
      reservation_id: 999999,
      guest_name: 'Guest Ghost',
      total_amount: 500000
    });
    expect(recNonExist.status === 404, 'M1: POST nonexistent reservation receivable returns 404');
    expect(recNonExist.json?.code === 'RESERVATION_NOT_FOUND', 'M2: error code is RESERVATION_NOT_FOUND');

    // N. Failed receivable leaves no partial row
    const ghostCheck = await pool.query('SELECT COUNT(*)::int AS count FROM guest_receivables WHERE guest_name IN ($1, $2, $3)', ['Guest B in Prop A', 'Guest B Room A rejected', 'Guest Ghost']);
    expect(ghostCheck.rows[0].count === 0, 'N: rejected receivables leave zero rows in database');

    // O. Summary A sees only A receivable total
    // Prop A: recA_direct remaining = 400k - 100k = 300k; recA_res remaining = 1000k - 500k = 500k. Total = 800k.
    const sumA2 = await api('GET', '/api/accounting/summary?property_id=' + propIdA);
    expect(sumA2.status === 200, 'O1: GET summary A returns 200');
    expect(Number(sumA2.json?.data?.total_receivable) === 800000, 'O2: Property A total_receivable is 800,000 (got ' + sumA2.json?.data?.total_receivable + ')');

    // P. Summary B sees only B receivable total
    // Prop B: recB_direct remaining = 600k - 200k = 400k. Total = 400k.
    const sumB2 = await api('GET', '/api/accounting/summary?property_id=' + propIdB);
    expect(sumB2.status === 200, 'P1: GET summary B returns 200');
    expect(Number(sumB2.json?.data?.total_receivable) === 400000, 'P2: Property B total_receivable is 400,000 (got ' + sumB2.json?.data?.total_receivable + ')');

    // Q. Property switch / read isolation
    expect(Number(sumA2.json?.data?.total_payable) === 750000, 'Q1: Summary A total_payable is strictly 750,000');
    expect(Number(sumB2.json?.data?.total_payable) === 1200000, 'Q2: Summary B total_payable is strictly 1,200,000');
    expect(Number(sumA2.json?.data?.total_receivable) === 800000, 'Q3: Summary A total_receivable is strictly 800,000');
    expect(Number(sumB2.json?.data?.total_receivable) === 400000, 'Q4: Summary B total_receivable is strictly 400,000');

  } finally {
    if (server) {
      server.close();
      await once(server, 'close');
    }
    console.log('\n--- Cleaning up Fixtures ---');
    await cleanupFixtures();
  }

  // R & S: Zero fixture residue verification
  const resProp = await pool.query('SELECT COUNT(*)::int AS count FROM properties WHERE id IN ($1, $2)', [propIdA, propIdB]);
  expect(resProp.rows[0].count === 0, 'R1: zero test properties residue');

  const resPay = await pool.query('SELECT COUNT(*)::int AS count FROM vendor_payables WHERE property_id IN ($1, $2)', [propIdA, propIdB]);
  expect(resPay.rows[0].count === 0, 'R2: zero test vendor_payables residue');

  const resRec = await pool.query('SELECT COUNT(*)::int AS count FROM guest_receivables WHERE property_id IN ($1, $2)', [propIdA, propIdB]);
  expect(resRec.rows[0].count === 0, 'R3: zero test guest_receivables residue');

  const resRes = await pool.query('SELECT COUNT(*)::int AS count FROM reservations WHERE id IN ($1, $2)', [resIdA, resIdB]);
  expect(resRes.rows[0].count === 0, 'R4: zero test reservations residue');

  console.log(`\nProperty-scoped payables & receivables: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
