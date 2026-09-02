const assert = require('assert');
const { Pool } = require('pg');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { getReservationEditAvailability } = require('../dist/domains/reservations/reservationEditService');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const runId = `EAV${String(Date.now()).slice(-8)}`;
const tracked = { propertyId: null, bookingIds: [], reservationIds: [] };

async function addReservation(client, propertyId, roomId, roomTypeId, suffix, status = 'BOOKED') {
  const booking = await client.query(
    `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [propertyId, `${runId}-${suffix}`, `${runId}-${suffix}`]
  );
  tracked.bookingIds.push(booking.rows[0].id);
  const reservation = await client.query(
    `INSERT INTO reservations (
       booking_id, room_id, booked_room_type_id_snapshot, guest_name,
       check_in, check_out, total_price, remaining_balance, status, payment_status, stay_sequence
     ) VALUES ($1, $2, $3, $4, '2035-02-10', '2035-02-12', 500000, 500000, $5, 'UNPAID', 1)
     RETURNING id`,
    [booking.rows[0].id, roomId, roomTypeId, `${runId}-${suffix}`, status]
  );
  tracked.reservationIds.push(reservation.rows[0].id);
  return reservation.rows[0].id;
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
    if (tracked.propertyId) {
      await client.query('DELETE FROM audit_logs WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM room_operational_blocks WHERE property_id = $1', [tracked.propertyId]);
      await client.query(`DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = $1)`, [tracked.propertyId]);
      await client.query('DELETE FROM rooms WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM room_types WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM room_categories WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM property_pricing_settings WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM properties WHERE id = $1', [tracked.propertyId]);
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
      [runId, `A${String(Date.now()).slice(-5)}`]
    );
    tracked.propertyId = property.rows[0].id;
    const category = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active)
       VALUES ($1, 'EAVCAT', 'Availability Test', TRUE) RETURNING id`,
      [tracked.propertyId]
    );
    const standard = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity, is_active)
       VALUES ($1, $2, 'EAV-STD', 'Standard', 500000, 2, TRUE) RETURNING id`,
      [tracked.propertyId, category.rows[0].id]
    );
    const deluxe = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity, is_active)
       VALUES ($1, $2, 'EAV-DLX', 'Deluxe', 600000, 2, TRUE) RETURNING id`,
      [tracked.propertyId, category.rows[0].id]
    );
    const soldOut = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity, is_active)
       VALUES ($1, $2, 'EAV-SOLD', 'Sold Out', 700000, 2, TRUE) RETURNING id`,
      [tracked.propertyId, category.rows[0].id]
    );
    const inactiveType = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity, is_active)
       VALUES ($1, $2, 'EAV-OFF', 'Inactive', 700000, 2, FALSE) RETURNING id`,
      [tracked.propertyId, category.rows[0].id]
    );
    const insertRoom = async (roomTypeId, roomNumber, status = 'Ready', isActive = true) => {
      const room = await client.query(
        `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
         VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
        [tracked.propertyId, roomTypeId, roomNumber, status, isActive]
      );
      return room.rows[0].id;
    };
    const selfRoom = await insertRoom(standard.rows[0].id, 'S-SELF');
    const freeRoom = await insertRoom(standard.rows[0].id, 'S-FREE');
    const reservedRoom = await insertRoom(standard.rows[0].id, 'S-RES');
    const oooRoom = await insertRoom(standard.rows[0].id, 'S-OOO', 'OUT_OF_ORDER');
    const oosRoom = await insertRoom(standard.rows[0].id, 'S-OOS', 'OUT_OF_SERVICE');
    const inactiveRoom = await insertRoom(standard.rows[0].id, 'S-OFF', 'Ready', false);
    const blockedRoom = await insertRoom(deluxe.rows[0].id, 'D-BLOCK');
    const soldOutRoom = await insertRoom(soldOut.rows[0].id, 'SO-RES');
    await insertRoom(inactiveType.rows[0].id, 'I-OFF');
    const editedReservationId = await addReservation(client, tracked.propertyId, selfRoom, standard.rows[0].id, 'SELF');
    await addReservation(client, tracked.propertyId, reservedRoom, standard.rows[0].id, 'CONFLICT');
    await addReservation(client, tracked.propertyId, soldOutRoom, soldOut.rows[0].id, 'SOLD');
    await client.query(
      `INSERT INTO room_operational_blocks (property_id, room_id, room_type_id, block_type, start_date, end_date, reason, status)
       VALUES ($1, $2, $3, 'OUT_OF_SERVICE', '2035-02-10', '2035-02-12', 'Test block', 'ACTIVE')`,
      [tracked.propertyId, blockedRoom, deluxe.rows[0].id]
    );
    await client.query('COMMIT');
    transactionOpen = false;

    const availability = await getReservationEditAvailability(
      pool, editedReservationId, tracked.propertyId, '2035-02-10', '2035-02-12'
    );
    const standardResult = availability.room_types.find((type) => type.id === standard.rows[0].id);
    assert.ok(standardResult, 'active type with assignable rooms is offered');
    const standardRoomIds = standardResult.rooms.map((room) => room.id);
    assert.ok(standardRoomIds.includes(selfRoom), 'current reservation room remains available through self-exclusion');
    assert.ok(standardRoomIds.includes(freeRoom), 'free active room is offered');
    assert.ok(!standardRoomIds.includes(reservedRoom), 'overlapping booked room is excluded');
    assert.ok(!standardRoomIds.includes(oooRoom), 'OOO room is excluded');
    assert.ok(!standardRoomIds.includes(oosRoom), 'OOS room is excluded');
    assert.ok(!standardRoomIds.includes(inactiveRoom), 'inactive room is excluded');
    assert.ok(!availability.room_types.some((type) => type.id === deluxe.rows[0].id), 'blocked-only type is excluded');
    assert.ok(!availability.room_types.some((type) => type.id === soldOut.rows[0].id), 'sold-out type is excluded');
    assert.ok(!availability.room_types.some((type) => type.id === inactiveType.rows[0].id), 'inactive type is excluded');
    await client.query("UPDATE reservations SET status = 'CHECKED_IN' WHERE id = $1", [editedReservationId]);
    await assert.rejects(
      getReservationEditAvailability(pool, editedReservationId, tracked.propertyId, '2035-02-10', '2035-02-12'),
      (error) => error.code === 'BOOKED_RESERVATION_REQUIRED'
    );
    console.log('PASS: reservation edit availability projection checks passed');
  } finally {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    client.release();
    await cleanup();
    await pool.end();
  }
}

run().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
