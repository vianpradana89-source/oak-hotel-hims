'use strict';

// RM-1D correction test: Room Type CODE edit safety.
// Disposable fixtures only (prefix RM1D-), zero contact with hotel master data.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:5000';
const fetchFn = global.fetch || require('node-fetch');
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
      'X-Correlation-Id': `RM1DCODE-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_e) { json = null; }
  return { status: resp.status, json };
}

async function main() {
  // A. Create disposable types
  const a = await request('POST', '/api/room-types', { code: 'RM1D-A', name: 'RM1D Fixture A', capacity: 2 });
  expect(a.status === 201 && a.json.data.code === 'RM1D-A', 'fixture A created (RM1D-A)');
  const b = await request('POST', '/api/room-types', { code: 'RM1D-B', name: 'RM1D Fixture B', capacity: 2 });
  expect(b.status === 201 && b.json.data.code === 'RM1D-B', 'fixture B created (RM1D-B)');
  const typeAId = Number(a.json.data.id);
  const typeBId = Number(b.json.data.id);
  const originalCodeA = String(a.json.data.code);

  // B. Rename code DLXK-style scenario: RM1D-A -> RM1D-Z
  const rename = await request('PATCH', `/api/room-types/${typeAId}`, { code: 'RM1D-Z' });
  expect(rename.status === 200 && rename.json.data.code === 'RM1D-Z', 'code rename RM1D-A -> RM1D-Z succeeds');
  expect(Number(rename.json.data.id) === typeAId, 'room_types.id unchanged after rename (canonical identity preserved)');

  const refetch = await request('GET', `/api/room-types/${typeAId}`);
  expect(refetch.status === 200 && refetch.json.data.code === 'RM1D-Z', 'GET after rename returns new code under same id');

  // C. Physical room binding survives code change via room_type_id
  const room = await request('POST', '/api/rooms', { room_number: 'RM1D-901', room_type_id: typeAId });
  expect(room.status === 201 && Number(room.json.data.room_type_id) === typeAId, 'disposable room bound to type id');
  const roomId = Number(room.json.data.id);

  const rename2 = await request('PATCH', `/api/room-types/${typeAId}`, { code: 'RM1D-Y' });
  expect(rename2.status === 200 && rename2.json.data.code === 'RM1D-Y', 'second rename RM1D-Z -> RM1D-Y succeeds');
  const relist = await request('GET', `/api/rooms?room_type_id=${typeAId}`);
  const bound = (relist.json.data || []).find((r) => Number(r.id) === roomId);
  expect(Boolean(bound), 'room still related through same room_type_id after code rename');
  expect(bound.room_type_code === 'RM1D-Y', 'room view exposes new canonical code label');

  // D. Duplicate rejection between disposable rows
  const dup = await request('PATCH', `/api/room-types/${typeAId}`, { code: 'RM1D-B' });
  expect(dup.status === 409, `duplicate code rejected with HTTP 409 (got ${dup.status})`);
  expect(dup.json && dup.json.code === 'ROOM_TYPE_CODE_EXISTS', 'backend conflict code surfaced (ROOM_TYPE_CODE_EXISTS)');
  const afterDup = await request('GET', `/api/room-types/${typeAId}`);
  expect(afterDup.json.data.code === 'RM1D-Y', 'code unchanged after duplicate rejection');

  // E. Format validation on UPDATE
  const bad = await request('PATCH', `/api/room-types/${typeAId}`, { code: 'BAD CODE!' });
  expect(bad.status === 400, `invalid format rejected with HTTP 400 (got ${bad.status})`);

  // F. Cleanup — guarded deletes scoped to disposable ids + RM1D- prefixes
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "DELETE FROM rooms WHERE id = ANY($1::int[]) AND room_number LIKE 'RM1D-%'",
      [[roomId]]
    );
    await client.query(
      'DELETE FROM availability_dates WHERE room_type_id = ANY($1::int[])',
      [[typeAId, typeBId]]
    );
    await client.query(
      "DELETE FROM room_types WHERE id = ANY($1::int[]) AND code LIKE 'RM1D-%'",
      [[typeAId, typeBId]]
    );
    await client.query("DELETE FROM audit_logs WHERE entity IN ('ROOM_TYPE','ROOM') AND record_id = ANY($1::text[])", [
      [String(typeAId), String(typeBId), String(roomId)]
    ]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // G. Residue verification
  const checks = [
    ['room_types', "code LIKE 'RM1D-%'", []],
    ['rooms', "room_number LIKE 'RM1D-%'", []],
    ['availability_dates', 'room_type_id = ANY($1::int[])', [[typeAId, typeBId]]],
    ['audit_logs', "entity IN ('ROOM_TYPE','ROOM') AND record_id = ANY($1::text[])", [[String(typeAId), String(typeBId), String(roomId)]]]
  ];
  for (const [table, predicate, params] of checks) {
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${predicate}`, params);
    expect(r.rows[0].c === 0, `zero residue in ${table}`);
  }
  const drift = await pool.query(`
    SELECT COUNT(*)::int AS c
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
       OR ad.reserved_qty < 0
       OR ad.reserved_qty > ad.total_rooms`);
  expect(drift.rows[0].c === 0, 'inventory drift/negative/over-capacity all zero');

  console.log(`\nALL ${passed} CHECKS PASS — RM-1D code editing safe, fixtures removed.`);
}

main()
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
