const { Pool } = require('pg');

const baseUrl = (process.argv[2] || 'http://localhost:5000').replace(/\/$/, '');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const fetchFn = globalThis.fetch || require('node-fetch');

const runId = `RM1B-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const fixture = {
  propertyId: null,
  roomCategoryId: null,
  roomTypeId: null,
  ratePlanId: null,
  roomIds: []
};

async function createFixture() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const propertyCode = `RM${String(Date.now()).slice(-3)}${Math.random().toString(16).slice(2, 3)}`.toUpperCase();
    const roomTypeCode = `RM1B-${propertyCode}`;

    const property = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'RM1B test fixture', TRUE)
       RETURNING id`,
      [runId, propertyCode]
    );
    fixture.propertyId = Number(property.rows[0].id);

    await client.query(
      `INSERT INTO property_pricing_settings (
         property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service
       ) VALUES ($1, 0, 0, FALSE, FALSE)`,
      [fixture.propertyId]
    );

    const category = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active)
       VALUES ($1, 'RM1B', $2, TRUE)
       RETURNING id`,
      [fixture.propertyId, `RM1B ${propertyCode}`]
    );
    fixture.roomCategoryId = Number(category.rows[0].id);

    const roomType = await client.query(
      `INSERT INTO room_types (
         property_id, room_category_id, code, name, base_rate, capacity, is_active
       ) VALUES ($1, $2, $3, $4, 100000, 2, TRUE)
       RETURNING id`,
      [fixture.propertyId, fixture.roomCategoryId, roomTypeCode, runId]
    );
    fixture.roomTypeId = Number(roomType.rows[0].id);

    const ratePlan = await client.query(
      `INSERT INTO rate_plans (
         property_id, room_type_id, code, name, base_rate, is_active, is_archived
       ) VALUES ($1, $2, $3, $4, 100000, TRUE, FALSE)
       RETURNING id`,
      [fixture.propertyId, fixture.roomTypeId, `BAR-${propertyCode}`, `BAR ${propertyCode}`]
    );
    fixture.ratePlanId = Number(ratePlan.rows[0].id);

    const rooms = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES
         ($1, $2, 'RM1B-A', 'RM1B-A', 'VACANT_CLEAN', TRUE),
         ($1, $2, 'RM1B-B', 'RM1B-B', 'VACANT_CLEAN', TRUE)
       RETURNING id, room_number`,
      [fixture.propertyId, fixture.roomTypeId]
    );
    fixture.roomIds = rooms.rows.map((r) => Number(r.id));

    await client.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       SELECT $1, $2, CURRENT_DATE + day_offset, 2, 0
       FROM generate_series(30, 429) AS day_offset`,
      [fixture.roomTypeId, runId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  propertyId = fixture.propertyId;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function localDate(dateValue = new Date()) {
  const date = new Date(dateValue);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

function correlationId(label) {
  return `RM1B-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

async function request(method, path, body, corr) {
  let effectiveBody = body;
  if (method === 'POST' && effectiveBody && typeof effectiveBody === 'object' && propertyId) {
    if (!effectiveBody.property_id) {
      effectiveBody = { ...effectiveBody, property_id: propertyId };
    }
  } else if (method === 'POST' && (effectiveBody === null || effectiveBody === undefined) && propertyId) {
    effectiveBody = { property_id: propertyId };
  }
  let effectivePath = path;
  if (propertyId && (effectivePath.startsWith('/api/rooms') || effectivePath.startsWith('/api/availability') || effectivePath.startsWith('/api/tapechart'))) {
    if (!effectivePath.includes('property_id=')) {
      const sep = effectivePath.includes('?') ? '&' : '?';
      effectivePath = `${effectivePath}${sep}property_id=${propertyId}`;
    }
  }
  const response = await fetchFn(`${baseUrl}${effectivePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': corr },
    body: effectiveBody ? JSON.stringify(effectiveBody) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_e) { json = null; }
  return { status: response.status, text, json };
}

// Restore reserved_qty from active reservations (mirrors reconcile semantics).
async function recomputeReserved(identName, identId, dates) {
  const client = await pool.connect();
  try {
    for (const date of dates) {
      const countRes = identId !== null && identId !== undefined
        ? await client.query(
            `SELECT COUNT(*) AS n
             FROM reservations res
             JOIN rooms rm ON rm.id = res.room_id
             WHERE rm.room_type_id = $1
               AND res.status NOT IN ('CANCELLED','CHECKED_OUT')
               AND res.check_in IS NOT NULL AND res.check_out IS NOT NULL AND res.check_out > res.check_in
               AND $2::date >= res.check_in::date AND $2::date < res.check_out::date`,
            [identId, date]
          )
        : { rows: [{ n: 0 }] };
      const expected = Number(countRes.rows[0].n);
      if (identId !== null && identId !== undefined) {
        await client.query(
          'UPDATE availability_dates SET reserved_qty = $1 WHERE room_type_id = $2 AND date = $3::date',
          [expected, identId, date]
        );
      } else {
        await client.query(
          'UPDATE availability_dates SET reserved_qty = $1 WHERE room_type = $2 AND room_type_id IS NULL AND date = $3::date',
          [expected, identName, date]
        );
      }
    }
  } finally {
    client.release();
  }
}

const trackedCleanups = [];

async function cleanupCorrelation(corr, identName, identId, dates) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      DELETE FROM housekeeping_tasks 
      WHERE reservation_id IN (SELECT id FROM reservations WHERE correlation_id = $1)
         OR (source_type = 'CHECKOUT_EVENT' AND source_entity_id IN (SELECT id::text FROM reservations WHERE correlation_id = $1))
    `, [corr]);
    await client.query('DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE correlation_id = $1)', [corr]);
    await client.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE correlation_id = $1)', [corr]);
    await client.query('DELETE FROM audit_logs WHERE correlation_id = $1', [corr]);
    await client.query("DELETE FROM audit_logs WHERE entity = 'RESERVATION' AND record_id IN (SELECT id::text FROM reservations WHERE correlation_id = $1)", [corr]);
    await client.query("DELETE FROM audit_logs WHERE entity = 'BOOKING' AND record_id IN (SELECT id::text FROM bookings WHERE correlation_id = $1)", [corr]);
    await client.query('DELETE FROM reservations WHERE correlation_id = $1', [corr]);
    await client.query('DELETE FROM bookings WHERE correlation_id = $1', [corr]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await recomputeReserved(identName, identId, dates);
}

async function pickSellableRoom() {
  const result = await pool.query(`
    SELECT r.id, r.status AS room_status, r.room_type_id, r.property_id, COALESCE(rt.name, r.name) AS room_type,
           (SELECT COUNT(*) FROM rooms x WHERE x.room_type_id = r.room_type_id) AS type_rooms
    FROM rooms r
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    WHERE r.status IN ('Ready', 'VACANT_CLEAN', 'INSPECTED') AND r.room_type_id IS NOT NULL
      AND ($1::int IS NULL OR r.property_id = $1)
    ORDER BY (SELECT COUNT(*) FROM rooms x WHERE x.room_type_id = r.room_type_id) DESC, r.id
    LIMIT 1
  `, [propertyId]);
  expect(result.rowCount > 0, 'no sellable room with canonical room_type_id found');
  return result.rows[0];
}

async function availabilityRow(roomTypeId, date) {
  const r = await pool.query(
    'SELECT room_type_id, room_type, total_rooms, reserved_qty FROM availability_dates WHERE room_type_id = $1 AND date = $2::date',
    [roomTypeId, date]
  );
  return r.rowCount > 0 ? r.rows[0] : null;
}

let passedScenarios = 0;

async function testRoomsExposeCanonicalIdentity() {
  const response = await request('GET', '/api/rooms', null, correlationId('ROOMS'));
  expect(response.status === 200, `/api/rooms failed: ${response.text}`);
  const rooms = response.json.data;
  expect(Array.isArray(rooms) && rooms.length > 0, '/api/rooms returned no rooms');
  for (const room of rooms) {
    expect(Object.prototype.hasOwnProperty.call(room, 'room_type_id'), `/api/rooms missing room_type_id for room ${room.id}`);
    expect(room.room_type_id !== undefined && room.room_type_id !== null, `room ${room.id} has null room_type_id`);
    expect(typeof room.name === 'string' && room.name.length > 0, `room ${room.id} missing display name`);
  }
  passedScenarios += 1;
}

async function testAvailabilityCanonicalAndExplicitLegacyModes() {
  const room = await pickSellableRoom();
  const start = addDays(localDate(), 45);
  const end = addDays(start, 3);
  const byId = await request('GET', `/api/availability?room_type_id=${room.room_type_id}&start=${start}&end=${end}`, null, correlationId('AVAIL-ID'));
  expect(byId.status === 200, `availability by room_type_id failed: ${byId.text}`);

  expect(byId.json.data.length > 0, 'availability by id returned no rows');
  for (const row of byId.json.data) {
    expect(Number(row.room_type_id) === Number(room.room_type_id), `row missing canonical room_type_id on ${row.date}`);
  }

  const implicitName = await request('GET', `/api/availability?room_type=${encodeURIComponent(room.room_type)}&start=${start}&end=${end}`, null, correlationId('AVAIL-NAME'));
  expect(implicitName.status === 400, `implicit name-only availability should fail, got ${implicitName.status}`);
  const explicitLegacy = await request('GET', `/api/availability?legacy_compatible=true&room_type=${encodeURIComponent(room.room_type)}&start=${start}&end=${end}`, null, correlationId('AVAIL-LEGACY'));
  expect(explicitLegacy.status === 200, `explicit legacy availability failed: ${explicitLegacy.text}`);
  expect(explicitLegacy.json.data.every((row) => row.room_type_id === null), 'legacy availability merged canonical rows');

  const bad = await request('GET', `/api/availability?room_type_id=abc&start=${start}&end=${end}`, null, correlationId('AVAIL-BAD'));
  expect(bad.status === 400, `invalid room_type_id should 400, got ${bad.status}`);
  passedScenarios += 1;
}

async function testBookingCreateDualWritesCanonicalIdentity() {
  const room = await pickSellableRoom();
  const start = addDays(localDate(), 50);
  const before = await availabilityRow(room.room_type_id, start);

  const corr = correlationId('BOOKING-CREATE');
  const response = await request('POST', '/api/bookings', {
    guest_name: 'RM1B Canonical Guest',
    guest_phone: '081500000001',
    identity_number: '3171012345678901',
    has_valid_identity: true,
    property_id: fixture.propertyId,
    reservations: [
      { room_id: room.id, check_in: start, check_out: addDays(start, 2), guest_name: 'RM1B Canonical Guest', total_price: 500000, qty: 1 }
    ]
  }, corr);
  expect(response.status === 201, `booking create failed: ${response.text}`);

  const after = await availabilityRow(room.room_type_id, start);
  expect(after !== null, 'availability row disappeared after create');
  expect(Number(after.room_type_id) === Number(room.room_type_id), 'availability row lost canonical room_type_id after create (dual-write broken)');
  expect(after.room_type === room.room_type, 'availability row legacy name diverged after create');
  expect(Number(after.reserved_qty) === Number(before.reserved_qty) + 1, `reserved_qty not incremented (before=${before.reserved_qty}, after=${after.reserved_qty})`);

  trackedCleanups.push({ corr, identName: room.room_type, identId: room.room_type_id, dates: [start, addDays(start, 1)] });
  passedScenarios += 1;
}

async function testExtendShortenUsesCanonicalIdentity() {
  const room = await pickSellableRoom();
  const start = addDays(localDate(), 55);
  const midEnd = addDays(start, 2);
  const extendedEnd = addDays(start, 4);
  const dates = [start, addDays(start, 1), addDays(start, 2), addDays(start, 3)];

  const corr = correlationId('EXTEND-SHORTEN');
  const create = await request('POST', '/api/reservations', {
    room_id: room.id, guest_name: 'RM1B Ext Guest', guest_phone: '081500000002',
    identity_number: '3171012345678901', has_valid_identity: true,
    check_in: start, check_out: midEnd, total_price: 400000, qty: 1
  }, corr);
  expect(create.status === 201, `create for extend failed: ${create.text}`);
  const reservationId = Number(create.json.data.id);

  const extend = await request('POST', `/api/reservations/${reservationId}/extend`, { new_check_out: extendedEnd }, `${corr}-EXT`);
  expect(extend.status === 200, `extend failed: ${extend.text}`);
  expect(extend.json.meta.room_type === room.room_type, 'extend meta room_type mismatch');
  expect(Number(extend.json.meta.room_type_id) === Number(room.room_type_id), 'extend meta missing canonical room_type_id');
  const extendedRow = await availabilityRow(room.room_type_id, addDays(start, 3));
  expect(extendedRow !== null && Number(extendedRow.reserved_qty) >= 1, 'extended night not incremented under canonical id');

  const shorten = await request('POST', `/api/reservations/${reservationId}/shorten`, { new_check_out: midEnd }, `${corr}-SHR`);
  expect(shorten.status === 200, `shorten failed: ${shorten.text}`);
  expect(Number(shorten.json.meta.room_type_id) === Number(room.room_type_id), 'shorten meta missing canonical room_type_id');
  const shortenedRow = await availabilityRow(room.room_type_id, addDays(start, 3));
  expect(shortenedRow !== null && Number(shortenedRow.reserved_qty) === 0, 'shortened night not released under canonical id');

  trackedCleanups.push({ corr, identName: room.room_type, identId: room.room_type_id, dates });
  passedScenarios += 1;
}

async function testCancelReleasesUnderCanonicalIdentity() {
  const room = await pickSellableRoom();
  const start = addDays(localDate(), 58);
  const end = addDays(start, 1);

  const corr = correlationId('CANCEL');
  const create = await request('POST', '/api/reservations', {
    room_id: room.id, guest_name: 'RM1B Cancel Guest', guest_phone: '081500000003',
    identity_number: '3171012345678901', has_valid_identity: true,
    check_in: start, check_out: end, total_price: 300000, qty: 1
  }, corr);
  expect(create.status === 201, `create for cancel failed: ${create.text}`);
  const reservationId = Number(create.json.data.id);

  const reserved = await availabilityRow(room.room_type_id, start);
  expect(reserved && Number(reserved.reserved_qty) >= 1, 'night not consumed before cancel');

  const cancel = await request('POST', `/api/reservations/${reservationId}/cancel`, {}, `${corr}-CXL`);
  expect(cancel.status === 200, `cancel failed: ${cancel.text}`);

  const released = await availabilityRow(room.room_type_id, start);
  expect(released !== null, 'availability row vanished after cancel');
  expect(Number(released.room_type_id) === Number(room.room_type_id), 'canonical identity lost after cancel release');
  expect(Number(released.reserved_qty) === 0, `reserved_qty not released on cancel (${released.reserved_qty})`);

  trackedCleanups.push({ corr, identName: room.room_type, identId: room.room_type_id, dates: [start] });
  passedScenarios += 1;
}

async function testCheckoutReleasesInventoryDriftFix() {
  const room = await pickSellableRoom();
  const start = addDays(localDate(), 60);
  const end = addDays(start, 2);
  const dates = [start, addDays(start, 1)];

  const corr = correlationId('CHECKOUT-FIX');
  const create = await request('POST', '/api/reservations', {
    room_id: room.id, guest_name: 'RM1B Checkout Guest', guest_phone: '081500000004',
    identity_number: '3171012345678901', has_valid_identity: true,
    check_in: start, check_out: end, total_price: 600000, qty: 1
  }, corr);
  expect(create.status === 201, `create for checkout failed: ${create.text}`);
  const reservationId = Number(create.json.data.id);

  const checkin = await request('POST', `/api/reservations/${reservationId}/checkin`, { property_id: room.property_id, force: true, override_guest_identity: true, override_housekeeping: true }, `${corr}-CI`);
  expect(checkin.status === 200, `checkin failed: ${checkin.text}`);

  const duringStay = await availabilityRow(room.room_type_id, start);
  expect(duringStay && Number(duringStay.reserved_qty) >= 1, 'in-stay night not counted');

  // RM-1B root-cause regression: checkout MUST release reserved_qty per occupied night.
  const checkout = await request('POST', `/api/reservations/${reservationId}/checkout`, { property_id: room.property_id, skip_inspection: true }, `${corr}-CO`);
  expect(checkout.status === 200, `checkout failed: ${checkout.text}`);

  const afterCheckoutA = await availabilityRow(room.room_type_id, start);
  const afterCheckoutB = await availabilityRow(room.room_type_id, addDays(start, 1));
  expect(Number(afterCheckoutA.reserved_qty) === 0, `DRIFT REPRODUCED: reserved_qty=${afterCheckoutA.reserved_qty} left on ${start} after checkout`);
  expect(Number(afterCheckoutB.reserved_qty) === 0, `DRIFT REPRODUCED: reserved_qty=${afterCheckoutB.reserved_qty} left on ${addDays(start, 1)} after checkout`);

  // restore physical room status mutated by the checkin/checkout lifecycle
  await pool.query('UPDATE rooms SET status = $1 WHERE id = $2', [room.room_status, room.id]);

  trackedCleanups.push({ corr, identName: room.room_type, identId: room.room_type_id, dates });
  passedScenarios += 1;
}

async function testLockEndpointDualWrite() {
  const room = await pickSellableRoom();
  const holdAStart = addDays(localDate(), 65);

  const lock = await request('POST', '/api/availability/lock', {
    room_type_id: room.room_type_id,
    start: holdAStart,
    end: addDays(holdAStart, 1),
    qty: 1,
    ttl_minutes: 30
  }, correlationId('LOCK-ID'));
  expect(lock.status === 200, `lock by room_type_id failed: ${lock.text}`);
  expect(Number(lock.json.room_type_id) === Number(room.room_type_id), 'lock response missing canonical room_type_id');

  const lockRows = await pool.query(
    'SELECT room_type_id, room_type FROM availability_locks WHERE room_type_id = $1 AND date = $2::date',
    [room.room_type_id, holdAStart]
  );
  expect(lockRows.rowCount > 0, 'lock row missing canonical room_type_id (dual-write broken)');
  expect(lockRows.rows[0].room_type === room.room_type, 'lock row legacy name mismatch');

  const implicitNameLock = await request('POST', '/api/availability/lock', {
    room_type: room.room_type,
    start: addDays(localDate(), 66),
    end: addDays(localDate(), 67),
    qty: 1,
    ttl_minutes: 30
  }, correlationId('LOCK-NAME'));
  expect(implicitNameLock.status === 400, `implicit name-only lock should fail: ${implicitNameLock.text}`);

  await pool.query(
    'DELETE FROM availability_locks WHERE room_type_id = $1 AND date = $2::date',
    [room.room_type_id, holdAStart]
  );
  await recomputeReserved(room.room_type, room.room_type_id, [holdAStart]);
  passedScenarios += 1;
}

// C3C post-hardening: verify NULL room_type_id is DB-rejected, implicit
// name-only requests are rejected, and canonical room_type_id is required.
async function testC3CContractNullIdRejected() {
  const room = await pickSellableRoom();
  const probeDate = addDays(localDate(), 70);

  // A. NULL room_type_id INSERT is DB-rejected (C3C NOT NULL enforcement)
  let nullIdError = null;
  try {
    await pool.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES (NULL, $1, $2::date, 1, 0)`,
      [room.room_type, probeDate]
    );
  } catch (error) { nullIdError = error; }
  expect(nullIdError?.code === '23502', `A: NULL room_type_id insert was not rejected (code=${nullIdError?.code})`);

  // B. Implicit name-only availability request is rejected (no room_type_id)
  const implicitName = await request('GET', `/api/availability?room_type=${encodeURIComponent(room.room_type)}&start=${probeDate}&end=${addDays(probeDate, 1)}`, null, correlationId('IMPLICIT-NAME'));
  expect(implicitName.status === 400, `B: implicit name-only request should fail, got ${implicitName.status}`);

  // C. Explicit canonical room_type_id request succeeds
  const canonicalRead = await request('GET', `/api/availability?room_type_id=${room.room_type_id}&start=${probeDate}&end=${addDays(probeDate, 1)}`, null, correlationId('CANONICAL-READ'));
  expect(canonicalRead.status === 200, `C: canonical read failed: ${canonicalRead.text}`);
  expect(canonicalRead.json.data.length === 1, `C: canonical read returned wrong row count (got ${canonicalRead.json.data.length})`);
  expect(Number(canonicalRead.json.data[0].room_type_id) === Number(room.room_type_id), 'C: canonical read room_type_id mismatch');

  // D. room_type text without canonical ID cannot substitute
  const legacySubError = await request('GET', `/api/availability?legacy_compatible=true&room_type=${encodeURIComponent(room.room_type)}&start=${probeDate}&end=${addDays(probeDate, 1)}`, null, correlationId('LEGACY-SUB'));
  expect(legacySubError.status === 200, `D: legacy-compatible read failed: ${legacySubError.text}`);
  expect(legacySubError.json.data.every((row) => row.room_type_id === null || Number(row.room_type_id) === Number(room.room_type_id)),
    'D: legacy read must not return rows with mismatched canonical id');

  // E. Canonical inventory unchanged after all probes
  const finalRow = await availabilityRow(room.room_type_id, probeDate);
  expect(finalRow !== null, 'E: canonical availability row disappeared after probes');
  expect(Number(finalRow.room_type_id) === Number(room.room_type_id), 'E: canonical row room_type_id changed');
  passedScenarios += 1;
}

async function testTapechartExposesCanonicalIdentity() {
  const start = addDays(localDate(), 75);
  const end = addDays(start, 2);
  const response = await request('GET', `/api/tapechart?start=${start}&end=${end}`, null, correlationId('TAPECHART'));
  expect(response.status === 200, `tapechart failed: ${response.text}`);
  const rooms = response.json.rooms;
  expect(Array.isArray(rooms) && rooms.length > 0, 'tapechart returned no rooms');
  let matchedCells = 0;
  for (const room of rooms) {
    expect(Object.prototype.hasOwnProperty.call(room, 'room_type_id'), `tapechart room ${room.id} missing room_type_id`);
    for (const cell of room.cells) {
      if (cell.availability) {
        matchedCells += 1;
        expect(
          cell.availability.room_type_id !== null && Number(cell.availability.room_type_id) === Number(room.room_type_id),
          `tapechart availability room_type_id (${cell.availability.room_type_id}) != room room_type_id (${room.room_type_id}) on ${cell.date}`
        );
        break;
      }
    }
  }
  expect(matchedCells > 0, 'tapechart returned no cells with availability data');
  passedScenarios += 1;
}

async function testInventoryViolationScan() {
  const violations = await pool.query(`
    SELECT COUNT(*) AS negative FROM availability_dates WHERE reserved_qty < 0
  `);
  expect(Number(violations.rows[0].negative) === 0, 'inventory violation: negative reserved_qty exists');

  const overbooked = await pool.query(`
    SELECT COUNT(*) AS over FROM availability_dates WHERE reserved_qty > total_rooms
  `);
  expect(Number(overbooked.rows[0].over) === 0, 'inventory violation: reserved_qty exceeds total_rooms');

  const unmapped = await pool.query(`
    SELECT COUNT(*) AS unmapped FROM availability_dates
    WHERE room_type_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM room_types rt WHERE rt.name = room_type)
  `);
  expect(Number(unmapped.rows[0].unmapped) === 0, 'inventory violation: legacy rows without resolvable canonical id');

  const driftRows = await pool.query(`
    SELECT ad.id, ad.room_type, ad.date, ad.reserved_qty, COALESCE(e.active_nights, 0) AS expected
    FROM availability_dates ad
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS active_nights
      FROM reservations r
      JOIN rooms rm ON rm.id = r.room_id
      LEFT JOIN room_types rt ON rt.id = rm.room_type_id
      WHERE COALESCE(rt.name, rm.name) = ad.room_type
        AND r.status NOT IN ('CANCELLED','CHECKED_OUT')
        AND r.check_in IS NOT NULL AND r.check_out IS NOT NULL AND r.check_out > r.check_in
        AND ad.date >= r.check_in::date
        AND ad.date < r.check_out::date
    ) e ON TRUE
    WHERE ad.reserved_qty <> COALESCE(e.active_nights, 0)
    ORDER BY ad.date
    LIMIT 10
  `);
  if (driftRows.rowCount > 0) {
    const detail = driftRows.rows.map((r) => `${r.room_type}@${String(r.date).slice(0, 10)} ledger=${r.reserved_qty} expected=${r.expected}`).join('; ');
    throw new Error(`inventory drift detected after RM-1B flows: ${detail}`);
  }
  passedScenarios += 1;
}

async function cleanupFixture() {
  if (!fixture.propertyId) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM housekeeping_tasks WHERE property_id = $1', [fixture.propertyId]);
    await client.query('DELETE FROM folio_entries WHERE reservation_id IN (SELECT r.id FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE b.property_id = $1)', [fixture.propertyId]);
    await client.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT r.id FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE b.property_id = $1)', [fixture.propertyId]);
    await client.query('DELETE FROM transaction_attachments WHERE property_id = $1', [fixture.propertyId]);
    await client.query('DELETE FROM transaction_lines WHERE property_id = $1', [fixture.propertyId]);
    await client.query('DELETE FROM transactions WHERE property_id = $1', [fixture.propertyId]);
    await client.query('DELETE FROM transaction_daily_sequences WHERE property_id = $1', [fixture.propertyId]);
    await client.query("DELETE FROM audit_logs WHERE property_id = $1", [fixture.propertyId]);
    await client.query('DELETE FROM reservation_room_moves WHERE property_id = $1', [fixture.propertyId]);
    await client.query('DELETE FROM availability_locks WHERE room_type_id = $1', [fixture.roomTypeId]);
    await client.query('DELETE FROM availability_dates WHERE room_type_id = $1', [fixture.roomTypeId]);
    await client.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [fixture.propertyId]);
    await client.query('DELETE FROM bookings WHERE property_id = $1', [fixture.propertyId]);
    await client.query('DELETE FROM rate_plans WHERE id = $1', [fixture.ratePlanId]);
    await client.query('DELETE FROM rooms WHERE property_id = $1', [fixture.propertyId]);
    await client.query('DELETE FROM room_types WHERE id = $1', [fixture.roomTypeId]);
    await client.query('DELETE FROM room_categories WHERE id = $1', [fixture.roomCategoryId]);
    await client.query('DELETE FROM property_housekeeping_settings WHERE property_id = $1', [fixture.propertyId]);
    await client.query('DELETE FROM property_pricing_settings WHERE property_id = $1', [fixture.propertyId]);
    await client.query('DELETE FROM property_quick_booking_rules WHERE property_id = $1', [fixture.propertyId]);
    await client.query('DELETE FROM properties WHERE id = $1', [fixture.propertyId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  await pool.query('SELECT 1');
  await createFixture();
  let probe = null;
  try {
    probe = await fetchFn(`${baseUrl}/api/rooms?property_id=${propertyId}`);
  } catch (_error) {
    throw new Error(`Backend server is not reachable at ${baseUrl}. Start the backend before running these tests.`);
  }
  expect(probe.ok, `Server responded with ${probe.status} at ${baseUrl}`);

  try {
    await testRoomsExposeCanonicalIdentity();
    await testAvailabilityCanonicalAndExplicitLegacyModes();
    await testBookingCreateDualWritesCanonicalIdentity();
    await testExtendShortenUsesCanonicalIdentity();
    await testCancelReleasesUnderCanonicalIdentity();
    await testCheckoutReleasesInventoryDriftFix();
    await testLockEndpointDualWrite();
    await testC3CContractNullIdRejected();
    await testTapechartExposesCanonicalIdentity();
  } finally {
    for (const cleanup of trackedCleanups) {
      try {
        await cleanupCorrelation(cleanup.corr, cleanup.identName, cleanup.identId, cleanup.dates);
      } catch (cleanupError) {
        console.error(`Cleanup warning for ${cleanup.corr}:`, cleanupError.message || cleanupError);
      }
    }
    await cleanupFixture();
  }

  // Final gate must run after all cleanups restored the ledger.
  await testInventoryViolationScan();

  console.log(`RM-1B canonical identity tests passed (${passedScenarios} scenarios).`);
}

main().catch((error) => {
  console.error('RM-1B canonical identity test failed:', error.message || error);
  process.exitCode = 1;
}).finally(() => {
  pool.end().catch(() => {});
});
