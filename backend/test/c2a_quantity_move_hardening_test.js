'use strict';
const { Pool } = require('pg');
const { app, pool } = require('../dist/index');

const runTag = `QC2A${String(Date.now()).slice(-8)}${Math.random().toString(16).slice(2, 6)}`.toUpperCase();
let server = null;
let baseUrl = '';
let assertions = 0;

function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

async function hotelDateNow() {
  const r = await pool.query(`SELECT to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date, 'YYYY-MM-DD') AS d`);
  return String(r.rows[0].d);
}

async function plusDays(dateStr, n) {
  const r = await pool.query(`SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS d`, [dateStr, n]);
  return String(r.rows[0].d);
}

async function discoverProperty() {
  const r = await pool.query('SELECT id FROM properties ORDER BY id LIMIT 1');
  return Number(r.rows[0].id);
}

async function createType(pid, suffix) {
  const code = `${runTag}${suffix}`.slice(0, 20);
  const name = `${runTag} T ${suffix}`;
  const r = await pool.query(`
    INSERT INTO room_types (property_id, code, name, base_rate, capacity, max_adults, max_children, is_active, display_order)
    VALUES ($1, $2, $3, 100000, 1, 2, 0, TRUE, 9999)
    RETURNING id, code, name
  `, [pid, code, name]);
  return r.rows[0];
}

async function createRoom(pid, typeId, suffix) {
  const roomNumber = `QC2A${suffix}${String(Date.now()).slice(-3)}`.slice(0, 10);
  const r = await pool.query(`
    INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
    VALUES ($1, $2, $3, $3, 'VACANT_CLEAN', TRUE)
    RETURNING id, room_number
  `, [pid, typeId, roomNumber]);
  return r.rows[0];
}

async function ensureAvailability(typeId, typeName, date) {
  await pool.query(`
    INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
    VALUES ($1, $2, $3::date, 1, 0)
    ON CONFLICT (room_type_id, date) WHERE room_type_id IS NOT NULL DO NOTHING
  `, [typeId, typeName, date]);
}

const tracked = { bookings: [], reservations: [], rooms: [], types: [] };

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // discover any API-created reservations referencing our rooms/types
    if (tracked.rooms.length > 0) {
      const apiRes = await client.query(
        'SELECT id FROM reservations WHERE room_id = ANY($1::int[]) FOR UPDATE',
        [tracked.rooms]
      );
      for (const row of apiRes.rows) {
        const rid = Number(row.id);
        if (!tracked.reservations.includes(rid)) tracked.reservations.push(rid);
      }
    }

    // also discover by correlation prefix for any missed bookings
    const corrRes = await client.query(
      'SELECT id, booking_id FROM reservations WHERE correlation_id LIKE $1 FOR UPDATE',
      [`${runTag}%`]
    );
    for (const row of corrRes.rows) {
      const rid = Number(row.id);
      if (!tracked.reservations.includes(rid)) tracked.reservations.push(rid);
      if (row.booking_id !== null) {
        const bid = Number(row.booking_id);
        if (!tracked.bookings.includes(bid)) tracked.bookings.push(bid);
      }
    }
    const corrBookings = await client.query(
      'SELECT id FROM bookings WHERE correlation_id LIKE $1 FOR UPDATE',
      [`${runTag}%`]
    );
    for (const row of corrBookings.rows) {
      const bid = Number(row.id);
      if (!tracked.bookings.includes(bid)) tracked.bookings.push(bid);
    }

    if (tracked.reservations.length > 0) {
      await client.query('DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[])', [tracked.reservations]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [tracked.reservations]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [tracked.reservations]);
      await client.query('DELETE FROM guest_receivables WHERE reservation_id = ANY($1::int[])', [tracked.reservations]);
      await client.query("DELETE FROM audit_logs WHERE entity='RESERVATION' AND record_id=ANY($1::text[])", [tracked.reservations.map(String)]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [tracked.reservations]);
    }
    if (tracked.bookings.length > 0) {
      await client.query("DELETE FROM audit_logs WHERE entity='BOOKING' AND record_id=ANY($1::text[])", [tracked.bookings.map(String)]);
      await client.query('DELETE FROM bookings WHERE id = ANY($1::bigint[])', [tracked.bookings]);
    }
    await client.query('DELETE FROM audit_logs WHERE correlation_id LIKE $1', [`${runTag}%`]);
    if (tracked.rooms.length > 0) {
      await client.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [tracked.rooms]);
    }
    for (const type of tracked.types) {
      await client.query('DELETE FROM availability_dates WHERE room_type_id = $1', [type.id]);
      await client.query('DELETE FROM room_types WHERE id = $1', [type.id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createBookingWithChild(pid, roomId, checkIn, checkOut, overrides = {}) {
  const bid = `${runTag}-${Date.now()}`;
  const booking = await pool.query(`
    INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_source, booking_status,
      currency_code, created_by, correlation_id)
    VALUES ($1, $2, $3, 'WALKIN', 'ACTIVE', 'IDR', 'c2a-test', $4)
    RETURNING id
  `, [bid, pid, `${runTag} Guest`, bid]);
  const bookingId = Number(booking.rows[0].id);
  tracked.bookings.push(bookingId);

  const r = await pool.query(`
    INSERT INTO reservations (
      booking_id, stay_sequence, room_id, guest_name, check_in, check_out,
      status, stay_status, payment_status, booking_type, correlation_id, created_at
    ) VALUES ($1, 1, $2, $3, $4::date, $5::date, 'BOOKED', 'RESERVED', 'UNPAID', 'WALKIN', $6, $4::date)
    RETURNING id
  `, [bookingId, roomId, `${runTag} Guest`, checkIn, checkOut, bid]);
  const reservationId = Number(r.rows[0].id);
  tracked.reservations.push(reservationId);

  // increment inventory for the booked dates
  const dates = await pool.query(`
    SELECT to_char(day::date, 'YYYY-MM-DD') AS d
    FROM generate_series($1::date, $2::date - 1, INTERVAL '1 day') AS day
  `, [checkIn, checkOut]);
  for (const row of dates.rows) {
    await pool.query(
      'UPDATE availability_dates SET reserved_qty = reserved_qty + 1 WHERE room_type_id = $1 AND date = $2::date',
      [overrides.roomTypeId || null, row.d]
    );
  }

  return { bookingId, reservationId, bid };
}

// ============================================================
// QUANTITY TESTS
// ============================================================

async function testQuantityOmittedSucceeds() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createType(pid, 'QA');
  tracked.types.push({ id: Number(type.id) });
  const room = await createRoom(pid, type.id, 'QA');
  tracked.rooms.push(Number(room.id));
  const checkIn = await plusDays(today, 50);
  const checkOut = await plusDays(today, 51);
  await ensureAvailability(type.id, type.name, checkIn);

  const response = await fetch(`${baseUrl}/api/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-QA-OMIT` },
    body: JSON.stringify({
      property_id: pid,
      guest_name: `${runTag} Guest QA`,
      guest_phone: '081200000000',
      booking_source: 'WALKIN',
      reservations: [{
        room_id: Number(room.id),
        check_in: checkIn,
        check_out: checkOut,
        total_price: 100000
        // no qty field
      }]
    })
  });
  expect(response.status === 201, `omitted qty: status=${response.status}`);
  const json = await response.json();
  expect(json?.data?.reservations?.[0]?.id, 'omitted qty: no reservation id');
}

async function testQuantityOneSucceeds() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createType(pid, 'QB');
  tracked.types.push({ id: Number(type.id) });
  const room = await createRoom(pid, type.id, 'QB');
  tracked.rooms.push(Number(room.id));
  const checkIn = await plusDays(today, 52);
  const checkOut = await plusDays(today, 53);
  await ensureAvailability(type.id, type.name, checkIn);

  const response = await fetch(`${baseUrl}/api/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-QB-ONE` },
    body: JSON.stringify({
      property_id: pid,
      guest_name: `${runTag} Guest QB`,
      guest_phone: '081200000000',
      booking_source: 'WALKIN',
      reservations: [{
        room_id: Number(room.id),
        check_in: checkIn,
        check_out: checkOut,
        total_price: 100000,
        qty: 1
      }]
    })
  });
  expect(response.status === 201, `qty=1: status=${response.status}`);
}

async function testQuantityTwoRejected() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createType(pid, 'QC');
  tracked.types.push({ id: Number(type.id) });
  const room = await createRoom(pid, type.id, 'QC');
  tracked.rooms.push(Number(room.id));
  const checkIn = await plusDays(today, 54);
  const checkOut = await plusDays(today, 55);
  await ensureAvailability(type.id, type.name, checkIn);

  const response = await fetch(`${baseUrl}/api/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-QC-TWO` },
    body: JSON.stringify({
      property_id: pid,
      guest_name: `${runTag} Guest QC`,
      guest_phone: '081200000000',
      booking_source: 'WALKIN',
      reservations: [{
        room_id: Number(room.id),
        check_in: checkIn,
        check_out: checkOut,
        total_price: 100000,
        qty: 2
      }]
    })
  });
  expect(response.status === 400, `qty=2: expected 400, got ${response.status}`);
  const json = await response.json();
  expect(json?.message?.includes('kamar fisik') || json?.code === 'RESERVATION_QUANTITY_UNSUPPORTED',
    `qty=2: wrong response=${JSON.stringify(json)}`);

  // verify no residue
  const residue = await pool.query(
    'SELECT COUNT(*)::int AS c FROM reservations WHERE correlation_id LIKE $1',
    [`${runTag}-QC-TWO%`]
  );
  expect(Number(residue.rows[0].c) === 0, `qty=2: reservation residue=${residue.rows[0].c}`);
}

async function testQuantityTenRejected() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createType(pid, 'QD');
  tracked.types.push({ id: Number(type.id) });
  const room = await createRoom(pid, type.id, 'QD');
  tracked.rooms.push(Number(room.id));
  const checkIn = await plusDays(today, 56);
  const checkOut = await plusDays(today, 57);
  await ensureAvailability(type.id, type.name, checkIn);

  const response = await fetch(`${baseUrl}/api/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-QD-TEN` },
    body: JSON.stringify({
      property_id: pid,
      guest_name: `${runTag} Guest QD`,
      guest_phone: '081200000000',
      booking_source: 'WALKIN',
      reservations: [{
        room_id: Number(room.id),
        check_in: checkIn,
        check_out: checkOut,
        total_price: 100000,
        qty: 10
      }]
    })
  });
  expect(response.status === 400, `qty=10: expected 400, got ${response.status}`);
}

async function testMultiRoomTwoChildrenAllowed() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type1 = await createType(pid, 'QE1');
  tracked.types.push({ id: Number(type1.id) });
  const type2 = await createType(pid, 'QE2');
  tracked.types.push({ id: Number(type2.id) });
  const room1 = await createRoom(pid, type1.id, 'QE1');
  tracked.rooms.push(Number(room1.id));
  const room2 = await createRoom(pid, type2.id, 'QE2');
  tracked.rooms.push(Number(room2.id));
  const checkIn = await plusDays(today, 58);
  const checkOut = await plusDays(today, 59);
  await ensureAvailability(type1.id, type1.name, checkIn);
  await ensureAvailability(type2.id, type2.name, checkIn);

  const response = await fetch(`${baseUrl}/api/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-QE-MULTI` },
    body: JSON.stringify({
      property_id: pid,
      guest_name: `${runTag} Guest QE`,
      guest_phone: '081200000000',
      booking_source: 'WALKIN',
      reservations: [
        { room_id: Number(room1.id), check_in: checkIn, check_out: checkOut, total_price: 100000, qty: 1 },
        { room_id: Number(room2.id), check_in: checkIn, check_out: checkOut, total_price: 100000, qty: 1 }
      ]
    })
  });
  expect(response.status === 201, `multi-room: status=${response.status}`);
  const json = await response.json();
  expect(json?.data?.reservations?.length === 2, 'multi-room: expected 2 reservations');
}

async function testQuantityRejectionLeavesNoResidue() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createType(pid, 'QF');
  tracked.types.push({ id: Number(type.id) });
  const room = await createRoom(pid, type.id, 'QF');
  tracked.rooms.push(Number(room.id));
  const checkIn = await plusDays(today, 60);
  const checkOut = await plusDays(today, 61);
  await ensureAvailability(type.id, type.name, checkIn);

  const beforeInv = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [type.id, checkIn]
  );
  const beforeQty = Number(beforeInv.rows[0]?.reserved_qty ?? 0);

  const response = await fetch(`${baseUrl}/api/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-QF-RES` },
    body: JSON.stringify({
      property_id: pid,
      guest_name: `${runTag} Guest QF`,
      guest_phone: '081200000000',
      booking_source: 'WALKIN',
      reservations: [{
        room_id: Number(room.id),
        check_in: checkIn,
        check_out: checkOut,
        total_price: 100000,
        qty: 5
      }]
    })
  });
  expect(response.status === 400, `residue: expected 400, got ${response.status}`);

  const afterInv = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [type.id, checkIn]
  );
  const afterQty = Number(afterInv.rows[0]?.reserved_qty ?? 0);
  expect(afterQty === beforeQty, `residue: inventory changed ${beforeQty} -> ${afterQty}`);

  const residueBookings = await pool.query(
    'SELECT COUNT(*)::int AS c FROM bookings WHERE correlation_id LIKE $1',
    [`${runTag}-QF-RES%`]
  );
  expect(Number(residueBookings.rows[0].c) === 0, `residue: booking residue=${residueBookings.rows[0].c}`);
}

// ============================================================
// MOVE HARDENING TESTS
// ============================================================

async function testValidMoveReleasesSourceExactly1() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const typeA = await createType(pid, 'MA');
  tracked.types.push({ id: Number(typeA.id) });
  const typeB = await createType(pid, 'MB');
  tracked.types.push({ id: Number(typeB.id) });
  const roomA = await createRoom(pid, typeA.id, 'MA');
  tracked.rooms.push(Number(roomA.id));
  const roomB = await createRoom(pid, typeB.id, 'MB');
  tracked.rooms.push(Number(roomB.id));
  const checkIn = await plusDays(today, 62);
  const checkOut = await plusDays(today, 64);
  await ensureAvailability(typeA.id, typeA.name, checkIn);
  await ensureAvailability(typeA.id, typeA.name, await plusDays(today, 63));
  await ensureAvailability(typeB.id, typeB.name, checkIn);
  await ensureAvailability(typeB.id, typeB.name, await plusDays(today, 63));

  const { reservationId } = await createBookingWithChild(pid, roomA.id, checkIn, checkOut, { roomTypeId: typeA.id });

  const beforeA = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [typeA.id, checkIn]
  );
  const beforeSrc = Number(beforeA.rows[0]?.reserved_qty ?? 0);
  expect(beforeSrc >= 1, 'move: source must have reserved_qty >= 1');

  const response = await fetch(`${baseUrl}/api/reservations/${reservationId}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-MA-VALID` },
    body: JSON.stringify({ to_room_id: Number(roomB.id), property_id: pid })
  });
  expect(response.status === 200, `move: status=${response.status}`);

  const afterA = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [typeA.id, checkIn]
  );
  const afterSrc = Number(afterA.rows[0]?.reserved_qty ?? 0);
  expect(afterSrc === beforeSrc - 1, `move: source ${beforeSrc} -> ${afterSrc}, expected ${beforeSrc - 1}`);
}

async function testMoveSourceZeroReservedQtyFails() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const typeA = await createType(pid, 'MC');
  tracked.types.push({ id: Number(typeA.id) });
  const typeB = await createType(pid, 'MD');
  tracked.types.push({ id: Number(typeB.id) });
  const roomA = await createRoom(pid, typeA.id, 'MC');
  tracked.rooms.push(Number(roomA.id));
  const roomB = await createRoom(pid, typeB.id, 'MD');
  tracked.rooms.push(Number(roomB.id));
  const checkIn = await plusDays(today, 65);
  const checkOut = await plusDays(today, 66);
  await ensureAvailability(typeA.id, typeA.name, checkIn);
  await ensureAvailability(typeB.id, typeB.name, checkIn);

  const { reservationId } = await createBookingWithChild(pid, roomA.id, checkIn, checkOut, { roomTypeId: typeA.id });

  // zero out source inventory
  await pool.query(
    'UPDATE availability_dates SET reserved_qty = 0 WHERE room_type_id = $1 AND date = $2::date',
    [typeA.id, checkIn]
  );

  const beforeSrc = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [typeA.id, checkIn]
  );
  expect(Number(beforeSrc.rows[0]?.reserved_qty) === 0, 'move-zero: source must be 0');

  const response = await fetch(`${baseUrl}/api/reservations/${reservationId}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-MC-ZERO` },
    body: JSON.stringify({ to_room_id: Number(roomB.id), property_id: pid })
  });
  expect(response.status === 400, `move-zero: expected 400, got ${response.status}`);

  // reservation room_id must not have changed
  const afterRes = await pool.query('SELECT room_id FROM reservations WHERE id = $1', [reservationId]);
  expect(Number(afterRes.rows[0].room_id) === Number(roomA.id), 'move-zero: reservation room changed');

  // source inventory must not have gone negative
  const afterSrc = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [typeA.id, checkIn]
  );
  expect(Number(afterSrc.rows[0]?.reserved_qty) === 0, 'move-zero: source inventory changed');
}

async function testMoveNoNegativeInventory() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const typeA = await createType(pid, 'ME');
  tracked.types.push({ id: Number(typeA.id) });
  const typeB = await createType(pid, 'MF');
  tracked.types.push({ id: Number(typeB.id) });
  const roomA = await createRoom(pid, typeA.id, 'ME');
  tracked.rooms.push(Number(roomA.id));
  const roomB = await createRoom(pid, typeB.id, 'MF');
  tracked.rooms.push(Number(roomB.id));
  const checkIn = await plusDays(today, 67);
  const checkOut = await plusDays(today, 68);
  await ensureAvailability(typeA.id, typeA.name, checkIn);
  await ensureAvailability(typeB.id, typeB.name, checkIn);

  const { reservationId } = await createBookingWithChild(pid, roomA.id, checkIn, checkOut, { roomTypeId: typeA.id });

  // zero source
  await pool.query(
    'UPDATE availability_dates SET reserved_qty = 0 WHERE room_type_id = $1 AND date = $2::date',
    [typeA.id, checkIn]
  );

  const response = await fetch(`${baseUrl}/api/reservations/${reservationId}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-ME-NEG` },
    body: JSON.stringify({ to_room_id: Number(roomB.id), property_id: pid })
  });
  expect(response.status === 400, `move-neg: expected 400, got ${response.status}`);

  const afterSrc = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [typeA.id, checkIn]
  );
  expect(Number(afterSrc.rows[0]?.reserved_qty) >= 0, `move-neg: source=${afterSrc.rows[0]?.reserved_qty}`);
}

async function testMoveTargetInventoryUnchangedOnFailure() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const typeA = await createType(pid, 'MG');
  tracked.types.push({ id: Number(typeA.id) });
  const typeB = await createType(pid, 'MH');
  tracked.types.push({ id: Number(typeB.id) });
  const roomA = await createRoom(pid, typeA.id, 'MG');
  tracked.rooms.push(Number(roomA.id));
  const roomB = await createRoom(pid, typeB.id, 'MH');
  tracked.rooms.push(Number(roomB.id));
  const checkIn = await plusDays(today, 69);
  const checkOut = await plusDays(today, 70);
  await ensureAvailability(typeA.id, typeA.name, checkIn);
  await ensureAvailability(typeB.id, typeB.name, checkIn);

  const { reservationId } = await createBookingWithChild(pid, roomA.id, checkIn, checkOut, { roomTypeId: typeA.id });

  const beforeTarget = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [typeB.id, checkIn]
  );
  const beforeTargetQty = Number(beforeTarget.rows[0]?.reserved_qty ?? 0);

  // zero source to force failure
  await pool.query(
    'UPDATE availability_dates SET reserved_qty = 0 WHERE room_type_id = $1 AND date = $2::date',
    [typeA.id, checkIn]
  );

  const response = await fetch(`${baseUrl}/api/reservations/${reservationId}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-MH-TGT` },
    body: JSON.stringify({ to_room_id: Number(roomB.id), property_id: pid })
  });
  expect(response.status === 400, `move-tgt: expected 400, got ${response.status}`);

  const afterTarget = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [typeB.id, checkIn]
  );
  const afterTargetQty = Number(afterTarget.rows[0]?.reserved_qty ?? 0);
  expect(afterTargetQty === beforeTargetQty, `move-tgt: target ${beforeTargetQty} -> ${afterTargetQty}`);
}

// ============================================================
// MAIN
// ============================================================

const { once } = require('events');

async function main() {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await testQuantityOmittedSucceeds();
    console.log('PASS  A. omitted quantity -> succeeds as 1');

    await testQuantityOneSucceeds();
    console.log('PASS  B. quantity=1 -> succeeds');

    await testQuantityTwoRejected();
    console.log('PASS  C. quantity=2 -> rejected');

    await testQuantityTenRejected();
    console.log('PASS  D. quantity=10 -> rejected');

    await testMultiRoomTwoChildrenAllowed();
    console.log('PASS  E. multi-room two children qty=1 -> allowed');

    await testQuantityRejectionLeavesNoResidue();
    console.log('PASS  F. failed quantity leaves no residue');

    await testValidMoveReleasesSourceExactly1();
    console.log('PASS  G. valid move releases source by exactly 1');

    await testMoveSourceZeroReservedQtyFails();
    console.log('PASS  H. source reserved_qty=0 -> move fails');

    await testMoveNoNegativeInventory();
    console.log('PASS  I. no negative/clamped inventory possible');

    await testMoveTargetInventoryUnchangedOnFailure();
    console.log('PASS  J. failed move leaves target unchanged');

  } catch (error) {
    throw error;
  } finally {
    await new Promise(resolve => server.close(resolve));
    await cleanup();
  }

  console.log(`c2a-hardening assertions=${assertions}`);
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
