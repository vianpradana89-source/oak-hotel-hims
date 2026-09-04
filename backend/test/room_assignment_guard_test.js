'use strict';

require('dotenv').config({ path: 'E:/oak-hotel-hims/backend/.env' });
const http = require('http');
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
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body && method !== 'GET') {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(baseUrl + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function runTests() {
  console.log('=== RUNNING ROOM_ASSIGNMENT_GUARD TESTS ===\n');

  await initializeDatabase(pool);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const cleanup = { transactions: [], folioEntries: [], reservations: [], bookings: [], rooms: [], roomTypes: [], properties: [] };

  try {
    // Create test property
    const propRes = await pool.query(
      `INSERT INTO properties (property_code, name, address, is_active)
       VALUES ($1, $2, 'Guard Test Address', true) RETURNING id`,
      [`GRD${String(Date.now()).slice(-3)}`, `Guard Test Property ${Date.now()}`]
    );
    const propertyId = Number(propRes.rows[0].id);
    cleanup.properties.push(propertyId);

    // Create room type
    const rtRes = await pool.query(
      `INSERT INTO room_types (property_id, name, code, base_rate, capacity)
       VALUES ($1, $2, $3, 500000, 2) RETURNING id`,
      [propertyId, 'Guard Test Type', `GTT-${Date.now()}`]
    );
    const roomTypeId = Number(rtRes.rows[0].id);
    cleanup.roomTypes.push(roomTypeId);

    // Create room
    const roomRes = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, status)
       VALUES ($1, $2, $3, 'VACANT_CLEAN') RETURNING id`,
      [propertyId, roomTypeId, `9${String(Date.now()).slice(-3)}`]
    );
    const roomId = Number(roomRes.rows[0].id);
    cleanup.rooms.push(roomId);

    // Seed availability for the room type
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, $3, 1, 0)
         ON CONFLICT DO NOTHING`,
        [roomTypeId, 'Guard Test Type', dateStr]
      );
    }

    // ─── TEST A: Check-in with room_id=NULL returns ROOM_NOT_ASSIGNED ───
    console.log('\nTest A: Check-in with room_id=NULL returns ROOM_NOT_ASSIGNED');

    // Create a booking with a room
    const bResA = await pool.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [`BID-GUARD-A-${Date.now()}`, propertyId, 'Guard Test Guest A']
    );
    const bookingIdA = Number(bResA.rows[0].id);
    cleanup.bookings.push(bookingIdA);

    const checkInA = new Date(today);
    checkInA.setDate(checkInA.getDate() + 1);
    const checkOutA = new Date(today);
    checkOutA.setDate(checkOutA.getDate() + 3);
    const ciStr = checkInA.toISOString().slice(0, 10);
    const coStr = checkOutA.toISOString().slice(0, 10);

    // Create reservation WITH room_id (normal)
    const rResA = await pool.query(
      `INSERT INTO reservations (booking_id, booking_number, stay_sequence, guest_name,
         room_id, booked_room_type_id_snapshot, check_in, check_out, stay_type,
         total_price, payment_status, status, stay_status)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'OVERNIGHT', 1000000, 'UNPAID', 'BOOKED', 'RESERVED')
       RETURNING id`,
      [bookingIdA, `RES-GUARD-A-${Date.now()}`, 'Guard Guest A', roomId, roomTypeId, ciStr, coStr]
    );
    const resIdA = Number(rResA.rows[0].id);
    cleanup.reservations.push(resIdA);

    // Now manually null out room_id to simulate the defect
    await pool.query('UPDATE reservations SET room_id = NULL WHERE id = $1', [resIdA]);

    const checkinResA = await api('POST', `/api/reservations/${resIdA}/checkin`, { property_id: propertyId });
    expect(checkinResA.status === 409, 'Check-in with room_id=NULL returns 409');
    expect(checkinResA.json?.code === 'ROOM_NOT_ASSIGNED', 'Check-in returns ROOM_NOT_ASSIGNED code');
    expect(checkinResA.json?.message.includes('Kamar belum ditentukan'), 'Check-in returns Indonesian message');

    // Restore room_id for cleanup
    await pool.query('UPDATE reservations SET room_id = $1 WHERE id = $2', [roomId, resIdA]);

    // ─── TEST B: Checkout with room_id=NULL returns ROOM_NOT_ASSIGNED ───
    console.log('\nTest B: Checkout with room_id=NULL returns ROOM_NOT_ASSIGNED');

    // Create a booking with room, check it in, then null room_id
    const bResB = await pool.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [`BID-GUARD-B-${Date.now()}`, propertyId, 'Guard Test Guest B']
    );
    const bookingIdB = Number(bResB.rows[0].id);
    cleanup.bookings.push(bookingIdB);

    const checkInB = new Date(today);
    checkInB.setDate(checkInB.getDate() + 1);
    const checkOutB = new Date(today);
    checkOutB.setDate(checkOutB.getDate() + 3);
    const ciStrB = checkInB.toISOString().slice(0, 10);
    const coStrB = checkOutB.toISOString().slice(0, 10);

    // Create room type 2 for second test
    const rtRes2 = await pool.query(
      `INSERT INTO room_types (property_id, name, code, base_rate, capacity)
       VALUES ($1, $2, $3, 500000, 2) RETURNING id`,
      [propertyId, 'Guard Test Type 2', `GTT2-${Date.now()}`]
    );
    const roomTypeId2 = Number(rtRes2.rows[0].id);
    cleanup.roomTypes.push(roomTypeId2);

    const roomRes2 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, status)
       VALUES ($1, $2, $3, 'VACANT_CLEAN') RETURNING id`,
      [propertyId, roomTypeId2, `8${String(Date.now()).slice(-3)}`]
    );
    const roomId2 = Number(roomRes2.rows[0].id);
    cleanup.rooms.push(roomId2);

    // Seed availability for room type 2
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, $3, 1, 0)
         ON CONFLICT DO NOTHING`,
        [roomTypeId2, 'Guard Test Type 2', dateStr]
      );
    }

    const rResB = await pool.query(
      `INSERT INTO reservations (booking_id, booking_number, stay_sequence, guest_name,
         room_id, booked_room_type_id_snapshot, check_in, check_out, stay_type,
         total_price, payment_status, status, stay_status, checked_in_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'OVERNIGHT', 1000000, 'UNPAID', 'CHECKED_IN', 'IN_HOUSE', NOW())
       RETURNING id`,
      [bookingIdB, `RES-GUARD-B-${Date.now()}`, 'Guard Guest B', roomId2, roomTypeId2, ciStrB, coStrB]
    );
    const resIdB = Number(rResB.rows[0].id);
    cleanup.reservations.push(resIdB);

    // Null out room_id to simulate defect
    await pool.query('UPDATE reservations SET room_id = NULL WHERE id = $1', [resIdB]);

    const checkoutResB = await api('POST', `/api/reservations/${resIdB}/checkout`, { property_id: propertyId });
    expect(checkoutResB.status === 409, 'Checkout with room_id=NULL returns 409');
    expect(checkoutResB.json?.code === 'ROOM_NOT_ASSIGNED', 'Checkout returns ROOM_NOT_ASSIGNED code');
    expect(checkoutResB.json?.message.includes('Kamar belum ditentukan'), 'Checkout returns Indonesian message');

    // Restore room_id for cleanup
    await pool.query('UPDATE reservations SET room_id = $1 WHERE id = $2', [roomId2, resIdB]);

    // ─── TEST C: Checkout with booked_room_type_id_snapshot=NULL returns ROOM_TYPE_SNAPSHOT_MISSING ───
    console.log('\nTest C: Checkout with booked_room_type_id_snapshot=NULL returns ROOM_TYPE_SNAPSHOT_MISSING');

    const bResC = await pool.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [`BID-GUARD-C-${Date.now()}`, propertyId, 'Guard Test Guest C']
    );
    const bookingIdC = Number(bResC.rows[0].id);
    cleanup.bookings.push(bookingIdC);

    const checkInC = new Date(today);
    checkInC.setDate(checkInC.getDate() + 1);
    const checkOutC = new Date(today);
    checkOutC.setDate(checkOutC.getDate() + 3);
    const ciStrC = checkInC.toISOString().slice(0, 10);
    const coStrC = checkOutC.toISOString().slice(0, 10);

    // Create room type 3
    const rtRes3 = await pool.query(
      `INSERT INTO room_types (property_id, name, code, base_rate, capacity)
       VALUES ($1, $2, $3, 500000, 2) RETURNING id`,
      [propertyId, 'Guard Test Type 3', `GTT3-${Date.now()}`]
    );
    const roomTypeId3 = Number(rtRes3.rows[0].id);
    cleanup.roomTypes.push(roomTypeId3);

    const roomRes3 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, status)
       VALUES ($1, $2, $3, 'VACANT_CLEAN') RETURNING id`,
      [propertyId, roomTypeId3, `7${String(Date.now()).slice(-3)}`]
    );
    const roomId3 = Number(roomRes3.rows[0].id);
    cleanup.rooms.push(roomId3);

    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, $3, 1, 0)
         ON CONFLICT DO NOTHING`,
        [roomTypeId3, 'Guard Test Type 3', dateStr]
      );
    }

    const rResC = await pool.query(
      `INSERT INTO reservations (booking_id, booking_number, stay_sequence, guest_name,
         room_id, booked_room_type_id_snapshot, check_in, check_out, stay_type,
         total_price, payment_status, status, stay_status, checked_in_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'OVERNIGHT', 1000000, 'UNPAID', 'CHECKED_IN', 'IN_HOUSE', NOW())
       RETURNING id`,
      [bookingIdC, `RES-GUARD-C-${Date.now()}`, 'Guard Guest C', roomId3, roomTypeId3, ciStrC, coStrC]
    );
    const resIdC = Number(rResC.rows[0].id);
    cleanup.reservations.push(resIdC);

    // Null out booked_room_type_id_snapshot
    await pool.query('UPDATE reservations SET booked_room_type_id_snapshot = NULL WHERE id = $1', [resIdC]);

    const checkoutResC = await api('POST', `/api/reservations/${resIdC}/checkout`, { property_id: propertyId });
    expect(checkoutResC.status === 409, 'Checkout with booked_room_type_id_snapshot=NULL returns 409');
    expect(checkoutResC.json?.code === 'ROOM_TYPE_SNAPSHOT_MISSING', 'Checkout returns ROOM_TYPE_SNAPSHOT_MISSING code');
    expect(checkoutResC.json?.message.includes('tipe kamar'), 'Checkout mentions tipe kamar in message');

    // Restore for cleanup
    await pool.query('UPDATE reservations SET booked_room_type_id_snapshot = $1 WHERE id = $2', [roomTypeId3, resIdC]);

    // ─── TEST D: Normal check-in/checkout still works ───
    console.log('\nTest D: Normal check-in/checkout flow unchanged');

    const bResD = await pool.query(
      `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [`BID-GUARD-D-${Date.now()}`, propertyId, 'Guard Test Guest D']
    );
    const bookingIdD = Number(bResD.rows[0].id);
    cleanup.bookings.push(bookingIdD);

    const checkInD = new Date(today);
    checkInD.setDate(checkInD.getDate() + 1);
    const checkOutD = new Date(today);
    checkOutD.setDate(checkOutD.getDate() + 3);
    const ciStrD = checkInD.toISOString().slice(0, 10);
    const coStrD = checkOutD.toISOString().slice(0, 10);

    // Create room type 4
    const rtRes4 = await pool.query(
      `INSERT INTO room_types (property_id, name, code, base_rate, capacity)
       VALUES ($1, $2, $3, 500000, 2) RETURNING id`,
      [propertyId, 'Guard Test Type 4', `GTT4-${Date.now()}`]
    );
    const roomTypeId4 = Number(rtRes4.rows[0].id);
    cleanup.roomTypes.push(roomTypeId4);

    const roomRes4 = await pool.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, status)
       VALUES ($1, $2, $3, 'VACANT_CLEAN') RETURNING id`,
      [propertyId, roomTypeId4, `6${String(Date.now()).slice(-3)}`]
    );
    const roomId4 = Number(roomRes4.rows[0].id);
    cleanup.rooms.push(roomId4);

    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, $3, 1, 0)
         ON CONFLICT DO NOTHING`,
        [roomTypeId4, 'Guard Test Type 4', dateStr]
      );
    }

    const rResD = await pool.query(
      `INSERT INTO reservations (booking_id, booking_number, stay_sequence, guest_name,
         room_id, booked_room_type_id_snapshot, check_in, check_out, stay_type,
         total_price, payment_status, status, stay_status)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'OVERNIGHT', 1000000, 'UNPAID', 'BOOKED', 'RESERVED')
       RETURNING id`,
      [bookingIdD, `RES-GUARD-D-${Date.now()}`, 'Guard Guest D', roomId4, roomTypeId4, ciStrD, coStrD]
    );
    const resIdD = Number(rResD.rows[0].id);
    cleanup.reservations.push(resIdD);

    // Check-in should succeed — proves guard does not break normal flow
    const checkinResD = await api('POST', `/api/reservations/${resIdD}/checkin`, { property_id: propertyId, override_guest_identity: true, override_housekeeping: true });
    expect(checkinResD.status === 200, 'Normal check-in succeeds');
    expect(checkinResD.json?.status === 'SUCCESS', 'Normal check-in returns SUCCESS');

    // Checkout requires full canonical availability ledger; not tested here.
    // The guard tests above (A, B, C) already validate rejection behavior.

    // ─── SUMMARY ───
    console.log('\n==================================================');
    if (failed === 0) {
      console.log(`ALL ${passed} ROOM ASSIGNMENT GUARD TESTS PASSED!`);
    } else {
      console.log(`${passed} PASSED, ${failed} FAILED`);
    }
    console.log('==================================================\n');

  } finally {
    console.log('Cleaning up guard test fixtures...');
    for (const txId of cleanup.transactions) {
      await pool.query('DELETE FROM transactions WHERE id = $1', [txId]).catch(() => {});
    }
    for (const feId of cleanup.folioEntries) {
      await pool.query('DELETE FROM folio_entries WHERE id = $1', [feId]).catch(() => {});
    }
    for (const resId of cleanup.reservations) {
      await pool.query('DELETE FROM reservations WHERE id = $1', [resId]).catch(() => {});
    }
    for (const bId of cleanup.bookings) {
      await pool.query('DELETE FROM bookings WHERE id = $1', [bId]).catch(() => {});
    }
    for (const roomId of cleanup.rooms) {
      await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]).catch(() => {});
    }
    for (const rtId of cleanup.roomTypes) {
      await pool.query('DELETE FROM room_types WHERE id = $1', [rtId]).catch(() => {});
    }
    if (cleanup.properties.length > 0) {
      await pool.query('DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = ANY($1))', [cleanup.properties]);
      await pool.query('DELETE FROM reservation_guests WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = ANY($1)))', [cleanup.properties]).catch(() => {});
      await pool.query('DELETE FROM transaction_attachments WHERE property_id = ANY($1)', [cleanup.properties]);
      await pool.query('DELETE FROM transactions WHERE property_id = ANY($1)', [cleanup.properties]);
      await pool.query('DELETE FROM transaction_daily_sequences WHERE property_id = ANY($1)', [cleanup.properties]);
      await pool.query('DELETE FROM audit_logs WHERE property_id = ANY($1)', [cleanup.properties]);
      await pool.query('DELETE FROM property_features WHERE property_id = ANY($1)', [cleanup.properties]);
      await pool.query('DELETE FROM property_brandings WHERE property_id = ANY($1)', [cleanup.properties]);
      await pool.query('DELETE FROM property_pricing_settings WHERE property_id = ANY($1)', [cleanup.properties]);
      await pool.query('DELETE FROM property_housekeeping_settings WHERE property_id = ANY($1)', [cleanup.properties]);
      await pool.query('DELETE FROM property_attendance_settings WHERE property_id = ANY($1)', [cleanup.properties]);
      await pool.query('DELETE FROM property_quick_booking_rules WHERE property_id = ANY($1)', [cleanup.properties]);
      await pool.query('DELETE FROM property_day_use_durations WHERE property_id = ANY($1)', [cleanup.properties]);
      await pool.query('DELETE FROM rate_plans WHERE property_id = ANY($1)', [cleanup.properties]);
      await pool.query('DELETE FROM meal_plans WHERE property_id = ANY($1)', [cleanup.properties]);
      await pool.query('DELETE FROM room_types WHERE property_id = ANY($1)', [cleanup.properties]).catch(() => {});
      await pool.query('DELETE FROM properties WHERE id = ANY($1)', [cleanup.properties]);
    }
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test Suite Failed:', err.message);
  process.exit(1);
});
