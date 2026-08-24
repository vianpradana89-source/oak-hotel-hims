'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const fetchFn = global.fetch || require('node-fetch');
const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:5000';

const runId = `RM1C-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'secretpassword',
  database: process.env.PGDATABASE || 'oak_hotel_db'
});

function expect(condition, message) {
  if (!condition) {
    throw new Error(`ASSERT FAILED: ${message}`);
  }
}

async function request(method, path, body, correlationSuffix = '') {
  const correlationId = `${runId}${correlationSuffix ? `-${correlationSuffix}` : ''}`;
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

function jakartaDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  const jakarta = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return jakarta.toISOString().slice(0, 10);
}

function addDays(dateKey, offset) {
  const base = new Date(`${dateKey}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

async function todayJakarta(client) {
  const result = await client.query("SELECT (NOW() AT TIME ZONE 'Asia/Jakarta')::date AS d");
  return jakartaDateKey(result.rows[0].d);
}

const createdReservationIds = new Set();
const reservationOwnership = new Map();

function trackReservation(reservationId, roomTypeName, checkIn, checkOut) {
  createdReservationIds.add(Number(reservationId));
  const nights = [];
  let cursor = checkIn;
  while (cursor < checkOut) {
    nights.push(`${roomTypeName}::${cursor}`);
    cursor = addDays(cursor, 1);
  }
  reservationOwnership.set(Number(reservationId), {
    ownedNights: nights,
    releasedNights: new Set()
  });
}

function markReleased(reservationId) {
  const record = reservationOwnership.get(Number(reservationId));
  expect(record, `ownership record missing for reservation ${reservationId}`);
  for (const nightKey of record.ownedNights) {
    record.releasedNights.add(nightKey);
  }
}

const createdRoomIds = new Set();
const createdTypeIds = new Set();
const sharedRoomBaseline = new Map();
const availabilityBaseline = new Map();

async function snapshotSharedRooms(client, roomIds) {
  const rows = await client.query('SELECT id, status, COALESCE(is_active, TRUE) AS is_active FROM rooms WHERE id = ANY($1::int[])', [roomIds]);
  for (const row of rows.rows) {
    sharedRoomBaseline.set(Number(row.id), { status: String(row.status), is_active: Boolean(row.is_active) });
  }
}

async function snapshotAvailability(client, roomTypeNames, startDate, endDateExclusive) {
  const rows = await client.query(
    `SELECT room_type,
            to_char(date::date, 'YYYY-MM-DD') AS date_key,
            reserved_qty, total_rooms
     FROM availability_dates
     WHERE room_type = ANY($1::text[])
       AND date >= $2::date AND date < $3::date`,
    [roomTypeNames, startDate, endDateExclusive]
  );
  for (const row of rows.rows) {
    availabilityBaseline.set(`${row.room_type}::${row.date_key}`, {
      reserved_qty: Number(row.reserved_qty),
      total_rooms: Number(row.total_rooms)
    });
  }
}

function registerBaselineEntry(roomTypeName, dateKey, reservedQty, totalRooms) {
  const existing = availabilityBaseline.get(`${roomTypeName}::${dateKey}`);
  if (!existing) {
    availabilityBaseline.set(`${roomTypeName}::${dateKey}`, {
      reserved_qty: Number(reservedQty),
      total_rooms: Number(totalRooms)
    });
  }
}

async function reconcileLedgerAndCleanup(client, fixtureTypeId, fixtureDateKey) {
  await client.query('BEGIN');
  try {
    const runRows = await client.query(
      `SELECT id FROM reservations WHERE guest_name LIKE $1 OR correlation_id LIKE $2`,
      [`${runId}%`, `${runId}%`]
    );
    const trackedIds = Array.from(createdReservationIds.values());
    const reservationIds = Array.from(new Set([
      ...trackedIds,
      ...runRows.rows.map((r) => Number(r.id)).filter(Number.isFinite)
    ]));

    if (reservationIds.length > 0) {
      await client.query('SELECT id FROM reservations WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [reservationIds]);

      const unreleased = new Map();
      for (const reservationId of reservationIds) {
        const record = reservationOwnership.get(Number(reservationId));
        expect(record, `cleanup ownership missing for reservation ${reservationId}`);
        for (const nightKey of record.ownedNights) {
          if (record.releasedNights.has(nightKey)) continue;
          unreleased.set(nightKey, (unreleased.get(nightKey) || 0) + 1);
        }
      }

      for (const [nightKey, delta] of unreleased.entries()) {
        const [roomTypeName, dateKey] = nightKey.split('::');
        const current = await client.query(
          'SELECT reserved_qty FROM availability_dates WHERE room_type = $1 AND date = $2::date FOR UPDATE',
          [roomTypeName, dateKey]
        );
        expect(current.rowCount === 1, `cleanup availability row missing for ${nightKey}`);
        const currentReserved = Number(current.rows[0].reserved_qty || 0);
        const baselineKey = `${roomTypeName}::${dateKey}`;
        const baselineRow = availabilityBaseline.get(baselineKey);
        expect(baselineRow, `cleanup baseline missing for ${baselineKey}`);
        expect(currentReserved - Number(baselineRow.reserved_qty) === delta,
          `ledger mismatch on ${baselineKey}: excess=${currentReserved - Number(baselineRow.reserved_qty)} expected=${delta}`);
        await client.query(
          'UPDATE availability_dates SET reserved_qty = reserved_qty - $1 WHERE room_type = $2 AND date = $3::date',
          [delta, roomTypeName, dateKey]
        );
      }

      await client.query('DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[])', [reservationIds]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [reservationIds]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [reservationIds]);
      await client.query('DELETE FROM guest_receivables WHERE reservation_id = ANY($1::int[])', [reservationIds]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [reservationIds]);
    }

    const bookingRows = await client.query(
      `SELECT DISTINCT b.id FROM bookings b
       LEFT JOIN reservations r ON r.booking_id = b.id
       WHERE b.correlation_id LIKE $1 OR b.guest_name_snapshot LIKE $2`,
      [`${runId}%`, `${runId}%`]
    );
    for (const row of bookingRows.rows) {
      await client.query(
        `DELETE FROM bookings b WHERE b.id = $1
           AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.booking_id = b.id)`,
        [Number(row.id)]
      );
    }
    const bookingResidue = await client.query(
      'SELECT COUNT(*)::int AS c FROM bookings WHERE correlation_id LIKE $1 OR guest_name_snapshot LIKE $2',
      [`${runId}%`, `${runId}%`]
    );
    expect(bookingResidue.rows[0].c === 0, `booking residue remains for ${runId}`);

    for (const [roomId, baseline] of sharedRoomBaseline.entries()) {
      await client.query(
        'UPDATE rooms SET status = $1, is_active = $2 WHERE id = $3',
        [baseline.status, baseline.is_active, roomId]
      );
    }

    if (createdRoomIds.size > 0) {
      await client.query(
        'DELETE FROM rooms WHERE id = ANY($1::int[]) AND room_number LIKE \'RM1C-%\'',
        [Array.from(createdRoomIds)]
      );
    }
    if (createdTypeIds.size > 0) {
      await client.query(
        'DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[])',
        [Array.from(createdTypeIds)]
      );
      await client.query(
        'DELETE FROM room_types WHERE id = ANY($1::int[]) AND code LIKE \'RM1C-%\'',
        [Array.from(createdTypeIds)]
      );
    }

    await client.query(
      'DELETE FROM audit_logs WHERE correlation_id LIKE $1',
      [`${runId}%`]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function verifyPostCleanup() {
  const checks = [
    ['reservations', 'guest_name LIKE $1 OR correlation_id LIKE $2'],
    ['bookings', 'correlation_id LIKE $1 OR guest_name_snapshot LIKE $2'],
    ['rooms', "room_number LIKE 'RM1C-%'"],
    ['room_types', "code LIKE 'RM1C-%'"]
  ];
  for (const [table, predicate] of checks) {
    const params = table === 'reservations' || table === 'bookings' ? [`%${runId}%`, `${runId}%`] : [];
    const result = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${predicate}`, params);
    expect(result.rows[0].c === 0, `residue in ${table} for run ${runId}: ${result.rows[0].c}`);
  }

  const drift = await pool.query(`
    SELECT COUNT(*)::int AS drift_count
    FROM availability_dates ad
    LEFT JOIN (
      SELECT rm.room_type_id, g.d::date AS day, COUNT(*) AS active
      FROM reservations r
      JOIN rooms rm ON rm.id = r.room_id
      CROSS JOIN LATERAL generate_series(r.check_in, r.check_out - INTERVAL '1 day', INTERVAL '1 day') g(d)
      WHERE r.status IN ('BOOKED','CHECKED_IN') AND rm.room_type_id IS NOT NULL
      GROUP BY 1, 2
    ) e ON e.room_type_id = ad.room_type_id AND e.day = ad.date::date
    WHERE ad.reserved_qty <> COALESCE(e.active, 0)
  `);
  expect(drift.rows[0].drift_count === 0, `inventory drift detected after cleanup: ${drift.rows[0].drift_count}`);

  const negatives = await pool.query('SELECT COUNT(*)::int AS c FROM availability_dates WHERE reserved_qty < 0');
  expect(negatives.rows[0].c === 0, `negative reserved_qty rows after cleanup: ${negatives.rows[0].c}`);

  const overCap = await pool.query('SELECT COUNT(*)::int AS c FROM availability_dates WHERE reserved_qty > total_rooms');
  expect(overCap.rows[0].c === 0, `over-capacity rows after cleanup: ${overCap.rows[0].c}`);
}

async function run() {
  const client = await pool.connect();
  const results = [];
  const mark = (label, ok, detail = '') => {
    results.push({ label, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };

  let fixtureTypeId = null;
  let fixtureDateKey = null;
  let typeOne = null;
  let typeTwo = null;
  let roomOne = null;
  let roomTwo = null;
  let originalRooms = [];

  try {
    const today = await todayJakarta(client);

    const originalsResult = await request('GET', '/api/rooms');
    expect(originalsResult.status === 200, `GET /api/rooms failed: ${originalsResult.status}`);
    originalRooms = originalsResult.json.data || [];
    expect(originalRooms.length >= 9, `expected at least 9 original rooms, got ${originalRooms.length}`);

    const prtRoom107 = originalRooms.find((r) => String(r.room_number) === '107');
    expect(prtRoom107, 'original room 107 (Premiere Twin) not found');
    await snapshotSharedRooms(client, [Number(prtRoom107.id)]);
    await snapshotAvailability(client, ['Premiere Twin', 'STD King'], addDays(today, 1), addDays(today, 45));

    // A. Room type create + validation
    {
      const created = await request('POST', '/api/room-types', {
        code: 'RM1C-T1',
        name: 'RM1C Suite One',
        description: `${runId} fixture suite`,
        capacity: 3,
        max_adults: 2,
        max_children: 1,
        bed_type: 'King',
        base_rate: 450000,
        display_order: 50
      });
      expect(created.status === 201, `A type create must be 201, got ${created.status} ${created.text}`);
      typeOne = created.json.data;
      createdTypeIds.add(Number(typeOne.id));
      expect(typeOne.is_active === true, 'A new type must default is_active=true');
      expect(Number(typeOne.max_adults) === 2, 'A max_adults must persist');

      const duplicate = await request('POST', '/api/room-types', { code: 'RM1C-T1', name: 'Dup', capacity: 2 });
      expect(duplicate.status === 409, `A duplicate code must be 409, got ${duplicate.status}`);
      expect(duplicate.json?.code === 'ROOM_TYPE_CODE_EXISTS', 'A duplicate code payload must carry ROOM_TYPE_CODE_EXISTS');

      const badCode = await request('POST', '/api/room-types', { code: 'BAD CODE!', name: 'Bad', capacity: 2 });
      expect(badCode.status === 400, `A invalid code format must be 400, got ${badCode.status}`);

      const badOccupancy = await request('POST', '/api/room-types', { code: 'RM1C-BAD', name: 'Bad', capacity: 2, max_adults: 5 });
      expect(badOccupancy.status === 400, `A max_adults>capacity must be 400, got ${badOccupancy.status}`);
      mark('A. room type create + validation', true);
    }

    // B. Room type read endpoints
    {
      const list = await request('GET', '/api/room-types');
      expect(list.status === 200, `B list failed: ${list.status}`);
      const listed = (list.json.data || []).find((t) => Number(t.id) === Number(typeOne.id));
      expect(listed, 'B created type must appear in list');
      expect(Number(listed.physical_room_count) === 0, `B physical_room_count must start at 0, got ${listed.physical_room_count}`);

      const detail = await request('GET', `/api/room-types/${typeOne.id}`);
      expect(detail.status === 200 && detail.json.data.code === 'RM1C-T1', 'B detail fetch failed');

      const missing = await request('GET', '/api/room-types/999999');
      expect(missing.status === 404, `B missing type must be 404, got ${missing.status}`);
      mark('B. room type read endpoints', true);
    }

    // C. Room type update
    {
      const updated = await request('PATCH', `/api/room-types/${typeOne.id}`, {
        name: 'RM1C Suite One Renamed',
        description: `${runId} renamed`
      });
      expect(updated.status === 200, `C update failed: ${updated.status} ${updated.text}`);
      expect(updated.json.data.name === 'RM1C Suite One Renamed', 'C name must persist');
      expect(updated.json.data.updated_at !== null, 'C updated_at must be set');

      const noFields = await request('PATCH', `/api/room-types/${typeOne.id}`, {});
      expect(noFields.status === 400, `C empty patch must be 400, got ${noFields.status}`);
      mark('C. room type update', true);
    }

    // D. Capacity decrease guard via future reserved peak
    {
      fixtureDateKey = addDays(today, 6);
      const seeded = await pool.query(
        `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
         VALUES ($1, $2, $3::date, 5, 3)
         RETURNING id`,
        [typeOne.id, 'RM1C Suite One Renamed', fixtureDateKey]
      );
      expect(seeded.rowCount === 1, 'D fixture availability row insert failed');
      registerBaselineEntry('RM1C Suite One Renamed', fixtureDateKey, 3, 5);
      fixtureTypeId = Number(typeOne.id);

      const rejected = await request('PATCH', `/api/room-types/${typeOne.id}`, { capacity: 2 });
      expect(rejected.status === 409, `D capacity below reserved must be 409, got ${rejected.status} ${rejected.text}`);
      expect(rejected.json?.code === 'CAPACITY_BELOW_RESERVED', 'D payload must carry CAPACITY_BELOW_RESERVED');

      const allowed = await request('PATCH', `/api/room-types/${typeOne.id}`, { capacity: 4 });
      expect(allowed.status === 200 && Number(allowed.json.data.capacity) === 4, 'D capacity raise must succeed');
      mark('D. capacity decrease guard', true);
    }

    // E. Type deactivate / activate lifecycle
    {
      const deactivated = await request('PATCH', `/api/room-types/${typeOne.id}`, { is_active: false });
      expect(deactivated.status === 200 && deactivated.json.data.is_active === false, `E deactivate failed: ${deactivated.text}`);
      expect(deactivated.json.meta && typeof deactivated.json.meta.note === 'string', 'E deactivate must include meta note');

      const reactivated = await request('PATCH', `/api/room-types/${typeOne.id}`, { is_active: true });
      expect(reactivated.status === 200 && reactivated.json.data.is_active === true, 'E reactivate failed');
      mark('E. type deactivate/activate', true);
    }

    // F. Physical room create + validation
    {
      const created = await request('POST', '/api/rooms', {
        room_number: 'RM1C-901',
        room_type_id: typeOne.id,
        floor: '9'
      });
      expect(created.status === 201, `F room create must be 201, got ${created.status} ${created.text}`);
      roomOne = created.json.data;
      createdRoomIds.add(Number(roomOne.id));
      expect(roomOne.status === 'VACANT_CLEAN', `F default status must be VACANT_CLEAN, got ${roomOne.status}`);
      expect(roomOne.name === 'RM1C Suite One Renamed', `F name mirror expected, got ${roomOne.name}`);
      expect(Number(roomOne.property_id) > 0, 'F property must be inherited from room type');

      const duplicate = await request('POST', '/api/rooms', { room_number: 'RM1C-901', room_type_id: typeOne.id });
      expect(duplicate.status === 409 && duplicate.json?.code === 'ROOM_NUMBER_EXISTS', `F duplicate number must be 409 ROOM_NUMBER_EXISTS, got ${duplicate.status} ${duplicate.text}`);

      const unknownType = await request('POST', '/api/rooms', { room_number: 'RM1C-902', room_type_id: 999999 });
      expect(unknownType.status === 404, `F unknown type must be 404, got ${unknownType.status}`);

      typeTwo = (await request('POST', '/api/room-types', { code: 'RM1C-T2', name: 'RM1C Suite Two', capacity: 2 })).json.data;
      createdTypeIds.add(Number(typeTwo.id));
      await request('PATCH', `/api/room-types/${typeTwo.id}`, { is_active: false });
      const inactiveType = await request('POST', '/api/rooms', { room_number: 'RM1C-903', room_type_id: typeTwo.id });
      expect(inactiveType.status === 409 && inactiveType.json?.code === 'ROOM_TYPE_INACTIVE', `F inactive type must be 409 ROOM_TYPE_INACTIVE, got ${inactiveType.status} ${inactiveType.text}`);
      mark('F. physical room create + validation', true);
    }

    // G. Room detail endpoint
    {
      const detail = await request('GET', `/api/rooms/${roomOne.id}`);
      expect(detail.status === 200, `G detail failed: ${detail.status} ${detail.text}`);
      expect(detail.json.data.room_type_code === 'RM1C-T1', 'G room_type_code mismatch');
      expect(Number(detail.json.data.active_reservation_count) === 0, 'G active_reservation_count must start at 0');

      const missing = await request('GET', '/api/rooms/999999');
      expect(missing.status === 404, `G missing room must be 404, got ${missing.status}`);
      mark('G. room detail endpoint', true);
    }

    // H. Legacy list filters (additive)
    {
      const filtered = await request('GET', `/api/rooms?room_type_id=${typeOne.id}`);
      expect(filtered.status === 200, `H filter failed: ${filtered.status}`);
      const rows = filtered.json.data || [];
      expect(rows.length === 1 && Number(rows[0].id) === Number(roomOne.id), `H room_type_id filter must match only the new room, got ${JSON.stringify(rows.map((r) => r.room_number))}`);

      const activeOnly = await request('GET', '/api/rooms?is_active=true');
      expect(activeOnly.status === 200 && (activeOnly.json.data || []).length >= 9, 'H is_active filter must keep all original rooms');
      mark('H. legacy list filters', true);
    }

    // I. Room update + duplicate rename guard
    {
      const patched = await request('PATCH', `/api/rooms/${roomOne.id}`, { floor: '10', notes: `${runId} notes` });
      expect(patched.status === 200 && patched.json.data.floor === '10', `I floor/notes patch failed: ${patched.text}`);

      const renameDuplicate = await request('PATCH', `/api/rooms/${roomOne.id}`, { room_number: '101' });
      expect(renameDuplicate.status === 409 && renameDuplicate.json?.code === 'ROOM_NUMBER_EXISTS', `I rename onto existing number must be 409, got ${renameDuplicate.status} ${renameDuplicate.text}`);

      const renamed = await request('PATCH', `/api/rooms/${roomOne.id}`, { room_number: 'RM1C-905' });
      expect(renamed.status === 200 && renamed.json.data.room_number === 'RM1C-905', 'I valid rename must succeed');
      mark('I. room update + rename guard', true);
    }

    // J. Booking-flow room type change guard
    {
      const stdTypeRow = await pool.query("SELECT id, name FROM room_types WHERE code = 'STK'");
      expect(stdTypeRow.rowCount === 1, 'J STD King master row missing');
      const stdType = stdTypeRow.rows[0];

      const stayStartJ = addDays(today, 10);
      const stayEndJ = addDays(today, 12);
      for (const nightDate of [stayStartJ, addDays(today, 11)]) {
        const seeded = await pool.query(
          `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
           VALUES ($1, $2, $3::date, 5, 0)
           RETURNING id`,
          [typeOne.id, 'RM1C Suite One Renamed', nightDate]
        );
        expect(seeded.rowCount === 1, `J availability seed failed for ${nightDate}`);
        registerBaselineEntry('RM1C Suite One Renamed', nightDate, 0, 5);
      }

      const resA = await request('POST', '/api/reservations', {
        room_id: roomOne.id,
        guest_name: `${runId} J-Guest`,
        guest_phone: `0819${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        check_in: stayStartJ,
        check_out: stayEndJ,
        total_price: 300000,
        qty: 1
      }, 'J-RES-A');
      expect(resA.status === 201, `J reservation on new room must be 201, got ${resA.status} ${resA.text}`);
      const resAId = Number(resA.json.data.id);
      trackReservation(resAId, 'RM1C Suite One Renamed', stayStartJ, stayEndJ);

      const blocked = await request('PATCH', `/api/rooms/${roomOne.id}`, { room_type_id: stdType.id });
      expect(blocked.status === 409 && blocked.json?.code === 'ROOM_HAS_ACTIVE_RESERVATIONS', `J type change with active reservation must be 409, got ${blocked.status} ${blocked.text}`);

      const cancelled = await request('POST', `/api/reservations/${resAId}/cancel`, {}, 'J-CANCEL-A');
      expect(cancelled.status === 200 || cancelled.status === 201, `J cancel failed: ${cancelled.status} ${cancelled.text}`);
      markReleased(resAId);

      const moved = await request('PATCH', `/api/rooms/${roomOne.id}`, { room_type_id: stdType.id });
      expect(moved.status === 200, `J type change after cancel must succeed, got ${moved.status} ${moved.text}`);
      expect(moved.json.data.name === stdType.name, `J name must sync to STD King, got ${moved.json.data.name}`);
      mark('J. booking-flow room type change guard', true);
    }

    // K. Inactive room blocks creation but never strands guests
    {
      await snapshotAvailability(client, ['Premiere Twin'], addDays(today, 1), addDays(today, 40));

      const deactivated = await request('PATCH', `/api/rooms/${roomOne.id}`, { is_active: false });
      expect(deactivated.status === 200 && deactivated.json.data.is_active === false, `K deactivate failed: ${deactivated.text}`);

      const blockedBooking = await request('POST', '/api/reservations', {
        room_id: roomOne.id,
        guest_name: `${runId} K-Guest`,
        guest_phone: `0819${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        check_in: addDays(today, 20),
        check_out: addDays(today, 22),
        total_price: 200000,
        qty: 1
      }, 'K-BLOCKED');
      expect(blockedBooking.status === 409, `K booking against inactive room must be 409, got ${blockedBooking.status} ${blockedBooking.text}`);

      await request('PATCH', `/api/rooms/${roomOne.id}`, { is_active: true });

      const stayStart = addDays(today, 20);
      const stayEnd = addDays(today, 22);
      const resB = await request('POST', '/api/reservations', {
        room_id: roomOne.id,
        guest_name: `${runId} K-Stay`,
        guest_phone: `0819${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        check_in: stayStart,
        check_out: stayEnd,
        total_price: 200000,
        qty: 1
      }, 'K-STAY');
      expect(resB.status === 201, `K active-room booking must be 201, got ${resB.status} ${resB.text}`);
      const resBId = Number(resB.json.data.id);
      trackReservation(resBId, 'STD King', stayStart, stayEnd);

      const checkedIn = await request('POST', `/api/reservations/${resBId}/checkin`, {}, 'K-CHECKIN');
      expect(checkedIn.status === 200 || checkedIn.status === 201, `K checkin failed: ${checkedIn.status} ${checkedIn.text}`);

      await request('PATCH', `/api/rooms/${roomOne.id}`, { is_active: false });
      const checkedOut = await request('POST', `/api/reservations/${resBId}/checkout`, {}, 'K-CHECKOUT');
      expect(checkedOut.status === 200 || checkedOut.status === 201, `K checkout of in-house guest must not be blocked by deactivation, got ${checkedOut.status} ${checkedOut.text}`);
      markReleased(resBId);
      await request('PATCH', `/api/rooms/${roomOne.id}`, { is_active: true });

      let moveStart = addDays(today, 30);
      const moveEndOffset = 2;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const startCandidate = addDays(today, 30 + attempt);
        const endCandidate = addDays(today, 30 + attempt + moveEndOffset);
        const clash = await pool.query(
          `SELECT 1 FROM reservations
           WHERE room_id = $1 AND status IN ('BOOKED','CHECKED_IN')
             AND check_in < $3::date AND check_out > $2::date
           LIMIT 1`,
          [prtRoom107.id, startCandidate, endCandidate]
        );
        if (clash.rowCount === 0) {
          moveStart = startCandidate;
          break;
        }
      }
      const resC = await request('POST', '/api/reservations', {
        room_id: prtRoom107.id,
        guest_name: `${runId} K-Move`,
        guest_phone: `0819${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        check_in: moveStart,
        check_out: addDays(moveStart, moveEndOffset),
        total_price: 250000,
        qty: 1
      }, 'K-MOVE-SRC');
      expect(resC.status === 201, `K source reservation on 107 must be 201, got ${resC.status} ${resC.text}`);
      const resCId = Number(resC.json.data.id);
      trackReservation(resCId, 'Premiere Twin', moveStart, addDays(moveStart, moveEndOffset));

      await request('PATCH', `/api/rooms/${roomOne.id}`, { is_active: false });
      const moveBlocked = await request('POST', `/api/reservations/${resCId}/move`, { to_room_id: roomOne.id }, 'K-MOVE-BLOCKED');
      expect(moveBlocked.status === 409, `K move targeting inactive room must be 409, got ${moveBlocked.status} ${moveBlocked.text}`);
      expect(moveBlocked.json?.code === 'ROOM_MASTER_INACTIVE', 'K move block payload must carry ROOM_MASTER_INACTIVE');
      await request('PATCH', `/api/rooms/${roomOne.id}`, { is_active: true });

      const cancelledC = await request('POST', `/api/reservations/${resCId}/cancel`, {}, 'K-CANCEL-C');
      expect(cancelledC.status === 200 || cancelledC.status === 201, `K cancel C failed: ${cancelledC.status}`);
      markReleased(resCId);

      mark('K. inactive room guards + guest safety', true);
    }

    // L. Canonical availability still resolves for existing masters
    {
      const availability = await request('GET', `/api/availability?start=${addDays(today, 1)}&end=${addDays(today, 8)}&room_type=Premiere%20Twin`);
      expect(availability.status === 200, `L availability failed: ${availability.status} ${availability.text}`);
      const rows = availability.json?.data || availability.json?.availability || [];
      expect(Array.isArray(rows) && rows.length > 0, 'L availability rows must be present for Premiere Twin');
      mark('L. canonical availability resolution intact', true);
    }

  } catch (err) {
    mark('UNEXPECTED FAILURE', false, err.message);
  } finally {
    try {
      await reconcileLedgerAndCleanup(client, fixtureTypeId, fixtureDateKey);
      await verifyPostCleanup();
      const allPassed = results.every((r) => r.ok);
      const passed = results.filter((r) => r.ok).length;
      console.log('');
      console.log(allPassed
        ? `ALL ${passed}/${results.length} SCENARIOS PASS — zero residue, ledger reconciled (${runId})`
        : `${passed}/${results.length} scenarios passed; see FAIL lines above (${runId})`);
      process.exitCode = allPassed ? 0 : 1;
    } catch (cleanupErr) {
      console.error(`CLEANUP FAILURE for ${runId}: ${cleanupErr.message}`);
      process.exitCode = 1;
    } finally {
      client.release();
      await pool.end();
    }
  }
}

run();
