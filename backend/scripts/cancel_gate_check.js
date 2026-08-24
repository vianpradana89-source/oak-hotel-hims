require('dotenv').config();
const { Client } = require('pg');

const fetchFn = globalThis.fetch ? globalThis.fetch : require('node-fetch');

const baseUrl = 'http://localhost:5000';
const runId = `CANCEL-GATE-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const scenarioTags = [];

const client = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toDateKeyLikeBackend(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function enumerateDatesLikeBackend(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || startStr === endStr) return [];

  const dates = [];
  const current = new Date(start);
  while (current < end) {
    dates.push(toDateKeyLikeBackend(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

async function q(sql, params) {
  return client.query(sql, params);
}

async function request(method, path, body, tag) {
  const correlationId = `${runId}${tag ? `-${tag}` : ''}`;
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
  } catch (_err) {
    json = null;
  }
  return { status: resp.status, text, json, correlationId };
}

async function getAvailability(roomType, startDate, endDate) {
  const result = await q(
    `SELECT to_char(date::date, 'YYYY-MM-DD') AS date_key, reserved_qty, total_rooms
     FROM availability_dates
     WHERE room_type = $1
       AND date >= $2::date
       AND date < $3::date
     ORDER BY date`,
    [roomType, startDate, endDate]
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(String(row.date_key), {
      reserved_qty: Number(row.reserved_qty || 0),
      total_rooms: Number(row.total_rooms || 0)
    });
  }
  return map;
}

function snapshot(map) {
  return JSON.stringify([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function findSafeWindowForRooms(roomIds, roomType, nights, neededCapacity) {
  const result = await q(
    `SELECT to_char(date::date, 'YYYY-MM-DD') AS date_key, reserved_qty, total_rooms
     FROM availability_dates
     WHERE room_type = $1
       AND date >= CURRENT_DATE + INTERVAL '7 day'
       AND date < CURRENT_DATE + INTERVAL '180 day'
     ORDER BY date`,
    [roomType]
  );

  const rows = result.rows.map((row) => ({
    date_key: String(row.date_key),
    reserved_qty: Number(row.reserved_qty || 0),
    total_rooms: Number(row.total_rooms || 0)
  }));
  const byDate = new Map(rows.map((row) => [row.date_key, row]));

  const activeReservations = await q(
    `SELECT room_id,
            to_char(check_in::date, 'YYYY-MM-DD') AS check_in_key,
            to_char(check_out::date, 'YYYY-MM-DD') AS check_out_key
     FROM reservations
     WHERE room_id = ANY($1::int[])
       AND status IN ('BOOKED', 'CHECKED_IN')`,
    [roomIds]
  );
  const activeByRoom = new Map();
  for (const row of activeReservations.rows) {
    const list = activeByRoom.get(Number(row.room_id)) || [];
    list.push({ start: String(row.check_in_key), end: String(row.check_out_key) });
    activeByRoom.set(Number(row.room_id), list);
  }

  for (const row of rows) {
    const dates = [];
    let ok = true;
    for (let i = 0; i < nights; i += 1) {
      const key = addDays(row.date_key, i);
      dates.push(key);
      const slot = byDate.get(key);
      if (!slot || (slot.total_rooms - slot.reserved_qty) < neededCapacity) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const candidateRange = { start: dates[0], end: addDays(dates[0], nights) };
      for (const roomId of roomIds) {
        const roomReservations = activeByRoom.get(Number(roomId)) || [];
        const overlaps = roomReservations.some((r) => r.start < candidateRange.end && r.end > candidateRange.start);
        if (overlaps) {
          ok = false;
          break;
        }
      }
    }
    if (ok) {
      return { checkIn: dates[0], checkOut: addDays(dates[0], nights), dates };
    }
  }

  throw new Error(`No safe window found for ${roomType} (nights=${nights}, capacity=${neededCapacity})`);
}

async function createReservation(roomId, checkIn, checkOut, tag) {
  const response = await request('POST', '/api/reservations', {
    room_id: roomId,
    guest_name: `${runId} ${tag}`,
    guest_phone: `08${String(Math.floor(Math.random() * 1e10)).padStart(10, '0').slice(0, 10)}`,
    check_in: checkIn,
    check_out: checkOut,
    total_price: 100000,
    qty: 1
  }, tag);

  assert(response.status === 201, `POST /api/reservations failed for ${tag}: ${response.status} ${response.text}`);
  assert(response.json && response.json.data, `Missing reservation payload for ${tag}`);
  return response.json.data;
}

async function cleanupScenario(tag) {
  const prefix = `${runId}-${tag}%`;
  const resRows = await q(
    `SELECT r.id, r.status, r.check_in, r.check_out, COALESCE(rt.name, rm.name) AS room_type
     FROM reservations r
     JOIN rooms rm ON rm.id = r.room_id
     LEFT JOIN room_types rt ON rt.id = rm.room_type_id
     WHERE r.correlation_id LIKE $1`,
    [prefix]
  );

  const ids = resRows.rows.map((row) => Number(row.id)).filter((n) => Number.isFinite(n));
  if (ids.length > 0) {
    for (const row of resRows.rows) {
      if (String(row.status || '').toUpperCase() === 'CANCELLED') continue;
      const dates = enumerateDatesLikeBackend(row.check_in, row.check_out);
      for (const date of dates) {
        await q(
          `UPDATE availability_dates
           SET reserved_qty = reserved_qty - 1
           WHERE room_type = $1 AND date = $2::date`,
          [row.room_type, date]
        );
      }
    }

    await q('DELETE FROM pos_order_items WHERE order_id IN (SELECT id FROM pos_orders WHERE reservation_id = ANY($1::int[]))', [ids]);
    await q('DELETE FROM pos_orders WHERE reservation_id = ANY($1::int[])', [ids]);
    await q('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [ids]);
    await q('DELETE FROM guest_receivables WHERE reservation_id = ANY($1::int[])', [ids]);
    await q('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [ids]);
    await q('DELETE FROM reservations WHERE id = ANY($1::int[])', [ids]);
  }
  await q(`DELETE FROM audit_logs WHERE correlation_id LIKE $1`, [prefix]);
  await q(`DELETE FROM bookings WHERE correlation_id LIKE $1`, [prefix]);
}

async function scenarioSingleCancel() {
  const tag = 'S1-single';
  scenarioTags.push(tag);
  const roomType = 'STD King';
  const roomId = 4;
  const window = await findSafeWindowForRooms([roomId], roomType, 2, 1);
  const baseline = await getAvailability(roomType, window.checkIn, window.checkOut);
  const created = await createReservation(roomId, window.checkIn, window.checkOut, tag);
  const bid = String(created.bid || '').toUpperCase();
  const reservationId = Number(created.id);
  const bookingId = Number(created.booking_id);

  const afterCreate = await getAvailability(roomType, window.checkIn, window.checkOut);
  for (const date of window.dates) {
    assert(afterCreate.get(date)?.reserved_qty === baseline.get(date)?.reserved_qty + 1, `Scenario 1 create did not increment once on ${date}`);
  }

  const cancel1 = await request('POST', `/api/bookings/${encodeURIComponent(bid)}/cancel`, null, `${tag}-cancel1`);
  assert(cancel1.status === 200, `Scenario 1 first cancel failed: ${cancel1.status} ${cancel1.text}`);
  assert(String(cancel1.json?.status || '').toUpperCase() === 'SUCCESS', 'Scenario 1 first cancel did not return SUCCESS');

  const afterCancel1 = await getAvailability(roomType, window.checkIn, window.checkOut);
  for (const date of window.dates) {
    assert(afterCancel1.get(date)?.reserved_qty === baseline.get(date)?.reserved_qty, `Scenario 1 inventory did not restore baseline on ${date}`);
  }

  const cancel2 = await request('POST', `/api/bookings/${encodeURIComponent(bid)}/cancel`, null, `${tag}-cancel2`);
  assert(cancel2.status === 200, `Scenario 1 second cancel failed: ${cancel2.status} ${cancel2.text}`);
  assert(String(cancel2.json?.message || '').toLowerCase().includes('already cancelled'), 'Scenario 1 second cancel did not report already cancelled');

  const afterCancel2 = await getAvailability(roomType, window.checkIn, window.checkOut);
  assert(snapshot(afterCancel1) === snapshot(afterCancel2), 'Scenario 1 inventory changed on double-cancel');

  const reservation = await q('SELECT status, stay_status FROM reservations WHERE id = $1', [reservationId]);
  assert(reservation.rows[0]?.status === 'CANCELLED', 'Scenario 1 reservation not CANCELLED');
  assert(reservation.rows[0]?.stay_status === 'CANCELLED', 'Scenario 1 stay_status not CANCELLED');

  const booking = await q('SELECT booking_status FROM bookings WHERE id = $1', [bookingId]);
  assert(booking.rows[0]?.booking_status === 'CANCELLED', 'Scenario 1 booking not CANCELLED');

  const audits = await q(
    `SELECT entity, COUNT(*)::int AS cnt
     FROM audit_logs
     WHERE correlation_id LIKE $1 AND action = 'CANCEL'
     GROUP BY entity
     ORDER BY entity`,
    [`${runId}-${tag}%`]
  );
  const auditMap = new Map(audits.rows.map((row) => [String(row.entity), Number(row.cnt)]));
  assert(auditMap.get('RESERVATION') === 1, `Scenario 1 expected 1 reservation cancel audit, got ${auditMap.get('RESERVATION') || 0}`);
  assert(auditMap.get('BOOKING') === 1, `Scenario 1 expected 1 booking cancel audit, got ${auditMap.get('BOOKING') || 0}`);

  console.log(`S1 single-cancel: PASS`);
  console.log(`  booking=${bid}`);
  console.log(`  first cancel=${cancel1.status} second cancel=${cancel2.status}`);
  console.log(`  inventory restored=YES`);

  await cleanupScenario(tag);
}

async function scenarioCheckedIn() {
  const tag = 'S2-checked-in';
  scenarioTags.push(tag);
  const roomType = 'STD King';
  const roomId = 4;
  const window = await findSafeWindowForRooms([roomId], roomType, 2, 1);
  const baseline = await getAvailability(roomType, window.checkIn, window.checkOut);
  const created = await createReservation(roomId, window.checkIn, window.checkOut, tag);
  const reservationId = Number(created.id);
  const bookingId = Number(created.booking_id);
  const bid = String(created.bid || '').toUpperCase();

  await q(`UPDATE reservations SET status = 'CHECKED_IN', stay_status = 'CHECKED_IN' WHERE id = $1`, [reservationId]);
  const before = await getAvailability(roomType, window.checkIn, window.checkOut);

  const cancel = await request('POST', `/api/bookings/${encodeURIComponent(bid)}/cancel`, null, `${tag}-cancel`);
  assert(cancel.status === 409, `Scenario 2 expected 409, got ${cancel.status} ${cancel.text}`);
  assert(String(cancel.json?.message || '').toUpperCase().includes('CHECKED_IN'), 'Scenario 2 error message missing CHECKED_IN');

  const after = await getAvailability(roomType, window.checkIn, window.checkOut);
  for (const date of window.dates) {
    assert(before.get(date)?.reserved_qty === after.get(date)?.reserved_qty, `Scenario 2 inventory changed on ${date}`);
    assert(before.get(date)?.reserved_qty === baseline.get(date)?.reserved_qty + 1, `Scenario 2 baseline not incremented as expected on ${date}`);
  }

  const reservation = await q('SELECT status, stay_status FROM reservations WHERE id = $1', [reservationId]);
  assert(reservation.rows[0]?.status === 'CHECKED_IN', 'Scenario 2 reservation mutated');
  assert(reservation.rows[0]?.stay_status === 'CHECKED_IN', 'Scenario 2 stay_status mutated');

  const booking = await q('SELECT booking_status FROM bookings WHERE id = $1', [bookingId]);
  assert(booking.rows[0]?.booking_status === 'ACTIVE', 'Scenario 2 booking mutated');

  console.log(`S2 checked-in-cancel-guard: PASS`);
  console.log(`  booking=${bid} cancel=${cancel.status}`);
  console.log(`  inventory unchanged=YES`);

  await cleanupScenario(tag);
}

async function scenarioCheckedOut() {
  const tag = 'S3-checked-out';
  scenarioTags.push(tag);
  const roomType = 'STD King';
  const roomId = 4;
  const window = await findSafeWindowForRooms([roomId], roomType, 2, 1);
  const baseline = await getAvailability(roomType, window.checkIn, window.checkOut);
  const created = await createReservation(roomId, window.checkIn, window.checkOut, tag);
  const reservationId = Number(created.id);
  const bookingId = Number(created.booking_id);
  const bid = String(created.bid || '').toUpperCase();

  await q(`UPDATE reservations SET status = 'CHECKED_OUT', stay_status = 'CHECKED_OUT' WHERE id = $1`, [reservationId]);
  const before = await getAvailability(roomType, window.checkIn, window.checkOut);

  const cancel = await request('POST', `/api/bookings/${encodeURIComponent(bid)}/cancel`, null, `${tag}-cancel`);
  assert(cancel.status === 409, `Scenario 3 expected 409, got ${cancel.status} ${cancel.text}`);
  assert(String(cancel.json?.message || '').toUpperCase().includes('CHECKED_OUT'), 'Scenario 3 error message missing CHECKED_OUT');

  const after = await getAvailability(roomType, window.checkIn, window.checkOut);
  for (const date of window.dates) {
    assert(before.get(date)?.reserved_qty === after.get(date)?.reserved_qty, `Scenario 3 inventory changed on ${date}`);
    assert(before.get(date)?.reserved_qty === baseline.get(date)?.reserved_qty + 1, `Scenario 3 baseline not incremented as expected on ${date}`);
  }

  const reservation = await q('SELECT status, stay_status FROM reservations WHERE id = $1', [reservationId]);
  assert(reservation.rows[0]?.status === 'CHECKED_OUT', 'Scenario 3 reservation mutated');
  assert(reservation.rows[0]?.stay_status === 'CHECKED_OUT', 'Scenario 3 stay_status mutated');

  const booking = await q('SELECT booking_status FROM bookings WHERE id = $1', [bookingId]);
  assert(booking.rows[0]?.booking_status === 'ACTIVE', 'Scenario 3 booking mutated');

  console.log(`S3 checked-out-cancel-guard: PASS`);
  console.log(`  booking=${bid} cancel=${cancel.status}`);
  console.log(`  inventory unchanged=YES`);

  await cleanupScenario(tag);
}

async function scenarioMultiRoomAtomic() {
  const tag = 'S4-multi-room';
  scenarioTags.push(tag);
  const roomType = 'STD King';
  const roomA = 4;
  const roomB = 5;
  const window = await findSafeWindowForRooms([roomA, roomB], roomType, 2, 2);
  const baseline = await getAvailability(roomType, window.checkIn, window.checkOut);

  const created = await createReservation(roomA, window.checkIn, window.checkOut, tag);
  const bookingId = Number(created.booking_id);
  const bid = String(created.bid || '').toUpperCase();

  await q(
    `INSERT INTO reservations (
       room_id, guest_name, guest_phone, check_in, check_out,
       booking_id, stay_sequence, total_price, payment_status,
       status, stay_status, booking_type, correlation_id, guest_segment
     ) VALUES (
       $1, $2, $3, $4::date, $5::date,
       $6, $7, $8, $9,
       'BOOKED', 'RESERVED', 'WALKIN', $10, 'Reguler'
     )`,
    [
      roomB,
      `${runId} ${tag} second`,
      `08${String(Math.floor(Math.random() * 1e10)).padStart(10, '0').slice(0, 10)}`,
      window.checkIn,
      window.checkOut,
      bookingId,
      2,
      100000,
      'UNPAID',
      `${runId}-${tag}`
    ]
  );

  for (const date of window.dates) {
    await q(`UPDATE availability_dates SET reserved_qty = reserved_qty + 1 WHERE room_type = $1 AND date = $2::date`, [roomType, date]);
  }

  const before = await getAvailability(roomType, window.checkIn, window.checkOut);
  for (const date of window.dates) {
    assert(before.get(date)?.reserved_qty === baseline.get(date)?.reserved_qty + 2, `Scenario 4 pre-cancel inventory not +2 on ${date}`);
  }

  const cancel = await request('POST', `/api/bookings/${encodeURIComponent(bid)}/cancel`, null, `${tag}-cancel`);
  assert(cancel.status === 200, `Scenario 4 cancel failed: ${cancel.status} ${cancel.text}`);
  assert(String(cancel.json?.status || '').toUpperCase() === 'SUCCESS', 'Scenario 4 cancel not SUCCESS');

  const after = await getAvailability(roomType, window.checkIn, window.checkOut);
  for (const date of window.dates) {
    assert(after.get(date)?.reserved_qty === baseline.get(date)?.reserved_qty, `Scenario 4 inventory not restored on ${date}`);
  }

  const reservations = await q('SELECT id, status, stay_status, room_id FROM reservations WHERE booking_id = $1 ORDER BY stay_sequence, id', [bookingId]);
  assert(reservations.rows.length === 2, `Scenario 4 expected 2 child reservations, got ${reservations.rows.length}`);
  assert(reservations.rows.every((r) => String(r.status).toUpperCase() === 'CANCELLED'), 'Scenario 4 not all children CANCELLED');

  const booking = await q('SELECT booking_status FROM bookings WHERE id = $1', [bookingId]);
  assert(booking.rows[0]?.booking_status === 'CANCELLED', 'Scenario 4 booking not CANCELLED');

  const audits = await q(
    `SELECT entity, COUNT(*)::int AS cnt
     FROM audit_logs
     WHERE correlation_id LIKE $1 AND action = 'CANCEL'
     GROUP BY entity
     ORDER BY entity`,
    [`${runId}-${tag}%`]
  );
  const auditMap = new Map(audits.rows.map((row) => [String(row.entity), Number(row.cnt)]));
  assert(auditMap.get('RESERVATION') === 2, `Scenario 4 expected 2 reservation cancel audits, got ${auditMap.get('RESERVATION') || 0}`);
  assert(auditMap.get('BOOKING') === 1, `Scenario 4 expected 1 booking cancel audit, got ${auditMap.get('BOOKING') || 0}`);

  console.log(`S4 multi-room-atomic-cancel: PASS`);
  console.log(`  booking=${bid}`);
  console.log(`  children=2 inventory restored=YES`);

  await cleanupScenario(tag);
}

async function scenarioPatchBlocked() {
  const tag = 'S5-patch-blocked';
  scenarioTags.push(tag);
  const roomType = 'STD King';
  const roomId = 4;
  const window = await findSafeWindowForRooms([roomId], roomType, 2, 1);
  const baseline = await getAvailability(roomType, window.checkIn, window.checkOut);
  const created = await createReservation(roomId, window.checkIn, window.checkOut, tag);
  const reservationId = Number(created.id);
  const bookingId = Number(created.booking_id);
  const bid = String(created.bid || '').toUpperCase();

  const beforePatch = await getAvailability(roomType, window.checkIn, window.checkOut);
  const patch = await request('PATCH', `/api/bookings/${encodeURIComponent(bid)}`, {
    booking_status: 'CANCELLED'
  }, `${tag}-patch`);

  assert(patch.status === 409, `Scenario 5 expected 409, got ${patch.status} ${patch.text}`);
  assert(String(patch.json?.message || '').includes('POST /api/bookings/:bid/cancel'), 'Scenario 5 did not direct to cancel endpoint');

  const afterPatch = await getAvailability(roomType, window.checkIn, window.checkOut);
  assert(snapshot(beforePatch) === snapshot(afterPatch), 'Scenario 5 inventory changed on blocked PATCH');

  const reservation = await q('SELECT status, stay_status FROM reservations WHERE id = $1', [reservationId]);
  assert(reservation.rows[0]?.status === 'BOOKED', 'Scenario 5 reservation mutated');
  assert(reservation.rows[0]?.stay_status === 'RESERVED', 'Scenario 5 stay_status mutated');

  const booking = await q('SELECT booking_status FROM bookings WHERE id = $1', [bookingId]);
  assert(booking.rows[0]?.booking_status === 'ACTIVE', 'Scenario 5 booking mutated');

  console.log(`S5 patch-cancelled-blocked: PASS`);
  console.log(`  booking=${bid} patch=${patch.status}`);
  console.log(`  inventory unchanged=YES`);

  await cleanupScenario(tag);
}

(async () => {
  await client.connect();
  try {
    await scenarioSingleCancel();
    await scenarioCheckedIn();
    await scenarioCheckedOut();
    await scenarioMultiRoomAtomic();
    await scenarioPatchBlocked();

    const driftRes = await q(`SELECT COUNT(*)::int AS drift FROM availability_dates WHERE reserved_qty < 0 OR reserved_qty > total_rooms`);
    const drift = Number(driftRes.rows[0]?.drift || 0);
    console.log(`AUTHORITY-INVENTORY-DRIFT=${drift}`);
    console.log(`OVERALL=PASS`);
  } catch (err) {
    console.error(`OVERALL=FAIL`);
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
