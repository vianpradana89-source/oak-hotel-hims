'use strict';

require('dotenv').config({ path: 'e:/oak-hotel-hims/backend/.env' });
const http = require('http');
const { once } = require('events');
const { app, pool } = require('../dist/index');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`PASS | ${message}`);
    passed++;
  } else {
    console.error(`FAIL | ${message}`);
    failed++;
  }
}

async function api(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body && method !== 'GET') {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(baseUrl + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function main() {
  console.log('=== Starting Property-Scoped Reservation List Tests ===\n');

  server = http.createServer(app);
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  let propAId = null;
  let propBId = null;
  let roomTypeIdA = null;
  let roomTypeIdB = null;
  let roomIdA = null;
  let roomIdB = null;

  try {
    // 1. Setup Test Fixtures: Property A and Property B
    const propARes = await pool.query("INSERT INTO properties (property_code, name, address, is_active) VALUES ('TLA', 'Test List Prop A', 'Test Address A', TRUE) RETURNING id");
    propAId = propARes.rows[0].id;

    const propBRes = await pool.query("INSERT INTO properties (property_code, name, address, is_active) VALUES ('TLB', 'Test List Prop B', 'Test Address B', TRUE) RETURNING id");
    propBId = propBRes.rows[0].id;

    // Room Types
    const rtARes = await pool.query("INSERT INTO room_types (property_id, code, name, base_rate, capacity) VALUES ($1, 'DXA', 'Deluxe A', 500000, 2) RETURNING id", [propAId]);
    roomTypeIdA = rtARes.rows[0].id;

    const rtBRes = await pool.query("INSERT INTO room_types (property_id, code, name, base_rate, capacity) VALUES ($1, 'DXB', 'Deluxe B', 600000, 2) RETURNING id", [propBId]);
    roomTypeIdB = rtBRes.rows[0].id;

    // Rooms
    const rARes = await pool.query("INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, 'A101', 'Deluxe A', 'VACANT_CLEAN', true) RETURNING id", [propAId, roomTypeIdA]);
    roomIdA = rARes.rows[0].id;

    const rBRes = await pool.query("INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, 'B101', 'Deluxe B', 'VACANT_CLEAN', true) RETURNING id", [propBId, roomTypeIdB]);
    roomIdB = rBRes.rows[0].id;

    // 2. Insert Bookings & Reservations for Property A
    // Booking A1: Historical Stay (30 days ago: 2026-07-20 to 2026-07-23) - CHECKED_OUT
    const bA1 = await pool.query("INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-LIST-A1', $1, 'Alice Historical') RETURNING id", [propAId]);
    await pool.query(`
      INSERT INTO reservations (booking_id, stay_sequence, room_id, guest_name, guest_phone, check_in, check_out, total_price, amount_paid, remaining_balance, status, payment_status, booked_room_type_id_snapshot, booked_room_type_name_snapshot)
      VALUES ($1, 1, $2, 'Alice Historical', '0811111111', '2026-07-20', '2026-07-23', 1500000, 1500000, 0, 'CHECKED_OUT', 'PAID', $3, 'Deluxe A')
    `, [bA1.rows[0].id, roomIdA, roomTypeIdA]);

    // Booking A2: Current Stay (2026-08-26 to 2026-08-29) - CHECKED_IN
    const bA2 = await pool.query("INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-LIST-A2', $1, 'Bob Current') RETURNING id", [propAId]);
    await pool.query(`
      INSERT INTO reservations (booking_id, stay_sequence, room_id, guest_name, guest_phone, check_in, check_out, total_price, amount_paid, remaining_balance, status, payment_status, booked_room_type_id_snapshot, booked_room_type_name_snapshot)
      VALUES ($1, 1, $2, 'Bob Current', '0822222222', '2026-08-26', '2026-08-29', 1500000, 500000, 1000000, 'CHECKED_IN', 'PARTIAL', $3, 'Deluxe A')
    `, [bA2.rows[0].id, roomIdA, roomTypeIdA]);

    // Booking A3: Future Stay (45 days ahead: 2026-10-10 to 2026-10-12) - BOOKED
    const bA3 = await pool.query("INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-LIST-A3', $1, 'Charlie Future') RETURNING id", [propAId]);
    await pool.query(`
      INSERT INTO reservations (booking_id, stay_sequence, room_id, guest_name, guest_phone, check_in, check_out, total_price, amount_paid, remaining_balance, status, payment_status, booked_room_type_id_snapshot, booked_room_type_name_snapshot)
      VALUES ($1, 1, $2, 'Charlie Future', '0833333333', '2026-10-10', '2026-10-12', 1000000, 0, 1000000, 'BOOKED', 'UNPAID', $3, 'Deluxe A')
    `, [bA3.rows[0].id, roomIdA, roomTypeIdA]);

    // Booking A4: Cancelled Stay (2026-08-27 to 2026-08-28) - CANCELLED
    const bA4 = await pool.query("INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-LIST-A4', $1, 'Dave Cancelled') RETURNING id", [propAId]);
    await pool.query(`
      INSERT INTO reservations (booking_id, stay_sequence, room_id, guest_name, guest_phone, check_in, check_out, total_price, amount_paid, remaining_balance, status, payment_status, booked_room_type_id_snapshot, booked_room_type_name_snapshot)
      VALUES ($1, 1, $2, 'Dave Cancelled', '0844444444', '2026-08-27', '2026-08-28', 500000, 0, 500000, 'CANCELLED', 'UNPAID', $3, 'Deluxe A')
    `, [bA4.rows[0].id, roomIdA, roomTypeIdA]);

    // 3. Insert Booking & Reservation for Property B
    const bB1 = await pool.query("INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-LIST-B1', $1, 'Eve Property B') RETURNING id", [propBId]);
    await pool.query(`
      INSERT INTO reservations (booking_id, stay_sequence, room_id, guest_name, guest_phone, check_in, check_out, total_price, amount_paid, remaining_balance, status, payment_status, booked_room_type_id_snapshot, booked_room_type_name_snapshot)
      VALUES ($1, 1, $2, 'Eve Property B', '0855555555', '2026-08-26', '2026-08-29', 1800000, 1800000, 0, 'BOOKED', 'PAID', $3, 'Deluxe B')
    `, [bB1.rows[0].id, roomIdB, roomTypeIdB]);

    // =========================================================================
    // Test 1: Property Validation
    // =========================================================================
    console.log('--- Test 1: Property Validation ---');
    const noProp = await api('GET', '/api/reservations');
    assert(noProp.status === 400, '1A. Missing property_id returns 400');
    assert(noProp.body?.code === 'VALIDATION_ERROR', '1B. Missing property_id code is VALIDATION_ERROR');

    const invalidProp = await api('GET', '/api/reservations?property_id=invalid');
    assert(invalidProp.status === 400, '1C. Invalid property_id returns 400');

    const negativeProp = await api('GET', '/api/reservations?property_id=-5');
    assert(negativeProp.status === 400, '1D. Negative property_id returns 400');

    const unknownProp = await api('GET', '/api/reservations?property_id=999999');
    assert(unknownProp.status === 404, '1E. Unknown property_id returns 404');
    assert(unknownProp.body?.code === 'PROPERTY_NOT_FOUND', '1F. Unknown property code is PROPERTY_NOT_FOUND');

    // =========================================================================
    // Test 2: Property Scoping & Isolation
    // =========================================================================
    console.log('\n--- Test 2: Property Scoping & Isolation ---');
    const listA = await api('GET', `/api/reservations?property_id=${propAId}`);
    assert(listA.status === 200, '2A. GET /api/reservations for Prop A returns 200');
    assert(listA.body?.data?.length === 4, '2B. Prop A returns all 4 Prop A reservations');
    const allPropA = (listA.body?.data || []).every(r => ['Alice Historical', 'Bob Current', 'Charlie Future', 'Dave Cancelled'].includes(r.guest_name));
    assert(allPropA, '2C. Prop A reservations contain only Prop A guest names');

    const listB = await api('GET', `/api/reservations?property_id=${propBId}`);
    assert(listB.status === 200, '2D. GET /api/reservations for Prop B returns 200');
    assert(listB.body?.data?.length === 1, '2E. Prop B returns exactly 1 reservation');
    assert(listB.body?.data?.[0]?.guest_name === 'Eve Property B', '2F. Prop B contains Eve Property B');

    // Cross-check: No Prop B in Prop A, and vice-versa
    const noCrossA = !(listA.body?.data || []).some(r => r.guest_name === 'Eve Property B');
    const noCrossB = !(listB.body?.data || []).some(r => r.guest_name.includes('Alice') || r.guest_name.includes('Bob'));
    assert(noCrossA && noCrossB, '2G. Zero cross-property reservation leakage');

    // =========================================================================
    // Test 3: Beyond Tapechart 7-day Window (Historical & Future)
    // =========================================================================
    console.log('\n--- Test 3: Beyond Tapechart 7-day Window ---');
    const hasHistorical = (listA.body?.data || []).some(r => r.guest_name === 'Alice Historical' && r.check_in === '2026-07-20');
    assert(hasHistorical, '3A. Historical reservation outside 7-day window is returned');

    const hasFuture = (listA.body?.data || []).some(r => r.guest_name === 'Charlie Future' && r.check_in === '2026-10-10');
    assert(hasFuture, '3B. Future reservation beyond 7 days is returned');

    // =========================================================================
    // Test 4: Date Filter Semantics [check_in, check_out)
    // =========================================================================
    console.log('\n--- Test 4: Date Filter Semantics ---');
    // Stay-overlap query: range 2026-08-28 to 2026-08-30 (Bob's stay 2026-08-26..2026-08-29 overlaps; Alice and Charlie do not)
    const overlapRes = await api('GET', `/api/reservations?property_id=${propAId}&start_date=2026-08-28&end_date=2026-08-30`);
    assert(overlapRes.status === 200, '4A. Date range query returns 200');
    const overlapGuests = (overlapRes.body?.data || []).map(r => r.guest_name);
    assert(overlapGuests.includes('Bob Current'), '4B. Overlapping stay Bob Current included in range');
    assert(!overlapGuests.includes('Alice Historical'), '4C. Non-overlapping Alice Historical excluded');
    assert(!overlapGuests.includes('Charlie Future'), '4D. Non-overlapping Charlie Future excluded');

    // Single date filter: 2026-08-27 (Bob 2026-08-26..2026-08-29 is occupied on 2026-08-27)
    const singleDateRes = await api('GET', `/api/reservations?property_id=${propAId}&date=2026-08-27`);
    assert(singleDateRes.status === 200, '4E. Single date query returns 200');
    const singleGuests = (singleDateRes.body?.data || []).map(r => r.guest_name);
    assert(singleGuests.includes('Bob Current'), '4F. Single date occupied stay Bob Current included');

    // Checkout date is NOT occupied: range start_date=2026-07-23, end_date=2026-07-25 (Alice checked out 2026-07-23)
    const checkoutDateRes = await api('GET', `/api/reservations?property_id=${propAId}&start_date=2026-07-23&end_date=2026-07-25`);
    const checkoutGuests = (checkoutDateRes.body?.data || []).map(r => r.guest_name);
    assert(!checkoutGuests.includes('Alice Historical'), '4G. Checkout date boundary is NOT occupied [check_in, check_out)');

    // Invalid date range (start >= end)
    const invalidRange = await api('GET', `/api/reservations?property_id=${propAId}&start_date=2026-08-30&end_date=2026-08-20`);
    assert(invalidRange.status === 400, '4H. Invalid date range (start >= end) returns 400');

    // =========================================================================
    // Test 5: Status & Search Filters
    // =========================================================================
    console.log('\n--- Test 5: Status & Search Filters ---');
    const checkedInRes = await api('GET', `/api/reservations?property_id=${propAId}&status=CHECKED_IN`);
    assert(checkedInRes.status === 200, '5A. Status filter returns 200');
    assert(checkedInRes.body?.data?.length === 1 && checkedInRes.body.data[0].guest_name === 'Bob Current', '5B. Status CHECKED_IN returns Bob Current');

    const searchRes = await api('GET', `/api/reservations?property_id=${propAId}&search=0833333333`);
    assert(searchRes.status === 200, '5C. Search by phone returns 200');
    assert(searchRes.body?.data?.length === 1 && searchRes.body.data[0].guest_name === 'Charlie Future', '5D. Search by phone returns Charlie Future');

    const searchBidRes = await api('GET', `/api/reservations?property_id=${propAId}&search=BID-LIST-A1`);
    assert(searchBidRes.body?.data?.length === 1 && searchBidRes.body.data[0].guest_name === 'Alice Historical', '5E. Search by BID returns Alice Historical');

  } finally {
    if (server) {
      server.close();
      await once(server, 'close');
    }

    // Teardown
    console.log('\n--- Cleaning up Fixtures ---');
    if (propAId || propBId) {
      const pIds = [propAId, propBId].filter(Boolean);
      await pool.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = ANY($1::int[]))', [pIds]);
      await pool.query('DELETE FROM bookings WHERE property_id = ANY($1::int[])', [pIds]);
      await pool.query('DELETE FROM rooms WHERE property_id = ANY($1::int[])', [pIds]);
      await pool.query('DELETE FROM room_types WHERE property_id = ANY($1::int[])', [pIds]);
      await pool.query('DELETE FROM properties WHERE id = ANY($1::int[])', [pIds]);
    }

    const testPropCheck = await pool.query("SELECT COUNT(*)::int as count FROM properties WHERE property_code IN ('TLA', 'TLB')");
    assert(testPropCheck.rows[0].count === 0, '6A. Zero test properties fixture residue');
  }

  console.log(`\nProperty-Scoped Reservation List Test Summary: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Test execution error:', err);
  process.exitCode = 1;
});
