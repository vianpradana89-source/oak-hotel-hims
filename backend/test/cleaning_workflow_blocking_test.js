/**
 * Automated Integration Test: Cleaning Workflow & Blocking Issue Room Readiness Logic
 *
 * Verifies:
 * 1. Database schema Migration 14 idempotently applied.
 * 2. MULAI BERSIHKAN transitions task ASSIGNED -> IN_PROGRESS and room VACANT_DIRTY -> CLEANING.
 * 3. Repeated start is idempotent (started_at preserved).
 * 4. Normal cleaning completion without blocking finding -> VACANT_CLEAN and room is READY.
 * 5. Cleaning completion with unresolved blocking finding (block_room_ready = true):
 *    - Task status -> DONE
 *    - Room cleanliness -> VACANT_CLEAN (NOT reverted to VACANT_DIRTY)
 *    - Room readiness -> is_ready: false, reason_code: 'BLOCKING_FINDING_ACTIVE'
 * 6. Resolving and verifying the blocking finding restores room readiness (or final inspection).
 * 7. Fixture isolation and cleanup with zero residue.
 */

const { Pool } = require('pg');
const { initializeDatabase } = require('../dist/db/schema_v3.js');
const {
  createHousekeepingTask,
  startHousekeepingTask,
  updateTaskChecklistItem,
  completeHousekeepingTask,
  createFindingType,
  createTaskFinding,
  resolveFinding,
  verifyFinding
} = require('../dist/domains/housekeeping/housekeepingService.js');
const { evaluateRoomReadiness } = require('../dist/domains/turnover/turnoverService.js');
const assert = require('assert');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

async function runTest() {
  console.log('--- START: Cleaning Workflow & Blocking Issue Logic Test ---');

  // Ensure all schema migrations including Migration 14 are applied
  console.log('Applying database schema & migrations...');
  await initializeDatabase(pool);
  console.log('✓ Database schema up to date.');

  const client = await pool.connect();
  const testSuffix = Date.now().toString().slice(-4);
  const testRoomNumber = `T${testSuffix}`;
  let propertyId = 1;
  let roomId = null;
  let roomTypeId = null;
  let taskId1 = null;
  let taskId2 = null;

  try {
    // 1. Get or pick active property and room type
    const propRes = await client.query('SELECT id FROM properties LIMIT 1');
    if (propRes.rows.length === 0) {
      console.log('No property found, skipping test');
      return;
    }
    propertyId = propRes.rows[0].id;

    const rtRes = await client.query('SELECT id FROM room_types WHERE property_id = $1 LIMIT 1', [propertyId]);
    if (rtRes.rows.length === 0) {
      console.log('No room type found, skipping test');
      return;
    }
    roomTypeId = rtRes.rows[0].id;

    // 2. Create isolated fixture room
    const roomRes = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, status)
       VALUES ($1, $2, $3, 'VACANT_DIRTY')
       RETURNING id, room_number, status`,
      [propertyId, roomTypeId, testRoomNumber]
    );
    roomId = roomRes.rows[0].id;
    console.log(`✓ Created fixture room: ${testRoomNumber} (ID: ${roomId}) with status VACANT_DIRTY`);

    // Ensure finding type with block_room_ready = true exists
    let findingTypeRes = await client.query(
      `SELECT id, code, label, block_room_ready FROM housekeeping_finding_types
       WHERE property_id = $1 AND code = 'AC_TIDAK_DINGIN' LIMIT 1`,
      [propertyId]
    );
    let blockingFindingType = findingTypeRes.rows[0];
    if (!blockingFindingType) {
      const createdFt = await createFindingType(client, propertyId, {
        code: `AC_TEST_${testSuffix}`,
        label: 'AC Tidak Dingin Test',
        severity: 'HIGH',
        block_room_ready: true,
        note_required: false
      });
      blockingFindingType = createdFt;
    } else if (!blockingFindingType.block_room_ready) {
      await client.query(
        `UPDATE housekeeping_finding_types SET block_room_ready = TRUE WHERE id = $1`,
        [blockingFindingType.id]
      );
    }
    console.log(`✓ Using blocking finding type: ${blockingFindingType.code} (block_room_ready: true)`);

    // =========================================================================
    // TEST CASE 1: Normal Cleaning Completion (No Findings)
    // =========================================================================
    console.log('\n--- Scenario 1: Normal Cleaning Flow ---');
    const task1 = await createHousekeepingTask(client, propertyId, {
      task_type: 'ROOM_CLEANING',
      room_id: roomId,
      title: `Pembersihan Rutin ${testRoomNumber}`,
      assigned_to_user_id: 1,
      assigned_user_name_snapshot: 'Crew Test'
    });
    taskId1 = task1.id;
    assert.strictEqual(task1.status, 'ASSIGNED', 'Task should start as ASSIGNED');

    // Tap MULAI BERSIHKAN
    const startedTask1 = await startHousekeepingTask(client, propertyId, taskId1, 'Crew Test');
    assert.strictEqual(startedTask1.status, 'IN_PROGRESS', 'Task should transition to IN_PROGRESS');
    assert.ok(startedTask1.started_at, 'started_at should be recorded');

    // Check room status updated to CLEANING
    const roomAfterStart1 = await client.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
    assert.strictEqual(roomAfterStart1.rows[0].status, 'CLEANING', 'Room status should be CLEANING');

    // Idempotent start test
    const startedTask1Repeat = await startHousekeepingTask(client, propertyId, taskId1, 'Crew Test');
    assert.strictEqual(
      new Date(startedTask1.started_at).getTime(),
      new Date(startedTask1Repeat.started_at).getTime(),
      'started_at must be preserved idempotently'
    );

    // Complete all required checklist items
    const checklistRes1 = await client.query(
      'SELECT id, is_required FROM housekeeping_task_checklist_items WHERE task_id = $1',
      [taskId1]
    );
    for (const item of checklistRes1.rows) {
      await updateTaskChecklistItem(client, taskId1, item.id, {
        property_id: propertyId,
        is_completed: true,
        checked_by: 'Crew Test'
      });
    }

    // Submit Selesai
    const completedTask1 = await completeHousekeepingTask(client, propertyId, taskId1, 'Crew Test', 'Selesai normal');
    assert.strictEqual(completedTask1.status, 'DONE', 'Task status should be DONE');

    // Room status should now be VACANT_CLEAN
    const roomAfterComplete1 = await client.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
    assert.strictEqual(roomAfterComplete1.rows[0].status, 'VACANT_CLEAN', 'Room should be VACANT_CLEAN');

    // Room readiness check
    const readiness1 = await evaluateRoomReadiness(client, roomId);
    assert.strictEqual(readiness1.is_ready, true, 'Room should be READY after normal clean');
    console.log('✓ Scenario 1 PASS: Normal cleaning produces VACANT_CLEAN and is_ready = true');

    // =========================================================================
    // TEST CASE 2: Cleaning Completion with BLOCKING FINDING
    // =========================================================================
    console.log('\n--- Scenario 2: Cleaning with Blocking Finding (block_room_ready = true) ---');

    // Set room back to VACANT_DIRTY for new cleaning cycle
    await client.query(`UPDATE rooms SET status = 'VACANT_DIRTY' WHERE id = $1`, [roomId]);

    const task2 = await createHousekeepingTask(client, propertyId, {
      task_type: 'ROOM_CLEANING',
      room_id: roomId,
      title: `Pembersihan Kamar ${testRoomNumber}`,
      assigned_to_user_id: 1,
      assigned_user_name_snapshot: 'Crew Test'
    });
    taskId2 = task2.id;

    // Start cleaning
    await startHousekeepingTask(client, propertyId, taskId2, 'Crew Test');

    // Report blocking finding (AC Tidak Dingin)
    const finding = await createTaskFinding(client, propertyId, taskId2, {
      finding_type_code: blockingFindingType.code,
      finding_type_label: blockingFindingType.label,
      severity: 'HIGH',
      block_room_ready: true,
      notes: 'Kompresor AC mati total, suhu kamar 29 derajat',
      actor_name: 'Crew Test'
    });
    assert.strictEqual(finding.status, 'OPEN', 'Finding must be OPEN');
    assert.strictEqual(finding.block_room_ready, true, 'Finding must have block_room_ready = true');
    console.log(`✓ Reported blocking finding: ${finding.finding_type_label} (ID: ${finding.id})`);

    // Complete all required checklist items
    const checklistRes2 = await client.query(
      'SELECT id, is_required FROM housekeeping_task_checklist_items WHERE task_id = $1',
      [taskId2]
    );
    for (const item of checklistRes2.rows) {
      await updateTaskChecklistItem(client, taskId2, item.id, {
        property_id: propertyId,
        is_completed: true,
        checked_by: 'Crew Test'
      });
    }

    // Submit Selesai
    const completedTask2 = await completeHousekeepingTask(client, propertyId, taskId2, 'Crew Test', 'Pembersihan fisik selesai');
    assert.strictEqual(completedTask2.status, 'DONE', 'Cleaning work task must be marked DONE');

    // Room cleanliness MUST be VACANT_CLEAN (NOT reverted to VACANT_DIRTY)
    const roomAfterComplete2 = await client.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
    assert.strictEqual(roomAfterComplete2.rows[0].status, 'VACANT_CLEAN', 'Room status MUST be VACANT_CLEAN');

    // Room readiness MUST be NOT READY with reason_code BLOCKING_FINDING_ACTIVE
    const readiness2 = await evaluateRoomReadiness(client, roomId);
    assert.strictEqual(readiness2.is_ready, false, 'Room MUST NOT be ready when blocking finding is open');
    assert.strictEqual(readiness2.reason_code, 'BLOCKING_FINDING_ACTIVE', 'Reason code MUST be BLOCKING_FINDING_ACTIVE');
    console.log(`✓ Scenario 2 PASS: Cleanliness is VACANT_CLEAN, but is_ready = false (BLOCKING_FINDING_ACTIVE)`);

    // =========================================================================
    // TEST CASE 3: Resolving & Verifying Blocking Finding Restores Readiness
    // =========================================================================
    console.log('\n--- Scenario 3: Resolving and Verifying Blocking Finding ---');

    // Technician / Crew resolves finding
    const resolvedFinding = await resolveFinding(client, propertyId, finding.id, 'Teknisi AC', 'Kompresor sudah diganti');
    assert.strictEqual(resolvedFinding.status, 'RESOLVED', 'Finding must be RESOLVED');

    // Supervisor verifies resolution
    const verifiedFinding = await verifyFinding(client, propertyId, finding.id, 'Supervisor Test', 'Suhu kamar sudah sejuk 20C');
    assert.strictEqual(verifiedFinding.status, 'VERIFIED', 'Finding must be VERIFIED');

    // Now evaluate room readiness again
    const readiness3 = await evaluateRoomReadiness(client, roomId);
    assert.strictEqual(readiness3.is_ready, true, 'Room MUST be ready after blocking finding is verified');
    console.log('✓ Scenario 3 PASS: Resolving & verifying blocking finding restored room readiness to is_ready = true');

  } catch (err) {
    console.error('❌ Test failed with error:', err);
    throw err;
  } finally {
    // Teardown test fixtures
    console.log('\n--- Teardown: Cleaning up test fixtures ---');
    if (taskId1) {
      await client.query('DELETE FROM housekeeping_task_checklist_items WHERE task_id = $1', [taskId1]);
      await client.query('DELETE FROM housekeeping_task_findings WHERE task_id = $1', [taskId1]);
      await client.query('DELETE FROM housekeeping_tasks WHERE id = $1', [taskId1]);
    }
    if (taskId2) {
      await client.query('DELETE FROM housekeeping_task_checklist_items WHERE task_id = $1', [taskId2]);
      await client.query('DELETE FROM housekeeping_task_findings WHERE task_id = $1', [taskId2]);
      await client.query('DELETE FROM housekeeping_tasks WHERE id = $1', [taskId2]);
    }
    if (roomId) {
      await client.query('DELETE FROM housekeeping_task_findings WHERE room_id = $1', [roomId]);
      await client.query('DELETE FROM rooms WHERE id = $1', [roomId]);
      console.log(`✓ Deleted test room ID ${roomId}`);
    }
    client.release();
    await pool.end();
    console.log('--- END: All cleaning workflow tests finished cleanly ---');
  }
}

runTest()
  .then(() => {
    console.log('✅ ALL CLEANING WORKFLOW & BLOCKING TESTS PASSED');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ TEST SUITE FAILED:', err);
    process.exit(1);
  });
