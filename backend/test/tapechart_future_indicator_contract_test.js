'use strict';

require('dotenv').config();
const { once } = require('events');
const { app, pool } = require('../dist/index');

const token = `${Math.random().toString(36).slice(2, 6)}${Date.now().toString(36).slice(-6)}`.toUpperCase();
const runTag = `TCFI-${token}`;
const roomTypeCode = runTag.slice(0, 20);
const roomTypeName = `${runTag} Type`;
const roomNumber = `T${token}`.slice(0, 10);
const guestName = `${runTag} Guest`;
const correlationPrefix = `${runTag}-`;

let server = null;
let assertions = 0;
let propertyId = null;
let roomTypeId = null;
let roomId = null;
let bookingId = null;
let dates = null;
const reservationIds = [];
const reservationByLabel = new Map();
const dependentPosOrderIds = new Set();

function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

function ids(values) {
  return values.length > 0 ? values : [];
}

async function request(path) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
  const text = await response.text();
  expect(response.status === 200, `${path} failed: ${response.status} ${text}`);
  return JSON.parse(text);
}

async function loadHotelDates(client) {
  const result = await client.query(`
    WITH hotel AS (
      SELECT (NOW() AT TIME ZONE 'Asia/Jakarta')::date AS today
    )
    SELECT to_char(today, 'YYYY-MM-DD') AS today,
           to_char(today + 2, 'YYYY-MM-DD') AS plus_2,
           to_char(today + 3, 'YYYY-MM-DD') AS plus_3,
           to_char(today + 4, 'YYYY-MM-DD') AS plus_4,
           to_char(today + 5, 'YYYY-MM-DD') AS plus_5,
           to_char(today + 6, 'YYYY-MM-DD') AS plus_6,
           to_char(today + 7, 'YYYY-MM-DD') AS plus_7,
           to_char(today + 8, 'YYYY-MM-DD') AS plus_8,
           to_char(today + 9, 'YYYY-MM-DD') AS plus_9,
           to_char(today + 10, 'YYYY-MM-DD') AS plus_10
    FROM hotel
  `);
  return result.rows[0];
}

async function createFixture() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    dates = await loadHotelDates(client);

    const property = await client.query('SELECT id FROM properties ORDER BY id LIMIT 1');
    expect(property.rowCount === 1, 'fixture requires one property');
    propertyId = Number(property.rows[0].id);

    const type = await client.query(
      `INSERT INTO room_types (
         property_id, code, name, base_rate, capacity, max_adults, max_children, is_active, display_order
       ) VALUES ($1, $2, $3, 100000, 2, 2, 0, TRUE, 9999)
       RETURNING id`,
      [propertyId, roomTypeCode, roomTypeName]
    );
    roomTypeId = Number(type.rows[0].id);

    const room = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, $3, $4, 'VACANT_CLEAN', TRUE)
       RETURNING id`,
      [propertyId, roomTypeId, roomNumber, roomTypeName]
    );
    roomId = Number(room.rows[0].id);

    const booking = await client.query(
      `INSERT INTO bookings (
         bid, property_id, guest_name_snapshot, booking_source, booking_status,
         currency_code, created_by, correlation_id
       ) VALUES ($1, $2, $3, 'WALKIN', 'ACTIVE', 'IDR', 'contract-test', $4)
       RETURNING id`,
      [runTag, propertyId, guestName, `${correlationPrefix}BOOKING`]
    );
    bookingId = Number(booking.rows[0].id);

    const reservations = await client.query(
      `INSERT INTO reservations (
         booking_id, stay_sequence, room_id, guest_name, check_in, check_out,
         status, stay_status, payment_status, booking_type, correlation_id
       ) VALUES
         ($1, 1, $2, $3, $4::date, $5::date, 'BOOKED',      'RESERVED',  'UNPAID', 'WALKIN', $6),
         ($1, 2, $2, $3, $7::date, $8::date, 'BOOKED',      'RESERVED',  'UNPAID', 'WALKIN', $9),
         ($1, 3, $2, $3, $5::date, $7::date, 'CHECKED_IN',  'IN_HOUSE',  'UNPAID', 'WALKIN', $10),
         ($1, 4, $2, $3, $11::date, $12::date, 'CHECKED_OUT', 'DEPARTED', 'UNPAID', 'WALKIN', $13),
         ($1, 5, $2, $3, $14::date, $15::date, 'CANCELLED',  'CANCELLED','UNPAID', 'WALKIN', $16)
       RETURNING id, stay_sequence`,
      [
        bookingId,
        roomId,
        guestName,
        dates.today,
        dates.plus_3,
        `${correlationPrefix}BOOKED-TODAY`,
        dates.plus_5,
        dates.plus_7,
        `${correlationPrefix}BOOKED-FUTURE`,
        `${correlationPrefix}CHECKED-IN`,
        dates.plus_2,
        dates.plus_4,
        `${correlationPrefix}CHECKED-OUT`,
        dates.plus_7,
        dates.plus_10,
        `${correlationPrefix}CANCELLED`
      ]
    );
    expect(reservations.rowCount === 5, `fixture reservation count=${reservations.rowCount}`);

    const labels = ['bookedToday', 'bookedFuture', 'checkedIn', 'checkedOut', 'cancelled'];
    for (const row of reservations.rows) {
      const reservationId = Number(row.id);
      reservationIds.push(reservationId);
      reservationByLabel.set(labels[Number(row.stay_sequence) - 1], reservationId);
    }

    await client.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       SELECT $1, $2, day::date, 1,
              CASE WHEN day::date < $4::date THEN 1 ELSE 0 END
       FROM generate_series($3::date, $5::date - 1, INTERVAL '1 day') AS day`,
      [roomTypeId, roomTypeName, dates.today, dates.plus_7, dates.plus_10]
    );

    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

function renderedDates(room, reservationId) {
  return room.cells
    .filter((cell) => (cell.reservations || []).some((reservation) => Number(reservation.id) === reservationId))
    .map((cell) => cell.date);
}

function expectDates(actual, expected, label) {
  expect(
    actual.join(',') === expected.join(','),
    `${label} rendered dates=${actual.join(',') || '(none)'} expected=${expected.join(',') || '(none)'}`
  );
}

async function validateContract() {
  const bookedTodayId = reservationByLabel.get('bookedToday');
  const bookedFutureId = reservationByLabel.get('bookedFuture');
  const checkedInId = reservationByLabel.get('checkedIn');
  const checkedOutId = reservationByLabel.get('checkedOut');
  const cancelledId = reservationByLabel.get('cancelled');

  const reservationResponse = await request(`/api/reservations/${bookedTodayId}`);
  const reservation = reservationResponse.data;
  expect(reservation.status === 'BOOKED', `today reservation status=${reservation.status}`);
  expect(reservation.check_in === dates.today, `today reservation check_in=${reservation.check_in}`);
  expect(reservation.check_out === dates.plus_3, `today reservation check_out=${reservation.check_out}`);

  const tapechart = await request(
    `/api/tapechart?start=${dates.plus_3}&end=${dates.plus_10}&include_inactive=1`
  );
  const fixtureRoom = tapechart.rooms.find((room) => Number(room.room_id) === roomId);
  expect(Boolean(fixtureRoom), `canonical room id ${roomId} missing from tapechart`);
  expect(Number(fixtureRoom.id) === roomId, 'tapechart room id aliases disagree');
  expect(Number(fixtureRoom.room_type_id) === roomTypeId, 'tapechart room type identity is not canonical');
  expect(Number(fixtureRoom.future_reservation_count) === 1,
    `fixture room future count=${fixtureRoom.future_reservation_count}`);
  expect(fixtureRoom.next_future_check_in === dates.plus_5,
    `fixture room next future check-in=${fixtureRoom.next_future_check_in}`);

  expectDates(renderedDates(fixtureRoom, bookedTodayId), [], 'BOOKED today checkout-at-window-start');
  expectDates(renderedDates(fixtureRoom, bookedFutureId), [dates.plus_5, dates.plus_6], 'BOOKED future');
  expectDates(renderedDates(fixtureRoom, checkedInId), [dates.plus_3, dates.plus_4], 'CHECKED_IN');
  expectDates(renderedDates(fixtureRoom, checkedOutId), [dates.plus_3], 'CHECKED_OUT window-start overlap');
  expectDates(renderedDates(fixtureRoom, cancelledId),
    [dates.plus_7, dates.plus_8, dates.plus_9], 'CANCELLED');

  const checkoutCell = fixtureRoom.cells.find((cell) => cell.date === dates.plus_7);
  expect(
    !(checkoutCell.reservations || []).some((item) => Number(item.id) === bookedFutureId),
    'future BOOKED reservation rendered on its checkout date'
  );
  const windowStartCell = fixtureRoom.cells.find((cell) => cell.date === dates.plus_3);
  expect(
    (windowStartCell.reservations || []).some((item) => Number(item.id) === checkedOutId),
    'reservation crossing the window start was not rendered on the first visible night'
  );

  for (const cell of fixtureRoom.cells) {
    expect(Number(cell.availability?.room_type_id) === roomTypeId,
      `availability on ${cell.date} did not use canonical room type id`);
    const expectedReserved = cell.date < dates.plus_7 ? 1 : 0;
    expect(Number(cell.availability?.reserved_qty) === expectedReserved,
      `availability reserved_qty on ${cell.date}=${cell.availability?.reserved_qty}`);
  }
}

async function cleanupFixture() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const discoveredReservations = await client.query(
      `SELECT id, booking_id
       FROM reservations
       WHERE correlation_id LIKE $1 OR guest_name = $2
       FOR UPDATE`,
      [`${correlationPrefix}%`, guestName]
    );
    for (const row of discoveredReservations.rows) {
      const id = Number(row.id);
      if (!reservationIds.includes(id)) reservationIds.push(id);
      if (row.booking_id !== null && bookingId === null) bookingId = Number(row.booking_id);
    }

    const ownedReservationIds = ids(reservationIds);
    const posOrders = await client.query(
      'SELECT id FROM pos_orders WHERE reservation_id = ANY($1::int[]) FOR UPDATE',
      [ownedReservationIds]
    );
    for (const row of posOrders.rows) dependentPosOrderIds.add(Number(row.id));

    await client.query('DELETE FROM pos_order_items WHERE order_id = ANY($1::int[])',
      [ids(Array.from(dependentPosOrderIds))]);
    await client.query('DELETE FROM pos_orders WHERE reservation_id = ANY($1::int[])', [ownedReservationIds]);
    await client.query('DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[]) OR room_type_id = $2',
      [ownedReservationIds, roomTypeId]);
    await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [ownedReservationIds]);
    await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [ownedReservationIds]);
    await client.query('DELETE FROM guest_receivables WHERE reservation_id = ANY($1::int[])', [ownedReservationIds]);
    await client.query('DELETE FROM audit_logs WHERE correlation_id LIKE $1', [`${correlationPrefix}%`]);
    await client.query(
      `DELETE FROM reservations
       WHERE id = ANY($1::int[])
         AND (correlation_id LIKE $2 OR guest_name = $3)`,
      [ownedReservationIds, `${correlationPrefix}%`, guestName]
    );
    if (bookingId !== null) {
      await client.query(
        `DELETE FROM bookings
         WHERE id = $1 AND correlation_id = $2 AND guest_name_snapshot = $3
           AND NOT EXISTS (SELECT 1 FROM reservations WHERE booking_id = $1)`,
        [bookingId, `${correlationPrefix}BOOKING`, guestName]
      );
    }
    if (roomId !== null) {
      await client.query('DELETE FROM rooms WHERE id = $1 AND room_number = $2', [roomId, roomNumber]);
    }
    if (roomTypeId !== null) {
      await client.query(
        'DELETE FROM availability_dates WHERE room_type_id = $1 AND room_type = $2',
        [roomTypeId, roomTypeName]
      );
      await client.query(
        'DELETE FROM room_types WHERE id = $1 AND code = $2 AND name = $3',
        [roomTypeId, roomTypeCode, roomTypeName]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

async function verifyZeroResidue() {
  const reservationIdList = ids(reservationIds);
  const posOrderIdList = ids(Array.from(dependentPosOrderIds));
  const checks = [
    ['reservations',
      'SELECT COUNT(*)::int AS c FROM reservations WHERE correlation_id LIKE $1 OR guest_name = $2',
      [`${correlationPrefix}%`, guestName]],
    ['bookings',
      'SELECT COUNT(*)::int AS c FROM bookings WHERE correlation_id LIKE $1 OR guest_name_snapshot = $2',
      [`${correlationPrefix}%`, guestName]],
    ['room', 'SELECT COUNT(*)::int AS c FROM rooms WHERE id = $1 OR room_number = $2', [roomId, roomNumber]],
    ['room type', 'SELECT COUNT(*)::int AS c FROM room_types WHERE id = $1 OR code = $2', [roomTypeId, roomTypeCode]],
    ['availability',
      'SELECT COUNT(*)::int AS c FROM availability_dates WHERE room_type_id = $1 OR room_type = $2',
      [roomTypeId, roomTypeName]],
    ['availability locks',
      'SELECT COUNT(*)::int AS c FROM availability_locks WHERE reservation_id = ANY($1::int[]) OR room_type_id = $2',
      [reservationIdList, roomTypeId]],
    ['payment transactions',
      'SELECT COUNT(*)::int AS c FROM payment_transactions WHERE reservation_id = ANY($1::int[])',
      [reservationIdList]],
    ['folio entries',
      'SELECT COUNT(*)::int AS c FROM folio_entries WHERE reservation_id = ANY($1::int[])',
      [reservationIdList]],
    ['guest receivables',
      'SELECT COUNT(*)::int AS c FROM guest_receivables WHERE reservation_id = ANY($1::int[])',
      [reservationIdList]],
    ['POS orders',
      'SELECT COUNT(*)::int AS c FROM pos_orders WHERE reservation_id = ANY($1::int[]) OR id = ANY($2::int[])',
      [reservationIdList, posOrderIdList]],
    ['POS order items',
      'SELECT COUNT(*)::int AS c FROM pos_order_items WHERE order_id = ANY($1::int[])',
      [posOrderIdList]],
    ['audit logs', 'SELECT COUNT(*)::int AS c FROM audit_logs WHERE correlation_id LIKE $1',
      [`${correlationPrefix}%`]]
  ];

  for (const [label, sql, params] of checks) {
    const result = await pool.query(sql, params);
    expect(Number(result.rows[0].c) === 0, `${label} fixture residue=${result.rows[0].c}`);
  }
}

async function main() {
  let failure = null;
  try {
    await createFixture();
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await validateContract();
  } catch (error) {
    failure = error;
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      await cleanupFixture();
    } catch (cleanupError) {
      failure = failure || cleanupError;
      if (failure !== cleanupError) console.error(cleanupError.stack || cleanupError.message);
    }
    try {
      await verifyZeroResidue();
    } catch (residueError) {
      failure = failure || residueError;
      if (failure !== residueError) console.error(residueError.stack || residueError.message);
    }
  }

  if (failure) throw failure;
  console.log(`tapechart future-indicator assertions=${assertions}`);
  console.log('strict_future_count=1');
  console.log('visible_window_half_open_contract=true');
  console.log('fixture_residue=0');
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
