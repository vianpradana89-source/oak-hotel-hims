'use strict';
/**
 * Test suite for Housekeeping Category Bulk Check & Property Settings.
 *
 * Verifies:
 *   1. Settings default: housekeeping_category_bulk_check_enabled is false.
 *   2. Settings update: toggling housekeeping_category_bulk_check_enabled persists per property.
 *   3. Settings isolation: property A setting does not leak to property B.
 *   4. Bulk check endpoint updates only items matching the specified category.
 *   5. Other categories in the same task remain unaffected.
 *   6. Bulk uncheck operates accurately.
 *   7. Bulk check does NOT auto-complete the task (status remains IN_PROGRESS).
 *   8. Finalized/Done tasks reject bulk check modifications.
 *   9. Cross-property isolation rejects bulk check requests with mismatched property_id.
 *   10. Deterministic cleanup and zero residue.
 */
require('dotenv').config({ path: 'E:/oak-hotel-hims/backend/.env' });
const http = require('http');
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');

let server;
let baseUrl;
let passed = 0;
let failed = 0;
const tracked = { properties: [], rooms: [], roomTypes: [], tasks: [] };

function expect(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error('FAIL: ' + msg);
  }
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(baseUrl + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function setup() {
  const client = await pool.connect();
  const s = String(Math.floor(Math.random() * 90) + 10);
  try {
    await client.query('BEGIN');

    // Create Property A and Property B (code max 6 chars)
    const rA = await client.query(
      `INSERT INTO properties (name, property_code, address, is_active)
       VALUES ('HK Bulk Prop A', 'H${s}A', 'Address A', TRUE) RETURNING id`
    );
    const pidA = rA.rows[0].id;
    tracked.properties.push(pidA);

    const rB = await client.query(
      `INSERT INTO properties (name, property_code, address, is_active)
       VALUES ('HK Bulk Prop B', 'H${s}B', 'Address B', TRUE) RETURNING id`
    );
    const pidB = rB.rows[0].id;
    tracked.properties.push(pidB);

    // Enable housekeeping feature for both properties
    await client.query(
      `INSERT INTO property_features (property_id, feature_key, enabled)
       VALUES ($1, 'housekeeping.enabled', TRUE), ($2, 'housekeeping.enabled', TRUE)`,
      [pidA, pidB]
    );

    // Create Room Types
    const rtA = await client.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, capacity, is_active)
       VALUES ($1, 'DLXA', 'Deluxe A', 500000, 2, TRUE) RETURNING id`,
      [pidA]
    );
    tracked.roomTypes.push(rtA.rows[0].id);

    const rtB = await client.query(
      `INSERT INTO room_types (property_id, code, name, base_rate, capacity, is_active)
       VALUES ($1, 'DLXB', 'Deluxe B', 500000, 2, TRUE) RETURNING id`,
      [pidB]
    );
    tracked.roomTypes.push(rtB.rows[0].id);

    // Create Rooms
    const rmA = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, status, is_active)
       VALUES ($1, $2, '101', 1, 'OCCUPIED_DIRTY', TRUE) RETURNING id`,
      [pidA, rtA.rows[0].id]
    );
    tracked.rooms.push(rmA.rows[0].id);

    const rmB = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, floor, status, is_active)
       VALUES ($1, $2, '201', 2, 'OCCUPIED_DIRTY', TRUE) RETURNING id`,
      [pidB, rtB.rows[0].id]
    );
    tracked.rooms.push(rmB.rows[0].id);

    // Create HK Task in Property A
    const tA = await client.query(
      `INSERT INTO housekeeping_tasks (
         property_id, room_id, task_type, task_number, status, priority, title
       ) VALUES (
         $1, $2, 'ROOM_CLEANING', 'HK-BULK-001', 'IN_PROGRESS', 'NORMAL', 'Cleaning 101'
       ) RETURNING id`,
      [pidA, rmA.rows[0].id]
    );
    const taskIdA = tA.rows[0].id;
    tracked.tasks.push(taskIdA);

    // Insert checklist items for 2 categories: KAMAR MANDI and RUANGAN KAMAR
    const items = [
      { cat: 'KAMAR MANDI', label: 'Sabun Mandi', req: true },
      { cat: 'KAMAR MANDI', label: 'Handuk', req: true },
      { cat: 'KAMAR MANDI', label: 'Kloset Bersih', req: false },
      { cat: 'RUANGAN KAMAR', label: 'Sprei Rapi', req: true },
      { cat: 'RUANGAN KAMAR', label: 'Bantal Rapih', req: true },
      { cat: 'RUANGAN KAMAR', label: 'Lantai Bersih', req: false }
    ];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await client.query(
        `INSERT INTO housekeeping_task_checklist_items (
           task_id, group_name, section, label, is_required, is_completed, sort_order
         ) VALUES ($1, $2, $2, $3, $4, FALSE, $5)`,
        [taskIdA, it.cat, it.label, it.req, i + 1]
      );
    }

    await client.query('COMMIT');
    return { pidA, pidB, taskIdA, roomIdA: rmA.rows[0].id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tracked.tasks.length > 0) {
      await client.query('DELETE FROM housekeeping_task_checklist_items WHERE task_id = ANY($1::int[])', [tracked.tasks]);
      await client.query('DELETE FROM housekeeping_tasks WHERE id = ANY($1::int[])', [tracked.tasks]);
    }
    if (tracked.rooms.length > 0) {
      await client.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [tracked.rooms]);
    }
    if (tracked.roomTypes.length > 0) {
      await client.query('DELETE FROM room_types WHERE id = ANY($1::int[])', [tracked.roomTypes]);
    }
    if (tracked.properties.length > 0) {
      await client.query('DELETE FROM property_housekeeping_settings WHERE property_id = ANY($1::int[])', [tracked.properties]);
      await client.query('DELETE FROM property_features WHERE property_id = ANY($1::int[])', [tracked.properties]);
      await client.query('DELETE FROM audit_logs WHERE property_id = ANY($1::int[])', [tracked.properties]);
      await client.query('DELETE FROM properties WHERE id = ANY($1::int[])', [tracked.properties]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Cleanup error:', err);
  } finally {
    client.release();
  }
}

async function runTests() {
  await initializeDatabase(pool);

  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  let fixtures;
  try {
    fixtures = await setup();
    const { pidA, pidB, taskIdA } = fixtures;

    console.log(`Starting HK Category Bulk Check tests with Prop A: ${pidA}, Prop B: ${pidB}, Task: ${taskIdA}`);

    // 1. Initial property settings default check
    const sA = await api('GET', `/api/housekeeping/settings?property_id=${pidA}`);
    expect(sA.status === 200, 'Settings endpoint returns 200 for Prop A');
    expect(sA.json?.data?.housekeeping_category_bulk_check_enabled === false, 'Default bulk check setting is FALSE for Prop A');

    const sB = await api('GET', `/api/housekeeping/settings?property_id=${pidB}`);
    expect(sB.status === 200, 'Settings endpoint returns 200 for Prop B');
    expect(sB.json?.data?.housekeeping_category_bulk_check_enabled === false, 'Default bulk check setting is FALSE for Prop B');

    // 2. Update Property A setting to TRUE
    const updA = await api('PATCH', `/api/housekeeping/settings`, {
      property_id: pidA,
      housekeeping_category_bulk_check_enabled: true
    });
    expect(updA.status === 200, 'Settings update returns 200 for Prop A');
    expect(updA.json?.data?.housekeeping_category_bulk_check_enabled === true, 'Prop A setting is now TRUE');

    // 3. Verify Property Isolation: Prop B remains FALSE
    const checkB = await api('GET', `/api/housekeeping/settings?property_id=${pidB}`);
    expect(checkB.json?.data?.housekeeping_category_bulk_check_enabled === false, 'Prop B setting remains FALSE (isolated)');

    // 4. Initial checklist state
    const clInitial = await api('GET', `/api/housekeeping/tasks/${taskIdA}/checklist?property_id=${pidA}`);
    expect(clInitial.status === 200, 'Task checklist fetch returns 200');
    const itemsInitial = clInitial.json?.data || [];
    expect(itemsInitial.length === 6, 'Task has 6 checklist items');
    expect(itemsInitial.every(i => !i.is_completed), 'All checklist items are initially uncompleted');

    // 5. Bulk check category "KAMAR MANDI"
    const bulkCheckRes = await api('PATCH', `/api/housekeeping/tasks/${taskIdA}/checklist/bulk-category`, {
      property_id: pidA,
      category: 'KAMAR MANDI',
      is_completed: true,
      actor_name: 'Budi HK'
    });
    console.log('bulkCheckRes:', JSON.stringify(bulkCheckRes));
    expect(bulkCheckRes.status === 200, 'Bulk category check returns 200');
    expect(bulkCheckRes.json?.data?.count === 3, 'Updated 3 items in KAMAR MANDI');

    // 6. Verify category items state: KAMAR MANDI completed, RUANGAN KAMAR untouched
    const clAfterCheck = await api('GET', `/api/housekeeping/tasks/${taskIdA}/checklist?property_id=${pidA}`);
    const itemsAfter = clAfterCheck.json?.data || [];
    const kmItems = itemsAfter.filter(i => i.group_name === 'KAMAR MANDI');
    const rkItems = itemsAfter.filter(i => i.group_name === 'RUANGAN KAMAR');

    expect(kmItems.length === 3 && kmItems.every(i => i.is_completed), 'All 3 KAMAR MANDI items are marked completed');
    expect(kmItems.every(i => i.completed_by_name === 'Budi HK'), 'completed_by_name is set to actor name');
    expect(rkItems.length === 3 && rkItems.every(i => !i.is_completed), 'All 3 RUANGAN KAMAR items remain UNCOMPLETED');

    // 7. Verify Task status is NOT auto-completed (still IN_PROGRESS)
    const taskStatusCheck = await api('GET', `/api/housekeeping/daily-operations?property_id=${pidA}`);
    const taskInOps = (taskStatusCheck.json?.data?.tasks || []).find(t => t.id === taskIdA);
    expect(taskInOps?.status === 'IN_PROGRESS', 'Task status remains IN_PROGRESS (no auto-completion)');

    // 8. Bulk uncheck "KAMAR MANDI"
    const bulkUncheckRes = await api('PATCH', `/api/housekeeping/tasks/${taskIdA}/checklist/bulk-category`, {
      property_id: pidA,
      category: 'KAMAR MANDI',
      is_completed: false,
      actor_name: 'Budi HK'
    });
    expect(bulkUncheckRes.status === 200, 'Bulk uncheck returns 200');

    const clAfterUncheck = await api('GET', `/api/housekeeping/tasks/${taskIdA}/checklist?property_id=${pidA}`);
    const kmItemsUnchecked = (clAfterUncheck.json?.data || []).filter(i => i.group_name === 'KAMAR MANDI');
    expect(kmItemsUnchecked.every(i => !i.is_completed), 'All KAMAR MANDI items are now uncompleted');

    // 8b. Test POST method on /tasks/:id/checklist-items/bulk-category with item_ids
    const rkIds = (clAfterUncheck.json?.data || []).filter(i => i.group_name === 'RUANGAN KAMAR').map(i => i.id);
    const postItemIdsRes = await api('POST', `/api/housekeeping/tasks/${taskIdA}/checklist-items/bulk-category`, {
      property_id: pidA,
      item_ids: rkIds,
      is_completed: true,
      actor_name: 'Siti HK'
    });
    expect(postItemIdsRes.status === 200, 'POST with item_ids returns 200');
    expect(postItemIdsRes.json?.data?.count === 3, 'Updated 3 items in RUANGAN KAMAR via item_ids');

    // 9. Finalized task rejection
    const client = await pool.connect();
    try {
      await client.query("UPDATE housekeeping_tasks SET status = 'DONE' WHERE id = $1", [taskIdA]);
    } finally {
      client.release();
    }

    const finalizedRes = await api('PATCH', `/api/housekeeping/tasks/${taskIdA}/checklist/bulk-category`, {
      property_id: pidA,
      category: 'KAMAR MANDI',
      is_completed: true
    });
    expect(finalizedRes.status === 400, 'Finalized task rejects bulk check with 400');
    expect(finalizedRes.json?.code === 'TASK_FINALIZED', 'Error code is TASK_FINALIZED');

    // 10. Cross-property mutation rejection
    const crossPropRes = await api('PATCH', `/api/housekeeping/tasks/${taskIdA}/checklist/bulk-category`, {
      property_id: pidB,
      category: 'KAMAR MANDI',
      is_completed: true
    });
    expect(crossPropRes.status === 404, 'Cross-property bulk check is rejected with 404');

    // 11. Audit log check
    const client2 = await pool.connect();
    try {
      const auditRes = await client2.query(
        `SELECT action, entity, property_id FROM audit_logs
         WHERE property_id = $1 AND action = 'HK_CHECKLIST_CATEGORY_BULK_CHECK'`,
        [pidA]
      );
      expect(auditRes.rows.length >= 3, 'Audit logs recorded for all bulk check operations');
    } finally {
      client2.release();
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
  } finally {
    await cleanup();
    server.close();
  }
}

runTests().then(() => {
  process.exit(failed > 0 ? 1 : 0);
}).catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
