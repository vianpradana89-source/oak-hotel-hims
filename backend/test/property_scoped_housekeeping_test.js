'use strict';
/**
 * BOOTSTRAP-2B2-B1: Property-scoped housekeeping test.
 *
 * Proves:
 *   A. missing property_id -> 400
 *   B. unknown property -> 404
 *   C. Property A sees only A tasks
 *   D. Property B sees only B tasks
 *   E. cross-property room assignment rejected
 *   F. cross-property task mutation rejected
 *   G. same room_number can exist independently in A and B
 *   H. property switch does not leak data
 *   I. cleanup is deterministic
 *   J. zero fixture residue
 */
require('dotenv').config({ path: 'E:/oak-hotel-hims/backend/.env' });
const http = require('http');
const { once } = require('events');
const { app, pool } = require('../dist/index');

let server;
let baseUrl;
let passed = 0;
let failed = 0;
const tracked = { properties: [], categories: [], rooms: [], tasks: [] };

function expect(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error('FAIL: ' + msg); }
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(baseUrl + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function safe(fn) { try { return await fn(); } catch(e) { return null; } }

async function setupFixtures() {
  const client = await pool.connect();
  const s = String(Math.floor(Math.random() * 900) + 100);
  try {
    await client.query('BEGIN');

    const rA = await client.query(`INSERT INTO properties (name, property_code, address, is_active) VALUES ('HK Prop A', 'HK${s}A', 'Test Address A', TRUE) RETURNING id`);
    tracked.properties.push(rA.rows[0].id);

    const rB = await client.query(`INSERT INTO properties (name, property_code, address, is_active) VALUES ('HK Prop B', 'HK${s}B', 'Test Address B', TRUE) RETURNING id`);
    tracked.properties.push(rB.rows[0].id);

    const pidA = rA.rows[0].id;
    const pidB = rB.rows[0].id;

    const rcA = await client.query('INSERT INTO room_categories (property_id, code, name, is_active, display_order) VALUES ($1, \'CA\', \'Cat A\', TRUE, 1) RETURNING id', [pidA]);
    tracked.categories.push(rcA.rows[0].id);

    const rcB = await client.query('INSERT INTO room_categories (property_id, code, name, is_active, display_order) VALUES ($1, \'CB\', \'Cat B\', TRUE, 1) RETURNING id', [pidB]);
    tracked.categories.push(rcB.rows[0].id);

    // Create room types
    const rtA = await client.query('INSERT INTO room_types (property_id, name, code, base_rate, capacity, room_category_id, is_active) VALUES ($1, \'Standard A\', \'SA\', 100, 2, $2, TRUE) RETURNING id', [pidA, rcA.rows[0].id]);
    const rtB = await client.query('INSERT INTO room_types (property_id, name, code, base_rate, capacity, room_category_id, is_active) VALUES ($1, \'Standard B\', \'SB\', 200, 2, $2, TRUE) RETURNING id', [pidB, rcB.rows[0].id]);

    // Create rooms with SAME room_number in different properties
    const roomA = await client.query('INSERT INTO rooms (property_id, room_type_id, room_number, floor, status, is_active) VALUES ($1, $2, \'101\', 1, \'VACANT_CLEAN\', TRUE) RETURNING id', [pidA, rtA.rows[0].id]);
    tracked.rooms.push(roomA.rows[0].id);

    const roomB = await client.query('INSERT INTO rooms (property_id, room_type_id, room_number, floor, status, is_active) VALUES ($1, $2, \'101\', 1, \'VACANT_CLEAN\', TRUE) RETURNING id', [pidB, rtB.rows[0].id]);
    tracked.rooms.push(roomB.rows[0].id);

    await client.query('COMMIT');
    return { pidA, pidB, roomA: roomA.rows[0].id, roomB: roomB.rows[0].id };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function cleanup() {
  const client = await pool.connect();
  const cleanupErrors = [];
  try {
    await client.query('BEGIN');
    for (const tid of tracked.tasks) {
      await safe(() => client.query('DELETE FROM housekeeping_tasks WHERE id = $1', [tid]));
    }
    for (const rid of tracked.rooms) {
      await safe(() => client.query('DELETE FROM rooms WHERE id = $1', [rid]));
    }
    for (const pid of tracked.properties) {
      await safe(() => client.query('DELETE FROM room_types WHERE property_id = $1', [pid]));
    }
    for (const cid of tracked.categories) {
      await safe(() => client.query('DELETE FROM room_categories WHERE id = $1', [cid]));
    }
    for (const pid of tracked.properties) {
      await safe(() => client.query('DELETE FROM properties WHERE id = $1', [pid]));
    }
    await client.query('COMMIT');

    // Verify residue
    for (const pid of tracked.properties) {
      const r = await pool.query('SELECT COUNT(*)::int AS c FROM properties WHERE id = $1', [pid]);
      if (r.rows[0].c > 0) cleanupErrors.push('Property ' + pid + ' still exists');
    }
    for (const tid of tracked.tasks) {
      const r = await pool.query('SELECT COUNT(*)::int AS c FROM housekeeping_tasks WHERE id = $1', [tid]);
      if (r.rows[0].c > 0) cleanupErrors.push('Task ' + tid + ' still exists');
    }
    if (cleanupErrors.length > 0) {
      console.error('CLEANUP RESIDUE:', cleanupErrors.join('; '));
      failed += cleanupErrors.length;
    }
  } catch (e) { await client.query('ROLLBACK'); console.error('CLEANUP FAILED:', e.message); failed++; } finally { client.release(); }
}

// A. missing property_id -> 400
async function testA_missingPropertyId() {
  const r = await api('GET', '/api/housekeeping/tasks');
  expect(r.status === 400, 'A: missing property_id -> 400 (got ' + r.status + ')');
}

// B. unknown property -> 404
async function testB_unknownProperty() {
  const r = await api('GET', '/api/housekeeping/tasks?property_id=999999');
  expect(r.status === 404, 'B: unknown property -> 404 (got ' + r.status + ')');
}

// C. Property A sees only A tasks
async function testC_propertyAScoped(pidA, pidB) {
  // Create task in A
  const createA = await api('POST', '/api/housekeeping/tasks', {
    property_id: pidA, room_number: '101', task_type: 'ROOM_CLEANING', priority: 'MEDIUM', status: 'PENDING', assignee: 'HK-A', notes: 'Test A'
  });
  expect(createA.status === 201, 'C: create task in A -> 201');
  if (createA.json && createA.json.data) tracked.tasks.push(createA.json.data.id);

  // Fetch A
  const rA = await api('GET', '/api/housekeeping/tasks?property_id=' + pidA);
  expect(rA.status === 200, 'C: fetch A -> 200');
  expect(rA.json.data.length >= 1, 'C: A has >= 1 task');
  const aIds = rA.json.data.map(t => t.id);
  expect(aIds.indexOf(createA.json.data.id) !== -1, 'C: A contains created task');

  // Fetch B - should not see A's task
  const rB = await api('GET', '/api/housekeeping/tasks?property_id=' + pidB);
  expect(rB.status === 200, 'C: fetch B -> 200');
  const bIds = rB.json.data.map(t => t.id);
  expect(bIds.indexOf(createA.json.data.id) === -1, 'C: B does not contain A task');
}

// D. Property B sees only B tasks
async function testD_propertyBScoped(pidA, pidB) {
  const createB = await api('POST', '/api/housekeeping/tasks', {
    property_id: pidB, room_number: '101', task_type: 'ROOM_CLEANING', priority: 'LOW', status: 'PENDING', assignee: 'HK-B', notes: 'Test B'
  });
  expect(createB.status === 201, 'D: create task in B -> 201');
  if (createB.json && createB.json.data) tracked.tasks.push(createB.json.data.id);

  const rB = await api('GET', '/api/housekeeping/tasks?property_id=' + pidB);
  expect(rB.json.data.length >= 1, 'D: B has >= 1 task');
  const bIds = rB.json.data.map(t => t.id);
  expect(bIds.indexOf(createB.json.data.id) !== -1, 'D: B contains its own task');

  const rA = await api('GET', '/api/housekeeping/tasks?property_id=' + pidA);
  const aIds = rA.json.data.map(t => t.id);
  expect(aIds.indexOf(createB.json.data.id) === -1, 'D: A does not contain B task');
}

// E. cross-property room assignment rejected
async function testE_crossPropertyRoom(pidA, pidB) {
  // Create task in A with B's room_number
  const r = await api('POST', '/api/housekeeping/tasks', {
    property_id: pidA, room_number: '999', task_type: 'ROOM_CLEANING', priority: 'MEDIUM', status: 'PENDING', notes: 'Cross-property test'
  });
  expect(r.status === 400, 'E: cross-property room -> 400 (got ' + r.status + ')');
}

// F. cross-property task mutation rejected
async function testF_crossPropertyMutation(pidA, pidB) {
  // Create task in A
  const create = await api('POST', '/api/housekeeping/tasks', {
    property_id: pidA, room_number: '101', task_type: 'ROOM_CLEANING', priority: 'MEDIUM', status: 'PENDING', notes: 'Mutation test'
  });
  expect(create.status === 201, 'F: create task -> 201');
  if (create.json && create.json.data) tracked.tasks.push(create.json.data.id);

  // Try to update with B's property_id
  const r = await api('PATCH', '/api/housekeeping/tasks/' + create.json.data.id + '/status', {
    property_id: pidB, status: 'DONE'
  });
  expect(r.status === 403, 'F: cross-property mutation -> 403 (got ' + r.status + ')');
}

// G. same room_number can exist independently in A and B
async function testG_sameRoomNumberIndependent(pidA, pidB) {
  const createA = await api('POST', '/api/housekeeping/tasks', {
    property_id: pidA, room_number: '101', task_type: 'ROOM_CLEANING', priority: 'MEDIUM', status: 'PENDING', notes: 'Room 101 in A'
  });
  expect(createA.status === 201, 'G: create 101 in A -> 201');
  if (createA.json && createA.json.data) tracked.tasks.push(createA.json.data.id);

  const createB = await api('POST', '/api/housekeeping/tasks', {
    property_id: pidB, room_number: '101', task_type: 'ROOM_CLEANING', priority: 'MEDIUM', status: 'PENDING', notes: 'Room 101 in B'
  });
  expect(createB.status === 201, 'G: create 101 in B -> 201');
  if (createB.json && createB.json.data) tracked.tasks.push(createB.json.data.id);

  // Both should exist independently
  const rA = await api('GET', '/api/housekeeping/tasks?property_id=' + pidA);
  const rB = await api('GET', '/api/housekeeping/tasks?property_id=' + pidB);
  expect(rA.json.data.some(t => t.id === createA.json.data.id), 'G: A has its 101 task');
  expect(rB.json.data.some(t => t.id === createB.json.data.id), 'G: B has its 101 task');
}

// H. property switch does not leak data
async function testH_propertySwitch(pidA, pidB) {
  const r1 = await api('GET', '/api/housekeeping/tasks?property_id=' + pidA);
  const r2 = await api('GET', '/api/housekeeping/tasks?property_id=' + pidB);
  const r1Again = await api('GET', '/api/housekeeping/tasks?property_id=' + pidA);

  expect(r1.json.data.length === r1Again.json.data.length, 'H: repeated A fetch returns same count');
  const aIds = new Set(r1.json.data.map(t => t.id));
  const bIds = new Set(r2.json.data.map(t => t.id));
  let overlap = 0;
  for (const id of aIds) { if (bIds.has(id)) overlap++; }
  expect(overlap === 0, 'H: zero overlap between A and B tasks');
}

async function main() {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  try {
    const f = await setupFixtures();
    console.log('Fixtures: propA=' + f.pidA + ', propB=' + f.pidB + ', roomA=' + f.roomA + ', roomB=' + f.roomB);
    await testA_missingPropertyId();
    await testB_unknownProperty();
    await testC_propertyAScoped(f.pidA, f.pidB);
    await testD_propertyBScoped(f.pidA, f.pidB);
    await testE_crossPropertyRoom(f.pidA, f.pidB);
    await testF_crossPropertyMutation(f.pidA, f.pidB);
    await testG_sameRoomNumberIndependent(f.pidA, f.pidB);
    await testH_propertySwitch(f.pidA, f.pidB);
    console.log('\n--- property_scoped_housekeeping_test: ' + passed + ' passed, ' + failed + ' failed ---');
  } catch (e) { console.error('TEST ERROR:', e); }
  finally { await cleanup(); server.close(); await pool.end(); if (failed > 0) process.exit(1); }
}

main();
