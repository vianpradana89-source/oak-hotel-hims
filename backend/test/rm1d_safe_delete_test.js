'use strict';

// RM-1D Safe Delete tests — Room Type & Physical Room.
// Disposable fixtures ONLY, all names carry a unique per-run tag:
//   room_types.code / rooms.room_number LIKE 'RM1D-<tag>%'
// Zero contact with legitimate hotel data; cleanup is guarded by that tag.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:5000';
const fetchFn = global.fetch || require('node-fetch');
const runTag = `DL${Date.now().toString(36).toUpperCase()}`;
const tagPrefix = `RM1D-${runTag}`; // e.g. RM1D-DLMJS7X1K (<=20 chars, valid type-code pattern)
const guestMarker = `${tagPrefix}-GUEST`;

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'oak_hotel_db',
});

let passed = 0;
function expect(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
  passed += 1;
  console.log(`PASS  ${message}`);
}

async function request(method, p, body) {
  const resp = await fetchFn(`${baseUrl}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-Id': `${tagPrefix}-${Math.random().toString(16).slice(2, 8)}`
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_e) { json = null; }
  return { status: resp.status, json };
}

async function jakartaDate(offsetDays) {
  const r = await pool.query(
    "SELECT ((NOW() AT TIME ZONE 'Asia/Jakarta')::date + $1::int) AS d",
    [offsetDays]
  );
  return r.rows[0].d.toISOString().slice(0, 10);
}

const fixtureTypeIds = [];
const fixtureRoomIds = [];

async function createType(suffix) {
  const code = `${tagPrefix}${suffix}`; // RM1D-<tag>T1 — unique per run
  const r = await request('POST', '/api/room-types', { code, name: `${code} Fixture`, capacity: 4 });
  if (r.status !== 201) throw new Error(`fixture type ${code} create failed: ${r.status} ${JSON.stringify(r.json)}`);
  fixtureTypeIds.push(Number(r.json.data.id));
  return r.json.data;
}

async function createRoom(typeId, suffix) {
  const number = `${tagPrefix}${suffix}`; // RM1D-<tag>R1 — <=20 chars
  const r = await request('POST', '/api/rooms', { room_number: number, room_type_id: typeId });
  if (r.status !== 201) throw new Error(`fixture room ${number} create failed: ${r.status} ${JSON.stringify(r.json)}`);
  fixtureRoomIds.push(Number(r.json.data.id));
  return r.json.data;
}

let bookingSeq = 0;
async function insertReservation(roomId, status, checkIn, checkOut) {
  bookingSeq += 1;
  const booking = await pool.query(
    `INSERT INTO bookings (bid, property_id, guest_name_snapshot, booking_source, booking_status, correlation_id)
     VALUES ($1, (SELECT id FROM properties ORDER BY id LIMIT 1), $2, 'WALKIN', 'ACTIVE', $3)
     RETURNING id`,
    [`${tagPrefix}-BID-${bookingSeq}`, guestMarker, `${tagPrefix}-CORR-${bookingSeq}`]
  );
  const r = await pool.query(
    `INSERT INTO reservations (booking_id, stay_sequence, room_id, guest_name, check_in, check_out,
                               status, payment_status, correlation_id)
     VALUES ($1, 1, $2, $3, $4::date, $5::date, $6, 'UNPAID', $7)
     RETURNING id`,
    [Number(booking.rows[0].id), roomId, guestMarker, checkIn, checkOut, status, `${tagPrefix}-CORR-${bookingSeq}`]
  );
  return Number(r.rows[0].id);
}

// Guarded, idempotent cleanup scoped to this run's unique tag/ids.
// Runs on success AND failure so the suite never leaves residue.
async function cleanupFixtures(alsoTypeIds = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM reservations WHERE guest_name = $1', [guestMarker]);
    await client.query('DELETE FROM bookings WHERE guest_name_snapshot = $1', [guestMarker]);
    await client.query('DELETE FROM availability_locks WHERE room_type_id = ANY($1::int[])', [[...fixtureTypeIds, ...alsoTypeIds]]);
    await client.query("DELETE FROM rooms WHERE id = ANY($1::int[]) AND room_number LIKE $2", [fixtureRoomIds, `${tagPrefix}%`]);
    await client.query('DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[])', [[...fixtureTypeIds, ...alsoTypeIds]]);
    const delTypes = await client.query(
      "DELETE FROM room_types WHERE id = ANY($1::int[]) AND code LIKE $2 RETURNING id",
      [[...fixtureTypeIds, ...alsoTypeIds], `${tagPrefix}%`]
    );
    const recordIds = [...fixtureRoomIds, ...fixtureTypeIds, ...alsoTypeIds].map(String);
    if (recordIds.length > 0) {
      await client.query(
        "DELETE FROM audit_logs WHERE module = 'ROOM_MASTER' AND entity IN ('ROOM','ROOM_TYPE') AND record_id = ANY($1::text[])",
        [recordIds]
      );
    }
    await client.query('COMMIT');
    return delTypes.rowCount ?? 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const today = await jakartaDate(0);
  const minus3 = await jakartaDate(-3);
  const plus5 = await jakartaDate(5);
  const plus7 = await jakartaDate(7);

  // Deleted-in-scenario type ids (G) so finally-cleanup covers them too.
  const deletedTypeIds = [];

  try {
  // ---------- PHYSICAL ROOM ----------
  const t1 = await createType('T1');
  const t1Code = String(t1.code);
  const r1 = await createRoom(t1.id, 'R1'); // unused — will be deleted
  const r2 = await createRoom(t1.id, 'R2'); // reservation history guard
  const r3 = await createRoom(t1.id, 'R3'); // active/future reservation guard

  const detailBefore = await request('GET', `/api/room-types/${t1.id}`);
  expect(Number(detailBefore.json.data.active_physical_rooms) === 3, 'baseline active physical rooms = 3');

  // A. unused room can be deleted
  const delUnused = await request('DELETE', `/api/rooms/${r1.id}`);
  expect(delUnused.status === 200, `A: unused room delete succeeds (got ${delUnused.status})`);

  // B. deleted room no longer appears
  const listAfter = await request('GET', `/api/rooms?room_type_id=${t1.id}`);
  expect(!(listAfter.json.data || []).some((x) => Number(x.id) === Number(r1.id)), 'B: deleted room absent from room list');
  const goneDetail = await request('GET', `/api/rooms/${r1.id}`);
  expect(goneDetail.status === 404, 'B: deleted room detail returns 404');

  // C. active physical capacity decreases correctly
  const detailAfterDel = await request('GET', `/api/room-types/${t1.id}`);
  expect(Number(detailAfterDel.json.data.active_physical_rooms) === 2, 'C: active physical rooms now 2 after delete');

  // D. room with reservation HISTORY cannot be deleted (CHECKED_OUT past stay)
  await insertReservation(r2.id, 'CHECKED_OUT', minus3, today);
  const delHist = await request('DELETE', `/api/rooms/${r2.id}`);
  expect(delHist.status === 409, `D: historical reservation blocks delete (got ${delHist.status})`);
  expect(delHist.json && delHist.json.code === 'ROOM_HAS_HISTORY', 'D: conflict code ROOM_HAS_HISTORY surfaced');

  // E. active/future reservation cannot be deleted
  await insertReservation(r3.id, 'BOOKED', plus5, plus7);
  const delFuture = await request('DELETE', `/api/rooms/${r3.id}`);
  expect(delFuture.status === 409, `E: future BOOKED reservation blocks delete (got ${delFuture.status})`);
  expect(delFuture.json && delFuture.json.code === 'ROOM_HAS_HISTORY', 'E: conflict code ROOM_HAS_HISTORY surfaced');

  // F. rejected delete leaves room untouched
  const r2After = await request('GET', `/api/rooms/${r2.id}`);
  expect(r2After.status === 200, 'F: rejected room still exists');
  expect(String(r2After.json.data.room_number) === `${tagPrefix}R2`, 'F: rejected room number unchanged');

  // K. no cascade deletion of reservations/bookings (checked before cleanup)
  const resCount = await pool.query('SELECT COUNT(*)::int AS c FROM reservations WHERE guest_name = $1', [guestMarker]);
  expect(Number(resCount.rows[0].c) === 2, 'K: both fixture reservations still present after rejections (no cascade)');

  // ---------- ROOM TYPE ----------
  // G. unused type with no rooms/history can be deleted
  const t2 = await createType('T2');
  const ledgerProbe = await pool.query(
    'SELECT COUNT(*)::int AS c FROM availability_dates WHERE room_type_id = $1',
    [Number(t2.id)]
  );
  expect(Number(ledgerProbe.rows[0].c) === 0, 'G: fresh fixture type has zero ledger rows (deletable state exists)');
  const delType2 = await request('DELETE', `/api/room-types/${t2.id}`);
  expect(delType2.status === 200, `G: unused type delete succeeds (got ${delType2.status})`);
  const t2Gone = await request('GET', `/api/room-types/${t2.id}`);
  expect(t2Gone.status === 404, 'G: deleted type detail returns 404');
  deletedTypeIds.push(Number(t2.id));

  // H. type with physical rooms cannot be deleted
  const delTypeWithRooms = await request('DELETE', `/api/room-types/${t1.id}`);
  expect(delTypeWithRooms.status === 409, `H: type with rooms blocked (got ${delTypeWithRooms.status})`);
  expect(delTypeWithRooms.json && delTypeWithRooms.json.code === 'ROOM_TYPE_HAS_ROOMS', 'H: conflict code ROOM_TYPE_HAS_ROOMS surfaced');

  // I. historical/inventory-linked type cannot be deleted
  //    Fresh type T3 + one synthetic ledger row simulating seeded inventory.
  const t3 = await createType('T3');
  await pool.query(
    `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
     VALUES ($1, $2, $3::date, 0, 0)`,
    [Number(t3.id), String(t3.name), plus5]
  );
  const delLinked = await request('DELETE', `/api/room-types/${t3.id}`);
  expect(delLinked.status === 409, `I: ledger-linked type blocked (got ${delLinked.status})`);
  expect(delLinked.json && delLinked.json.code === 'ROOM_TYPE_HAS_HISTORY', 'I: conflict code ROOM_TYPE_HAS_HISTORY surfaced');

  // J. rejected type deletes leave types untouched
  const t1After = await request('GET', `/api/room-types/${t1.id}`);
  const t3After = await request('GET', `/api/room-types/${t3.id}`);
  expect(t1After.status === 200 && t1After.json.data.code === t1Code, 'J: type with rooms untouched (same id + code)');
  expect(t3After.status === 200 && Number(t3After.json.data.active_physical_rooms) === 0, 'J: ledger-linked type untouched');

  // ---------- CLEANUP runs in finally (guarded by per-run tag) ----------
  } finally {
    await cleanupFixtures(deletedTypeIds);
  }

  // ---------- L/M/N/O. FINAL INVARIANTS + RESIDUE ----------
  const inv = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE ad.reserved_qty <> COALESCE(e.active, 0))::int AS drift,
      COUNT(*) FILTER (WHERE ad.reserved_qty < 0)::int AS neg,
      COUNT(*) FILTER (WHERE ad.reserved_qty > ad.total_rooms)::int AS over
    FROM availability_dates ad
    LEFT JOIN (
      SELECT rm.room_type_id, g.d::date AS day, COUNT(*) AS active
      FROM reservations r
      JOIN rooms rm ON rm.id = r.room_id
      CROSS JOIN LATERAL generate_series(r.check_in, r.check_out - INTERVAL '1 day', INTERVAL '1 day') g(d)
      WHERE r.status IN ('BOOKED','CHECKED_IN') AND rm.room_type_id IS NOT NULL
      GROUP BY 1, 2
    ) e ON e.room_type_id = ad.room_type_id AND e.day = ad.date::date`);
  expect(inv.rows[0].drift === 0, 'L: inventory drift = 0');
  expect(inv.rows[0].neg === 0, 'M: negative inventory = 0');
  expect(inv.rows[0].over === 0, 'N: over-capacity = 0');

  const residueChecks = [
    ['room_types', 'code LIKE $1', [`${tagPrefix}%`]],
    ['rooms', 'room_number LIKE $1', [`${tagPrefix}%`]],
    ['reservations', 'guest_name = $1', [guestMarker]],
    ['bookings', 'guest_name_snapshot = $1', [guestMarker]],
    ['audit_logs', "module = 'ROOM_MASTER' AND record_id = ANY($1::text[])", [[...fixtureRoomIds, ...fixtureTypeIds, ...deletedTypeIds].map(String)]]
  ];
  for (const [table, predicate, params] of residueChecks) {
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${predicate}`, params);
    expect(r.rows[0].c === 0, `O: zero residue in ${table}`);
  }

  console.log(`\nALL ${passed} CHECKS PASS — Safe Delete rules enforced, zero residue (${tagPrefix}).`);
}

main()
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
