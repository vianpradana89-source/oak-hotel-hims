/**
 * EMP-MOBILE-3G: Canonical Housekeeping Checklist Content Cleanup Regression Test
 *
 * Verifies:
 * 1. Standard Room Cleaning Master has exactly 4 canonical groups and 31 active items.
 * 2. Group 1 (KAMAR MANDI): 8 items (all required).
 * 3. Group 2 (RUANGAN KAMAR): 13 items (all required).
 * 4. Group 3 (AMENITIES): 7 items (3 required, 4 optional).
 * 5. Group 4 (MINIBAR / KULKAS): 3 items (3 optional).
 * 6. Semantic duplicate removal & proper soft-archiving of legacy items.
 * 7. Group corrections (e.g. Tempat Sampah, AC, TV in Ruangan Kamar; Air Panas in Kamar Mandi).
 * 8. Creation of new task snapshots matches canonical 31 items without legacy pollution.
 * 9. Historical snapshots remain strictly immutable.
 * 10. Clean lifecycle, zero residue.
 */

const assert = require('assert');
const http = require('http');
const { Pool } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'oak_hotel_db',
});

const PORT = 5098;
const baseUrl = `http://localhost:${PORT}`;

function httpRequest(method, urlPath, data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch {
          parsed = body;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });

    req.on('error', reject);
    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

const httpGet = (url) => httpRequest('GET', url);
const httpPost = (url, data) => httpRequest('POST', url, data);

const express = require('express');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { createHousekeepingRouter } = require('../dist/domains/housekeeping/housekeepingRouter');

async function runTests() {
  console.log('====================================================');
  console.log('Running EMP-MOBILE-3G Canonical Content Test Suite');
  console.log('====================================================\n');

  let server;
  const client = await pool.connect();

  let testPropertyId = 1;
  let testRoomId = null;
  let createdTaskId = null;
  let historicalTaskId = null;

  try {
    await initializeDatabase(pool);

    const app = express();
    app.use(express.json());
    app.use('/api/housekeeping', createHousekeepingRouter(pool));

    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // Setup isolated test room
    const roomRes = await client.query(`
      INSERT INTO rooms (property_id, room_number, room_type_id, status, created_at, updated_at)
      VALUES ($1, 'TEST-3G-99', 1, 'DIRTY', NOW(), NOW())
      RETURNING id
    `, [testPropertyId]);
    testRoomId = roomRes.rows[0].id;

    // Test 1: Standard Room Cleaning template contains 4 groups and 31 canonical items via API
    console.log('Test 1: Settings API returns 4 groups and 31 canonical items for Standard Room Cleaning');
    const tplsRes = await httpGet(`${baseUrl}/api/housekeeping/templates?property_id=${testPropertyId}`);
    assert.strictEqual(tplsRes.status, 200, 'GET /templates should return 200');
    const stdTpl = tplsRes.body.data.find((t) => t.code === 'STANDARD_ROOM_CLEANING');
    assert.ok(stdTpl, 'STANDARD_ROOM_CLEANING template must exist');
    assert.strictEqual(stdTpl.groups.length, 4, 'Must have exactly 4 groups');

    const expectedGroups = [
      { name: 'KAMAR MANDI', sort: 10, itemCount: 8 },
      { name: 'RUANGAN KAMAR', sort: 20, itemCount: 13 },
      { name: 'AMENITIES', sort: 30, itemCount: 7 },
      { name: 'MINIBAR / KULKAS', sort: 40, itemCount: 3 }
    ];

    for (let i = 0; i < expectedGroups.length; i++) {
      const exp = expectedGroups[i];
      const actualGroup = stdTpl.groups[i];
      assert.strictEqual(actualGroup.name, exp.name, `Group ${i + 1} name must be ${exp.name}`);
      assert.strictEqual(actualGroup.items.length, exp.itemCount, `Group ${exp.name} must have ${exp.itemCount} items`);
    }

    const totalActiveItems = stdTpl.groups.reduce((sum, g) => sum + g.items.length, 0);
    assert.strictEqual(totalActiveItems, 31, 'Total active canonical items must be exactly 31');
    console.log('  ✓ PASSED: Template groups and item counts verified (31 items across 4 groups)\n');

    // Test 2: Verify specific group item lists and required/optional flags
    console.log('Test 2: Detailed verification of canonical item labels and required flags');
    const g1 = stdTpl.groups[0]; // KAMAR MANDI
    const g1Labels = g1.items.map(i => i.label);
    const expectedG1Labels = [
      'Sabun', 'Sampo', 'Handuk', 'Toilet', 'Shower', 'Wastafel', 'Air Panas', 'Kebersihan Lantai Kamar Mandi'
    ];
    assert.deepStrictEqual(g1Labels, expectedG1Labels, 'KAMAR MANDI items mismatch');
    assert.ok(g1.items.every(i => i.is_required === true), 'All KAMAR MANDI items must be required');

    const g2 = stdTpl.groups[1]; // RUANGAN KAMAR
    const g2Labels = g2.items.map(i => i.label);
    const expectedG2Labels = [
      'Kebersihan Lantai', 'Kasur / Bed', 'Sprei', 'Bantal', 'Selimut', 'Furniture',
      'Lampu', 'AC', 'TV', 'Remote TV', 'Remote AC', 'Tirai / Ventilasi', 'Tempat Sampah'
    ];
    assert.deepStrictEqual(g2Labels, expectedG2Labels, 'RUANGAN KAMAR items mismatch');
    assert.ok(g2.items.every(i => i.is_required === true), 'All RUANGAN KAMAR items must be required');

    const g3 = stdTpl.groups[2]; // AMENITIES
    const g3Labels = g3.items.map(i => i.label);
    const expectedG3Labels = [
      'Teh', 'Kopi', 'Gula', 'Air Mineral', 'Tissue', 'Perlengkapan Mandi', 'Hanger'
    ];
    assert.deepStrictEqual(g3Labels, expectedG3Labels, 'AMENITIES items mismatch');
    // Required: Air Mineral, Tissue, Perlengkapan Mandi. Optional: Teh, Kopi, Gula, Hanger
    const g3ReqMap = Object.fromEntries(g3.items.map(i => [i.label, i.is_required]));
    assert.strictEqual(g3ReqMap['Air Mineral'], true, 'Air Mineral must be required');
    assert.strictEqual(g3ReqMap['Tissue'], true, 'Tissue must be required');
    assert.strictEqual(g3ReqMap['Perlengkapan Mandi'], true, 'Perlengkapan Mandi must be required');
    assert.strictEqual(g3ReqMap['Teh'], false, 'Teh must be optional');
    assert.strictEqual(g3ReqMap['Kopi'], false, 'Kopi must be optional');
    assert.strictEqual(g3ReqMap['Gula'], false, 'Gula must be optional');
    assert.strictEqual(g3ReqMap['Hanger'], false, 'Hanger must be optional');

    const g4 = stdTpl.groups[3]; // MINIBAR / KULKAS
    const g4Labels = g4.items.map(i => i.label);
    const expectedG4Labels = ['Coca-Cola', 'Sprite', 'UHT'];
    assert.deepStrictEqual(g4Labels, expectedG4Labels, 'MINIBAR / KULKAS items mismatch');
    assert.ok(g4.items.every(i => i.is_required === false), 'All MINIBAR / KULKAS items must be optional');
    console.log('  ✓ PASSED: All canonical item labels and required/optional flags verified\n');

    // Test 3: Verify semantic duplicates and legacy items are archived in DB
    console.log('Test 3: Legacy items and duplicate labels are archived (is_archived = TRUE, is_active = FALSE)');
    const archivedRes = await client.query(`
      SELECT label, is_active, is_archived
      FROM checklist_template_items
      WHERE template_id = $1 AND (is_archived = TRUE OR is_active = FALSE)
      ORDER BY id ASC
    `, [stdTpl.id]);
    assert.ok(archivedRes.rows.length > 0, 'Archived legacy items should exist');
    const archivedLabels = archivedRes.rows.map(r => r.label);
    const knownLegacy = [
      'Bed dibuat rapi', 'Lantai dibersihkan', 'Amenities dilengkapi',
      'Coffee / tea replenished', 'Isi Minibar / Kulkas'
    ];
    for (const leg of knownLegacy) {
      assert.ok(
        archivedLabels.includes(leg),
        `Legacy item "${leg}" should be archived in DB`
      );
    }
    console.log('  ✓ PASSED: Legacy duplicates are safely soft-archived\n');

    // Test 4: Historical task snapshots remain immutable and untouched
    console.log('Test 4: Historical task snapshots remain unchanged');
    // Create a mock historical task with legacy items directly
    const histTaskRes = await client.query(`
      INSERT INTO housekeeping_tasks (property_id, room_id, task_type, status, priority, created_at, updated_at)
      VALUES ($1, $2, 'ROOM_CLEANING', 'COMPLETED', 'NORMAL', NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days')
      RETURNING id
    `, [testPropertyId, testRoomId]);
    historicalTaskId = histTaskRes.rows[0].id;

    // Add legacy snapshot items
    await client.query(`
      INSERT INTO housekeeping_task_checklist_items (task_id, section, label, sort_order, is_required, is_completed)
      VALUES
        ($1, 'LEGACY_BEDROOM', 'Bed dibuat rapi', 1, true, true),
        ($1, 'LEGACY_BATHROOM', 'Amenities dilengkapi', 2, true, true)
    `, [historicalTaskId]);

    // Re-run initializeDatabase to test idempotency and ensure it never mutates historical snapshots
    await initializeDatabase(pool);

    const histSnapRes = await client.query(`
      SELECT label, section, is_completed
      FROM housekeeping_task_checklist_items
      WHERE task_id = $1
      ORDER BY sort_order ASC
    `, [historicalTaskId]);
    assert.strictEqual(histSnapRes.rows.length, 2, 'Historical snapshot must retain exact 2 items');
    assert.strictEqual(histSnapRes.rows[0].label, 'Bed dibuat rapi');
    assert.strictEqual(histSnapRes.rows[0].section, 'LEGACY_BEDROOM');
    assert.strictEqual(histSnapRes.rows[1].label, 'Amenities dilengkapi');
    console.log('  ✓ PASSED: Historical task snapshots are strictly immutable\n');

    // Test 5: New Task Creation snapshots exactly 31 items with group context
    console.log('Test 5: Create a new room cleaning task and verify canonical snapshot');
    // Ensure room is in a cleanable state
    await client.query(`
      UPDATE rooms SET status = 'DIRTY' WHERE id = $1
    `, [testRoomId]);

    const taskCreateRes = await httpPost(`${baseUrl}/api/housekeeping/tasks`, {
      property_id: testPropertyId,
      room_id: testRoomId,
      task_type: 'ROOM_CLEANING',
      priority: 'NORMAL'
    });
    assert.strictEqual(taskCreateRes.status, 201, 'POST /tasks should return 201');
    createdTaskId = taskCreateRes.body.data.id;

    // Fetch created task details
    const taskDetailsRes = await httpGet(`${baseUrl}/api/housekeeping/tasks/${createdTaskId}`);
    assert.strictEqual(taskDetailsRes.status, 200, 'GET /tasks/:id should return 200');
    const checklistItems = taskDetailsRes.body.data.checklist_items;
    assert.ok(Array.isArray(checklistItems), 'Checklist items array must exist');
    assert.strictEqual(checklistItems.length, 31, 'New task snapshot must contain exactly 31 canonical items');

    // Verify snapshot groups
    const snapGroups = {};
    for (const item of checklistItems) {
      const gName = item.group_name || 'UNGROUPED';
      if (!snapGroups[gName]) snapGroups[gName] = [];
      snapGroups[gName].push(item);
    }
    assert.strictEqual(snapGroups['KAMAR MANDI']?.length, 8, 'Snapshot KAMAR MANDI count must be 8');
    assert.strictEqual(snapGroups['RUANGAN KAMAR']?.length, 13, 'Snapshot RUANGAN KAMAR count must be 13');
    assert.strictEqual(snapGroups['AMENITIES']?.length, 7, 'Snapshot AMENITIES count must be 7');
    assert.strictEqual(snapGroups['MINIBAR / KULKAS']?.length, 3, 'Snapshot MINIBAR / KULKAS count must be 3');

    // Verify no legacy labels in new snapshot
    const snapLabels = checklistItems.map(i => i.label);
    for (const leg of knownLegacy) {
      assert.strictEqual(
        snapLabels.includes(leg),
        false,
        `New snapshot must NOT include legacy item "${leg}"`
      );
    }
    console.log('  ✓ PASSED: New task snapshot created with 31 clean canonical items\n');

  } finally {
    // Zero residue cleanup
    if (createdTaskId) {
      await client.query('DELETE FROM housekeeping_task_checklist_items WHERE task_id = $1', [createdTaskId]);
      await client.query('DELETE FROM housekeeping_tasks WHERE id = $1', [createdTaskId]);
    }
    if (historicalTaskId) {
      await client.query('DELETE FROM housekeeping_task_checklist_items WHERE task_id = $1', [historicalTaskId]);
      await client.query('DELETE FROM housekeeping_tasks WHERE id = $1', [historicalTaskId]);
    }
    if (testRoomId) {
      await client.query('DELETE FROM rooms WHERE id = $1', [testRoomId]);
    }

    client.release();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await pool.end();
  }

  console.log('====================================================');
  console.log('ALL EMP-MOBILE-3G HOUSEKEEPING TESTS PASSED (5/5)!');
  console.log('====================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ EMP-MOBILE-3G TEST SUITE FAILED:', err);
  process.exit(1);
});
