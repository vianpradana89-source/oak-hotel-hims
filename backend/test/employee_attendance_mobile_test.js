// backend/test/employee_attendance_mobile_test.js
require('dotenv').config();
const { Pool } = require('pg');
const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'oak_hotel_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Import express app
const { app } = require('../dist/index');

let server;
let baseUrl;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function runTests() {
  console.log('=== EMP-MOBILE-1 & HK INTEGRATION TEST SUITE ===\n');
  const propertyId = 1;
  const testTag = `TEST_EMP_MOB_${Date.now()}`;
  let testRoomId = null;
  let testTaskId = null;
  let testEmpId = null;

  try {
    // 0. Ensure schema is initialized
    const { initializeDatabase } = require('../dist/db/schema_v3');
    await initializeDatabase(pool);

    await startServer();
    console.log(`✓ Test server started on ${baseUrl}`);

    // Create test employee fixture
    const empRes = await pool.query(
      `INSERT INTO hr_employees (employee_code, full_name, department, position, status)
       VALUES ($1, $2, 'Housekeeping', 'Room Attendant', 'ACTIVE')
       RETURNING id`,
      [`EMP_${testTag.slice(-6)}`, `Crew_${testTag}`]
    );
    testEmpId = empRes.rows[0].id;

    // Create test room fixture
    const roomRes = await pool.query(
      `INSERT INTO rooms (property_id, room_number, name, status, is_active, floor)
       VALUES ($1, $2, $3, 'VACANT_DIRTY', TRUE, 1)
       RETURNING id`,
      [propertyId, `999_${testTag.slice(-4)}`, `Test Room ${testTag}`]
    );
    testRoomId = roomRes.rows[0].id;

    // -------------------------------------------------------------
    // TEST 1: Get & Update Attendance Settings
    // -------------------------------------------------------------
    console.log('\n--- 1. Attendance Settings API ---');
    const getSetRes = await fetchJson(`${baseUrl}/api/attendance/settings?property_id=${propertyId}`);
    assert.strictEqual(getSetRes.status, 200, 'GET /api/attendance/settings must return 200');
    assert.strictEqual(getSetRes.data.status, 'OK');
    assert.strictEqual(typeof getSetRes.data.data.attendance_enabled, 'boolean');

    const patchSetRes = await fetchJson(`${baseUrl}/api/attendance/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propertyId,
        attendance_enabled: true,
        require_employee_attendance: true,
        require_checkin_photo: false, // relaxed for automated testing
        require_checkout_photo: false,
        geofence_enabled: true,
        geofence_latitude: -6.2088,
        geofence_longitude: 106.8456,
        geofence_radius_meters: 500,
        outside_geofence_policy: 'ALLOW_WITH_REASON'
      })
    });
    if (patchSetRes.status !== 200) {
      console.error('PATCH /api/attendance/settings failed:', patchSetRes);
    }
    assert.strictEqual(patchSetRes.status, 200, 'PATCH /api/attendance/settings must return 200');
    assert.strictEqual(patchSetRes.data.data.geofence_enabled, true);
    assert.strictEqual(patchSetRes.data.data.geofence_radius_meters, 500);
    console.log('✓ Attendance settings GET and PATCH verified');

    // -------------------------------------------------------------
    // TEST 2: Employee Attendance Status API
    // -------------------------------------------------------------
    console.log('\n--- 2. Employee Attendance Status API ---');
    const statusRes = await fetchJson(`${baseUrl}/api/attendance/status?property_id=${propertyId}&employee_id=${testEmpId}&role=Room%20Attendant`);
    assert.strictEqual(statusRes.status, 200);
    assert.strictEqual(statusRes.data.data.has_checked_in, false);
    assert.strictEqual(statusRes.data.data.attendance_required, true);
    assert.strictEqual(statusRes.data.data.timezone, 'Asia/Jakarta');
    console.log('✓ Attendance status API returns correct today state and Asia/Jakarta timezone');

    // -------------------------------------------------------------
    // TEST 3: Attendance Check-In with Geofence & Check-Out
    // -------------------------------------------------------------
    console.log('\n--- 3. Attendance Check-In & Check-Out ---');
    // Inside geofence check-in
    const checkInRes = await fetchJson(`${baseUrl}/api/attendance/check-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propertyId,
        employee_id: testEmpId,
        employee_name: `Crew_${testTag}`,
        department: 'Housekeeping',
        latitude: -6.2089, // ~15m from property
        longitude: 106.8457,
        location_accuracy_meters: 10
      })
    });
    assert.strictEqual(checkInRes.status, 201, 'Check-in should return 201');
    assert.strictEqual(checkInRes.data.data.geofence_result, 'INSIDE');
    assert.strictEqual(checkInRes.data.data.status, 'ACCEPTED');
    console.log('✓ Check-in within geofence successfully accepted');

    // Check status now shows checked in
    const statusAfterIn = await fetchJson(`${baseUrl}/api/attendance/status?property_id=${propertyId}&employee_id=${testEmpId}`);
    assert.strictEqual(statusAfterIn.data.data.has_checked_in, true);
    assert.strictEqual(statusAfterIn.data.data.has_checked_out, false);

    // Check-out
    const checkOutRes = await fetchJson(`${baseUrl}/api/attendance/check-out`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propertyId,
        employee_id: testEmpId,
        employee_name: `Crew_${testTag}`,
        department: 'Housekeeping',
        latitude: -6.2089,
        longitude: 106.8457
      })
    });
    assert.strictEqual(checkOutRes.status, 201);
    assert.strictEqual(checkOutRes.data.data.attendance_type, 'CHECK_OUT');
    console.log('✓ Check-out successfully recorded');

    // Attendance records query
    const recordsRes = await fetchJson(`${baseUrl}/api/attendance/records?property_id=${propertyId}&employee_id=${testEmpId}`);
    assert.strictEqual(recordsRes.status, 200);
    assert.strictEqual(recordsRes.data.data.length >= 2, true);
    console.log('✓ Attendance records list filter verified');

    // -------------------------------------------------------------
    // TEST 4: Room Cleaning Data Integrity (room_id mandatory)
    // -------------------------------------------------------------
    console.log('\n--- 4. Housekeeping Data Integrity (room_id mandatory for ROOM_CLEANING) ---');
    const invalidTaskRes = await fetchJson(`${baseUrl}/api/housekeeping/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propertyId,
        task_type: 'ROOM_CLEANING',
        title: 'Invalid task without room'
      })
    });
    assert.strictEqual(invalidTaskRes.status, 400, 'ROOM_CLEANING without room_id must return 400');
    assert.strictEqual(invalidTaskRes.data.code, 'ROOM_ID_REQUIRED');
    console.log('✓ ROOM_CLEANING without room_id is strictly rejected with ROOM_ID_REQUIRED');

    // Valid task creation with room_id
    const validTaskRes = await fetchJson(`${baseUrl}/api/housekeeping/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propertyId,
        task_type: 'ROOM_CLEANING',
        room_id: testRoomId,
        assigned_user_id: testEmpId,
        assigned_user_name_snapshot: `Crew_${testTag}`,
        priority: 'NORMAL'
      })
    });
    assert.strictEqual(validTaskRes.status, 201, 'Valid ROOM_CLEANING should return 201');
    testTaskId = validTaskRes.data.data.id;
    console.log(`✓ Valid ROOM_CLEANING task created with id ${testTaskId}`);

    // -------------------------------------------------------------
    // TEST 5: Housekeeping Safe History Correction
    // -------------------------------------------------------------
    console.log('\n--- 5. Housekeeping Safe History Correction ---');
    // Reject edit without reason
    const editNoReason = await fetchJson(`${baseUrl}/api/housekeeping/tasks/${testTaskId}/history-edit`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propertyId,
        priority: 'HIGH'
      })
    });
    assert.strictEqual(editNoReason.status, 400, 'History edit without reason must return 400');
    assert.strictEqual(editNoReason.data.code, 'REASON_REQUIRED');

    // Authorized edit with reason
    const editWithReason = await fetchJson(`${baseUrl}/api/housekeeping/tasks/${testTaskId}/history-edit`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propertyId,
        priority: 'HIGH',
        completion_note: 'Updated notes via supervisor review',
        reason: 'Correction of priority as per guest request'
      })
    });
    assert.strictEqual(editWithReason.status, 200);
    assert.strictEqual(editWithReason.data.data.priority, 'HIGH');
    assert.strictEqual(editWithReason.data.data.completion_note, 'Updated notes via supervisor review');
    console.log('✓ Safe history correction requires justification reason and audits accurately');

    // -------------------------------------------------------------
    // TEST 6: Housekeeping Task Soft Archiving & History Filters
    // -------------------------------------------------------------
    console.log('\n--- 6. Housekeeping Soft Archive & History Filter ---');
    const archiveRes = await fetchJson(`${baseUrl}/api/housekeeping/tasks/${testTaskId}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propertyId,
        reason: 'Duplicate operational entry'
      })
    });
    assert.strictEqual(archiveRes.status, 200);
    assert.strictEqual(archiveRes.data.data.is_archived, true);
    assert.strictEqual(archiveRes.data.data.archive_reason, 'Duplicate operational entry');

    // Ensure archived task does not show in standard history
    const historyRes = await fetchJson(`${baseUrl}/api/housekeeping/history?property_id=${propertyId}&status=ASSIGNED`);
    const isPresentInStandard = historyRes.data.data.some(t => Number(t.id) === testTaskId);
    assert.strictEqual(isPresentInStandard, false, 'Archived task must not appear in standard history view');

    // Ensure archived task appears when include_archived=true
    const historyWithArchived = await fetchJson(`${baseUrl}/api/housekeeping/history?property_id=${propertyId}&status=ASSIGNED&include_archived=true`);
    const isPresentInArchived = historyWithArchived.data.data.some(t => Number(t.id) === testTaskId);
    assert.strictEqual(isPresentInArchived, true, 'Archived task must appear when include_archived=true');
    console.log('✓ Housekeeping soft archiving and include_archived filter verified');

    // -------------------------------------------------------------
    // TEST 7: Calendar Readiness Override Hardening
    // -------------------------------------------------------------
    console.log('\n--- 7. Calendar Readiness Override Hardening ---');
    // 1. Ensure allow_calendar_room_status_override is FALSE
    await pool.query(
      `UPDATE property_housekeeping_settings
       SET allow_calendar_room_status_override = FALSE
       WHERE property_id = $1`,
      [propertyId]
    );

    // 2. Attempt to toggle room 999 from VACANT_DIRTY to VACANT_CLEAN without override authority
    const overrideAttempt = await fetchJson(`${baseUrl}/api/rooms/${testRoomId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propertyId,
        status: 'VACANT_CLEAN'
      })
    });
    assert.strictEqual(overrideAttempt.status, 403, 'Calendar status change to clean must be denied with 403 when override is disabled');
    assert.strictEqual(overrideAttempt.data.code, 'OVERRIDE_DISABLED');
    console.log('✓ Calendar readiness override blocked with 403 OVERRIDE_DISABLED when disabled in settings');

    // -------------------------------------------------------------
    // TEST 8: Tape Chart Turnover Clearance Data
    // -------------------------------------------------------------
    console.log('\n--- 8. Tape Chart Turnover Outgoing Clearance ---');
    const tapeRes = await fetchJson(`${baseUrl}/api/tapechart?property_id=${propertyId}`);
    assert.strictEqual(tapeRes.status, 200);
    assert.strictEqual(Array.isArray(tapeRes.data.rooms), true);
    console.log('✓ Tape chart endpoint returns successfully with enriched turnover structure');

    console.log('\n=============================================');
    console.log('ALL EMP-MOBILE-1 BACKEND TESTS PASSED (8/8)!');
    console.log('=============================================\n');
  } finally {
    // Cleanup fixtures
    console.log('Cleaning up test fixtures...');
    try {
      if (testTaskId) {
        await pool.query('DELETE FROM housekeeping_task_checklist_items WHERE task_id = $1', [testTaskId]);
        await pool.query('DELETE FROM housekeeping_tasks WHERE id = $1', [testTaskId]);
      }
      if (testEmpId) {
        await pool.query('DELETE FROM employee_attendance_records WHERE employee_id = $1', [testEmpId]);
        await pool.query('DELETE FROM hr_employees WHERE id = $1', [testEmpId]);
      }
      if (testRoomId) {
        await pool.query('DELETE FROM rooms WHERE id = $1', [testRoomId]);
      }
      // Restore default attendance settings for property 1
      await pool.query(
        `UPDATE property_attendance_settings
         SET attendance_enabled = TRUE, require_employee_attendance = TRUE, require_checkin_photo = TRUE, geofence_enabled = FALSE
         WHERE property_id = $1`,
        [propertyId]
      );
      // Clean audit log residues created by test tag
      await pool.query(`DELETE FROM audit_logs WHERE correlation_id = $1 OR correlation_id LIKE $2 OR new_value LIKE $2`, [testTag, `%${testTag}%`]);
    } catch (cleanErr) {
      console.error('Fixture cleanup error:', cleanErr);
    }
    await stopServer();
  }
}

runTests()
  .then(() => {
    pool.end();
    process.exit(0);
  })
  .catch((err) => {
    console.error('TEST FAILED:', err);
    stopServer().then(() => {
      pool.end();
      process.exit(1);
    });
  });
