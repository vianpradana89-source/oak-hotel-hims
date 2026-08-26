'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const fetchFn = globalThis.fetch || require('node-fetch');
const rawBaseUrl = String(process.env.TEST_BASE_URL || '5000').trim();
const baseUrl = (/^\d+$/.test(rawBaseUrl) ? `http://127.0.0.1:${rawBaseUrl}` : rawBaseUrl).replace(/\/$/, '');
const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase().slice(-6);
const fixturePrefix = `R2C${token}`;
const guestMarker = `${fixturePrefix}-GUEST`;
const secondPropertyCode = `Q${token.slice(-5)}`;

const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || process.env.PGPORT || 5432),
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'oak_hotel_db'
});

const CATEGORY_SPECS = [
  { key: 'DLX', label: 'DELUXE', displayOrder: 910 },
  { key: 'STD', label: 'STANDARD', displayOrder: 920 },
  { key: 'PRM-IN', label: 'PREMIERE IN', displayOrder: 930 },
  { key: 'PRM-OUT', label: 'PREMIERE OUT', displayOrder: 940 }
];

const TYPE_SPECS = [
  { key: 'DLXK', categoryKey: 'DLX' },
  { key: 'STDT', categoryKey: 'STD' },
  { key: 'PRMK', categoryKey: 'PRM-IN' },
  { key: 'PRMT', categoryKey: 'PRM-IN' },
  { key: 'DLXT', categoryKey: 'DLX' },
  { key: 'STDK', categoryKey: 'STD' },
  { key: 'DLXTR', categoryKey: 'DLX' },
  { key: 'PRMKO', categoryKey: 'PRM-OUT' },
  { key: 'PRMTO', categoryKey: 'PRM-OUT' }
];

const SNAPSHOT_COLUMNS = [
  'booked_room_type_id_snapshot',
  'booked_room_type_code_snapshot',
  'booked_room_type_name_snapshot',
  'booked_room_category_id_snapshot',
  'booked_room_category_code_snapshot',
  'booked_room_category_name_snapshot',
  'classification_snapshot_source',
  'classification_snapshotted_at'
];

const createdCategoryIds = new Set();
const createdTypeIds = new Set();
const createdRoomIds = new Set();
const createdLockIds = new Set();
const ownedReservationIds = new Set();
const ownedBookingIds = new Set();
const ownedAuditIds = new Set();
const bookingLedgerBaseline = new Map();
const passedCases = new Set();
const categoriesByKey = new Map();
const typesByKey = new Map();
const roomsByTypeKey = new Map();

let sourceProperty = null;
let secondPropertyId = null;
let fixtureDate = null;
let fixtureCheckOut = null;
let legacyReservationId = null;

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

function markCase(number, label) {
  assert(!passedCases.has(number), `case ${number} was marked more than once`);
  passedCases.add(number);
  console.log(`PASS  ${number}. ${label}`);
}

function normalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(normalize(actual));
  const expectedJson = JSON.stringify(normalize(expected));
  assert(actualJson === expectedJson, `${message}; expected=${expectedJson}, actual=${actualJson}`);
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function ids(values) {
  const result = Array.from(values).filter((value) => Number.isInteger(value) && value > 0);
  return result.length > 0 ? result : [0];
}

function categoryCode(key) {
  return `${fixturePrefix}-${key}`;
}

function typeCode(key) {
  return `${fixturePrefix}-${key}`;
}

function ledgerKey(typeId, dateKey) {
  return `${Number(typeId)}|${dateKey}`;
}

async function request(method, requestPath, body, correlationSuffix = 'API') {
  const response = await fetchFn(`${baseUrl}${requestPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-Id': `${fixturePrefix}-${correlationSuffix}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_error) { /* asserted by caller */ }
  return { status: response.status, json, text };
}

async function discoverSourcePropertyAndDate() {
  const propertyResult = await pool.query(`
    SELECT id, property_code, name
    FROM properties
    ORDER BY id
    LIMIT 1
  `);
  assert(propertyResult.rowCount === 1, 'an existing source property is required');
  sourceProperty = {
    id: Number(propertyResult.rows[0].id),
    property_code: String(propertyResult.rows[0].property_code),
    name: String(propertyResult.rows[0].name)
  };

  const dates = await pool.query(`
    SELECT to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date + 30, 'YYYY-MM-DD') AS check_in,
           to_char((NOW() AT TIME ZONE 'Asia/Jakarta')::date + 31, 'YYYY-MM-DD') AS check_out
  `);
  fixtureDate = String(dates.rows[0].check_in);
  fixtureCheckOut = String(dates.rows[0].check_out);
}

async function createCategory(spec) {
  const response = await request('POST', '/api/room-categories', {
    code: categoryCode(spec.key),
    name: `${fixturePrefix} ${spec.label}`,
    description: `${fixturePrefix} disposable ${spec.key} category`,
    display_order: spec.displayOrder
  }, `CATEGORY-${spec.key}`);
  assert(response.status === 201, `category ${spec.key} creation failed: ${response.status} ${response.text}`);
  const category = response.json.data;
  assert(Number(category.property_id) === sourceProperty.id,
    `category ${spec.key} attached to property ${category.property_id}, expected ${sourceProperty.id}`);
  createdCategoryIds.add(Number(category.id));
  categoriesByKey.set(spec.key, category);
  return category;
}

async function createFixtureType(spec) {
  const category = categoriesByKey.get(spec.categoryKey);
  const response = await request('POST', '/api/room-types', {
    code: typeCode(spec.key),
    name: `${fixturePrefix} Type ${spec.key}`,
    room_category_id: Number(category.id),
    capacity: 2,
    max_adults: 2,
    display_order: TYPE_SPECS.indexOf(spec) + 1
  }, `TYPE-${spec.key}`);
  assert(response.status === 201, `type ${spec.key} creation failed: ${response.status} ${response.text}`);
  const roomType = response.json.data;
  createdTypeIds.add(Number(roomType.id));
  typesByKey.set(spec.key, roomType);
  return roomType;
}

async function createFixtureRoom(spec, index) {
  const roomType = typesByKey.get(spec.key);
  const response = await request('POST', '/api/rooms', {
    room_number: `${fixturePrefix}${index.toString(36).toUpperCase()}`,
    room_type_id: Number(roomType.id),
    floor: 'T'
  }, `ROOM-${spec.key}`);
  assert(response.status === 201, `room for ${spec.key} creation failed: ${response.status} ${response.text}`);
  const room = response.json.data;
  createdRoomIds.add(Number(room.id));
  roomsByTypeKey.set(spec.key, room);
  return room;
}

async function createFixtureTopology() {
  for (const spec of CATEGORY_SPECS.slice(1)) await createCategory(spec);
  for (const spec of TYPE_SPECS) await createFixtureType(spec);
  for (let index = 0; index < TYPE_SPECS.length; index += 1) {
    await createFixtureRoom(TYPE_SPECS[index], index);
  }

  for (const spec of TYPE_SPECS) {
    const roomType = typesByKey.get(spec.key);
    const inserted = await pool.query(`
      INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
      VALUES ($1, $2, $3::date, 1, 0)
      RETURNING id
    `, [Number(roomType.id), String(roomType.name), fixtureDate]);
    assert(inserted.rowCount === 1, `availability fixture for ${spec.key} was not inserted`);
  }
}

async function createSecondPropertyAndCategory() {
  const columns = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'properties'
      AND column_name <> 'id'
      AND is_generated = 'NEVER'
    ORDER BY ordinal_position
  `);
  const names = columns.rows.map((row) => String(row.column_name));
  assert(names.includes('property_code') && names.includes('name'), 'properties must expose property_code and name');

  const targetColumns = names.map(quoteIdentifier).join(', ');
  const sourceValues = names.map((name) => {
    if (name === 'property_code') return '$2';
    if (name === 'name') return '$3';
    return `source.${quoteIdentifier(name)}`;
  }).join(', ');
  const insertedProperty = await pool.query(
    `INSERT INTO properties (${targetColumns})
     SELECT ${sourceValues}
     FROM properties source
     WHERE source.id = $1
     RETURNING id`,
    [sourceProperty.id, secondPropertyCode, `${fixturePrefix} Property`]
  );
  assert(insertedProperty.rowCount === 1, 'second-property fixture was not inserted');
  secondPropertyId = Number(insertedProperty.rows[0].id);

  const insertedCategory = await pool.query(`
    INSERT INTO room_categories (property_id, code, name, description, is_active, display_order)
    VALUES ($1, $2, $3, $4, TRUE, 990)
    RETURNING id
  `, [secondPropertyId, categoryCode('OTHER'), `${fixturePrefix} Other Property`, `${fixturePrefix} direct fixture`]);
  assert(insertedCategory.rowCount === 1, 'second-property category fixture was not inserted');
  createdCategoryIds.add(Number(insertedCategory.rows[0].id));
  return Number(insertedCategory.rows[0].id);
}

async function createLifecycleLock() {
  const roomType = typesByKey.get('DLXTR');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(`
      UPDATE availability_dates
      SET reserved_qty = 1
      WHERE room_type_id = $1 AND date = $2::date AND reserved_qty = 0 AND total_rooms = 1
      RETURNING id
    `, [Number(roomType.id), fixtureDate]);
    assert(updated.rowCount === 1, 'lifecycle lock could not reserve its owned ledger row');
    const inserted = await client.query(`
      INSERT INTO availability_locks
        (reservation_id, room_type_id, room_type, date, qty_locked, lock_expires_at)
      VALUES (NULL, $1, $2, $3::date, 1, NOW() + INTERVAL '1 day')
      RETURNING id
    `, [Number(roomType.id), String(roomType.name), fixtureDate]);
    createdLockIds.add(Number(inserted.rows[0].id));
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

async function releaseLifecycleLock() {
  const roomType = typesByKey.get('DLXTR');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await client.query(
      'DELETE FROM availability_locks WHERE id = ANY($1::int[]) AND room_type_id = $2',
      [ids(createdLockIds), Number(roomType.id)]
    );
    assert(deleted.rowCount === 1, 'owned lifecycle lock was not deleted exactly once');
    const updated = await client.query(`
      UPDATE availability_dates
      SET reserved_qty = reserved_qty - 1
      WHERE room_type_id = $1 AND date = $2::date AND reserved_qty = 1
      RETURNING reserved_qty
    `, [Number(roomType.id), fixtureDate]);
    assert(updated.rowCount === 1 && Number(updated.rows[0].reserved_qty) === 0,
      'owned lifecycle lock inventory was not released exactly');
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

async function createLegacyNullSnapshotReservation() {
  const room = roomsByTypeKey.get('STDK');
  const booking = await pool.query(`
    INSERT INTO bookings
      (bid, property_id, guest_name_snapshot, booking_source, booking_status,
       currency_code, created_by, correlation_id)
    VALUES ($1, $2, $3, 'WALKIN', 'CANCELLED', 'IDR', 'rm2c-test', $4)
    RETURNING id
  `, [
    `${fixturePrefix}-LEGACY`, sourceProperty.id, `${fixturePrefix}-LEGACY`,
    `${fixturePrefix}-LEGACY-NULL`
  ]);
  assert(booking.rowCount === 1, 'legacy-null booking fixture was not inserted');
  const legacyBookingId = Number(booking.rows[0].id);
  ownedBookingIds.add(legacyBookingId);

  const inserted = await pool.query(`
    INSERT INTO reservations
      (booking_id, stay_sequence, room_id, guest_name, guest_phone, guest_segment, check_in, check_out,
       total_price, payment_status, booking_number, booking_type, correlation_id, status)
    VALUES ($1, 1, $2, $3, $4, 'Reguler', $5::date, $6::date, 0, 'UNPAID', $7, 'WALKIN', $8, 'CANCELLED')
    RETURNING id
  `, [
    legacyBookingId, Number(room.id), `${fixturePrefix}-LEGACY`, '081200000001', fixtureDate,
    fixtureCheckOut, `${fixturePrefix}-LEGACY`, `${fixturePrefix}-LEGACY-NULL`
  ]);
  assert(inserted.rowCount === 1, 'legacy-null reservation fixture was not inserted');
  legacyReservationId = Number(inserted.rows[0].id);
  ownedReservationIds.add(legacyReservationId);
  await assertLegacySnapshotNull('baseline');
}

async function assertLegacySnapshotNull(label) {
  assert(Number.isInteger(legacyReservationId), `${label}: legacy reservation fixture does not exist`);
  const result = await pool.query(`
    SELECT ${SNAPSHOT_COLUMNS.join(', ')}
    FROM reservations
    WHERE id = $1
  `, [legacyReservationId]);
  assert(result.rowCount === 1, `${label}: legacy reservation fixture is missing`);
  for (const column of SNAPSHOT_COLUMNS) {
    assert(result.rows[0][column] === null, `${label}: legacy fixture column ${column} was rewritten`);
  }
}

async function maxAuditId() {
  const result = await pool.query('SELECT COALESCE(MAX(audit_id), 0)::int AS id FROM audit_logs');
  return Number(result.rows[0].id);
}

async function trackCategoryAudit(categoryId, action, minimumAuditId) {
  const result = await pool.query(`
    SELECT audit_id
    FROM audit_logs
    WHERE audit_id > $1
      AND module = 'ROOM_MASTER'
      AND entity = 'ROOM_CATEGORY'
      AND record_id = $2
      AND action = $3
    ORDER BY audit_id
  `, [minimumAuditId, String(categoryId), action]);
  assert(result.rowCount === 1, `expected one ${action} audit for fixture category ${categoryId}`);
  ownedAuditIds.add(Number(result.rows[0].audit_id));
}

async function snapshotCategoryChildren(categoryId) {
  const [types, rooms, availability, locks] = await Promise.all([
    pool.query(`
      SELECT id, property_id, code, name, room_category_id, description, base_rate,
             capacity, max_adults, max_children, bed_type, is_active, display_order,
             created_at, updated_at
      FROM room_types
      WHERE room_category_id = $1
      ORDER BY id
    `, [categoryId]),
    pool.query(`
      SELECT r.id, r.property_id, r.room_number, r.room_type_id, r.name, r.floor,
             r.status, r.notes, r.is_active, r.updated_at
      FROM rooms r
      JOIN room_types rt ON rt.id = r.room_type_id
      WHERE rt.room_category_id = $1
      ORDER BY r.id
    `, [categoryId]),
    pool.query(`
      SELECT ad.id, ad.room_type_id, ad.room_type, ad.date, ad.total_rooms, ad.reserved_qty
      FROM availability_dates ad
      JOIN room_types rt ON rt.id = ad.room_type_id
      WHERE rt.room_category_id = $1
      ORDER BY ad.room_type_id, ad.date, ad.id
    `, [categoryId]),
    pool.query(`
      SELECT al.id, al.reservation_id, al.room_type_id, al.room_type, al.date,
             al.qty_locked, al.lock_expires_at, al.created_at
      FROM availability_locks al
      JOIN room_types rt ON rt.id = al.room_type_id
      WHERE rt.room_category_id = $1
      ORDER BY al.room_type_id, al.date, al.id
    `, [categoryId])
  ]);
  return { types: types.rows, rooms: rooms.rows, availability: availability.rows, locks: locks.rows };
}

async function verifyDisposableTopology() {
  const fixtureCategoryIds = CATEGORY_SPECS.map((spec) => Number(categoriesByKey.get(spec.key).id));
  const categories = await pool.query(`
    SELECT id, property_id, code, name, is_active, display_order
    FROM room_categories
    WHERE id = ANY($1::int[])
    ORDER BY id
  `, [fixtureCategoryIds]);
  assert(categories.rowCount === CATEGORY_SPECS.length, 'disposable category set must contain exactly four rows');
  const categoryById = new Map(categories.rows.map((row) => [Number(row.id), row]));
  for (const spec of CATEGORY_SPECS) {
    const expected = categoriesByKey.get(spec.key);
    const actual = categoryById.get(Number(expected.id));
    assert(actual && String(actual.code) === categoryCode(spec.key), `fixture category ${spec.key} code mismatch`);
    assert(String(actual.name) === `${fixturePrefix} ${spec.label}`, `fixture category ${spec.key} name mismatch`);
    assert(actual.is_active === true, `fixture category ${spec.key} must be active after lifecycle restoration`);
    assert(Number(actual.property_id) === sourceProperty.id, `fixture category ${spec.key} property mismatch`);
    assert(Number(actual.display_order) === spec.displayOrder, `fixture category ${spec.key} display order mismatch`);
  }

  const mappings = await pool.query(`
    SELECT rt.id, rt.code, rt.name, rt.property_id, rt.room_category_id,
           rc.property_id AS category_property_id, rc.code AS category_code
    FROM room_types rt
    JOIN room_categories rc ON rc.id = rt.room_category_id
    WHERE rt.room_category_id = ANY($1::int[])
    ORDER BY rt.id
  `, [fixtureCategoryIds]);
  assert(mappings.rowCount === TYPE_SPECS.length,
    `disposable topology must contain exactly ${TYPE_SPECS.length} type mappings`);
  const mappingById = new Map(mappings.rows.map((row) => [Number(row.id), row]));
  for (const spec of TYPE_SPECS) {
    const expectedType = typesByKey.get(spec.key);
    const expectedCategory = categoriesByKey.get(spec.categoryKey);
    const actual = mappingById.get(Number(expectedType.id));
    assert(actual && String(actual.code) === typeCode(spec.key), `fixture type ${spec.key} code mismatch`);
    assert(String(actual.name) === `${fixturePrefix} Type ${spec.key}`, `fixture type ${spec.key} name mismatch`);
    assert(Number(actual.room_category_id) === Number(expectedCategory.id),
      `fixture type ${spec.key} is not mapped by canonical room_category_id`);
    assert(String(actual.category_code) === categoryCode(spec.categoryKey),
      `fixture type ${spec.key} category code mismatch`);
    assert(Number(actual.property_id) === sourceProperty.id
      && Number(actual.category_property_id) === sourceProperty.id,
    `fixture type ${spec.key} violates property consistency`);
  }
}

async function verifyFixtureRoomMappings() {
  const result = await pool.query(`
    SELECT id, property_id, room_number, room_type_id
    FROM rooms
    WHERE id = ANY($1::int[])
    ORDER BY id
  `, [ids(createdRoomIds)]);
  assert(result.rowCount === TYPE_SPECS.length, 'fixture physical room set is incomplete');
  const byId = new Map(result.rows.map((row) => [Number(row.id), row]));
  for (const spec of TYPE_SPECS) {
    const expectedRoom = roomsByTypeKey.get(spec.key);
    const expectedType = typesByKey.get(spec.key);
    const actual = byId.get(Number(expectedRoom.id));
    assert(actual && Number(actual.room_type_id) === Number(expectedType.id),
      `fixture room for ${spec.key} changed canonical room_type_id`);
    assert(Number(actual.property_id) === sourceProperty.id, `fixture room for ${spec.key} property mismatch`);
    assert(String(actual.room_number).startsWith(fixturePrefix), `fixture room for ${spec.key} lost ownership marker`);
  }
}

async function verifyInventorySchemaIdentity() {
  const result = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('availability_dates', 'availability_locks')
      AND column_name IN ('room_type_id', 'room_category_id')
    ORDER BY table_name, column_name
  `);
  const columns = new Map();
  for (const row of result.rows) {
    const values = columns.get(row.table_name) || [];
    values.push(String(row.column_name));
    columns.set(String(row.table_name), values);
  }
  assertDeepEqual(columns.get('availability_dates'), ['room_type_id'],
    'availability_dates identity must remain room_type_id-only');
  assertDeepEqual(columns.get('availability_locks'), ['room_type_id'],
    'availability_locks identity must remain room_type_id-only');
}

async function snapshotLedger(typeId, dateKey) {
  const result = await pool.query(`
    SELECT id, room_type_id, room_type, to_char(date, 'YYYY-MM-DD') AS date,
           total_rooms, reserved_qty
    FROM availability_dates
    WHERE room_type_id = $1 AND date = $2::date
  `, [typeId, dateKey]);
  assert(result.rowCount === 1, `expected one owned ledger row for type ${typeId} on ${dateKey}`);
  const row = result.rows[0];
  return {
    id: Number(row.id),
    room_type_id: Number(row.room_type_id),
    room_type: String(row.room_type),
    date: String(row.date),
    total_rooms: Number(row.total_rooms),
    reserved_qty: Number(row.reserved_qty)
  };
}

async function assertLedgerDelta(typeId, dateKey, delta, message) {
  const baseline = bookingLedgerBaseline.get(ledgerKey(typeId, dateKey));
  assert(baseline, `missing booking ledger baseline for fixture type ${typeId}`);
  const current = await snapshotLedger(typeId, dateKey);
  assert(current.reserved_qty === baseline.reserved_qty + delta,
    `${message}: expected reserved_qty ${baseline.reserved_qty + delta}, got ${current.reserved_qty}`);
  assert(current.id === baseline.id && current.room_type_id === baseline.room_type_id
    && current.room_type === baseline.room_type && current.total_rooms === baseline.total_rooms,
  `${message}: non-reservation ledger fields changed`);
}

async function assertFixtureInventoryInvariant() {
  const result = await pool.query(`
    WITH expected AS (
      SELECT rm.room_type_id, COUNT(*)::int AS expected_qty
      FROM reservations r
      JOIN rooms rm ON rm.id = r.room_id
      WHERE r.id = ANY($1::int[])
        AND r.status IN ('BOOKED', 'CHECKED_IN')
        AND r.check_in < $2::date + INTERVAL '1 day'
        AND r.check_out > $2::date
      GROUP BY rm.room_type_id
    )
    SELECT ad.room_type_id, ad.total_rooms, ad.reserved_qty,
           COALESCE(expected.expected_qty, 0)::int AS expected_qty
    FROM availability_dates ad
    LEFT JOIN expected ON expected.room_type_id = ad.room_type_id
    WHERE ad.room_type_id = ANY($3::int[]) AND ad.date = $2::date
    ORDER BY ad.room_type_id
  `, [ids(ownedReservationIds), fixtureDate, ids(createdTypeIds)]);
  assert(result.rowCount === TYPE_SPECS.length, 'owned inventory invariant did not cover every fixture type');
  for (const row of result.rows) {
    assert(Number(row.reserved_qty) === Number(row.expected_qty),
      `owned inventory drift for type ${row.room_type_id}: actual=${row.reserved_qty}, expected=${row.expected_qty}`);
    assert(Number(row.reserved_qty) >= 0, `owned inventory is negative for type ${row.room_type_id}`);
    assert(Number(row.reserved_qty) <= Number(row.total_rooms),
      `owned inventory exceeds capacity for type ${row.room_type_id}`);
  }
}

async function readReservationSnapshot(reservationId) {
  const result = await pool.query(`
    SELECT id, room_id,
           booked_room_type_id_snapshot, booked_room_type_code_snapshot, booked_room_type_name_snapshot,
           booked_room_category_id_snapshot, booked_room_category_code_snapshot, booked_room_category_name_snapshot,
           classification_snapshot_source, classification_snapshotted_at
    FROM reservations
    WHERE id = $1
  `, [reservationId]);
  assert(result.rowCount === 1, `reservation ${reservationId} not found for snapshot inspection`);
  return result.rows[0];
}

async function runCases() {
  await pool.query('SELECT 1');
  let probe;
  try {
    probe = await fetchFn(`${baseUrl}/api/room-categories`);
  } catch (_error) {
    throw new Error(`backend is not reachable at ${baseUrl}`);
  }
  assert(probe.ok, `backend probe returned HTTP ${probe.status}`);

  await discoverSourcePropertyAndDate();

  const firstCategory = await createCategory(CATEGORY_SPECS[0]);
  assert(String(firstCategory.code) === categoryCode('DLX') && firstCategory.is_active === true,
    'created fixture category fields are incorrect');
  markCase(1, 'category creation');

  const duplicateCode = await request('POST', '/api/room-categories', {
    code: categoryCode('DLX'),
    name: `${fixturePrefix} Other Name`
  }, 'DUP-CODE');
  assert(duplicateCode.status === 409 && duplicateCode.json?.code === 'ROOM_CATEGORY_CODE_EXISTS',
    `duplicate category code must return ROOM_CATEGORY_CODE_EXISTS, got ${duplicateCode.status} ${duplicateCode.text}`);
  markCase(2, 'duplicate category code rejected');

  const duplicateName = await request('POST', '/api/room-categories', {
    code: categoryCode('DUP'),
    name: `  ${fixturePrefix.toLowerCase()}   deluxe  `
  }, 'DUP-NAME');
  assert(duplicateName.status === 409 && duplicateName.json?.code === 'ROOM_CATEGORY_NAME_EXISTS',
    `normalized duplicate category name must return ROOM_CATEGORY_NAME_EXISTS, got ${duplicateName.status} ${duplicateName.text}`);
  markCase(3, 'normalized-name duplicate rejected');

  await createFixtureTopology();
  await createLegacyNullSnapshotReservation();
  const otherPropertyCategoryId = await createSecondPropertyAndCategory();
  const crossPropertyType = typesByKey.get('STDT');
  const crossProperty = await request('PATCH', `/api/room-types/${crossPropertyType.id}`, {
    room_category_id: otherPropertyCategoryId
  }, 'CROSS-PROPERTY');
  assert(crossProperty.status === 409 && crossProperty.json?.code === 'ROOM_CATEGORY_PROPERTY_MISMATCH',
    `cross-property category assignment must be rejected, got ${crossProperty.status} ${crossProperty.text}`);
  const typeAfterCrossProperty = await pool.query(
    'SELECT property_id, room_category_id FROM room_types WHERE id = $1',
    [Number(crossPropertyType.id)]
  );
  assert(Number(typeAfterCrossProperty.rows[0].property_id) === sourceProperty.id
    && Number(typeAfterCrossProperty.rows[0].room_category_id) === Number(categoriesByKey.get('STD').id),
  'cross-property rejection changed the fixture type identity');
  markCase(4, 'cross-property category assignment rejected');

  const lifecycleCategory = categoriesByKey.get('DLX');
  await createLifecycleLock();
  const childrenBefore = await snapshotCategoryChildren(Number(lifecycleCategory.id));
  assert(childrenBefore.types.length === 3, 'fixture DLX category must have exactly three child types');
  assert(childrenBefore.rooms.length === 3, 'fixture DLX category must have exactly three child rooms');
  assert(childrenBefore.availability.length === 3, 'fixture DLX category must have exactly three inventory rows');
  assert(childrenBefore.locks.length === 1, 'fixture DLX category must have exactly one lifecycle lock');

  const deactivateAuditFloor = await maxAuditId();
  const deactivated = await request('PATCH', `/api/room-categories/${lifecycleCategory.id}`, {
    is_active: false
  }, 'FIXTURE-DEACTIVATE');
  assert(deactivated.status === 200 && deactivated.json?.data?.is_active === false,
    `fixture category deactivation failed: ${deactivated.status} ${deactivated.text}`);
  await trackCategoryAudit(Number(lifecycleCategory.id), 'DEACTIVATE', deactivateAuditFloor);
  markCase(6, 'category deactivation changes classification state only');

  const childrenAfter = await snapshotCategoryChildren(Number(lifecycleCategory.id));
  assertDeepEqual(childrenAfter.types, childrenBefore.types, 'category deactivation changed a fixture child room type');
  markCase(7, 'category deactivation preserves child room types');
  assertDeepEqual(childrenAfter.rooms, childrenBefore.rooms, 'category deactivation changed a fixture child physical room');
  markCase(8, 'category deactivation preserves child physical rooms');
  assertDeepEqual(childrenAfter.availability, childrenBefore.availability,
    'category deactivation changed fixture availability inventory');
  assertDeepEqual(childrenAfter.locks, childrenBefore.locks, 'category deactivation changed fixture availability locks');
  markCase(9, 'category deactivation preserves inventory and locks');

  const inactiveAssignment = await request('POST', '/api/room-types', {
    code: typeCode('INACTIVE'),
    name: `${fixturePrefix} Inactive Assignment`,
    room_category_id: Number(lifecycleCategory.id),
    capacity: 2
  }, 'INACTIVE-ASSIGN');
  assert(inactiveAssignment.status === 409 && inactiveAssignment.json?.code === 'ROOM_CATEGORY_INACTIVE',
    `inactive category assignment must be rejected, got ${inactiveAssignment.status} ${inactiveAssignment.text}`);
  markCase(5, 'inactive category assignment rejected');

  const activateAuditFloor = await maxAuditId();
  const reactivated = await request('PATCH', `/api/room-categories/${lifecycleCategory.id}`, {
    is_active: true
  }, 'FIXTURE-REACTIVATE');
  assert(reactivated.status === 200 && reactivated.json?.data?.is_active === true,
    `fixture category reactivation failed: ${reactivated.status} ${reactivated.text}`);
  await trackCategoryAudit(Number(lifecycleCategory.id), 'ACTIVATE', activateAuditFloor);
  await releaseLifecycleLock();

  const unusedCategory = await createCategory({ key: 'UNUSED', label: 'UNUSED', displayOrder: 980 });
  const safeDelete = await request('DELETE', `/api/room-categories/${unusedCategory.id}`, undefined, 'DELETE-UNUSED');
  assert(safeDelete.status === 200 && Number(safeDelete.json?.data?.id) === Number(unusedCategory.id),
    `unused category delete failed: ${safeDelete.status} ${safeDelete.text}`);
  const deletedProbe = await request('GET', `/api/room-categories/${unusedCategory.id}`, undefined, 'DELETE-PROBE');
  assert(deletedProbe.status === 404, 'deleted unused fixture category must return 404');
  markCase(10, 'safe delete succeeds for an unused category');

  const blockedDelete = await request('DELETE', `/api/room-categories/${lifecycleCategory.id}`, undefined, 'DELETE-BLOCKED');
  assert(blockedDelete.status === 409 && blockedDelete.json?.code === 'ROOM_CATEGORY_HAS_ROOM_TYPES',
    `category delete with a fixture child type must be blocked, got ${blockedDelete.status} ${blockedDelete.text}`);
  const blockedStillExists = await pool.query('SELECT id FROM room_categories WHERE id = $1', [Number(lifecycleCategory.id)]);
  assert(blockedStillExists.rowCount === 1, 'blocked category delete removed the fixture category');
  markCase(11, 'category delete is blocked by a child room type');

  await verifyDisposableTopology();
  markCase(12, 'disposable category ids and exact type mappings are canonical');

  await verifyInventorySchemaIdentity();
  markCase(14, 'availability and locks remain room_type_id-only');

  const snapshotSchema = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'reservations'
      AND column_name = ANY($1::text[])
    ORDER BY ordinal_position
  `, [SNAPSHOT_COLUMNS]);
  assertDeepEqual(snapshotSchema.rows.map((row) => String(row.column_name)), SNAPSHOT_COLUMNS,
    'reservation snapshot columns do not use the exact approved names/order');

  const sourceRoom = roomsByTypeKey.get('STDT');
  const targetRoom = roomsByTypeKey.get('DLXK');
  const sourceType = typesByKey.get('STDT');
  const targetType = typesByKey.get('DLXK');
  const sourceBaseline = await snapshotLedger(Number(sourceType.id), fixtureDate);
  const targetBaseline = await snapshotLedger(Number(targetType.id), fixtureDate);
  bookingLedgerBaseline.set(ledgerKey(sourceBaseline.room_type_id, fixtureDate), sourceBaseline);
  bookingLedgerBaseline.set(ledgerKey(targetBaseline.room_type_id, fixtureDate), targetBaseline);

  const spoof = {
    booked_room_type_id_snapshot: 999999,
    booked_room_type_code_snapshot: 'SPOOF-TYPE',
    booked_room_type_name_snapshot: 'Spoof Type Name',
    booked_room_category_id_snapshot: 999998,
    booked_room_category_code_snapshot: 'SPOOF-CATEGORY',
    booked_room_category_name_snapshot: 'Spoof Category Name',
    classification_snapshot_source: 'CLIENT_SPOOF',
    classification_snapshotted_at: '2000-01-01T00:00:00.000Z'
  };
  const booking = await request('POST', '/api/bookings', {
    property_id: sourceProperty.id,
    guest_name: guestMarker,
    guest_phone: '081200000000',
    booking_source: 'WALKIN',
    reservations: [{
      room_id: Number(sourceRoom.id),
      check_in: fixtureDate,
      check_out: fixtureCheckOut,
      total_price: 123456,
      qty: 1,
      ...spoof
    }]
  }, 'BOOKING');
  assert(booking.status === 201, `fixture booking creation failed: ${booking.status} ${booking.text}`);
  const bookingId = Number(booking.json?.data?.booking_id);
  const reservationId = Number(booking.json?.data?.reservations?.[0]?.id);
  assert(Number.isInteger(bookingId) && Number.isInteger(reservationId), 'booking response omitted fixture ids');
  ownedBookingIds.add(bookingId);
  ownedReservationIds.add(reservationId);

  const createdSnapshot = await readReservationSnapshot(reservationId);
  const sourceCategory = categoriesByKey.get('STD');
  assert(Number(createdSnapshot.booked_room_type_id_snapshot) === Number(sourceType.id),
    'booked room type id snapshot is not canonical');
  assert(String(createdSnapshot.booked_room_type_code_snapshot) === String(sourceType.code),
    'booked room type code snapshot mismatch');
  assert(String(createdSnapshot.booked_room_type_name_snapshot) === String(sourceType.name),
    'booked room type name snapshot mismatch');
  assert(Number(createdSnapshot.booked_room_category_id_snapshot) === Number(sourceCategory.id),
    'booked category id snapshot is not canonical');
  assert(String(createdSnapshot.booked_room_category_code_snapshot) === String(sourceCategory.code),
    'booked category code snapshot mismatch');
  assert(String(createdSnapshot.booked_room_category_name_snapshot) === String(sourceCategory.name),
    'booked category name snapshot mismatch');
  assert(String(createdSnapshot.classification_snapshot_source) === 'CANONICAL_ROOM_MASTER',
    'snapshot source must be CANONICAL_ROOM_MASTER');
  assert(createdSnapshot.classification_snapshotted_at instanceof Date,
    'classification_snapshotted_at must be server-generated');
  await assertLedgerDelta(Number(sourceType.id), fixtureDate, 1, 'booking source ledger');
  await assertLedgerDelta(Number(targetType.id), fixtureDate, 0, 'booking target ledger');
  markCase(15, 'new canonical booking writes all exact approved snapshot columns');

  assert(Number(createdSnapshot.booked_room_type_id_snapshot) !== spoof.booked_room_type_id_snapshot
    && String(createdSnapshot.booked_room_type_code_snapshot) !== spoof.booked_room_type_code_snapshot
    && Number(createdSnapshot.booked_room_category_id_snapshot) !== spoof.booked_room_category_id_snapshot
    && String(createdSnapshot.booked_room_category_code_snapshot) !== spoof.booked_room_category_code_snapshot
    && String(createdSnapshot.classification_snapshot_source) !== spoof.classification_snapshot_source,
  'client-supplied snapshot values reached fixture persistent state');
  markCase(16, 'client snapshot spoof fields are ignored');

  const move = await request('POST', `/api/reservations/${reservationId}/move`, {
    to_room_id: Number(targetRoom.id)
  }, 'MOVE');
  assert(move.status === 200, `fixture cross-type room move failed: ${move.status} ${move.text}`);
  const movedSnapshot = await readReservationSnapshot(reservationId);
  assert(Number(movedSnapshot.room_id) === Number(targetRoom.id), 'reservation did not move to the fixture target room');
  const snapshotBeforeMove = { ...createdSnapshot };
  const snapshotAfterMove = { ...movedSnapshot };
  delete snapshotBeforeMove.room_id;
  delete snapshotAfterMove.room_id;
  assertDeepEqual(snapshotAfterMove, snapshotBeforeMove, 'cross-type move rewrote immutable booking snapshots');
  await assertLedgerDelta(Number(sourceType.id), fixtureDate, 0, 'moved source ledger');
  await assertLedgerDelta(Number(targetType.id), fixtureDate, 1, 'moved target ledger');
  markCase(17, 'cross-type room move does not rewrite booking snapshots');

  await assertLegacySnapshotNull('after canonical booking and move');
  markCase(18, 'owned legacy reservation remains null-snapshotted');

  await verifyFixtureRoomMappings();
  markCase(13, 'all disposable physical room_type_id mappings remain unchanged');
  await assertFixtureInventoryInvariant();
}

async function cleanupFixtures() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const discoveredReservations = await client.query(`
      SELECT id, booking_id
      FROM reservations
      WHERE correlation_id LIKE $1 OR guest_name LIKE $1
      FOR UPDATE
    `, [`${fixturePrefix}%`]);
    for (const row of discoveredReservations.rows) {
      ownedReservationIds.add(Number(row.id));
      if (row.booking_id !== null) ownedBookingIds.add(Number(row.booking_id));
    }
    const discoveredBookings = await client.query(`
      SELECT id
      FROM bookings
      WHERE correlation_id LIKE $1 OR guest_name_snapshot LIKE $1
      FOR UPDATE
    `, [`${fixturePrefix}%`]);
    for (const row of discoveredBookings.rows) ownedBookingIds.add(Number(row.id));

    const discoveredRooms = await client.query('SELECT id FROM rooms WHERE room_number LIKE $1', [`${fixturePrefix}%`]);
    for (const row of discoveredRooms.rows) createdRoomIds.add(Number(row.id));
    const discoveredTypes = await client.query('SELECT id FROM room_types WHERE code LIKE $1', [`${fixturePrefix}%`]);
    for (const row of discoveredTypes.rows) createdTypeIds.add(Number(row.id));
    const discoveredCategories = await client.query('SELECT id FROM room_categories WHERE code LIKE $1', [`${fixturePrefix}%`]);
    for (const row of discoveredCategories.rows) createdCategoryIds.add(Number(row.id));
    const discoveredLocks = await client.query(`
      SELECT id FROM availability_locks
      WHERE reservation_id = ANY($1::int[]) OR room_type_id = ANY($2::int[])
    `, [ids(ownedReservationIds), ids(createdTypeIds)]);
    for (const row of discoveredLocks.rows) createdLockIds.add(Number(row.id));

    await client.query('DELETE FROM availability_locks WHERE id = ANY($1::int[])', [ids(createdLockIds)]);
    await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [ids(ownedReservationIds)]);
    await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [ids(ownedReservationIds)]);
    await client.query('DELETE FROM guest_receivables WHERE reservation_id = ANY($1::int[])', [ids(ownedReservationIds)]);
    await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [ids(ownedReservationIds)]);
    await client.query('DELETE FROM bookings WHERE id = ANY($1::bigint[])', [ids(ownedBookingIds)]);

    await client.query('DELETE FROM rooms WHERE id = ANY($1::int[]) AND room_number LIKE $2',
      [ids(createdRoomIds), `${fixturePrefix}%`]);
    await client.query('DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[])', [ids(createdTypeIds)]);
    await client.query('DELETE FROM room_types WHERE id = ANY($1::int[]) AND code LIKE $2',
      [ids(createdTypeIds), `${fixturePrefix}%`]);
    await client.query('DELETE FROM room_categories WHERE id = ANY($1::int[]) AND code LIKE $2',
      [ids(createdCategoryIds), `${fixturePrefix}%`]);

    await client.query(`
      DELETE FROM audit_logs
      WHERE correlation_id LIKE $1
         OR audit_id = ANY($2::int[])
         OR (entity = 'RESERVATION' AND record_id = ANY($3::text[]))
         OR (entity = 'BOOKING' AND record_id = ANY($4::text[]))
         OR (module = 'ROOM_MASTER' AND entity = 'ROOM_CATEGORY' AND record_id = ANY($5::text[]))
         OR (module = 'ROOM_MASTER' AND entity = 'ROOM_TYPE' AND record_id = ANY($6::text[]))
         OR (module = 'ROOM_MASTER' AND entity = 'ROOM' AND record_id = ANY($7::text[]))
    `, [
      `${fixturePrefix}%`,
      ids(ownedAuditIds),
      ids(ownedReservationIds).map(String),
      ids(ownedBookingIds).map(String),
      ids(createdCategoryIds).map(String),
      ids(createdTypeIds).map(String),
      ids(createdRoomIds).map(String)
    ]);

    if (secondPropertyId !== null) {
      const deletedProperty = await client.query(`
        DELETE FROM properties
        WHERE id = $1 AND property_code = $2 AND name LIKE $3
      `, [secondPropertyId, secondPropertyCode, `${fixturePrefix}%`]);
      assert(deletedProperty.rowCount === 1, 'owned second property was not deleted exactly once');
    }

    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError) { /* noop */ }
    throw error;
  } finally {
    client.release();
  }
}

async function finalChecks() {
  const residueQueries = [
    ['categories', 'SELECT COUNT(*)::int AS c FROM room_categories WHERE code LIKE $1 OR name LIKE $1', [`${fixturePrefix}%`]],
    ['types', 'SELECT COUNT(*)::int AS c FROM room_types WHERE code LIKE $1 OR name LIKE $1', [`${fixturePrefix}%`]],
    ['rooms', 'SELECT COUNT(*)::int AS c FROM rooms WHERE room_number LIKE $1', [`${fixturePrefix}%`]],
    ['properties', 'SELECT COUNT(*)::int AS c FROM properties WHERE property_code = $1 OR name LIKE $2', [secondPropertyCode, `${fixturePrefix}%`]],
    ['reservations', 'SELECT COUNT(*)::int AS c FROM reservations WHERE correlation_id LIKE $1 OR guest_name LIKE $1', [`${fixturePrefix}%`]],
    ['bookings', 'SELECT COUNT(*)::int AS c FROM bookings WHERE correlation_id LIKE $1 OR guest_name_snapshot LIKE $1', [`${fixturePrefix}%`]],
    ['availability', 'SELECT COUNT(*)::int AS c FROM availability_dates WHERE room_type_id = ANY($1::int[])', [ids(createdTypeIds)]],
    ['locks', 'SELECT COUNT(*)::int AS c FROM availability_locks WHERE id = ANY($1::int[]) OR reservation_id = ANY($2::int[]) OR room_type_id = ANY($3::int[])',
      [ids(createdLockIds), ids(ownedReservationIds), ids(createdTypeIds)]],
    ['folios', 'SELECT COUNT(*)::int AS c FROM folio_entries WHERE reservation_id = ANY($1::int[])', [ids(ownedReservationIds)]],
    ['payments', 'SELECT COUNT(*)::int AS c FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [ids(ownedReservationIds)]],
    ['receivables', 'SELECT COUNT(*)::int AS c FROM guest_receivables WHERE reservation_id = ANY($1::int[])', [ids(ownedReservationIds)]],
    ['audits', `SELECT COUNT(*)::int AS c FROM audit_logs
                WHERE correlation_id LIKE $1 OR audit_id = ANY($2::int[])
                   OR (entity = 'RESERVATION' AND record_id = ANY($3::text[]))
                   OR (entity = 'BOOKING' AND record_id = ANY($4::text[]))
                   OR (module = 'ROOM_MASTER' AND entity = 'ROOM_CATEGORY' AND record_id = ANY($5::text[]))
                   OR (module = 'ROOM_MASTER' AND entity = 'ROOM_TYPE' AND record_id = ANY($6::text[]))
                   OR (module = 'ROOM_MASTER' AND entity = 'ROOM' AND record_id = ANY($7::text[]))`, [
      `${fixturePrefix}%`,
      ids(ownedAuditIds),
      ids(ownedReservationIds).map(String),
      ids(ownedBookingIds).map(String),
      ids(createdCategoryIds).map(String),
      ids(createdTypeIds).map(String),
      ids(createdRoomIds).map(String)
    ]]
  ];
  for (const [label, sql, params] of residueQueries) {
    const result = await pool.query(sql, params);
    assert(Number(result.rows[0].c) === 0, `fixture residue remains in ${label}: ${result.rows[0].c}`);
  }

  assert(passedCases.size === 18, `expected 18 covered cases, marked ${passedCases.size}`);
  console.log(`ALL 18 RM-2C.2 CASES PASS; owned fixtures removed with zero residue (${fixturePrefix}).`);
}

async function main() {
  let primaryError = null;
  try {
    await runCases();
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await cleanupFixtures();
    } catch (cleanupError) {
      primaryError = primaryError
        ? new Error(`${primaryError.message}; cleanup failed: ${cleanupError.message}`)
        : cleanupError;
    }
  }

  try {
    await finalChecks();
  } catch (finalError) {
    primaryError = primaryError
      ? new Error(`${primaryError.message}; final checks failed: ${finalError.message}`)
      : finalError;
  }

  if (primaryError) throw primaryError;
}

main()
  .catch((error) => {
    console.error('RM-2C.2 integration suite failed:', error.message || error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
