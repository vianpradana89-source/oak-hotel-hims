'use strict';
require('dotenv').config({ path: 'E:/oak-hotel-hims/backend/.env' });
const { Pool } = require('pg');
const { app, pool } = require('../dist/index');
const { once } = require('events');

const runTag = `C2B${String(Date.now()).slice(-8)}${Math.random().toString(16).slice(2, 6)}`.toUpperCase();
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

const tracked = { bookings: [], reservations: [], rooms: [], types: [] };

async function createType(pid, suffix) {
  const code = `${runTag}${suffix}`.slice(0, 20);
  const name = `${runTag} T ${suffix}`;
  const r = await pool.query(`
    INSERT INTO room_types (property_id, code, name, base_rate, capacity, max_adults, max_children, is_active, display_order)
    VALUES ($1, $2, $3, 100000, 10, 2, 0, TRUE, 9999)
    RETURNING id, code, name
  `, [pid, code, name]);
  return r.rows[0];
}

async function createRoom(pid, typeId, suffix) {
  const rand = Math.random().toString(16).slice(2, 6).toUpperCase();
  const roomNumber = `${runTag}${suffix}${rand}`.slice(0, 20);
  const r = await pool.query(`
    INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
    VALUES ($1, $2, $3, $3, 'VACANT_CLEAN', TRUE)
    RETURNING id, room_number
  `, [pid, typeId, roomNumber]);
  tracked.rooms.push(Number(r.rows[0].id));
  return r.rows[0];
}

async function ensureAvailability(typeId, typeName, date) {
  await pool.query(`
    INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
    VALUES ($1, $2, $3::date, 10, 0)
    ON CONFLICT (room_type_id, date) WHERE room_type_id IS NOT NULL DO NOTHING
  `, [typeId, typeName, date]);
}

async function createBookingDirect(pid, roomId, checkIn, checkOut, tag) {
  const bid = `${runTag}-${tag}-${Date.now()}`;
  const r = await pool.query(`
    INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_source, booking_status,
      currency_code, created_by, correlation_id)
    VALUES ($1, $2, $3, 'WALKIN', 'ACTIVE', 'IDR', 'c2b-test', $4)
    RETURNING id
  `, [bid, pid, `${runTag} Guest ${tag}`, bid]);
  const bookingId = Number(r.rows[0].id);
  tracked.bookings.push(bookingId);

  const res = await pool.query(`
    INSERT INTO reservations (
      booking_id, stay_sequence, room_id, guest_name, check_in, check_out,
      status, stay_status, payment_status, booking_type, correlation_id, created_at
    ) VALUES ($1, 1, $2, $3, $4::date, $5::date, 'BOOKED', 'RESERVED', 'UNPAID', 'WALKIN', $6, $4::date)
    RETURNING id
  `, [bookingId, roomId, `${runTag} Guest ${tag}`, checkIn, checkOut, bid]);
  const reservationId = Number(res.rows[0].id);
  tracked.reservations.push(reservationId);

  const dates = await pool.query(`
    SELECT to_char(day::date, 'YYYY-MM-DD') AS d
    FROM generate_series($1::date, $2::date - 1, INTERVAL '1 day') AS day
  `, [checkIn, checkOut]);
  for (const row of dates.rows) {
    await pool.query(
      'UPDATE availability_dates SET reserved_qty = reserved_qty + 1 WHERE room_type_id = $1 AND date = $2::date',
      [null, row.d]
    );
  }

  return { bookingId, reservationId, bid };
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const corrRes = await client.query(
      'SELECT id, booking_id FROM reservations WHERE correlation_id LIKE $1 FOR UPDATE',
      [`${runTag}%`]
    );
    const allResIds = corrRes.rows.map(r => Number(r.id));
    const allBkIds = corrRes.rows.map(r => Number(r.booking_id)).filter(Boolean);
    for (const rid of tracked.reservations) {
      if (!allResIds.includes(rid)) allResIds.push(rid);
    }
    for (const bid of tracked.bookings) {
      if (!allBkIds.includes(bid)) allBkIds.push(bid);
    }

    if (allResIds.length > 0) {
      await client.query('DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[])', [allResIds]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [allResIds]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [allResIds]);
      await client.query('DELETE FROM guest_receivables WHERE reservation_id = ANY($1::int[])', [allResIds]);
      await client.query("DELETE FROM audit_logs WHERE entity='RESERVATION' AND record_id=ANY($1::text[])", [allResIds.map(String)]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [allResIds]);
    }
    if (allBkIds.length > 0) {
      await client.query("DELETE FROM audit_logs WHERE entity='BOOKING' AND record_id=ANY($1::text[])", [allBkIds.map(String)]);
      await client.query('DELETE FROM bookings WHERE id = ANY($1::bigint[])', [allBkIds]);
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
    console.error('Cleanup error:', error.message);
  } finally {
    client.release();
  }
}

async function api(method, path, body, propId) {
  let effectiveBody = body;
  if ((method === 'POST' || method === 'PATCH') && effectiveBody && typeof effectiveBody === 'object') {
    if (propId !== undefined) {
      effectiveBody = { ...effectiveBody, property_id: propId };
    }
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-${Date.now()}` },
    body: effectiveBody ? JSON.stringify(effectiveBody) : undefined
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

// ============================================================
// TEST A: Two concurrent booking attempts for same room + overlapping dates
// ============================================================
async function testA_concurrentBookingOverlap() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createType(pid, 'A');
  tracked.types.push({ id: Number(type.id) });
  const room = await createRoom(pid, type.id, 'A');
  tracked.rooms.push(Number(room.id));
  const checkIn = await plusDays(today, 50);
  const checkOut = await plusDays(today, 53);
  await ensureAvailability(type.id, type.name, checkIn);
  await ensureAvailability(type.id, type.name, await plusDays(today, 51));
  await ensureAvailability(type.id, type.name, await plusDays(today, 52));

  const payload = {
    property_id: pid,
    guest_name: `${runTag} Guest`,
    guest_phone: '081200000000',
    booking_source: 'WALKIN',
    reservations: [{
      room_id: Number(room.id),
      check_in: checkIn,
      check_out: checkOut,
      total_price: 300000
    }]
  };

  const [r1, r2] = await Promise.all([
    api('POST', '/api/bookings', payload),
    api('POST', '/api/bookings', { ...payload, guest_name: `${runTag} Guest B` })
  ]);

  const successes = [r1, r2].filter(r => r.status === 201);
  const failures = [r1, r2].filter(r => r.status === 409);

  expect(successes.length === 1, `testA: expected 1 success, got ${successes.length}`);
  expect(failures.length === 1, `testA: expected 1 conflict, got ${failures.length}`);

  if (successes.length === 1) {
    const bookingId = successes[0].json?.data?.id;
    if (bookingId) tracked.bookings.push(Number(bookingId));
    const resIds = (successes[0].json?.data?.reservations || []).map(r => r.id);
    for (const rid of resIds) tracked.reservations.push(Number(rid));
  }

  console.log('PASS  A. concurrent booking overlap: exactly one succeeds');
}

// ============================================================
// TEST B: Adjacent stays — first checkout == second checkin → both allowed
// ============================================================
async function testB_adjacentStays() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createType(pid, 'B');
  tracked.types.push({ id: Number(type.id) });
  const room = await createRoom(pid, type.id, 'B');
  tracked.rooms.push(Number(room.id));
  const day1 = await plusDays(today, 55);
  const day2 = await plusDays(today, 56);
  const day3 = await plusDays(today, 57);
  await ensureAvailability(type.id, type.name, day1);
  await ensureAvailability(type.id, type.name, day2);

  const r1 = await api('POST', '/api/bookings', {
    property_id: pid, guest_name: `${runTag} B1`, guest_phone: '081200000000',
    booking_source: 'WALKIN',
    reservations: [{ room_id: Number(room.id), check_in: day1, check_out: day2, total_price: 100000 }]
  });
  expect(r1.status === 201, `testB: first booking status=${r1.status}`);
  if (r1.status === 201) {
    const bid = r1.json?.data?.id;
    if (bid) tracked.bookings.push(Number(bid));
    const rids = (r1.json?.data?.reservations || []).map(r => r.id);
    for (const rid of rids) tracked.reservations.push(Number(rid));
  }

  const r2 = await api('POST', '/api/bookings', {
    property_id: pid, guest_name: `${runTag} B2`, guest_phone: '081200000000',
    booking_source: 'WALKIN',
    reservations: [{ room_id: Number(room.id), check_in: day2, check_out: day3, total_price: 100000 }]
  });
  expect(r2.status === 201, `testB: second booking status=${r2.status}`);
  if (r2.status === 201) {
    const bid = r2.json?.data?.id;
    if (bid) tracked.bookings.push(Number(bid));
    const rids = r2.json?.data?.reservations?.map(r => r.id) || [];
    for (const rid of rids) tracked.reservations.push(Number(rid));
  }

  console.log('PASS  B. adjacent stays: both allowed');
}

// ============================================================
// TEST C: Concurrent move attempts into same room/date
// ============================================================
async function testC_concurrentMoveOverlap() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const typeA = await createType(pid, 'CA');
  tracked.types.push({ id: Number(typeA.id) });
  const typeB = await createType(pid, 'CB');
  tracked.types.push({ id: Number(typeB.id) });
  const roomA = await createRoom(pid, typeA.id, 'CA');
  tracked.rooms.push(Number(roomA.id));
  const roomTarget = await createRoom(pid, typeB.id, 'CT');
  tracked.rooms.push(Number(roomTarget.id));
  const day1 = await plusDays(today, 60);
  const day2 = await plusDays(today, 62);
  await ensureAvailability(typeA.id, typeA.name, day1);
  await ensureAvailability(typeA.id, typeA.name, await plusDays(today, 61));
  await ensureAvailability(typeB.id, typeB.name, day1);
  await ensureAvailability(typeB.id, typeB.name, await plusDays(today, 61));

  // create two non-overlapping bookings on roomA, then move both to roomTarget (overlapping)
  const b1 = await api('POST', '/api/bookings', {
    property_id: pid, guest_name: `${runTag} C1`, guest_phone: '081200000000',
    booking_source: 'WALKIN',
    reservations: [{ room_id: Number(roomA.id), check_in: day1, check_out: day2, total_price: 200000 }]
  });
  expect(b1.status === 201, `testC: first booking status=${b1.status}`);
  const resId1 = b1.json?.data?.reservations?.[0]?.id;
  if (resId1) tracked.reservations.push(Number(resId1));

  // put the second booking on a different room so it doesn't conflict with b1
  const roomA2 = await createRoom(pid, typeA.id, 'C2');
  tracked.rooms.push(Number(roomA2.id));
  const b2 = await api('POST', '/api/bookings', {
    property_id: pid, guest_name: `${runTag} C2`, guest_phone: '081200000000',
    booking_source: 'WALKIN',
    reservations: [{ room_id: Number(roomA2.id), check_in: day1, check_out: day2, total_price: 200000 }]
  });
  expect(b2.status === 201, `testC: second booking status=${b2.status}`);
  const resId2 = b2.json?.data?.reservations?.[0]?.id;
  if (resId2) tracked.reservations.push(Number(resId2));

  // now try to move both to the same target room — overlapping
  const [r1, r2] = await Promise.all([
    api('POST', `/api/reservations/${resId1}/move`, { to_room_id: Number(roomTarget.id) }, pid),
    api('POST', `/api/reservations/${resId2}/move`, { to_room_id: Number(roomTarget.id) }, pid)
  ]);

  const successes = [r1, r2].filter(r => r.status === 200);
  const failures = [r1, r2].filter(r => r.status !== 200);

  expect(successes.length === 1, `testC: expected 1 success, got ${successes.length}`);
  expect(failures.length === 1, `testC: expected 1 failure, got ${failures.length}`);

  console.log('PASS  C. concurrent move into same room: exactly one succeeds');
}

// ============================================================
// TEST D: Extend into conflicting occupied date → rejected
// ============================================================
async function testD_extendConflict() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createType(pid, 'D');
  tracked.types.push({ id: Number(type.id) });
  const room = await createRoom(pid, type.id, 'D');
  tracked.rooms.push(Number(room.id));
  const day1 = await plusDays(today, 65);
  const day2 = await plusDays(today, 66);
  const day3 = await plusDays(today, 67);
  const day4 = await plusDays(today, 68);
  await ensureAvailability(type.id, type.name, day1);
  await ensureAvailability(type.id, type.name, day2);
  await ensureAvailability(type.id, type.name, day3);

  // D1: [day1, day2)
  const b1 = await api('POST', '/api/bookings', {
    property_id: pid, guest_name: `${runTag} D1`, guest_phone: '081200000000',
    booking_source: 'WALKIN',
    reservations: [{ room_id: Number(room.id), check_in: day1, check_out: day2, total_price: 100000 }]
  });
  expect(b1.status === 201, `testD: D1 booking status=${b1.status}`);
  const resId1 = b1.json?.data?.reservations?.[0]?.id;
  if (resId1) tracked.reservations.push(Number(resId1));

  // D2: [day3, day4) — occupies day3
  const b2 = await api('POST', '/api/bookings', {
    property_id: pid, guest_name: `${runTag} D2`, guest_phone: '081200000000',
    booking_source: 'WALKIN',
    reservations: [{ room_id: Number(room.id), check_in: day3, check_out: day4, total_price: 100000 }]
  });
  expect(b2.status === 201, `testD: D2 booking status=${b2.status}`);
  const resId2 = b2.json?.data?.reservations?.[0]?.id;
  if (resId2) tracked.reservations.push(Number(resId2));

  // try to extend D1 from day2 to day4 — overlaps with D2 [day3, day4)
  const r = await api('POST', `/api/reservations/${resId1}/extend`, { new_check_out: day4 }, pid);
  expect(r.status === 409, `testD: extend into occupied expected 409, got ${r.status}`);

  const inv = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [type.id, day1]
  );
  expect(Number(inv.rows[0]?.reserved_qty) === 1, `testD: inventory changed after failed extend`);

  console.log('PASS  D. extend into conflicting date: rejected after lock/recheck');
}

// ============================================================
// TEST E: Failed overlap attempt leaves inventory unchanged
// ============================================================
async function testE_failedOverlapInventory() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createType(pid, 'E');
  tracked.types.push({ id: Number(type.id) });
  const room = await createRoom(pid, type.id, 'E');
  tracked.rooms.push(Number(room.id));
  const day1 = await plusDays(today, 70);
  const day2 = await plusDays(today, 71);
  await ensureAvailability(type.id, type.name, day1);

  const before = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [type.id, day1]
  );
  const beforeQty = Number(before.rows[0]?.reserved_qty ?? 0);

  const b1 = await api('POST', '/api/bookings', {
    property_id: pid, guest_name: `${runTag} E1`, guest_phone: '081200000000',
    booking_source: 'WALKIN',
    reservations: [{ room_id: Number(room.id), check_in: day1, check_out: day2, total_price: 100000 }]
  });
  expect(b1.status === 201, `testE: first booking status=${b1.status}`);
  if (b1.status === 201) {
    const bid = b1.json?.data?.id;
    if (bid) tracked.bookings.push(Number(bid));
    const rids = (b1.json?.data?.reservations || []).map(r => r.id);
    for (const rid of rids) tracked.reservations.push(Number(rid));
  }

  const r = await api('POST', '/api/bookings', {
    property_id: pid, guest_name: `${runTag} E2`, guest_phone: '081200000000',
    booking_source: 'WALKIN',
    reservations: [{ room_id: Number(room.id), check_in: day1, check_out: day2, total_price: 100000 }]
  });
  expect(r.status === 409, `testE: overlap expected 409, got ${r.status}`);

  const after = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [type.id, day1]
  );
  const afterQty = Number(after.rows[0]?.reserved_qty ?? 0);
  expect(afterQty === beforeQty + 1, `testE: inventory ${beforeQty} -> ${afterQty}, expected ${beforeQty + 1}`);

  console.log('PASS  E. failed overlap leaves inventory unchanged');
}

// ============================================================
// TEST F: No duplicate physical-room active overlap
// ============================================================
async function testF_noDuplicateOverlap() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const type = await createType(pid, 'F');
  tracked.types.push({ id: Number(type.id) });
  const room = await createRoom(pid, type.id, 'F');
  tracked.rooms.push(Number(room.id));
  const day1 = await plusDays(today, 75);
  const day2 = await plusDays(today, 78);
  await ensureAvailability(type.id, type.name, day1);
  await ensureAvailability(type.id, type.name, await plusDays(today, 76));
  await ensureAvailability(type.id, type.name, await plusDays(today, 77));

  const results = await Promise.all([
    api('POST', '/api/bookings', {
      property_id: pid, guest_name: `${runTag} F1`, guest_phone: '081200000000',
      booking_source: 'WALKIN',
      reservations: [{ room_id: Number(room.id), check_in: day1, check_out: day2, total_price: 300000 }]
    }),
    api('POST', '/api/bookings', {
      property_id: pid, guest_name: `${runTag} F2`, guest_phone: '081200000000',
      booking_source: 'WALKIN',
      reservations: [{ room_id: Number(room.id), check_in: day1, check_out: day2, total_price: 300000 }]
    }),
    api('POST', '/api/bookings', {
      property_id: pid, guest_name: `${runTag} F3`, guest_phone: '081200000000',
      booking_source: 'WALKIN',
      reservations: [{ room_id: Number(room.id), check_in: day1, check_out: day2, total_price: 300000 }]
    })
  ]);

  const successCount = results.filter(r => r.status === 201).length;
  expect(successCount === 1, `testF: expected exactly 1 success, got ${successCount}`);

  for (const r of results) {
    if (r.status === 201) {
      const bid = r.json?.data?.id;
      if (bid) tracked.bookings.push(Number(bid));
      const rids = r.json?.data?.reservations?.map(r => r.id) || [];
      for (const rid of rids) tracked.reservations.push(Number(rid));
    }
  }

  const overlap = await pool.query(
    `SELECT COUNT(*)::int AS c FROM reservations
     WHERE room_id = $1 AND status IN ('BOOKED','CHECKED_IN')
       AND check_in < $3::date AND check_out > $2::date`,
    [room.id, day1, day2]
  );
  expect(Number(overlap.rows[0].c) === 1, `testF: overlap count=${overlap.rows[0].c}, expected 1`);

  console.log('PASS  F. no duplicate physical-room active overlap');
}

// ============================================================
// TEST G: Reassignment with active reservation → rejected
// ============================================================
async function testG_reassignWithActive() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const typeA = await createType(pid, 'GA');
  tracked.types.push({ id: Number(typeA.id) });
  const typeB = await createType(pid, 'GB');
  tracked.types.push({ id: Number(typeB.id) });
  const room = await createRoom(pid, typeA.id, 'GA');
  tracked.rooms.push(Number(room.id));
  const day1 = await plusDays(today, 80);
  const day2 = await plusDays(today, 81);
  await ensureAvailability(typeA.id, typeA.name, day1);
  await ensureAvailability(typeB.id, typeB.name, day1);

  const bk = await api('POST', '/api/bookings', {
    property_id: pid, guest_name: `${runTag} GA`, guest_phone: '081200000000',
    booking_source: 'WALKIN',
    reservations: [{ room_id: Number(room.id), check_in: day1, check_out: day2, total_price: 100000 }]
  });
  expect(bk.status === 201, `testG: booking status=${bk.status}`);
  if (bk.status === 201) {
    const bid = bk.json?.data?.id;
    if (bid) tracked.bookings.push(Number(bid));
    const rids = (bk.json?.data?.reservations || []).map(r => r.id);
    for (const rid of rids) tracked.reservations.push(Number(rid));
  }

  const r = await api('PATCH', `/api/rooms/${room.id}`, { room_type_id: Number(typeB.id) }, pid);
  expect(r.status === 409, `testG: reassign with active expected 409, got ${r.status}`);

  const roomCheck = await pool.query('SELECT room_type_id FROM rooms WHERE id = $1', [room.id]);
  expect(Number(roomCheck.rows[0].room_type_id) === Number(typeA.id), `testG: room type changed despite active reservation`);

  console.log('PASS  G. reassignment with active reservation: rejected');
}

// ============================================================
// TEST H: Reassignment with no active reservations → allowed
// ============================================================
async function testH_reassignNoActive() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const typeA = await createType(pid, 'HA');
  tracked.types.push({ id: Number(typeA.id) });
  const typeB = await createType(pid, 'HB');
  tracked.types.push({ id: Number(typeB.id) });
  const room = await createRoom(pid, typeA.id, 'HA');
  tracked.rooms.push(Number(room.id));
  await ensureAvailability(typeA.id, typeA.name, await plusDays(today, 85));
  await ensureAvailability(typeB.id, typeB.name, await plusDays(today, 85));

  const r = await api('PATCH', `/api/rooms/${room.id}`, { room_type_id: Number(typeB.id) }, pid);
  expect(r.status === 200, `testH: reassign without active expected 200, got ${r.status}`);

  const roomCheck = await pool.query('SELECT room_type_id FROM rooms WHERE id = $1', [room.id]);
  expect(Number(roomCheck.rows[0].room_type_id) === Number(typeB.id), `testH: room type not updated`);

  console.log('PASS  H. reassignment without active reservations: allowed');
}

// ============================================================
// TEST I: Concurrent reservation creation vs reassignment → no inconsistency
// ============================================================
async function testI_concurrentCreateVsReassign() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const typeA = await createType(pid, 'IA');
  tracked.types.push({ id: Number(typeA.id) });
  const typeB = await createType(pid, 'IB');
  tracked.types.push({ id: Number(typeB.id) });
  const room = await createRoom(pid, typeA.id, 'IA');
  tracked.rooms.push(Number(room.id));
  const day1 = await plusDays(today, 90);
  const day2 = await plusDays(today, 91);
  await ensureAvailability(typeA.id, typeA.name, day1);
  await ensureAvailability(typeB.id, typeB.name, day1);

  const bookingPayload = {
    property_id: pid, guest_name: `${runTag} IA`, guest_phone: '081200000000',
    booking_source: 'WALKIN',
    reservations: [{ room_id: Number(room.id), check_in: day1, check_out: day2, total_price: 100000 }]
  };

  const [bookingResult, reassignResult] = await Promise.all([
    api('POST', '/api/bookings', bookingPayload),
    api('PATCH', `/api/rooms/${room.id}`, { room_type_id: Number(typeB.id) }, pid)
  ]);

  if (bookingResult.status === 201) {
    const bid = bookingResult.json?.data?.id;
    if (bid) tracked.bookings.push(Number(bid));
    const rids = bookingResult.json?.data?.reservations?.map(r => r.id) || [];
    for (const rid of rids) tracked.reservations.push(Number(rid));
  }

  const neg = await pool.query('SELECT COUNT(*)::int AS c FROM availability_dates WHERE reserved_qty < 0');
  expect(Number(neg.rows[0].c) === 0, `testI: negative inventory=${neg.rows[0].c}`);

  const roomCheck = await pool.query('SELECT room_type_id FROM rooms WHERE id = $1', [room.id]);
  const finalTypeId = Number(roomCheck.rows[0].room_type_id);
  expect(finalTypeId === Number(typeA.id) || finalTypeId === Number(typeB.id),
    `testI: room type in unexpected state ${finalTypeId}`);

  console.log('PASS  I. concurrent create vs reassignment: no inconsistency');
}

// ============================================================
// TEST J: total_rooms never falls below reserved_qty
// ============================================================
async function testJ_totalRoomsNeverBelowReserved() {
  const drift = await pool.query(
    'SELECT COUNT(*)::int AS c FROM availability_dates WHERE reserved_qty > total_rooms'
  );
  expect(Number(drift.rows[0].c) === 0, `testJ: over-capacity rows=${drift.rows[0].c}`);
  console.log('PASS  J. total_rooms never below reserved_qty');
}

// ============================================================
// TEST K: Historical terminal reservation snapshots unchanged
// ============================================================
async function testK_historicalSnapshots() {
  const terminal = await pool.query(
    `SELECT res.id, res.booked_room_type_id_snapshot, res.booked_room_type_code_snapshot, res.booked_room_type_name_snapshot
     FROM reservations res
     WHERE res.status IN ('CHECKED_OUT', 'CANCELLED')
       AND res.booked_room_type_id_snapshot IS NOT NULL
     ORDER BY res.id DESC LIMIT 5`
  );
  for (const row of terminal.rows) {
    expect(row.booked_room_type_id_snapshot !== null, `testK: res ${row.id} lost room_type_id_snapshot`);
    expect(row.booked_room_type_name_snapshot !== null, `testK: res ${row.id} lost room_type_name_snapshot`);
  }
  console.log('PASS  K. historical terminal snapshots unchanged');
}

// ============================================================
// TEST L: Failed reassignment rolls back fully
// ============================================================
async function testL_failedReassignRollback() {
  const pid = await discoverProperty();
  const today = await hotelDateNow();
  const typeA = await createType(pid, 'LA');
  tracked.types.push({ id: Number(typeA.id) });
  const typeB = await createType(pid, 'LB');
  tracked.types.push({ id: Number(typeB.id) });
  const room = await createRoom(pid, typeA.id, 'LA');
  tracked.rooms.push(Number(room.id));
  const day1 = await plusDays(today, 95);
  const day2 = await plusDays(today, 96);
  await ensureAvailability(typeA.id, typeA.name, day1);
  await ensureAvailability(typeB.id, typeB.name, day1);

  const bk = await api('POST', '/api/bookings', {
    property_id: pid, guest_name: `${runTag} LA`, guest_phone: '081200000000',
    booking_source: 'WALKIN',
    reservations: [{ room_id: Number(room.id), check_in: day1, check_out: day2, total_price: 100000 }]
  });
  expect(bk.status === 201, `testL: booking status=${bk.status}`);
  if (bk.status === 201) {
    const bid = bk.json?.data?.id;
    if (bid) tracked.bookings.push(Number(bid));
    const rids = (bk.json?.data?.reservations || []).map(r => r.id);
    for (const rid of rids) tracked.reservations.push(Number(rid));
  }

  const r = await api('PATCH', `/api/rooms/${room.id}`, { room_type_id: Number(typeB.id) }, pid);
  expect(r.status === 409, `testL: reassign expected 409, got ${r.status}`);

  const roomCheck = await pool.query('SELECT room_type_id, room_number FROM rooms WHERE id = $1', [room.id]);
  expect(Number(roomCheck.rows[0].room_type_id) === Number(typeA.id), `testL: room type changed`);

  const inv = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [typeA.id, day1]
  );
  expect(Number(inv.rows[0]?.reserved_qty) === 1, `testL: availability changed`);

  console.log('PASS  L. failed reassignment rolls back fully');
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await testA_concurrentBookingOverlap();
    await testB_adjacentStays();
    await testC_concurrentMoveOverlap();
    await testD_extendConflict();
    await testE_failedOverlapInventory();
    await testF_noDuplicateOverlap();
    await testG_reassignWithActive();
    await testH_reassignNoActive();
    await testI_concurrentCreateVsReassign();
    await testJ_totalRoomsNeverBelowReserved();
    await testK_historicalSnapshots();
    await testL_failedReassignRollback();
  } catch (error) {
    throw error;
  } finally {
    await new Promise(resolve => server.close(resolve));
    await cleanup();
  }

  console.log(`c2b-concurrency assertions=${assertions}`);
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
