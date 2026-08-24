require('dotenv').config();
const { Pool } = require('pg');

const baseUrl = (process.argv[2] || 'http://localhost:5000').replace(/\/$/, '');
const runId = `STAY-DATES-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

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
  host: process.env.DB_HOST || '127.0.0.1',
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

function hasRows(result) {
  return Number(result?.rowCount || 0) > 0;
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
    SELECT r.id, r.room_number, r.property_id, COALESCE(rt.name, r.name) AS room_type, r.status
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    ORDER BY r.id ASC
  `);
  expect(result.rows.length >= 1, 'No rooms available for stay-date test');
  return result.rows.map((row) => ({
    id: Number(row.id),
    roomNumber: String(row.room_number || ''),
    propertyId: Number(row.property_id || 0),
    roomType: String(row.room_type || ''),
    status: String(row.status || '')
  }));
}

async function ensureRoomStatusBaseline(roomId, baselineMap) {
  if (baselineMap.has(roomId)) {
    return;
  }
  const result = await pool.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
  expect(result.rows.length === 1, `Room ${roomId} not found`);
  baselineMap.set(roomId, String(result.rows[0].status || ''));
}

async function findSafeWindow(roomId, roomType, nights, minOffset, extraBufferNights = 0) {
  const active = await pool.query(
    `SELECT to_char(check_in::date, 'YYYY-MM-DD') AS check_in_key,
            to_char(check_out::date, 'YYYY-MM-DD') AS check_out_key
     FROM reservations
     WHERE room_id = $1
       AND status IN ('BOOKED', 'CHECKED_IN')`,
    [roomId]
  );
  const activeRanges = active.rows.map((row) => ({
    start: String(row.check_in_key),
    end: String(row.check_out_key)
  }));

  for (let offset = minOffset; offset < minOffset + 180; offset += 1) {
    const start = addDays(toDateKey(new Date()), offset);
    const end = addDays(start, nights);
    const safeEnd = addDays(end, extraBufferNights);
    const dates = enumerateDates(start, safeEnd);
    const availability = await pool.query(
      `SELECT to_char(date::date, 'YYYY-MM-DD') AS date_key
       FROM availability_dates
       WHERE room_type = $1
         AND date = ANY($2::date[])`,
      [roomType, dates]
    );
    if (availability.rows.length !== dates.length) {
      continue;
    }
    const hasConflict = activeRanges.some((range) => {
      return start < range.end && safeEnd > range.start;
    });
    if (!hasConflict) {
      return { start, end, safeEnd, dates };
    }
  }

  throw new Error(`Unable to find a safe window for room type ${roomType}`);
}

async function findSafeReservationContext(nights, minOffset, extraBufferNights = 0) {
  const rooms = await getRooms();
  for (const room of rooms) {
    try {
      const window = await findSafeWindow(room.id, room.roomType, nights, minOffset, extraBufferNights);
      return { room, window };
    } catch (_e) {
      continue;
    }
  }

  throw new Error('Unable to find a safe reservation context');
}

async function getAvailabilityMap(roomType, dates) {
  const result = await pool.query(
    `SELECT to_char(date::date, 'YYYY-MM-DD') AS date_key, reserved_qty
     FROM availability_dates
     WHERE room_type = $1
       AND date = ANY($2::date[])
     ORDER BY date`,
    [roomType, dates]
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(String(row.date_key), Number(row.reserved_qty || 0));
  }
  return map;
}

async function countReservationAudits(reservationId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM audit_logs
     WHERE entity = 'RESERVATION'
       AND record_id = $1::text`,
    [String(reservationId)]
  );
  return Number(result.rows[0]?.count || 0);
}

async function fetchReservationRow(reservationId) {
  const result = await pool.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
  expect(result.rows.length === 1, `Reservation ${reservationId} not found`);
  return result.rows[0];
}

async function createReservation(roomId, start, end, suffix) {
  const payload = {
    room_id: roomId,
    guest_name: `${runId} ${suffix}`,
    guest_phone: `0819${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    check_in: start,
    check_out: end,
    total_price: 120000,
    qty: 1
  };
  const result = await request('POST', '/api/reservations', payload, suffix);
  expect(result.status === 201, `${suffix} create failed: ${result.status} ${result.text}`);
  return result.json.data;
}

async function cleanupReservation(reservationId, roomStatusBaseline) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reservationResult = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    if (reservationResult.rows.length === 1) {
      const reservation = reservationResult.rows[0];
      const currentStatus = String(reservation.status || '').toUpperCase();
      if (currentStatus === 'BOOKED' || currentStatus === 'CHECKED_IN') {
        const roomTypeResult = await client.query(
          `SELECT COALESCE(rt.name, r.name) AS room_type
           FROM rooms r
           LEFT JOIN room_types rt ON rt.id = r.room_type_id
           WHERE r.id = $1`,
          [reservation.room_id]
        );
        const roomType = String(roomTypeResult.rows[0]?.room_type || '');
        const dates = enumerateDates(
          toJakartaDateKey(reservation.check_in),
          toJakartaDateKey(reservation.check_out)
        );
        for (const date of dates) {
          await client.query(
            `UPDATE availability_dates
             SET reserved_qty = reserved_qty - 1
             WHERE room_type = $1 AND date = $2`,
            [roomType, date]
          );
        }
      }

      await client.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = $2::text', ['RESERVATION', String(reservationId)]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = $1', [reservationId]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = $1', [reservationId]);
      await client.query('DELETE FROM reservations WHERE id = $1', [reservationId]);
      if (reservation.booking_id) {
        const siblings = await client.query('SELECT 1 FROM reservations WHERE booking_id = $1 LIMIT 1', [reservation.booking_id]);
        if (!hasRows(siblings)) {
          await client.query('DELETE FROM bookings WHERE id = $1', [reservation.booking_id]);
        }
      }
    }

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

async function expectReservationUnchanged(reservationId, baselineRow) {
  const result = await pool.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
  expect(result.rows.length === 1, `Reservation ${reservationId} missing`);
  const current = result.rows[0];
  expect(toJakartaDateKey(current.check_in) === toJakartaDateKey(baselineRow.check_in), 'check_in changed unexpectedly');
  expect(toJakartaDateKey(current.check_out) === toJakartaDateKey(baselineRow.check_out), 'check_out changed unexpectedly');
  expect(String(current.status) === String(baselineRow.status), 'status changed unexpectedly');
  expect(String(current.stay_status) === String(baselineRow.stay_status), 'stay_status changed unexpectedly');
}

async function main() {
  const roomStatusBaseline = new Map();
  try {
    // EXTEND one-night success
    {
      const context = await findSafeReservationContext(3, 0, 1);
      await ensureRoomStatusBaseline(context.room.id, roomStatusBaseline);
      const window = context.window;
      const reservation = await createReservation(context.room.id, window.start, window.end, 'extend-one');
      const before = await getAvailabilityMap(context.room.roomType, window.dates.concat([addDays(window.end, 0)]));
      const auditBefore = await countReservationAudits(reservation.id);
      const response = await request('POST', `/api/reservations/${reservation.id}/extend`, { new_check_out: addDays(window.end, 1) }, 'extend-one');
      expect(response.status === 200, `extend one-night failed: ${response.status} ${response.text}`);
      expect(String(response.json?.meta?.operation) === 'EXTEND', 'extend meta missing');
      const extendedRow = await pool.query('SELECT check_out FROM reservations WHERE id = $1', [reservation.id]);
      expect(extendedRow.rows.length === 1, 'extended reservation missing from DB');
      const expectedExtendedCheckOut = addDays(window.end, 1);
      expect(toJakartaDateKey(extendedRow.rows[0].check_out) === expectedExtendedCheckOut, `extend check_out not updated (expected ${expectedExtendedCheckOut}, got ${toJakartaDateKey(extendedRow.rows[0].check_out)})`);
      const afterDates = await getAvailabilityMap(context.room.roomType, [...window.dates, window.end]);
      expect(afterDates.get(window.end) === Number(before.get(window.end) || 0) + 1, 'extended night was not incremented exactly once');
      for (const date of enumerateDates(window.start, window.end)) {
        expect(afterDates.get(date) === Number(before.get(date) || 0), `retained night ${date} changed unexpectedly`);
      }
      expect(await countReservationAudits(reservation.id) === auditBefore + 1, 'extend audit was not written');
      await cleanupReservation(reservation.id, roomStatusBaseline);
    }

    // EXTEND multi-night success
    {
      const context = await findSafeReservationContext(5, 10, 3);
      await ensureRoomStatusBaseline(context.room.id, roomStatusBaseline);
      const window = context.window;
      const reservation = await createReservation(context.room.id, window.start, window.end, 'extend-multi');
      const extensionEnd = addDays(window.end, 3);
      const beforeDates = enumerateDates(window.start, extensionEnd);
      const before = await getAvailabilityMap(context.room.roomType, beforeDates);
      const response = await request('POST', `/api/reservations/${reservation.id}/extend`, { new_check_out: extensionEnd }, 'extend-multi');
      expect(response.status === 200, `extend multi-night failed: ${response.status} ${response.text}`);
      const afterDates = await getAvailabilityMap(context.room.roomType, beforeDates);
      const addedDates = enumerateDates(window.end, extensionEnd);
      for (const date of addedDates) {
        expect(afterDates.get(date) === Number(before.get(date) || 0) + 1, `added night ${date} was not incremented exactly once`);
      }
      await cleanupReservation(reservation.id, roomStatusBaseline);
    }

    // EXTEND same-day no-op and earlier-date rejection
    {
      const context = await findSafeReservationContext(2, 20);
      await ensureRoomStatusBaseline(context.room.id, roomStatusBaseline);
      const window = context.window;
      const reservation = await createReservation(context.room.id, window.start, window.end, 'extend-noop');
      const before = await getAvailabilityMap(context.room.roomType, enumerateDates(window.start, window.end));
      const auditBefore = await countReservationAudits(reservation.id);
      const noOp = await request('POST', `/api/reservations/${reservation.id}/extend`, { new_check_out: window.end }, 'extend-noop');
      expect(noOp.status === 200, `extend no-op failed: ${noOp.status} ${noOp.text}`);
      expect(noOp.json?.meta?.no_op === true, 'extend no-op flag missing');
      const after = await getAvailabilityMap(context.room.roomType, enumerateDates(window.start, window.end));
      expect(JSON.stringify([...before.entries()]) === JSON.stringify([...after.entries()]), 'extend no-op mutated inventory');
      expect(await countReservationAudits(reservation.id) === auditBefore, 'extend no-op wrote an audit unexpectedly');

      const earlier = await request('POST', `/api/reservations/${reservation.id}/extend`, { new_check_out: addDays(window.end, -1) }, 'extend-earlier');
      expect(earlier.status === 409, `extend earlier-date guard failed: ${earlier.status} ${earlier.text}`);
      await expectReservationUnchanged(reservation.id, {
        check_in: `${window.start}T00:00:00.000Z`,
        check_out: `${window.end}T00:00:00.000Z`,
        status: 'BOOKED',
        stay_status: 'RESERVED'
      });
      await cleanupReservation(reservation.id, roomStatusBaseline);
    }

    // EXTEND overlap rejection and CHECKED_IN success/status preservation
    {
      const context = await findSafeReservationContext(4, 30, 2);
      await ensureRoomStatusBaseline(context.room.id, roomStatusBaseline);
      const window = context.window;
      const base = await createReservation(context.room.id, window.start, window.end, 'extend-overlap-a');
      const conflict = await createReservation(context.room.id, window.end, addDays(window.end, 2), 'extend-overlap-b');
      const overlap = await request('POST', `/api/reservations/${base.id}/extend`, { new_check_out: addDays(window.end, 2) }, 'extend-overlap');
      expect(overlap.status === 409, `extend overlap guard failed: ${overlap.status} ${overlap.text}`);
      await cleanupReservation(base.id, roomStatusBaseline);
      await cleanupReservation(conflict.id, roomStatusBaseline);

      const checkedInContext = await findSafeReservationContext(3, 40, 1);
      await ensureRoomStatusBaseline(checkedInContext.room.id, roomStatusBaseline);
      const checkedInWindow = checkedInContext.window;
      const checkedIn = await createReservation(checkedInContext.room.id, checkedInWindow.start, checkedInWindow.end, 'extend-checkedin');
      const checkinResponse = await request('POST', `/api/reservations/${checkedIn.id}/checkin`, null, 'extend-checkedin-checkin');
      expect(checkinResponse.status === 200, `checkin setup failed: ${checkinResponse.status} ${checkinResponse.text}`);
      const before = await getAvailabilityMap(checkedInContext.room.roomType, enumerateDates(checkedInWindow.start, addDays(checkedInWindow.end, 1)));
      const auditBefore = await countReservationAudits(checkedIn.id);
      const nextCheckOut = addDays(checkedInWindow.end, 1);
      const response = await request('POST', `/api/reservations/${checkedIn.id}/extend`, { new_check_out: nextCheckOut }, 'extend-checkedin');
      expect(response.status === 200, `checked-in extend failed: ${response.status} ${response.text}`);
      expect(String(response.json?.meta?.operation) === 'EXTEND', 'checked-in extend meta missing');
      const checkedInUpdated = await fetchReservationRow(checkedIn.id);
      expect(String(checkedInUpdated.status) === 'CHECKED_IN', 'checked-in extend changed status unexpectedly');
      expect(String(checkedInUpdated.stay_status) === 'IN_HOUSE', 'checked-in extend changed stay_status unexpectedly');
      expect(
        toJakartaDateKey(checkedInUpdated.check_out) === nextCheckOut,
        `checked-in extend did not update check_out (expected ${nextCheckOut}, got ${toJakartaDateKey(checkedInUpdated.check_out)})`
      );
      expect(Array.isArray(response.json?.meta?.delta_dates) && response.json.meta.delta_dates.length === 1, 'checked-in extend delta_dates incorrect');
      expect(Number(response.json?.meta?.inventory_delta || 0) === 1, 'checked-in extend inventory_delta incorrect');
      const after = await getAvailabilityMap(checkedInContext.room.roomType, enumerateDates(checkedInWindow.start, nextCheckOut));
      expect(after.get(checkedInWindow.end) === Number(before.get(checkedInWindow.end) || 0) + 1, 'checked-in added night was not incremented exactly once');
      for (const date of enumerateDates(checkedInWindow.start, checkedInWindow.end)) {
        expect(after.get(date) === Number(before.get(date) || 0), `checked-in retained night ${date} changed unexpectedly`);
      }
      expect(await countReservationAudits(checkedIn.id) === auditBefore + 1, 'checked-in extend audit was not written');
      await cleanupReservation(checkedIn.id, roomStatusBaseline);
    }

    // SHORTEN one-night and multi-night success
    {
      const context = await findSafeReservationContext(4, 50);
      await ensureRoomStatusBaseline(context.room.id, roomStatusBaseline);
      const window = context.window;
      const reservation = await createReservation(context.room.id, window.start, window.end, 'shorten-one');
      const before = await getAvailabilityMap(context.room.roomType, enumerateDates(window.start, window.end));
      const auditBefore = await countReservationAudits(reservation.id);
      const shorterEnd = addDays(window.end, -1);
      const response = await request('POST', `/api/reservations/${reservation.id}/shorten`, { new_check_out: shorterEnd }, 'shorten-one');
      expect(response.status === 200, `shorten one-night failed: ${response.status} ${response.text}`);
      expect(String(response.json?.meta?.operation) === 'SHORTEN', 'shorten meta missing');
      const after = await getAvailabilityMap(context.room.roomType, enumerateDates(window.start, window.end));
      const released = addDays(window.end, -1);
      expect(after.get(released) === Number(before.get(released) || 0) - 1, 'shortened night was not decremented exactly once');
      expect(await countReservationAudits(reservation.id) === auditBefore + 1, 'shorten audit was not written');
      await cleanupReservation(reservation.id, roomStatusBaseline);
    }

    {
      const context = await findSafeReservationContext(5, 60);
      await ensureRoomStatusBaseline(context.room.id, roomStatusBaseline);
      const window = context.window;
      const reservation = await createReservation(context.room.id, window.start, window.end, 'shorten-multi');
      const beforeDates = enumerateDates(window.start, window.end);
      const before = await getAvailabilityMap(context.room.roomType, beforeDates);
      const shorterEnd = addDays(window.end, -3);
      const response = await request('POST', `/api/reservations/${reservation.id}/shorten`, { new_check_out: shorterEnd }, 'shorten-multi');
      expect(response.status === 200, `shorten multi-night failed: ${response.status} ${response.text}`);
      const after = await getAvailabilityMap(context.room.roomType, beforeDates);
      const removedDates = enumerateDates(shorterEnd, window.end);
      for (const date of removedDates) {
        expect(after.get(date) === Number(before.get(date) || 0) - 1, `removed night ${date} was not decremented exactly once`);
      }
      await cleanupReservation(reservation.id, roomStatusBaseline);
    }

    // SHORTEN no-op, invalid later-date, and BOOKED-only guard
    {
      const context = await findSafeReservationContext(3, 70);
      await ensureRoomStatusBaseline(context.room.id, roomStatusBaseline);
      const window = context.window;
      const reservation = await createReservation(context.room.id, window.start, window.end, 'shorten-noop');
      const before = await getAvailabilityMap(context.room.roomType, enumerateDates(window.start, window.end));
      const auditBefore = await countReservationAudits(reservation.id);
      const noOp = await request('POST', `/api/reservations/${reservation.id}/shorten`, { new_check_out: window.end }, 'shorten-noop');
      expect(noOp.status === 200, `shorten no-op failed: ${noOp.status} ${noOp.text}`);
      expect(noOp.json?.meta?.no_op === true, 'shorten no-op flag missing');
      const after = await getAvailabilityMap(context.room.roomType, enumerateDates(window.start, window.end));
      expect(JSON.stringify([...before.entries()]) === JSON.stringify([...after.entries()]), 'shorten no-op mutated inventory');
      expect(await countReservationAudits(reservation.id) === auditBefore, 'shorten no-op wrote an audit unexpectedly');

      const later = await request('POST', `/api/reservations/${reservation.id}/shorten`, { new_check_out: addDays(window.end, 1) }, 'shorten-later');
      expect(later.status === 409, `shorten later-date guard failed: ${later.status} ${later.text}`);
      await cleanupReservation(reservation.id, roomStatusBaseline);

      const checkedInContext = await findSafeReservationContext(2, 80);
      await ensureRoomStatusBaseline(checkedInContext.room.id, roomStatusBaseline);
      const checkedInWindow = checkedInContext.window;
      const checkedIn = await createReservation(checkedInContext.room.id, checkedInWindow.start, checkedInWindow.end, 'shorten-checkedin');
      const checkinResponse = await request('POST', `/api/reservations/${checkedIn.id}/checkin`, null, 'shorten-checkedin-checkin');
      expect(checkinResponse.status === 200, `checkin setup failed: ${checkinResponse.status} ${checkinResponse.text}`);
      const rejected = await request('POST', `/api/reservations/${checkedIn.id}/shorten`, { new_check_out: addDays(checkedInWindow.end, -1) }, 'shorten-checkedin');
      expect(rejected.status === 409, `checked-in shorten should fail 409: ${rejected.status} ${rejected.text}`);
      await cleanupReservation(checkedIn.id, roomStatusBaseline);
    }

    // CHECKED_IN rollback guards, terminal-state guards, and sibling isolation
    {
      const checkedInContext = await findSafeReservationContext(3, 90, 1);
      await ensureRoomStatusBaseline(checkedInContext.room.id, roomStatusBaseline);
      const checkedInWindow = checkedInContext.window;
      const checkedInReservation = await createReservation(checkedInContext.room.id, checkedInWindow.start, checkedInWindow.end, 'checkedin-guards');
      const checkinResponse = await request('POST', `/api/reservations/${checkedInReservation.id}/checkin`, null, 'checkedin-guards-checkin');
      expect(checkinResponse.status === 200, `checked-in setup failed: ${checkinResponse.status} ${checkinResponse.text}`);
      const checkedInBaseline = await fetchReservationRow(checkedInReservation.id);

      // overlap rollback
      const overlapConflict = await createReservation(checkedInContext.room.id, checkedInWindow.end, addDays(checkedInWindow.end, 1), 'checkedin-overlap-conflict');
      const overlapBefore = await getAvailabilityMap(checkedInContext.room.roomType, enumerateDates(checkedInWindow.start, addDays(checkedInWindow.end, 1)));
      const overlapAuditBefore = await countReservationAudits(checkedInReservation.id);
      const overlapResponse = await request('POST', `/api/reservations/${checkedInReservation.id}/extend`, { new_check_out: addDays(checkedInWindow.end, 1) }, 'checkedin-overlap');
      expect(overlapResponse.status === 409, `checked-in overlap should fail 409: ${overlapResponse.status} ${overlapResponse.text}`);
      const overlapAfter = await getAvailabilityMap(checkedInContext.room.roomType, enumerateDates(checkedInWindow.start, addDays(checkedInWindow.end, 1)));
      expect(JSON.stringify([...overlapBefore.entries()]) === JSON.stringify([...overlapAfter.entries()]), 'checked-in overlap request mutated inventory');
      expect(await countReservationAudits(checkedInReservation.id) === overlapAuditBefore, 'checked-in overlap request wrote an audit unexpectedly');
      await expectReservationUnchanged(checkedInReservation.id, checkedInBaseline);
      await cleanupReservation(overlapConflict.id, roomStatusBaseline);

      // capacity rollback
      const capacityContext = await findSafeReservationContext(2, 100, 1);
      await ensureRoomStatusBaseline(capacityContext.room.id, roomStatusBaseline);
      const capacityWindow = capacityContext.window;
      const capacityReservation = await createReservation(capacityContext.room.id, capacityWindow.start, capacityWindow.end, 'checkedin-capacity');
      const capacityCheckin = await request('POST', `/api/reservations/${capacityReservation.id}/checkin`, null, 'checkedin-capacity-checkin');
      expect(capacityCheckin.status === 200, `checked-in capacity setup failed: ${capacityCheckin.status} ${capacityCheckin.text}`);
      const capacityBaseline = await fetchReservationRow(capacityReservation.id);
      const capacityAddedDate = capacityWindow.end;
      const capacityBefore = await getAvailabilityMap(capacityContext.room.roomType, enumerateDates(capacityWindow.start, addDays(capacityWindow.end, 1)));
      const capacityRow = await pool.query(
        `SELECT room_type, date, total_rooms, reserved_qty
         FROM availability_dates
         WHERE room_type = $1 AND date = $2
         FOR UPDATE`,
        [capacityContext.room.roomType, capacityAddedDate]
      );
      expect(capacityRow.rows.length === 1, `availability row missing before capacity test for ${capacityContext.room.roomType} on ${capacityAddedDate}`);
      const capacitySnapshot = capacityRow.rows[0];
      await pool.query(
        'UPDATE availability_dates SET reserved_qty = total_rooms WHERE room_type = $1 AND date = $2',
        [capacityContext.room.roomType, capacityAddedDate]
      );
      const capacityResponse = await request('POST', `/api/reservations/${capacityReservation.id}/extend`, { new_check_out: addDays(capacityWindow.end, 1) }, 'checkedin-capacity');
      expect(capacityResponse.status === 409, `checked-in capacity should fail 409: ${capacityResponse.status} ${capacityResponse.text}`);
      await pool.query(
        'UPDATE availability_dates SET reserved_qty = $1 WHERE room_type = $2 AND date = $3',
        [Number(capacitySnapshot.reserved_qty || 0), capacityContext.room.roomType, capacityAddedDate]
      );
      const capacityAfter = await getAvailabilityMap(capacityContext.room.roomType, enumerateDates(capacityWindow.start, addDays(capacityWindow.end, 1)));
      expect(JSON.stringify([...capacityBefore.entries()]) === JSON.stringify([...capacityAfter.entries()]), 'checked-in capacity request mutated inventory');
      await expectReservationUnchanged(capacityReservation.id, capacityBaseline);
      await cleanupReservation(capacityReservation.id, roomStatusBaseline);

      // missing availability rollback
      const missingContext = await findSafeReservationContext(2, 110, 1);
      await ensureRoomStatusBaseline(missingContext.room.id, roomStatusBaseline);
      const missingWindow = missingContext.window;
      const missingReservation = await createReservation(missingContext.room.id, missingWindow.start, missingWindow.end, 'checkedin-missing-row');
      const missingCheckin = await request('POST', `/api/reservations/${missingReservation.id}/checkin`, null, 'checkedin-missing-row-checkin');
      expect(missingCheckin.status === 200, `checked-in missing-row setup failed: ${missingCheckin.status} ${missingCheckin.text}`);
      const missingBaseline = await fetchReservationRow(missingReservation.id);
      const missingAddedDate = missingWindow.end;
      const missingBefore = await getAvailabilityMap(missingContext.room.roomType, enumerateDates(missingWindow.start, addDays(missingWindow.end, 1)));
      const missingRow = await pool.query(
        `SELECT room_type, date, total_rooms, reserved_qty
         FROM availability_dates
         WHERE room_type = $1 AND date = $2`,
        [missingContext.room.roomType, missingAddedDate]
      );
      expect(missingRow.rows.length === 1, `availability row missing before delete test for ${missingContext.room.roomType} on ${missingAddedDate}`);
      const missingSnapshot = missingRow.rows[0];
      await pool.query(
        'DELETE FROM availability_dates WHERE room_type = $1 AND date = $2',
        [missingContext.room.roomType, missingAddedDate]
      );
      const missingResponse = await request('POST', `/api/reservations/${missingReservation.id}/extend`, { new_check_out: addDays(missingWindow.end, 1) }, 'checkedin-missing-row');
      expect(missingResponse.status === 409, `checked-in missing row should fail 409: ${missingResponse.status} ${missingResponse.text}`);
      await pool.query(
        'INSERT INTO availability_dates (room_type, date, total_rooms, reserved_qty) VALUES ($1, $2, $3, $4)',
        [missingSnapshot.room_type, missingSnapshot.date, missingSnapshot.total_rooms, missingSnapshot.reserved_qty]
      );
      const missingAfter = await getAvailabilityMap(missingContext.room.roomType, enumerateDates(missingWindow.start, addDays(missingWindow.end, 1)));
      expect(JSON.stringify([...missingBefore.entries()]) === JSON.stringify([...missingAfter.entries()]), 'checked-in missing-row request mutated inventory');
      await expectReservationUnchanged(missingReservation.id, missingBaseline);
      await cleanupReservation(missingReservation.id, roomStatusBaseline);

      // CHECKED_OUT extend guard
      const checkedOutContext = await findSafeReservationContext(2, 120, 1);
      await ensureRoomStatusBaseline(checkedOutContext.room.id, roomStatusBaseline);
      const checkedOutReservation = await createReservation(checkedOutContext.room.id, checkedOutContext.window.start, checkedOutContext.window.end, 'checkedout-guard');
      expect((await request('POST', `/api/reservations/${checkedOutReservation.id}/checkin`, null, 'checkedout-guard-checkin')).status === 200, 'checked-out guard setup check-in failed');
      expect((await request('POST', `/api/reservations/${checkedOutReservation.id}/checkout`, null, 'checkedout-guard-checkout')).status === 200, 'checked-out guard checkout failed');
      const checkedOutResponse = await request('POST', `/api/reservations/${checkedOutReservation.id}/extend`, { new_check_out: addDays(checkedOutContext.window.end, 1) }, 'checkedout-guard');
      expect(checkedOutResponse.status === 409, `checked-out extend should fail 409: ${checkedOutResponse.status} ${checkedOutResponse.text}`);
      await cleanupReservation(checkedOutReservation.id, roomStatusBaseline);

      // CANCELLED extend guard
      const cancelledContext = await findSafeReservationContext(2, 130, 1);
      await ensureRoomStatusBaseline(cancelledContext.room.id, roomStatusBaseline);
      const cancelledReservation = await createReservation(cancelledContext.room.id, cancelledContext.window.start, cancelledContext.window.end, 'cancelled-guard');
      expect((await request('POST', `/api/reservations/${cancelledReservation.id}/cancel`, null, 'cancelled-guard-cancel')).status === 200, 'cancelled guard cancel failed');
      const cancelledResponse = await request('POST', `/api/reservations/${cancelledReservation.id}/extend`, { new_check_out: addDays(cancelledContext.window.end, 1) }, 'cancelled-guard');
      expect(cancelledResponse.status === 409, `cancelled extend should fail 409: ${cancelledResponse.status} ${cancelledResponse.text}`);
      await cleanupReservation(cancelledReservation.id, roomStatusBaseline);

      // Same BID sibling isolation
      const siblingPrimary = await findSafeReservationContext(2, 140, 1);
      const siblingSecondary = await findSafeReservationContext(2, 150, 1);
      expect(Number(siblingPrimary.room.propertyId || 0) > 0, 'primary property_id missing');
      expect(siblingPrimary.room.propertyId === siblingSecondary.room.propertyId, 'sibling booking test requires the same property');
      const siblingPayload = {
        property_id: siblingPrimary.room.propertyId,
        guest_name: `${runId} parent`,
        guest_phone: `0819${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        guest_segment: 'Reguler',
        booking_source: 'walkin',
        channel: 'WALKIN',
        currency_code: 'IDR',
        reservations: [
          {
            room_id: siblingPrimary.room.id,
            check_in: siblingPrimary.window.start,
            check_out: siblingPrimary.window.end,
            total_price: 120000,
            subtotal_amount: 120000,
            discount_amount: 0,
            discount_percent: 0,
            amount_paid: 0,
            payment_status: 'UNPAID',
            qty: 1,
            booking_type: 'walkin'
          },
          {
            room_id: siblingSecondary.room.id,
            check_in: siblingSecondary.window.start,
            check_out: siblingSecondary.window.end,
            total_price: 130000,
            subtotal_amount: 130000,
            discount_amount: 0,
            discount_percent: 0,
            amount_paid: 0,
            payment_status: 'UNPAID',
            qty: 1,
            booking_type: 'walkin'
          }
        ]
      };
      const siblingBooking = await request('POST', '/api/bookings', siblingPayload, 'sibling-booking');
      expect(siblingBooking.status === 201, `sibling booking create failed: ${siblingBooking.status} ${siblingBooking.text}`);
      const siblingReservations = siblingBooking.json?.data?.reservations || [];
      expect(siblingReservations.length === 2, 'sibling booking did not return two reservations');
      const siblingTargetId = Number(siblingReservations[0].id);
      const siblingOtherId = Number(siblingReservations[1].id);
      const siblingBaseline = await fetchReservationRow(siblingOtherId);
      expect((await request('POST', `/api/reservations/${siblingTargetId}/checkin`, null, 'sibling-target-checkin')).status === 200, 'sibling target check-in failed');
      const siblingExtendResponse = await request('POST', `/api/reservations/${siblingTargetId}/extend`, { new_check_out: addDays(siblingPrimary.window.end, 1) }, 'sibling-target-extend');
      expect(siblingExtendResponse.status === 200, `sibling target extend failed: ${siblingExtendResponse.status} ${siblingExtendResponse.text}`);
      const siblingAfter = await fetchReservationRow(siblingOtherId);
      expect(toDateKey(siblingAfter.check_in) === toDateKey(siblingBaseline.check_in), 'sibling check_in changed unexpectedly');
      expect(toDateKey(siblingAfter.check_out) === toDateKey(siblingBaseline.check_out), 'sibling check_out changed unexpectedly');
      expect(String(siblingAfter.status) === String(siblingBaseline.status), 'sibling status changed unexpectedly');
      expect(String(siblingAfter.stay_status) === String(siblingBaseline.stay_status), 'sibling stay_status changed unexpectedly');
      await cleanupReservation(siblingTargetId, roomStatusBaseline);
      await cleanupReservation(siblingOtherId, roomStatusBaseline);
    }

    console.log('Reservation stay-date workflows');
    console.log('PASS | extend success, no-op, overlap guard, status guard');
    console.log('PASS | shorten success, no-op, direction guard, status guard');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Reservation stay-date test failed:', error.message);
  process.exitCode = 1;
});
