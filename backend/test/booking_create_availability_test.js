const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { getBookingCreateAvailability } = require('../dist/domains/reservations/reservationEditService');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
const createAvailabilityRoute = "app.get('/api/bookings/create-availability'";
const bookingByBidRoute = "app.get('/api/bookings/:bid'";
const createAvailabilityIndex = indexSrc.indexOf(createAvailabilityRoute);
const bookingByBidIndex = indexSrc.indexOf(bookingByBidRoute);
assert.ok(createAvailabilityIndex >= 0, 'GET /api/bookings/create-availability must be registered');
assert.ok(bookingByBidIndex >= 0, 'GET /api/bookings/:bid must remain registered');
assert.ok(
  createAvailabilityIndex < bookingByBidIndex,
  'GET /api/bookings/create-availability must be registered before GET /api/bookings/:bid so create-availability is not parsed as a BID'
);
assert.strictEqual(
  indexSrc.split(createAvailabilityRoute).length - 1,
  1,
  'create-availability handler must be registered exactly once'
);

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const runId = `BCA${String(Date.now()).slice(-8)}`;
const tracked = {
  propertyId: null,
  otherPropertyId: null,
  bookingIds: [],
  reservationIds: [],
  roomIds: {}
};

async function addReservation(client, propertyId, roomId, roomTypeId, suffix, fields = {}) {
  const booking = await client.query(
    `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [propertyId, `${runId}-${suffix}`, `${runId}-${suffix}`]
  );
  tracked.bookingIds.push(booking.rows[0].id);
  const reservation = await client.query(
    `INSERT INTO reservations (
       booking_id, room_id, booked_room_type_id_snapshot, guest_name,
       check_in, check_out, total_price, remaining_balance, status, payment_status, stay_sequence,
       stay_type, start_at, end_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 500000, 500000, $7, 'UNPAID', 1, $8, $9, $10)
     RETURNING id`,
    [
      booking.rows[0].id,
      roomId,
      roomTypeId,
      `${runId}-${suffix}`,
      fields.checkIn || '2035-03-10',
      fields.checkOut || '2035-03-12',
      fields.status || 'BOOKED',
      fields.stayType || 'OVERNIGHT',
      fields.startAt || null,
      fields.endAt || null
    ]
  );
  tracked.reservationIds.push(reservation.rows[0].id);
  return reservation.rows[0].id;
}

function roomIdsOf(availability, roomTypeId) {
  const type = availability.room_types.find((item) => item.id === roomTypeId);
  return type ? type.rooms.map((room) => room.id) : [];
}

async function cleanup() {
  const client = await pool.connect();
  try {
    if (tracked.reservationIds.length) {
      await client.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [tracked.reservationIds]);
    }
    if (tracked.bookingIds.length) {
      await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [tracked.bookingIds]);
    }
    const propertyIds = [tracked.propertyId, tracked.otherPropertyId].filter(Boolean);
    if (propertyIds.length) {
      await client.query('DELETE FROM audit_logs WHERE property_id = ANY($1::int[])', [propertyIds]);
      await client.query('DELETE FROM room_operational_blocks WHERE property_id = ANY($1::int[])', [propertyIds]);
      await client.query(
        'DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = ANY($1::int[]))',
        [propertyIds]
      );
      await client.query('DELETE FROM rooms WHERE property_id = ANY($1::int[])', [propertyIds]);
      await client.query('DELETE FROM room_types WHERE property_id = ANY($1::int[])', [propertyIds]);
      await client.query('DELETE FROM room_categories WHERE property_id = ANY($1::int[])', [propertyIds]);
      await client.query('DELETE FROM property_pricing_settings WHERE property_id = ANY($1::int[])', [propertyIds]);
      await client.query('DELETE FROM properties WHERE id = ANY($1::int[])', [propertyIds]);
    }
  } finally {
    client.release();
  }
}

async function run() {
  await initializeDatabase(pool);
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const property = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'Test', TRUE) RETURNING id`,
      [runId, `B${String(Date.now()).slice(-5)}`]
    );
    tracked.propertyId = property.rows[0].id;
    const otherProperty = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'Other', TRUE) RETURNING id`,
      [`${runId}-X`, `C${String(Date.now()).slice(-5)}`]
    );
    tracked.otherPropertyId = otherProperty.rows[0].id;

    const category = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active)
       VALUES ($1, 'BCACAT', 'Availability Create', TRUE) RETURNING id`,
      [tracked.propertyId]
    );
    const deluxe = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity, is_active)
       VALUES ($1, $2, 'BCA-DLX', 'Deluxe', 600000, 2, TRUE) RETURNING id`,
      [tracked.propertyId, category.rows[0].id]
    );
    const standard = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity, is_active)
       VALUES ($1, $2, 'BCA-STD', 'Standard', 500000, 2, TRUE) RETURNING id`,
      [tracked.propertyId, category.rows[0].id]
    );
    const otherCategory = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active)
       VALUES ($1, 'BCAOTH', 'Other', TRUE) RETURNING id`,
      [tracked.otherPropertyId]
    );
    const otherType = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity, is_active)
       VALUES ($1, $2, 'BCA-OTH', 'Other Deluxe', 600000, 2, TRUE) RETURNING id`,
      [tracked.otherPropertyId, otherCategory.rows[0].id]
    );

    const insertRoom = async (propertyId, roomTypeId, roomNumber, status = 'Ready', isActive = true) => {
      const room = await client.query(
        `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
         VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
        [propertyId, roomTypeId, roomNumber, status, isActive]
      );
      return room.rows[0].id;
    };

    const room101 = await insertRoom(tracked.propertyId, deluxe.rows[0].id, '101');
    const room102 = await insertRoom(tracked.propertyId, deluxe.rows[0].id, '102');
    const room103 = await insertRoom(tracked.propertyId, deluxe.rows[0].id, '103');
    const oooRoom = await insertRoom(tracked.propertyId, deluxe.rows[0].id, '104', 'OUT_OF_ORDER');
    const oosRoom = await insertRoom(tracked.propertyId, deluxe.rows[0].id, '105', 'OUT_OF_SERVICE');
    const blockedRoom = await insertRoom(tracked.propertyId, standard.rows[0].id, '201');
    const freeStandard = await insertRoom(tracked.propertyId, standard.rows[0].id, '202');
    const otherRoom = await insertRoom(tracked.otherPropertyId, otherType.rows[0].id, '901');
    tracked.roomIds = { room101, room102, room103, oooRoom, oosRoom, blockedRoom, freeStandard, otherRoom };

    await client.query(
      `INSERT INTO room_operational_blocks (property_id, room_id, room_type_id, block_type, start_date, end_date, reason, status)
       VALUES ($1, $2, $3, 'OUT_OF_SERVICE', '2035-03-10', '2035-03-12', 'Create-availability block', 'ACTIVE')`,
      [tracked.propertyId, blockedRoom, standard.rows[0].id]
    );
    await client.query('COMMIT');
    transactionOpen = false;

    const deluxeId = deluxe.rows[0].id;
    const standardId = standard.rows[0].id;

    let availability = await getBookingCreateAvailability(pool, {
      propertyId: tracked.propertyId,
      checkIn: '2035-03-10',
      checkOut: '2035-03-12',
      stayType: 'OVERNIGHT'
    });
    let deluxeRooms = roomIdsOf(availability, deluxeId);
    assert.ok(deluxeRooms.includes(room101) && deluxeRooms.includes(room102) && deluxeRooms.includes(room103), 'A: 3/3 free deluxe rooms are eligible');
    assert.ok(!deluxeRooms.includes(oooRoom), 'D: OOO room excluded');
    assert.ok(!deluxeRooms.includes(oosRoom), 'E: OOS room excluded');
    assert.ok(!roomIdsOf(availability, standardId).includes(blockedRoom), 'F: active operational block excluded');
    assert.ok(roomIdsOf(availability, standardId).includes(freeStandard), 'unblocked standard room remains');
    assert.ok(!availability.room_types.some((type) => type.rooms.some((room) => room.id === otherRoom)), 'O: other property rooms are not exposed');

    await addReservation(client, tracked.propertyId, room101, deluxeId, 'BOOKED', {
      checkIn: '2035-03-10',
      checkOut: '2035-03-12',
      status: 'BOOKED'
    });
    availability = await getBookingCreateAvailability(pool, {
      propertyId: tracked.propertyId,
      checkIn: '2035-03-10',
      checkOut: '2035-03-12',
      stayType: 'OVERNIGHT'
    });
    deluxeRooms = roomIdsOf(availability, deluxeId);
    assert.ok(!deluxeRooms.includes(room101), 'H: BOOKED room excluded');
    assert.ok(deluxeRooms.includes(room102) && deluxeRooms.includes(room103), 'B: 2/3 still leaves the type available');

    await addReservation(client, tracked.propertyId, room102, deluxeId, 'INH', {
      checkIn: '2035-03-10',
      checkOut: '2035-03-12',
      status: 'CHECKED_IN'
    });
    await addReservation(client, tracked.propertyId, room103, deluxeId, 'CAN', {
      checkIn: '2035-03-10',
      checkOut: '2035-03-12',
      status: 'CANCELLED'
    });
    availability = await getBookingCreateAvailability(pool, {
      propertyId: tracked.propertyId,
      checkIn: '2035-03-10',
      checkOut: '2035-03-12',
      stayType: 'OVERNIGHT'
    });
    deluxeRooms = roomIdsOf(availability, deluxeId);
    assert.ok(!deluxeRooms.includes(room102), 'I: CHECKED_IN room excluded');
    assert.ok(deluxeRooms.includes(room103), 'G: CANCELLED reservation does not block');

    await addReservation(client, tracked.propertyId, room103, deluxeId, 'LAST', {
      checkIn: '2035-03-10',
      checkOut: '2035-03-12',
      status: 'BOOKED'
    });
    availability = await getBookingCreateAvailability(pool, {
      propertyId: tracked.propertyId,
      checkIn: '2035-03-10',
      checkOut: '2035-03-12',
      stayType: 'OVERNIGHT'
    });
    assert.ok(!availability.room_types.some((type) => type.id === deluxeId), 'C: 3/3 occupied hides the type');

    const adjacentRoom = freeStandard;
    await addReservation(client, tracked.propertyId, adjacentRoom, standardId, 'ADJ', {
      checkIn: '2035-03-10',
      checkOut: '2035-03-12',
      status: 'BOOKED'
    });
    const adjacent = await getBookingCreateAvailability(pool, {
      propertyId: tracked.propertyId,
      checkIn: '2035-03-12',
      checkOut: '2035-03-13',
      stayType: 'OVERNIGHT'
    });
    assert.ok(roomIdsOf(adjacent, standardId).includes(adjacentRoom), 'J: adjacent overnight boundary remains eligible');
    const overlapping = await getBookingCreateAvailability(pool, {
      propertyId: tracked.propertyId,
      checkIn: '2035-03-11',
      checkOut: '2035-03-13',
      stayType: 'OVERNIGHT'
    });
    assert.ok(!roomIdsOf(overlapping, standardId).includes(adjacentRoom), 'K: overlapping overnight is excluded');

    const dayUseRoom = room101;
    await addReservation(client, tracked.propertyId, dayUseRoom, deluxeId, 'DU1', {
      checkIn: '2035-05-10',
      checkOut: '2035-05-10',
      stayType: 'DAY_USE',
      status: 'BOOKED',
      startAt: '2035-05-10T10:00:00+07:00',
      endAt: '2035-05-10T16:00:00+07:00'
    });
    const sameDayUse = await getBookingCreateAvailability(pool, {
      propertyId: tracked.propertyId,
      checkIn: '2035-05-10',
      checkOut: '2035-05-10',
      stayType: 'DAY_USE',
      startAt: '2035-05-10T10:00:00',
      endAt: '2035-05-10T16:00:00'
    });
    assert.ok(!roomIdsOf(sameDayUse, deluxeId).includes(dayUseRoom), 'L: same DAY_USE interval is blocked');

    const buffered = await getBookingCreateAvailability(pool, {
      propertyId: tracked.propertyId,
      checkIn: '2035-05-10',
      checkOut: '2035-05-10',
      stayType: 'DAY_USE',
      startAt: '2035-05-10T16:30:00',
      endAt: '2035-05-10T18:30:00'
    });
    assert.ok(!roomIdsOf(buffered, deluxeId).includes(dayUseRoom), 'M: 60-minute DAY_USE buffer still blocks 16:30 start');

    const afterBuffer = await getBookingCreateAvailability(pool, {
      propertyId: tracked.propertyId,
      checkIn: '2035-05-10',
      checkOut: '2035-05-10',
      stayType: 'DAY_USE',
      startAt: '2035-05-10T17:00:00',
      endAt: '2035-05-10T19:00:00'
    });
    assert.ok(roomIdsOf(afterBuffer, deluxeId).includes(dayUseRoom), 'M: exact 60-minute gap is allowed');

    const mixedOvernight = await getBookingCreateAvailability(pool, {
      propertyId: tracked.propertyId,
      checkIn: '2035-05-10',
      checkOut: '2035-05-11',
      stayType: 'OVERNIGHT'
    });
    assert.ok(!roomIdsOf(mixedOvernight, deluxeId).includes(dayUseRoom), 'N: overnight request is blocked by DAY_USE on that hotel date');

    const staleAfterInsert = await getBookingCreateAvailability(pool, {
      propertyId: tracked.propertyId,
      checkIn: '2035-03-10',
      checkOut: '2035-03-12',
      stayType: 'OVERNIGHT'
    });
    assert.ok(!roomIdsOf(staleAfterInsert, deluxeId).includes(room103), 'P: read model hides a room after a later BOOKED insert; create submit still uses findActiveRoomOverlap');

    console.log('PASS: booking create availability projection checks passed');
  } catch (err) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* ignore */ }
    }
    throw err;
  } finally {
    client.release();
    await cleanup();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
