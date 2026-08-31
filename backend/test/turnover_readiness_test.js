// backend/test/turnover_readiness_test.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { once } = require('events');
const { app, pool } = require('../dist/index');

let server;
let baseUrl;

function expect(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function toDateKey(dateValue) {
  const dt = new Date(dateValue);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function enumerateDates(startStr, endStr) {
  const dates = [];
  let cur = startStr;
  while (cur < endStr) {
    dates.push(cur);
    cur = addDays(cur, 1);
  }
  return dates;
}

async function request(method, requestPath, body, correlationId) {
  const headers = { 'Content-Type': 'application/json' };
  if (correlationId) {
    headers['X-Correlation-Id'] = correlationId;
  }
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { status: response.status, json, text };
}

async function cleanupCorrelation(correlationId) {
  if (!correlationId) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reservations = await client.query(
      `SELECT r.id, r.room_id, r.check_in, r.check_out,
              COALESCE(r.booked_room_type_id_snapshot, rm.room_type_id) AS room_type_id
       FROM reservations r
       JOIN rooms rm ON rm.id = r.room_id
       WHERE r.correlation_id = $1`,
      [correlationId]
    );

    for (const res of reservations.rows) {
      const ci = toDateKey(res.check_in);
      const co = toDateKey(res.check_out);
      const dates = enumerateDates(ci, co);
      for (const d of dates) {
        await client.query(
          `UPDATE availability_dates
           SET reserved_qty = GREATEST(0, reserved_qty - 1)
           WHERE room_type_id = $1 AND (date AT TIME ZONE 'Asia/Jakarta')::date = $2::date`,
          [res.room_type_id, d]
        );
      }
    }

    await client.query('DELETE FROM payment_evidences WHERE reservation_id IN (SELECT id FROM reservations WHERE correlation_id = $1)', [correlationId]);
    await client.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE correlation_id = $1)', [correlationId]);
    await client.query('DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE correlation_id = $1)', [correlationId]);
    await client.query('DELETE FROM audit_logs WHERE correlation_id = $1', [correlationId]);
    await client.query('DELETE FROM reservations WHERE correlation_id = $1', [correlationId]);
    await client.query('DELETE FROM bookings WHERE correlation_id = $1', [correlationId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function runTests() {
  server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(`Server listening on ${baseUrl} for in-process test execution`);

  console.log('--- Starting TURNOVER-1 Room Readiness & Turnover Safety Tests ---');
  let client;
  let testRoom = null;
  let originalRoomStatus = 'VACANT_CLEAN';
  let originalHkSettings = null;
  const createdCorrelations = [];

  try {
    client = await pool.connect();
    const testStartDate = '2026-12-01';
    const day1 = testStartDate;
    const day2 = addDays(day1, 1);
    const day3 = addDays(day1, 2);
    const day4 = addDays(day1, 3);

    // 1. Discover or select an active room in property 1 with NO overlapping reservations on test dates
    const roomRes = await client.query(
      `SELECT r.id, r.room_number, r.status, r.property_id, r.room_type_id, rt.name as room_type_name
       FROM rooms r
       JOIN room_types rt ON rt.id = r.room_type_id
       WHERE r.property_id = 1
         AND r.is_active = true
         AND rt.is_active = true
         AND NOT EXISTS (
           SELECT 1 FROM reservations res
           WHERE res.room_id = r.id
             AND res.status IN ('BOOKED', 'CHECKED_IN')
             AND NOT (res.check_out <= $1::timestamp OR res.check_in >= $2::timestamp)
         )
       ORDER BY r.id ASC
       LIMIT 1`,
      [`${day1}T00:00:00+07:00`, `${day4}T00:00:00+07:00`]
    );
    expect(roomRes.rowCount === 1, 'No active available room found in property 1');
    testRoom = roomRes.rows[0];
    originalRoomStatus = testRoom.status || 'VACANT_CLEAN';

    console.log(`Using test room: ID=${testRoom.id}, No=${testRoom.room_number}, Type=${testRoom.room_type_name}`);

    // Isolate housekeeping settings for property 1
    const hkSetRes = await client.query('SELECT require_checkout_room_check FROM property_housekeeping_settings WHERE property_id = $1', [testRoom.property_id]);
    if (hkSetRes.rowCount > 0) {
      originalHkSettings = hkSetRes.rows[0].require_checkout_room_check;
      await client.query('UPDATE property_housekeeping_settings SET require_checkout_room_check = false WHERE property_id = $1', [testRoom.property_id]);
    }

    // Ensure baseline room status is VACANT_CLEAN
    await client.query('UPDATE rooms SET status = $1 WHERE id = $2', ['VACANT_CLEAN', testRoom.id]);

    // ==========================================
    // SCENARIO 1: Back-to-Back Booking Creation
    // Guest A: [day1, day2), Guest B: [day2, day3) on same physical room
    // ==========================================
    console.log('Scenario 1: Testing Back-to-Back booking creation on same room...');
    const corrA = `TURNOVER-A-${Date.now()}`;
    createdCorrelations.push(corrA);
    const bookingAPayload = {
      property_id: testRoom.property_id,
      guest_name: 'Guest A Outgoing',
      guest_phone: '081100010001',
      guest_segment: 'Reguler',
      booking_source: 'WALKIN',
      channel: 'Front Desk',
      currency_code: 'IDR',
      reservations: [{
        room_id: testRoom.id,
        check_in: day1,
        check_out: day2,
        subtotal_amount: 150000,
        total_price: 150000,
        discount_amount: 0,
        discount_percent: 0,
        amount_paid: 0,
        remaining_balance: 150000,
        payment_status: 'UNPAID',
        booking_type: 'WALKIN'
      }]
    };
    const resA = await request('POST', '/api/bookings', bookingAPayload, corrA);
    expect(resA.status === 201, `Guest A booking create failed: ${resA.status} ${resA.text}`);
    const resAId = resA.json.data.reservations[0].id;
    await client.query(`UPDATE reservations SET identity_number = '3171012345670001', has_valid_identity = true, guest_phone = '081100010001' WHERE id = $1`, [resAId]);

    const corrB = `TURNOVER-B-${Date.now()}`;
    createdCorrelations.push(corrB);
    const bookingBPayload = {
      property_id: testRoom.property_id,
      guest_name: 'Guest B Incoming',
      guest_phone: '081100010002',
      guest_segment: 'Reguler',
      booking_source: 'WALKIN',
      channel: 'Front Desk',
      currency_code: 'IDR',
      reservations: [{
        room_id: testRoom.id,
        check_in: day2,
        check_out: day3,
        subtotal_amount: 150000,
        total_price: 150000,
        discount_amount: 0,
        discount_percent: 0,
        amount_paid: 0,
        remaining_balance: 150000,
        payment_status: 'UNPAID',
        booking_type: 'WALKIN'
      }]
    };
    const resB = await request('POST', '/api/bookings', bookingBPayload, corrB);
    expect(resB.status === 201, `Guest B back-to-back booking create failed: ${resB.status} ${resB.text}`);
    const resBId = resB.json.data.reservations[0].id;
    await client.query(`UPDATE reservations SET identity_number = '3171012345670002', has_valid_identity = true, guest_phone = '081100010002' WHERE id = $1`, [resBId]);
    console.log('PASS | Scenario 1: Back-to-Back booking creation succeeded.');

    // ==========================================
    // SCENARIO 2: Real Date Overlap Rejection
    // Guest C: [day1, day3) overlapping day2 on same physical room
    // ==========================================
    console.log('Scenario 2: Testing real date overlap rejection...');
    const corrC = `TURNOVER-C-${Date.now()}`;
    const bookingCPayload = {
      property_id: testRoom.property_id,
      guest_name: 'Guest C Overlap',
      guest_phone: '081100010003',
      guest_segment: 'Reguler',
      booking_source: 'WALKIN',
      channel: 'Front Desk',
      currency_code: 'IDR',
      reservations: [{
        room_id: testRoom.id,
        check_in: day1,
        check_out: day3,
        subtotal_amount: 300000,
        total_price: 300000,
        discount_amount: 0,
        discount_percent: 0,
        amount_paid: 0,
        remaining_balance: 300000,
        payment_status: 'UNPAID',
        booking_type: 'WALKIN'
      }]
    };
    const resC = await request('POST', '/api/bookings', bookingCPayload, corrC);
    expect(resC.status === 409, `Expected 409 ROOM_OVERLAP, got ${resC.status} ${resC.text}`);
    console.log('PASS | Scenario 2: Real date overlap rejected with 409.');

    // ==========================================
    // SCENARIO 3: Live OCCUPIED & VACANT_DIRTY Status Does NOT Block Future Booking
    // ==========================================
    console.log('Scenario 3: Testing live room operational status decoupling from booking creation...');
    await client.query('UPDATE rooms SET status = $1 WHERE id = $2', ['OCCUPIED_CLEAN', testRoom.id]);
    const corrD = `TURNOVER-D-${Date.now()}`;
    createdCorrelations.push(corrD);
    const bookingDPayload = {
      property_id: testRoom.property_id,
      guest_name: 'Guest D Future',
      guest_phone: '081100010004',
      guest_segment: 'Reguler',
      booking_source: 'WALKIN',
      channel: 'Front Desk',
      currency_code: 'IDR',
      reservations: [{
        room_id: testRoom.id,
        check_in: day3,
        check_out: day4,
        subtotal_amount: 150000,
        total_price: 150000,
        discount_amount: 0,
        discount_percent: 0,
        amount_paid: 0,
        remaining_balance: 150000,
        payment_status: 'UNPAID',
        booking_type: 'WALKIN'
      }]
    };
    const resD = await request('POST', '/api/bookings', bookingDPayload, corrD);
    expect(resD.status === 201, `Future booking failed while room is OCCUPIED: ${resD.status} ${resD.text}`);

    // Also test with VACANT_DIRTY
    await client.query('UPDATE rooms SET status = $1 WHERE id = $2', ['VACANT_DIRTY', testRoom.id]);
    const corrE = `TURNOVER-E-${Date.now()}`;
    createdCorrelations.push(corrE);
    const day5 = addDays(day1, 4);
    const day6 = addDays(day1, 5);
    const bookingEPayload = {
      property_id: testRoom.property_id,
      guest_name: 'Guest E Future',
      guest_phone: '081100010005',
      guest_segment: 'Reguler',
      booking_source: 'WALKIN',
      channel: 'Front Desk',
      currency_code: 'IDR',
      reservations: [{
        room_id: testRoom.id,
        check_in: day5,
        check_out: day6,
        subtotal_amount: 150000,
        total_price: 150000,
        discount_amount: 0,
        discount_percent: 0,
        amount_paid: 0,
        remaining_balance: 150000,
        payment_status: 'UNPAID',
        booking_type: 'WALKIN'
      }]
    };
    const resE = await request('POST', '/api/bookings', bookingEPayload, corrE);
    expect(resE.status === 201, `Future booking failed while room is VACANT_DIRTY: ${resE.status} ${resE.text}`);
    console.log('PASS | Scenario 3: Live OCCUPIED/VACANT_DIRTY room status does not block future bookings.');

    // ==========================================
    // SCENARIO 4: Check-in Safety Gate - Outgoing Guest Still In-House
    // ==========================================
    console.log('Scenario 4: Testing Check-in Safety Gate when outgoing guest is CHECKED_IN...');
    // Make room VACANT_CLEAN so Guest A can check in
    await client.query('UPDATE rooms SET status = $1 WHERE id = $2', ['VACANT_CLEAN', testRoom.id]);

    // Check in Guest A
    const checkinA = await request('POST', `/api/reservations/${resAId}/checkin`, { property_id: testRoom.property_id });
    expect(checkinA.status === 200, `Guest A check-in failed: ${checkinA.status} ${checkinA.text}`);

    // Verify room is now OCCUPIED_CLEAN
    const roomOccupied = await client.query('SELECT status FROM rooms WHERE id = $1', [testRoom.id]);
    expect(roomOccupied.rows[0].status === 'OCCUPIED_CLEAN', 'Room should be OCCUPIED_CLEAN after checkin');

    // Attempt to check in Guest B (Incoming) while Guest A is still CHECKED_IN
    const checkinBWhileOccupied = await request('POST', `/api/reservations/${resBId}/checkin`, { property_id: testRoom.property_id });
    expect(checkinBWhileOccupied.status === 409, `Expected 409 when outgoing guest is in-house, got: ${checkinBWhileOccupied.status} ${checkinBWhileOccupied.text}`);
    expect(checkinBWhileOccupied.json.code === 'OUTGOING_NOT_CHECKED_OUT' || checkinBWhileOccupied.json.code === 'ROOM_NOT_READY', 'Expected OUTGOING_NOT_CHECKED_OUT or ROOM_NOT_READY code');
    console.log('PASS | Scenario 4: Incoming check-in blocked when outgoing guest is still checked-in.');

    // ==========================================
    // SCENARIO 5: Check-in Safety Gate - Room VACANT_DIRTY after Checkout
    // ==========================================
    console.log('Scenario 5: Testing Check-in Safety Gate when room is VACANT_DIRTY...');
    // Check out Guest A
    const checkoutA = await request('POST', `/api/reservations/${resAId}/checkout`, { property_id: testRoom.property_id });
    expect(checkoutA.status === 200, `Guest A checkout failed: ${checkoutA.status} ${checkoutA.text}`);

    // Verify room is now VACANT_DIRTY
    const roomDirty = await client.query('SELECT status FROM rooms WHERE id = $1', [testRoom.id]);
    expect(roomDirty.rows[0].status === 'VACANT_DIRTY', `Room should be VACANT_DIRTY after checkout, got ${roomDirty.rows[0].status}`);

    // Attempt to check in Guest B while room is VACANT_DIRTY
    const checkinBWhileDirty = await request('POST', `/api/reservations/${resBId}/checkin`, { property_id: testRoom.property_id });
    expect(checkinBWhileDirty.status === 409, `Expected 409 when room is VACANT_DIRTY, got: ${checkinBWhileDirty.status} ${checkinBWhileDirty.text}`);
    expect(checkinBWhileDirty.json.code === 'HOUSEKEEPING_IN_PROGRESS' || checkinBWhileDirty.json.code === 'ROOM_NOT_READY', 'Expected HOUSEKEEPING_IN_PROGRESS / ROOM_NOT_READY code');
    console.log('PASS | Scenario 5: Incoming check-in blocked when room is VACANT_DIRTY.');

    // ==========================================
    // SCENARIO 6: Check-in Safety Gate - Room CLEANING
    // ==========================================
    console.log('Scenario 6: Testing Check-in Safety Gate when room is CLEANING...');
    await client.query('UPDATE rooms SET status = $1 WHERE id = $2', ['CLEANING', testRoom.id]);
    const checkinBWhileCleaning = await request('POST', `/api/reservations/${resBId}/checkin`, { property_id: testRoom.property_id });
    expect(checkinBWhileCleaning.status === 409, `Expected 409 when room is CLEANING, got: ${checkinBWhileCleaning.status}`);
    console.log('PASS | Scenario 6: Incoming check-in blocked when room is CLEANING.');

    // ==========================================
    // SCENARIO 7: Check-in Success when Room is Marked VACANT_CLEAN or INSPECTED
    // ==========================================
    console.log('Scenario 7: Testing Check-in Success when room is marked VACANT_CLEAN...');
    await client.query('UPDATE rooms SET status = $1 WHERE id = $2', ['VACANT_CLEAN', testRoom.id]);

    const checkinBReady = await request('POST', `/api/reservations/${resBId}/checkin`, { property_id: testRoom.property_id });
    expect(checkinBReady.status === 200, `Guest B check-in failed on VACANT_CLEAN: ${checkinBReady.status} ${checkinBReady.text}`);
    expect(checkinBReady.json.data.status === 'CHECKED_IN', 'Guest B reservation should be CHECKED_IN');

    // Verify room is now OCCUPIED_CLEAN
    const roomAfterB = await client.query('SELECT status FROM rooms WHERE id = $1', [testRoom.id]);
    expect(roomAfterB.rows[0].status === 'OCCUPIED_CLEAN', 'Room should be OCCUPIED_CLEAN after Guest B check-in');
    console.log('PASS | Scenario 7: Check-in succeeded once room marked VACANT_CLEAN.');

    // ==========================================
    // SCENARIO 8: Reservation Detail Endpoint Returns Readiness Metadata
    // ==========================================
    console.log('Scenario 8: Testing GET /api/reservations/:id readiness metadata...');
    const detailRes = await request('GET', `/api/reservations/${resBId}?property_id=${testRoom.property_id}`);
    expect(detailRes.status === 200, `GET reservation detail failed: ${detailRes.status}`);
    expect(detailRes.json.data && detailRes.json.data.readiness !== undefined, 'Missing readiness metadata in reservation detail');
    console.log('PASS | Scenario 8: Reservation detail returns readiness metadata.');

    // ==========================================
    // SCENARIO 9: Tapechart Cell Turnover Metadata
    // ==========================================
    console.log('Scenario 9: Testing GET /api/tapechart turnover departures & arrivals...');
    const tapechartRes = await request('GET', `/api/tapechart?start=${day1}&end=${day4}&property_id=${testRoom.property_id}`);
    expect(tapechartRes.status === 200, `GET tapechart failed: ${tapechartRes.status}`);
    const tapeRooms = tapechartRes.json.rooms || [];
    const tapeTestRoom = tapeRooms.find(r => r.id === testRoom.id);
    expect(tapeTestRoom !== undefined, 'Test room not found in tapechart');

    const day2Cell = tapeTestRoom.cells.find(c => c.date === day2);
    expect(day2Cell !== undefined, `Cell for ${day2} missing in tapechart`);
    expect(Array.isArray(day2Cell.departures), 'Missing departures in cell');
    expect(Array.isArray(day2Cell.arrivals), 'Missing arrivals in cell');
    expect(day2Cell.turnover !== null, 'Missing turnover metadata in cell');
    expect(day2Cell.turnover.has_turnover === true, 'Cell should have has_turnover: true for same-day turnover');
    console.log('PASS | Scenario 9: Tapechart cell returns turnover departures and arrivals.');

    // ==========================================
    // SCENARIO 10: Concurrent Check-In Race Proof (Exact row locking)
    // ==========================================
    console.log('Scenario 10: Testing Concurrent Check-In Race on same physical room...');
    const concDate1 = '2026-12-10';
    const concDate2 = '2026-12-11';
    const concDate3 = '2026-12-12';

    // Create Reservation C1 (2026-12-10 to 2026-12-11)
    const corrC1 = `TURNOVER-CONC1-${Date.now()}`;
    createdCorrelations.push(corrC1);
    const createC1 = await request('POST', '/api/bookings', {
      property_id: testRoom.property_id,
      guest_name: 'Concurrent Guest 1',
      guest_phone: '081299990001',
      booking_source: 'DIRECT',
      reservations: [{
        room_id: testRoom.id,
        room_type_id: testRoom.room_type_id,
        check_in: concDate1,
        check_out: concDate2,
        total_price: 450000,
        qty: 1
      }]
    }, corrC1);
    expect(createC1.status === 201, `Create C1 failed: ${createC1.status} ${createC1.text}`);
    const resC1Id = createC1.json.data.reservations[0].id;
    await client.query(`UPDATE reservations SET identity_number = '3171012345670003', has_valid_identity = true, guest_phone = '081299990001' WHERE id = $1`, [resC1Id]);

    // Create Reservation C2 (2026-12-11 to 2026-12-12)
    const corrC2 = `TURNOVER-CONC2-${Date.now()}`;
    createdCorrelations.push(corrC2);
    const createC2 = await request('POST', '/api/bookings', {
      property_id: testRoom.property_id,
      guest_name: 'Concurrent Guest 2',
      guest_phone: '081299990002',
      booking_source: 'DIRECT',
      reservations: [{
        room_id: testRoom.id,
        room_type_id: testRoom.room_type_id,
        check_in: concDate2,
        check_out: concDate3,
        total_price: 450000,
        qty: 1
      }]
    }, corrC2);
    expect(createC2.status === 201, `Create C2 failed: ${createC2.status} ${createC2.text}`);
    const resC2Id = createC2.json.data.reservations[0].id;
    await client.query(`UPDATE reservations SET identity_number = '3171012345670004', has_valid_identity = true, guest_phone = '081299990002' WHERE id = $1`, [resC2Id]);

    // Ensure room is VACANT_CLEAN
    await client.query('UPDATE rooms SET status = $1 WHERE id = $2', ['VACANT_CLEAN', testRoom.id]);

    // Fire TWO concurrent check-in requests for the same room simultaneously
    const [checkin1Res, checkin2Res] = await Promise.all([
      request('POST', `/api/reservations/${resC1Id}/checkin`, { property_id: testRoom.property_id }),
      request('POST', `/api/reservations/${resC2Id}/checkin`, { property_id: testRoom.property_id })
    ]);

    const statuses = [checkin1Res.status, checkin2Res.status].sort();
    expect(statuses[0] === 200 && statuses[1] === 409, `Expected exactly one 200 and one 409 from concurrent checkin race, got ${checkin1Res.status} and ${checkin2Res.status}`);

    // Verify final DB state: exactly ONE reservation is CHECKED_IN
    const activeCheckedInRes = await client.query(
      `SELECT id, status FROM reservations WHERE id IN ($1, $2) AND status = 'CHECKED_IN'`,
      [resC1Id, resC2Id]
    );
    expect(activeCheckedInRes.rowCount === 1, `Expected exactly 1 CHECKED_IN reservation, found ${activeCheckedInRes.rowCount}`);

    const roomPostConc = await client.query('SELECT status FROM rooms WHERE id = $1', [testRoom.id]);
    expect(roomPostConc.rows[0].status === 'OCCUPIED_CLEAN', `Expected room to be OCCUPIED_CLEAN, got ${roomPostConc.rows[0].status}`);
    console.log('PASS | Scenario 10: Concurrent check-in race serialized by row locks (at most 1 succeeded, other 409 conflict, state consistent).');

    // ==========================================
    // SCENARIO 11: Tapechart Window Boundary & Half-Open Semantics
    // ==========================================
    console.log('Scenario 11: Testing Tapechart Window Boundary & Semantics...');
    const winStart = '2026-12-20';
    const winMid = '2026-12-21';
    const winEnd = '2026-12-22';

    // 1. Boundary: checkout == window_start (stay 2026-12-19 -> 2026-12-20)
    const corrB1 = `TURNOVER-BND1-${Date.now()}`;
    createdCorrelations.push(corrB1);
    const createB1 = await request('POST', '/api/bookings', {
      property_id: testRoom.property_id,
      guest_name: 'Boundary CheckoutAtStart',
      guest_phone: '081299990011',
      booking_source: 'DIRECT',
      reservations: [{
        room_id: testRoom.id,
        room_type_id: testRoom.room_type_id,
        check_in: '2026-12-19',
        check_out: winStart,
        total_price: 450000,
        qty: 1
      }]
    }, corrB1);
    expect(createB1.status === 201, `Create B1 failed: ${createB1.status}`);
    const resB1Id = createB1.json.data.reservations[0].id;

    // 2. Boundary: checkin == window_end (stay 2026-12-22 -> 2026-12-23)
    const corrB2 = `TURNOVER-BND2-${Date.now()}`;
    createdCorrelations.push(corrB2);
    const createB2 = await request('POST', '/api/bookings', {
      property_id: testRoom.property_id,
      guest_name: 'Boundary CheckinAtEnd',
      guest_phone: '081299990012',
      booking_source: 'DIRECT',
      reservations: [{
        room_id: testRoom.id,
        room_type_id: testRoom.room_type_id,
        check_in: winEnd,
        check_out: '2026-12-23',
        total_price: 450000,
        qty: 1
      }]
    }, corrB2);
    expect(createB2.status === 201, `Create B2 failed: ${createB2.status}`);
    const resB2Id = createB2.json.data.reservations[0].id;

    // 3. Spanning reservation (stay 2026-12-18 -> 2026-12-24)
    const corrBSpanning = `TURNOVER-BNDSP-${Date.now()}`;
    createdCorrelations.push(corrBSpanning);
    // Use room 2 if available or another room in property 1 for spanning test
    const spanningRoomRes = await client.query(
      `SELECT r.id, r.room_number, r.room_type_id FROM rooms r
       WHERE r.property_id = $1 AND r.id <> $2 AND r.is_active = true
       ORDER BY r.id LIMIT 1`,
      [testRoom.property_id, testRoom.id]
    );
    if (spanningRoomRes.rowCount > 0) {
      const spanningRoom = spanningRoomRes.rows[0];
      const createSpanning = await request('POST', '/api/bookings', {
        property_id: testRoom.property_id,
        guest_name: 'Spanning Stay',
        guest_phone: '081299990019',
        booking_source: 'DIRECT',
        reservations: [{
          room_id: spanningRoom.id,
          room_type_id: spanningRoom.room_type_id,
          check_in: '2026-12-18',
          check_out: '2026-12-24',
          total_price: 900000,
          qty: 1
        }]
      }, corrBSpanning);
      expect(createSpanning.status === 201, `Create spanning failed: ${createSpanning.status}`);
      const resSpanningId = createSpanning.json.data.reservations[0].id;

      const tapeSpanning = await request('GET', `/api/tapechart?start=${winStart}&end=${winEnd}&property_id=${testRoom.property_id}`);
      const spanningTapeRoom = tapeSpanning.json.rooms.find(r => r.id === spanningRoom.id);
      expect(spanningTapeRoom !== undefined, 'Spanning room missing in tapechart');
      const c1 = spanningTapeRoom.cells.find(c => c.date === winStart);
      const c2 = spanningTapeRoom.cells.find(c => c.date === winMid);
      expect(c1 && c1.reservations.some(r => r.id === resSpanningId), 'Spanning reservation must occupy winStart');
      expect(c2 && c2.reservations.some(r => r.id === resSpanningId), 'Spanning reservation must occupy winMid');
    }

    // 4. Same-day turnover on first visible date (winStart: B1 departs, B3 arrives)
    const corrB3 = `TURNOVER-BND3-${Date.now()}`;
    createdCorrelations.push(corrB3);
    const createB3 = await request('POST', '/api/bookings', {
      property_id: testRoom.property_id,
      guest_name: 'Boundary ArriveAtStart',
      guest_phone: '081299990013',
      booking_source: 'DIRECT',
      reservations: [{
        room_id: testRoom.id,
        room_type_id: testRoom.room_type_id,
        check_in: winStart,
        check_out: winMid,
        total_price: 450000,
        qty: 1
      }]
    }, corrB3);
    expect(createB3.status === 201, `Create B3 failed: ${createB3.status}`);
    const resB3Id = createB3.json.data.reservations[0].id;

    // 5. Same-day turnover on last visible date (winMid: B3 departs, B4 arrives and departs winEnd)
    const corrB4 = `TURNOVER-BND4-${Date.now()}`;
    createdCorrelations.push(corrB4);
    const createB4 = await request('POST', '/api/bookings', {
      property_id: testRoom.property_id,
      guest_name: 'Boundary TurnoverLastDate',
      guest_phone: '081299990014',
      booking_source: 'DIRECT',
      reservations: [{
        room_id: testRoom.id,
        room_type_id: testRoom.room_type_id,
        check_in: winMid,
        check_out: winEnd,
        total_price: 450000,
        qty: 1
      }]
    }, corrB4);
    expect(createB4.status === 201, `Create B4 failed: ${createB4.status}`);
    const resB4Id = createB4.json.data.reservations[0].id;

    // Query tapechart for window [winStart, winEnd) -> dates: [winStart, winMid]
    const tapeBnd = await request('GET', `/api/tapechart?start=${winStart}&end=${winEnd}&property_id=${testRoom.property_id}`);
    expect(tapeBnd.status === 200, `Tapechart boundary query failed: ${tapeBnd.status}`);

    const tapeBndRoom = tapeBnd.json.rooms.find(r => r.id === testRoom.id);
    expect(tapeBndRoom !== undefined, 'Test room missing in tapechart boundary response');

    const cellStart = tapeBndRoom.cells.find(c => c.date === winStart);
    const cellMid = tapeBndRoom.cells.find(c => c.date === winMid);
    expect(cellStart !== undefined && cellMid !== undefined, 'Cells for winStart and winMid must exist');

    // Boundary 1: B1 (checkout == winStart) must be in departures of cellStart, but NOT occupying night winStart in cell.reservations
    expect(cellStart.departures.some(d => d.id === resB1Id), 'B1 must be in cellStart departures');
    expect(!cellStart.reservations.some(r => r.id === resB1Id), 'B1 must NOT occupy cellStart nightly reservations');

    // Boundary 2: B2 (checkin == winEnd) must NOT appear in cellStart or cellMid reservations
    expect(!cellStart.reservations.some(r => r.id === resB2Id), 'B2 must NOT be in cellStart reservations');
    expect(!cellMid.reservations.some(r => r.id === resB2Id), 'B2 must NOT be in cellMid reservations');

    // Boundary 3: Same-day turnover on first visible date (winStart)
    expect(cellStart.departures.some(d => d.id === resB1Id), 'B1 must be in departures on first visible date');
    expect(cellStart.arrivals.some(a => a.id === resB3Id), 'B3 must be in arrivals on first visible date');
    expect(cellStart.reservations.some(r => r.id === resB3Id), 'B3 must occupy night winStart');
    expect(cellStart.turnover !== null && cellStart.turnover.has_turnover === true, 'cellStart must have turnover metadata');

    // Boundary 4: Same-day turnover on last visible date (winMid)
    expect(cellMid.departures.some(d => d.id === resB3Id), 'B3 must be in departures on last visible date');
    expect(cellMid.arrivals.some(a => a.id === resB4Id), 'B4 must be in arrivals on last visible date');
    expect(cellMid.reservations.some(r => r.id === resB4Id), 'B4 must occupy night winMid');
    expect(cellMid.turnover !== null && cellMid.turnover.has_turnover === true, 'cellMid must have turnover metadata');

    console.log('PASS | Scenario 11: Tapechart window boundary and half-open semantics verified (checkout at start, checkin at end, spanning, turnovers on first/last visible dates).');

    console.log('\n=======================================================');
    console.log('ALL 11 TURNOVER-1 INTEGRATION TESTS PASSED SUCCESSFULLY');
    console.log('=======================================================');
  } finally {
    // Teardown all created fixtures
    console.log('Cleaning up test fixtures...');
    for (const corr of createdCorrelations) {
      try {
        await cleanupCorrelation(corr);
      } catch (e) {
        console.error(`Error cleaning up correlation ${corr}:`, e);
      }
    }
    if (testRoom && originalRoomStatus) {
      await pool.query('UPDATE rooms SET status = $1 WHERE id = $2', [originalRoomStatus, testRoom.id]);
    }
    if (testRoom && originalHkSettings !== null) {
      await pool.query('UPDATE property_housekeeping_settings SET require_checkout_room_check = $1 WHERE property_id = $2', [originalHkSettings, testRoom.property_id]);
    }
    if (client) client.release();
    if (server) server.close();
    await pool.end();
  }
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
