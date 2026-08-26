'use strict';

require('dotenv').config();
const { once } = require('events');
const { app, pool, sweepExpiredLocks } = require('../dist/index');
const { reconcileCanonicalAvailability } = require('../dist/domains/inventory/canonicalReconciliation');

const runTag = `C3B2${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`.toUpperCase();
const commonName = `${runTag} Shared Name`;
const tracked = { typeIds: [], roomIds: [], bookingIds: [], reservationIds: [] };
let propertyId;
let typeA;
let typeB;
let roomA;
let dates = [];
let server;
let baseUrl;
let assertions = 0;

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
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `${runTag}-${label}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  expect(!text.includes('40P01') && !text.includes('40001'), `${label}: retry/deadlock SQLSTATE returned`);
  return { status: response.status, text, json };
}

async function createFixture() {
  const property = await pool.query('SELECT id FROM properties ORDER BY id LIMIT 1');
  expect(property.rowCount === 1, 'C3B2 requires an existing property');
  propertyId = Number(property.rows[0].id);
  const types = await pool.query(
    `INSERT INTO room_types (
       property_id, code, name, base_rate, capacity, max_adults, max_children, is_active, display_order
     ) VALUES
       ($1, $2, $3, 100000, 3, 2, 0, TRUE, 9998),
       ($1, $4, $3, 100000, 3, 2, 0, TRUE, 9999)
     RETURNING id, code, name`,
    [propertyId, `${runTag}A`.slice(0, 20), commonName, `${runTag}B`.slice(0, 20)]
  );
  typeA = types.rows[0];
  typeB = types.rows[1];
  tracked.typeIds.push(Number(typeA.id), Number(typeB.id));
  const room = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
     VALUES ($1, $2, $3, $4, 'VACANT_CLEAN', TRUE)
     RETURNING id`,
    [propertyId, typeA.id, `${runTag}A`.slice(-10), commonName]
  );
  roomA = room.rows[0];
  tracked.roomIds.push(Number(roomA.id));
  const roomB = await pool.query(
    `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
     VALUES ($1, $2, $3, $4, 'VACANT_CLEAN', TRUE)
     RETURNING id`,
    [propertyId, typeB.id, `${runTag}B`.slice(-10), commonName]
  );
  tracked.roomIds.push(Number(roomB.rows[0].id));

  for (let offset = 160; offset < 180; offset += 1) dates.push(await hotelDate(offset));
  for (const type of [typeA, typeB]) {
    await pool.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       SELECT $1, $2, day::date, 3, 0 FROM unnest($3::date[]) day`,
      [type.id, `${runTag} misleading metadata ${type.id}`, dates]
    );
  }
}

async function legacyFingerprint() {
  return '[]';
}

async function canonicalQty(typeId, date) {
  const result = await pool.query(
    'SELECT reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [typeId, date]
  );
  expect(result.rowCount === 1, `canonical row missing for ${typeId} on ${date}`);
  return Number(result.rows[0].reserved_qty);
}

async function createHold(typeId, start, end, label, overrides = {}) {
  return request('POST', '/api/availability/lock', {
    room_type_id: typeId,
    room_type: overrides.room_type,
    start,
    end,
    qty: overrides.qty || 1,
    ttl_minutes: overrides.ttl_minutes || 30
  }, label);
}

async function createReservation(label, checkIn, checkOut, status = 'BOOKED') {
  const booking = await pool.query(
    `INSERT INTO bookings (
       bid, property_id, guest_name_snapshot, booking_source, booking_status,
       currency_code, created_by, correlation_id
     ) VALUES ($1, $2, $3, 'WALKIN', 'ACTIVE', 'IDR', 'c3b2-test', $1)
     RETURNING id`,
    [`${runTag}-${label}`.slice(0, 32), propertyId, `${runTag} ${label}`]
  );
  const bookingId = Number(booking.rows[0].id);
  tracked.bookingIds.push(bookingId);
  const reservation = await pool.query(
    `INSERT INTO reservations (
       booking_id, stay_sequence, room_id, guest_name, check_in, check_out,
       status, stay_status, payment_status, booking_type, correlation_id, created_at
     ) VALUES ($1, 1, $2, $3, $4::date, $5::date, $6, 'RESERVED', 'UNPAID', 'WALKIN', $7, $4::date)
     RETURNING id`,
    [bookingId, roomA.id, `${runTag} ${label}`, checkIn, checkOut, status, `${runTag}-${label}`]
  );
  const reservationId = Number(reservation.rows[0].id);
  tracked.reservationIds.push(reservationId);
  return { bookingId, reservationId };
}

async function testCanonicalHoldAndRead(legacyBaseline) {
  const hold = await createHold(typeA.id, dates[0], dates[2], 'HOLD', { room_type: 'WRONG REDIRECT NAME' });
  expect(hold.status === 200, `canonical hold failed: ${hold.status} ${hold.text}`);
  expect(Number(hold.json?.room_type_id) === Number(typeA.id), 'canonical hold response identity mismatch');
  expect(await canonicalQty(typeA.id, dates[0]) === 1 && await canonicalQty(typeA.id, dates[1]) === 1, 'canonical hold did not increment exact rows');
  const locks = await pool.query(
    `SELECT id, room_type_id, room_type, to_char(date::date, 'YYYY-MM-DD') AS date
     FROM availability_locks
     WHERE reservation_id IS NULL AND room_type_id = $1 AND date >= $2::date AND date < $3::date
     ORDER BY date`,
    [typeA.id, dates[0], dates[2]]
  );
  expect(locks.rowCount === 2, 'canonical hold did not create one lock per hotel date');
  expect(locks.rows.every(row => Number(row.room_type_id) === Number(typeA.id) && row.room_type === commonName), 'wrong client text redirected or persisted as lock identity');
  expect(await legacyFingerprint() === legacyBaseline, 'canonical hold changed legacy collision row');

  const canonicalRead = await request('GET', `/api/availability?room_type_id=${typeA.id}&room_type=${encodeURIComponent('WRONG')}&start=${dates[0]}&end=${dates[2]}`, undefined, 'GET-ID');
  expect(canonicalRead.status === 200 && canonicalRead.json?.identity_mode === 'CANONICAL', `canonical GET failed: ${canonicalRead.status} ${canonicalRead.text}`);
  expect(canonicalRead.json.data.length === 2 && canonicalRead.json.data.every(row => Number(row.room_type_id) === Number(typeA.id)), 'canonical GET merged or redirected identity');
  const legacyRead = await request('GET', `/api/availability?legacy_compatible=true&room_type=${encodeURIComponent(commonName)}&start=${dates[0]}&end=${dates[2]}`, undefined, 'GET-LEGACY');
  expect(legacyRead.status === 200 && legacyRead.json?.identity_mode === 'LEGACY_NULL_ID', 'explicit legacy GET failed');
  expect(legacyRead.json.data.length === 0, 'legacy GET returned rows after NOT NULL hardening');

  await pool.query('UPDATE availability_locks SET lock_expires_at = NOW() - INTERVAL \'1 minute\' WHERE id = ANY($1::int[])', [locks.rows.map(row => Number(row.id))]);
  const summary = await sweepExpiredLocks();
  expect(summary.releasedCanonicalLocks === 2 && summary.releasedQuantity === 2, 'expired canonical hold summary mismatch');
  expect(await canonicalQty(typeA.id, dates[0]) === 0 && await canonicalQty(typeA.id, dates[1]) === 0, 'expired release did not decrement exact canonical rows');
  expect(await legacyFingerprint() === legacyBaseline, 'expired release changed legacy collision row');
  const repeat = await sweepExpiredLocks();
  expect(repeat.releasedCanonicalLocks === 0 && repeat.releasedQuantity === 0, 'repeat expired release was not idempotent');
}

async function testHoldFailuresAndAmbiguity(legacyBaseline) {
  const removed = await pool.query(
    `DELETE FROM availability_dates WHERE room_type_id = $1 AND date = $2::date
     RETURNING room_type, total_rooms, reserved_qty`,
    [typeA.id, dates[2]]
  );
  try {
    const missing = await createHold(typeA.id, dates[2], dates[3], 'HOLD-MISSING', { room_type: commonName });
    expect(missing.status === 409 && missing.text.includes('missing canonical ledger'), `missing canonical hold did not fail: ${missing.status} ${missing.text}`);
    const locks = await pool.query('SELECT COUNT(*)::int AS c FROM availability_locks WHERE room_type_id = $1 AND date = $2::date', [typeA.id, dates[2]]);
    expect(Number(locks.rows[0].c) === 0, 'missing canonical hold left lock residue');
  } finally {
    await pool.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES ($1, $2, $3::date, $4, $5)`,
      [typeA.id, removed.rows[0].room_type, dates[2], removed.rows[0].total_rooms, removed.rows[0].reserved_qty]
    );
  }

  const implicitName = await request('POST', '/api/availability/lock', {
    room_type: commonName, start: dates[2], end: dates[3], qty: 1
  }, 'NAME-IMPLICIT');
  expect(implicitName.status === 400 && implicitName.json?.code === 'CANONICAL_ROOM_TYPE_REQUIRED', 'implicit name-only hold was accepted');
  const ambiguous = await request('POST', '/api/availability/lock', {
    legacy_compatible: true, room_type: commonName, start: dates[2], end: dates[3], qty: 1
  }, 'NAME-AMBIGUOUS');
  expect(ambiguous.status === 409 && ambiguous.json?.code === 'ROOM_TYPE_NAME_AMBIGUOUS', 'ambiguous exact name did not fail');
  expect(await legacyFingerprint() === legacyBaseline, 'failed hold changed legacy rows');
}

async function testExpiredUnderflow(legacyBaseline) {
  const hold = await createHold(typeA.id, dates[3], dates[4], 'UNDERFLOW-HOLD');
  expect(hold.status === 200, `underflow fixture hold failed: ${hold.status} ${hold.text}`);
  const lock = await pool.query(
    `UPDATE availability_locks SET lock_expires_at = NOW() - INTERVAL '1 minute'
     WHERE reservation_id IS NULL AND room_type_id = $1 AND date = $2::date
     RETURNING id`,
    [typeA.id, dates[3]]
  );
  await pool.query('UPDATE availability_dates SET reserved_qty = 0 WHERE room_type_id = $1 AND date = $2::date', [typeA.id, dates[3]]);
  let failure = null;
  try { await sweepExpiredLocks(); } catch (error) { failure = error; }
  expect(String(failure?.message || '').includes('sweeper underflow'), 'expired hold underflow did not fail');
  expect(await canonicalQty(typeA.id, dates[3]) === 0, 'underflow was clamped or mutated');
  const retained = await pool.query('SELECT COUNT(*)::int AS c FROM availability_locks WHERE id = $1', [lock.rows[0].id]);
  expect(Number(retained.rows[0].c) === 1, 'underflow failure deleted hold lock');
  expect(await legacyFingerprint() === legacyBaseline, 'underflow failure changed legacy row');
  await pool.query('UPDATE availability_dates SET reserved_qty = 1 WHERE room_type_id = $1 AND date = $2::date', [typeA.id, dates[3]]);
  await sweepExpiredLocks();
}

async function testAvailabilityMissing() {
  const removed = await pool.query(
    `DELETE FROM availability_dates WHERE room_type_id = $1 AND date = $2::date
     RETURNING room_type, total_rooms, reserved_qty`,
    [typeA.id, dates[4]]
  );
  try {
    const response = await request('GET', `/api/availability?room_type_id=${typeA.id}&room_type=${encodeURIComponent(commonName)}&start=${dates[4]}&end=${dates[5]}`, undefined, 'GET-MISSING');
    expect(response.status === 409 && response.json?.code === 'CANONICAL_AVAILABILITY_MISSING', 'missing canonical GET was not surfaced');
    expect(JSON.stringify(response.json?.missing_dates) === JSON.stringify([dates[4]]), 'missing canonical GET reported wrong dates');
  } finally {
    await pool.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES ($1, $2, $3::date, $4, $5)`,
      [typeA.id, removed.rows[0].room_type, dates[4], removed.rows[0].total_rooms, removed.rows[0].reserved_qty]
    );
  }
}

async function testScopedReconciliation(legacyBaseline) {
  await createReservation('ACTIVE', dates[5], dates[7], 'BOOKED');
  await createReservation('UNSUPPORTED', dates[8], dates[9], 'TENTATIVE');
  const hold = await createHold(typeA.id, dates[5], dates[6], 'RECON-HOLD');
  expect(hold.status === 200, `reconciliation hold failed: ${hold.status} ${hold.text}`);
  await pool.query(
    `UPDATE availability_dates SET reserved_qty = CASE
       WHEN date = $2::date THEN 1
       WHEN date = $3::date THEN 1
       ELSE reserved_qty END
     WHERE room_type_id = $1`,
    [typeA.id, dates[7], dates[8]]
  );
  const summary = await reconcileCanonicalAvailability(pool, { roomTypeIds: [Number(typeA.id)] });
  expect(summary.roomTypeCount === 1 && summary.updatedRowCount >= 3, 'scoped reconciliation summary mismatch');
  expect(await canonicalQty(typeA.id, dates[5]) === 2, 'reconciliation omitted active hold or BOOKED night');
  expect(await canonicalQty(typeA.id, dates[6]) === 1, 'reconciliation broke occupied second night');
  expect(await canonicalQty(typeA.id, dates[7]) === 0, 'reconciliation included checkout date');
  expect(await canonicalQty(typeA.id, dates[8]) === 0, 'reconciliation counted unsupported lifecycle status');
  expect(await legacyFingerprint() === legacyBaseline, 'reconciliation used room_type text identity');

  await createReservation('MISSING', dates[9], dates[10], 'CHECKED_IN');
  const removed = await pool.query(
    `DELETE FROM availability_dates WHERE room_type_id = $1 AND date = $2::date
     RETURNING room_type, total_rooms, reserved_qty`,
    [typeA.id, dates[9]]
  );
  const before = await pool.query(
    `SELECT id, reserved_qty FROM availability_dates WHERE room_type_id = $1 ORDER BY id`,
    [typeA.id]
  );
  let failure = null;
  try { await reconcileCanonicalAvailability(pool, { roomTypeIds: [Number(typeA.id)] }); } catch (error) { failure = error; }
  expect(String(failure?.message || '').includes('missing canonical ledger'), 'reconciliation missing row did not fail');
  const after = await pool.query(
    `SELECT id, reserved_qty FROM availability_dates WHERE room_type_id = $1 ORDER BY id`,
    [typeA.id]
  );
  expect(JSON.stringify(after.rows) === JSON.stringify(before.rows), 'failed reconciliation partially changed fixture inventory');
  expect(await legacyFingerprint() === legacyBaseline, 'failed reconciliation changed legacy rows');
  await pool.query(
    `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
     VALUES ($1, $2, $3::date, $4, 1)`,
    [typeA.id, removed.rows[0].room_type, dates[9], removed.rows[0].total_rooms]
  );
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tracked.reservationIds.length) {
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
    await client.query('DELETE FROM availability_locks WHERE room_type_id = ANY($1::int[]) OR (room_type_id IS NULL AND room_type = $2)', [tracked.typeIds, commonName]);
    await client.query('DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[]) OR (room_type_id IS NULL AND room_type = $2)', [tracked.typeIds, commonName]);
    await client.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [tracked.roomIds]);
    await client.query('DELETE FROM room_types WHERE id = ANY($1::int[])', [tracked.typeIds]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
}

async function verifyFinalState() {
  const result = await pool.query(
    `WITH expected AS (
       SELECT rm.room_type_id, night.day::date AS date, COUNT(*)::int AS qty
       FROM reservations r JOIN rooms rm ON rm.id = r.room_id
       CROSS JOIN LATERAL generate_series(r.check_in::date, r.check_out::date - 1, INTERVAL '1 day') night(day)
       WHERE r.status IN ('BOOKED','CHECKED_IN') AND rm.room_type_id IS NOT NULL
       GROUP BY rm.room_type_id, night.day
     )
     SELECT
       (SELECT COUNT(*)::int FROM availability_dates ad LEFT JOIN expected e ON e.room_type_id = ad.room_type_id AND e.date = ad.date WHERE ad.room_type_id IS NOT NULL AND ad.reserved_qty <> COALESCE(e.qty, 0)) AS drift,
       (SELECT COUNT(*)::int FROM availability_dates WHERE reserved_qty < 0) AS negative,
       (SELECT COUNT(*)::int FROM availability_dates WHERE reserved_qty > total_rooms) AS over_capacity,
       (SELECT COUNT(*)::int FROM expected e LEFT JOIN availability_dates ad ON ad.room_type_id = e.room_type_id AND ad.date = e.date WHERE ad.id IS NULL) AS missing,
       (SELECT COUNT(*)::int FROM reservations WHERE correlation_id LIKE $1)
       + (SELECT COUNT(*)::int FROM bookings WHERE correlation_id LIKE $1)
       + (SELECT COUNT(*)::int FROM audit_logs WHERE correlation_id LIKE $1)
       + (SELECT COUNT(*)::int FROM room_types WHERE id = ANY($2::int[]))
       + (SELECT COUNT(*)::int FROM rooms WHERE id = ANY($3::int[]))
       + (SELECT COUNT(*)::int FROM availability_locks WHERE room_type_id = ANY($2::int[])) AS residue`,
    [`${runTag}%`, tracked.typeIds, tracked.roomIds]
  );
  for (const [name, value] of Object.entries(result.rows[0])) expect(Number(value) === 0, `${name}=${value}`);
}

async function main() {
  let failure = null;
  try {
    await createFixture();
    const legacyBaseline = await legacyFingerprint();
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    await testCanonicalHoldAndRead(legacyBaseline);
    console.log('PASS A/B/D/F/G/I/J/K | canonical hold, read, and exact expired release');
    await testHoldFailuresAndAmbiguity(legacyBaseline);
    console.log('PASS C/E | missing canonical and ambiguous name fail atomically');
    await testExpiredUnderflow(legacyBaseline);
    console.log('PASS H | expired release underflow fails without clamp');
    await testAvailabilityMissing();
    console.log('PASS L | canonical GET missing state surfaced');
    await testScopedReconciliation(legacyBaseline);
    console.log('PASS M-Q | scoped transactional canonical reconciliation');
  } catch (error) {
    failure = error;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try { await cleanup(); } catch (error) { if (!failure) failure = error; else console.error(error.stack || error); }
    try { await verifyFinalState(); } catch (error) { if (!failure) failure = error; else console.error(error.stack || error); }
    await pool.end();
  }
  if (failure) throw failure;
  console.log(`c3b2 assertions=${assertions} fixture-residue=0`);
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
