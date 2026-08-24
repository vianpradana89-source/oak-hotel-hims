const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const RUN_CORRELATION = `RM1B-RESIDUE-CLEANUP-${Date.now()}`;

const GUEST_PREFIXES = ['STAY-DATES-', 'PHASE1C2C-', 'BOOKING-COMP-', 'AVAIL-REG-', 'AVAILREG-', 'RM1C-', 'RM1C1-'];
const CORRELATION_PREFIXES = ['STAY-DATES-', 'PHASE1C2C-', 'BOOKING-COMP-', 'AVAIL-REG-', 'AVAILREG-', 'RM1C-', 'RM1C1-', 'BOOKING-OK-'];
const DOCUMENTED_CORRELATIONS = [
  'CORR-1787441570200',
  'CORR-1787449620719',
  'CORR-1787538677048'
];

function jakartaDateKey(value) {
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
  const date = new Date(`${dateStr}T00:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function collectTargetReservations() {
  const result = await pool.query(
    `SELECT r.id, r.booking_id, r.correlation_id, r.guest_name
     FROM reservations r
     WHERE ${CORRELATION_PREFIXES.map((_, index) => `r.correlation_id LIKE $${index + 1}`).join(' OR ')}
        OR ${GUEST_PREFIXES.map((_, index) => `r.guest_name LIKE $${CORRELATION_PREFIXES.length + index + 1}`).join(' OR ')}
        OR r.correlation_id = ANY($${CORRELATION_PREFIXES.length * 2 + 1}::varchar[])`,
    [...CORRELATION_PREFIXES.map((prefix) => `${prefix}%`), ...GUEST_PREFIXES.map((prefix) => `${prefix}%`), DOCUMENTED_CORRELATIONS]
  );
  return result.rows;
}

async function collectOrphanTargetBookings(reservationRows) {
  const coveredBookingIds = new Set(reservationRows.map((row) => Number(row.booking_id)).filter((id) => Number.isFinite(id)));
  const result = await pool.query(
    `SELECT b.id, b.correlation_id
     FROM bookings b
     WHERE (${CORRELATION_PREFIXES.map((_, index) => `b.correlation_id LIKE $${index + 1}`).join(' OR ')})
        OR b.correlation_id = ANY($${CORRELATION_PREFIXES.length + 1}::varchar[])`,
    [...CORRELATION_PREFIXES.map((prefix) => `${prefix}%`), DOCUMENTED_CORRELATIONS]
  );
  return result.rows.filter((row) => !coveredBookingIds.has(Number(row.id)));
}

async function purgeReservation(client, reservationId) {
  const detail = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
  expectRow(detail, `reservation ${reservationId}`);
  const reservation = detail.rows[0];
  const touchedCells = [];

  const roomTypeResult = await client.query('SELECT room_type_id FROM rooms WHERE id = $1', [reservation.room_id]);
  const roomTypeId = roomTypeResult.rows[0]?.room_type_id ?? null;
  if (roomTypeId !== null) {
    let cursor = jakartaDateKey(reservation.check_in);
    const end = jakartaDateKey(reservation.check_out);
    while (cursor && end && cursor < end) {
      touchedCells.push({ room_type_id: Number(roomTypeId), day: cursor });
      cursor = addDays(cursor, 1);
    }
  }

  await client.query('DELETE FROM payment_transactions WHERE reservation_id = $1', [reservationId]);
  await client.query('DELETE FROM folio_entries WHERE reservation_id = $1', [reservationId]);
  await client.query('DELETE FROM availability_locks WHERE reservation_id = $1', [reservationId]);
  await client.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = $2::text', ['RESERVATION', String(reservationId)]);
  if (reservation.correlation_id) {
    await client.query('DELETE FROM audit_logs WHERE correlation_id = $1', [reservation.correlation_id]);
  }
  await client.query('DELETE FROM reservations WHERE id = $1', [reservationId]);

  await client.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      'RM1B_RESIDUE_CLEANUP',
      'PURGE_RESERVATION',
      'RESERVATION',
      String(reservationId),
      JSON.stringify({
        guest_name: reservation.guest_name,
        status: reservation.status,
        check_in: jakartaDateKey(reservation.check_in),
        check_out: jakartaDateKey(reservation.check_out),
        correlation_id: reservation.correlation_id,
        reason: classifyReason(reservation)
      }),
      RUN_CORRELATION
    ]
  );

  return touchedCells;
}

function classifyReason(reservation) {
  const correlation = String(reservation.correlation_id || '');
  for (const prefix of CORRELATION_PREFIXES) {
    if (correlation.startsWith(prefix)) return `correlation-prefix:${prefix}`;
  }
  const guestName = String(reservation.guest_name || '');
  for (const prefix of GUEST_PREFIXES) {
    if (guestName.startsWith(prefix)) return `guest-prefix:${prefix}`;
  }
  if (DOCUMENTED_CORRELATIONS.includes(correlation)) return `documented-correlation:${correlation}`;
  return 'unknown';
}

function expectRow(result, label) {
  if (!result.rows.length) {
    throw new Error(`Expected row for ${label} but found none`);
  }
}

async function purgeStandaloneBookings(bookingRows) {
  let purged = 0;
  for (const booking of bookingRows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const childCheck = await client.query('SELECT COUNT(*)::int AS children FROM reservations WHERE booking_id = $1', [booking.id]);
      if (Number(childCheck.rows[0].children) > 0) {
        await client.query('ROLLBACK');
        continue;
      }
      await client.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = $2::text', ['BOOKING', String(booking.id)]);
      if (booking.correlation_id) {
        await client.query('DELETE FROM audit_logs WHERE correlation_id = $1', [booking.correlation_id]);
      }
      await client.query('DELETE FROM bookings WHERE id = $1', [booking.id]);
      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          'RM1B_RESIDUE_CLEANUP',
          'PURGE_BOOKING',
          'BOOKING',
          String(booking.id),
          JSON.stringify({ correlation_id: booking.correlation_id }),
          RUN_CORRELATION
        ]
      );
      await client.query('COMMIT');
      purged += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return purged;
}

async function purgeGroupedByBooking(reservationRows) {
  const byBooking = new Map();
  for (const row of reservationRows) {
    const bookingKey = Number(row.booking_id);
    if (!byBooking.has(bookingKey)) {
      byBooking.set(bookingKey, []);
    }
    byBooking.get(bookingKey).push(row.id);
  }

  const touchedCells = [];
  let purgedReservations = 0;
  let purgedBookings = 0;

  for (const [bookingId, reservationIds] of byBooking.entries()) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const reservationId of reservationIds) {
        touchedCells.push(...await purgeReservation(client, reservationId));
        purgedReservations += 1;
      }

      const remainingChildren = await client.query('SELECT COUNT(*)::int AS children FROM reservations WHERE booking_id = $1', [bookingId]);
      if (Number(remainingChildren.rows[0].children) === 0 && Number.isFinite(bookingId)) {
        const bookingDetail = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
        if (bookingDetail.rows.length) {
          const booking = bookingDetail.rows[0];
          await client.query('DELETE FROM audit_logs WHERE entity = $1 AND record_id = $2::text', ['BOOKING', String(bookingId)]);
          if (booking.correlation_id) {
            await client.query('DELETE FROM audit_logs WHERE correlation_id = $1', [booking.correlation_id]);
          }
          await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
          await client.query(
            `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              'RM1B_RESIDUE_CLEANUP',
              'PURGE_BOOKING',
              'BOOKING',
              String(bookingId),
              JSON.stringify({ booking_number: booking.booking_number, correlation_id: booking.correlation_id }),
              RUN_CORRELATION
            ]
          );
          purgedBookings += 1;
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return { touchedCells, purgedReservations, purgedBookings };
}

function dedupeCells(cells) {
  const seen = new Map();
  for (const cell of cells) {
    seen.set(`${cell.room_type_id}|${cell.day}`, cell);
  }
  return Array.from(seen.values());
}

async function reconcileTouchedCells(cells) {
  const uniqueCells = dedupeCells(cells);
  if (!uniqueCells.length) {
    return 0;
  }
  const result = await pool.query(
    `WITH input AS (
       SELECT (c->>'room_type_id')::int AS room_type_id, (c->>'day')::date AS day
       FROM json_array_elements($1::json) c
     ),
     active AS (
       SELECT rm.room_type_id, g.d::date AS day, COUNT(*)::int AS active
       FROM reservations r
       JOIN rooms rm ON rm.id = r.room_id
       CROSS JOIN LATERAL generate_series(r.check_in, r.check_out - INTERVAL '1 day', INTERVAL '1 day') g(d)
       WHERE r.status IN ('BOOKED', 'CHECKED_IN')
         AND rm.room_type_id IS NOT NULL
       GROUP BY 1, 2
     )
     UPDATE availability_dates ad
     SET reserved_qty = COALESCE(a.active, 0)
     FROM input i
     LEFT JOIN active a ON a.room_type_id = i.room_type_id AND a.day = i.day
     WHERE ad.room_type_id = i.room_type_id
       AND ad.date::date = i.day
       AND ad.reserved_qty <> COALESCE(a.active, 0)
     RETURNING ad.id`,
    [JSON.stringify(uniqueCells)]
  );
  return result.rowCount;
}

async function reconcileAllLedgerCells() {
  const result = await pool.query(
    `WITH active AS (
       SELECT rm.room_type_id, g.d::date AS day, COUNT(*)::int AS active
       FROM reservations r
       JOIN rooms rm ON rm.id = r.room_id
       CROSS JOIN LATERAL generate_series(r.check_in, r.check_out - INTERVAL '1 day', INTERVAL '1 day') g(d)
       WHERE r.status IN ('BOOKED', 'CHECKED_IN')
         AND rm.room_type_id IS NOT NULL
       GROUP BY 1, 2
     )
     UPDATE availability_dates ad
     SET reserved_qty = COALESCE(a.active, 0)
     FROM availability_dates src
     LEFT JOIN active a ON a.room_type_id = src.room_type_id AND a.day = src.date::date
     WHERE src.id = ad.id
       AND ad.reserved_qty <> COALESCE(a.active, 0)
     RETURNING ad.id`
  );
  return result.rowCount;
}

async function verificationSnapshot() {
  const drift = await pool.query(
    `SELECT COUNT(*)::int AS mismatches
     FROM availability_dates ad
     LEFT JOIN (
       SELECT rm.room_type_id, g.d::date AS day, COUNT(*) AS active
       FROM reservations r
       JOIN rooms rm ON rm.id = r.room_id
       CROSS JOIN LATERAL generate_series(r.check_in, r.check_out - INTERVAL '1 day', INTERVAL '1 day') g(d)
       WHERE r.status IN ('BOOKED', 'CHECKED_IN')
         AND rm.room_type_id IS NOT NULL
       GROUP BY 1, 2
     ) e ON e.room_type_id = ad.room_type_id AND e.day = ad.date::date
     WHERE ad.reserved_qty <> COALESCE(e.active, 0)`
  );
  const negatives = await pool.query('SELECT COUNT(*)::int AS negatives FROM availability_dates WHERE reserved_qty < 0');
  const overCapacity = await pool.query('SELECT COUNT(*)::int AS over_capacity FROM availability_dates WHERE reserved_qty > total_rooms');
  const residue = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM reservations WHERE ${CORRELATION_PREFIXES.map((_, index) => `correlation_id LIKE $${index + 1}`).join(' OR ')}) AS residue_reservations,
       (SELECT COUNT(*)::int FROM bookings WHERE ${CORRELATION_PREFIXES.map((_, index) => `correlation_id LIKE $${index + 1}`).join(' OR ')}) AS residue_bookings`,
    CORRELATION_PREFIXES.map((prefix) => `${prefix}%`)
  );
  const unclassifiable = await pool.query(
    `SELECT r.id, r.booking_id, r.guest_name, r.status, r.correlation_id,
            to_char(r.check_in::date, 'YYYY-MM-DD') AS check_in_key,
            to_char(r.check_out::date, 'YYYY-MM-DD') AS check_out_key
     FROM reservations r
     WHERE r.guest_name IN ('ggggg', 'dshsdsh', 'Demo 101 #1')
        OR r.id IN (11, 21, 37, 788)
     ORDER BY r.id`
  );
  const roomStatuses = await pool.query('SELECT id, status FROM rooms ORDER BY id');
  return {
    driftMismatchCount: Number(drift.rows[0].mismatches),
    negativeCount: Number(negatives.rows[0].negatives),
    overCapacityCount: Number(overCapacity.rows[0].over_capacity),
    residueReservationCount: Number(residue.rows[0].residue_reservations),
    residueBookingCount: Number(residue.rows[0].residue_bookings),
    unclassifiableRows: unclassifiable.rows,
    roomStatuses: roomStatuses.rows
  };
}

async function main() {
  try {
    await pool.query('SELECT 1');

    const targetReservations = await collectTargetReservations();
    const orphanBookings = await collectOrphanTargetBookings(targetReservations);

    console.log(`Targets: ${targetReservations.length} reservation(s) across ${new Set(targetReservations.map((row) => Number(row.booking_id))).size} booking(s); ${orphanBookings.length} standalone booking(s).`);

    const purgeResult = await purgeGroupedByBooking(targetReservations);
    const orphanPurged = await purgeStandaloneBookings(orphanBookings);
    const reconciled = await reconcileTouchedCells(purgeResult.touchedCells);
    const sweptAll = await reconcileAllLedgerCells();

    console.log(`Purged ${purgeResult.purgedReservations} reservation(s), ${purgeResult.purgedBookings + orphanPurged} booking(s), reconciled ${reconciled} touched + ${sweptAll} total ledger cell(s).`);

    const snapshot = await verificationSnapshot();
    console.log(`Verification: ledger-mismatches=${snapshot.driftMismatchCount}, negatives=${snapshot.negativeCount}, over-capacity=${snapshot.overCapacityCount}, residue-reservations=${snapshot.residueReservationCount}, residue-bookings=${snapshot.residueBookingCount}`);
    console.log('Room statuses:', snapshot.roomStatuses.map((row) => `${row.id}:${row.status}`).join(', '));

    if (snapshot.unclassifiableRows.length) {
      console.log('UNCLASSIFIABLE RESIDUE (report-only, NOT deleted):');
      for (const row of snapshot.unclassifiableRows) {
        console.log(`  res=${row.id} booking=${row.booking_id} guest="${row.guest_name}" status=${row.status} corr=${row.correlation_id || '-'} stay=${row.check_in_key}..${row.check_out_key}`);
      }
    } else {
      console.log('UNCLASSIFIABLE RESIDUE: none');
    }

    if (snapshot.driftMismatchCount !== 0 || snapshot.negativeCount !== 0 || snapshot.overCapacityCount !== 0) {
      console.error('Post-cleanup integrity checks failed.');
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('RM-1B residue cleanup failed:', error.message);
  process.exitCode = 1;
});
