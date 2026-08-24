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

function request(method, path, body, correlationIdSuffix = '') {
  const headers = { 'Content-Type': 'application/json' };
  const correlationId = `AVAIL-REG-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${correlationIdSuffix ? `-${correlationIdSuffix}` : ''}`;
  headers['X-Correlation-Id'] = correlationId;
  return fetchFn(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
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

async function cleanupCorrelation(correlationId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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

async function pickReadyRoom() {
  const result = await pool.query(`
    SELECT r.id, r.status, COALESCE(rt.name, r.name) AS room_type, r.room_number
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    WHERE r.status IN ('Ready', 'VACANT_CLEAN', 'INSPECTED')
    ORDER BY r.id
    LIMIT 1
  `);
  expect(result.rowCount > 0, 'No ready room available for availability regression tests');
  return result.rows[0];
}

async function setRoomStatus(roomId, status) {
  await pool.query('UPDATE rooms SET status = $1 WHERE id = $2', [status, roomId]);
}

async function getAvailabilityForType(roomType, start, end) {
  const response = await request('GET', `/api/availability?room_type=${encodeURIComponent(roomType)}&start=${start}&end=${end}`);
  expect(response.status === 200, `Availability fetch failed for ${roomType}: ${response.text}`);
  return response.json?.data || [];
}

async function createReservationWithPayload(payload, label) {
  const response = await request('POST', '/api/reservations', payload, label);
  return response;
}

async function testAvailableRoomReturned() {
  const room = await pickReadyRoom();
  const start = addDays(localDate(), 8);
  const end = addDays(start, 2);
  const rows = await getAvailabilityForType(room.room_type, start, end);
  expect(Array.isArray(rows) && rows.length > 0, `Expected availability rows for ${room.room_type}`);
  expect(rows.some((row) => Number(row.sellable || 0) > 0), `No sellable night found for ${room.room_type}`);
}

async function testBookedRoomExcluded() {
  const room = await pickReadyRoom();
  const checkIn = addDays(localDate(), 12);
  const checkOut = addDays(checkIn, 1);
  const payload = { room_id: room.id, guest_name: 'Booked Exclusion', guest_phone: '081212000001', check_in: checkIn, check_out: checkOut, total_price: 500000, qty: 1 };
  const create = await createReservationWithPayload(payload, 'BOOKED-EXCLUDED');
  expect(create.status === 201, `Booked-room exclusion first create should succeed: ${create.text}`);

  const duplicate = await createReservationWithPayload(payload, 'BOOKED-EXCLUDED-DUP');
  expect(duplicate.status === 409, `Booked room should be rejected on overlap: ${duplicate.text}`);
  await cleanupCorrelation(create.correlationId);
  await cleanupCorrelation(duplicate.correlationId);
}

async function testCheckedInRoomExcluded() {
  const room = await pickReadyRoom();
  const checkIn = addDays(localDate(), 15);
  const checkOut = addDays(checkIn, 2);
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
  const room = await pickReadyRoom();
  const checkIn = addDays(localDate(), 18);
  const checkOut = addDays(checkIn, 1);
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

async function testHistoricalCheckedOutDoesNotBlock() {
  const room = await pickReadyRoom();
  const checkIn = addDays(localDate(), 20);
  const checkOut = addDays(checkIn, 1);
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
  const room = await pickReadyRoom();
  await setRoomStatus(room.id, 'OUT_OF_ORDER');
  const checkIn = addDays(localDate(), 22);
  const checkOut = addDays(checkIn, 1);
  const response = await createReservationWithPayload({
    room_id: room.id,
    guest_name: 'Maintenance Exclusion',
    guest_phone: '081212000008',
    check_in: checkIn,
    check_out: checkOut,
    total_price: 350000,
    qty: 1
  }, 'MAINTENANCE-EXCLUDE');
  expect(response.status === 409, `Maintenance room should be rejected: ${response.text}`);
  await setRoomStatus(room.id, 'Ready');
}

async function testBoundaryPreviousCheckoutAllowed() {
  const room = await pickReadyRoom();
  const priorCheckIn = addDays(localDate(), 23);
  const priorCheckOut = addDays(priorCheckIn, 1);
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
  const room = await pickReadyRoom();
  const firstCheckIn = addDays(localDate(), 25);
  const firstCheckOut = addDays(firstCheckIn, 2);
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
  const room = await pickReadyRoom();
  const start = addDays(localDate(), 27);
  const end = addDays(start, 2);
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
  const room = await pickReadyRoom();
  const start = '2026-08-23';
  const end = '2026-08-24';
  const rows = await getAvailabilityForType(room.room_type, start, end);
  expect(Array.isArray(rows) && rows.some((row) => String(row.date) === start || String(row.date).startsWith(start)), 'Asia/Jakarta date should include 2026-08-23 in the local availability window');
}

async function testR01SelectedRoomExcludedFromOverlappingR02() {
  const room = await pickReadyRoom();
  const payload = {
    guest_name: 'Booking Multi Room Overlap',
    guest_phone: '081212000015',
    property_id: 1,
    reservations: [
      { room_id: room.id, check_in: addDays(localDate(), 30), check_out: addDays(localDate(), 32), guest_name: 'R01', guest_phone: '081212000015', total_price: 500000, qty: 1 },
      { room_id: room.id, check_in: addDays(localDate(), 30), check_out: addDays(localDate(), 32), guest_name: 'R02', guest_phone: '081212000016', total_price: 500000, qty: 1 }
    ]
  };
  const response = await request('POST', '/api/bookings', payload, 'MULTI-ROOM-OVERLAP');
  expect(response.status === 409, `Multi-room booking should reject overlapping same room selection: ${response.text}`);
}

async function testBackendBookingCreateRejectsStaleDoubleBookingAttempt() {
  const room = await pickReadyRoom();
  const checkIn = addDays(localDate(), 31);
  const checkOut = addDays(checkIn, 1);
  const payload = {
    guest_name: 'Stale Booking Guard',
    guest_phone: '081212000017',
    property_id: 1,
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
  let response = null;
  try {
    response = await fetchFn(`${baseUrl}/api/rooms`);
  } catch (_error) {
    throw new Error(`Backend server is not reachable at ${baseUrl}. Start the backend before running these tests.`);
  }
  expect(response.ok, `Server responded with ${response.status} at ${baseUrl}`);

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
}

main().catch((error) => {
  console.error('Availability regression test failed:', error.message || error);
  process.exit(1);
}).finally(() => {
  pool.end().catch(() => {});
});
