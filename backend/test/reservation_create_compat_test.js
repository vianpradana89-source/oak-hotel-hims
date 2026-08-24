const { Pool } = require('pg');

const baseUrl = (process.argv[2] || 'http://localhost:5000').replace(/\/$/, '');

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
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(dateStr, days) {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

function enumerateDates(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  const dates = [];
  const current = new Date(start);
  while (current < end) {
    dates.push(toDateKey(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

async function request(body, options = {}) {
  const correlationId = options.correlationId || `RES-COMP-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Correlation-Id': correlationId
  };
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  const response = await fetchFn(`${baseUrl}/api/reservations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_e) {
    json = null;
  }

  return { status: response.status, json, text, correlationId };
}

async function cleanupCorrelation(correlationId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reservations = await client.query(
      `SELECT r.id, r.check_in, r.check_out, COALESCE(rt.name, rm.name) AS room_type
       FROM reservations r
       JOIN rooms rm ON rm.id = r.room_id
       LEFT JOIN room_types rt ON rt.id = rm.room_type_id
       WHERE r.correlation_id = $1`,
      [correlationId]
    );

    for (const reservation of reservations.rows) {
      const dates = enumerateDates(reservation.check_in, reservation.check_out);
      for (const date of dates) {
        await client.query(
          `UPDATE availability_dates
           SET reserved_qty = GREATEST(0, reserved_qty - 1)
           WHERE room_type = $1 AND date = $2`,
          [reservation.room_type, date]
        );
      }
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

async function findScenario() {
  const rooms = await pool.query(`
    SELECT r.id, r.property_id, COALESCE(rt.name, r.name) AS room_type
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    WHERE COALESCE(rt.name, r.name) IS NOT NULL
    ORDER BY r.property_id, room_type, r.id
  `);

  expect(rooms.rowCount > 0, 'No rooms available');
  const today = new Date().toISOString().slice(0, 10);
  for (const room of rooms.rows) {
    for (let offset = 30; offset < 220; offset += 1) {
      const checkIn = addDays(today, offset);
      const checkOut = addDays(checkIn, 1);
      const availability = await pool.query(
        `SELECT total_rooms, reserved_qty
         FROM availability_dates
         WHERE room_type = $1 AND date = $2`,
        [room.room_type, checkIn]
      );
      if (availability.rowCount !== 1) {
        continue;
      }

      const row = availability.rows[0];
      if (Number(row.total_rooms || 0) - Number(row.reserved_qty || 0) < 1) {
        continue;
      }

      const overlap = await pool.query(
        `SELECT 1
         FROM reservations
         WHERE room_id = $1
           AND status IN ('BOOKED', 'CHECKED_IN')
           AND check_in < $3::date
           AND check_out > $2::date
         LIMIT 1`,
        [room.id, checkIn, checkOut]
      );

      if (overlap.rowCount === 0) {
        return {
          roomId: Number(room.id),
          propertyId: Number(room.property_id),
          roomType: String(room.room_type),
          checkIn,
          checkOut
        };
      }
    }
  }

  throw new Error('Unable to find a safe legacy reservation scenario');
}

async function captureAvailability(roomType, dates) {
  const result = await pool.query(
    `SELECT date::text AS date_key, reserved_qty
     FROM availability_dates
     WHERE room_type = $1 AND date = ANY($2::date[])
     ORDER BY date`,
    [roomType, dates]
  );
  return result.rows.map((row) => ({ date: String(row.date_key), reservedQty: Number(row.reserved_qty || 0) }));
}

function assertLegacyReservationShape(response) {
  expect(response.status === 201, `Expected 201, got ${response.status}: ${response.text}`);
  expect(response.json?.status === 'SUCCESS', `Unexpected response status: ${response.text}`);
  const data = response.json?.data;
  expect(data && typeof data === 'object', 'Missing response data');
  expect(Number.isFinite(Number(data.id)), 'Missing reservation id');
  expect(Number.isFinite(Number(data.booking_id)), 'Missing booking_id');
  expect(Number(data.stay_sequence) === 1, 'stay_sequence must be 1');
  expect(typeof data.bid === 'string' && data.bid.length > 0, 'Missing BID');
  expect(typeof data.booking_number === 'string' && data.booking_number.length > 0, 'Missing booking_number');
  expect(data.status === 'BOOKED', 'Legacy reservation should be BOOKED');
  expect(data.stay_status === 'RESERVED', 'Legacy stay_status should be RESERVED');
  expect(typeof data.correlation_id === 'string' && data.correlation_id.length > 0, 'Missing correlation id');
  return data;
}

async function main() {
  const scenario = await findScenario();
  const correlationId = `RES-COMP-${Date.now()}`;
  const dates = enumerateDates(scenario.checkIn, scenario.checkOut);
  const beforeAvailability = await captureAvailability(scenario.roomType, dates);

  try {
    const payload = {
      room_id: scenario.roomId,
      guest_name: `${correlationId} Guest`,
      guest_phone: '081900000011',
      guest_segment: 'Reguler',
      check_in: scenario.checkIn,
      check_out: scenario.checkOut,
      total_price: 175000,
      qty: 1,
      booking_type: 'WALKIN'
    };

    const result = await request(payload, { correlationId });
    const data = assertLegacyReservationShape(result);
    expect(Number(data.booking_id) > 0, 'booking_id should be positive');
    expect(result.json.lock_expires_at, 'Missing lock_expires_at');

    const bookingCount = await pool.query('SELECT COUNT(*)::int AS count FROM bookings WHERE correlation_id = $1', [result.correlationId]);
    const reservationCount = await pool.query('SELECT COUNT(*)::int AS count FROM reservations WHERE correlation_id = $1', [result.correlationId]);
    expect(Number(bookingCount.rows[0]?.count || 0) === 1, 'Expected exactly one booking parent');
    expect(Number(reservationCount.rows[0]?.count || 0) === 1, 'Expected exactly one reservation');

    const afterAvailability = await captureAvailability(scenario.roomType, dates);
    expect(afterAvailability.length === beforeAvailability.length, 'Availability snapshot mismatch');
    for (let index = 0; index < beforeAvailability.length; index += 1) {
      expect(afterAvailability[index].reservedQty === beforeAvailability[index].reservedQty + 1, 'Inventory did not increment by 1');
    }

    const booking = await pool.query('SELECT * FROM bookings WHERE id = $1', [Number(data.booking_id)]);
    expect(booking.rowCount === 1, 'Missing booking row');
    expect(String(booking.rows[0].legacy_booking_number || '') === String(data.booking_number), 'Booking legacy number should match reservation booking number');

    await cleanupCorrelation(result.correlationId);

    const afterCleanup = await captureAvailability(scenario.roomType, dates);
    for (let index = 0; index < beforeAvailability.length; index += 1) {
      expect(afterCleanup[index].reservedQty === beforeAvailability[index].reservedQty, 'Inventory did not restore after cleanup');
    }

    const orphanBooking = await pool.query('SELECT COUNT(*)::int AS count FROM bookings WHERE correlation_id = $1', [result.correlationId]);
    const orphanReservation = await pool.query('SELECT COUNT(*)::int AS count FROM reservations WHERE correlation_id = $1', [result.correlationId]);
    expect(Number(orphanBooking.rows[0]?.count || 0) === 0, 'Cleanup left an orphan booking');
    expect(Number(orphanReservation.rows[0]?.count || 0) === 0, 'Cleanup left an orphan reservation');

    const violationCount = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM availability_dates
      WHERE reserved_qty < 0 OR reserved_qty > total_rooms
    `);
    expect(Number(violationCount.rows[0]?.count || 0) === 0, 'Inventory drift detected');

    console.log('PASS: legacy reservation create compatibility checks passed');
  } finally {
    try {
      await cleanupCorrelation(correlationId);
    } catch (_e) {
      // ignore cleanup failures in test shutdown
    }
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Reservation create compat test failed:', error.message);
  process.exit(1);
});
