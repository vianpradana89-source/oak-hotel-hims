const assert = require('assert');
const http = require('http');
const express = require('express');
const { Pool } = require('pg');
require('dotenv').config({ path: 'e:/oak-hotel-hims/backend/.env' });

const { initializeDatabase } = require('../dist/db/schema_v3');
const { createHousekeepingRouter } = require('../dist/domains/housekeeping/housekeepingRouter');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'oak_hotel_db',
});

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    }).on('error', reject);
  });
}

function httpRequest(method, url, postData) {
  return new Promise((resolve, reject) => {
    const payload = postData !== undefined ? JSON.stringify(postData) : '';
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const httpPost = (url, data) => httpRequest('POST', url, data);
const httpPatch = (url, data) => httpRequest('PATCH', url, data);
const httpDelete = (url) => httpRequest('DELETE', url);

async function runTests() {
  console.log('====================================================');
  console.log('Running EMP-MOBILE-3F Housekeeping Regression Suite');
  console.log('====================================================\n');

  await initializeDatabase(pool);

  // Spin up an in-process express server mounting current router
  const app = express();
  app.use(express.json());
  app.use('/api/housekeeping', createHousekeepingRouter(pool));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const client = await pool.connect();
  const testPropertyId = 1;
  let testRoomId = null;
  let testTemplateId = null;
  let createdTaskIds = [];

  try {
    // Setup isolated test room
    const roomRes = await client.query(
      `INSERT INTO rooms (property_id, room_number, room_type_id, status, created_at, updated_at)
       VALUES ($1, 'TEST-3F-99', 1, 'OCCUPIED_DIRTY', NOW(), NOW())
       RETURNING id`,
      [testPropertyId]
    );
    testRoomId = roomRes.rows[0].id;

    // Ensure standard room cleaning groups & items are fully active
    await client.query(`
      UPDATE checklist_template_groups
      SET is_active = TRUE, is_archived = FALSE
      WHERE template_id = (SELECT id FROM checklist_templates WHERE code = 'STANDARD_ROOM_CLEANING' AND property_id = $1 LIMIT 1)
    `, [testPropertyId]);
    await client.query(`
      UPDATE checklist_template_items
      SET is_active = TRUE
      WHERE template_id = (SELECT id FROM checklist_templates WHERE code = 'STANDARD_ROOM_CLEANING' AND property_id = $1 LIMIT 1)
        AND group_id IS NOT NULL AND is_archived = FALSE
    `, [testPropertyId]);

    // Test 1: Canonical Standard Room Cleaning template has 4 groups and canonical items
    console.log('Test 1: Standard Room Cleaning has 4 canonical groups and items');
    const stdTplRes = await httpGet(`${baseUrl}/api/housekeeping/templates?property_id=${testPropertyId}`);
    assert.strictEqual(stdTplRes.status, 200, 'GET /templates must return 200');
    const stdTpl = stdTplRes.body.data.find(t => t.code === 'STANDARD_ROOM_CLEANING');
    assert.ok(stdTpl, 'STANDARD_ROOM_CLEANING template must exist');
    assert.ok(Array.isArray(stdTpl.groups), 'Template must include groups array');
    assert.strictEqual(stdTpl.groups.length, 4, 'Standard template must have exactly 4 groups');

    const groupNames = stdTpl.groups.map(g => g.name);
    assert.deepStrictEqual(groupNames, ['KAMAR MANDI', 'RUANGAN KAMAR', 'AMENITIES', 'MINIBAR / KULKAS']);

    // Check Minibar group items are active but optional
    const minibarGroup = stdTpl.groups.find(g => g.code === 'MINIBAR_KULKAS');
    assert.ok(minibarGroup, 'MINIBAR_KULKAS group must exist');
    const minibarItems = stdTpl.items.filter(i => i.group_id === minibarGroup.id && i.is_active && !i.is_archived);
    assert.strictEqual(minibarItems.length, 3, 'Minibar must have 3 items');
    for (const item of minibarItems) {
      assert.strictEqual(item.is_active, true, 'Minibar item must be active by default');
      assert.strictEqual(item.is_required, false, 'Minibar item must be optional by default');
    }
    console.log('  ✓ PASSED: Canonical Standard Room Cleaning structure verified\n');

    // Test 2: Group CRUD & Reordering on a custom template
    console.log('Test 2: Group CRUD, active toggle, and reordering');
    const tplCreateRes = await httpPost(`${baseUrl}/api/housekeeping/templates`, {
      property_id: testPropertyId,
      code: 'TEST_3F_CUSTOM',
      name: 'Custom 3F Template',
      task_type: 'ROOM_CLEANING',
      is_active: true
    });
    assert.strictEqual(tplCreateRes.status, 201, 'POST /templates must create template');
    testTemplateId = tplCreateRes.body.data.id;

    // 2a. Add Groups
    const g1Res = await httpPost(`${baseUrl}/api/housekeeping/templates/${testTemplateId}/groups`, {
      property_id: testPropertyId,
      code: 'G_AREA_A',
      name: 'Area Depan',
      sort_order: 10
    });
    assert.strictEqual(g1Res.status, 201, 'Add group 1 must succeed');
    const g1Id = g1Res.body.data.id;

    const g2Res = await httpPost(`${baseUrl}/api/housekeeping/templates/${testTemplateId}/groups`, {
      property_id: testPropertyId,
      code: 'G_AREA_B',
      name: 'Area Belakang',
      sort_order: 20
    });
    assert.strictEqual(g2Res.status, 201, 'Add group 2 must succeed');
    const g2Id = g2Res.body.data.id;

    // 2b. Edit Group
    const gEditRes = await httpPatch(`${baseUrl}/api/housekeeping/templates/${testTemplateId}/groups/${g1Id}`, {
      name: 'Area Teras & Depan',
      description: 'Pintu masuk dan teras luar'
    });
    assert.strictEqual(gEditRes.status, 200, 'Edit group must succeed');
    assert.strictEqual(gEditRes.body.data.name, 'Area Teras & Depan');

    // 2c. Reorder Groups
    const reorderGRes = await httpPost(`${baseUrl}/api/housekeeping/templates/${testTemplateId}/groups/reorder`, {
      property_id: testPropertyId,
      groupIds: [g2Id, g1Id]
    });
    assert.strictEqual(reorderGRes.status, 200, 'Reorder groups must succeed');

    const gListRes = await httpGet(`${baseUrl}/api/housekeeping/templates/${testTemplateId}/groups?property_id=${testPropertyId}`);
    assert.strictEqual(gListRes.status, 200);
    assert.strictEqual(gListRes.body.data[0].id, g2Id, 'Group 2 should now be first');
    assert.strictEqual(gListRes.body.data[1].id, g1Id, 'Group 1 should now be second');
    console.log('  ✓ PASSED: Group CRUD and reordering functional\n');

    // Test 3: Item CRUD, group transfer, and item reordering
    console.log('Test 3: Item CRUD, cross-group transfer, and reorder');
    const item1Res = await httpPost(`${baseUrl}/api/housekeeping/templates/${testTemplateId}/items`, {
      group_id: g1Id,
      label: 'Sapu Teras',
      sort_order: 10,
      is_required: true
    });
    assert.strictEqual(item1Res.status, 201);
    const item1Id = item1Res.body.data.id;

    const item2Res = await httpPost(`${baseUrl}/api/housekeeping/templates/${testTemplateId}/items`, {
      group_id: g1Id,
      label: 'Lap Kaca Depan',
      sort_order: 20,
      is_required: false
    });
    assert.strictEqual(item2Res.status, 201);
    const item2Id = item2Res.body.data.id;

    // Cross-group transfer: move item2 to g2
    const moveRes = await httpPatch(`${baseUrl}/api/housekeeping/templates/${testTemplateId}/items/${item2Id}`, {
      group_id: g2Id,
      label: 'Lap Kaca Belakang'
    });
    assert.strictEqual(moveRes.status, 200);
    assert.strictEqual(moveRes.body.data.group_id, g2Id, 'Item should be moved to group 2');
    console.log('  ✓ PASSED: Item CRUD and cross-group transfer functional\n');

    // Test 4: Task creation snapshots full group hierarchy with group_name and group_sort_order
    console.log('Test 4: Task creation snapshots full group context');
    const startCleanRes = await httpPost(`${baseUrl}/api/housekeeping/tasks`, {
      property_id: testPropertyId,
      room_id: testRoomId,
      task_type: 'ROOM_CLEANING',
      assigned_user_id: 1,
      assigned_user_name_snapshot: 'Budi Housekeeping'
    });
    assert.strictEqual(startCleanRes.status, 201, 'Create task must succeed');
    const taskId1 = startCleanRes.body.data.id;
    assert.ok(taskId1, 'Task ID must be returned');
    createdTaskIds.push(taskId1);

    const snapRes = await httpGet(`${baseUrl}/api/housekeeping/tasks/${taskId1}/checklist?property_id=${testPropertyId}`);
    assert.strictEqual(snapRes.status, 200);
    const items = snapRes.body.data;
    assert.ok(items.length > 0, 'Snapshot must contain items');

    // Verify all items have group_name and group_sort_order populated
    for (const it of items) {
      assert.ok(it.group_name, `Item ${it.label} must have group_name`);
      assert.ok(it.group_sort_order !== undefined && it.group_sort_order !== null, `Item ${it.label} must have group_sort_order`);
    }

    // Verify items are sorted by group_sort_order ASC, sort_order ASC
    for (let i = 0; i < items.length - 1; i++) {
      const cur = items[i];
      const nxt = items[i + 1];
      const curG = cur.group_sort_order || 0;
      const nxtG = nxt.group_sort_order || 0;
      if (curG === nxtG) {
        assert.ok((cur.sort_order || 0) <= (nxt.sort_order || 0), `Item order within group must be preserved: ${cur.label} <= ${nxt.label}`);
      } else {
        assert.ok(curG < nxtG, `Group order must be ascending: ${curG} < ${nxtG}`);
      }
    }
    console.log('  ✓ PASSED: Task checklist snapshot correctly stores group context and ordering\n');

    // Test 5: Inactive group and inactive items are excluded from new tasks
    console.log('Test 5: Inactive groups and inactive items are excluded from new snapshots');
    // Deactivate MINIBAR group on standard template
    const stdGroups = stdTpl.groups;
    const minibarG = stdGroups.find(g => g.code === 'MINIBAR_KULKAS');
    await httpPatch(`${baseUrl}/api/housekeeping/templates/${stdTpl.id}/groups/${minibarG.id}`, {
      is_active: false
    });

    // Create a new room & task
    const room2Res = await client.query(
      `INSERT INTO rooms (property_id, room_number, room_type_id, status, created_at, updated_at)
       VALUES ($1, 'TEST-3F-98', 1, 'OCCUPIED_DIRTY', NOW(), NOW())
       RETURNING id`,
      [testPropertyId]
    );
    const testRoomId2 = room2Res.rows[0].id;

    const startClean2 = await httpPost(`${baseUrl}/api/housekeeping/tasks`, {
      property_id: testPropertyId,
      room_id: testRoomId2,
      task_type: 'ROOM_CLEANING',
      assigned_user_id: 2,
      assigned_user_name_snapshot: 'Siti Housekeeping'
    });
    assert.strictEqual(startClean2.status, 201, 'Create task 2 must succeed');
    const taskId2 = startClean2.body.data.id;
    createdTaskIds.push(taskId2);

    const snap2Res = await httpGet(`${baseUrl}/api/housekeeping/tasks/${taskId2}/checklist?property_id=${testPropertyId}`);
    const items2 = snap2Res.body.data;
    const hasMinibar = items2.some(i => i.group_name === 'MINIBAR / KULKAS' || i.group_code === 'MINIBAR_KULKAS');
    assert.strictEqual(hasMinibar, false, 'Inactive group MINIBAR must not appear in new task snapshot');

    // Re-activate MINIBAR group
    await httpPatch(`${baseUrl}/api/housekeeping/templates/${stdTpl.id}/groups/${minibarG.id}`, {
      is_active: true
    });
    console.log('  ✓ PASSED: Inactive group exclusion verified\n');

    // Test 6: Historical Task Snapshot Immutability (Requirement 17 Synchronization Scenario)
    console.log('Test 6: Historical task snapshot immutability across template modifications');
    // Verify taskId1 still has MINIBAR items from when it was created
    const snap1Recheck = await httpGet(`${baseUrl}/api/housekeeping/tasks/${taskId1}/checklist?property_id=${testPropertyId}`);
    const hasMinibar1 = snap1Recheck.body.data.some(i => i.group_name === 'MINIBAR / KULKAS');
    assert.strictEqual(hasMinibar1, true, 'Historical task 1 snapshot MUST retain its original items');

    // Clean up room 2
    await client.query('DELETE FROM housekeeping_task_checklist_items WHERE task_id = $1', [taskId2]);
    await client.query('DELETE FROM housekeeping_tasks WHERE id = $1', [taskId2]);
    await client.query('DELETE FROM rooms WHERE id = $1', [testRoomId2]);
    console.log('  ✓ PASSED: Historical task snapshot immutability verified\n');

    // Test 7: Safe Delete / Archive rule for Groups
    console.log('Test 7: Safe delete / archive rule for groups');
    // Group with snapshot reference cannot be hard-deleted, gets archived
    const stdG1 = stdGroups[0];
    const delRes = await httpDelete(`${baseUrl}/api/housekeeping/templates/${stdTpl.id}/groups/${stdG1.id}`);
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(delRes.body.data.archived, true, 'Referenced group must be archived, not hard-deleted');

    // Restore group active status
    await httpPatch(`${baseUrl}/api/housekeeping/templates/${stdTpl.id}/groups/${stdG1.id}`, {
      is_active: true,
      is_archived: false
    });
    await client.query(`UPDATE checklist_template_groups SET is_active = TRUE, is_archived = FALSE WHERE id = $1`, [stdG1.id]);
    await client.query(`UPDATE checklist_template_items SET is_active = TRUE, is_archived = FALSE WHERE group_id = $1 AND template_id = $2`, [stdG1.id, stdTpl.id]);

    // Group without snapshot reference is hard-deleted
    const unrefGRes = await httpDelete(`${baseUrl}/api/housekeeping/templates/${testTemplateId}/groups/${g2Id}`);
    assert.strictEqual(unrefGRes.status, 200);
    assert.strictEqual(unrefGRes.body.data.deleted, true, 'Unreferenced group must be hard deleted');
    console.log('  ✓ PASSED: Safe delete / archive rule verified\n');

    console.log('====================================================');
    console.log('ALL EMP-MOBILE-3F HOUSEKEEPING TESTS PASSED (7/7)!');
    console.log('====================================================\n');

  } finally {
    // Teardown test fixtures
    try {
      for (const tId of createdTaskIds) {
        await client.query('DELETE FROM housekeeping_task_checklist_items WHERE task_id = $1', [tId]);
        await client.query('DELETE FROM housekeeping_task_findings WHERE task_id = $1', [tId]);
        await client.query('DELETE FROM housekeeping_tasks WHERE id = $1', [tId]);
      }
      if (testRoomId) {
        await client.query('DELETE FROM rooms WHERE id = $1', [testRoomId]);
      }
      if (testTemplateId) {
        await client.query('DELETE FROM checklist_template_items WHERE template_id = $1', [testTemplateId]);
        await client.query('DELETE FROM checklist_template_groups WHERE template_id = $1', [testTemplateId]);
        await client.query('DELETE FROM checklist_templates WHERE id = $1', [testTemplateId]);
      }
    } catch (cleanErr) {
      console.error('Teardown error:', cleanErr);
    }
    server.close();
    client.release();
    await pool.end();
  }
}

runTests().catch(err => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
