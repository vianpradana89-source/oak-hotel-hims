#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');

const p = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log('PASS | ' + label);
  } else {
    failed += 1;
    console.log('FAIL | ' + label);
  }
}

let server;
let baseUrl;

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

let propAId, propBId;
let catAId, catBId;
let typeAId, typeBId;
let roomA1Id, roomB1Id;
const cleanupErrors = [];

async function cleanup(client) {
  const safe = async (label, sql, params) => {
    try { await client.query(sql, params); }
    catch (e) { cleanupErrors.push(`${label}: ${e.message}`); console.error(`  CLEANUP WARN: ${label}: ${e.message}`); }
  };
  if (roomA1Id) await safe('delete room A', 'DELETE FROM rooms WHERE id = $1', [roomA1Id]);
  if (roomB1Id) await safe('delete room B', 'DELETE FROM rooms WHERE id = $1', [roomB1Id]);
  if (typeAId) {
    await safe('delete locks A', 'DELETE FROM availability_locks WHERE room_type_id = $1', [typeAId]);
    await safe('delete avail A', 'DELETE FROM availability_dates WHERE room_type_id = $1', [typeAId]);
    await safe('delete type A', 'DELETE FROM room_types WHERE id = $1', [typeAId]);
  }
  if (typeBId) {
    await safe('delete locks B', 'DELETE FROM availability_locks WHERE room_type_id = $1', [typeBId]);
    await safe('delete avail B', 'DELETE FROM availability_dates WHERE room_type_id = $1', [typeBId]);
    await safe('delete type B', 'DELETE FROM room_types WHERE id = $1', [typeBId]);
  }
  if (catAId) await safe('delete cat A', 'DELETE FROM room_categories WHERE id = $1', [catAId]);
  if (catBId) await safe('delete cat B', 'DELETE FROM room_categories WHERE id = $1', [catBId]);
  if (propAId) await safe('delete prop A', 'DELETE FROM properties WHERE id = $1', [propAId]);
  if (propBId) await safe('delete prop B', 'DELETE FROM properties WHERE id = $1', [propBId]);
}

async function verifyResidue(client) {
  const ids = [
    roomA1Id && { tbl: 'rooms', id: roomA1Id },
    roomB1Id && { tbl: 'rooms', id: roomB1Id },
    typeAId && { tbl: 'room_types', id: typeAId },
    typeBId && { tbl: 'room_types', id: typeBId },
    catAId && { tbl: 'room_categories', id: catAId },
    catBId && { tbl: 'room_categories', id: catBId },
    propAId && { tbl: 'properties', id: propAId },
    propBId && { tbl: 'properties', id: propBId },
  ].filter(Boolean);
  const residue = [];
  for (const { tbl, id } of ids) {
    const r = await client.query(`SELECT 1 FROM ${tbl} WHERE id = $1`, [id]);
    if (r.rowCount > 0) residue.push(`${tbl}#${id}`);
  }
  return residue;
}

async function main() {
  const { initializeDatabase } = require('../dist/db/schema_v3');
  const { app, pool } = require('../dist/index');

  await initializeDatabase(pool);

  // Ensure is_active column exists on properties (added in BOOTSTRAP-1B)
  await p.query("ALTER TABLE properties ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE");

  // Clean up any residue from prior runs
  await p.query("DELETE FROM availability_locks WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id IN (SELECT id FROM properties WHERE property_code IN ('RMXA','RMXB')))");
  await p.query("DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id IN (SELECT id FROM properties WHERE property_code IN ('RMXA','RMXB')))");
  await p.query("DELETE FROM reservations WHERE room_id IN (SELECT id FROM rooms WHERE property_id IN (SELECT id FROM properties WHERE property_code IN ('RMXA','RMXB')))");
  await p.query("DELETE FROM rooms WHERE property_id IN (SELECT id FROM properties WHERE property_code IN ('RMXA','RMXB'))");
  await p.query("DELETE FROM room_types WHERE property_id IN (SELECT id FROM properties WHERE property_code IN ('RMXA','RMXB'))");
  await p.query("DELETE FROM room_categories WHERE property_id IN (SELECT id FROM properties WHERE property_code IN ('RMXA','RMXB'))");
  await p.query("DELETE FROM properties WHERE property_code IN ('RMXA','RMXB')");

  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(`Disposable server on port ${address.port}`);

  const client = await p.connect();
  try {
    // ---- SETUP: Create disposable properties A and B ----
    const propA = await client.query(
      `INSERT INTO properties (name, property_code, address, is_active) VALUES ('Test Property A', 'RMXA', 'Test Address A', TRUE) RETURNING id`
    );
    propAId = Number(propA.rows[0].id);

    const propB = await client.query(
      `INSERT INTO properties (name, property_code, address, is_active) VALUES ('Test Property B', 'RMXB', 'Test Address B', TRUE) RETURNING id`
    );
    propBId = Number(propB.rows[0].id);

    // Create categories for each property
    const catA = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active, display_order)
       VALUES ($1, 'STDA', 'Standard Category A', TRUE, 10) RETURNING id`,
      [propAId]
    );
    catAId = Number(catA.rows[0].id);

    const catB = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active, display_order)
       VALUES ($1, 'STDB', 'Standard Category B', TRUE, 10) RETURNING id`,
      [propBId]
    );
    catBId = Number(catB.rows[0].id);

    // Create room types for each property
    const typeA = await client.query(
      `INSERT INTO room_types (property_id, code, name, room_category_id, capacity, max_adults, max_children, is_active, display_order, base_rate)
       VALUES ($1, 'DKA', 'Deluxe King A', $2, 2, 2, 0, TRUE, 10, 500000) RETURNING id`,
      [propAId, catAId]
    );
    typeAId = Number(typeA.rows[0].id);

    const typeB = await client.query(
      `INSERT INTO room_types (property_id, code, name, room_category_id, capacity, max_adults, max_children, is_active, display_order, base_rate)
       VALUES ($1, 'DKB', 'Deluxe King B', $2, 2, 2, 0, TRUE, 10, 500000) RETURNING id`,
      [propBId, catBId]
    );
    typeBId = Number(typeB.rows[0].id);

    // Create physical rooms for each property (both can have Room 101)
    const roomA = await client.query(
      `INSERT INTO rooms (property_id, room_number, room_type_id, is_active)
       VALUES ($1, '101', $2, TRUE) RETURNING id`,
      [propAId, typeAId]
    );
    roomA1Id = Number(roomA.rows[0].id);

    const roomB = await client.query(
      `INSERT INTO rooms (property_id, room_number, room_type_id, is_active)
       VALUES ($1, '101', $2, TRUE) RETURNING id`,
      [propBId, typeBId]
    );
    roomB1Id = Number(roomB.rows[0].id);

    // ---- A. Both properties can have Room 101 ----
    assert(roomA1Id !== roomB1Id, 'A: Property A and B can both have Room 101 (different physical room IDs)');

    // ---- B. GET categories A never returns B ----
    const catsARes = await api('GET', `/api/room-categories?property_id=${propAId}`);
    assert(catsARes.status === 200, `B1: GET categories for A returns 200 (got ${catsARes.status})`);
    const catIdsA = catsARes.json.data.map(c => c.id);
    assert(catIdsA.includes(catAId), 'B2: Categories for A includes category A');
    assert(!catIdsA.includes(catBId), 'B3: Categories for A does NOT include category B');

    const catsBRes = await api('GET', `/api/room-categories?property_id=${propBId}`);
    assert(catsBRes.status === 200, `B4: GET categories for B returns 200`);
    const catIdsB = catsBRes.json.data.map(c => c.id);
    assert(catIdsB.includes(catBId), 'B5: Categories for B includes category B');
    assert(!catIdsB.includes(catAId), 'B6: Categories for B does NOT include category A');

    // ---- C. GET room types A never returns B ----
    const typesARes = await api('GET', `/api/room-types?property_id=${propAId}`);
    assert(typesARes.status === 200, `C1: GET room types for A returns 200`);
    const typeIdsA = typesARes.json.data.map(t => t.id);
    assert(typeIdsA.includes(typeAId), 'C2: Room types for A includes type A');
    assert(!typeIdsA.includes(typeBId), 'C3: Room types for A does NOT include type B');

    const typesBRes = await api('GET', `/api/room-types?property_id=${propBId}`);
    assert(typesBRes.status === 200, `C4: GET room types for B returns 200`);
    const typeIdsB = typesBRes.json.data.map(t => t.id);
    assert(typeIdsB.includes(typeBId), 'C5: Room types for B includes type B');
    assert(!typeIdsB.includes(typeAId), 'C6: Room types for B does NOT include type A');

    // ---- D. GET rooms A never returns B ----
    const roomsARes = await api('GET', `/api/rooms?property_id=${propAId}`);
    assert(roomsARes.status === 200, `D1: GET rooms for A returns 200`);
    const roomIdsA = roomsARes.json.data.map(r => r.id);
    assert(roomIdsA.includes(roomA1Id), 'D2: Rooms for A includes room A');
    assert(!roomIdsA.includes(roomB1Id), 'D3: Rooms for A does NOT include room B');

    const roomsBRes = await api('GET', `/api/rooms?property_id=${propBId}`);
    assert(roomsBRes.status === 200, `D4: GET rooms for B returns 200`);
    const roomIdsB = roomsBRes.json.data.map(r => r.id);
    assert(roomIdsB.includes(roomB1Id), 'D5: Rooms for B includes room B');
    assert(!roomIdsB.includes(roomA1Id), 'D6: Rooms for B does NOT include room A');

    // ---- E. Creating category without property_id is rejected ----
    const noPropCat = await api('POST', '/api/room-categories', { code: 'NOPE', name: 'No Property' });
    assert(noPropCat.status === 400, `E: Creating category without property_id returns 400 (got ${noPropCat.status})`);

    // ---- F. Creating room type without property_id is rejected ----
    const noPropType = await api('POST', '/api/room-types', { code: 'NOPE', name: 'No Property', capacity: 2 });
    assert(noPropType.status === 400, `F: Creating room type without property_id returns 400 (got ${noPropType.status})`);

    // ---- G. Cross-property category -> room_type is rejected ----
    const crossPropType = await api('POST', '/api/room-types', {
      property_id: propAId,
      code: 'XPROP',
      name: 'Cross Property Type',
      room_category_id: catBId,
      capacity: 2
    });
    assert(crossPropType.status === 409, `G: Cross-property category -> room_type is rejected (got ${crossPropType.status})`);

    // ---- H. Room type from B cannot be used to create room in A ----
    const crossPropRoom = await api('POST', '/api/rooms', {
      property_id: propAId,
      room_number: '999',
      room_type_id: typeBId
    });
    assert(crossPropRoom.status === 403, `H: Room type from B cannot create room in A (got ${crossPropRoom.status})`);

    // ---- I. GET room by ID with wrong property is rejected ----
    const wrongPropRoom = await api('GET', `/api/rooms/${roomA1Id}?property_id=${propBId}`);
    assert(wrongPropRoom.status === 403, `I: GET room A with property B context is rejected (got ${wrongPropRoom.status})`);

    // ---- J. PATCH room with wrong property is rejected ----
    const patchWrongProp = await api('PATCH', `/api/rooms/${roomA1Id}`, {
      property_id: propBId,
      notes: 'should fail'
    });
    assert(patchWrongProp.status === 403, `J: PATCH room A with property B context is rejected (got ${patchWrongProp.status})`);

    // ---- K. GET room types without property_id is rejected ----
    const noPropTypes = await api('GET', '/api/room-types');
    assert(noPropTypes.status === 400, `K: GET room types without property_id returns 400 (got ${noPropTypes.status})`);

    // ---- L. GET rooms without property_id is rejected ----
    const noPropRooms = await api('GET', '/api/rooms');
    assert(noPropRooms.status === 400, `L: GET rooms without property_id returns 400 (got ${noPropRooms.status})`);

    // ---- M. GET categories without property_id is rejected ----
    const noPropCats = await api('GET', '/api/room-categories');
    assert(noPropCats.status === 400, `M: GET categories without property_id returns 400 (got ${noPropCats.status})`);

    // ---- N. Verify rejected probes did not create residue ----
    const residueCheck = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM room_types WHERE code = 'XPROP'`
    );
    assert(Number(residueCheck.rows[0].cnt) === 0, 'N1: No residue room type from cross-property probe');
    const residueCheck2 = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM rooms WHERE room_number = '999'`
    );
    assert(Number(residueCheck2.rows[0].cnt) === 0, 'N2: No residue room from cross-property probe');

    console.log(`\n--- property_scoped_room_master_test: ${passed} passed, ${failed} failed ---`);
  } catch (err) {
    console.error('FATAL:', err.message);
  } finally {
    await cleanup(client);
    if (cleanupErrors.length > 0) {
      console.error(`\n  CLEANUP ERRORS (${cleanupErrors.length}):`);
      for (const e of cleanupErrors) console.error(`    ${e}`);
    }
    const residue = await verifyResidue(client);
    if (residue.length > 0) {
      console.error(`\n  FIXTURE RESIDUE DETECTED: ${residue.join(', ')}`);
      failed += 1;
    }
    client.release();
    if (server) server.close();
    await p.end();
    if (failed > 0 || residue.length > 0 || cleanupErrors.length > 0) process.exit(1);
  }
}

main();
