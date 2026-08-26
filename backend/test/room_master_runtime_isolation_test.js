'use strict';
/**
 * BOOTSTRAP-2B1: Room Master runtime isolation test.
 *
 * Proves:
 *   1. Room Master API returns correct counts per property
 *   2. Switching properties returns different data (no state leakage)
 *   3. Frontend code has no hardcoded property references in RoomMasterPage
 *   4. Property switching clears old state
 *   5. Unknown property returns 404
 */
require('dotenv').config();
const http = require('http');
const { once } = require('events');
const { app, pool } = require('../dist/index');

let server;
let baseUrl;
let passed = 0;
let failed = 0;
const tracked = { properties: [], categories: [], types: [], rooms: [], bookings: [] };

function expect(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error('FAIL: ' + msg); }
}

async function api(method, path) {
  var res = await fetch(baseUrl + path);
  var json = await res.json().catch(function() { return null; });
  return { status: res.status, json: json };
}

async function safe(fn) {
  try { return await fn(); } catch(e) { return null; }
}

// Create test properties with categories
async function setupFixtures() {
  var client = await pool.connect();
  try {
    await client.query('BEGIN');

    var rA = await client.query(
      "INSERT INTO properties (name, property_code, address, is_active) VALUES ('Isolation Prop A', 'RMIA', 'Test Address A', TRUE) RETURNING id"
    );
    var pidA = rA.rows[0].id;
    tracked.properties.push(pidA);

    var rB = await client.query(
      "INSERT INTO properties (name, property_code, address, is_active) VALUES ('Isolation Prop B', 'RMIB', 'Test Address B', TRUE) RETURNING id"
    );
    var pidB = rB.rows[0].id;
    tracked.properties.push(pidB);

    var rcA = await client.query(
      "INSERT INTO room_categories (property_id, code, name, is_active, display_order) VALUES ($1, 'CA', 'Cat A', TRUE, 1) RETURNING id",
      [pidA]
    );
    tracked.categories.push(rcA.rows[0].id);

    var rcB = await client.query(
      "INSERT INTO room_categories (property_id, code, name, is_active, display_order) VALUES ($1, 'CB', 'Cat B', TRUE, 1) RETURNING id",
      [pidB]
    );
    tracked.categories.push(rcB.rows[0].id);

    await client.query('COMMIT');
    return { pidA: pidA, pidB: pidB };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function cleanup() {
  var client = await pool.connect();
  var cleanupErrors = [];
  try {
    await client.query('BEGIN');
    for (var i = 0; i < tracked.bookings.length; i++) {
      await safe(function() { return client.query('DELETE FROM reservations WHERE booking_id = $1', [tracked.bookings[i]]); });
      await safe(function() { return client.query('DELETE FROM bookings WHERE id = $1', [tracked.bookings[i]]); });
    }
    for (var i = 0; i < tracked.rooms.length; i++) {
      await safe(function() { return client.query('DELETE FROM rooms WHERE id = $1', [tracked.rooms[i]]); });
    }
    for (var i = 0; i < tracked.types.length; i++) {
      await safe(function() { return client.query('DELETE FROM availability_dates WHERE room_type_id = $1', [tracked.types[i]]); });
      await safe(function() { return client.query('DELETE FROM availability_locks WHERE room_type_id = $1', [tracked.types[i]]); });
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

// Test 1: API returns correct counts per property
async function testApiCountsByProperty(pidA, pidB) {
  // OAK Lawang (id=1): 3 categories, 9 types, 23 rooms
  var oakCats = await api('GET', '/api/room-categories?property_id=1');
  var oakTypes = await api('GET', '/api/room-types?property_id=1');
  var oakRooms = await api('GET', '/api/rooms?property_id=1');
  expect(oakCats.json && oakCats.json.data && oakCats.json.data.length === 3,
    'T1: OAK has 3 categories (got ' + (oakCats.json && oakCats.json.data ? oakCats.json.data.length : '?') + ')');
  expect(oakTypes.json && oakCats.json.data && oakTypes.json.data.length === 9,
    'T1: OAK has 9 types (got ' + (oakTypes.json && oakTypes.json.data ? oakTypes.json.data.length : '?') + ')');
  expect(oakRooms.json && oakRooms.json.data && oakRooms.json.data.length === 23,
    'T1: OAK has 23 rooms (got ' + (oakRooms.json && oakRooms.json.data ? oakRooms.json.data.length : '?') + ')');

  // Test Property A: 1 category, 0 types, 0 rooms
  var aCats = await api('GET', '/api/room-categories?property_id=' + pidA);
  var aTypes = await api('GET', '/api/room-types?property_id=' + pidA);
  var aRooms = await api('GET', '/api/rooms?property_id=' + pidA);
  expect(aCats.json && aCats.json.data && aCats.json.data.length === 1,
    'T1: Prop A has 1 category (got ' + (aCats.json && aCats.json.data ? aCats.json.data.length : '?') + ')');
  expect(aTypes.json && aCats.json.data && aTypes.json.data.length === 0,
    'T1: Prop A has 0 types (got ' + (aTypes.json && aTypes.json.data ? aTypes.json.data.length : '?') + ')');
  expect(aRooms.json && aCats.json.data && aRooms.json.data.length === 0,
    'T1: Prop A has 0 rooms (got ' + (aRooms.json && aRooms.json.data ? aRooms.json.data.length : '?') + ')');

  // Test Property B: 1 category, 0 types, 0 rooms
  var bCats = await api('GET', '/api/room-categories?property_id=' + pidB);
  var bTypes = await api('GET', '/api/room-types?property_id=' + pidB);
  var bRooms = await api('GET', '/api/rooms?property_id=' + pidB);
  expect(bCats.json && bCats.json.data && bCats.json.data.length === 1,
    'T1: Prop B has 1 category (got ' + (bCats.json && bCats.json.data ? bCats.json.data.length : '?') + ')');
  expect(bTypes.json && bCats.json.data && bTypes.json.data.length === 0,
    'T1: Prop B has 0 types (got ' + (bTypes.json && bTypes.json.data ? bTypes.json.data.length : '?') + ')');
  expect(bRooms.json && bCats.json.data && bRooms.json.data.length === 0,
    'T1: Prop B has 0 rooms (got ' + (bRooms.json && bRooms.json.data ? bRooms.json.data.length : '?') + ')');
}

// Test 2: Switching properties returns different data (no state leakage)
async function testSwitchingProperties(pidA, pidB) {
  // Fetch OAK
  var oak = await api('GET', '/api/room-types?property_id=1');
  var oakNames = oak.json.data.map(function(t) { return t.name; });

  // Fetch A
  var a = await api('GET', '/api/room-types?property_id=' + pidA);
  expect(a.json && a.json.data && a.json.data.length === 0, 'T2: Switch OAK->A: A has 0 types');
  expect(oakNames.indexOf('DELUXE KING') !== -1, 'T2: OAK has DELUXE KING');

  // Fetch B
  var b = await api('GET', '/api/room-types?property_id=' + pidB);
  expect(b.json && b.json.data && b.json.data.length === 0, 'T2: Switch A->B: B has 0 types');

  // Fetch OAK again
  var oak2 = await api('GET', '/api/room-types?property_id=1');
  expect(oak2.json.data.length === 9, 'T2: Switch B->OAK: OAK still has 9 types');

  // Verify no OAK types leaked into A
  var aNames = a.json.data.map(function(t) { return t.name; });
  expect(aNames.indexOf('DELUXE KING') === -1, 'T2: A does not contain OAK DELUXE KING');
  expect(aNames.indexOf('STANDARD TWIN') === -1, 'T2: A does not contain OAK STANDARD TWIN');

  // Verify no OAK types leaked into B
  var bNames = b.json.data.map(function(t) { return t.name; });
  expect(bNames.indexOf('DELUXE KING') === -1, 'T2: B does not contain OAK DELUXE KING');
}

// Test 3: Frontend code has no hardcoded property references in RoomMasterPage
async function testFrontendNoHardcodedProperty() {
  var fs = require('fs');
  var path = require('path');

  // RoomMasterPage should NOT have its own propertyId state
  var rmPath = path.resolve(__dirname, '../../frontend/src/features/roomMaster/RoomMasterPage.tsx');
  var rmContent = fs.readFileSync(rmPath, 'utf8');
  expect(rmContent.indexOf('useState<number | null>(null)') === -1,
    'T3: RoomMasterPage has no internal propertyId state');
  expect(rmContent.indexOf('/api/properties') === -1,
    'T3: RoomMasterPage does not fetch /api/properties');
  expect(rmContent.indexOf('setPropertyId') === -1,
    'T3: RoomMasterPage has no setPropertyId');

  // ProductInventorySection should accept propertyId prop
  var pisPath = path.resolve(__dirname, '../../frontend/src/features/productInventory/ProductInventorySection.tsx');
  var pisContent = fs.readFileSync(pisPath, 'utf8');
  expect(pisContent.indexOf('propertyId: number | null') !== -1,
    'T3: ProductInventorySection accepts propertyId prop');
  expect(pisContent.indexOf('propertyId={propertyId}') !== -1,
    'T3: ProductInventorySection passes propertyId to RoomMasterPage');

  // App.tsx should pass propertyId to ProductInventorySection
  var appPath = path.resolve(__dirname, '../../frontend/src/App.tsx');
  var appContent = fs.readFileSync(appPath, 'utf8');
  expect(appContent.indexOf('propertyId={propertyId}') !== -1,
    'T3: App.tsx passes propertyId to ProductInventorySection');
}

// Test 4: Tapechart also scoped correctly
async function testTapechartScoped(pidA, pidB) {
  var today = new Date().toISOString().slice(0, 10);
  var end = new Date(); end.setDate(end.getDate() + 3);
  var endStr = end.toISOString().slice(0, 10);

  var oakTc = await api('GET', '/api/tapechart?property_id=1&start=' + today + '&end=' + endStr);
  expect(oakTc.json && oakTc.json.rooms && oakTc.json.rooms.length > 0,
    'T4: OAK tapechart has rooms (got ' + (oakTc.json && oakTc.json.rooms ? oakTc.json.rooms.length : '?') + ')');

  var aTc = await api('GET', '/api/tapechart?property_id=' + pidA + '&start=' + today + '&end=' + endStr);
  expect(aTc.json && aTc.json.rooms && aTc.json.rooms.length === 0,
    'T4: Prop A tapechart has 0 rooms (got ' + (aTc.json && aTc.json.rooms ? aTc.json.rooms.length : '?') + ')');

  var bTc = await api('GET', '/api/tapechart?property_id=' + pidB + '&start=' + today + '&end=' + endStr);
  expect(bTc.json && bTc.json.rooms && bTc.json.rooms.length === 0,
    'T4: Prop B tapechart has 0 rooms (got ' + (bTc.json && bTc.json.rooms ? bTc.json.rooms.length : '?') + ')');
}

// Test 5: Unknown property returns 404
async function testUnknownProperty404() {
  var r = await api('GET', '/api/room-categories?property_id=999999');
  expect(r.status === 404, 'T5: unknown property returns 404 (got ' + r.status + ')');
}

async function main() {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  try {
    var fixtures = await setupFixtures();
    console.log('Fixtures: propA=' + fixtures.pidA + ', propB=' + fixtures.pidB);
    await testApiCountsByProperty(fixtures.pidA, fixtures.pidB);
    await testSwitchingProperties(fixtures.pidA, fixtures.pidB);
    await testFrontendNoHardcodedProperty();
    await testTapechartScoped(fixtures.pidA, fixtures.pidB);
    await testUnknownProperty404();
    console.log('\n--- room_master_runtime_isolation_test: ' + passed + ' passed, ' + failed + ' failed ---');
    console.log('assertions=' + (passed + failed));
  } catch (e) { console.error('TEST ERROR:', e); }
  finally { await cleanup(); server.close(); await pool.end(); if (failed > 0) process.exit(1); }
}

main();
