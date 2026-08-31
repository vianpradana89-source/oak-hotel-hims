const { Pool } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const assert = require('assert');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'oak_hotel_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function runTest() {
  console.log('=== RUNNING TEST: Maintenance Finding & Room Readiness Resolution Workflow ===');
  const client = await pool.connect();
  let testRoomId = null;
  let testFindingId = null;
  const propertyId = 1;

  try {
    // 1. Create a clean test room
    const roomRes = await client.query(
      `INSERT INTO rooms (property_id, room_number, name, status, created_at, updated_at)
       VALUES ($1, 'TEST-MNT-999', 'Deluxe Test Maintenance', 'VACANT_CLEAN', NOW(), NOW())
       RETURNING id, room_number`,
      [propertyId]
    );
    testRoomId = roomRes.rows[0].id;
    console.log(`[PASS] Created test room: ${roomRes.rows[0].room_number} (ID: ${testRoomId})`);

    // 2. Insert an active blocking finding for this room (simulating HK Mobile input)
    const findingRes = await client.query(
      `INSERT INTO housekeeping_task_findings (
        property_id, room_id, room_number, finding_type_code, finding_type_label,
        severity, notes, block_room_ready, status, reported_by_name, reported_by_role,
        reported_at, created_at, updated_at
      ) VALUES (
        $1, $2, 'TEST-MNT-999', 'DAMAGE', 'Kerusakan Elektronik',
        'HIGH', 'tv rusak di kamar test', TRUE, 'OPEN', 'Mobile HK Crew Budi', 'Housekeeping Staff',
        NOW(), NOW(), NOW()
      ) RETURNING id`,
      [propertyId, testRoomId]
    );
    testFindingId = findingRes.rows[0].id;
    console.log(`[PASS] Created active blocking finding ID: ${testFindingId}`);

    // 3. Test getHousekeepingDailyOperations calculates maintenance >= 1
    const { getHousekeepingDailyOperations, getAllFindings, resolveFinding } = require('../dist/domains/housekeeping/housekeepingService');
    const todayStr = new Date().toISOString().slice(0, 10);
    const dailyOps = await getHousekeepingDailyOperations(client, propertyId, todayStr);
    assert(dailyOps.metrics.maintenance >= 1, `Expected maintenance count >= 1, got ${dailyOps.metrics.maintenance}`);
    console.log(`[PASS] getHousekeepingDailyOperations returned maintenance metric: ${dailyOps.metrics.maintenance}`);

    // 4. Test getAllFindings returns this open finding
    const allFindings = await getAllFindings(client, propertyId, 'OPEN');
    const found = allFindings.find(f => Number(f.id) === Number(testFindingId));
    assert(found, 'Expected finding to be found in getAllFindings');
    assert.strictEqual(found.room_number, 'TEST-MNT-999');
    assert.strictEqual(found.notes, 'tv rusak di kamar test');
    console.log(`[PASS] getAllFindings successfully returned finding with room details`);

    // 5. Test evaluateRoomReadiness blocks room check-in
    const { evaluateRoomReadiness } = require('../dist/domains/turnover/turnoverService');
    const readinessBefore = await evaluateRoomReadiness(client, testRoomId, 999999);
    assert.strictEqual(readinessBefore.is_ready, false);
    assert.strictEqual(readinessBefore.reason_code, 'BLOCKING_FINDING_ACTIVE');
    assert(readinessBefore.reason_message.includes('tv rusak'));
    console.log(`[PASS] evaluateRoomReadiness correctly blocked check-in: "${readinessBefore.reason_message}"`);

    // 6. Test resolveFinding with ready_room: true
    const resolved = await resolveFinding(
      client,
      propertyId,
      testFindingId,
      {
        resolution_note: 'TV telah diganti unit baru dan berfungsi normal.',
        ready_room: true
      },
      { id: 1, name: 'Resepsionis Siti', role: 'Front Office' }
    );
    assert.strictEqual(resolved.status, 'RESOLVED');
    assert.strictEqual(resolved.resolved_by_name, 'Resepsionis Siti');
    console.log(`[PASS] resolveFinding executed successfully`);

    // 7. Verify room status was updated to VACANT_CLEAN
    const roomCheckRes = await client.query('SELECT status FROM rooms WHERE id = $1', [testRoomId]);
    assert.strictEqual(roomCheckRes.rows[0].status, 'VACANT_CLEAN');
    console.log(`[PASS] Room status automatically updated to VACANT_CLEAN`);

    // 8. Verify evaluateRoomReadiness now returns is_ready: true
    const readinessAfter = await evaluateRoomReadiness(client, testRoomId, 999999);
    assert.strictEqual(readinessAfter.is_ready, true);
    assert.strictEqual(readinessAfter.turnover_state, 'READY');
    console.log(`[PASS] evaluateRoomReadiness is now READY and unblocked for receptionist check-in!`);

    console.log('=== ALL TESTS PASSED SUCCESSFULLY! ===');
  } finally {
    // Cleanup
    if (testFindingId) {
      await client.query('DELETE FROM housekeeping_task_findings WHERE id = $1', [testFindingId]);
    }
    if (testRoomId) {
      await client.query('DELETE FROM rooms WHERE id = $1', [testRoomId]);
    }
    client.release();
    await pool.end();
  }
}

runTest().catch((err) => {
  console.error('[FAIL] Test failed with error:', err);
  process.exit(1);
});
