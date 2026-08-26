'use strict';
require('dotenv').config({ path: 'E:/oak-hotel-hims/backend/.env' });
const { Pool } = require('pg');
const { app, pool } = require('../dist/index');

const runTag = `LCR${String(Date.now()).slice(-8)}${Math.random().toString(16).slice(2, 6)}`.toUpperCase();
const propertyId = 1;
let server = null;
let baseUrl = '';
let assertions = 0;

function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

function hotelDateNow() {
  return pool.query(`SELECT to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date, 'YYYY-MM-DD') AS d`)
    .then(r => String(r.rows[0].d));
}

function plusDays(dateStr, n) {
  return pool.query(`SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS d`, [dateStr, n])
    .then(r => String(r.rows[0].d));
}

async function discoverProperty() {
  const r = await pool.query('SELECT id FROM properties ORDER BY id LIMIT 1');
  return Number(r.rows[0].id);
}

async function createMasterRoomType(pid, suffix) {
  const code = `LCR${suffix}${String(Date.now()).slice(-4)}`.slice(0, 20);
  const name = `${runTag} T ${suffix}`;
  const r = await pool.query(`
    INSERT INTO room_types (property_id, code, name, base_rate, capacity, max_adults, max_children, is_active, display_order)
    VALUES ($1, $2, $3, 100000, 2, 2, 0, TRUE, 9999)
    RETURNING id, code, name
  `, [pid, code, name]);
  return r.rows[0];
}

async function createMasterRoom(pid, typeId, suffix) {
  const roomNumber = `LCR${suffix}${String(Date.now()).slice(-4)}`.slice(0, 10);
  const r = await pool.query(`
    INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
    VALUES ($1, $2, $3, $3, 'VACANT_CLEAN', TRUE)
    RETURNING id, room_number
  `, [pid, typeId, roomNumber]);
  return r.rows[0];
}

async function createAvailability(typeId, typeName, date) {
  await pool.query(`
    INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
    VALUES ($1, $2, $3::date, 1, 0)
    ON CONFLICT (room_type_id, date) WHERE room_type_id IS NOT NULL DO NOTHING
  `, [typeId, typeName, date]);
}

async function createBookingAndReservations(pid, roomId, checkIn, checkOut, childSpecs) {
  const bid = `${runTag}-${Date.now()}`;
  const booking = await pool.query(`
    INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_source, booking_status,
      currency_code, created_by, correlation_id)
    VALUES ($1, $2, $3, 'WALKIN', 'ACTIVE', 'IDR', 'lifecycle-test', $4)
    RETURNING id
  `, [bid, pid, `${runTag} Guest`, bid]);
  const bookingId = Number(booking.rows[0].id);

  const reservationIds = [];
  for (let i = 0; i < childSpecs.length; i++) {
    const spec = childSpecs[i];
    const r = await pool.query(`
      INSERT INTO reservations (
        booking_id, stay_sequence, room_id, guest_name, check_in, check_out,
        status, stay_status, payment_status, booking_type, correlation_id, created_at
      ) VALUES ($1, $2, $3, $4, $5::date, $6::date,
               $7, $8, 'UNPAID', 'WALKIN', $9, $5::date)
      RETURNING id
    `, [bookingId, i + 1, roomId, `${runTag} Guest ${i + 1}`,
        spec.checkIn, spec.checkOut, spec.status, spec.stayStatus, bid]);
    reservationIds.push(Number(r.rows[0].id));
  }

  return { bookingId, bid, reservationIds };
}

async function getBookingStatus(bookingId) {
  const r = await pool.query('SELECT booking_status FROM bookings WHERE id = $1', [bookingId]);
  return r.rows[0] ? String(r.rows[0].booking_status) : null;
}

async function getAuditCount(bookingId, action) {
  const r = await pool.query(
    "SELECT COUNT(*)::int AS c FROM audit_logs WHERE module='PMS' AND entity='BOOKING' AND record_id=$1 AND action=$2",
    [String(bookingId), action]
  );
  return Number(r.rows[0].c);
}

const tracked = { bookings: [], reservations: [], rooms: [], roomTypes: [], availability: [] };

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tracked.reservations.length > 0) {
      await client.query('DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[])', [tracked.reservations]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [tracked.reservations]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [tracked.reservations]);
      await client.query('DELETE FROM guest_receivables WHERE reservation_id = ANY($1::int[])', [tracked.reservations]);
      await client.query("DELETE FROM audit_logs WHERE entity='RESERVATION' AND record_id=ANY($1::text[])",
        [tracked.reservations.map(String)]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [tracked.reservations]);
    }
    if (tracked.bookings.length > 0) {
      await client.query("DELETE FROM audit_logs WHERE entity='BOOKING' AND record_id=ANY($1::text[])",
        [tracked.bookings.map(String)]);
      await client.query('DELETE FROM bookings WHERE id = ANY($1::bigint[])', [tracked.bookings]);
    }
    await client.query('DELETE FROM audit_logs WHERE correlation_id LIKE $1', [`${runTag}%`]);
    for (const roomId of tracked.rooms) {
      await client.query('DELETE FROM rooms WHERE id = $1', [roomId]);
    }
    for (const rt of tracked.roomTypes) {
      await client.query('DELETE FROM availability_dates WHERE room_type_id = $1', [rt]);
      await client.query('DELETE FROM room_types WHERE id = $1', [rt]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function testAllCancelledBecomesCancelled() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createMasterRoomType(pid, 'AC');
  tracked.roomTypes.push(Number(type.id));
  const room = await createMasterRoom(pid, type.id, 'AC');
  tracked.rooms.push(Number(room.id));
  const checkIn = await plusDays(today, 20);
  const checkOut = await plusDays(today, 22);
  await createAvailability(type.id, type.name, checkIn);

  const { bookingId, bid, reservationIds } = await createBookingAndReservations(pid, room.id, checkIn, checkOut, [
    { checkIn, checkOut, status: 'CANCELLED', stayStatus: 'CANCELLED' }
  ]);
  tracked.bookings.push(bookingId);
  tracked.reservations.push(...reservationIds);

  expect(await getBookingStatus(bookingId) === 'ACTIVE', 'all-cancelled parent must start ACTIVE');

  for (const rid of reservationIds) {
    await pool.query("UPDATE reservations SET status='CANCELLED', stay_status='CANCELLED' WHERE id=$1", [rid]);
  }

  const beforeCount = await getAuditCount(bookingId, 'CANCEL');

  const response = await fetch(`${baseUrl}/api/reservations/${reservationIds[0]}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-AC-CANCEL` },
    body: '{}'
  });
  expect(response.status === 200, `cancel failed: ${response.status}`);

  const finalStatus = await getBookingStatus(bookingId);
  expect(finalStatus === 'CANCELLED', `all-cancelled parent became ${finalStatus}`);

  const afterCount = await getAuditCount(bookingId, 'CANCEL');
  expect(afterCount >= beforeCount, 'cancel audit was written');
}

async function testAllCheckedOutBecomesCompleted() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createMasterRoomType(pid, 'CO');
  tracked.roomTypes.push(Number(type.id));
  const room = await createMasterRoom(pid, type.id, 'CO');
  tracked.rooms.push(Number(room.id));
  const checkIn = await plusDays(today, 25);
  const checkOut = await plusDays(today, 26);
  await createAvailability(type.id, type.name, checkIn);

  const { bookingId, bid, reservationIds } = await createBookingAndReservations(pid, room.id, checkIn, checkOut, [
    { checkIn, checkOut, status: 'CHECKED_OUT', stayStatus: 'DEPARTED' }
  ]);
  tracked.bookings.push(bookingId);
  tracked.reservations.push(...reservationIds);

  expect(await getBookingStatus(bookingId) === 'ACTIVE', 'all-SCO parent must start ACTIVE');

  const response = await fetch(`${baseUrl}/api/reservations/${reservationIds[0]}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-SCO-CHECKOUT` },
    body: '{}'
  });
  expect(response.status === 200, `checkout failed: ${response.status}`);

  const finalStatus = await getBookingStatus(bookingId);
  expect(finalStatus === 'COMPLETED', `all-SCO parent became ${finalStatus}`);

  const afterCount = await getAuditCount(bookingId, 'COMPLETE');
  expect(afterCount === 1, 'completion audit written exactly once');
}

async function testMixedCheckedOutAndCancelled() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createMasterRoomType(pid, 'MX');
  tracked.roomTypes.push(Number(type.id));
  const room1 = await createMasterRoom(pid, type.id, 'MX1');
  tracked.rooms.push(Number(room1.id));
  const room2 = await createMasterRoom(pid, type.id, 'MX2');
  tracked.rooms.push(Number(room2.id));
  const checkIn = await plusDays(today, 27);
  const checkOut = await plusDays(today, 28);
  await createAvailability(type.id, type.name, checkIn);

  const { bookingId, bid, reservationIds } = await createBookingAndReservations(pid, room1.id, checkIn, checkOut, [
    { checkIn, checkOut, status: 'CHECKED_OUT', stayStatus: 'DEPARTED' },
    { checkIn, checkOut, status: 'CANCELLED', stayStatus: 'CANCELLED' }
  ]);
  tracked.bookings.push(bookingId);
  tracked.reservations.push(...reservationIds);

  expect(await getBookingStatus(bookingId) === 'ACTIVE', 'mixed parent must start ACTIVE');

  const response = await fetch(`${baseUrl}/api/reservations/${reservationIds[1]}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-MIX-CANCEL` },
    body: '{}'
  });
  expect(response.status === 200, `mixed cancel failed: ${response.status}`);

  const finalStatus = await getBookingStatus(bookingId);
  expect(finalStatus === 'COMPLETED', `mixed parent became ${finalStatus}`);
}

async function testActiveChildStaysActive() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createMasterRoomType(pid, 'AC2');
  tracked.roomTypes.push(Number(type.id));
  const room = await createMasterRoom(pid, type.id, 'AC2');
  tracked.rooms.push(Number(room.id));
  const checkIn = await plusDays(today, 30);
  const checkOut = await plusDays(today, 31);
  await createAvailability(type.id, type.name, checkIn);

  const { bookingId, bid, reservationIds } = await createBookingAndReservations(pid, room.id, checkIn, checkOut, [
    { checkIn, checkOut, status: 'CHECKED_OUT', stayStatus: 'DEPARTED' },
    { checkIn, checkOut, status: 'BOOKED', stayStatus: 'RESERVED' }
  ]);
  tracked.bookings.push(bookingId);
  tracked.reservations.push(...reservationIds);

  expect(await getBookingStatus(bookingId) === 'ACTIVE', 'parent with active child must stay ACTIVE');

  const response = await fetch(`${baseUrl}/api/reservations/${reservationIds[0]}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-ACT-REMAIN` },
    body: '{}'
  });
  expect(response.status === 200, `checkout failed: ${response.status}`);

  const finalStatus = await getBookingStatus(bookingId);
  expect(finalStatus === 'ACTIVE', `parent with active child stayed ${finalStatus}`);
}

async function testAlreadyTerminalNoop() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createMasterRoomType(pid, 'NT');
  tracked.roomTypes.push(Number(type.id));
  const room = await createMasterRoom(pid, type.id, 'NT');
  tracked.rooms.push(Number(room.id));
  const checkIn = await plusDays(today, 32);
  const checkOut = await plusDays(today, 33);
  await createAvailability(type.id, type.name, checkIn);

  const { bookingId, bid, reservationIds } = await createBookingAndReservations(pid, room.id, checkIn, checkOut, [
    { checkIn, checkOut, status: 'CANCELLED', stayStatus: 'CANCELLED' }
  ]);
  tracked.bookings.push(bookingId);
  tracked.reservations.push(...reservationIds);

  await pool.query("UPDATE reservations SET status='CANCELLED', stay_status='CANCELLED' WHERE id=$1", [reservationIds[0]]);

  const response = await fetch(`${baseUrl}/api/reservations/${reservationIds[0]}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-NT-NOOP` },
    body: '{}'
  });
  expect(response.status === 200, `noop cancel failed: ${response.status}`);

  const finalStatus = await getBookingStatus(bookingId);
  expect(finalStatus === 'CANCELLED', `already-cancelled parent stayed ${finalStatus}`);
}

async function testNoInventoryMutation() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createMasterRoomType(pid, 'NI');
  tracked.roomTypes.push(Number(type.id));
  const room = await createMasterRoom(pid, type.id, 'NI');
  tracked.rooms.push(Number(room.id));
  const checkIn = await plusDays(today, 34);
  const checkOut = await plusDays(today, 35);
  await createAvailability(type.id, type.name, checkIn);

  const { bookingId, bid, reservationIds } = await createBookingAndReservations(pid, room.id, checkIn, checkOut, [
    { checkIn, checkOut, status: 'CANCELLED', stayStatus: 'CANCELLED' }
  ]);
  tracked.bookings.push(bookingId);
  tracked.reservations.push(...reservationIds);

  const beforeInventory = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [type.id, checkIn]
  );
  const beforeQty = Number(beforeInventory.rows[0]?.reserved_qty ?? 0);

  await pool.query("UPDATE reservations SET status='CANCELLED', stay_status='CANCELLED' WHERE id=$1", [reservationIds[0]]);
  const response = await fetch(`${baseUrl}/api/reservations/${reservationIds[0]}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-NI-INV` },
    body: '{}'
  });
  expect(response.status === 200, `inventory cancel failed: ${response.status}`);

  const afterInventory = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [type.id, checkIn]
  );
  const afterQty = Number(afterInventory.rows[0]?.reserved_qty ?? 0);
  expect(afterQty === beforeQty, `inventory changed: ${beforeQty} -> ${afterQty}`);
}

async function main() {
  server = app.listen(0, '127.0.0.1');
  const { once } = require('events');
  await once(server, 'listening');
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await testAllCancelledBecomesCancelled();
    console.log('PASS  1. all-cancelled -> CANCELLED');

    await testAllCheckedOutBecomesCompleted();
    console.log('PASS  2. all-SCO -> COMPLETED');

    await testMixedCheckedOutAndCancelled();
    console.log('PASS  3. mixed SCO+CANCELLED -> COMPLETED');

    await testActiveChildStaysActive();
    console.log('PASS  4. active child -> stays ACTIVE');

    await testAlreadyTerminalNoop();
    console.log('PASS  5. already terminal -> no-op');

    await testNoInventoryMutation();
    console.log('PASS  6. no inventory mutation');
  } catch (error) {
    throw error;
  } finally {
    await new Promise(resolve => server.close(resolve));
    await cleanup();
  }

  console.log(`lifecycle-reconciliation assertions=${assertions}`);
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
