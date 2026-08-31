require('dotenv').config();
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const DIAGNOSE = process.argv.includes('--diagnose');
const TARGET = Object.freeze({
  reservationId: 1,
  bookingId: 227,
  bid: 'LWG-260817-CW9ZAESX',
  roomId: 2,
  roomNumber: '102',
  roomTypeId: 2,
  roomTypeCode: 'STD-T',
  checkIn: '2026-08-17',
  checkOut: '2026-08-18',
  occupiedDate: '2026-08-17',
  repairCorrelationId: 'PHASE2_RESERVATION1_LEDGER_REPAIR-20260825'
});

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

function assert(condition, message) {
  if (!condition) throw new Error(`PRECONDITION_FAILED: ${message}`);
}

async function queryEvidence(client, lock) {
  const suffix = lock ? ' FOR UPDATE OF res, b, rm, rt' : '';
  const target = await client.query(
    `SELECT res.id AS reservation_id, res.booking_id, res.room_id,
            res.status AS reservation_status, res.stay_status,
            to_char(res.check_in::date, 'YYYY-MM-DD') AS check_in,
            to_char(res.check_out::date, 'YYYY-MM-DD') AS check_out,
            b.id AS booking_id_value, b.bid, b.booking_status,
            rm.room_number, rm.room_type_id, COALESCE(rm.is_active, TRUE) AS room_is_active,
            rt.code AS room_type_code, rt.name AS room_type_name,
            COALESCE(rt.is_active, TRUE) AS room_type_is_active
     FROM reservations res
     JOIN bookings b ON b.id = res.booking_id
     JOIN rooms rm ON rm.id = res.room_id
     JOIN room_types rt ON rt.id = rm.room_type_id
     WHERE res.id = $1${suffix}`,
    [TARGET.reservationId]
  );

  const childSuffix = lock ? ' FOR UPDATE' : '';
  const bookingChildren = await client.query(
    `SELECT id, status FROM reservations WHERE booking_id = $1 ORDER BY id${childSuffix}`,
    [TARGET.bookingId]
  );

  const occupiedNights = await client.query(
    `SELECT to_char(day::date, 'YYYY-MM-DD') AS date
     FROM reservations res
     CROSS JOIN LATERAL generate_series(
       res.check_in::date,
       res.check_out::date - 1,
       INTERVAL '1 day'
     ) day
     WHERE res.id = $1
     ORDER BY day`,
    [TARGET.reservationId]
  );

  const rowLock = lock ? ' FOR UPDATE' : '';
  const canonicalRows = await client.query(
    `SELECT id, room_type_id, room_type, to_char(date, 'YYYY-MM-DD') AS date,
            total_rooms, reserved_qty
     FROM availability_dates
     WHERE room_type_id = $1 AND date = $2::date${rowLock}`,
    [TARGET.roomTypeId, TARGET.occupiedDate]
  );

  const adjacentRows = await client.query(
    `SELECT id, room_type_id, room_type, to_char(date, 'YYYY-MM-DD') AS date,
            total_rooms, reserved_qty
     FROM availability_dates
     WHERE room_type_id = $1
       AND date BETWEEN $2::date - 7 AND $2::date + 7
       AND date <> $2::date
     ORDER BY ABS(date - $2::date), date${lock ? ' FOR SHARE' : ''}`,
    [TARGET.roomTypeId, TARGET.occupiedDate]
  );

  const physicalRooms = await client.query(
    `SELECT id, room_number, COALESCE(is_active, TRUE) AS is_active, status,
            created_at, updated_at
     FROM rooms
     WHERE room_type_id = $1
     ORDER BY id${lock ? ' FOR SHARE' : ''}`,
    [TARGET.roomTypeId]
  );

  const roomTypeName = target.rows[0]?.room_type_name == null ? '' : String(target.rows[0].room_type_name).trim().toLowerCase();
  const adjacentDisplays = adjacentRows.rows.map((row) => String(row.room_type || '').trim().toLowerCase()).filter(Boolean);
  const logicalDisplays = Array.from(new Set([roomTypeName, ...adjacentDisplays])).filter(Boolean);
  const nullIdRows = await client.query(
    `SELECT id, room_type, to_char(date, 'YYYY-MM-DD') AS date, total_rooms, reserved_qty
     FROM availability_dates
     WHERE room_type_id IS NULL AND date = $1::date${rowLock}`,
    [TARGET.occupiedDate]
  );
  const legacySiblings = nullIdRows.rows.filter((row) => logicalDisplays.includes(String(row.room_type || '').trim().toLowerCase()));

  const availabilityLocks = await client.query(
    `SELECT id, reservation_id, room_type_id, room_type, to_char(date, 'YYYY-MM-DD') AS date,
            qty_locked, lock_expires_at
     FROM availability_locks
     WHERE date = $1::date
       AND (
         room_type_id = $2
         OR reservation_id = $3
         OR (room_type_id IS NULL AND LOWER(TRIM(room_type)) = ANY($4::text[]))
       )${rowLock}`,
    [TARGET.occupiedDate, TARGET.roomTypeId, TARGET.reservationId, logicalDisplays]
  );

  const activeReservations = await client.query(
    `SELECT res.id, res.booking_id, res.room_id,
            to_char(res.check_in::date, 'YYYY-MM-DD') AS check_in,
            to_char(res.check_out::date, 'YYYY-MM-DD') AS check_out,
            res.status
     FROM reservations res
     JOIN rooms rm ON rm.id = res.room_id
     WHERE rm.room_type_id = $1
       AND res.status IN ('BOOKED', 'CHECKED_IN')
       AND $2::date >= res.check_in::date
       AND $2::date < res.check_out::date
     ORDER BY res.id${lock ? ' FOR UPDATE OF res' : ''}`,
    [TARGET.roomTypeId, TARGET.occupiedDate]
  );

  const repairAudits = await client.query(
    'SELECT audit_id FROM audit_logs WHERE correlation_id = $1',
    [TARGET.repairCorrelationId]
  );

  const roomAudits = await client.query(
    `SELECT audit_id, action, record_id, new_value, correlation_id, timestamp
     FROM audit_logs
     WHERE entity = 'ROOM'
       AND record_id IN (SELECT id::text FROM rooms WHERE room_type_id = $1)
     ORDER BY timestamp, audit_id`,
    [TARGET.roomTypeId]
  );

  const roomTypeChangeAudits = await client.query(
    `SELECT audit_id, action, record_id, new_value, correlation_id, timestamp
     FROM audit_logs
     WHERE entity = 'ROOM'
       AND action IN ('CHANGE_TYPE', 'UPDATE')
       AND new_value LIKE '%room_type_id%'
     ORDER BY timestamp, audit_id`
  );

  const allRooms = await client.query(
    `SELECT id, room_number, room_type_id, COALESCE(is_active, TRUE) AS is_active,
            created_at, updated_at
     FROM rooms
     ORDER BY id`
  );

  const invariants = await client.query(`
    WITH active_nights AS (
      SELECT rm.room_type_id, night.day::date AS date, COUNT(*)::int AS expected_qty
      FROM reservations res
      JOIN rooms rm ON rm.id = res.room_id
      CROSS JOIN LATERAL generate_series(
        res.check_in::date,
        res.check_out::date - 1,
        INTERVAL '1 day'
      ) night(day)
      WHERE res.status IN ('BOOKED', 'CHECKED_IN')
        AND rm.room_type_id IS NOT NULL
        AND res.check_out > res.check_in
      GROUP BY rm.room_type_id, night.day
    )
    SELECT
      COUNT(*) FILTER (WHERE ad.reserved_qty IS DISTINCT FROM COALESCE(an.expected_qty, 0))::int AS drift,
      COUNT(*) FILTER (WHERE ad.reserved_qty < 0)::int AS negative,
      COUNT(*) FILTER (WHERE ad.reserved_qty > ad.total_rooms)::int AS over_capacity
    FROM availability_dates ad
    LEFT JOIN active_nights an ON an.room_type_id = ad.room_type_id AND an.date = ad.date
  `);

  const baseline = await client.query(`
    SELECT
      (SELECT md5(COALESCE(string_agg(
        concat_ws('|', id, booking_id, room_id, status, stay_status, check_in, check_out),
        ',' ORDER BY id
      ), '')) FROM reservations WHERE id <> $1) AS other_reservations_hash,
      (SELECT md5(COALESCE(string_agg(
        concat_ws('|', id, booking_status), ',' ORDER BY id
      ), '')) FROM bookings WHERE id <> $2) AS other_bookings_hash,
      (SELECT md5(COALESCE(string_agg(
        concat_ws('|', id, room_type_id, date, total_rooms, reserved_qty), ',' ORDER BY id
      ), '')) FROM availability_dates
       WHERE NOT (room_type_id = $3 AND date = $4::date)) AS other_availability_hash
  `, [TARGET.reservationId, TARGET.bookingId, TARGET.roomTypeId, TARGET.occupiedDate]);

  return {
    target: target.rows[0] || null,
    bookingChildren: bookingChildren.rows,
    occupiedNights: occupiedNights.rows.map((row) => row.date),
    canonicalRows: canonicalRows.rows,
    adjacentRows: adjacentRows.rows,
    physicalRooms: physicalRooms.rows,
    legacySiblings,
    availabilityLocks: availabilityLocks.rows,
    activeReservations: activeReservations.rows,
    repairAuditCount: repairAudits.rowCount || 0,
    roomAudits: roomAudits.rows,
    roomTypeChangeAudits: roomTypeChangeAudits.rows,
    allRooms: allRooms.rows,
    invariants: invariants.rows[0],
    baseline: baseline.rows[0]
  };
}

function provePreconditions(evidence) {
  const row = evidence.target;
  assert(row, 'reservation 1 and its authoritative joins must exist');
  assert(Number(row.reservation_id) === TARGET.reservationId, 'reservation id changed');
  assert(String(row.reservation_status) === 'BOOKED', `reservation status is ${row.reservation_status}`);
  assert(Number(row.booking_id) === TARGET.bookingId && Number(row.booking_id_value) === TARGET.bookingId, 'booking relationship changed');
  assert(String(row.bid) === TARGET.bid, `BID is ${row.bid}`);
  assert(String(row.booking_status) === 'ACTIVE', `booking status is ${row.booking_status}`);
  assert(Number(row.room_id) === TARGET.roomId, `room id is ${row.room_id}`);
  assert(String(row.room_number) === TARGET.roomNumber, `room number is ${row.room_number}`);
  assert(Number(row.room_type_id) === TARGET.roomTypeId, `room type id is ${row.room_type_id}`);
  assert(String(row.room_type_code) === TARGET.roomTypeCode, `room type code is ${row.room_type_code}`);
  assert(String(row.check_in) === TARGET.checkIn && String(row.check_out) === TARGET.checkOut, 'stay dates changed');
  assert(evidence.occupiedNights.length === 1 && evidence.occupiedNights[0] === TARGET.occupiedDate, 'occupied nights are not exactly the target night');
  assert(evidence.bookingChildren.length === 1 && Number(evidence.bookingChildren[0].id) === TARGET.reservationId, 'booking 227 has another child reservation');
  assert(evidence.canonicalRows.length === 0, 'canonical target availability row already exists');
  assert(evidence.legacySiblings.length === 0, 'NULL-ID legacy sibling exists for the logical type/date');
  assert(evidence.availabilityLocks.length === 0, 'relevant availability lock exists');
  assert(evidence.activeReservations.length === 1 && Number(evidence.activeReservations[0].id) === TARGET.reservationId, 'expected active quantity is not exactly reservation 1');
  assert(evidence.repairAuditCount === 0, 'repair audit already exists');

  const activePhysicalRooms = evidence.physicalRooms.filter((room) => room.is_active !== false);
  assert(activePhysicalRooms.length > 0, 'active physical capacity is zero');
  assert(evidence.adjacentRows.length >= 2, 'fewer than two adjacent canonical rows exist');
  assert(evidence.adjacentRows.every((row) => Number(row.total_rooms) === activePhysicalRooms.length), 'adjacent canonical total_rooms disagrees with active physical capacity');
  const displayValues = new Set(evidence.adjacentRows.map((adjacent) => String(adjacent.room_type || '').trim()).filter(Boolean));
  assert(displayValues.size === 1, 'adjacent canonical display evidence is inconsistent');
  assert(Number(evidence.invariants.negative) === 0, 'negative inventory already exists');
  assert(Number(evidence.invariants.over_capacity) === 0, 'over-capacity inventory already exists');

  return {
    authoritativeTotalRooms: activePhysicalRooms.length,
    roomTypeDisplay: Array.from(displayValues)[0],
    activePhysicalRooms: activePhysicalRooms.map((room) => ({ id: Number(room.id), room_number: String(room.room_number) }))
  };
}

async function dryRun() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY');
    const evidence = await queryEvidence(client, false);
    if (DIAGNOSE) {
      await client.query('COMMIT');
      console.log(JSON.stringify({ mode: 'DIAGNOSE', target: TARGET, evidence }, null, 2));
      return;
    }
    const authority = provePreconditions(evidence);
    await client.query('COMMIT');
    console.log(JSON.stringify({ mode: 'DRY_RUN', target: TARGET, authority, evidence }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function applyRepair() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [2202, 20260817]);
    const evidence = await queryEvidence(client, true);
    const authority = provePreconditions(evidence);

    const inserted = await client.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES ($1, $2, $3::date, $4, 1)
       RETURNING id, room_type_id, room_type, to_char(date, 'YYYY-MM-DD') AS date, total_rooms, reserved_qty`,
      [TARGET.roomTypeId, authority.roomTypeDisplay, TARGET.occupiedDate, authority.authoritativeTotalRooms]
    );
    assert(inserted.rowCount === 1, `expected one inserted row, inserted ${inserted.rowCount || 0}`);
    const insertedRow = inserted.rows[0];

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, timestamp)
       VALUES ('PMS', 'DATA_REPAIR', 'INVENTORY', $1, $2, $3, NOW())`,
      [
        String(insertedRow.id),
        JSON.stringify({
          repair_reason: 'MISSING_HISTORICAL_CANONICAL_AVAILABILITY_CELL',
          room_type_id: TARGET.roomTypeId,
          room_type: authority.roomTypeDisplay,
          date: TARGET.occupiedDate,
          total_rooms: authority.authoritativeTotalRooms,
          reserved_qty: 1,
          related_reservation_id: TARGET.reservationId,
          related_booking_id: TARGET.bookingId,
          bid: TARGET.bid
        }),
        TARGET.repairCorrelationId
      ]
    );

    const verification = await client.query(`
      WITH target AS (
        SELECT COUNT(*)::int AS row_count,
               MIN(total_rooms)::int AS total_rooms,
               MIN(reserved_qty)::int AS reserved_qty
        FROM availability_dates
        WHERE room_type_id = $1 AND date = $2::date
      )
      SELECT target.*,
             (SELECT COUNT(*)::int FROM availability_dates WHERE reserved_qty < 0) AS negative,
             (SELECT COUNT(*)::int FROM availability_dates WHERE reserved_qty > total_rooms) AS over_capacity
      FROM target
    `, [TARGET.roomTypeId, TARGET.occupiedDate]);
    const verified = verification.rows[0];
    assert(Number(verified.row_count) === 1, `target row count is ${verified.row_count}`);
    assert(Number(verified.total_rooms) === authority.authoritativeTotalRooms, 'inserted total_rooms changed');
    assert(Number(verified.reserved_qty) === 1, 'inserted reserved_qty is not 1');
    assert(Number(verified.reserved_qty) <= Number(verified.total_rooms), 'inserted row exceeds capacity');
    assert(Number(verified.negative) === 0, 'negative inventory after insert');
    assert(Number(verified.over_capacity) === 0, 'over-capacity inventory after insert');

    await client.query('COMMIT');
    console.log(JSON.stringify({ mode: 'APPLY', inserted: insertedRow, authority, verification: verified, baseline: evidence.baseline }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

(APPLY ? applyRepair() : dryRun())
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
