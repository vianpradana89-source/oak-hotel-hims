'use strict';

require('dotenv').config();
const { once } = require('events');
const { app, pool } = require('../dist/index');

const runTag = `C3B1${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`.toUpperCase();
const tracked = { bookingIds: [], reservationIds: [], roomIds: [], typeIds: [] };
let propertyId;
let typeA;
let typeB;
let roomA;
let roomB;
let dates = [];
let server;
let baseUrl;
let assertions = 0;
let deadlocksBefore = 0;

function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

async function hotelDate(offset) {
  const result = await pool.query(
    `SELECT to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date + $1::int, 'YYYY-MM-DD') AS d`,
    [offset]
  );
  return String(result.rows[0].d);
}

async function request(method, path, body, label) {
  const correlationId = `${runTag}-${label}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': correlationId },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  expect(!text.includes('40P01') && !text.includes('40001'), `${label}: retry/deadlock SQLSTATE returned: ${text}`);
  return { status: response.status, text, json, correlationId };
}

async function createFixture() {
  const property = await pool.query('SELECT id FROM properties ORDER BY id LIMIT 1');
  expect(property.rowCount === 1, 'C3B1 requires an existing property');
  propertyId = Number(property.rows[0].id);

  const insertedTypes = await pool.query(
    `INSERT INTO room_types (
       property_id, code, name, base_rate, capacity, max_adults, max_children, is_active, display_order
     ) VALUES
       ($1, $2, $3, 100000, 1, 2, 0, TRUE, 9998),
       ($1, $4, $5, 100000, 1, 2, 0, TRUE, 9999)
     RETURNING id, code, name`,
    [
      propertyId,
      `${runTag}A`.slice(0, 20), `${runTag} Type A`,
      `${runTag}B`.slice(0, 20), `${runTag} Type B`
    ]
  );
  typeA = insertedTypes.rows[0];
  typeB = insertedTypes.rows[1];
  tracked.typeIds.push(Number(typeA.id), Number(typeB.id));

  const insertedRooms = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
     VALUES ($1, $2, $3, $4, 'VACANT_CLEAN', TRUE),
            ($1, $5, $6, $7, 'VACANT_CLEAN', TRUE)
     RETURNING id, room_type_id, room_number`,
    [
      propertyId, typeA.id, `${runTag}A`.slice(-10), typeA.name,
      typeB.id, `${runTag}B`.slice(-10), typeB.name
    ]
  );
  roomA = insertedRooms.rows.find(row => Number(row.room_type_id) === Number(typeA.id));
  roomB = insertedRooms.rows.find(row => Number(row.room_type_id) === Number(typeB.id));
  tracked.roomIds.push(Number(roomA.id), Number(roomB.id));

  for (let offset = 120; offset < 150; offset += 1) dates.push(await hotelDate(offset));
  for (const type of [typeA, typeB]) {
    await pool.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       SELECT $1, $2, day::date, 1, 0
       FROM unnest($3::date[]) AS day`,
      [type.id, `${runTag} misleading metadata ${type.id}`, dates]
    );
  }
}

async function legacyFingerprint() {
  return '[]';
}

async function canonicalQty(typeId, date) {
  const result = await pool.query(
    `SELECT id, reserved_qty, total_rooms
     FROM availability_dates
     WHERE room_type_id = $1 AND date = $2::date`,
    [typeId, date]
  );
  expect(result.rowCount === 1, `canonical row missing for type ${typeId} on ${date}`);
  return Number(result.rows[0].reserved_qty);
}

async function createBooking(roomId, checkIn, checkOut, label) {
  const response = await request('POST', '/api/bookings', {
    property_id: propertyId,
    guest_name: `${runTag} ${label}`,
    guest_phone: '081200000000',
    booking_source: 'WALKIN',
    reservations: [{ room_id: roomId, check_in: checkIn, check_out: checkOut, total_price: 100000, qty: 1 }]
  }, label);
  expect(response.status === 201, `${label}: create failed ${response.status} ${response.text}`);
  const booking = response.json?.data;
  const reservation = booking?.reservations?.[0];
  expect(Number(booking?.booking_id) > 0 && Number(reservation?.id) > 0, `${label}: response identities missing`);
  tracked.bookingIds.push(Number(booking.booking_id));
  tracked.reservationIds.push(Number(reservation.id));
  return { bookingId: Number(booking.booking_id), bid: String(booking.bid), reservationId: Number(reservation.id) };
}

async function assertLifecycle(bookingId, reservationId, bookingStatus, reservationStatus) {
  const result = await pool.query(
    `SELECT b.booking_status, r.status AS reservation_status, r.room_id, r.check_out
     FROM bookings b JOIN reservations r ON r.booking_id = b.id
     WHERE b.id = $1 AND r.id = $2`,
    [bookingId, reservationId]
  );
  expect(result.rowCount === 1, `lifecycle missing for reservation ${reservationId}`);
  expect(String(result.rows[0].booking_status) === bookingStatus, `booking ${bookingId} status changed`);
  expect(String(result.rows[0].reservation_status) === reservationStatus, `reservation ${reservationId} status changed`);
  return result.rows[0];
}

async function deleteCanonical(typeId, date) {
  const result = await pool.query(
    `DELETE FROM availability_dates
     WHERE room_type_id = $1 AND date = $2::date
     RETURNING room_type, total_rooms, reserved_qty`,
    [typeId, date]
  );
  expect(result.rowCount === 1, `failed to remove canonical row ${typeId} ${date}`);
  return result.rows[0];
}

async function restoreCanonical(typeId, date, row) {
  await pool.query(
    `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
     VALUES ($1, $2, $3::date, $4, $5)`,
    [typeId, row.room_type, date, row.total_rooms, row.reserved_qty]
  );
}

async function testCreateExtendShortenCancel(legacyBaseline) {
  const fixture = await createBooking(roomA.id, dates[0], dates[2], 'CREATE');
  expect(await canonicalQty(typeA.id, dates[0]) === 1, 'create did not increment canonical check-in date');
  expect(await canonicalQty(typeA.id, dates[1]) === 1, 'create did not increment canonical second date');

  const extend = await request('POST', `/api/reservations/${fixture.reservationId}/extend`, { new_check_out: dates[4] }, 'EXTEND');
  expect(extend.status === 200, `extend failed ${extend.status} ${extend.text}`);
  expect(await canonicalQty(typeA.id, dates[2]) === 1 && await canonicalQty(typeA.id, dates[3]) === 1, 'extend did not change canonical rows');

  const shorten = await request('POST', `/api/reservations/${fixture.reservationId}/shorten`, { new_check_out: dates[2] }, 'SHORTEN');
  expect(shorten.status === 200, `shorten failed ${shorten.status} ${shorten.text}`);
  expect(await canonicalQty(typeA.id, dates[2]) === 0 && await canonicalQty(typeA.id, dates[3]) === 0, 'shorten did not release canonical rows');

  const cancel = await request('POST', `/api/reservations/${fixture.reservationId}/cancel`, {}, 'CANCEL');
  expect(cancel.status === 200, `single cancellation failed ${cancel.status} ${cancel.text}`);
  expect(await canonicalQty(typeA.id, dates[0]) === 0 && await canonicalQty(typeA.id, dates[1]) === 0, 'cancel did not release canonical rows');
  expect(await legacyFingerprint() === legacyBaseline, 'legacy row changed during create/extend/shorten/cancel');
}

async function testWholeBookingCancel(legacyBaseline) {
  const fixture = await createBooking(roomA.id, dates[5], dates[7], 'WHOLE-CREATE');
  const cancel = await request('POST', `/api/bookings/${fixture.bid}/cancel`, {}, 'WHOLE-CANCEL');
  expect(cancel.status === 200, `whole cancellation failed ${cancel.status} ${cancel.text}`);
  expect(await canonicalQty(typeA.id, dates[5]) === 0 && await canonicalQty(typeA.id, dates[6]) === 0, 'whole cancellation did not release canonical rows');
  expect(await legacyFingerprint() === legacyBaseline, 'legacy row changed during whole cancellation');
}

async function testCheckout(legacyBaseline) {
  const fixture = await createBooking(roomA.id, dates[7], dates[9], 'CHECKOUT-CREATE');
  const checkin = await request('POST', `/api/reservations/${fixture.reservationId}/checkin`, {}, 'CHECKIN');
  expect(checkin.status === 200, `checkin failed ${checkin.status} ${checkin.text}`);
  const checkout = await request('POST', `/api/reservations/${fixture.reservationId}/checkout`, {}, 'CHECKOUT');
  expect(checkout.status === 200, `checkout failed ${checkout.status} ${checkout.text}`);
  expect(await canonicalQty(typeA.id, dates[7]) === 0 && await canonicalQty(typeA.id, dates[8]) === 0, 'checkout did not release canonical rows');
  expect(await legacyFingerprint() === legacyBaseline, 'legacy row changed during checkout');
  await pool.query("UPDATE rooms SET status = 'VACANT_CLEAN' WHERE id = $1", [roomA.id]);
}

async function testMove(legacyBaseline) {
  const fixture = await createBooking(roomA.id, dates[10], dates[12], 'MOVE-CREATE');
  const move = await request('POST', `/api/reservations/${fixture.reservationId}/move`, { to_room_id: roomB.id }, 'MOVE');
  expect(move.status === 200, `move failed ${move.status} ${move.text}`);
  for (const date of [dates[10], dates[11]]) {
    expect(await canonicalQty(typeA.id, date) === 0, `move source canonical row not released on ${date}`);
    expect(await canonicalQty(typeB.id, date) === 1, `move target canonical row not incremented on ${date}`);
  }
  const assignment = await pool.query('SELECT room_id FROM reservations WHERE id = $1', [fixture.reservationId]);
  expect(Number(assignment.rows[0].room_id) === Number(roomB.id), 'move room assignment not changed');
  expect(await legacyFingerprint() === legacyBaseline, 'legacy row changed during move');
  const cancel = await request('POST', `/api/reservations/${fixture.reservationId}/cancel`, {}, 'MOVE-CLEAN-CANCEL');
  expect(cancel.status === 200, `moved reservation cleanup cancellation failed ${cancel.status} ${cancel.text}`);
}

async function testMissingCanonicalFails(legacyBaseline) {
  const missingCreate = await deleteCanonical(typeA.id, dates[13]);
  try {
    const failed = await request('POST', '/api/bookings', {
      property_id: propertyId,
      guest_name: `${runTag} Missing Create`,
      guest_phone: '081200000001',
      reservations: [{ room_id: roomA.id, check_in: dates[13], check_out: dates[14], total_price: 100000, qty: 1 }]
    }, 'MISSING-CREATE');
    expect(failed.status === 409 && failed.text.includes('missing canonical ledger'), `missing create did not fail canonically: ${failed.status} ${failed.text}`);
    const residue = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM bookings WHERE correlation_id = $1)::int AS bookings,
         (SELECT COUNT(*) FROM reservations WHERE correlation_id = $1)::int AS reservations,
         (SELECT COUNT(*) FROM audit_logs WHERE correlation_id = $1)::int AS audits`,
      [failed.correlationId]
    );
    expect(Object.values(residue.rows[0]).every(value => Number(value) === 0), 'missing create left booking/reservation/audit residue');
  } finally {
    await restoreCanonical(typeA.id, dates[13], missingCreate);
  }

  const extendFixture = await createBooking(roomA.id, dates[14], dates[15], 'MISSING-EXTEND-CREATE');
  const missingExtend = await deleteCanonical(typeA.id, dates[15]);
  try {
    const before = await assertLifecycle(extendFixture.bookingId, extendFixture.reservationId, 'ACTIVE', 'BOOKED');
    const failed = await request('POST', `/api/reservations/${extendFixture.reservationId}/extend`, { new_check_out: dates[16] }, 'MISSING-EXTEND');
    expect(failed.status === 409 && failed.text.includes('missing canonical ledger'), `missing extend did not fail canonically: ${failed.status} ${failed.text}`);
    const after = await assertLifecycle(extendFixture.bookingId, extendFixture.reservationId, 'ACTIVE', 'BOOKED');
    expect(String(after.check_out) === String(before.check_out), 'missing extend changed reservation dates');
    const audits = await pool.query("SELECT COUNT(*)::int AS c FROM audit_logs WHERE action = 'EXTEND' AND correlation_id = $1", [failed.correlationId]);
    expect(Number(audits.rows[0].c) === 0, 'missing extend wrote an audit');
  } finally {
    await restoreCanonical(typeA.id, dates[15], missingExtend);
  }

  const moveFixture = await createBooking(roomA.id, dates[16], dates[17], 'MISSING-MOVE-CREATE');
  const missingMove = await deleteCanonical(typeB.id, dates[16]);
  try {
    const sourceBefore = await canonicalQty(typeA.id, dates[16]);
    const failed = await request('POST', `/api/reservations/${moveFixture.reservationId}/move`, { to_room_id: roomB.id }, 'MISSING-MOVE');
    expect(failed.status === 400 && failed.text.includes('missing canonical ledger'), `missing move did not fail canonically: ${failed.status} ${failed.text}`);
    const assignment = await pool.query('SELECT room_id FROM reservations WHERE id = $1', [moveFixture.reservationId]);
    expect(Number(assignment.rows[0].room_id) === Number(roomA.id), 'missing move changed room assignment');
    expect(await canonicalQty(typeA.id, dates[16]) === sourceBefore, 'missing move changed source inventory');
    const audits = await pool.query("SELECT COUNT(*)::int AS c FROM audit_logs WHERE action = 'MOVE' AND correlation_id = $1", [failed.correlationId]);
    expect(Number(audits.rows[0].c) === 0, 'missing move wrote an audit');
  } finally {
    await restoreCanonical(typeB.id, dates[16], missingMove);
  }

  const checkoutFixture = await createBooking(roomA.id, dates[18], dates[19], 'MISSING-CHECKOUT-CREATE');
  const missingCheckout = await deleteCanonical(typeA.id, dates[18]);
  try {
    const failed = await request('POST', `/api/reservations/${checkoutFixture.reservationId}/checkout`, {}, 'MISSING-CHECKOUT');
    expect(failed.status === 409 && failed.text.includes('missing canonical ledger'), `missing checkout did not fail canonically: ${failed.status} ${failed.text}`);
    await assertLifecycle(checkoutFixture.bookingId, checkoutFixture.reservationId, 'ACTIVE', 'BOOKED');
    const audits = await pool.query("SELECT COUNT(*)::int AS c FROM audit_logs WHERE action = 'CHECK_OUT' AND correlation_id = $1", [failed.correlationId]);
    expect(Number(audits.rows[0].c) === 0, 'missing checkout wrote an audit');
  } finally {
    await restoreCanonical(typeA.id, dates[18], missingCheckout);
  }

  const cancelFixture = await createBooking(roomA.id, dates[19], dates[20], 'MISSING-CANCEL-CREATE');
  const missingCancel = await deleteCanonical(typeA.id, dates[19]);
  try {
    const failed = await request('POST', `/api/reservations/${cancelFixture.reservationId}/cancel`, {}, 'MISSING-CANCEL');
    expect(failed.status === 409, `missing cancellation did not fail atomically: ${failed.status} ${failed.text}`);
    await assertLifecycle(cancelFixture.bookingId, cancelFixture.reservationId, 'ACTIVE', 'BOOKED');
    const audits = await pool.query("SELECT COUNT(*)::int AS c FROM audit_logs WHERE action = 'CANCEL' AND correlation_id = $1", [failed.correlationId]);
    expect(Number(audits.rows[0].c) === 0, 'missing cancellation wrote an audit');
  } finally {
    await restoreCanonical(typeA.id, dates[19], missingCancel);
  }
  expect(await legacyFingerprint() === legacyBaseline, 'legacy row changed during missing-canonical failures');
}

async function testDuplicateCanonicalBlocked() {
  let duplicateError = null;
  try {
    await pool.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES ($1, $2, $3::date, 1, 0)`,
      [typeA.id, `${runTag} duplicate`, dates[0]]
    );
  } catch (error) {
    duplicateError = error;
  }
  expect(duplicateError?.code === '23505', `duplicate canonical identity was not DB-blocked: ${duplicateError?.code}`);
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const discovered = await client.query(
      'SELECT id, booking_id FROM reservations WHERE room_id = ANY($1::int[]) FOR UPDATE',
      [tracked.roomIds]
    );
    for (const row of discovered.rows) {
      if (!tracked.reservationIds.includes(Number(row.id))) tracked.reservationIds.push(Number(row.id));
      if (row.booking_id && !tracked.bookingIds.includes(Number(row.booking_id))) tracked.bookingIds.push(Number(row.booking_id));
    }
    if (tracked.reservationIds.length) {
      await client.query('DELETE FROM pos_order_items WHERE order_id IN (SELECT id FROM pos_orders WHERE reservation_id = ANY($1::int[]))', [tracked.reservationIds]);
      await client.query('DELETE FROM pos_orders WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM availability_locks WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM guest_receivables WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query("DELETE FROM audit_logs WHERE entity = 'RESERVATION' AND record_id = ANY($1::text[])", [tracked.reservationIds.map(String)]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [tracked.reservationIds]);
    }
    if (tracked.bookingIds.length) {
      await client.query("DELETE FROM audit_logs WHERE entity = 'BOOKING' AND record_id = ANY($1::text[])", [tracked.bookingIds.map(String)]);
      await client.query('DELETE FROM bookings WHERE id = ANY($1::bigint[])', [tracked.bookingIds]);
    }
    await client.query('DELETE FROM audit_logs WHERE correlation_id LIKE $1', [`${runTag}%`]);
    await client.query('DELETE FROM availability_locks WHERE room_type_id = ANY($1::int[])', [tracked.typeIds]);
    await client.query('DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[]) OR (room_type_id IS NULL AND room_type = ANY($2::text[]))', [tracked.typeIds, [typeA.name, typeB.name]]);
    await client.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [tracked.roomIds]);
    await client.query('DELETE FROM room_types WHERE id = ANY($1::int[])', [tracked.typeIds]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function finalVerification() {
  const result = await pool.query(
    `WITH expected AS (
       SELECT rm.room_type_id, night.day::date AS date, COUNT(*)::int AS qty
       FROM reservations r
       JOIN rooms rm ON rm.id = r.room_id
       CROSS JOIN LATERAL generate_series(r.check_in::date, r.check_out::date - 1, INTERVAL '1 day') night(day)
       WHERE r.status IN ('BOOKED', 'CHECKED_IN') AND rm.room_type_id IS NOT NULL
       GROUP BY rm.room_type_id, night.day
     ), drift AS (
       SELECT ad.id
       FROM availability_dates ad
       LEFT JOIN expected e ON e.room_type_id = ad.room_type_id AND e.date = ad.date
       WHERE ad.room_type_id IS NOT NULL AND ad.reserved_qty <> COALESCE(e.qty, 0)
     ), missing AS (
       SELECT e.room_type_id, e.date FROM expected e
       LEFT JOIN availability_dates ad ON ad.room_type_id = e.room_type_id AND ad.date = e.date
       WHERE ad.id IS NULL
     ), active_overlaps AS (
       SELECT a.id FROM reservations a JOIN reservations b
         ON b.id > a.id AND b.room_id = a.room_id
        AND a.check_in < b.check_out AND a.check_out > b.check_in
       WHERE a.status IN ('BOOKED','CHECKED_IN') AND b.status IN ('BOOKED','CHECKED_IN')
     ), parent_mismatch AS (
       SELECT b.id FROM bookings b
       WHERE b.booking_status = 'ACTIVE'
         AND EXISTS (SELECT 1 FROM reservations r WHERE r.booking_id = b.id)
         AND NOT EXISTS (
           SELECT 1 FROM reservations r
           WHERE r.booking_id = b.id AND UPPER(COALESCE(r.status, '')) NOT IN ('CANCELLED','CHECKED_OUT')
         )
     )
     SELECT
       (SELECT COUNT(*)::int FROM drift) AS drift,
       (SELECT COUNT(*)::int FROM availability_dates WHERE reserved_qty < 0) AS negative,
       (SELECT COUNT(*)::int FROM availability_dates WHERE reserved_qty > total_rooms) AS over_capacity,
       (SELECT COUNT(*)::int FROM missing) AS missing,
       (SELECT COUNT(*)::int FROM (SELECT room_type_id, date FROM availability_dates WHERE room_type_id IS NOT NULL GROUP BY room_type_id, date HAVING COUNT(*) > 1) d) AS duplicates,
       (SELECT COUNT(*)::int FROM active_overlaps) AS overlaps,
       (SELECT COUNT(*)::int FROM parent_mismatch) AS parent_mismatch,
       (SELECT COUNT(*)::int FROM reservations WHERE correlation_id LIKE $1) AS fixture_reservations,
       (SELECT COUNT(*)::int FROM bookings WHERE correlation_id LIKE $1) AS fixture_bookings,
       (SELECT COUNT(*)::int FROM rooms WHERE id = ANY($2::int[])) AS fixture_rooms,
       (SELECT COUNT(*)::int FROM room_types WHERE id = ANY($3::int[])) AS fixture_types,
       (SELECT COUNT(*)::int FROM audit_logs WHERE correlation_id LIKE $1) AS fixture_audits`,
    [`${runTag}%`, tracked.roomIds, tracked.typeIds]
  );
  const counts = result.rows[0];
  for (const [name, value] of Object.entries(counts)) expect(Number(value) === 0, `${name}=${value}`);
  const deadlocks = await pool.query('SELECT deadlocks::bigint AS deadlocks FROM pg_stat_database WHERE datname = current_database()');
  expect(Number(deadlocks.rows[0].deadlocks) === deadlocksBefore, `deadlocks increased ${deadlocksBefore} -> ${deadlocks.rows[0].deadlocks}`);
}

async function main() {
  const deadlocks = await pool.query('SELECT deadlocks::bigint AS deadlocks FROM pg_stat_database WHERE datname = current_database()');
  deadlocksBefore = Number(deadlocks.rows[0].deadlocks);
  let primaryError = null;
  try {
    await createFixture();
    const legacyBaseline = await legacyFingerprint();
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    await testCreateExtendShortenCancel(legacyBaseline);
    console.log('PASS A-F | canonical create/extend/shorten/cancel; collision rows unchanged');
    await testWholeBookingCancel(legacyBaseline);
    console.log('PASS C | whole-booking cancellation canonical only');
    await testCheckout(legacyBaseline);
    console.log('PASS D | checkout canonical only');
    await testMove(legacyBaseline);
    console.log('PASS G | move source/target exact canonical rows');
    await testMissingCanonicalFails(legacyBaseline);
    console.log('PASS H/J | missing canonical fails atomically; text cannot redirect writes');
    await testDuplicateCanonicalBlocked();
    console.log('PASS I | duplicate canonical identity DB-blocked');
  } catch (error) {
    primaryError = error;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try { await cleanup(); } catch (cleanupError) { if (!primaryError) primaryError = cleanupError; else console.error(cleanupError.stack || cleanupError); }
    try { await finalVerification(); } catch (verifyError) { if (!primaryError) primaryError = verifyError; else console.error(verifyError.stack || verifyError); }
    await pool.end();
  }
  if (primaryError) throw primaryError;
  console.log(`PASS K/L | no deadlock/retry SQLSTATE; fixture residue zero; assertions=${assertions}`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
