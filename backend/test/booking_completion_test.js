const { Pool } = require('pg');

const baseUrl = (process.argv[2] || 'http://localhost:5000').replace(/\/$/, '');
const runId = `BOOKING-COMP-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try {
    fetchFn = require('node-fetch');
  } catch (_e) {
    console.error('Global fetch is not available. Use Node 18+ or install node-fetch.');
    process.exit(1);
  }
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function toDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function toJakartaDateKey(value) {
  const date = new Date(value);
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

function addDays(dateStr, days) {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return toDateKey(dt);
}

function enumerateDates(startStr, endStr) {
  const start = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${endStr}T00:00:00Z`);
  const out = [];
  const current = new Date(start);
  while (current < end) {
    out.push(toDateKey(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return out;
}

async function request(method, path, body, suffix = '') {
  const correlationId = `${runId}${suffix ? `-${suffix}` : ''}`;
  const resp = await fetchFn(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-Id': correlationId
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_e) {
    json = null;
  }
  return { status: resp.status, text, json, correlationId };
}

async function getRooms() {
  const result = await pool.query(`
    SELECT r.id, COALESCE(rt.name, r.name) AS room_type, r.status
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    ORDER BY r.id ASC
  `);
  expect(result.rows.length >= 1, 'No rooms available for booking completion test');
  return result.rows.map((row) => ({
    id: Number(row.id),
    roomType: String(row.room_type || ''),
    status: String(row.status || '')
  }));
}

async function ensureRoomBaseline(roomId, roomStatusBaseline) {
  if (roomStatusBaseline.has(roomId)) {
    return;
  }
  const result = await pool.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
  expect(result.rows.length === 1, `Room ${roomId} not found`);
  roomStatusBaseline.set(roomId, String(result.rows[0].status || ''));
}

const SELLABLE_ROOM_STATUSES = new Set(['VACANT_CLEAN', 'READY', 'INSPECTED']);

async function findSafeContext(nights, minOffset) {
  const rooms = await getRooms();

  for (const room of rooms) {
    if (!SELLABLE_ROOM_STATUSES.has(String(room.status || '').toUpperCase())) {
      continue;
    }
    const active = await pool.query(
      `SELECT to_char(check_in::date, 'YYYY-MM-DD') AS check_in_key,
              to_char(check_out::date, 'YYYY-MM-DD') AS check_out_key
       FROM reservations
       WHERE room_id = $1
         AND status IN ('BOOKED', 'CHECKED_IN')`,
      [room.id]
    );
    const activeRanges = active.rows.map((row) => ({
      start: String(row.check_in_key),
      end: String(row.check_out_key)
    }));

    for (let offset = minOffset; offset < minOffset + 180; offset += 1) {
      const start = addDays(new Date().toISOString().slice(0, 10), offset);
      const end = addDays(start, nights);
      const dates = enumerateDates(start, end);
      const availability = await pool.query(
        `SELECT to_char(date::date, 'YYYY-MM-DD') AS date_key,
                reserved_qty,
                total_rooms
         FROM availability_dates
         WHERE room_type = $1
           AND date = ANY($2::date[])`,
        [room.roomType, dates]
      );

      if (availability.rows.length !== dates.length) {
        continue;
      }

      const hasCapacity = availability.rows.every((row) => Number(row.reserved_qty || 0) < Number(row.total_rooms || 0));
      if (!hasCapacity) {
        continue;
      }

      const hasConflict = activeRanges.some((range) => start < range.end && end > range.start);
      if (!hasConflict) {
        return { room, start, end };
      }
    }
  }

  throw new Error('Unable to find a safe booking completion context');
}

async function createBaseReservation(room, start, suffix) {
  const payload = {
    room_id: room.id,
    guest_name: `${runId} ${suffix}`,
    guest_phone: `0819${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    check_in: start,
    check_out: addDays(start, 1),
    total_price: 150000,
    qty: 1
  };

  const result = await request('POST', '/api/reservations', payload, suffix);
  expect(result.status === 201, `${suffix} create failed: ${result.status} ${result.text}`);
  return result.json.data;
}

async function insertSiblingReservation(baseReservation, room, start, suffix, initialStatus = 'BOOKED') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const checkIn = start;
    const checkOut = addDays(start, 1);
    const nights = enumerateDates(checkIn, checkOut);
    expect(nights.length === 1, `Sibling reservation must be exactly one night (${checkIn} -> ${checkOut})`);
    for (const date of nights) {
      const availability = await client.query(
        `SELECT reserved_qty, total_rooms
         FROM availability_dates
         WHERE room_type = $1 AND date = $2
         FOR UPDATE`,
        [room.roomType, date]
      );
      expect(availability.rowCount === 1, `Missing availability row for ${room.roomType} on ${date}`);
      const currentReserved = Number(availability.rows[0].reserved_qty || 0);
      const totalRooms = Number(availability.rows[0].total_rooms || 0);
      expect(currentReserved < totalRooms, `No capacity for sibling reservation on ${date}`);

      await client.query(
        `UPDATE availability_dates
         SET reserved_qty = reserved_qty + 1
         WHERE room_type = $1 AND date = $2`,
        [room.roomType, date]
      );
    }

    const bookingNumber = `${String(baseReservation.booking_number || baseReservation.legacy_booking_number || `LEG-${baseReservation.id}`)}-${suffix}`;
    const inserted = await client.query(
      `INSERT INTO reservations (
         room_id, guest_name, guest_phone, guest_segment, check_in, check_out,
         total_price, payment_status, discount_amount, discount_percent, amount_paid, remaining_balance,
         booking_number, booking_type, booking_id, stay_sequence, status, stay_status, correlation_id,
         ktp_path, bukti_bayar_path
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0, $7,
               $9, $10, $11, $12, $13, $14, $15, NULL, NULL)
       RETURNING *`,
      [
        room.id,
        `${runId} ${suffix}`,
        baseReservation.guest_phone || '081900000000',
        baseReservation.guest_segment || 'Reguler',
        checkIn,
        checkOut,
        Number(baseReservation.total_price || 150000),
        'UNPAID',
        bookingNumber,
        baseReservation.booking_type || 'WALKIN',
        baseReservation.booking_id,
        2,
        initialStatus,
        initialStatus === 'CANCELLED' ? 'CANCELLED' : 'RESERVED',
        `${runId}-${suffix}`,
      ]
    );

    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function setReservationCancelled(reservationId, roomType, start) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const nights = enumerateDates(start, addDays(start, 1));
    for (const date of nights) {
      await client.query(
        `UPDATE availability_dates
         SET reserved_qty = reserved_qty - 1
         WHERE room_type = $1 AND date = $2`,
        [roomType, date]
      );
    }
    await client.query(
      `UPDATE reservations
       SET status = 'CANCELLED',
           stay_status = 'CANCELLED'
       WHERE id = $1`,
      [reservationId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function countReservationAudit(reservationId, action) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM audit_logs
     WHERE entity = 'RESERVATION'
       AND record_id = $1::text
       AND action = $2`,
    [String(reservationId), action]
  );
  return Number(result.rows[0]?.count || 0);
}

async function countBookingAudit(bookingId, action) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM audit_logs
     WHERE entity = 'BOOKING'
       AND record_id = $1::text
       AND action = $2`,
    [String(bookingId), action]
  );
  return Number(result.rows[0]?.count || 0);
}

async function getBookingStatus(bookingId) {
  const result = await pool.query('SELECT booking_status FROM bookings WHERE id = $1', [bookingId]);
  expect(result.rows.length === 1, `Booking ${bookingId} not found`);
  return String(result.rows[0].booking_status || '').toUpperCase();
}

async function getReservationStatus(reservationId) {
  const result = await pool.query('SELECT status FROM reservations WHERE id = $1', [reservationId]);
  expect(result.rows.length === 1, `Reservation ${reservationId} not found`);
  return String(result.rows[0].status || '').toUpperCase();
}

async function cleanupBooking(bookingId, roomStatusBaseline) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reservations = await client.query('SELECT * FROM reservations WHERE booking_id = $1 FOR UPDATE', [bookingId]);
    for (const reservation of reservations.rows) {
      const status = String(reservation.status || '').toUpperCase();
      // RM-1B semantics: CHECKED_OUT nights were already released by the
      // checkout endpoint. Only stays still holding inventory (BOOKED /
      // CHECKED_IN) need a manual release here.
      if (status === 'BOOKED' || status === 'CHECKED_IN') {
        const roomTypeResult = await client.query(
          `SELECT COALESCE(rt.name, r.name) AS room_type
           FROM rooms r
           LEFT JOIN room_types rt ON rt.id = r.room_type_id
           WHERE r.id = $1`,
          [reservation.room_id]
        );
        const roomType = String(roomTypeResult.rows[0]?.room_type || '');
        const dates = enumerateDates(toJakartaDateKey(reservation.check_in), toJakartaDateKey(reservation.check_out));
        for (const date of dates) {
          await client.query(
            `UPDATE availability_dates
             SET reserved_qty = reserved_qty - 1
             WHERE room_type = $1 AND date = $2`,
            [roomType, date]
          );
        }
      }

      await client.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = $2::text', ['RESERVATION', String(reservation.id)]);
    }

    await client.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = $2::text', ['BOOKING', String(bookingId)]);
    await client.query('DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
    await client.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
    await client.query('DELETE FROM reservations WHERE booking_id = $1', [bookingId]);
    await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);

    for (const [roomId, status] of roomStatusBaseline.entries()) {
      await client.query('UPDATE rooms SET status = $1 WHERE id = $2', [status, roomId]);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const roomStatusBaseline = new Map();

  try {
    // A. single-room checkout completes parent
    {
      const context = await findSafeContext(2, 60);
      await ensureRoomBaseline(context.room.id, roomStatusBaseline);
      const reservation = await createBaseReservation(context.room, context.start, 'single');
      try {
        const response = await request('POST', `/api/reservations/${reservation.id}/checkout`, null, 'single-checkout');
        expect(response.status === 200, `single checkout failed: ${response.status} ${response.text}`);
        expect(await getBookingStatus(reservation.booking_id) === 'COMPLETED', 'single checkout did not complete parent');
        expect(await getReservationStatus(reservation.id) === 'CHECKED_OUT', 'single checkout did not close child');
        expect(await countBookingAudit(reservation.booking_id, 'COMPLETE') === 1, 'single checkout completion audit missing');
      } finally {
        await cleanupBooking(reservation.booking_id, roomStatusBaseline);
      }
    }

    // B/C. first checkout ACTIVE, final checkout COMPLETED
    {
      const context = await findSafeContext(2, 80);
      await ensureRoomBaseline(context.room.id, roomStatusBaseline);
      const baseReservation = await createBaseReservation(context.room, context.start, 'pair-base');
      const secondReservation = await insertSiblingReservation(baseReservation, context.room, addDays(context.start, 1), 'pair-second', 'BOOKED');

      try {
        const firstCheckout = await request('POST', `/api/reservations/${baseReservation.id}/checkout`, null, 'pair-first-checkout');
        expect(firstCheckout.status === 200, `pair first checkout failed: ${firstCheckout.status} ${firstCheckout.text}`);
        expect(await getBookingStatus(baseReservation.booking_id) === 'ACTIVE', 'parent should remain ACTIVE after first checkout');
        expect(await countBookingAudit(baseReservation.booking_id, 'COMPLETE') === 0, 'completion audit written too early');

        const secondCheckout = await request('POST', `/api/reservations/${secondReservation.id}/checkout`, null, 'pair-second-checkout');
        expect(secondCheckout.status === 200, `pair second checkout failed: ${secondCheckout.status} ${secondCheckout.text}`);
        expect(await getBookingStatus(baseReservation.booking_id) === 'COMPLETED', 'parent not completed after final checkout');
        expect(await countBookingAudit(baseReservation.booking_id, 'COMPLETE') === 1, 'completion audit not written exactly once');
      } finally {
        await cleanupBooking(baseReservation.booking_id, roomStatusBaseline);
      }
    }

    // D. mixed CANCELLED + CHECKED_OUT completes
    {
      const context = await findSafeContext(2, 100);
      await ensureRoomBaseline(context.room.id, roomStatusBaseline);
      const baseReservation = await createBaseReservation(context.room, context.start, 'mixed-base');
      const cancelledReservation = await insertSiblingReservation(baseReservation, context.room, addDays(context.start, 1), 'mixed-cancelled', 'BOOKED');
      await setReservationCancelled(cancelledReservation.id, context.room.roomType, addDays(context.start, 1));

      try {
        const checkout = await request('POST', `/api/reservations/${baseReservation.id}/checkout`, null, 'mixed-checkout');
        expect(checkout.status === 200, `mixed checkout failed: ${checkout.status} ${checkout.text}`);
        expect(await getBookingStatus(baseReservation.booking_id) === 'COMPLETED', 'mixed booking did not complete');
      } finally {
        await cleanupBooking(baseReservation.booking_id, roomStatusBaseline);
      }
    }

    // E. all CANCELLED remains CANCELLED
    {
      const context = await findSafeContext(2, 120);
      await ensureRoomBaseline(context.room.id, roomStatusBaseline);
      const reservation = await createBaseReservation(context.room, context.start, 'cancel-all');
      try {
        const cancel = await request('POST', `/api/bookings/${reservation.bid}/cancel`, null, 'cancel-all');
        expect(cancel.status === 200, `booking cancel failed: ${cancel.status} ${cancel.text}`);
        expect(await getBookingStatus(reservation.booking_id) === 'CANCELLED', 'all-cancelled booking not cancelled');
        expect(await countBookingAudit(reservation.booking_id, 'COMPLETE') === 0, 'cancelled booking should not have completion audit');
      } finally {
        await cleanupBooking(reservation.booking_id, roomStatusBaseline);
      }
    }

    // F/G/H. repeat checkout safe, completed booking stable, audit exactly once
    {
      const context = await findSafeContext(2, 140);
      await ensureRoomBaseline(context.room.id, roomStatusBaseline);
      const reservation = await createBaseReservation(context.room, context.start, 'repeat');
      const firstCheckout = await request('POST', `/api/reservations/${reservation.id}/checkout`, null, 'repeat-first');
      expect(firstCheckout.status === 200, `repeat first checkout failed: ${firstCheckout.status} ${firstCheckout.text}`);

      try {
        const reservationAuditBefore = await countReservationAudit(reservation.id, 'CHECK_OUT');
        const bookingAuditBefore = await countBookingAudit(reservation.booking_id, 'COMPLETE');

        const secondCheckout = await request('POST', `/api/reservations/${reservation.id}/checkout`, null, 'repeat-second');
        expect(secondCheckout.status === 200, `repeat checkout failed: ${secondCheckout.status} ${secondCheckout.text}`);
        expect(await getBookingStatus(reservation.booking_id) === 'COMPLETED', 'completed booking changed on repeat checkout');
        expect(await countReservationAudit(reservation.id, 'CHECK_OUT') === reservationAuditBefore, 'repeat checkout duplicated reservation audit');
        expect(await countBookingAudit(reservation.booking_id, 'COMPLETE') === bookingAuditBefore, 'repeat checkout duplicated completion audit');
      } finally {
        await cleanupBooking(reservation.booking_id, roomStatusBaseline);
      }
    }

    console.log('Booking completion derivation');
    console.log('PASS | single checkout completes booking');
    console.log('PASS | multi-child booking completes only on final checkout');
    console.log('PASS | mixed terminal children derive completion');
    console.log('PASS | all-cancelled booking remains cancelled');
    console.log('PASS | repeat checkout is idempotent');
    console.log('PASS | completion audit written exactly once');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Booking completion test failed:', error.message);
  process.exitCode = 1;
});
