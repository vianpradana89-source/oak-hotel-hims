import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { app, pool } from '../dist/index.js';

test('GET /api/reservations/:id returns canonical room_type and room_number', async (t) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const propertyId = 1;

  // Find a room with a room type
  const roomRes = await pool.query(`
    SELECT r.id as room_id, r.room_number, rt.id as room_type_id, rt.name as room_type_name
    FROM rooms r
    JOIN room_types rt ON rt.id = r.room_type_id
    WHERE r.property_id = $1
    LIMIT 1
  `, [propertyId]);

  assert.ok(roomRes.rows.length > 0, 'Should have at least one room fixture');
  const fixtureRoom = roomRes.rows[0];

  // Insert a test booking & reservation
  const client = await pool.connect();
  let bookingId = null;
  let reservationId = null;

  try {
    await client.query('BEGIN');
    const bRes = await client.query(`
      INSERT INTO bookings (property_id, bid, booker_name, guest_name_snapshot, channel, booking_source)
      VALUES ($1, $2, $3, $3, 'FRONT_DESK', 'WALKIN')
      RETURNING id
    `, [propertyId, `TEST-BID-ROOM-INFO-${Date.now()}`, 'Test Room Info Booker']);
    bookingId = bRes.rows[0].id;

    const rRes = await client.query(`
      INSERT INTO reservations (
        booking_id, stay_sequence, guest_name, room_id, booked_room_type_id_snapshot,
        check_in, check_out, total_price, status
      )
      VALUES ($1, 1, 'Test Guest Room Info', $2, $3, '2026-09-10', '2026-09-11', 450000, 'BOOKED')
      RETURNING id
    `, [bookingId, fixtureRoom.room_id, fixtureRoom.room_type_id]);
    reservationId = rRes.rows[0].id;
    await client.query('COMMIT');

    // Fetch via API GET /api/reservations/:id
    const res = await fetch(`${baseUrl}/api/reservations/${reservationId}?property_id=${propertyId}`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.status, 'OK');
    const data = json.data;

    assert.equal(data.room_number, fixtureRoom.room_number, 'room_number must match physical room number');
    assert.equal(data.room_type, fixtureRoom.room_type_name, 'room_type must match canonical room type name');
    assert.equal(data.room_type_name, fixtureRoom.room_type_name, 'room_type_name must match canonical room type name');
    assert.equal(Number(data.room_type_id), Number(fixtureRoom.room_type_id), 'room_type_id must match canonical room type id');

    console.log('✓ GET /api/reservations/:id returned canonical room info:', {
      room_number: data.room_number,
      room_type: data.room_type,
      room_type_id: data.room_type_id
    });
  } finally {
    if (reservationId) {
      await pool.query('DELETE FROM reservations WHERE id = $1', [reservationId]);
    }
    if (bookingId) {
      await pool.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
    }
    client.release();
    server.close();
  }
});
