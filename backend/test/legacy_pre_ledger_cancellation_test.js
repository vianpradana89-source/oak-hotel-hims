require('dotenv').config();
const { once } = require('events');
const { app, pool } = require('../dist/index');

const runTag = `LPLC${String(Date.now()).slice(-8)}${Math.random().toString(16).slice(2, 6)}`.toUpperCase();
const roomTypeCode = runTag.slice(0, 20);
const roomTypeName = `${runTag} Type`;
const roomNumber = runTag.slice(0, 10);
const trackedBookingIds = [];
const trackedReservationIds = [];
let roomTypeId = null;
let roomId = null;
let propertyId = null;
let server = null;
let baseUrl = '';
let assertions = 0;
let baselineMissingActiveRows = null;

function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

async function hotelDate(offsetDays) {
  const result = await pool.query(
    `SELECT to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date + $1::int, 'YYYY-MM-DD') AS d`,
    [offsetDays]
  );
  return String(result.rows[0].d);
}

async function globalMissingActiveRows() {
  const result = await pool.query(
    `WITH active_nights AS (
       SELECT rm.room_type_id, night.day::date AS date
       FROM reservations r
       JOIN rooms rm ON rm.id = r.room_id
       CROSS JOIN LATERAL generate_series(r.check_in::date, r.check_out::date - 1, INTERVAL '1 day') AS night(day)
       WHERE r.status IN ('BOOKED', 'CHECKED_IN') AND rm.room_type_id IS NOT NULL
       GROUP BY rm.room_type_id, night.day
     )
     SELECT COUNT(*)::int AS c
     FROM active_nights an
     LEFT JOIN availability_dates ad ON ad.room_type_id = an.room_type_id AND ad.date = an.date
     WHERE ad.id IS NULL`
  );
  return Number(result.rows[0].c);
}

async function occupiedHotelDates(checkIn, checkOut) {
  const result = await pool.query(
    `SELECT to_char(day::date, 'YYYY-MM-DD') AS date
     FROM generate_series($1::date, $2::date - 1, INTERVAL '1 day') AS day
     ORDER BY day`,
    [checkIn, checkOut]
  );
  return result.rows.map((row) => String(row.date));
}

function compactDate(date) {
  return date.slice(2).replace(/-/g, '');
}

async function requestCancel(reservationId, label) {
  const response = await fetch(`${baseUrl}/api/reservations/${reservationId}/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-Id': `${runTag}-${label}`
    },
    body: JSON.stringify({ property_id: propertyId })
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_error) { json = null; }
  return { status: response.status, text, json };
}

async function createFixtureMaster(coverageStart, coverageEnd) {
  const property = await pool.query('SELECT id FROM properties ORDER BY id LIMIT 1');
  expect(property.rowCount === 1, 'fixture requires one property');
  propertyId = Number(property.rows[0].id);

  const type = await pool.query(
    `INSERT INTO room_types (
       property_id, code, name, base_rate, capacity, max_adults, max_children, is_active, display_order
     ) VALUES ($1, $2, $3, 100000, 2, 2, 0, TRUE, 9999)
     RETURNING id`,
    [propertyId, roomTypeCode, roomTypeName]
  );
  roomTypeId = Number(type.rows[0].id);

  const room = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
     VALUES ($1, $2, $3, $4, 'VACANT_CLEAN', TRUE)
     RETURNING id`,
    [propertyId, roomTypeId, roomNumber, roomTypeName]
  );
  roomId = Number(room.rows[0].id);

  await pool.query(
    `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
     SELECT $1, $2, day::date, 1, 0
     FROM generate_series($3::date, $4::date, INTERVAL '1 day') AS day
     ON CONFLICT (room_type_id, date) WHERE room_type_id IS NOT NULL DO NOTHING`,
    [roomTypeId, roomTypeName, coverageStart, coverageEnd]
  );
}

async function createReservationFixture(label, checkIn, checkOut, options = {}) {
  const correlationId = `${runTag}-${label}`;
  const legacy = options.legacy === true;
  const booking = await pool.query(
    `INSERT INTO bookings (
       bid, property_id, guest_name_snapshot, booking_source, booking_status,
       currency_code, created_by, correlation_id, created_at
     ) VALUES ($1, $2, $3, 'WALKIN', 'ACTIVE', 'IDR', $4, $5, $6::date)
     RETURNING *`,
    [
      `${runTag}-${label}`.slice(0, 32),
      propertyId,
      `${runTag} ${label}`,
      legacy ? 'phase1d2-backfill' : 'legacy-policy-test',
      correlationId,
      checkIn
    ]
  );
  const bookingRow = booking.rows[0];
  const bookingId = Number(bookingRow.id);
  trackedBookingIds.push(bookingId);

  const reservation = await pool.query(
    `INSERT INTO reservations (
       booking_id, stay_sequence, room_id, guest_name, check_in, check_out,
       status, stay_status, payment_status, booking_type, correlation_id, created_at
     ) VALUES ($1, 1, $2, $3, $4::date, $5::date,
               'BOOKED', 'RESERVED', 'UNPAID', 'WALKIN', $6, $4::date)
     RETURNING *`,
    [bookingId, roomId, `${runTag} ${label}`, checkIn, checkOut, correlationId]
  );
  const reservationRow = reservation.rows[0];
  const reservationId = Number(reservationRow.id);
  trackedReservationIds.push(reservationId);

  if (legacy) {
    await pool.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id)
       VALUES ('PMS', 'BACKFILL', 'BOOKING', $1, $2, $3)`,
      [
        String(bookingId),
        JSON.stringify({
          booking_id: bookingId,
          bid: bookingRow.bid,
          property_id: propertyId,
          reservation_id: reservationId,
          source_reason: 'LEGACY_ONE_TO_ONE_BACKFILL',
          original_reservation_status: 'BOOKED',
          property_local_creation_date: compactDate(checkIn)
        }),
        `${runTag}-BACKFILL-${label}`
      ]
    );
  }

  return { bookingId, reservationId, correlationId };
}

async function incrementCanonical(date) {
  const result = await pool.query(
    `UPDATE availability_dates
     SET reserved_qty = reserved_qty + 1
     WHERE room_type_id = $1 AND date = $2::date AND reserved_qty < total_rooms
     RETURNING id, reserved_qty`,
    [roomTypeId, date]
  );
  expect(result.rowCount === 1, `canonical fixture ledger missing or full on ${date}`);
}

async function lifecycle(reservationId, bookingId) {
  const result = await pool.query(
    `SELECT r.status AS reservation_status, r.stay_status,
            b.booking_status
     FROM reservations r
     JOIN bookings b ON b.id = r.booking_id
     WHERE r.id = $1 AND b.id = $2`,
    [reservationId, bookingId]
  );
  expect(result.rowCount === 1, `fixture lifecycle missing for reservation ${reservationId}`);
  return result.rows[0];
}

async function testNormalCancellation(normalDate) {
  const fixture = await createReservationFixture('NORMAL', normalDate, await hotelDate(2));
  await incrementCanonical(normalDate);
  const response = await requestCancel(fixture.reservationId, 'NORMAL-CANCEL');
  expect(response.status === 200, `normal cancellation failed: ${response.status} ${response.text}`);
  expect(response.json?.meta?.inventory_release_mode === 'NORMAL', 'normal cancellation used legacy mode');
  const ledger = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [roomTypeId, normalDate]
  );
  expect(Number(ledger.rows[0].reserved_qty) === 0, 'normal cancellation did not release inventory');
  const state = await lifecycle(fixture.reservationId, fixture.bookingId);
  expect(state.reservation_status === 'CANCELLED', 'normal reservation not cancelled');
  expect(state.booking_status === 'CANCELLED', 'normal single-child parent not reconciled');

  const cancelAuditsBefore = await pool.query(
    "SELECT COUNT(*)::int AS c FROM audit_logs WHERE action = 'CANCEL' AND entity = 'RESERVATION' AND record_id = $1",
    [String(fixture.reservationId)]
  );
  await pool.query("UPDATE bookings SET booking_status = 'ACTIVE' WHERE id = $1", [fixture.bookingId]);
  const repeat = await requestCancel(fixture.reservationId, 'NORMAL-REPEAT');
  expect(repeat.status === 200, `repeat cancellation failed: ${repeat.status} ${repeat.text}`);
  expect(repeat.json?.meta?.inventory_release_mode === 'NONE_ALREADY_CANCELLED', 'repeat cancellation touched inventory');
  const repeatedState = await lifecycle(fixture.reservationId, fixture.bookingId);
  expect(repeatedState.booking_status === 'CANCELLED', 'repeat cancellation did not reconcile stale parent');
  const cancelAuditsAfter = await pool.query(
    "SELECT COUNT(*)::int AS c FROM audit_logs WHERE action = 'CANCEL' AND entity = 'RESERVATION' AND record_id = $1",
    [String(fixture.reservationId)]
  );
  expect(Number(cancelAuditsAfter.rows[0].c) === Number(cancelAuditsBefore.rows[0].c), 'repeat cancellation duplicated reservation audit');
}

async function testCancellationCompletesMixedParent(date) {
  const fixture = await createReservationFixture('COMPLETE', date, await hotelDate(3));
  await incrementCanonical(date);
  const sibling = await pool.query(
    `INSERT INTO reservations (
       booking_id, stay_sequence, room_id, guest_name, check_in, check_out,
       status, stay_status, payment_status, booking_type, correlation_id, created_at
     ) VALUES ($1, 2, $2, $3, $4::date, $5::date,
               'CHECKED_OUT', 'DEPARTED', 'UNPAID', 'WALKIN', $6, $4::date)
     RETURNING id`,
    [fixture.bookingId, roomId, `${runTag} COMPLETE-SIBLING`, await hotelDate(-5), await hotelDate(-4), `${runTag}-COMPLETE-SIBLING`]
  );
  trackedReservationIds.push(Number(sibling.rows[0].id));

  const response = await requestCancel(fixture.reservationId, 'COMPLETE-CANCEL');
  expect(response.status === 200, `mixed-child cancellation failed: ${response.status} ${response.text}`);
  const state = await lifecycle(fixture.reservationId, fixture.bookingId);
  expect(state.booking_status === 'COMPLETED', 'cancellation did not complete mixed terminal parent');
  const completionAudit = await pool.query(
    "SELECT COUNT(*)::int AS c FROM audit_logs WHERE action = 'COMPLETE' AND entity = 'BOOKING' AND record_id = $1",
    [String(fixture.bookingId)]
  );
  expect(Number(completionAudit.rows[0].c) === 1, 'cancellation-triggered parent completion audit is missing');
}

async function testMissingCurrentBlocked(today) {
  const fixture = await createReservationFixture('CURRENT', today, await hotelDate(1), { legacy: true });
  const removed = await pool.query(
    `DELETE FROM availability_dates
     WHERE room_type_id = $1 AND date = $2::date
     RETURNING room_type, total_rooms`,
    [roomTypeId, today]
  );
  expect(removed.rowCount === 1, 'current fixture row was not removed');
  try {
    const response = await requestCancel(fixture.reservationId, 'CURRENT-CANCEL');
    expect(response.status === 409, `missing current ledger should block, got ${response.status}`);
    expect(response.text.includes('current or future'), 'missing current ledger returned the wrong integrity reason');
    const state = await lifecycle(fixture.reservationId, fixture.bookingId);
    expect(state.reservation_status === 'BOOKED' && state.booking_status === 'ACTIVE', 'blocked current cancellation mutated lifecycle');
  } finally {
    await pool.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES ($1, $2, $3::date, $4, 1)`,
      [roomTypeId, removed.rows[0].room_type, today, removed.rows[0].total_rooms]
    );
  }
}

async function testMissingFutureBlocked(futureDate) {
  const fixture = await createReservationFixture('FUTURE', futureDate, await hotelDate(11), { legacy: true });
  const response = await requestCancel(fixture.reservationId, 'FUTURE-CANCEL');
  expect(response.status === 409, `missing future ledger should block, got ${response.status}`);
  expect(response.text.includes('current or future'), 'missing future ledger returned the wrong integrity reason');
  const state = await lifecycle(fixture.reservationId, fixture.bookingId);
  expect(state.reservation_status === 'BOOKED' && state.booking_status === 'ACTIVE', 'blocked future cancellation mutated lifecycle');
}

async function testEligibleLegacy(legacyStart, coverageStart) {
  const fixture = await createReservationFixture('ELIGIBLE', legacyStart, coverageStart, { legacy: true });
  const expectedOccupiedDates = await occupiedHotelDates(legacyStart, coverageStart);
  const beforeCoverage = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [roomTypeId, coverageStart]
  );
  expect(beforeCoverage.rowCount === 1, 'coverage-start row is missing before legacy cancellation');

  const response = await requestCancel(fixture.reservationId, 'ELIGIBLE-CANCEL');
  expect(response.status === 200, `eligible legacy cancellation failed: ${response.status} ${response.text}`);
  expect(response.json?.meta?.inventory_release_mode === 'LEGACY_PRE_LEDGER', 'eligible cancellation did not use legacy mode');
  expect(
    JSON.stringify(response.json?.meta?.legacy_no_ledger_dates) === JSON.stringify(expectedOccupiedDates),
    'eligible cancellation did not classify the exact [check_in, check_out) dates'
  );

  const fabricated = await pool.query(
    `SELECT date FROM availability_dates
     WHERE (room_type_id = $1 OR (room_type_id IS NULL AND room_type = $2))
       AND date >= $3::date AND date < $4::date`,
    [roomTypeId, roomTypeName, legacyStart, coverageStart]
  );
  expect(fabricated.rowCount === 0, 'legacy cancellation fabricated canonical or matching NULL-ID availability rows');
  const afterCoverage = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [roomTypeId, coverageStart]
  );
  expect(Number(afterCoverage.rows[0].reserved_qty) === Number(beforeCoverage.rows[0].reserved_qty), 'checkout date inventory was changed');

  const state = await lifecycle(fixture.reservationId, fixture.bookingId);
  expect(state.reservation_status === 'CANCELLED' && state.stay_status === 'CANCELLED', 'eligible reservation lifecycle was not cancelled');
  expect(state.booking_status === 'CANCELLED', 'eligible parent booking was not reconciled to CANCELLED');

  const audit = await pool.query(
    `SELECT new_value
     FROM audit_logs
     WHERE action = 'LEGACY_PRE_LEDGER_CANCELLATION'
       AND entity = 'RESERVATION' AND record_id = $1`,
    [String(fixture.reservationId)]
  );
  expect(audit.rowCount === 1, 'dedicated legacy cancellation audit was not written exactly once');
  const payload = JSON.parse(audit.rows[0].new_value);
  expect(Number(payload.reservation_id) === fixture.reservationId, 'legacy audit reservation identity mismatch');
  expect(Number(payload.booking_id) === fixture.bookingId, 'legacy audit booking identity mismatch');
  expect(Number(payload.room_type_id) === roomTypeId, 'legacy audit room type identity mismatch');
  expect(!Object.prototype.hasOwnProperty.call(payload, 'total_rooms'), 'legacy audit stored guessed historical capacity');
  expect(
    JSON.stringify(payload.affected_hotel_dates) === JSON.stringify(expectedOccupiedDates),
    '[check_in, check_out) audit dates are incorrect'
  );
  expect(
    JSON.stringify(payload.occupied_hotel_dates) === JSON.stringify(expectedOccupiedDates),
    'legacy audit occupied dates are not the exact [check_in, check_out) dates'
  );
}

async function testLockBlocksLegacy(lockDate) {
  const fixture = await createReservationFixture('LOCKED', lockDate, await hotelDate(-22), { legacy: true });
  await pool.query(
    `INSERT INTO availability_locks (
       reservation_id, room_type_id, room_type, date, qty_locked, lock_expires_at
     ) VALUES ($1, $2, $3, $4::date, 1, NOW() + INTERVAL '1 hour')`,
    [fixture.reservationId, roomTypeId, roomTypeName, lockDate]
  );
  const response = await requestCancel(fixture.reservationId, 'LOCKED-CANCEL');
  expect(response.status === 409, `availability lock should block legacy cancellation, got ${response.status}`);
  expect(response.text.includes('availability lock exists'), 'lock blocker returned the wrong integrity reason');
  const state = await lifecycle(fixture.reservationId, fixture.bookingId);
  expect(state.reservation_status === 'BOOKED' && state.booking_status === 'ACTIVE', 'lock-blocked cancellation mutated lifecycle');
}

async function testNullIdLedgerCannotReplaceCanonical(nullDate) {
  const fixture = await createReservationFixture('NULLROW', nullDate, await hotelDate(-23));
  let inserted;
  try {
    inserted = await pool.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES (NULL, $1, $2::date, 1, 1)
       RETURNING id`,
      [roomTypeName, nullDate]
    );
  } catch (e) {
    // NOT NULL constraint on room_type_id means the old NULL-ID legacy path
    // is structurally rejected, which satisfies the same intent.
    expect(e.message.includes('not-null constraint') || e.message.includes('null value'), 'NULL-ID insert failed with expected constraint violation');
    return;
  }
  const response = await requestCancel(fixture.reservationId, 'NULLROW-CANCEL');
  expect(response.status === 409, `NULL-ID ledger should not replace canonical inventory: ${response.status} ${response.text}`);
  const ledger = await pool.query('SELECT reserved_qty FROM availability_dates WHERE id = $1', [inserted.rows[0].id]);
  expect(Number(ledger.rows[0].reserved_qty) === 1, 'NULL-ID ledger was changed by canonical cancellation');
  const state = await lifecycle(fixture.reservationId, fixture.bookingId);
  expect(state.reservation_status === 'BOOKED' && state.booking_status === 'ACTIVE', 'missing canonical row mutated lifecycle');
  const audit = await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_logs
     WHERE action = 'LEGACY_PRE_LEDGER_CANCELLATION' AND record_id = $1`,
    [String(fixture.reservationId)]
  );
  expect(Number(audit.rows[0].c) === 0, 'existing NULL-ID ledger incorrectly produced no-ledger audit');
}

async function testCanonicalNullIdCollisionReleasesCanonicalOnly(historicalDate) {
  const canonical = await pool.query(
    `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
     VALUES ($1, $2, $3::date, 1, 1)
     RETURNING id`,
    [roomTypeId, `${roomTypeName} Canonical`, historicalDate]
  );
  const fixture = await createReservationFixture('HISTROW', historicalDate, await hotelDate(-24), { legacy: true });
  let ambiguity;
  try {
    ambiguity = await pool.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES (NULL, $1, $2::date, 1, 1)
       RETURNING id`,
      [roomTypeName, historicalDate]
    );
  } catch (e) {
    // NOT NULL constraint on room_type_id means NULL-ID legacy rows are structurally impossible.
    // Canonical-only cancellation is therefore the only path.
    expect(e.message.includes('not-null constraint') || e.message.includes('null value'), 'NULL-ID insert blocked by NOT NULL constraint');
    const response = await requestCancel(fixture.reservationId, 'HISTROW-CANCEL-NOROW');
    expect(response.status === 200, `canonical-only cancellation failed: ${response.status} ${response.text}`);
    return;
  }

  const response = await requestCancel(fixture.reservationId, 'HISTROW-CANCEL');
  expect(response.status === 200, `canonical collision cancellation failed: ${response.status} ${response.text}`);
  expect(response.json?.meta?.inventory_release_mode === 'NORMAL', 'existing historical ledger did not use normal release');
  const ledger = await pool.query(
    'SELECT id, reserved_qty FROM availability_dates WHERE id = ANY($1::int[]) ORDER BY id',
    [[Number(canonical.rows[0].id), Number(ambiguity.rows[0].id)]]
  );
  const canonicalAfter = ledger.rows.find((row) => Number(row.id) === Number(canonical.rows[0].id));
  const legacyAfter = ledger.rows.find((row) => Number(row.id) === Number(ambiguity.rows[0].id));
  expect(Number(canonicalAfter.reserved_qty) === 0, 'canonical collision row was not released');
  expect(Number(legacyAfter.reserved_qty) === 1, 'legacy collision row was changed');
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (trackedReservationIds.length > 0) {
      await client.query('DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[])', [trackedReservationIds]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [trackedReservationIds]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [trackedReservationIds]);
      await client.query('DELETE FROM guest_receivables WHERE reservation_id = ANY($1::int[])', [trackedReservationIds]);
      await client.query(
        'DELETE FROM pos_order_items WHERE order_id IN (SELECT id FROM pos_orders WHERE reservation_id = ANY($1::int[]))',
        [trackedReservationIds]
      );
      await client.query('DELETE FROM pos_orders WHERE reservation_id = ANY($1::int[])', [trackedReservationIds]);
      await client.query(
        "DELETE FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = ANY($1::text[])",
        [trackedReservationIds.map(String)]
      );
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [trackedReservationIds]);
    }
    if (trackedBookingIds.length > 0) {
      await client.query(
        "DELETE FROM audit_logs WHERE entity = 'BOOKING' AND record_id = ANY($1::text[])",
        [trackedBookingIds.map(String)]
      );
      await client.query('DELETE FROM bookings WHERE id = ANY($1::bigint[])', [trackedBookingIds]);
    }
    await client.query('DELETE FROM audit_logs WHERE correlation_id LIKE $1', [`${runTag}%`]);
    if (roomTypeId !== null) {
      await client.query('DELETE FROM availability_locks WHERE room_type_id = $1', [roomTypeId]);
      await client.query('DELETE FROM availability_dates WHERE room_type_id = $1 OR (room_type_id IS NULL AND room_type = $2)', [roomTypeId, roomTypeName]);
    }
    if (roomId !== null) await client.query('DELETE FROM rooms WHERE id = $1 AND room_number = $2', [roomId, roomNumber]);
    if (roomTypeId !== null) await client.query('DELETE FROM room_types WHERE id = $1 AND code = $2', [roomTypeId, roomTypeCode]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function verifyFinalState() {
  const result = await pool.query(
    `WITH active_nights AS (
       SELECT rm.room_type_id, night.day::date AS date, COUNT(*)::int AS expected_qty
       FROM reservations r
       JOIN rooms rm ON rm.id = r.room_id
       CROSS JOIN LATERAL generate_series(r.check_in::date, r.check_out::date - 1, INTERVAL '1 day') AS night(day)
       WHERE r.status IN ('BOOKED', 'CHECKED_IN') AND rm.room_type_id IS NOT NULL
       GROUP BY rm.room_type_id, night.day
     )
     SELECT
       COUNT(*) FILTER (WHERE ad.reserved_qty IS DISTINCT FROM COALESCE(an.expected_qty, 0))::int AS drift,
       COUNT(*) FILTER (WHERE ad.reserved_qty < 0)::int AS negative,
       COUNT(*) FILTER (WHERE ad.reserved_qty > ad.total_rooms)::int AS over_capacity,
       (SELECT COUNT(*)::int
        FROM active_nights an2
        LEFT JOIN availability_dates ad2 ON ad2.room_type_id = an2.room_type_id AND ad2.date = an2.date
        WHERE ad2.id IS NULL) AS missing_active_rows,
       (SELECT COUNT(*)::int
        FROM reservations r2
        JOIN rooms rm2 ON rm2.id = r2.room_id
        CROSS JOIN LATERAL generate_series(r2.check_in::date, r2.check_out::date - 1, INTERVAL '1 day') AS night2(day)
        LEFT JOIN availability_dates ad2 ON ad2.room_type_id = rm2.room_type_id AND ad2.date = night2.day::date
        WHERE r2.status IN ('BOOKED', 'CHECKED_IN')
          AND r2.correlation_id LIKE $1
          AND ad2.id IS NULL) AS fixture_missing_active_rows,
       (SELECT COUNT(*) FROM reservations WHERE correlation_id LIKE $1)::int
       + (SELECT COUNT(*) FROM bookings WHERE correlation_id LIKE $1)::int
       + (SELECT COUNT(*) FROM audit_logs WHERE correlation_id LIKE $1)::int
       + (SELECT COUNT(*) FROM room_types WHERE code = $2)::int
       + (SELECT COUNT(*) FROM rooms WHERE room_number = $3)::int AS residue
     FROM availability_dates ad
     LEFT JOIN active_nights an ON an.room_type_id = ad.room_type_id AND an.date = ad.date`,
    [`${runTag}%`, roomTypeCode, roomNumber]
  );
  const snapshot = result.rows[0];
  expect(Number(snapshot.drift) === 0, `inventory drift=${snapshot.drift}`);
  expect(Number(snapshot.negative) === 0, `negative inventory=${snapshot.negative}`);
  expect(Number(snapshot.over_capacity) === 0, `over-capacity inventory=${snapshot.over_capacity}`);
  expect(
    Number(snapshot.missing_active_rows) === baselineMissingActiveRows,
    `global missing-active-rows changed from ${baselineMissingActiveRows} to ${snapshot.missing_active_rows}`
  );
  expect(Number(snapshot.fixture_missing_active_rows) === 0, `fixture missing-active-rows=${snapshot.fixture_missing_active_rows}`);
  expect(Number(snapshot.residue) === 0, `test residue=${snapshot.residue}`);
  return snapshot;
}

async function main() {
  const today = await hotelDate(0);
  const coverageStart = await hotelDate(-20);
  const coverageEnd = await hotelDate(3);
  const normalDate = await hotelDate(1);
  const futureMissing = await hotelDate(10);
  const eligibleStart = await hotelDate(-22);
  const lockDate = await hotelDate(-23);
  const nullDate = await hotelDate(-24);
  const historicalDate = await hotelDate(-25);

  let failure = null;
  try {
    baselineMissingActiveRows = await globalMissingActiveRows();
    await createFixtureMaster(coverageStart, coverageEnd);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    await testNormalCancellation(normalDate);
    await testCancellationCompletesMixedParent(await hotelDate(2));
    await testMissingCurrentBlocked(today);
    await testMissingFutureBlocked(futureMissing);
    await testEligibleLegacy(eligibleStart, coverageStart);
    await testLockBlocksLegacy(lockDate);
    await testNullIdLedgerCannotReplaceCanonical(nullDate);
    await testCanonicalNullIdCollisionReleasesCanonicalOnly(historicalDate);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await cleanup();
      const invariants = await verifyFinalState();
      console.log(`legacy pre-ledger cancellation assertions=${assertions}`);
      console.log(`drift=${invariants.drift}`);
      console.log(`negative=${invariants.negative}`);
      console.log(`over-capacity=${invariants.over_capacity}`);
      console.log(`baseline-missing-active-rows=${baselineMissingActiveRows}`);
      console.log(`missing-active-rows=${invariants.missing_active_rows}`);
      console.log(`fixture-missing-active-rows=${invariants.fixture_missing_active_rows}`);
      console.log(`test-residue=${invariants.residue}`);
    } catch (cleanupError) {
      if (!failure) failure = cleanupError;
      else console.error(`cleanup/final verification also failed: ${cleanupError.message}`);
    }
  }

  if (failure) throw failure;
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
  });
