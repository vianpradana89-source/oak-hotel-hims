const { Pool } = require('pg');

const baseUrl = (process.argv[2] || 'http://localhost:5000').replace(/\/$/, '');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const fetchFn = globalThis.fetch || require('node-fetch');

let propertyId = null;

async function discoverProperty() {
  const result = await pool.query('SELECT id FROM properties ORDER BY id LIMIT 1');
  expect(result.rows.length >= 1, 'No properties found');
  propertyId = Number(result.rows[0].id);
}

const runCorrelationPrefix = `AVAILREG-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const issuedCorrelationIds = new Set();

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function localDate(dateValue = new Date()) {
  const date = new Date(dateValue);
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  return `${year}-${month}-${day}`;
}

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

function toDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return localDate(date);
}

function jakartaDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value || '';
  const month = parts.find((part) => part.type === 'month')?.value || '';
  const day = parts.find((part) => part.type === 'day')?.value || '';
  return `${year}-${month}-${day}`;
}

function request(method, path, body, correlationIdSuffix = '') {
  const headers = { 'Content-Type': 'application/json' };
  const correlationId = `${runCorrelationPrefix}${correlationIdSuffix ? `-${correlationIdSuffix}` : ''}`;
  headers['X-Correlation-Id'] = correlationId;
  issuedCorrelationIds.add(correlationId);
  let effectiveBody = body;
  if (method === 'POST' && effectiveBody && typeof effectiveBody === 'object' && propertyId) {
    if (!effectiveBody.property_id) {
      effectiveBody = { ...effectiveBody, property_id: propertyId };
    }
  } else if (method === 'POST' && (effectiveBody === null || effectiveBody === undefined) && propertyId) {
    effectiveBody = { property_id: propertyId };
  }
  return fetchFn(`${baseUrl}${path}`, {
    method,
    headers,
    body: effectiveBody ? JSON.stringify(effectiveBody) : undefined
  }).then(async (response) => {
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_error) {
      json = null;
    }
    return { status: response.status, text, json, correlationId };
  });
}

async function releaseReservationNights(client, reservation) {
  const status = String(reservation.status || '').toUpperCase();
  if (status !== 'BOOKED' && status !== 'CHECKED_IN') {
    return;
  }
  const roomTypeResult = await client.query('SELECT room_type_id FROM rooms WHERE id = $1', [reservation.room_id]);
  if (!roomTypeResult.rows.length || roomTypeResult.rows[0].room_type_id === null) {
    return;
  }
  const roomTypeId = roomTypeResult.rows[0].room_type_id;
  const nights = [];
  let cursor = new Date(`${toDateKey(reservation.check_in)}T00:00:00`);
  const end = new Date(`${toDateKey(reservation.check_out)}T00:00:00`);
  while (cursor < end) {
    nights.push(toDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const night of nights) {
    await client.query(
      `UPDATE availability_dates
       SET reserved_qty = reserved_qty - 1
       WHERE room_type_id = $1 AND date::date = $2::date
         AND reserved_qty > 0`,
      [roomTypeId, night]
    );
  }
}

async function cleanupCorrelation(correlationId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reservations = await client.query(
      'SELECT id, room_id, check_in, check_out, status FROM reservations WHERE correlation_id = $1 FOR UPDATE',
      [correlationId]
    );
    for (const reservation of reservations.rows) {
      await releaseReservationNights(client, reservation);
    }
    await client.query('DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE correlation_id = $1)', [correlationId]);
    await client.query('DELETE FROM audit_logs WHERE correlation_id = $1', [correlationId]);
    await client.query('DELETE FROM reservations WHERE correlation_id = $1', [correlationId]);
    await client.query('DELETE FROM bookings WHERE correlation_id = $1', [correlationId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function roomHasActiveOverlap(roomId, start, end) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS conflicts
     FROM reservations
     WHERE room_id = $1
       AND status IN ('BOOKED', 'CHECKED_IN')
       AND check_in::date < $3::date
       AND check_out::date > $2::date`,
    [roomId, start, end]
  );
  return Number(result.rows[0]?.conflicts || 0) > 0;
}

async function pickReadyRoom(start, end) {
  const candidates = await pool.query(`
    SELECT r.id, r.status, COALESCE(rt.name, r.name) AS room_type, r.room_number, r.property_id, r.room_type_id
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    WHERE UPPER(r.status) IN ('READY', 'VACANT_CLEAN', 'INSPECTED')
      AND ($1::int IS NULL OR r.property_id = $1)
    ORDER BY r.id
  `, [propertyId]);
  expect(candidates.rowCount > 0, 'No ready room available for availability regression tests');
  for (const candidate of candidates.rows) {
    if (await roomHasActiveOverlap(candidate.id, start, end)) {
      continue;
    }
    const rows = await getAvailabilityForType(candidate.room_type, start, end, candidate.room_type_id);
    if (!Array.isArray(rows) || rows.length === 0) {
      continue;
    }
    const everyNightSellable = rows.every((row) => Number(row.sellable || 0) > 0);
    if (everyNightSellable) {
      return candidate;
    }
  }
  throw new Error(`No ready room with sellable availability for every night between ${start} and ${end}`);
}

async function setRoomStatus(roomId, status) {
  await pool.query('UPDATE rooms SET status = $1 WHERE id = $2', [status, roomId]);
}

async function getAvailabilityForType(roomType, start, end, roomTypeId) {
  const propParam = propertyId ? `&property_id=${propertyId}` : '';
  const typeParam = roomTypeId ? `&room_type_id=${roomTypeId}` : `&room_type=${encodeURIComponent(roomType)}&legacy_compatible=true`;
  const response = await request('GET', `/api/availability?start=${start}&end=${end}${typeParam}${propParam}`);
  expect(response.status === 200, `Availability fetch failed for ${roomType}: ${response.text}`);
  return response.json?.data || [];
}

async function createReservationWithPayload(payload, label) {
  const response = await request('POST', '/api/reservations', payload, label);
  return response;
}

async function testAvailableRoomReturned() {
  const start = addDays(localDate(), 8);
  const end = addDays(start, 2);
  const room = await pickReadyRoom(start, end);
  const rows = await getAvailabilityForType(room.room_type, start, end, room.room_type_id);
  expect(Array.isArray(rows) && rows.length > 0, `Expected availability rows for ${room.room_type}`);
  expect(rows.some((row) => Number(row.sellable || 0) > 0), `No sellable night found for ${room.room_type}`);
}

async function testBookedRoomExcluded() {
  const checkIn = addDays(localDate(), 12);
  const checkOut = addDays(checkIn, 1);
  const room = await pickReadyRoom(checkIn, checkOut);
  const payload = { room_id: room.id, guest_name: 'Booked Exclusion', guest_phone: '081212000001', check_in: checkIn, check_out: checkOut, total_price: 500000, qty: 1 };
  const create = await createReservationWithPayload(payload, 'BOOKED-EXCLUDED');
  expect(create.status === 201, `Booked-room exclusion first create should succeed: ${create.text}`);

  const duplicate = await createReservationWithPayload(payload, 'BOOKED-EXCLUDED-DUP');
  expect(duplicate.status === 409, `Booked room should be rejected on overlap: ${duplicate.text}`);
  await cleanupCorrelation(create.correlationId);
  await cleanupCorrelation(duplicate.correlationId);
}

async function testCheckedInRoomExcluded() {
  const checkIn = addDays(localDate(), 15);
  const checkOut = addDays(checkIn, 2);
  const room = await pickReadyRoom(checkIn, checkOut);
  const first = await createReservationWithPayload({
    room_id: room.id,
    guest_name: 'Checked In Exclusion',
    guest_phone: '081212000002',
    check_in: checkIn,
    check_out: checkOut,
    total_price: 550000,
    qty: 1
  }, 'CHECKED-IN-EXCLUDED');
  expect(first.status === 201, `Checked-in setup should create reservation: ${first.text}`);

  const reservationId = Number(first.json?.data?.id);
  await pool.query(
    `UPDATE reservations SET status = 'CHECKED_IN', stay_status = 'IN_HOUSE', checked_in_at = NOW(), checked_out_at = NULL WHERE id = $1`,
    [reservationId]
  );

  const overlap = await createReservationWithPayload({
    room_id: room.id,
    guest_name: 'Second Checked In Booking',
    guest_phone: '081212000003',
    check_in: checkIn,
    check_out: checkOut,
    total_price: 600000,
    qty: 1
  }, 'CHECKED-IN-OVERLAP');
  expect(overlap.status === 409, `CHECKED_IN overlap should be rejected: ${overlap.text}`);
  await cleanupCorrelation(first.correlationId);
  await cleanupCorrelation(overlap.correlationId);
}

async function testCancelledReservationDoesNotBlock() {
  const checkIn = addDays(localDate(), 18);
  const checkOut = addDays(checkIn, 1);
  const room = await pickReadyRoom(checkIn, checkOut);
  const first = await createReservationWithPayload({
    room_id: room.id,
    guest_name: 'Cancelled Block',
    guest_phone: '081212000004',
    check_in: checkIn,
    check_out: checkOut,
    total_price: 400000,
    qty: 1
  }, 'CANCELLED-BLOCK');
  expect(first.status === 201, `Cancelled setup should create reservation: ${first.text}`);

  const cancelResponse = await request('POST', `/api/reservations/${first.json.data.id}/cancel`, {}, 'CANCELLED-BLOCK-CANCEL');
  expect(cancelResponse.status === 200, `Cancel request failed: ${cancelResponse.text}`);

  const allowed = await createReservationWithPayload({
    room_id: room.id,
    guest_name: 'Cancelled Reuse',
    guest_phone: '081212000005',
    check_in: checkIn,
    check_out: checkOut,
    total_price: 420000,
    qty: 1
  }, 'CANCELLED-BLOCK-REUSE');
  expect(allowed.status === 201, `Cancelled reservation should not block new availability: ${allowed.text}`);
  await cleanupCorrelation(first.correlationId);
  await cleanupCorrelation(cancelResponse.correlationId);
  await cleanupCorrelation(allowed.correlationId);
}

async function releaseHeldNightsForReservation(reservationId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query(
      'SELECT room_id, check_in, check_out FROM reservations WHERE id = $1 FOR UPDATE',
      [reservationId]
    );
    expect(target.rowCount === 1, `Reservation ${reservationId} not found for night release`);
    const reservation = target.rows[0];
    const roomTypeResult = await client.query('SELECT room_type_id FROM rooms WHERE id = $1', [reservation.room_id]);
    const roomTypeId = roomTypeResult.rows[0]?.room_type_id ?? null;
    if (roomTypeId !== null) {
      let cursor = toDateKey(reservation.check_in);
      const end = toDateKey(reservation.check_out);
      while (cursor && end && cursor < end) {
        await client.query(
          `UPDATE availability_dates
           SET reserved_qty = reserved_qty - 1
           WHERE room_type_id = $1 AND date::date = $2::date AND reserved_qty > 0`,
          [roomTypeId, cursor]
        );
        cursor = addDays(cursor, 1);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function testHistoricalCheckedOutDoesNotBlock() {
  const checkIn = addDays(localDate(), 20);
  const checkOut = addDays(checkIn, 1);
  const room = await pickReadyRoom(checkIn, checkOut);
  const first = await createReservationWithPayload({
    room_id: room.id,
    guest_name: 'Historical Check Out',
    guest_phone: '081212000006',
    check_in: checkIn,
    check_out: checkOut,
    total_price: 430000,
    qty: 1
  }, 'CHECKED-OUT-HIST');
  expect(first.status === 201, `Historical check-out setup should create: ${first.text}`);

  const reservationId = Number(first.json?.data?.id);
  await pool.query(
    `UPDATE reservations SET status = 'CHECKED_OUT', stay_status = 'COMPLETED', checked_in_at = NOW() - INTERVAL '3 day', checked_out_at = NOW() - INTERVAL '2 day' WHERE id = $1`,
    [reservationId]
  );
  await releaseHeldNightsForReservation(reservationId);

  const allowed = await createReservationWithPayload({
    room_id: room.id,
    guest_name: 'Historical Reuse',
    guest_phone: '081212000007',
    check_in: checkIn,
    check_out: checkOut,
    total_price: 440000,
    qty: 1
  }, 'CHECKED-OUT-HIST-REUSE');
  expect(allowed.status === 201, `Historical CHECKED_OUT should not block new room availability: ${allowed.text}`);
  await cleanupCorrelation(first.correlationId);
  await cleanupCorrelation(allowed.correlationId);
}

async function testMaintenanceRoomExcluded() {
  const checkIn = addDays(localDate(), 22);
  const checkOut = addDays(checkIn, 1);
  const room = await pickReadyRoom(checkIn, checkOut);
  const originalStatusResult = await pool.query('SELECT status FROM rooms WHERE id = $1', [room.id]);
  expect(originalStatusResult.rowCount === 1, `Room ${room.id} not found for maintenance test`);
  const originalStatus = String(originalStatusResult.rows[0].status || 'VACANT_CLEAN');
  await setRoomStatus(room.id, 'OUT_OF_ORDER');
  try {
    const response = await createReservationWithPayload({
      room_id: room.id,
      guest_name: 'Maintenance Exclusion',
      guest_phone: '081212000008',
      check_in: checkIn,
      check_out: checkOut,
      total_price: 350000,
      qty: 1
    }, 'MAINTENANCE-EXCLUDE');
    if (response.status === 201) {
      await cleanupCorrelation(response.correlationId);
    }
    expect(response.status === 409, `Maintenance room should be rejected: ${response.text}`);
  } finally {
    await setRoomStatus(room.id, originalStatus);
  }
}

async function testBoundaryPreviousCheckoutAllowed() {
  const priorCheckIn = addDays(localDate(), 23);
  const priorCheckOut = addDays(priorCheckIn, 1);
  const room = await pickReadyRoom(priorCheckIn, addDays(priorCheckOut, 1));
  const first = await createReservationWithPayload({
    room_id: room.id,
    guest_name: 'Boundary Previous',
    guest_phone: '081212000009',
    check_in: priorCheckIn,
    check_out: priorCheckOut,
    total_price: 300000,
    qty: 1
  }, 'BOUNDARY-PREV');
  expect(first.status === 201, `Previous checkout setup should succeed: ${first.text}`);

  const next = await createReservationWithPayload({
    room_id: room.id,
    guest_name: 'Boundary Next',
    guest_phone: '081212000010',
    check_in: priorCheckOut,
    check_out: addDays(priorCheckOut, 1),
    total_price: 310000,
    qty: 1
  }, 'BOUNDARY-PREV-NEXT');
  expect(next.status === 201, `Previous checkout == next checkin should be allowed: ${next.text}`);
  await cleanupCorrelation(first.correlationId);
  await cleanupCorrelation(next.correlationId);
}

async function testBoundaryRequestedCheckoutEqualsNextCheckinAllowed() {
  const firstCheckIn = addDays(localDate(), 25);
  const firstCheckOut = addDays(firstCheckIn, 2);
  const room = await pickReadyRoom(firstCheckIn, addDays(firstCheckOut, 1));
  const first = await createReservationWithPayload({
    room_id: room.id,
    guest_name: 'Boundary Checkout',
    guest_phone: '081212000011',
    check_in: firstCheckIn,
    check_out: firstCheckOut,
    total_price: 350000,
    qty: 1
  }, 'BOUNDARY-CHECKOUT');
  expect(first.status === 201, `Requested checkout setup should succeed: ${first.text}`);

  const next = await createReservationWithPayload({
    room_id: room.id,
    guest_name: 'Boundary Next Sequence',
    guest_phone: '081212000012',
    check_in: firstCheckOut,
    check_out: addDays(firstCheckOut, 1),
    total_price: 360000,
    qty: 1
  }, 'BOUNDARY-CHECKOUT-NEXT');
  expect(next.status === 201, `Requested checkout == next checkin should be allowed: ${next.text}`);
  await cleanupCorrelation(first.correlationId);
  await cleanupCorrelation(next.correlationId);
}

async function testMultiNightRequiresAvailabilityEveryNight() {
  const start = addDays(localDate(), 27);
  const end = addDays(start, 2);
  const room = await pickReadyRoom(start, end);
  const first = await createReservationWithPayload({
    room_id: room.id,
    guest_name: 'Multi Night First',
    guest_phone: '081212000013',
    check_in: start,
    check_out: end,
    total_price: 500000,
    qty: 1
  }, 'MULTI-NIGHT-FIRST');
  expect(first.status === 201, `Multi-night first reservation should succeed: ${first.text}`);

  const overlap = await createReservationWithPayload({
    room_id: room.id,
    guest_name: 'Multi Night Second',
    guest_phone: '081212000014',
    check_in: addDays(start, 1),
    check_out: addDays(start, 2),
    total_price: 280000,
    qty: 1
  }, 'MULTI-NIGHT-SECOND');
  expect(overlap.status === 409, `Multi-night overlap should be rejected: ${overlap.text}`);
  await cleanupCorrelation(first.correlationId);
  await cleanupCorrelation(overlap.correlationId);
}

async function testTimezoneDateBehavior() {
  const start = addDays(jakartaDateKey(), -1);
  const end = jakartaDateKey();
  const roomResult = await pool.query(`
    SELECT r.room_type_id, COALESCE(rt.name, r.name) AS room_type
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    WHERE ($1::int IS NULL OR r.property_id = $1)
    ORDER BY r.id
    LIMIT 1
  `, [propertyId]);
  expect(roomResult.rowCount === 1, 'No rooms configured for timezone behavior test');
  const rows = await getAvailabilityForType(roomResult.rows[0].room_type, start, end, roomResult.rows[0].room_type_id);
  expect(
    Array.isArray(rows) && rows.some((row) => jakartaDateKey(row.date) === start),
    `Asia/Jakarta date should include ${start} in the local availability window`
  );
}

async function testR01SelectedRoomExcludedFromOverlappingR02() {
  const checkIn = addDays(localDate(), 30);
  const checkOut = addDays(checkIn, 2);
  const room = await pickReadyRoom(checkIn, checkOut);
  const payload = {
    guest_name: 'Booking Multi Room Overlap',
    guest_phone: '081212000015',
    property_id: propertyId,
    reservations: [
      { room_id: room.id, check_in: checkIn, check_out: checkOut, guest_name: 'R01', guest_phone: '081212000015', total_price: 500000, qty: 1 },
      { room_id: room.id, check_in: checkIn, check_out: checkOut, guest_name: 'R02', guest_phone: '081212000016', total_price: 500000, qty: 1 }
    ]
  };
  const response = await request('POST', '/api/bookings', payload, 'MULTI-ROOM-OVERLAP');
  expect(response.status === 409, `Multi-room booking should reject overlapping same room selection: ${response.text}`);
}

async function testBackendBookingCreateRejectsStaleDoubleBookingAttempt() {
  const checkIn = addDays(localDate(), 31);
  const checkOut = addDays(checkIn, 1);
  const room = await pickReadyRoom(checkIn, checkOut);
  const payload = {
    guest_name: 'Stale Booking Guard',
    guest_phone: '081212000017',
    property_id: propertyId,
    reservations: [{ room_id: room.id, guest_name: 'Stale Guard Guest', guest_phone: '081212000017', check_in: checkIn, check_out: checkOut, total_price: 600000, qty: 1 }]
  };
  const first = await request('POST', '/api/bookings', payload, 'STALE-BOOKING-1');
  expect(first.status === 201, `Initial booking creation should succeed: ${first.text}`);

  const second = await request('POST', '/api/bookings', payload, 'STALE-BOOKING-2');
  expect(second.status === 409, `Duplicate stale booking attempt should be rejected: ${second.text}`);
  await cleanupCorrelation(first.correlationId);
  await cleanupCorrelation(second.correlationId);
}

async function main() {
  await pool.query('SELECT 1');
  await discoverProperty();
  let response = null;
  try {
    response = await fetchFn(`${baseUrl}/api/rooms?property_id=${propertyId}`);
  } catch (_error) {
    throw new Error(`Backend server is not reachable at ${baseUrl}. Start the backend before running these tests.`);
  }
  expect(response.ok, `Server responded with ${response.status} at ${baseUrl}`);

  try {
    await testAvailableRoomReturned();
    await testBookedRoomExcluded();
    await testCheckedInRoomExcluded();
    await testCancelledReservationDoesNotBlock();
    await testHistoricalCheckedOutDoesNotBlock();
    await testMaintenanceRoomExcluded();
    await testBoundaryPreviousCheckoutAllowed();
    await testBoundaryRequestedCheckoutEqualsNextCheckinAllowed();
    await testMultiNightRequiresAvailabilityEveryNight();
    await testTimezoneDateBehavior();
    await testR01SelectedRoomExcludedFromOverlappingR02();
    await testBackendBookingCreateRejectsStaleDoubleBookingAttempt();

    console.log('Availability regression tests passed (12 scenarios).');
  } finally {
    for (const correlationId of issuedCorrelationIds) {
      try {
        await cleanupCorrelation(correlationId);
      } catch (cleanupError) {
        console.error(`Cleanup failed for correlation ${correlationId}: ${cleanupError.message}`);
      }
    }
  }
}

main().catch((error) => {
  console.error('Availability regression test failed:', error.message || error);
  process.exit(1);
}).finally(() => {
  pool.end().catch(() => {});
});
