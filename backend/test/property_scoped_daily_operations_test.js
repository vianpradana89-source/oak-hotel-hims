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
  console.log('=== Starting Property-Scoped Daily Operations Tests ===\n');

  server = http.createServer(app);
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  let propAId = null;
  let propBId = null;
  let roomTypeIdA = null;
  let roomTypeIdB = null;
  let roomIdsA = [];
  let roomIdsB = [];

  const TEST_DATE = '2026-09-01';

  try {
    // 1. Setup Test Fixtures: Property A and Property B
    const propARes = await pool.query("INSERT INTO properties (property_code, name, address, is_active) VALUES ('TDA', 'Test Ops Prop A', 'Test Address A', TRUE) RETURNING id");
    propAId = propARes.rows[0].id;

    const propBRes = await pool.query("INSERT INTO properties (property_code, name, address, is_active) VALUES ('TDB', 'Test Ops Prop B', 'Test Address B', TRUE) RETURNING id");
    propBId = propBRes.rows[0].id;

    // Room Types
    const rtARes = await pool.query("INSERT INTO room_types (property_id, code, name, base_rate, capacity) VALUES ($1, 'OPTA', 'Ops Type A', 500000, 2) RETURNING id", [propAId]);
    roomTypeIdA = rtARes.rows[0].id;

    const rtBRes = await pool.query("INSERT INTO room_types (property_id, code, name, base_rate, capacity) VALUES ($1, 'OPTB', 'Ops Type B', 600000, 2) RETURNING id", [propBId]);
    roomTypeIdB = rtBRes.rows[0].id;

    // Rooms for Property A (Total 6 active rooms with different operational statuses)
    const statusesA = [
      'VACANT_CLEAN',
      'VACANT_DIRTY',
      'CLEANING',
      'INSPECTED',
      'OCCUPIED_CLEAN',
      'OUT_OF_ORDER'
    ];

    for (let i = 0; i < statusesA.length; i++) {
      const r = await pool.query(
        "INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, $3, 'Ops Room', $4, true) RETURNING id",
        [propAId, roomTypeIdA, `A-OPS-${i + 1}`, statusesA[i]]
      );
      roomIdsA.push(r.rows[0].id);
    }

    // Also add 1 inactive room for Property A (should be excluded from total_active_rooms)
    await pool.query(
      "INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, 'A-OPS-INACTIVE', 'Inactive Room', 'OUT_OF_SERVICE', false)",
      [propAId, roomTypeIdA]
    );

    // Rooms for Property B (Total 1 active room)
    const rB1 = await pool.query("INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active) VALUES ($1, $2, 'B-OPS-1', 'Ops Room B', 'VACANT_CLEAN', true) RETURNING id", [propBId, roomTypeIdB]);
    roomIdsB.push(rB1.rows[0].id);

    // 2. Setup Reservations for Property A on TEST_DATE (2026-09-01)
    // Res 1: Arrival on TEST_DATE (2026-09-01 -> 2026-09-03) - BOOKED
    const bA1 = await pool.query("INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-OPS-A1', $1, 'Arrival Guest') RETURNING id", [propAId]);
    const rA1 = await pool.query(`
      INSERT INTO reservations (booking_id, stay_sequence, room_id, guest_name, check_in, check_out, total_price, amount_paid, remaining_balance, status, payment_status, booked_room_type_id_snapshot, booked_room_type_name_snapshot)
      VALUES ($1, 1, $2, 'Arrival Guest', '2026-09-01', '2026-09-03', 1000000, 200000, 800000, 'BOOKED', 'PARTIAL', $3, 'Ops Type A')
      RETURNING id
    `, [bA1.rows[0].id, roomIdsA[0], roomTypeIdA]);

    // Res 2: Departure on TEST_DATE (2026-08-30 -> 2026-09-01) - CHECKED_IN
    const bA2 = await pool.query("INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-OPS-A2', $1, 'Departure Guest') RETURNING id", [propAId]);
    const rA2 = await pool.query(`
      INSERT INTO reservations (booking_id, stay_sequence, room_id, guest_name, check_in, check_out, total_price, amount_paid, remaining_balance, status, payment_status, booked_room_type_id_snapshot, booked_room_type_name_snapshot)
      VALUES ($1, 1, $2, 'Departure Guest', '2026-08-30', '2026-09-01', 500000, 500000, 0, 'CHECKED_IN', 'PAID', $3, 'Ops Type A')
      RETURNING id
    `, [bA2.rows[0].id, roomIdsA[4], roomTypeIdA]);

    // Res 3: In-House on TEST_DATE (2026-08-31 -> 2026-09-02) - CHECKED_IN
    const bA3 = await pool.query("INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-OPS-A3', $1, 'InHouse Guest') RETURNING id", [propAId]);
    const rA3 = await pool.query(`
      INSERT INTO reservations (booking_id, stay_sequence, room_id, guest_name, check_in, check_out, total_price, amount_paid, remaining_balance, status, payment_status, booked_room_type_id_snapshot, booked_room_type_name_snapshot)
      VALUES ($1, 1, $2, 'InHouse Guest', '2026-08-31', '2026-09-02', 1000000, 500000, 500000, 'CHECKED_IN', 'PARTIAL', $3, 'Ops Type A')
      RETURNING id
    `, [bA3.rows[0].id, roomIdsA[3], roomTypeIdA]);

    // Res 4: Cancelled on TEST_DATE (2026-09-01 -> 2026-09-02) - CANCELLED
    const bA4 = await pool.query("INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-OPS-A4', $1, 'Cancelled Guest') RETURNING id", [propAId]);
    await pool.query(`
      INSERT INTO reservations (booking_id, stay_sequence, room_id, guest_name, check_in, check_out, total_price, amount_paid, remaining_balance, status, payment_status, booked_room_type_id_snapshot, booked_room_type_name_snapshot)
      VALUES ($1, 1, $2, 'Cancelled Guest', '2026-09-01', '2026-09-02', 500000, 0, 500000, 'CANCELLED', 'UNPAID', $3, 'Ops Type A')
    `, [bA4.rows[0].id, roomIdsA[1], roomTypeIdA]);

    // 3. Payment Transactions for Property A
    // Normal payments on TEST_DATE (2026-09-01): 200k + 300k = 500k
    await pool.query(`
      INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, status, created_at)
      VALUES ($1, 'PAYMENT', 200000, 'CASH', 'SUCCESS', '2026-09-01 10:00:00')
    `, [rA1.rows[0].id]);

    await pool.query(`
      INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, status, created_at)
      VALUES ($1, 'PAYMENT', 300000, 'TRANSFER', 'SUCCESS', '2026-09-01 14:00:00')
    `, [rA3.rows[0].id]);

    // Midnight WIB Boundary Payments:
    // P_WIB_0030: UTC 2026-08-31 17:30:00Z -> 2026-09-01 00:30:00 WIB (Belongs to 2026-09-01) = 100k
    await pool.query(`
      INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, status, created_at)
      VALUES ($1, 'PAYMENT', 100000, 'CASH', 'SUCCESS', '2026-08-31 17:30:00Z'::timestamptz)
    `, [rA1.rows[0].id]);

    // P_WIB_2359_PREV: UTC 2026-08-31 16:59:59Z -> 2026-08-31 23:59:59 WIB (Belongs to 2026-08-31) = 150k
    await pool.query(`
      INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, status, created_at)
      VALUES ($1, 'PAYMENT', 150000, 'CASH', 'SUCCESS', '2026-08-31 16:59:59Z'::timestamptz)
    `, [rA1.rows[0].id]);

    // P_WIB_2359_TODAY: UTC 2026-09-01 16:59:59Z -> 2026-09-01 23:59:59 WIB (Belongs to 2026-09-01) = 75k
    await pool.query(`
      INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, status, created_at)
      VALUES ($1, 'PAYMENT', 75000, 'CASH', 'SUCCESS', '2026-09-01 16:59:59Z'::timestamptz)
    `, [rA1.rows[0].id]);

    // P_WIB_0000_NEXT: UTC 2026-09-01 17:00:01Z -> 2026-09-02 00:00:01 WIB (Belongs to 2026-09-02) = 90k
    await pool.query(`
      INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, status, created_at)
      VALUES ($1, 'PAYMENT', 90000, 'CASH', 'SUCCESS', '2026-09-01 17:00:01Z'::timestamptz)
    `, [rA1.rows[0].id]);

    // Payment on an earlier date (2026-08-30 11:00:00) = 500k
    await pool.query(`
      INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, status, created_at)
      VALUES ($1, 'PAYMENT', 500000, 'CASH', 'SUCCESS', '2026-08-30 11:00:00')
    `, [rA2.rows[0].id]);

    // 4. Setup Booking & Payment for Property B
    const bB1 = await pool.query("INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ('BID-OPS-B1', $1, 'Prop B Guest') RETURNING id", [propBId]);
    const resB1 = await pool.query(`
      INSERT INTO reservations (booking_id, stay_sequence, room_id, guest_name, check_in, check_out, total_price, amount_paid, remaining_balance, status, payment_status, booked_room_type_id_snapshot, booked_room_type_name_snapshot)
      VALUES ($1, 1, $2, 'Prop B Guest', '2026-08-31', '2026-09-03', 1200000, 1200000, 0, 'CHECKED_IN', 'PAID', $3, 'Ops Type B')
      RETURNING id
    `, [bB1.rows[0].id, roomIdsB[0], roomTypeIdB]);

    await pool.query(`
      INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, status, created_at)
      VALUES ($1, 'PAYMENT', 1200000, 'CASH', 'SUCCESS', '2026-09-01 15:00:00')
    `, [resB1.rows[0].id]);

    // =========================================================================
    // Test 1: Property Validation
    // =========================================================================
    console.log('--- Test 1: Property Validation ---');
    const noProp = await api('GET', '/api/reports/daily-operations');
    assert(noProp.status === 400, '1A. Missing property_id returns 400');
    assert(noProp.body?.code === 'VALIDATION_ERROR', '1B. Missing property_id code is VALIDATION_ERROR');

    const invalidProp = await api('GET', '/api/reports/daily-operations?property_id=bad');
    assert(invalidProp.status === 400, '1C. Invalid property_id returns 400');

    const unknownProp = await api('GET', '/api/reports/daily-operations?property_id=888888');
    assert(unknownProp.status === 404, '1E. Unknown property_id returns 404');
    assert(unknownProp.body?.code === 'PROPERTY_NOT_FOUND', '1F. Unknown property code is PROPERTY_NOT_FOUND');

    const invalidDate = await api('GET', `/api/reports/daily-operations?property_id=${propAId}&date=invalid-date`);
    assert(invalidDate.status === 400, '1G. Invalid date format returns 400');

    // =========================================================================
    // Test 2: Lifecycle Counters for Property A on TEST_DATE
    // =========================================================================
    console.log('\n--- Test 2: Lifecycle Counters ---');
    const resA = await api('GET', `/api/reports/daily-operations?property_id=${propAId}&date=${TEST_DATE}`);
    assert(resA.status === 200, '2A. GET /api/reports/daily-operations for Prop A returns 200');

    const lc = resA.body?.data?.lifecycle;
    assert(lc?.arrivals_today === 1, '2B. arrivals_today = 1 (rA1 arrival, rA4 cancelled excluded)');
    assert(lc?.departures_today === 1, '2C. departures_today = 1 (rA2 departure, active)');
    assert(lc?.in_house === 2, '2D. in_house = 2 (rA2 & rA3 are CHECKED_IN)');
    assert(lc?.booked_future_or_today === 1, '2E. booked_future_or_today = 1 (rA1 is BOOKED)');

    // Verify explicit response sections: business_date_metrics vs live_snapshot
    const bdm = resA.body?.data?.business_date_metrics;
    assert(bdm?.date === TEST_DATE, '2F. business_date_metrics.date matches requested date');
    assert(bdm?.arrivals === 1, '2G. business_date_metrics.arrivals = 1');
    assert(bdm?.departures === 1, '2H. business_date_metrics.departures = 1');

    const ls = resA.body?.data?.live_snapshot;
    assert(ls?.in_house_current === 2, '2I. live_snapshot.in_house_current = 2');
    assert(ls?.booked_active === 1, '2J. live_snapshot.booked_active = 1');

    // =========================================================================
    // Test 3: Room Status Live Pulse for Property A
    // =========================================================================
    console.log('\n--- Test 3: Room Status Live Pulse ---');
    const rm = resA.body?.data?.rooms;
    assert(rm?.total_active_rooms === 6, '3A. total_active_rooms = 6 (excludes inactive room)');
    assert(rm?.vacant_ready === 1, '3B. vacant_ready = 1');
    assert(rm?.vacant_dirty === 1, '3C. vacant_dirty = 1');
    assert(rm?.cleaning === 1, '3D. cleaning = 1');
    assert(rm?.waiting_inspection === 1, '3E. waiting_inspection = 1');
    assert(rm?.occupied === 1, '3F. occupied = 1 (OCCUPIED_CLEAN)');
    assert(rm?.out_of_order === 1, '3G. out_of_order = 1');
    assert(rm?.out_of_order_or_service === 1, '3H. out_of_order_or_service = 1');

    // =========================================================================
    // Test 4: Financial Pulse & Midnight WIB Boundary
    // =========================================================================
    console.log('\n--- Test 4: Financial Pulse & Midnight WIB Boundary ---');
    const fin = resA.body?.data?.financials;
    // Expected on 2026-09-01: 200k + 300k + 100k (00:30 WIB) + 75k (23:59:59 WIB) = 675,000
    assert(fin?.cash_collected_today === 675000, `4A. cash_collected_today = 675000 (200k + 300k + 100k [00:30 WIB] + 75k [23:59:59 WIB] on ${TEST_DATE})`);
    assert(bdm?.cash_collected === 675000, '4B. business_date_metrics.cash_collected = 675000');
    // Outstanding balance: rA1 (800k) + rA2 (0k) + rA3 (500k) = 1,300,000 (excludes cancelled rA4 500k)
    assert(fin?.outstanding_guest_balance === 1300000, '4C. outstanding_guest_balance = 1300000 (excludes cancelled reservations)');
    assert(ls?.outstanding_guest_balance_current === 1300000, '4D. live_snapshot.outstanding_guest_balance_current = 1300000');

    // Boundary Test for Preceding Hotel Date: 2026-08-31
    const resPrevDay = await api('GET', `/api/reports/daily-operations?property_id=${propAId}&date=2026-08-31`);
    assert(resPrevDay.status === 200, '4E. GET /api/reports/daily-operations for 2026-08-31 returns 200');
    assert(resPrevDay.body?.data?.financials?.cash_collected_today === 150000, '4F. cash_collected for 2026-08-31 = 150000 (P_WIB_2359_PREV captured on Aug 31)');

    // Boundary Test for Succeeding Hotel Date: 2026-09-02
    const resNextDay = await api('GET', `/api/reports/daily-operations?property_id=${propAId}&date=2026-09-02`);
    assert(resNextDay.status === 200, '4G. GET /api/reports/daily-operations for 2026-09-02 returns 200');
    assert(resNextDay.body?.data?.financials?.cash_collected_today === 90000, '4H. cash_collected for 2026-09-02 = 90000 (P_WIB_0000_NEXT captured on Sep 02)');

    // Session TimeZone Invariance Test:
    // 1. Under America/New_York session timezone
    await pool.query("SET TIME ZONE 'America/New_York'");
    const resNySep01 = await api('GET', `/api/reports/daily-operations?property_id=${propAId}&date=${TEST_DATE}`);
    assert(resNySep01.body?.data?.financials?.cash_collected_today === 675000, '4I. cash_collected invariant on 2026-09-01 under America/New_York session timezone');
    const resNyAug31 = await api('GET', `/api/reports/daily-operations?property_id=${propAId}&date=2026-08-31`);
    assert(resNyAug31.body?.data?.financials?.cash_collected_today === 150000, '4J. cash_collected invariant on 2026-08-31 under America/New_York session timezone');
    const resNySep02 = await api('GET', `/api/reports/daily-operations?property_id=${propAId}&date=2026-09-02`);
    assert(resNySep02.body?.data?.financials?.cash_collected_today === 90000, '4K. cash_collected invariant on 2026-09-02 under America/New_York session timezone');

    // 2. Under UTC session timezone
    await pool.query("SET TIME ZONE 'UTC'");
    const resUtcSep01 = await api('GET', `/api/reports/daily-operations?property_id=${propAId}&date=${TEST_DATE}`);
    assert(resUtcSep01.body?.data?.financials?.cash_collected_today === 675000, '4L. cash_collected invariant on 2026-09-01 under UTC session timezone');
    const resUtcAug31 = await api('GET', `/api/reports/daily-operations?property_id=${propAId}&date=2026-08-31`);
    assert(resUtcAug31.body?.data?.financials?.cash_collected_today === 150000, '4M. cash_collected invariant on 2026-08-31 under UTC session timezone');
    const resUtcSep02 = await api('GET', `/api/reports/daily-operations?property_id=${propAId}&date=2026-09-02`);
    assert(resUtcSep02.body?.data?.financials?.cash_collected_today === 90000, '4N. cash_collected invariant on 2026-09-02 under UTC session timezone');

    // =========================================================================
    // Test 5: Strict Property Isolation (Property B)
    // =========================================================================
    console.log('\n--- Test 5: Property Isolation ---');
    const resB = await api('GET', `/api/reports/daily-operations?property_id=${propBId}&date=${TEST_DATE}`);
    assert(resB.status === 200, '5A. GET /api/reports/daily-operations for Prop B returns 200');

    const lcB = resB.body?.data?.lifecycle;
    assert(lcB?.arrivals_today === 0, '5B. Prop B arrivals_today = 0 (rB1 is CHECKED_IN)');
    assert(lcB?.in_house === 1, '5C. Prop B in_house = 1');

    const rmB = resB.body?.data?.rooms;
    assert(rmB?.total_active_rooms === 1, '5D. Prop B total_active_rooms = 1');
    assert(rmB?.vacant_ready === 1, '5E. Prop B vacant_ready = 1');

    const finB = resB.body?.data?.financials;
    assert(finB?.cash_collected_today === 1200000, '5F. Prop B cash_collected_today = 1200000');
    assert(finB?.outstanding_guest_balance === 0, '5G. Prop B outstanding_guest_balance = 0');

  } finally {
    if (server) {
      server.close();
      await once(server, 'close');
    }

    // Teardown
    console.log('\n--- Cleaning up Fixtures ---');
    if (propAId || propBId) {
      const pIds = [propAId, propBId].filter(Boolean);
      await pool.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = ANY($1::int[])))', [pIds]);
      await pool.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = ANY($1::int[]))', [pIds]);
      await pool.query('DELETE FROM bookings WHERE property_id = ANY($1::int[])', [pIds]);
      await pool.query('DELETE FROM rooms WHERE property_id = ANY($1::int[])', [pIds]);
      await pool.query('DELETE FROM room_types WHERE property_id = ANY($1::int[])', [pIds]);
      await pool.query('DELETE FROM properties WHERE id = ANY($1::int[])', [pIds]);
    }

    const testPropCheck = await pool.query("SELECT COUNT(*)::int as count FROM properties WHERE property_code IN ('TDA', 'TDB')");
    assert(testPropCheck.rows[0].count === 0, '6A. Zero test properties fixture residue');
  }

  console.log(`\nProperty-Scoped Daily Operations Test Summary: ${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Test execution error:', err);
  process.exitCode = 1;
});
