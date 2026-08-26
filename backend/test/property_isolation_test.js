'use strict';

require('dotenv').config();
const http = require('http');
const { once } = require('events');
const { app, pool } = require('../dist/index');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function expect(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error('FAIL: ' + msg); }
}

async function api(method, path, body) {
  var url = baseUrl + path;
  var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  var res = await fetch(url, opts);
  var json = await res.json().catch(function() { return null; });
  return { status: res.status, json: json };
}

var tracked = { properties: [], categories: [], types: [], rooms: [] };
async function safe(fn) { try { await fn(); } catch (e) { /* ignore */ } }

async function setupFixtures() {
  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    var propA = await client.query("INSERT INTO properties (name, property_code, timezone, currency, address) VALUES ('Iso Test A', 'ISXA', 'Asia/Jakarta', 'IDR', 'Test Address A') RETURNING id");
    var pidA = propA.rows[0].id;
    tracked.properties.push(pidA);
    var catA = await client.query('INSERT INTO room_categories (property_id, code, name, is_active, display_order) VALUES ($1, \'ICA\', \'Iso Category A\', true, 10) RETURNING id', [pidA]);
    tracked.categories.push(catA.rows[0].id);
    var typeA = await client.query('INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity, is_active, display_order) VALUES ($1, $2, \'ITA\', \'Iso Type A\', 500000, 2, true, 10) RETURNING id', [pidA, catA.rows[0].id]);
    tracked.types.push(typeA.rows[0].id);
    var roomA = await client.query('INSERT INTO rooms (property_id, room_type_id, room_number, name, floor, status, is_active) VALUES ($1, $2, \'101\', \'Iso Room A-101\', 1, \'VACANT_CLEAN\', true) RETURNING id', [pidA, typeA.rows[0].id]);
    tracked.rooms.push(roomA.rows[0].id);

    var propB = await client.query("INSERT INTO properties (name, property_code, timezone, currency, address) VALUES ('Iso Test B', 'ISXB', 'Asia/Jakarta', 'IDR', 'Test Address B') RETURNING id");
    var pidB = propB.rows[0].id;
    tracked.properties.push(pidB);
    var catB = await client.query('INSERT INTO room_categories (property_id, code, name, is_active, display_order) VALUES ($1, \'ICB\', \'Iso Category B\', true, 10) RETURNING id', [pidB]);
    tracked.categories.push(catB.rows[0].id);
    var typeB = await client.query('INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity, is_active, display_order) VALUES ($1, $2, \'ITB\', \'Iso Type B\', 600000, 2, true, 10) RETURNING id', [pidB, catB.rows[0].id]);
    tracked.types.push(typeB.rows[0].id);
    var roomB = await client.query('INSERT INTO rooms (property_id, room_type_id, room_number, name, floor, status, is_active) VALUES ($1, $2, \'101\', \'Iso Room B-101\', 1, \'VACANT_CLEAN\', true) RETURNING id', [pidB, typeB.rows[0].id]);
    tracked.rooms.push(roomB.rows[0].id);

    var today = new Date().toISOString().slice(0, 10);
    var pairs = [[typeA.rows[0].id, 'Iso Type A'], [typeB.rows[0].id, 'Iso Type B']];
    for (var pi = 0; pi < pairs.length; pi++) {
      var tid = pairs[pi][0], tname = pairs[pi][1];
      for (var i = 0; i < 3; i++) {
        var d = new Date(today); d.setDate(d.getDate() + i);
        var ds = d.toISOString().slice(0, 10);
        await client.query('INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty) VALUES ($1, $2, $3, 10, 0) ON CONFLICT (room_type, date) DO NOTHING', [tid, tname, ds]);
      }
    }
    await client.query('COMMIT');
    return { pidA: pidA, pidB: pidB, typeA: typeA.rows[0].id, typeB: typeB.rows[0].id, roomA: roomA.rows[0].id, roomB: roomB.rows[0].id };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function test1_noPropertyId() {
  var today = new Date().toISOString().slice(0, 10);
  var end = new Date(); end.setDate(end.getDate() + 1);
  var endStr = end.toISOString().slice(0, 10);
  var r1 = await api('GET', '/api/availability?room_type_id=1&start=' + today + '&end=' + endStr);
  expect(r1.status === 400, 'T1: availability without property_id returns 400 (got ' + r1.status + ')');
  expect(r1.json && r1.json.code === 'VALIDATION_ERROR', 'T1: error code VALIDATION_ERROR (got ' + (r1.json && r1.json.code) + ')');
  var r2 = await api('GET', '/api/tapechart?start=' + today + '&end=' + endStr);
  expect(r2.status === 400, 'T4: tapechart without property_id returns 400 (got ' + r2.status + ')');
  expect(r2.json && r2.json.code === 'VALIDATION_ERROR', 'T4: error code VALIDATION_ERROR (got ' + (r2.json && r2.json.code) + ')');
}

async function test2_crossPropertyAvailability(pidA, typeB) {
  var today = new Date().toISOString().slice(0, 10);
  var end = new Date(); end.setDate(end.getDate() + 1);
  var endStr = end.toISOString().slice(0, 10);
  var r = await api('GET', '/api/availability?property_id=' + pidA + '&room_type_id=' + typeB + '&start=' + today + '&end=' + endStr);
  expect(r.status === 403, 'T2: availability cross-property returns 403 (got ' + r.status + ')');
  expect(r.json && r.json.code === 'PROPERTY_MISMATCH', 'T2: error code PROPERTY_MISMATCH (got ' + (r.json && r.json.code) + ')');
}

async function test3_scopedAvailability(pidA, typeA) {
  var today = new Date().toISOString().slice(0, 10);
  var end = new Date(); end.setDate(end.getDate() + 3);
  var endStr = end.toISOString().slice(0, 10);
  var r = await api('GET', '/api/availability?property_id=' + pidA + '&room_type_id=' + typeA + '&start=' + today + '&end=' + endStr);
  expect(r.status === 200, 'T3: availability for property A returns 200 (got ' + r.status + ')');
  var data = (r.json && r.json.data) || [];
  expect(data.length > 0, 'T3: returns data rows (got ' + data.length + ')');
  var allMatch = data.every(function(row) { return Number(row.room_type_id) === Number(typeA); });
  expect(allMatch, 'T3: all rows belong to type A');
}

async function test5_scopedTapechart(pidA, typeB) {
  var today = new Date().toISOString().slice(0, 10);
  var end = new Date(); end.setDate(end.getDate() + 3);
  var endStr = end.toISOString().slice(0, 10);
  var r = await api('GET', '/api/tapechart?property_id=' + pidA + '&start=' + today + '&end=' + endStr);
  expect(r.status === 200, 'T5: tapechart A returns 200 (got ' + r.status + ')');
  var rooms = (r.json && r.json.rooms) || [];
  var hasTypeB = rooms.some(function(room) { return Number(room.room_type_id) === Number(typeB); });
  expect(!hasTypeB, 'T5: tapechart A has no type B rooms');
  var hasTypeNameB = rooms.some(function(room) { return room.room_type_name === 'Iso Type B'; });
  expect(!hasTypeNameB, 'T5: tapechart A has no type B name');
  var aRoomIds = new Set(rooms.map(function(room) { return Number(room.id); }));
  for (var ri = 0; ri < rooms.length; ri++) {
    var cells = rooms[ri].cells || [];
    for (var ci = 0; ci < cells.length; ci++) {
      var rvs = cells[ci].reservations || [];
      for (var vi = 0; vi < rvs.length; vi++) {
        expect(aRoomIds.has(Number(rvs[vi].room_id)) || rvs[vi].room_id === rooms[ri].id, 'T5: reservation belongs to A');
      }
    }
  }
}

async function test6_independentRoomNumbers(pidA, pidB, roomA, roomB) {
  var today = new Date().toISOString().slice(0, 10);
  var end = new Date(); end.setDate(end.getDate() + 3);
  var endStr = end.toISOString().slice(0, 10);
  var rA = await api('GET', '/api/tapechart?property_id=' + pidA + '&start=' + today + '&end=' + endStr);
  var roomsA = (rA.json && rA.json.rooms) || [];
  expect(roomsA.some(function(r) { return Number(r.id) === Number(roomA); }), 'T6: tapechart A includes room A');
  expect(!roomsA.some(function(r) { return Number(r.id) === Number(roomB); }), 'T6: tapechart A excludes room B');
  var rB = await api('GET', '/api/tapechart?property_id=' + pidB + '&start=' + today + '&end=' + endStr);
  var roomsB = (rB.json && rB.json.rooms) || [];
  expect(roomsB.some(function(r) { return Number(r.id) === Number(roomB); }), 'T6: tapechart B includes room B');
  expect(!roomsB.some(function(r) { return Number(r.id) === Number(roomA); }), 'T6: tapechart B excludes room A');
}

async function test7_noHardcodedProperty1() {
  var fs = require('fs');
  var path = require('path');
  var appPath = path.resolve(__dirname, '../../frontend/src/App.tsx');
  var content = fs.readFileSync(appPath, 'utf8');
  expect(content.indexOf('useState<number>(1)') === -1, 'T7: no useState<number>(1) in App.tsx');
  expect(content.indexOf('OAK LAWANG') === -1, 'T7: no OAK LAWANG literal in App.tsx');
  var lines = content.split('\n');
  var hardcoded = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf('property') !== -1 && (line.indexOf('?? 1') !== -1 || line.indexOf('|| 1') !== -1) && line.indexOf('//') === -1) {
      hardcoded = true;
      console.log('  T7 hardcode at line ' + (i+1) + ': ' + line.trim());
    }
  }
  expect(!hardcoded, 'T7: no hardcoded property fallback');
}

async function test8_propertySelectionBehavior() {
  var r = await api('GET', '/api/properties');
  expect(r.status === 200, 'T8: /api/properties returns 200');
  var props = (r.json && r.json.data) || [];
  expect(props.length >= 1, 'T8: at least 1 property exists (got ' + props.length + ')');
  // Verify each property has required fields
  for (var i = 0; i < props.length; i++) {
    expect(props[i].id !== undefined, 'T8: property has id');
    expect(props[i].name !== undefined, 'T8: property has name');
    expect(props[i].property_code !== undefined, 'T8: property has property_code');
  }
  // Verify OAK Lawang is present
  var codes = props.map(function(p) { return p.property_code; });
  expect(codes.indexOf('LWG') !== -1, 'T8: LWG (OAK Lawang) exists');
}

async function cleanup() {
  var client = await pool.connect();
  var cleanupErrors = [];
  try {
    await client.query('BEGIN');
    for (var i = 0; i < tracked.types.length; i++) {
      await safe(function() { return client.query('DELETE FROM availability_dates WHERE room_type_id = $1', [tracked.types[i]]); });
      await safe(function() { return client.query('DELETE FROM availability_locks WHERE room_type_id = $1', [tracked.types[i]]); });
    }
    for (var i = 0; i < tracked.rooms.length; i++) {
      await safe(function() { return client.query('DELETE FROM rooms WHERE id = $1', [tracked.rooms[i]]); });
    }
    for (var i = 0; i < tracked.types.length; i++) {
      await safe(function() { return client.query('DELETE FROM room_types WHERE id = $1', [tracked.types[i]]); });
    }
    for (var i = 0; i < tracked.categories.length; i++) {
      await safe(function() { return client.query('DELETE FROM room_categories WHERE id = $1', [tracked.categories[i]]); });
    }
    for (var i = 0; i < tracked.properties.length; i++) {
      await safe(function() { return client.query('DELETE FROM properties WHERE id = $1', [tracked.properties[i]]); });
    }
    await client.query('COMMIT');

    // Verify residue
    for (var i = 0; i < tracked.properties.length; i++) {
      var r = await pool.query('SELECT COUNT(*)::int AS c FROM properties WHERE id = $1', [tracked.properties[i]]);
      if (r.rows[0].c > 0) cleanupErrors.push('Property ' + tracked.properties[i] + ' still exists');
    }
    for (var i = 0; i < tracked.categories.length; i++) {
      var r = await pool.query('SELECT COUNT(*)::int AS c FROM room_categories WHERE id = $1', [tracked.categories[i]]);
      if (r.rows[0].c > 0) cleanupErrors.push('Category ' + tracked.categories[i] + ' still exists');
    }
    for (var i = 0; i < tracked.types.length; i++) {
      var r = await pool.query('SELECT COUNT(*)::int AS c FROM room_types WHERE id = $1', [tracked.types[i]]);
      if (r.rows[0].c > 0) cleanupErrors.push('Type ' + tracked.types[i] + ' still exists');
    }
    for (var i = 0; i < tracked.rooms.length; i++) {
      var r = await pool.query('SELECT COUNT(*)::int AS c FROM rooms WHERE id = $1', [tracked.rooms[i]]);
      if (r.rows[0].c > 0) cleanupErrors.push('Room ' + tracked.rooms[i] + ' still exists');
    }
    if (cleanupErrors.length > 0) {
      console.error('CLEANUP RESIDUE:', cleanupErrors.join('; '));
      failed += cleanupErrors.length;
    }
  } catch (e) { await client.query('ROLLBACK'); console.error('CLEANUP FAILED:', e.message); failed++; } finally { client.release(); }
}

async function main() {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  try {
    var fixtures = await setupFixtures();
    console.log('Fixtures: propA=' + fixtures.pidA + ', propB=' + fixtures.pidB);
    await test1_noPropertyId();
    await test2_crossPropertyAvailability(fixtures.pidA, fixtures.typeB);
    await test3_scopedAvailability(fixtures.pidA, fixtures.typeA);
    await test5_scopedTapechart(fixtures.pidA, fixtures.typeB);
    await test6_independentRoomNumbers(fixtures.pidA, fixtures.pidB, fixtures.roomA, fixtures.roomB);
    await test7_noHardcodedProperty1();
    await test8_propertySelectionBehavior();
    console.log('\n--- property_isolation_test: ' + passed + ' passed, ' + failed + ' failed ---');
  } catch (e) { console.error('TEST ERROR:', e); } finally { await cleanup(); server.close(); await pool.end(); if (failed > 0) process.exit(1); }
}

main();
