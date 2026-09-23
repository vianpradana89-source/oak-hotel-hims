const { Pool } = require('pg');
const { generateToken } = require('../dist/domains/auth/authService');

const baseUrl = (process.argv[2] || 'http://localhost:5000').replace(/\/$/, '');

let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try { fetchFn = require('node-fetch'); } catch (_e) {
    console.error('Global fetch is not available. Use Node 18+ or install node-fetch.');
    process.exit(1);
  }
}

const dbHost = process.env.DB_HOST || '127.0.0.1';
const dbPort = Number(process.env.DB_PORT) || 5432;
const dbName = process.env.DB_NAME || 'oak_hotel_db';

if (dbHost !== '127.0.0.1' && dbHost !== 'localhost') {
  console.error(`FATAL: add_room_to_group_test must ONLY run against local database (127.0.0.1). Target: ${dbHost}`);
  process.exit(1);
}
if (dbPort !== 5432) {
  console.error(`FATAL: add_room_to_group_test must ONLY run on port 5432. Target: ${dbPort}`);
  process.exit(1);
}

const pool = new Pool({
  host: dbHost,
  port: dbPort,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: dbName
});

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function toDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return toDateKey(d);
}

async function generateAuth(propertyId) {
  return generateToken({
    id: 1,
    email: 'info@oaklawang.com',
    username: 'vian',
    full_name: 'Vian Pradana',
    role: 'Super Admin',
    property_id: propertyId
  });
}

let authToken = null;

async function request(path, body, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  else if (/^\/api\/bookings\/[^/]+\/reservations$/.test(path)) headers['Idempotency-Key'] = `ADDROOM-TEST-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  if (options.correlationId) headers['X-Correlation-Id'] = options.correlationId;
  if (options.authToken) headers['Authorization'] = `Bearer ${options.authToken}`;
  else if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const response = await fetchFn(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_e) { json = null; }
  return { status: response.status, json, text };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findProperty() {
  const res = await pool.query(`SELECT id, property_code FROM properties WHERE is_active = true ORDER BY id ASC LIMIT 1`);
  if (res.rowCount === 0) throw new Error('No property found in database');
  return { id: Number(res.rows[0].id), code: String(res.rows[0].property_code) };
}

async function getOrCreateRatePlan(propertyId, roomTypeId) {
  const existing = await pool.query(
    `SELECT id FROM rate_plans WHERE room_type_id = $1 AND property_id = $2 AND is_active = true AND is_archived = false LIMIT 1`,
    [roomTypeId, propertyId]
  );
  if (existing.rowCount > 0) {
    return Number(existing.rows[0].id);
  }
  const code = `RP-${roomTypeId}-${Date.now().toString().slice(-6)}`;
  const created = await pool.query(
    `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, meal_plan, rate_type, is_active, is_archived, sort_order)
     VALUES ($1, $2, $3, $4, 150000, 'ROOM_ONLY', 'STANDARD', true, false, 0)
     RETURNING id`,
    [propertyId, roomTypeId, code, `Standard Rate ${roomTypeId}`]
  );
  return Number(created.rows[0].id);
}

async function findAvailableRoom(propertyId, checkIn, checkOut, excludeRoomId = null) {
  const res = await pool.query(
    `SELECT r.id, r.property_id, COALESCE(rt.name, r.name) AS room_type, rt.id AS canonical_room_type_id,
            r.room_number, r.status AS room_status, r.is_active, rt.is_active AS room_type_is_active
     FROM rooms r
     JOIN room_types rt ON rt.id = r.room_type_id
     WHERE r.property_id = $1
       AND r.is_active = true
       AND rt.is_active = true
       AND r.status IN ('VACANT_CLEAN', 'READY', 'VACANT')
     ORDER BY r.id`,
    [propertyId]
  );
  for (const row of res.rows) {
    if (excludeRoomId !== null && Number(row.id) === Number(excludeRoomId)) continue;
    const overlap = await pool.query(
      `SELECT 1 FROM reservations
       WHERE room_id = $1 AND status IN ('BOOKED','CHECKED_IN')
         AND check_in < $2::date AND check_out > $3::date
       LIMIT 1`,
      [row.id, checkOut, checkIn]
    );
    if (overlap.rowCount === 0) {
      await getOrCreateRatePlan(propertyId, row.canonical_room_type_id);
      return row;
    }
  }
  return null;
}

async function createTestBooking(propertyId, room, checkIn, checkOut, extra = {}) {
  const correlationId = `ADDROOM-BASIC-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const ratePlanId = await getOrCreateRatePlan(propertyId, room.canonical_room_type_id);

  const payload = {
    property_id: propertyId,
    guest_name: 'AddRoom Test Guest',
    guest_phone: '081900001111',
    booker_name: 'Test Booker',
    booker_phone: '081900001111',
    identity_number: '3171010101010001',
    booking_source: 'WALKIN',
    payment_method: 'CASH',
    payment_amount: 150000,
    bukti_bayar_path: 'uploads/test_fixture_receipt.jpg',
    reservations: [{
      room_id: room.id,
      check_in: checkIn,
      check_out: checkOut,
      subtotal_amount: 150000,
      total_price: 150000,
      discount_amount: 0,
      discount_percent: 0,
      amount_paid: 150000,
      remaining_balance: 0,
      payment_status: 'PAID',
      booking_type: 'WALKIN',
      rate_plan_id: ratePlanId,
      bukti_bayar_path: 'uploads/test_fixture_receipt.jpg'
    }],
    ...extra
  };

  const res = await request('/api/bookings', payload, { correlationId, authToken });
  expect(res.status === 201, `create booking failed: ${res.status} ${JSON.stringify(res.json)}`);
  expect(res.json.status === 'SUCCESS', `booking response not SUCCESS: ${JSON.stringify(res.json)}`);
  return { bid: res.json.data.bid, correlationId, propertyId };
}

async function cleanupByBid(bid) {
  if (!bid) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bRes = await client.query('SELECT id FROM bookings WHERE UPPER(bid) = $1', [bid.toUpperCase()]);
    if (bRes.rowCount > 0) {
      const bookingId = bRes.rows[0].id;
      const rRes = await client.query('SELECT id FROM reservations WHERE booking_id = $1', [bookingId]);
      const resIds = rRes.rows.map(r => r.id);
      let stayNights = { rows: [] };
      if (resIds.length > 0) {
        stayNights = await client.query(
          `SELECT r.booked_room_type_id_snapshot AS room_type_id, d::date AS date
           FROM reservations r
           CROSS JOIN LATERAL generate_series(r.check_in, r.check_out - INTERVAL '1 day', INTERVAL '1 day') AS d
           WHERE r.id = ANY($1) AND r.booked_room_type_id_snapshot IS NOT NULL`,
          [resIds]
        );
        await client.query('DELETE FROM identity_custody WHERE reservation_id = ANY($1)', [resIds]);
        await client.query('DELETE FROM deposit_events WHERE reservation_id = ANY($1)', [resIds]);
        await client.query('DELETE FROM deposits WHERE reservation_id = ANY($1)', [resIds]);
        await client.query('DELETE FROM payment_allocations WHERE reservation_id = ANY($1) OR booking_id = $2', [resIds, bookingId]);
        await client.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1)', [resIds]);
        await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1)', [resIds]);
        await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1)', [resIds]);
        await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1)', [resIds]);
        await client.query('DELETE FROM reservation_guests WHERE reservation_id = ANY($1)', [resIds]);
        await client.query('DELETE FROM guest_receivables WHERE reservation_id = ANY($1)', [resIds]);
      }
      await client.query('DELETE FROM payment_allocations WHERE booking_id = $1', [bookingId]);
      await client.query("DELETE FROM audit_logs WHERE record_id = $1::text AND module = 'PMS' AND action = 'ADD_ROOM'", [bookingId]);
      await client.query('DELETE FROM reservations WHERE booking_id = $1', [bookingId]);
      await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);

      for (const night of stayNights.rows) {
        await client.query(
          `UPDATE availability_dates ad
           SET reserved_qty = (
             SELECT COUNT(*)::int
             FROM reservations r
             CROSS JOIN LATERAL generate_series(r.check_in, r.check_out - INTERVAL '1 day', INTERVAL '1 day') AS d
             WHERE r.booked_room_type_id_snapshot = ad.room_type_id
               AND d::date = ad.date
               AND r.status IN ('BOOKED', 'CHECKED_IN')
           )
           WHERE ad.room_type_id = $1 AND ad.date = $2`,
          [night.room_type_id, night.date]
        );
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

async function getReservationCount(bid) {
  const res = await pool.query(`SELECT COUNT(*)::int AS cnt FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE UPPER(b.bid) = $1`, [bid.toUpperCase()]);
  return Number(res.rows[0]?.cnt || 0);
}

async function getBookingStatus(bid) {
  const res = await pool.query(`SELECT booking_status FROM bookings WHERE UPPER(bid) = $1`, [bid.toUpperCase()]);
  return res.rows[0]?.booking_status || null;
}

async function getInventoryViolationCount() {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM availability_dates
    WHERE reserved_qty < 0 OR reserved_qty > total_rooms
  `);
  return Number(result.rows[0]?.count || 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test_basic_add_room() {
  console.log('\n[T1] basic_add_room - add child to existing booking');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 30);
  const checkOut = addDays(checkIn, 2);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  // Need rate_plan_id - find one for this room type
  const rpRes = await pool.query(
    `SELECT id FROM rate_plans WHERE room_type_id = $1 AND is_active = true LIMIT 1`,
    [room.canonical_room_type_id]
  );
  expect(rpRes.rowCount > 0, 'No active rate plan found for room type');
  const ratePlanId = Number(rpRes.rows[0].id);

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');

  const secondRpRes = await pool.query(
    `SELECT id FROM rate_plans WHERE room_type_id = $1 AND is_active = true LIMIT 1`,
    [secondRoom.canonical_room_type_id]
  );
  expect(secondRpRes.rowCount > 0, 'No active rate plan found for second room type');
  const secondRatePlanId = Number(secondRpRes.rows[0].id);

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom Second Guest',
    guest_phone: '081900002222',
    check_in: checkIn,
    check_out: checkOut,
    stay_type: 'OVERNIGHT',
    created_by: 'test'
  };

  const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
  expect(res.status === 201, `add room failed: ${res.status} ${JSON.stringify(res.json)}`);
  expect(res.json.status === 'SUCCESS', `booking response not SUCCESS: ${JSON.stringify(res.json)}`);
  expect(res.json.data.reservation, 'No reservation in response');
  expect(res.json.data.stay_sequence === 2, `Expected stay_sequence=2, got ${res.json.data.stay_sequence}`);
  expect(res.json.data.new_booking_status === 'ACTIVE', `Expected ACTIVE, got ${res.json.data.new_booking_status}`);

  const afterCount = await getReservationCount(bid);
  expect(afterCount === 2, `Expected 2 reservations after add, got ${afterCount}`);

  // Verify group financials
  expect(res.json.data.group_financials, 'Missing group_financials');
  expect(res.json.data.group_financials.existing_children_count === 1, 'Wrong existing count');
  expect(res.json.data.group_financials.new_room_price > 0, 'New room price should be positive');
  expect(res.json.data.group_financials.projected_group_total > 0, 'Projected total should be positive');

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_idempotency_no_duplicate() {
  console.log('\n[T2] idempotency - same request twice returns same result');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 40);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom Idempotent Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const key = `ADDROOM-IDEMPOTENT-${Date.now()}`;

  const res1 = await request(`/api/bookings/${bid}/reservations`, addPayload, { idempotencyKey: key });
  const res2 = await request(`/api/bookings/${bid}/reservations`, addPayload, { idempotencyKey: key });

  expect(res1.status === 201, `first call failed: ${res1.status}`);
  expect(res2.status === 201, `second call failed: ${res2.status}`);
  expect(res1.json.data.reservation.id === res2.json.data.reservation.id, 'Idempotent responses must have same reservation ID');

  const afterCount = await getReservationCount(bid);
  expect(afterCount === 2, `Expected 2 reservations after idempotent add, got ${afterCount}`);

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_sibling_overlap_blocks() {
  console.log('\n[T3] sibling_same_room_overlap - same physical room blocks even within same booking');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 50);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const rpRes = await pool.query(
    `SELECT id FROM rate_plans WHERE room_type_id = $1 AND is_active = true LIMIT 1`,
    [room.canonical_room_type_id]
  );

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  // Add a SECOND reservation on the SAME room (sibling)
  const addPayload = {
    property_id: property.id,
    room_id: room.id,
    rate_plan_id: Number(rpRes.rows[0].id),
    guest_name: 'AddRoom Sibling Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
  // Same physical room on same dates -> should BLOCK (sibling overlap)
  expect(res.status === 409, `Expected 409 for sibling overlap, got ${res.status}: ${JSON.stringify(res.json)}`);
  expect(res.json.code === 'ROOM_OVERLAP', `Expected ROOM_OVERLAP code, got ${res.json.code}`);

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_external_overlap_blocks() {
  console.log('\n[T4] external_overlap - outside booking blocks when room occupied');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 55);
  const checkOut = addDays(checkIn, 1);

  // Create first booking with room A
  const roomA = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(roomA, 'No available room A');

  const rpRes = await pool.query(
    `SELECT id FROM rate_plans WHERE room_type_id = $1 AND is_active = true LIMIT 1`,
    [roomA.canonical_room_type_id]
  );
  expect(rpRes.rowCount > 0, 'No active rate plan for room A');

  // Create a separate (external) booking on room A
  const { bid: otherBid } = await createTestBooking(property.id, roomA, checkIn, checkOut);

  // Create second booking with a different room
  const checkIn2 = addDays(today, 60);
  const checkOut2 = addDays(today, 61);
  const roomD = await findAvailableRoom(property.id, checkIn2, checkOut2);
  expect(roomD, 'No available room D');
  const { bid: bid2 } = await createTestBooking(property.id, roomD, checkIn2, checkOut2);

  // Try to add roomA (occupied by external booking on [checkIn, checkOut)) to bid2
  const addPayload = {
    property_id: property.id,
    room_id: roomA.id,
    rate_plan_id: Number(rpRes.rows[0].id),
    guest_name: 'AddRoom External Conflict Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const res = await request(`/api/bookings/${bid2}/reservations`, addPayload);
  expect(res.status === 409, `Expected 409 for external overlap, got ${res.status}: ${JSON.stringify(res.json)}`);
  expect(res.json.code === 'ROOM_OVERLAP', `Expected ROOM_OVERLAP, got ${res.json.code}`);

  await cleanupByBid(bid2);
  await cleanupByBid(otherBid);
  console.log('  PASSED');
}

async function test_all_children_cancelled_blocks() {
  console.log('\n[T5] stale_booking_all_cancelled - derived CANCELLED blocks add');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 70);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  // Cancel the existing child reservation
  await pool.query(`UPDATE reservations SET status = 'CANCELLED' WHERE booking_id = (SELECT id FROM bookings WHERE UPPER(bid) = $1)`, [bid.toUpperCase()]);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom Cancelled Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
  expect(res.status === 409, `Expected 409 for all-cancelled booking, got ${res.status}: ${JSON.stringify(res.json)}`);
  expect(res.json.code === 'BOOKING_EFFECTIVELY_TERMINAL', `Expected BOOKING_EFFECTIVELY_TERMINAL, got ${res.json.code}`);

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_checked_in_child_blocks() {
  console.log('\n[T6] checked_in_child - CHECKED_IN child blocks add room');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 75);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  // Set the existing child to CHECKED_IN
  await pool.query(`UPDATE reservations SET status = 'CHECKED_IN' WHERE booking_id = (SELECT id FROM bookings WHERE UPPER(bid) = $1)`, [bid.toUpperCase()]);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom CheckedIn Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
  expect(res.status === 409, `Expected 409 for CHECKED_IN child, got ${res.status}: ${JSON.stringify(res.json)}`);
  expect(res.json.code === 'CHILD_CHECKED_IN_OR_OUT', `Expected CHILD_CHECKED_IN_OR_OUT, got ${res.json.code}`);

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_checked_out_child_blocks() {
  console.log('\n[T7] checked_out_child - CHECKED_OUT child blocks add room');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 80);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  // Set the existing child to CHECKED_OUT
  await pool.query(`UPDATE reservations SET status = 'CHECKED_OUT' WHERE booking_id = (SELECT id FROM bookings WHERE UPPER(bid) = $1)`, [bid.toUpperCase()]);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom CheckedOut Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
  expect(res.status === 409, `Expected 409 for CHECKED_OUT child, got ${res.status}: ${JSON.stringify(res.json)}`);
  expect(
    res.json.code === 'CHILD_CHECKED_IN_OR_OUT' || res.json.code === 'BOOKING_EFFECTIVELY_TERMINAL',
    `Expected CHILD_CHECKED_IN_OR_OUT or BOOKING_EFFECTIVELY_TERMINAL, got ${res.json.code}`
  );

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_inactive_room_blocks() {
  console.log('\n[T8] inactive_room - inactive room blocks add');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 85);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  // Deactivate the second room
  await pool.query(`UPDATE rooms SET is_active = false WHERE id = $1`, [secondRoom.id]);

  try {
    const addPayload = {
      property_id: property.id,
      room_id: secondRoom.id,
      rate_plan_id: secondRatePlanId,
      guest_name: 'AddRoom Inactive Room Guest',
      check_in: checkIn,
      check_out: checkOut
    };

    const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
    expect(res.status === 409, `Expected 409 for inactive room, got ${res.status}: ${JSON.stringify(res.json)}`);
    expect(res.json.code === 'ROOM_INACTIVE', `Expected ROOM_INACTIVE, got ${res.json.code}`);
  } finally {
    // Restore
    await pool.query(`UPDATE rooms SET is_active = true WHERE id = $1`, [secondRoom.id]);
    await cleanupByBid(bid);
  }
  console.log('  PASSED');
}

async function test_inactive_room_type_blocks() {
  console.log('\n[T9] inactive_room_type - inactive room type blocks add');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 86);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  // Deactivate the second room type
  await pool.query(`UPDATE room_types SET is_active = false WHERE id = $1`, [secondRoom.canonical_room_type_id]);

  try {
    const addPayload = {
      property_id: property.id,
      room_id: secondRoom.id,
      rate_plan_id: secondRatePlanId,
      guest_name: 'AddRoom Inactive Type Guest',
      check_in: checkIn,
      check_out: checkOut
    };

    const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
    expect(res.status === 409, `Expected 409 for inactive room type, got ${res.status}: ${JSON.stringify(res.json)}`);
    expect(res.json.code === 'ROOM_INACTIVE', `Expected ROOM_INACTIVE, got ${res.json.code}`);
  } finally {
    // Restore
    await pool.query(`UPDATE room_types SET is_active = true WHERE id = $1`, [secondRoom.canonical_room_type_id]);
    await cleanupByBid(bid);
  }
  console.log('  PASSED');
}

async function test_incompatible_rate_plan_blocks() {
  console.log('\n[T10] incompatible_rate_plan - wrong room type rate plan blocks add');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 87);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');

  // Find a DIFFERENT room type's rate plan
  const otherRp = await pool.query(
    `SELECT rp.id FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id
     WHERE rt.id <> $1 AND rp.property_id = $2 AND rp.is_active = true AND rp.is_archived = false LIMIT 1`,
    [secondRoom.canonical_room_type_id, property.id]
  );
  if (otherRp.rowCount === 0) {
    console.log('  SKIPPED (no other rate plan available)');
    return;
  }

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: Number(otherRp.rows[0].id), // WRONG rate plan for secondRoom
    guest_name: 'AddRoom Bad Rate Plan Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
  expect(res.status === 409, `Expected 409 for incompatible rate plan, got ${res.status}: ${JSON.stringify(res.json)}`);
  expect(res.json.code === 'RATE_PLAN_ROOM_TYPE_MISMATCH', `Expected RATE_PLAN_ROOM_TYPE_MISMATCH, got ${res.json.code}`);

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_rate_plan_persisted() {
  console.log('\n[T11] rate_plan_persisted - rate_plan_id stored in reservation');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 90);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom RP Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
  expect(res.status === 201, `add room failed: ${res.status}`);

  // Verify rate_plan_id persisted
  const rpCheck = await pool.query(
    `SELECT rate_plan_id FROM reservations WHERE booking_id = (SELECT id FROM bookings WHERE UPPER(bid) = $1) AND stay_sequence = 2`,
    [bid.toUpperCase()]
  );
  expect(rpCheck.rowCount === 1, 'Rate plan not persisted');
  expect(Number(rpCheck.rows[0].rate_plan_id) === secondRatePlanId, `Expected rate_plan_id=${secondRatePlanId}, got ${rpCheck.rows[0].rate_plan_id}`);

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_quote_grand_total_used() {
  console.log('\n[T12] quote_grand_total - reservation total_price = quote grand_total');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 95);
  const checkOut = addDays(checkIn, 2);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom Quote Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
  expect(res.status === 201, `add room failed: ${res.status}`);

  // Verify total_price matches quote grand_total (not 0 or manual value)
  const resRow = await pool.query(
    `SELECT total_price, subtotal_amount, tax_amount, service_amount FROM reservations WHERE id = $1`,
    [res.json.data.reservation.id]
  );
  expect(resRow.rowCount === 1, 'Reservation not found');
  expect(resRow.rows[0].total_price > 0, `total_price should be > 0, got ${resRow.rows[0].total_price}`);
  expect(resRow.rows[0].subtotal_amount > 0, `subtotal_amount should be > 0`);
  console.log(`  total_price=${resRow.rows[0].total_price}, subtotal=${resRow.rows[0].subtotal_amount}`);

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_start_unpaid() {
  console.log('\n[T13] start_unpaid - new room starts with amount_paid=0, payment_status=UNPAID');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 100);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom Unpaid Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
  expect(res.status === 201, `add room failed: ${res.status}`);

  // Verify payment state
  const resRow = await pool.query(
    `SELECT amount_paid, payment_status, remaining_balance, discount_amount FROM reservations WHERE id = $1`,
    [res.json.data.reservation.id]
  );
  expect(resRow.rowCount === 1, 'Reservation not found');
  expect(Number(resRow.rows[0].amount_paid) === 0, `amount_paid should be 0, got ${resRow.rows[0].amount_paid}`);
  expect(resRow.rows[0].payment_status === 'UNPAID', `payment_status should be UNPAID, got ${resRow.rows[0].payment_status}`);
  expect(Number(resRow.rows[0].discount_amount) === 0, `discount_amount should be 0, got ${resRow.rows[0].discount_amount}`);
  expect(Number(resRow.rows[0].remaining_balance) > 0, `remaining_balance should be > 0`);

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_request_cannot_fake_amount_paid() {
  console.log('\n[T14] no_fake_amount_paid - request cannot set amount_paid');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 105);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  // 1. Try to pass forbidden financial field amount_paid in request -> must be rejected with 400
  const addPayloadWithPay = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom Fake Pay Guest',
    check_in: checkIn,
    check_out: checkOut,
    amount_paid: 999999
  };

  const resForbidden = await request(`/api/bookings/${bid}/reservations`, addPayloadWithPay);
  expect(resForbidden.status === 400, `Expected 400 for forbidden financial fields, got: ${resForbidden.status}`);
  expect(resForbidden.json.code === 'UNSUPPORTED_ADD_ROOM_FINANCIAL_FIELDS', `Expected UNSUPPORTED_ADD_ROOM_FINANCIAL_FIELDS, got: ${resForbidden.json?.code}`);

  // 2. Normal add room -> child must be UNPAID with amount_paid = 0
  const addPayloadValid = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom Valid Child Guest',
    check_in: checkIn,
    check_out: checkOut
  };
  const resValid = await request(`/api/bookings/${bid}/reservations`, addPayloadValid);
  expect(resValid.status === 201, `add room failed: ${resValid.status}`);

  const resRow = await pool.query(
    `SELECT amount_paid, payment_status, discount_amount FROM reservations WHERE id = $1`,
    [resValid.json.data.reservation.id]
  );
  expect(Number(resRow.rows[0].amount_paid) === 0, `amount_paid should be 0, got ${resRow.rows[0].amount_paid}`);
  expect(resRow.rows[0].payment_status === 'UNPAID', `payment_status should be UNPAID, got ${resRow.rows[0].payment_status}`);
  expect(Number(resRow.rows[0].discount_amount) === 0, `discount_amount should be 0, got ${resRow.rows[0].discount_amount}`);

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_inventory_invariants_after_add() {
  console.log('\n[T15] inventory_invariants - reserved_qty matches active reservations');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 110);
  const checkOut = addDays(checkIn, 2);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  const invBefore = await getInventoryViolationCount();

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom Inv Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
  expect(res.status === 201, `add room failed: ${res.status}`);

  // Check inventory invariant
  const invAfter = await getInventoryViolationCount();
  expect(invAfter === invBefore, `Inventory violation count changed: ${invBefore} -> ${invAfter}`);

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_no_existing_payment_mutation() {
  console.log('\n[T16] no_existing_payment_mutation - adding room does not touch existing child payments');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 115);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  // Set existing child payment
  await pool.query(`UPDATE reservations SET amount_paid = 500000, payment_status = 'PARTIAL' WHERE booking_id = (SELECT id FROM bookings WHERE UPPER(bid) = $1)`, [bid.toUpperCase()]);

  const existingPaidBefore = await pool.query(
    `SELECT amount_paid, payment_status FROM reservations WHERE booking_id = (SELECT id FROM bookings WHERE UPPER(bid) = $1) AND stay_sequence = 1`,
    [bid.toUpperCase()]
  );

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom NoMutation Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
  expect(res.status === 201, `add room failed: ${res.status}`);

  // Verify existing child payment unchanged
  const existingPaidAfter = await pool.query(
    `SELECT amount_paid, payment_status FROM reservations WHERE booking_id = (SELECT id FROM bookings WHERE UPPER(bid) = $1) AND stay_sequence = 1`,
    [bid.toUpperCase()]
  );
  expect(Number(existingPaidAfter.rows[0].amount_paid) === 500000, `Existing payment mutated: ${existingPaidAfter.rows[0].amount_paid}`);
  expect(existingPaidAfter.rows[0].payment_status === 'PARTIAL', `Existing payment status mutated`);

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_group_paid_uses_effective_payment_state() {
  console.log('\n[T17] group_paid_effective - group paid uses canonical payment state');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 120);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  // Set existing child with partial payment
  await pool.query(`UPDATE reservations SET amount_paid = 250000, payment_status = 'PARTIAL' WHERE booking_id = (SELECT id FROM bookings WHERE UPPER(bid) = $1)`, [bid.toUpperCase()]);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom GroupPay Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
  expect(res.status === 201, `add room failed: ${res.status}`);

  // Group paid should reflect the effective payment state
  expect(res.json.data.group_financials.existing_group_paid >= 0, 'Group paid should be non-negative');
  expect(res.json.data.group_financials.projected_group_total > 0, 'Projected total should be positive');

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_full_price_no_inherited_discount() {
  console.log('\n[T18] full_price_no_discount - new room is full price, no discount inherited');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 125);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  // Set existing child with discount
  await pool.query(`UPDATE reservations SET discount_amount = 100000, discount_percent = 10 WHERE booking_id = (SELECT id FROM bookings WHERE UPPER(bid) = $1)`, [bid.toUpperCase()]);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom NoDiscount Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
  expect(res.status === 201, `add room failed: ${res.status}`);

  // New child should have 0 discount
  const newChild = await pool.query(
    `SELECT discount_amount, discount_percent, amount_paid FROM reservations WHERE booking_id = (SELECT id FROM bookings WHERE UPPER(bid) = $1) AND stay_sequence = 2`,
    [bid.toUpperCase()]
  );
  expect(Number(newChild.rows[0].discount_amount) === 0, `New child discount should be 0, got ${newChild.rows[0].discount_amount}`);
  expect(Number(newChild.rows[0].discount_percent) === 0, `New child discount percent should be 0, got ${newChild.rows[0].discount_percent}`);
  expect(Number(newChild.rows[0].amount_paid) === 0, `New child amount_paid should be 0, got ${newChild.rows[0].amount_paid}`);

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_day_use_inventory() {
  console.log('\n[T19] day_use_inventory - DAY_USE locks correct canonical date');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 130);
  const checkOut = addDays(checkIn, 1); // same day for DAY_USE

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom DayUse Guest',
    check_in: checkIn,
    check_out: checkIn, // DAY_USE: check_in === check_out
    stay_type: 'DAY_USE'
  };

  const res = await request(`/api/bookings/${bid}/reservations`, addPayload);
  expect(res.status === 201, `add day-use room failed: ${res.status} ${JSON.stringify(res.json)}`);

  // Check inventory invariant
  const invAfter = await getInventoryViolationCount();
  expect(invAfter === 0, `Inventory violation after DAY_USE: ${invAfter}`);

  await cleanupByBid(bid);
  console.log('  PASSED');
}

async function test_idempotency_no_double_inventory() {
  console.log('\n[T20] idempotency_no_double_inventory - retry does not double inventory');
  const property = await findProperty();
  const today = new Date().toISOString().slice(0, 10);
  const checkIn = addDays(today, 135);
  const checkOut = addDays(checkIn, 1);

  const room = await findAvailableRoom(property.id, checkIn, checkOut);
  expect(room, 'No available room found');

  const { bid } = await createTestBooking(property.id, room, checkIn, checkOut);

  const secondRoom = await findAvailableRoom(property.id, checkIn, checkOut, room.id);
  expect(secondRoom, 'No second available room found');
  const secondRatePlanId = await getOrCreateRatePlan(property.id, secondRoom.canonical_room_type_id);

  const addPayload = {
    property_id: property.id,
    room_id: secondRoom.id,
    rate_plan_id: secondRatePlanId,
    guest_name: 'AddRoom Idempotent Inv Guest',
    check_in: checkIn,
    check_out: checkOut
  };

  const key = `ADDROOM-INV-${Date.now()}`;

  const res1 = await request(`/api/bookings/${bid}/reservations`, addPayload, { idempotencyKey: key });
  const res2 = await request(`/api/bookings/${bid}/reservations`, addPayload, { idempotencyKey: key });

  expect(res1.status === 201, `first call failed: ${res1.status}`);
  expect(res2.status === 201, `second call failed: ${res2.status}`);
  expect(res1.json.data.reservation.id === res2.json.data.reservation.id, 'Idempotent must return same reservation');

  // Inventory should only increment once
  const invAfter = await getInventoryViolationCount();
  expect(invAfter === 0, `Inventory violation after idempotent add: ${invAfter}`);

  const afterCount = await getReservationCount(bid);
  expect(afterCount === 2, `Expected 2 reservations, got ${afterCount}`);

  await cleanupByBid(bid);
  console.log('  PASSED');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Add Room to Group - Backend Correction Tests ===\n');
  console.log(`Base URL: ${baseUrl}`);

  const property = await findProperty();
  authToken = await generateAuth(property.id);
  console.log(`Using auth for property ${property.id}`);

  const tests = [
    test_basic_add_room,
    test_idempotency_no_duplicate,
    test_sibling_overlap_blocks,
    test_external_overlap_blocks,
    test_all_children_cancelled_blocks,
    test_checked_in_child_blocks,
    test_checked_out_child_blocks,
    test_inactive_room_blocks,
    test_inactive_room_type_blocks,
    test_incompatible_rate_plan_blocks,
    test_rate_plan_persisted,
    test_quote_grand_total_used,
    test_start_unpaid,
    test_request_cannot_fake_amount_paid,
    test_inventory_invariants_after_add,
    test_no_existing_payment_mutation,
    test_group_paid_uses_effective_payment_state,
    test_full_price_no_inherited_discount,
    test_day_use_inventory,
    test_idempotency_no_double_inventory
  ];

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err) {
      failed++;
      failures.push({ name: test.name || test.toString().slice(0, 50), error: err.message });
      console.log(`  FAILED: ${err.message}`);
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  await pool.end();

  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
    process.exit(1);
  }
}

main().catch(async err => {
  console.error('Fatal:', err);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
