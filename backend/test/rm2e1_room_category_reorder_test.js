'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { once } = require('events');
const { app, pool } = require('../dist/index');

const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
const prefix = `E1${token.slice(-8)}`;
const propertyCode = `E${token.slice(-5)}`;
let server;
let propertyId = null;
let primaryCategoryId = null;
let auditFloor = 0;
const fixtureCategoryIds = [];
let assertions = 0;

function expect(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
  assertions += 1;
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

async function request(method, requestPath, body) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${requestPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_error) { /* reported by caller */ }
  return { status: response.status, json, text };
}

async function tableFingerprint(table) {
  const result = await pool.query(
    `SELECT md5(COALESCE(jsonb_agg(to_jsonb(snapshot) ORDER BY snapshot.id)::text, '[]')) AS fingerprint
     FROM (SELECT * FROM ${table}) snapshot`
  );
  return result.rows[0].fingerprint;
}

async function readCategories(targetPropertyId) {
  const result = await pool.query(
    `SELECT id, property_id, code, name, description, is_active, display_order
     FROM room_categories
     WHERE property_id = $1
     ORDER BY display_order, id`,
    [targetPropertyId]
  );
  return result.rows.map((row) => ({
    ...row,
    id: Number(row.id),
    property_id: Number(row.property_id),
    display_order: Number(row.display_order)
  }));
}

async function createDisposableProperty() {
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
  const targetColumns = names.map(quoteIdentifier).join(', ');
  const sourceValues = names.map((name) => {
    if (name === 'property_code') return '$2';
    if (name === 'name') return '$3';
    return `source.${quoteIdentifier(name)}`;
  }).join(', ');
  const result = await pool.query(
    `INSERT INTO properties (${targetColumns})
     SELECT ${sourceValues}
     FROM properties source
     WHERE source.id = $1
     RETURNING id`,
    [1, propertyCode, `${prefix} Disposable Property`]
  );
  expect(result.rowCount === 1, 'disposable property was not created');
  propertyId = Number(result.rows[0].id);
}

async function createDisposableCategories() {
  const initialOrders = [11, 22, 33, 44];
  for (let index = 0; index < 4; index += 1) {
    const result = await pool.query(
      `INSERT INTO room_categories
         (property_id, code, name, description, is_active, display_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        propertyId,
        `${prefix}${index}`,
        `${prefix} Category ${index}`,
        `${prefix} metadata ${index}`,
        index !== 2,
        initialOrders[index]
      ]
    );
    fixtureCategoryIds.push(Number(result.rows[0].id));
  }
}

async function verifyCalendarOrderingContract() {
  const primaryCategoriesResponse = await request('GET', '/api/room-categories?property_id=1');
  expect(primaryCategoriesResponse.status === 200, 'primary category refetch failed');
  const expected = primaryCategoriesResponse.json.data
    .filter((category) => Number(category.physical_room_count) > 0)
    .map((category) => Number(category.id));

  const tapechartResponse = await request('GET', '/api/tapechart?start=2026-09-01&end=2026-09-08&include_inactive=1');
  expect(tapechartResponse.status === 200, 'tapechart ordering read failed');
  const categories = new Map();
  for (const room of tapechartResponse.json.rooms) {
    const id = Number(room.room_category_id);
    if (!categories.has(id)) {
      categories.set(id, Number(room.room_category_display_order));
    }
  }
  const actual = Array.from(categories.entries())
    .sort((left, right) => left[1] - right[1] || left[0] - right[0])
    .map(([id]) => id);
  expect(JSON.stringify(actual) === JSON.stringify(expected),
    `Calendar category order differs from backend order: expected=${expected}, actual=${actual}`);
}

async function verifyCreateDefaultsToEnd() {
  const before = await request('GET', '/api/room-categories?property_id=1');
  expect(before.status === 200, 'category baseline read failed');
  const maxOrder = Math.max(...before.json.data.map((category) => Number(category.display_order)), 0);
  const expectedOrder = Math.floor(maxOrder / 10) * 10 + 10;
  const created = await request('POST', '/api/room-categories', {
    code: `${prefix}N`,
    name: `${prefix} New Category`,
    description: `${prefix} append test`
  });
  expect(created.status === 201, `append category create failed: ${created.status} ${created.text}`);
  primaryCategoryId = Number(created.json.data.id);
  expect(Number(created.json.data.display_order) === expectedOrder,
    `new category order=${created.json.data.display_order}, expected=${expectedOrder}`);

  const refetched = await request('GET', '/api/room-categories?property_id=1');
  expect(Number(refetched.json.data.at(-1).id) === primaryCategoryId, 'new category was not appended at the end');
}

async function runCases() {
  const auditFloorResult = await pool.query('SELECT COALESCE(MAX(audit_id), 0)::int AS audit_floor FROM audit_logs');
  auditFloor = Number(auditFloorResult.rows[0].audit_floor);
  const protectedFingerprints = {
    roomTypes: await tableFingerprint('room_types'),
    rooms: await tableFingerprint('rooms'),
    availability: await tableFingerprint('availability_dates')
  };

  await createDisposableProperty();
  await createDisposableCategories();
  const before = await readCategories(propertyId);
  const metadataBefore = before.map(({ display_order, ...category }) => category);
  const requestedIds = [fixtureCategoryIds[2], fixtureCategoryIds[0], fixtureCategoryIds[3], fixtureCategoryIds[1]];

  const reordered = await request('PATCH', '/api/room-categories/reorder', {
    property_id: propertyId,
    category_ids: requestedIds
  });
  expect(reordered.status === 200, `reorder failed: ${reordered.status} ${reordered.text}`);
  expect(JSON.stringify(reordered.json.data.map((category) => Number(category.id))) === JSON.stringify(requestedIds),
    'reorder response did not preserve requested canonical ID order');
  expect(JSON.stringify(reordered.json.data.map((category) => Number(category.display_order))) === JSON.stringify([10, 20, 30, 40]),
    'reorder response was not normalized to 10-step display orders');

  const persisted = await readCategories(propertyId);
  expect(JSON.stringify(persisted.map((category) => category.id)) === JSON.stringify(requestedIds),
    'reordered IDs did not persist after refetch');
  expect(JSON.stringify(persisted.map((category) => category.display_order)) === JSON.stringify([10, 20, 30, 40]),
    'normalized display orders did not persist after refetch');
  const metadataAfter = persisted.map(({ display_order, ...category }) => category).sort((a, b) => a.id - b.id);
  expect(JSON.stringify(metadataAfter) === JSON.stringify(metadataBefore.sort((a, b) => a.id - b.id)),
    'category metadata or active state changed during reorder');

  const auditResult = await pool.query(
    `SELECT record_id, new_value
     FROM audit_logs
     WHERE module = 'ROOM_MASTER'
       AND action = 'REORDER'
       AND entity = 'ROOM_CATEGORY'
       AND record_id = ANY($1::text[])
     ORDER BY record_id::int`,
    [fixtureCategoryIds.map(String)]
  );
  expect(auditResult.rows.length === 4, 'reorder did not audit every changed category');
  for (const audit of auditResult.rows) {
    const categoryId = Number(audit.record_id);
    const expectedAfter = (requestedIds.indexOf(categoryId) + 1) * 10;
    const auditValue = typeof audit.new_value === 'string' ? JSON.parse(audit.new_value) : audit.new_value;
    expect(Number(auditValue.property_id) === propertyId, `audit ${categoryId} has wrong property identity`);
    expect(Number(auditValue.before.display_order) === before.find((category) => category.id === categoryId).display_order,
      `audit ${categoryId} has wrong previous display order`);
    expect(Number(auditValue.after.display_order) === expectedAfter,
      `audit ${categoryId} has wrong final display order`);
  }

  const confirmedState = JSON.stringify(await readCategories(propertyId));
  const confirmedAuditCount = auditResult.rows.length;
  const invalidCases = [
    ['duplicate', 400, { property_id: propertyId, category_ids: [requestedIds[0], requestedIds[0], requestedIds[2], requestedIds[3]] }],
    ['unknown', 409, { property_id: propertyId, category_ids: [requestedIds[0], requestedIds[1], requestedIds[2], 999999] }],
    ['incomplete', 409, { property_id: propertyId, category_ids: requestedIds.slice(0, 3) }],
    ['empty', 400, { property_id: propertyId, category_ids: [] }],
    ['invalid-id', 400, { property_id: propertyId, category_ids: [requestedIds[0], 'bad', requestedIds[2], requestedIds[3]] }]
  ];
  for (const [label, expectedStatus, payload] of invalidCases) {
    const response = await request('PATCH', '/api/room-categories/reorder', payload);
    expect(response.status === expectedStatus, `${label} payload returned ${response.status}, expected ${expectedStatus}`);
    expect(JSON.stringify(await readCategories(propertyId)) === confirmedState, `${label} failure changed persisted order`);
  }
  const auditAfterFailures = await pool.query(
    `SELECT COUNT(*)::int AS count FROM audit_logs
     WHERE module = 'ROOM_MASTER' AND action = 'REORDER' AND entity = 'ROOM_CATEGORY'
       AND record_id = ANY($1::text[])`,
    [fixtureCategoryIds.map(String)]
  );
  expect(Number(auditAfterFailures.rows[0].count) === confirmedAuditCount,
    'failed reorder left audit or transaction residue');

  expect(await tableFingerprint('room_types') === protectedFingerprints.roomTypes, 'Room Types changed during category reorder');
  expect(await tableFingerprint('rooms') === protectedFingerprints.rooms, 'Physical Rooms changed during category reorder');
  expect(await tableFingerprint('availability_dates') === protectedFingerprints.availability, 'inventory changed during category reorder');

  await verifyCalendarOrderingContract();
  await verifyCreateDefaultsToEnd();
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = [...fixtureCategoryIds, primaryCategoryId].filter((id) => Number.isInteger(id));
    await client.query(
      `DELETE FROM audit_logs
       WHERE audit_id > $1
         AND module = 'ROOM_MASTER'
         AND entity = 'ROOM_CATEGORY'
         AND record_id = ANY($2::text[])`,
      [auditFloor, ids.length ? ids.map(String) : ['0']]
    );
    if (primaryCategoryId !== null) {
      await client.query('DELETE FROM room_categories WHERE id = $1 AND code = $2', [primaryCategoryId, `${prefix}N`]);
    }
    if (fixtureCategoryIds.length > 0) {
      await client.query('DELETE FROM room_categories WHERE id = ANY($1::int[]) AND code LIKE $2', [fixtureCategoryIds, `${prefix}%`]);
    }
    if (propertyId !== null) {
      await client.query('DELETE FROM properties WHERE id = $1 AND property_code = $2', [propertyId, propertyCode]);
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
  const residue = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM room_categories WHERE code LIKE $1 OR name LIKE $1)::int AS categories,
       (SELECT COUNT(*) FROM properties WHERE property_code = $2 OR name LIKE $1)::int AS properties,
       (SELECT COUNT(*) FROM audit_logs WHERE audit_id > $3
          AND module = 'ROOM_MASTER' AND entity = 'ROOM_CATEGORY'
          AND record_id = ANY($4::text[]))::int AS audits`,
    [`${prefix}%`, propertyCode, auditFloor, [...fixtureCategoryIds, primaryCategoryId].filter(Number.isInteger).map(String)]
  );
  expect(Number(residue.rows[0].categories) === 0, `category residue=${residue.rows[0].categories}`);
  expect(Number(residue.rows[0].properties) === 0, `property residue=${residue.rows[0].properties}`);
  expect(Number(residue.rows[0].audits) === 0, `audit residue=${residue.rows[0].audits}`);

  const invariants = await pool.query(`
    WITH active_nights AS (
      SELECT rm.room_type_id, night.day::date AS date, COUNT(*)::int AS expected_qty
      FROM reservations r
      JOIN rooms rm ON rm.id = r.room_id
      CROSS JOIN LATERAL generate_series(r.check_in::date, r.check_out::date - 1, INTERVAL '1 day') AS night(day)
      WHERE r.status IN ('BOOKED', 'CHECKED_IN')
        AND rm.room_type_id IS NOT NULL
        AND r.check_out > r.check_in
      GROUP BY rm.room_type_id, night.day
    )
    SELECT
      COUNT(*) FILTER (WHERE ad.id IS NULL OR ad.reserved_qty IS DISTINCT FROM COALESCE(an.expected_qty, 0))::int AS drift,
      COUNT(*) FILTER (WHERE ad.id IS NULL AND an.expected_qty > 0)::int AS missing,
      COUNT(*) FILTER (WHERE ad.reserved_qty < 0)::int AS negative,
      COUNT(*) FILTER (WHERE ad.reserved_qty > ad.total_rooms)::int AS over_capacity
    FROM availability_dates ad
    FULL OUTER JOIN active_nights an ON an.room_type_id = ad.room_type_id AND an.date = ad.date
  `);
  expect(Number(invariants.rows[0].drift) === 0, `inventory drift=${invariants.rows[0].drift}`);
  expect(Number(invariants.rows[0].missing) === 0, `missing inventory rows=${invariants.rows[0].missing}`);
  expect(Number(invariants.rows[0].negative) === 0, `negative inventory=${invariants.rows[0].negative}`);
  expect(Number(invariants.rows[0].over_capacity) === 0, `over-capacity inventory=${invariants.rows[0].over_capacity}`);
  console.log(`RM-2E.1 assertions=${assertions}`);
  console.log(`inventory drift=${invariants.rows[0].drift} missing=${invariants.rows[0].missing} negative=${invariants.rows[0].negative} over_capacity=${invariants.rows[0].over_capacity}`);
  console.log('fixture residue=0');
}

async function main() {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let failure = null;
  try {
    await runCases();
  } catch (error) {
    failure = error;
  } finally {
    try { await cleanup(); } catch (cleanupError) { failure = failure || cleanupError; }
  }
  try { await finalChecks(); } catch (finalError) { failure = failure || finalError; }
  if (failure) throw failure;
}

main()
  .catch((error) => {
    console.error('RM-2E.1 category reorder test failed:', error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
  });
