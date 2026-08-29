'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { once } = require('events');
const { app, pool } = require('../dist/index');

let server;
let baseUrl;

async function request(method, requestPath, body) {
  const headers = { 'Content-Type': 'application/json' };
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, body: data };
}

async function runTest() {
  console.log('=== RUNNING EMP-MOBILE-3A HOUSEKEEPING WORKSTREAMS TEST ===');

  let testRoomId = null;
  let testRoomNumber = null;
  let testRoomId2 = null;
  let testRoomNumber2 = null;
  let origRoom1Status = 'VACANT_CLEAN';
  let origRoom2Status = 'VACANT_CLEAN';
  const createdTaskIds = [];

  try {
    // 1. Setup isolated test rooms for Property 1
    const catRes = await pool.query('SELECT id FROM room_categories WHERE property_id = 1 LIMIT 1');
    const catId = catRes.rows[0]?.id || null;
    const rtRes = await pool.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity, is_active)
       VALUES (1, $1, 'HK_3A_TYPE', 'HK 3A Test Type', 100000, 2, true)
       ON CONFLICT (property_id, code) DO UPDATE SET is_active = true
       RETURNING id`,
      [catId]
    );
    const testRoomTypeId = rtRes.rows[0].id;

    const r1 = await pool.query(
      `INSERT INTO rooms (property_id, room_number, room_type_id, status)
       VALUES (1, 'HK-3A-101', $1, 'VACANT_DIRTY')
       ON CONFLICT (property_id, room_number) DO UPDATE SET status = 'VACANT_DIRTY', room_type_id = $1
       RETURNING id`,
      [testRoomTypeId]
    );
    testRoomId = r1.rows[0].id;
    testRoomNumber = 'HK-3A-101';

    const r2 = await pool.query(
      `INSERT INTO rooms (property_id, room_number, room_type_id, status)
       VALUES (1, 'HK-3A-102', $1, 'VACANT_DIRTY')
       ON CONFLICT (property_id, room_number) DO UPDATE SET status = 'VACANT_DIRTY', room_type_id = $1
       RETURNING id`,
      [testRoomTypeId]
    );
    testRoomId2 = r2.rows[0].id;
    testRoomNumber2 = 'HK-3A-102';

    // Clean any pre-existing test residue
    await pool.query(`
      DELETE FROM housekeeping_tasks WHERE title LIKE '%TEST_3A_%' OR notes LIKE '%TEST_3A_%'
    `);

    // 1. Standard ROOM_CLEANING
    const cleanInsert = await pool.query(`
      INSERT INTO housekeeping_tasks (
        property_id, task_type, task_category, title, room_id, room_number, status, source_type, notes
      ) VALUES (
        1, 'ROOM_CLEANING', 'ROOM_OPERATIONS', 'TEST_3A_CLEANING_NORMAL', $1, $2, 'ASSIGNED', 'SYSTEM_AUTO', 'TEST_3A'
      ) RETURNING id
    `, [testRoomId, testRoomNumber]);
    const cleaningId = cleanInsert.rows[0].id;
    createdTaskIds.push(cleaningId);

    // 2. Turnover ROOM_CLEANING on room 2 (Turnover priority stays inside ROOM_CLEANING)
    const turnoverInsert = await pool.query(`
      INSERT INTO housekeeping_tasks (
        property_id, task_type, task_category, title, room_id, room_number, priority, status, source_type, notes
      ) VALUES (
        1, 'ROOM_CLEANING', 'ROOM_OPERATIONS', 'TEST_3A_CLEANING_TURNOVER', $1, $2, 'TURNOVER', 'ASSIGNED', 'SYSTEM_AUTO', 'TEST_3A'
      ) RETURNING id
    `, [testRoomId2, testRoomNumber2]);
    const turnoverId = turnoverInsert.rows[0].id;
    createdTaskIds.push(turnoverId);

    // 3. CHECKOUT_ROOM_CHECK
    const checkoutInsert = await pool.query(`
      INSERT INTO housekeeping_tasks (
        property_id, task_type, task_category, title, room_id, room_number, priority, status, source_type, notes
      ) VALUES (
        1, 'CHECKOUT_ROOM_CHECK', 'CHECKOUT_INSPECTION', 'TEST_3A_CHECKOUT', $1, $2, 'CRITICAL', 'REQUESTED', 'FRONT_OFFICE', 'TEST_3A'
      ) RETURNING id
    `, [testRoomId, testRoomNumber]);
    const checkoutId = checkoutInsert.rows[0].id;
    createdTaskIds.push(checkoutId);

    // 4. Special task types that must be EXCLUDED from Cleaning
    const specialTypes = [
      'DEEP_CLEAN',
      'TURN_DOWN',
      'MAKEUP',
      'STAYOVER_CLEANING',
      'VIP_ROOM_PREPARATION',
      'FINAL_INSPECTION'
    ];

    const specialTaskMap = {};
    for (const type of specialTypes) {
      const spTitle = `TEST_3A_SPECIAL_${type}`;
      const spInsert = await pool.query(`
        INSERT INTO housekeeping_tasks (
          property_id, task_type, task_category, title, room_id, room_number, status, source_type, notes
        ) VALUES (
          1, $1, 'ROOM_OPERATIONS', $2, $3, $4, 'ASSIGNED', 'SYSTEM_AUTO', 'TEST_3A'
        ) RETURNING id
      `, [type, spTitle, testRoomId, testRoomNumber]);
      const spId = spInsert.rows[0].id;
      createdTaskIds.push(spId);
      specialTaskMap[type] = spId;
    }

    // 5. Test manual task creation via POST /api/housekeeping/manual-tasks with authorized role (HOD)
    console.log('Testing manual task creation with authorized role (HOD)...');
    const manualTaskRes = await request('POST', '/api/housekeeping/manual-tasks', {
      property_id: 1,
      department: 'Housekeeping',
      title: 'TEST_3A_MANUAL_LEADERSHIP_TASK',
      description: 'Pembersihan lobi dan kaca koridor',
      priority: 'HIGH',
      creator_name: 'Pak Budi HOD',
      creator_role: 'Head Department / Supervisor'
    });
    if (manualTaskRes.status !== 201 || !manualTaskRes.body?.data?.id) {
      throw new Error(`Failed to create manual task: ${manualTaskRes.status} ${JSON.stringify(manualTaskRes.body)}`);
    }
    const manualTaskId = manualTaskRes.body.data.id;
    createdTaskIds.push(manualTaskId);
    console.log(`✓ Manual task created with ID ${manualTaskId}, Task Number: ${manualTaskRes.body.data.task_number}`);

    // 6. Test unauthorized creator role
    console.log('Testing unauthorized role for manual task creation...');
    const unauthRes = await request('POST', '/api/housekeeping/manual-tasks', {
      property_id: 1,
      title: 'TEST_3A_UNAUTHORIZED',
      creator_name: 'Joni Crew',
      creator_role: 'Crew'
    });
    if (unauthRes.status !== 403 || unauthRes.body?.code !== 'UNAUTHORIZED_TASK_CREATOR') {
      throw new Error(`Expected 403 UNAUTHORIZED_TASK_CREATOR, got ${unauthRes.status}`);
    }
    console.log('✓ Unauthorized creator role successfully blocked with 403');

    // 7. Verify stream=CLEANING strictly contains ROOM_CLEANING only
    console.log('Verifying stream=CLEANING contains ROOM_CLEANING only...');
    const cleaningStreamRes = await request('GET', '/api/housekeeping/tasks?property_id=1&stream=CLEANING');
    if (cleaningStreamRes.status !== 200 || !Array.isArray(cleaningStreamRes.body.data)) {
      throw new Error('Failed to fetch stream=CLEANING');
    }
    const cleaningStreamTasks = cleaningStreamRes.body.data;
    const cleaningStreamIds = cleaningStreamTasks.map(t => t.id);

    // Must include ROOM_CLEANING normal & turnover
    if (!cleaningStreamIds.includes(cleaningId)) {
      throw new Error('Normal ROOM_CLEANING task not found in stream=CLEANING');
    }
    if (!cleaningStreamIds.includes(turnoverId)) {
      throw new Error('Turnover ROOM_CLEANING task not found in stream=CLEANING');
    }

    // Must exclude CHECKOUT_ROOM_CHECK
    if (cleaningStreamIds.includes(checkoutId)) {
      throw new Error('CHECKOUT_ROOM_CHECK must NOT appear in stream=CLEANING');
    }

    // Must exclude manual leadership task
    if (cleaningStreamIds.includes(manualTaskId)) {
      throw new Error('Manual task must NOT appear in stream=CLEANING');
    }

    // Must exclude all special types: DEEP_CLEAN, TURN_DOWN, MAKEUP, STAYOVER_CLEANING, VIP_ROOM_PREPARATION, FINAL_INSPECTION
    for (const [type, id] of Object.entries(specialTaskMap)) {
      if (cleaningStreamIds.includes(id)) {
        throw new Error(`Special task type '${type}' (ID ${id}) must NOT appear in stream=CLEANING`);
      }
      console.log(`✓ ${type} strictly excluded from stream=CLEANING`);
    }

    // Verify all tasks in stream=CLEANING are task_type === 'ROOM_CLEANING'
    const nonCleaningFound = cleaningStreamTasks.filter(t => t.task_type !== 'ROOM_CLEANING');
    if (nonCleaningFound.length > 0) {
      throw new Error(`Found non-ROOM_CLEANING tasks in stream=CLEANING: ${JSON.stringify(nonCleaningFound.map(t => t.task_type))}`);
    }
    console.log('✓ stream=CLEANING contains strictly ROOM_CLEANING only');

    // 8. Verify stream=CHECKOUT contains CHECKOUT_ROOM_CHECK only
    console.log('Verifying stream=CHECKOUT contains CHECKOUT_ROOM_CHECK only...');
    const checkoutStreamRes = await request('GET', '/api/housekeeping/tasks?property_id=1&stream=CHECKOUT');
    const checkoutStreamTasks = checkoutStreamRes.body.data;
    const checkoutStreamIds = checkoutStreamTasks.map(t => t.id);

    if (!checkoutStreamIds.includes(checkoutId)) {
      throw new Error('CHECKOUT_ROOM_CHECK not found in stream=CHECKOUT');
    }
    if (checkoutStreamIds.includes(cleaningId) || checkoutStreamIds.includes(turnoverId) || checkoutStreamIds.includes(manualTaskId)) {
      throw new Error('Cleaning/Manual tasks found in stream=CHECKOUT');
    }
    const nonCheckoutFound = checkoutStreamTasks.filter(t => t.task_type !== 'CHECKOUT_ROOM_CHECK');
    if (nonCheckoutFound.length > 0) {
      throw new Error('Found non-CHECKOUT_ROOM_CHECK in stream=CHECKOUT');
    }
    console.log('✓ stream=CHECKOUT contains strictly CHECKOUT_ROOM_CHECK only');

    // 9. Verify stream=TASK contains manual tasks and leadership creations
    console.log('Verifying stream=TASK contains manual tasks and excludes automatic cleaning/checkout...');
    const taskStreamRes = await request('GET', '/api/housekeeping/tasks?property_id=1&stream=TASK');
    const taskStreamTasks = taskStreamRes.body.data;
    const taskStreamIds = taskStreamTasks.map(t => t.id);

    if (!taskStreamIds.includes(manualTaskId)) {
      throw new Error('Manual task not found in stream=TASK');
    }
    if (taskStreamIds.includes(cleaningId) || taskStreamIds.includes(turnoverId) || taskStreamIds.includes(checkoutId)) {
      throw new Error('Cleaning or Checkout tasks found in stream=TASK');
    }
    console.log('✓ stream=TASK strictly isolated to manual/management tasks');

    // 10. Verify GET /api/housekeeping/workstream-counts reconciles with exact active rows
    console.log('Verifying workstream counts reconciliation...');
    const countsRes = await request('GET', '/api/housekeeping/workstream-counts?property_id=1');
    const { cleaning, checkout, task, history } = countsRes.body.data;

    // Fetch active lists directly
    const [allCleanRes, allCheckRes, allTaskRes] = await Promise.all([
      request('GET', '/api/housekeeping/tasks?property_id=1&stream=CLEANING'),
      request('GET', '/api/housekeeping/tasks?property_id=1&stream=CHECKOUT'),
      request('GET', '/api/housekeeping/tasks?property_id=1&stream=TASK')
    ]);

    if (cleaning !== allCleanRes.body.data.length) {
      throw new Error(`Cleaning count mismatch: counter=${cleaning}, actual=${allCleanRes.body.data.length}`);
    }
    if (checkout !== allCheckRes.body.data.length) {
      throw new Error(`Checkout count mismatch: counter=${checkout}, actual=${allCheckRes.body.data.length}`);
    }
    if (task !== allTaskRes.body.data.length) {
      throw new Error(`Task count mismatch: counter=${task}, actual=${allTaskRes.body.data.length}`);
    }
    console.log(`✓ Counters perfectly reconcile: Cleaning=${cleaning}, Checkout=${checkout}, Task=${task}, History=${history}`);

    // 11. Verify Sidebar Configuration
    console.log('Verifying Sidebar Navigation configuration...');
    const fs = require('fs');
    const sidebarContent = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'features', 'shell', 'AppSidebar.tsx'), 'utf8');

    if (sidebarContent.includes("'Mobile Portal' as MainNavKey") || sidebarContent.includes("label: 'Mobile Crew Portal'")) {
      throw new Error("Duplicate 'Mobile Crew Portal' still present in AppSidebar.tsx");
    }
    if (!sidebarContent.includes("key: 'Employee Mobile' as MainNavKey") || !sidebarContent.includes("label: 'Employee Mobile'")) {
      throw new Error("Management 'Employee Mobile' entry missing from AppSidebar.tsx");
    }
    console.log("✓ Mobile Crew Portal removed from Departemen sidebar");
    console.log("✓ Management -> Employee Mobile confirmed present as authoritative admin entry");

    console.log('=== ALL 14 EMP-MOBILE-3A HOUSEKEEPING WORKSTREAM TESTS PASSED ===');
  } finally {
    // Teardown test fixtures
    console.log('Cleaning up test fixtures...');
    if (createdTaskIds.length > 0) {
      await pool.query('DELETE FROM housekeeping_tasks WHERE id = ANY($1::int[])', [createdTaskIds]);
    }
    await pool.query("DELETE FROM housekeeping_tasks WHERE title LIKE '%TEST_3A_%' OR notes LIKE '%TEST_3A_%'");
    if (testRoomId || testRoomId2) {
      const rids = [testRoomId, testRoomId2].filter(Boolean);
      await pool.query('DELETE FROM rooms WHERE id = ANY($1::int[])', [rids]);
      await pool.query("DELETE FROM room_types WHERE code = 'HK_3A_TYPE' AND property_id = 1");
    }
  }
}

async function main() {
  const { initializeDatabase } = require('../dist/db/schema_v3');
  await initializeDatabase(pool);

  server = app.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    await runTest();
  } catch (err) {
    console.error('\n[FATAL TEST FAILURE]', err);
    process.exitCode = 1;
  } finally {
    server.close();
    await pool.end();
  }
}

main();
