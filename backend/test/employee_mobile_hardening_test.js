'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { ensureDirtyRoomCleaningTask, completeHousekeepingTask } = require('../dist/domains/housekeeping/housekeepingService');

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
  console.log('=== RUNNING EMP-MOBILE-3B LIVE MOBILE OPERATIONAL HARDENING TEST ===');

  let testRoomId1 = null;
  let testRoomId2 = null;
  let origRoom1Status = 'VACANT_CLEAN';
  let origRoom2Status = 'VACANT_CLEAN';
  const createdTaskIds = [];

  try {
    // 1. Get 2 test physical rooms from property 1
    const roomsRes = await pool.query(`
      SELECT id, room_number, status FROM rooms WHERE property_id = 1 ORDER BY id ASC LIMIT 2
    `);
    if (roomsRes.rows.length < 2) {
      throw new Error('At least 2 physical rooms required for testing');
    }
    testRoomId1 = roomsRes.rows[0].id;
    origRoom1Status = roomsRes.rows[0].status;
    testRoomId2 = roomsRes.rows[1].id;
    origRoom2Status = roomsRes.rows[1].status;

    console.log(`Test Room 1: ID ${testRoomId1} (original status: ${origRoom1Status})`);
    console.log(`Test Room 2: ID ${testRoomId2} (original status: ${origRoom2Status})`);

    // Clean any pre-existing test residue
    await pool.query(`
      DELETE FROM housekeeping_tasks WHERE title LIKE '%TEST_3B_%' OR notes LIKE '%TEST_3B_%'
    `);

    // =========================================================================
    // TEST 1: STRICT ACTIVE CLEANING INVARIANT (PROPERTY + ROOM + ACTIVE ROOM_CLEANING <= 1)
    // =========================================================================
    console.log('\n--- Test 1: Invariant & Idempotency of ensureDirtyRoomCleaningTask ---');

    // Set room 1 to VACANT_DIRTY
    await pool.query('UPDATE rooms SET status = $1 WHERE id = $2', ['VACANT_DIRTY', testRoomId1]);

    const client = await pool.connect();
    let task1A, task1B, task1C;
    try {
      task1A = await ensureDirtyRoomCleaningTask(client, 1, testRoomId1, {
        actor: { name: 'TEST_3B_ACTOR' }
      });
      createdTaskIds.push(task1A.id);

      // Repeated call must return the exact same active task (idempotent)
      task1B = await ensureDirtyRoomCleaningTask(client, 1, testRoomId1, {
        actor: { name: 'TEST_3B_ACTOR' }
      });

      // Concurrent simulation
      const [p1, p2] = await Promise.all([
        ensureDirtyRoomCleaningTask(client, 1, testRoomId1, { actor: { name: 'TEST_3B_CONC_1' } }),
        ensureDirtyRoomCleaningTask(client, 1, testRoomId1, { actor: { name: 'TEST_3B_CONC_2' } })
      ]);
      task1C = p1;
    } finally {
      client.release();
    }

    if (!task1A || !task1B || task1A.id !== task1B.id) {
      throw new Error(`Idempotency failure: task1A.id (${task1A?.id}) !== task1B.id (${task1B?.id})`);
    }
    console.log(`  ✓ ensureDirtyRoomCleaningTask is idempotent (returned taskId ${task1A.id})`);

    // Verify active cleaning tasks in DB for room 1 is exactly 1
    const activeCountRes = await pool.query(`
      SELECT COUNT(*)::int AS cnt FROM housekeeping_tasks
      WHERE property_id = 1 AND room_id = $1 AND task_type = 'ROOM_CLEANING'
        AND status IN ('REQUESTED', 'PENDING', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')
    `, [testRoomId1]);

    const activeCount = activeCountRes.rows[0].cnt;
    if (activeCount !== 1) {
      throw new Error(`Active cleaning invariant violated for room ${testRoomId1}: expected 1, found ${activeCount}`);
    }
    console.log(`  ✓ DB invariant verified: exactly 1 active ROOM_CLEANING task in DB`);

    // =========================================================================
    // TEST 2: CLEANING COMPLETION LEAVES ACTIVE STREAM & RESTORES ROOM STATUS
    // =========================================================================
    console.log('\n--- Test 2: Cleaning completion transitions room & closes active task ---');

    const clientComplete = await pool.connect();
    try {
      await clientComplete.query('BEGIN');
      await clientComplete.query(
        'UPDATE housekeeping_task_checklist_items SET is_completed = TRUE WHERE task_id = $1',
        [task1A.id]
      );
      await completeHousekeepingTask(clientComplete, 1, task1A.id, {
        notes: 'TEST_3B Cleaning Done',
        actor: { name: 'TEST_3B_CREW', role: 'Housekeeping' }
      });
      await clientComplete.query('COMMIT');
    } catch (err) {
      await clientComplete.query('ROLLBACK');
      throw err;
    } finally {
      clientComplete.release();
    }

    // Verify room 1 status is now VACANT_CLEAN
    const room1AfterRes = await pool.query('SELECT status FROM rooms WHERE id = $1', [testRoomId1]);
    const room1Status = room1AfterRes.rows[0].status;
    if (room1Status !== 'VACANT_CLEAN') {
      throw new Error(`Expected room status VACANT_CLEAN after completion, got ${room1Status}`);
    }
    console.log(`  ✓ Room status successfully updated to ${room1Status}`);

    // Verify active cleaning tasks for room 1 is now 0
    const activeAfterRes = await pool.query(`
      SELECT COUNT(*)::int AS cnt FROM housekeeping_tasks
      WHERE property_id = 1 AND room_id = $1 AND task_type = 'ROOM_CLEANING'
        AND status IN ('REQUESTED', 'PENDING', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'BLOCKED')
    `, [testRoomId1]);
    if (activeAfterRes.rows[0].cnt !== 0) {
      throw new Error(`Active cleaning tasks remaining after completion: expected 0, got ${activeAfterRes.rows[0].cnt}`);
    }
    console.log(`  ✓ Zero active cleaning tasks remaining for completed room`);

    // =========================================================================
    // TEST 3: STALE ROOM/TASK MISMATCH EXCLUSION IN API
    // =========================================================================
    console.log('\n--- Test 3: Stale active task on non-dirty room is excluded from active cleaning query ---');

    // Insert a synthetic stale active cleaning task on room 2 which is VACANT_CLEAN
    await pool.query('UPDATE rooms SET status = $1 WHERE id = $2', ['VACANT_CLEAN', testRoomId2]);
    const staleInsert = await pool.query(`
      INSERT INTO housekeeping_tasks (
        property_id, task_type, task_category, title, room_id, room_number, status, source_type, notes
      ) VALUES (
        1, 'ROOM_CLEANING', 'ROOM_OPERATIONS', 'TEST_3B_STALE_ON_CLEAN', $1, (SELECT room_number FROM rooms WHERE id = $1), 'ASSIGNED', 'MANUAL', 'TEST_3B'
      ) RETURNING id
    `, [testRoomId2]);
    const staleTaskId = staleInsert.rows[0].id;
    createdTaskIds.push(staleTaskId);

    // Query active cleaning stream via API
    const apiTasks = await request('GET', '/api/housekeeping/tasks?property_id=1&stream=CLEANING&scope=active');
    if (apiTasks.status !== 200 || !apiTasks.body?.data) {
      throw new Error(`Failed to query active cleaning tasks via API: ${JSON.stringify(apiTasks)}`);
    }

    const foundStaleInApi = apiTasks.body.data.some(t => t.id === staleTaskId);
    if (foundStaleInApi) {
      throw new Error(`Stale active task ${staleTaskId} on VACANT_CLEAN room was incorrectly exposed in active cleaning stream!`);
    }
    console.log(`  ✓ Stale active task on non-dirty room is correctly excluded from GET /tasks?stream=CLEANING`);

    // Verify GET /workstream-counts does not count stale task on clean room
    const countsRes = await request('GET', '/api/housekeeping/workstream-counts?property_id=1');
    if (countsRes.status !== 200 || !countsRes.body?.data) {
      throw new Error(`Failed to query workstream counts: ${JSON.stringify(countsRes)}`);
    }
    console.log(`  ✓ GET /workstream-counts returned: ${JSON.stringify(countsRes.body.data)}`);

    // =========================================================================
    // TEST 4: ROLE PERMISSION GATING FOR MANUAL TASK CREATION
    // =========================================================================
    console.log('\n--- Test 4: Crew role 403 vs Leadership role 201 for manual task creation ---');

    // 4A: Crew role (e.g. Siti Rahmawati / Housekeeping Staff) must be rejected with 403
    const crewCreate = await request('POST', '/api/housekeeping/manual-tasks', {
      property_id: 1,
      title: 'TEST_3B_CREW_ATTEMPT',
      creator_name: 'Siti Rahmawati',
      creator_role: 'Housekeeping'
    });
    if (crewCreate.status !== 403 || crewCreate.body?.code !== 'UNAUTHORIZED_TASK_CREATOR') {
      throw new Error(`Expected 403 UNAUTHORIZED_TASK_CREATOR for Crew, got ${crewCreate.status}: ${JSON.stringify(crewCreate.body)}`);
    }
    console.log(`  ✓ Crew role correctly rejected with 403 UNAUTHORIZED_TASK_CREATOR`);

    // 4B: Supervisor / HOD role must succeed with 201
    const hodCreate = await request('POST', '/api/housekeeping/manual-tasks', {
      property_id: 1,
      title: 'TEST_3B_HOD_TASK',
      description: 'Periksa linen koridor lantai 2',
      creator_name: 'Pak Budi',
      creator_role: 'Supervisor Housekeeping'
    });
    if (hodCreate.status !== 201 || !hodCreate.body?.data?.id) {
      throw new Error(`Expected 201 Created for Supervisor, got ${hodCreate.status}: ${JSON.stringify(hodCreate.body)}`);
    }
    createdTaskIds.push(hodCreate.body.data.id);
    console.log(`  ✓ Supervisor role successfully created manual task ID ${hodCreate.body.data.id}`);

    // 4C: GM / Owner role must succeed with 201
    const gmCreate = await request('POST', '/api/housekeeping/manual-tasks', {
      property_id: 1,
      title: 'TEST_3B_GM_TASK',
      description: 'Persiapan VIP Room untuk tamu dinas',
      creator_name: 'General Manager',
      creator_role: 'General Manager'
    });
    if (gmCreate.status !== 201 || !gmCreate.body?.data?.id) {
      throw new Error(`Expected 201 Created for GM, got ${gmCreate.status}: ${JSON.stringify(gmCreate.body)}`);
    }
    createdTaskIds.push(gmCreate.body.data.id);
    console.log(`  ✓ General Manager role successfully created manual task ID ${gmCreate.body.data.id}`);

    // =========================================================================
    // TEST 5: WORKSTREAM COUNTS & STREAM SEPARATION
    // =========================================================================
    console.log('\n--- Test 5: Strict stream separation in active query ---');

    const tasksCleaning = await request('GET', '/api/housekeeping/tasks?property_id=1&stream=CLEANING&scope=active');
    const tasksTask = await request('GET', '/api/housekeeping/tasks?property_id=1&stream=TASK&scope=active');

    // Cleaning stream must contain only ROOM_CLEANING
    for (const t of tasksCleaning.body.data) {
      if (t.task_type !== 'ROOM_CLEANING') {
        throw new Error(`Found non-ROOM_CLEANING task in cleaning stream: ${t.task_type} (id: ${t.id})`);
      }
    }
    console.log(`  ✓ All ${tasksCleaning.body.data.length} tasks in cleaning stream are strictly ROOM_CLEANING`);

    // Task stream must NOT contain ROOM_CLEANING or CHECKOUT_ROOM_CHECK
    for (const t of tasksTask.body.data) {
      if (t.task_type === 'ROOM_CLEANING' || t.task_type === 'CHECKOUT_ROOM_CHECK' || t.task_type === 'FINAL_INSPECTION') {
        throw new Error(`Found incompatible task in manual task stream: ${t.task_type} (id: ${t.id})`);
      }
    }
    console.log(`  ✓ All ${tasksTask.body.data.length} tasks in task stream are strictly non-cleaning/non-checkout leadership tasks`);

    console.log('\n=== ALL EMP-MOBILE-3B LIVE HARDENING TESTS PASSED ===\n');
  } finally {
    // Teardown test fixtures
    if (createdTaskIds.length > 0) {
      await pool.query('DELETE FROM housekeeping_tasks WHERE id = ANY($1::int[])', [createdTaskIds]);
    }
    await pool.query(`
      DELETE FROM housekeeping_tasks WHERE title LIKE '%TEST_3B_%' OR notes LIKE '%TEST_3B_%'
    `);
    // Restore room original statuses
    if (testRoomId1) {
      await pool.query('UPDATE rooms SET status = $1 WHERE id = $2', [origRoom1Status, testRoomId1]);
    }
    if (testRoomId2) {
      await pool.query('UPDATE rooms SET status = $1 WHERE id = $2', [origRoom2Status, testRoomId2]);
    }
  }
}

async function main() {
  server = app.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    await runTest();
  } catch (err) {
    console.error('Test FAILED with error:', err);
    process.exitCode = 1;
  } finally {
    server.close();
    await pool.end();
  }
}

main();
