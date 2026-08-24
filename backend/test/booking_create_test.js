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

async function request(path, body, options = {}) {
  const correlationId = options.correlationId || `BOOKING-CREATE-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Correlation-Id': correlationId
  };
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  const response = await fetchFn(`${baseUrl}${path}`, {
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
      `SELECT r.id, r.room_id, r.check_in, r.check_out, COALESCE(rt.name, rm.name) AS room_type
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

async function getInventoryViolationCount() {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM availability_dates
    WHERE reserved_qty < 0 OR reserved_qty > total_rooms
  `);
  return Number(result.rows[0]?.count || 0);
}

async function findScenario() {
  const rooms = await pool.query(`
    SELECT r.id, r.property_id, COALESCE(rt.name, r.name) AS room_type
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    WHERE COALESCE(rt.name, r.name) IS NOT NULL
    ORDER BY r.property_id, room_type, r.id
  `);

  const groups = new Map();
  for (const row of rooms.rows) {
    const key = `${row.property_id}::${row.room_type}`;
    const current = groups.get(key) || { propertyId: Number(row.property_id), roomType: String(row.room_type), roomIds: [] };
    current.roomIds.push(Number(row.id));
    groups.set(key, current);
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const group of groups.values()) {
    if (group.roomIds.length < 3) {
      continue;
    }

    for (let offset = 30; offset < 220; offset += 1) {
      const checkIn = addDays(today, offset);
      const checkOut = addDays(checkIn, 1);
      const availability = await pool.query(
        `SELECT total_rooms, reserved_qty
         FROM availability_dates
         WHERE room_type = $1 AND date = $2`,
        [group.roomType, checkIn]
      );

      if (availability.rowCount !== 1) {
        continue;
      }

      const row = availability.rows[0];
      const available = Number(row.total_rooms || 0) - Number(row.reserved_qty || 0);
      if (available < 3) {
        continue;
      }

      let conflict = false;
      for (const roomId of group.roomIds.slice(0, 3)) {
        const overlap = await pool.query(
          `SELECT 1
           FROM reservations
           WHERE room_id = $1
             AND status IN ('BOOKED', 'CHECKED_IN')
             AND check_in < $3::date
             AND check_out > $2::date
           LIMIT 1`,
          [roomId, checkIn, checkOut]
        );
        if (overlap.rowCount > 0) {
          conflict = true;
          break;
        }
      }

      if (!conflict) {
        const trialCorrelationId = `BOOKING-SCENARIO-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const trialPayload = {
          property_id: group.propertyId,
          guest_name: `${trialCorrelationId} Guest`,
          guest_phone: '081900009999',
          guest_segment: 'Reguler',
          booking_source: 'WALKIN',
          channel: 'Front Desk',
          currency_code: 'IDR',
          reservations: buildReservations(group.roomIds.slice(0, 3), checkIn, checkOut)
        };
        const trial = await request('/api/bookings', trialPayload, { correlationId: trialCorrelationId });
        if (trial.status === 201) {
          await cleanupCorrelation(trial.correlationId);
          return {
            propertyId: group.propertyId,
            roomType: group.roomType,
            roomIds: group.roomIds.slice(0, 3),
            checkIn,
            checkOut
          };
        }
      }
    }
  }

  throw new Error('Unable to find a safe booking create scenario');
}

async function createSuccessfulBooking(childCount) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const scenario = await findScenario();
    const correlationId = `BOOKING-OK-${childCount}-${Date.now()}-${attempt}`;
    const payload = {
      property_id: scenario.propertyId,
      guest_name: `${correlationId} Guest`,
      guest_phone: `08190000${String(childCount).padStart(4, '0')}`,
      guest_segment: 'Reguler',
      booking_source: 'WALKIN',
      channel: 'Front Desk',
      currency_code: 'IDR',
      reservations: buildReservations(scenario.roomIds.slice(0, childCount), scenario.checkIn, scenario.checkOut)
    };
    const result = await request('/api/bookings', payload, { correlationId });
    if (result.status === 201) {
      const data = assertCanonicalResponseShape(result, childCount);
      expect(data.property_id === scenario.propertyId, 'Property mismatch');
      await verifyCounts(result.correlationId, childCount);
      await cleanupCorrelation(result.correlationId);
      return data;
    }

    if (result.status === 409 && (String(result.text || '').includes('ROOM_OVERLAP') || String(result.text || '').includes('Not enough availability'))) {
      continue;
    }

    throw new Error(`Unexpected booking create failure: ${result.status} ${result.text}`);
  }

  throw new Error(`Unable to create a ${childCount}-room booking after retries`);
}

function buildReservations(roomIds, checkIn, checkOut) {
  return roomIds.map((roomId, index) => ({
    room_id: roomId,
    check_in: checkIn,
    check_out: checkOut,
    subtotal_amount: 150000 + index * 10000,
    total_price: 150000 + index * 10000,
    discount_amount: 0,
    discount_percent: 0,
    amount_paid: 0,
    remaining_balance: 150000 + index * 10000,
    payment_status: 'UNPAID',
    booking_type: 'WALKIN'
  }));
}

function assertCanonicalResponseShape(response, expectedCount) {
  expect(response.status === 201, `Expected 201, got ${response.status}: ${response.text}`);
  expect(response.json?.status === 'SUCCESS', `Unexpected response status: ${response.text}`);
  const data = response.json?.data;
  expect(data && typeof data === 'object', 'Missing booking data');
  expect(Array.isArray(data.reservations), 'Missing reservations array');
  expect(data.reservations.length === expectedCount, `Expected ${expectedCount} reservations`);
  expect(Number.isFinite(Number(data.booking_id)), 'Missing booking_id');
  expect(typeof data.bid === 'string' && data.bid.length > 0, 'Missing bid');
  expect(data.booking_status === 'ACTIVE', 'Booking should be ACTIVE');
  expect(response.json.correlation_id, 'Missing correlation id');
  const bookingIds = new Set(data.reservations.map((r) => Number(r.booking_id)));
  expect(bookingIds.size === 1, 'Reservations must share one booking_id');
  const bids = new Set(data.reservations.map((r) => String(r.bid || '')));
  expect(bids.size === 1, 'Reservations must share one BID');
  const sequences = data.reservations.map((r) => Number(r.stay_sequence)).sort((a, b) => a - b);
  expect(sequences.join(',') === Array.from({ length: expectedCount }, (_, i) => i + 1).join(','), 'Unexpected stay_sequence values');
  const bookingNumbers = new Set(data.reservations.map((r) => String(r.booking_number || '')));
  expect(bookingNumbers.size === expectedCount, 'Each reservation must have a unique legacy booking_number');
  return data;
}

async function verifyCounts(correlationId, childCount) {
  const bookingCount = await pool.query('SELECT COUNT(*)::int AS count FROM bookings WHERE correlation_id = $1', [correlationId]);
  const reservationCount = await pool.query('SELECT COUNT(*)::int AS count FROM reservations WHERE correlation_id = $1', [correlationId]);
  const bookingAuditCount = await pool.query(`SELECT COUNT(*)::int AS count FROM audit_logs WHERE correlation_id = $1 AND entity = 'BOOKING'`, [correlationId]);
  const reservationAuditCount = await pool.query(`SELECT COUNT(*)::int AS count FROM audit_logs WHERE correlation_id = $1 AND entity = 'RESERVATION'`, [correlationId]);
  const folioCount = await pool.query('SELECT COUNT(*)::int AS count FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE correlation_id = $1)', [correlationId]);

  expect(Number(bookingCount.rows[0]?.count || 0) === 1, 'Expected exactly one booking row');
  expect(Number(reservationCount.rows[0]?.count || 0) === childCount, 'Unexpected reservation count');
  expect(Number(bookingAuditCount.rows[0]?.count || 0) === 1, 'Expected exactly one BOOKING audit');
  expect(Number(reservationAuditCount.rows[0]?.count || 0) === childCount, 'Unexpected RESERVATION audit count');
  expect(Number(folioCount.rows[0]?.count || 0) === childCount, 'Unexpected folio count');
}

async function main() {
  const createdCorrelations = [];

  try {
    // One-room canonical create
    {
      await createSuccessfulBooking(1);
    }

    // Two-room canonical create
    {
      await createSuccessfulBooking(2);
    }

    // Three-room canonical create
    {
      await createSuccessfulBooking(3);
    }

    const scenario = await findScenario();

    // Duplicate room in request rejected
    {
      const correlationId = `BOOKING-DUP-${Date.now()}`;
      const payload = {
        property_id: scenario.propertyId,
        guest_name: `${correlationId} Guest`,
        guest_phone: '081900000004',
        guest_segment: 'Reguler',
        booking_source: 'WALKIN',
        channel: 'Front Desk',
        currency_code: 'IDR',
        reservations: buildReservations([scenario.roomIds[0], scenario.roomIds[0]], scenario.checkIn, scenario.checkOut)
      };
      const result = await request('/api/bookings', payload, { correlationId });
      expect(result.status === 409, `Expected 409 for duplicate room, got ${result.status}: ${result.text}`);
      const bookingCount = await pool.query('SELECT COUNT(*)::int AS count FROM bookings WHERE correlation_id = $1', [result.correlationId]);
      expect(Number(bookingCount.rows[0]?.count || 0) === 0, 'Duplicate request must not create a booking');
    }

    // Existing room overlap rejected
    {
      const createCorrelation = `BOOKING-OVERLAP-${Date.now()}`;
      const payload = {
        property_id: scenario.propertyId,
        guest_name: `${createCorrelation} Guest`,
        guest_phone: '081900000005',
        guest_segment: 'Reguler',
        booking_source: 'WALKIN',
        channel: 'Front Desk',
        currency_code: 'IDR',
        reservations: buildReservations([scenario.roomIds[0]], scenario.checkIn, scenario.checkOut)
      };
      const createResult = await request('/api/bookings', payload, { correlationId: createCorrelation });
      assertCanonicalResponseShape(createResult, 1);
      createdCorrelations.push(createResult.correlationId);

      const overlapResult = await request('/api/bookings', {
        property_id: scenario.propertyId,
        guest_name: `${createCorrelation} Overlap`,
        guest_phone: '081900000006',
        guest_segment: 'Reguler',
        booking_source: 'WALKIN',
        channel: 'Front Desk',
        currency_code: 'IDR',
        reservations: buildReservations([scenario.roomIds[0]], scenario.checkIn, scenario.checkOut)
      }, { correlationId: `${createCorrelation}-OVERLAP` });
      expect(overlapResult.status === 409, `Expected 409 for overlap, got ${overlapResult.status}: ${overlapResult.text}`);
      const bookingCount = await pool.query('SELECT COUNT(*)::int AS count FROM bookings WHERE correlation_id = $1', [overlapResult.correlationId]);
      expect(Number(bookingCount.rows[0]?.count || 0) === 0, 'Overlap request must not create a booking');
    }

    // Child failure rolls back the whole booking
    {
      const correlationId = `BOOKING-FAIL-${Date.now()}`;
      const payload = {
        property_id: scenario.propertyId,
        guest_name: `${correlationId} Guest`,
        guest_phone: '081900000007',
        guest_segment: 'Reguler',
        booking_source: 'WALKIN',
        channel: 'Front Desk',
        currency_code: 'IDR',
        reservations: [
          ...buildReservations([scenario.roomIds[0]], scenario.checkIn, scenario.checkOut),
          {
            room_id: 999999999,
            check_in: scenario.checkIn,
            check_out: scenario.checkOut,
            subtotal_amount: 160000,
            total_price: 160000,
            discount_amount: 0,
            discount_percent: 0,
            amount_paid: 0,
            remaining_balance: 160000,
            payment_status: 'UNPAID',
            booking_type: 'WALKIN'
          }
        ]
      };
      const result = await request('/api/bookings', payload, { correlationId });
      expect(result.status === 409, `Expected 409 for child failure, got ${result.status}: ${result.text}`);
      const bookingCount = await pool.query('SELECT COUNT(*)::int AS count FROM bookings WHERE correlation_id = $1', [result.correlationId]);
      const reservationCount = await pool.query('SELECT COUNT(*)::int AS count FROM reservations WHERE correlation_id = $1', [result.correlationId]);
      expect(Number(bookingCount.rows[0]?.count || 0) === 0, 'Child failure must not leave a booking');
      expect(Number(reservationCount.rows[0]?.count || 0) === 0, 'Child failure must not leave reservations');
    }

    // Missing availability row rolls back the whole booking
    {
      const correlationId = `BOOKING-MISSING-${Date.now()}`;
      const farCheckIn = addDays(scenario.checkIn, 400);
      const farCheckOut = addDays(farCheckIn, 1);
      const payload = {
        property_id: scenario.propertyId,
        guest_name: `${correlationId} Guest`,
        guest_phone: '081900000008',
        guest_segment: 'Reguler',
        booking_source: 'WALKIN',
        channel: 'Front Desk',
        currency_code: 'IDR',
        reservations: buildReservations([scenario.roomIds[0]], farCheckIn, farCheckOut)
      };
      const result = await request('/api/bookings', payload, { correlationId });
      expect(result.status === 409, `Expected 409 for missing availability, got ${result.status}: ${result.text}`);
      const bookingCount = await pool.query('SELECT COUNT(*)::int AS count FROM bookings WHERE correlation_id = $1', [result.correlationId]);
      expect(Number(bookingCount.rows[0]?.count || 0) === 0, 'Missing availability must not leave a booking');
    }

    // Idempotent retry creates exactly one booking
    {
      let idempotentSucceeded = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const idemScenario = await findScenario();
        const correlationId = `BOOKING-IDEM-${Date.now()}-${attempt}`;
        const idempotencyKey = `booking-idem-${Date.now()}-${attempt}`;
        const payload = {
          property_id: idemScenario.propertyId,
          guest_name: `${correlationId} Guest`,
          guest_phone: '081900000009',
          guest_segment: 'Reguler',
          booking_source: 'WALKIN',
          channel: 'Front Desk',
          currency_code: 'IDR',
          reservations: buildReservations([idemScenario.roomIds[0]], idemScenario.checkIn, idemScenario.checkOut)
        };
        const first = await request('/api/bookings', payload, { correlationId, idempotencyKey });
        if (first.status !== 201) {
          if (first.status === 409 && (String(first.text || '').includes('ROOM_OVERLAP') || String(first.text || '').includes('Not enough availability'))) {
            continue;
          }
          throw new Error(`Unexpected idempotent first response: ${first.status} ${first.text}`);
        }
        const second = await request('/api/bookings', payload, { correlationId, idempotencyKey });
        expect(second.status === 201 || second.status === 200, `Unexpected idempotent replay response: ${second.status}`);
        expect(JSON.stringify(first.json) === JSON.stringify(second.json), 'Idempotent responses must match');
        const bookingCount = await pool.query('SELECT COUNT(*)::int AS count FROM bookings WHERE correlation_id = $1', [correlationId]);
        expect(Number(bookingCount.rows[0]?.count || 0) === 1, 'Idempotent retry must create only one booking');
        createdCorrelations.push(correlationId);
        idempotentSucceeded = true;
        break;
      }
      expect(idempotentSucceeded, 'Unable to complete idempotent retry test');
    }

    // Concurrent multi-room create never exceeds capacity
    {
      let concurrencySucceeded = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const concurrencyScenario = await findScenario();
        const correlationA = `BOOKING-CONC-A-${Date.now()}-${attempt}`;
        const correlationB = `BOOKING-CONC-B-${Date.now()}-${attempt}`;
        const payload = {
          property_id: concurrencyScenario.propertyId,
          guest_name: `Concurrent Guest`,
          guest_phone: '081900000010',
          guest_segment: 'Reguler',
          booking_source: 'WALKIN',
          channel: 'Front Desk',
          currency_code: 'IDR',
          reservations: buildReservations([concurrencyScenario.roomIds[0]], concurrencyScenario.checkIn, concurrencyScenario.checkOut)
        };
        const [a, b] = await Promise.all([
          request('/api/bookings', payload, { correlationId: correlationA, idempotencyKey: `idem-a-${Date.now()}-${attempt}` }),
          request('/api/bookings', payload, { correlationId: correlationB, idempotencyKey: `idem-b-${Date.now()}-${attempt}` })
        ]);
        const successCount = [a, b].filter((item) => item.status === 201 || item.status === 200).length;
        if (successCount < 1) {
          continue;
        }
        expect(successCount <= 1, 'Concurrent create must not create more than one booking');
        const bookingCount = await pool.query(
          'SELECT COUNT(*)::int AS count FROM bookings WHERE correlation_id IN ($1, $2)',
          [correlationA, correlationB]
        );
        expect(Number(bookingCount.rows[0]?.count || 0) <= 1, 'Concurrent create must not create more than one booking');
        if (a.status === 201) {
          createdCorrelations.push(correlationA);
        }
        if (b.status === 201) {
          createdCorrelations.push(correlationB);
        }
        concurrencySucceeded = true;
        break;
      }
      expect(concurrencySucceeded, 'Unable to complete concurrency test');
    }

    for (const correlationId of createdCorrelations.reverse()) {
      await cleanupCorrelation(correlationId);
    }

    const violationCount = await getInventoryViolationCount();
    expect(violationCount === 0, `Inventory drift detected: ${violationCount}`);

    console.log('PASS: booking create integration checks passed');
  } finally {
    for (const correlationId of createdCorrelations.reverse()) {
      try {
        await cleanupCorrelation(correlationId);
      } catch (_e) {
        // ignore cleanup failures in test shutdown
      }
    }
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Booking create test failed:', error.message);
  process.exit(1);
});
