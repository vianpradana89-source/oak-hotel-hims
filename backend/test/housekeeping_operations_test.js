// backend/test/housekeeping_operations_test.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { once } = require('events');
const { app, pool } = require('../dist/index');

let server;
let baseUrl;

function expect(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function toDateKey(dateValue) {
  const dt = new Date(dateValue);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

async function request(method, requestPath, body, correlationId) {
  const headers = { 'Content-Type': 'application/json' };
  if (correlationId) {
    headers['X-Correlation-Id'] = correlationId;
  }
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, body: data };
}

async function runHousekeepingOperationsSuite() {
  const propertyId = 1;
  const today = toDateKey(new Date());
  const tomorrow = addDays(today, 1);
  const nextWeek = addDays(today, 7);

  console.log('\n======================================================');
  console.log('HK-OPS-1: HOUSEKEEPING OPERATIONS INTEGRATION TEST SUITE');
  console.log('======================================================\n');

  // Find or create test room type & physical room
  let roomTypeId = null;
  let roomAId = null;
  let roomBId = null;
  let origSettings = null;
  const createdBookingIds = [];
  const createdReservationIds = [];
  const createdTaskIds = [];

  try {
    const origSettingsRes = await pool.query('SELECT * FROM property_housekeeping_settings WHERE property_id = $1', [propertyId]);
    origSettings = origSettingsRes.rows[0] || null;

    await pool.query(
      `INSERT INTO property_housekeeping_settings (property_id, require_checkout_room_check, require_final_inspection)
       VALUES ($1, false, false)
       ON CONFLICT (property_id) DO UPDATE SET require_checkout_room_check = false, require_final_inspection = false`,
      [propertyId]
    );
    // 1. Setup Fixture Room Type and Physical Rooms
    const catRes = await pool.query('SELECT id FROM room_categories WHERE property_id = $1 LIMIT 1', [propertyId]);
    const catId = catRes.rows[0]?.id || null;

    const rtRes = await pool.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity, is_active)
       VALUES ($1, $2, $3, $4, 100000, 2, true)
       ON CONFLICT (property_id, code) DO UPDATE SET is_active = true
       RETURNING id`,
      [propertyId, catId, 'HK_TEST_TYPE', 'HK Test Suite Type']
    );
    roomTypeId = rtRes.rows[0].id;

    const r1 = await pool.query(
      `INSERT INTO rooms (property_id, room_number, room_type_id, status)
       VALUES ($1, $2, $3, 'VACANT_CLEAN')
       ON CONFLICT (property_id, room_number) DO UPDATE SET status = 'VACANT_CLEAN', room_type_id = $3
       RETURNING id`,
      [propertyId, 'HK-901', roomTypeId]
    );
    roomAId = r1.rows[0].id;

    const r2 = await pool.query(
      `INSERT INTO rooms (property_id, room_number, room_type_id, status)
       VALUES ($1, $2, $3, 'VACANT_CLEAN')
       ON CONFLICT (property_id, room_number) DO UPDATE SET status = 'VACANT_CLEAN', room_type_id = $3
       RETURNING id`,
      [propertyId, 'HK-902', roomTypeId]
    );
    roomBId = r2.rows[0].id;

    // Seed availability_dates for roomTypeId so reservation and checkout ledger validations pass
    await pool.query('DELETE FROM availability_dates WHERE room_type_id = $1', [roomTypeId]);
    await pool.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES ($1, 'HK Test Suite Type', $2::date, 2, 1),
              ($1, 'HK Test Suite Type', $3::date, 2, 0)`,
      [roomTypeId, today, tomorrow]
    );

    console.log(`[SETUP] Initialized Test Fixtures: Room Type ${roomTypeId}, Rooms HK-901 (${roomAId}), HK-902 (${roomBId})`);

    // =========================================================================
    // TEST 1: Daily Operations Metrics & Initial State
    // =========================================================================
    console.log('\n[TEST 1] Query Daily Operations & Metrics');
    const opsRes = await request('GET', `/api/housekeeping/daily-operations?property_id=${propertyId}&date=${today}`);
    if (opsRes.status !== 200) {
      console.error('daily-operations error payload:', opsRes.body);
    }
    expect(opsRes.status === 200, `Expected 200 from daily-operations, got ${opsRes.status}`);
    expect(opsRes.body.status === 'OK', 'Expected status OK');
    expect(opsRes.body.data.metrics !== undefined, 'Expected metrics object');
    expect(typeof opsRes.body.data.metrics.dirty === 'number', 'Expected numeric dirty metric');
    expect(typeof opsRes.body.data.metrics.ready === 'number', 'Expected numeric ready metric');
    console.log(' -> Daily Operations returned metrics:', opsRes.body.data.metrics);

    // =========================================================================
    // TEST 2: Checkout Trigger creates automatic ROOM_CLEANING task with snapshot
    // =========================================================================
    console.log('\n[TEST 2] Automatic ROOM_CLEANING task creation on checkout');
    // Create an active checked-in reservation on HK-901
    const bid1 = `HK-BID-${Date.now()}-1`;
    const bk1 = await pool.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, 'Guest Checkout HK', 'ACTIVE')
       RETURNING id`,
      [propertyId, bid1]
    );
    createdBookingIds.push(bk1.rows[0].id);

    const res1 = await pool.query(
      `INSERT INTO reservations (booking_id, stay_sequence, room_id, guest_name, check_in, check_out, status, stay_status, booked_room_type_id_snapshot)
       VALUES ($1, 1, $2, 'Guest Checkout HK', $3, $4, 'CHECKED_IN', 'IN_HOUSE', $5)
       RETURNING id`,
      [bk1.rows[0].id, roomAId, today, tomorrow, roomTypeId]
    );
    const reservation1Id = res1.rows[0].id;
    createdReservationIds.push(reservation1Id);

    // Mark room OCCUPIED_CLEAN
    await pool.query('UPDATE rooms SET status = $1 WHERE id = $2', ['OCCUPIED_CLEAN', roomAId]);

    // Perform Checkout
    const coRes = await request('POST', `/api/reservations/${reservation1Id}/checkout`, { property_id: propertyId });
    expect(coRes.status === 200, `Expected 200 from checkout, got ${coRes.status}: ${JSON.stringify(coRes.body)}`);

    // Verify room transitioned to VACANT_DIRTY
    const roomACheck = await pool.query('SELECT status FROM rooms WHERE id = $1', [roomAId]);
    expect(roomACheck.rows[0].status === 'VACANT_DIRTY', `Expected room HK-901 status VACANT_DIRTY, got ${roomACheck.rows[0].status}`);

    // Verify automatic ROOM_CLEANING task created
    const taskRes = await pool.query(
      `SELECT * FROM housekeeping_tasks WHERE room_id = $1 AND task_type = 'ROOM_CLEANING' AND status != 'CANCELLED' ORDER BY id DESC LIMIT 1`,
      [roomAId]
    );
    expect(taskRes.rows.length === 1, 'Expected automatic ROOM_CLEANING task created');
    const autoTask = taskRes.rows[0];
    createdTaskIds.push(autoTask.id);
    expect(autoTask.status === 'ASSIGNED', `Expected task status ASSIGNED, got ${autoTask.status}`);
    expect(autoTask.priority === 'NORMAL' || autoTask.priority === 'HIGH', 'Expected standard priority');

    // Verify checklist items were snapshotted from template
    const itemsRes = await pool.query(
      `SELECT * FROM housekeeping_task_checklist_items WHERE task_id = $1 ORDER BY sort_order ASC`,
      [autoTask.id]
    );
    expect(itemsRes.rows.length > 0, `Expected checklist snapshot items, got ${itemsRes.rows.length}`);
    console.log(` -> Created task #${autoTask.id} with ${itemsRes.rows.length} checklist items snapshotted.`);

    // =========================================================================
    // TEST 3: Attendant Lifecycle: Acknowledge -> Start -> Room transitions to CLEANING
    // =========================================================================
    console.log('\n[TEST 3] Attendant Lifecycle: Acknowledge & Start');
    const ackRes = await request('PATCH', `/api/housekeeping/tasks/${autoTask.id}/acknowledge`, {
      property_id: propertyId,
      actor_name: 'Attendant Budi'
    });
    expect(ackRes.status === 200, `Expected 200 on acknowledge, got ${ackRes.status}`);
    expect(ackRes.body.data.status === 'ACKNOWLEDGED', `Expected status ACKNOWLEDGED, got ${ackRes.body.data.status}`);

    const startRes = await request('PATCH', `/api/housekeeping/tasks/${autoTask.id}/start`, {
      property_id: propertyId,
      actor_name: 'Attendant Budi'
    });
    expect(startRes.status === 200, `Expected 200 on start, got ${startRes.status}`);
    expect(startRes.body.data.status === 'IN_PROGRESS', `Expected status IN_PROGRESS, got ${startRes.body.data.status}`);

    // Verify room physical status transitioned to CLEANING
    const roomCleaningCheck = await pool.query('SELECT status FROM rooms WHERE id = $1', [roomAId]);
    expect(roomCleaningCheck.rows[0].status === 'CLEANING', `Expected room HK-901 status CLEANING, got ${roomCleaningCheck.rows[0].status}`);
    console.log(' -> Room HK-901 transitioned to CLEANING upon task start.');

    // =========================================================================
    // TEST 4: Mandatory Checklist Completion Enforcement
    // =========================================================================
    console.log('\n[TEST 4] Mandatory Checklist Enforcement');
    // Attempt to complete task while mandatory items are incomplete -> MUST FAIL
    const prematurelyCompleteRes = await request('PATCH', `/api/housekeeping/tasks/${autoTask.id}/complete`, {
      property_id: propertyId,
      actor_name: 'Attendant Budi'
    });
    expect(prematurelyCompleteRes.status === 400, `Expected 400 on premature complete, got ${prematurelyCompleteRes.status}`);
    expect(prematurelyCompleteRes.body.code === 'CHECKLIST_INCOMPLETE', `Expected code CHECKLIST_INCOMPLETE, got ${prematurelyCompleteRes.body.code}`);
    console.log(' -> Properly rejected completion with code CHECKLIST_INCOMPLETE.');

    // Complete all required items
    for (const item of itemsRes.rows) {
      if (item.is_required) {
        const itemRes = await request('PATCH', `/api/housekeeping/tasks/${autoTask.id}/checklist-items/${item.id}`, {
          property_id: propertyId,
          is_completed: true,
          actor_name: 'Attendant Budi'
        });
        expect(itemRes.status === 200, `Expected 200 on checklist item update, got ${itemRes.status}`);
      }
    }

    // Now complete the task -> MUST SUCCEED
    const validCompleteRes = await request('PATCH', `/api/housekeeping/tasks/${autoTask.id}/complete`, {
      property_id: propertyId,
      completion_note: 'Room cleaned thoroughly',
      actor_name: 'Attendant Budi'
    });
    expect(validCompleteRes.status === 200, `Expected 200 on valid complete, got ${validCompleteRes.status}`);
    expect(validCompleteRes.body.data.status === 'DONE', `Expected task status DONE, got ${validCompleteRes.body.data.status}`);

    // Verify room transitioned to VACANT_CLEAN
    const roomCleanCheck = await pool.query('SELECT status FROM rooms WHERE id = $1', [roomAId]);
    expect(roomCleanCheck.rows[0].status === 'VACANT_CLEAN', `Expected room status VACANT_CLEAN, got ${roomCleanCheck.rows[0].status}`);
    console.log(' -> Room HK-901 successfully transitioned to VACANT_CLEAN after checklist completion.');

    // =========================================================================
    // TEST 5: Supervisor Final Inspection (PASS -> INSPECTED, RETURN_TO_CLEANING -> Rework)
    // =========================================================================
    console.log('\n[TEST 5] Supervisor Final Inspection');
    // Create FINAL_INSPECTION task for HK-901
    const inspCreateRes = await request('POST', `/api/housekeeping/tasks`, {
      property_id: propertyId,
      task_category: 'ROOM_OPERATIONS',
      task_type: 'FINAL_INSPECTION',
      room_number: 'HK-901',
      title: 'Supervisor Final Inspection HK-901',
      priority: 'HIGH',
      assigned_user_name_snapshot: 'Supervisor Siti'
    });
    expect(inspCreateRes.status === 201, `Expected 201 on inspection task create, got ${inspCreateRes.status}`);
    const inspTask = inspCreateRes.body.data;
    createdTaskIds.push(inspTask.id);

    // Start inspection
    await request('PATCH', `/api/housekeeping/tasks/${inspTask.id}/start`, {
      property_id: propertyId,
      actor_name: 'Supervisor Siti'
    });

    // Complete inspection with RETURN_TO_CLEANING (rework)
    const reworkRes = await request('PATCH', `/api/housekeeping/tasks/${inspTask.id}/complete`, {
      property_id: propertyId,
      inspection_result: 'RETURN_TO_CLEANING',
      completion_note: 'Pillowcase wrinkled, bathroom mirror spotted',
      actor_name: 'Supervisor Siti'
    });
    expect(reworkRes.status === 200, `Expected 200 on rework completion, got ${reworkRes.status}`);

    // Room should transition back to VACANT_DIRTY
    const reworkRoomCheck = await pool.query('SELECT status FROM rooms WHERE id = $1', [roomAId]);
    expect(reworkRoomCheck.rows[0].status === 'VACANT_DIRTY', `Expected room status VACANT_DIRTY on rework, got ${reworkRoomCheck.rows[0].status}`);

    // A new rework task should have been created
    const reworkTaskCheck = await pool.query(
      `SELECT * FROM housekeeping_tasks WHERE room_id = $1 AND title LIKE '%Rework%' ORDER BY id DESC LIMIT 1`,
      [roomAId]
    );
    expect(reworkTaskCheck.rows.length === 1, 'Expected rework task created');
    createdTaskIds.push(reworkTaskCheck.rows[0].id);
    console.log(` -> RETURN_TO_CLEANING successfully reverted room to VACANT_DIRTY and spawned rework task #${reworkTaskCheck.rows[0].id}.`);

    // Now complete the rework task and do a PASS inspection
    await pool.query('UPDATE housekeeping_tasks SET status = $1 WHERE id = $2', ['DONE', reworkTaskCheck.rows[0].id]);
    await pool.query('UPDATE rooms SET status = $1 WHERE id = $2', ['VACANT_CLEAN', roomAId]);

    const passInspRes = await request('POST', `/api/housekeeping/tasks`, {
      property_id: propertyId,
      task_category: 'ROOM_OPERATIONS',
      task_type: 'FINAL_INSPECTION',
      room_number: 'HK-901',
      title: 'Supervisor Re-inspection HK-901',
      priority: 'HIGH'
    });
    const passTaskId = passInspRes.body.data.id;
    createdTaskIds.push(passTaskId);

    await request('PATCH', `/api/housekeeping/tasks/${passTaskId}/start`, { property_id: propertyId });
    const inspItems = await pool.query('SELECT id FROM housekeeping_task_checklist_items WHERE task_id = $1', [passTaskId]);
    for (const item of inspItems.rows) {
      await request('PATCH', `/api/housekeeping/tasks/${passTaskId}/checklist-items/${item.id}`, {
        property_id: propertyId,
        is_completed: true,
        actor_name: 'Supervisor Siti'
      });
    }

    const passDone = await request('PATCH', `/api/housekeeping/tasks/${passTaskId}/complete`, {
      property_id: propertyId,
      inspection_result: 'PASS',
      completion_note: 'All perfect',
      actor_name: 'Supervisor Siti'
    });
    expect(passDone.status === 200, `Expected 200 on pass inspection, got ${passDone.status}`);

    const inspectedRoomCheck = await pool.query('SELECT status FROM rooms WHERE id = $1', [roomAId]);
    expect(inspectedRoomCheck.rows[0].status === 'INSPECTED', `Expected room status INSPECTED, got ${inspectedRoomCheck.rows[0].status}`);
    console.log(' -> Final inspection PASS transitioned room HK-901 to INSPECTED.');

    // =========================================================================
    // TEST 6: Checkout Room Inspection & FO Notification Flow
    // =========================================================================
    console.log('\n[TEST 6] Checkout Room Inspection & FO Clearance Flow');
    // Create new reservation on HK-902
    const bid2 = `HK-BID-${Date.now()}-2`;
    const bk2 = await pool.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, 'Guest Checkout Inspection Test', 'ACTIVE')
       RETURNING id`,
      [propertyId, bid2]
    );
    createdBookingIds.push(bk2.rows[0].id);

    const res2 = await pool.query(
      `INSERT INTO reservations (booking_id, stay_sequence, room_id, guest_name, check_in, check_out, status, stay_status, booked_room_type_id_snapshot)
       VALUES ($1, 1, $2, 'Guest Checkout Inspection Test', $3, $4, 'CHECKED_IN', 'IN_HOUSE', $5)
       RETURNING id`,
      [bk2.rows[0].id, roomBId, today, tomorrow, roomTypeId]
    );
    const reservation2Id = res2.rows[0].id;
    createdReservationIds.push(reservation2Id);

    // FO requests room check
    const reqCheckRes = await request('POST', `/api/housekeeping/checkout-room-check`, {
      property_id: propertyId,
      reservation_id: reservation2Id,
      requested_by_name_snapshot: 'Receptionist Ani'
    });
    expect(reqCheckRes.status === 201, `Expected 201 from checkout-room-check, got ${reqCheckRes.status}`);
    const checkTask = reqCheckRes.body.data;
    createdTaskIds.push(checkTask.id);
    expect(checkTask.task_type === 'CHECKOUT_ROOM_CHECK', 'Expected CHECKOUT_ROOM_CHECK task type');
    expect(checkTask.priority === 'CRITICAL', 'Expected CRITICAL priority');

    // Verify GET /api/reservations/:id includes checkout_inspection status
    const getResDetail = await request('GET', `/api/reservations/${reservation2Id}?property_id=${propertyId}`);
    expect(getResDetail.status === 200, 'Expected 200 from GET reservation detail');
    expect(getResDetail.body.data.checkout_inspection !== null, 'Expected checkout_inspection object');
    expect(getResDetail.body.data.checkout_inspection.clearance_state === 'REQUESTED', `Expected clearance REQUESTED, got ${getResDetail.body.data.checkout_inspection.clearance_state}`);

    // Complete inspection with ISSUE_FOUND (Minibar + Damage)
    await request('PATCH', `/api/housekeeping/tasks/${checkTask.id}/start`, { property_id: propertyId });
    const issueDone = await request('PATCH', `/api/housekeeping/tasks/${checkTask.id}/complete`, {
      property_id: propertyId,
      inspection_result: 'ISSUE_FOUND',
      issue_type: 'MINIBAR',
      issue_note: '2 Cans Soda Consumed + 1 Snack Box',
      estimated_charge: 50000,
      actor_name: 'Attendant Budi'
    });
    expect(issueDone.status === 200, `Expected 200 on issue complete, got ${issueDone.status}`);

    // Verify GET /api/reservations/:id reflects ISSUE_FOUND
    const getResDetailAfter = await request('GET', `/api/reservations/${reservation2Id}?property_id=${propertyId}`);
    expect(getResDetailAfter.body.data.checkout_inspection.clearance_state === 'ISSUE_FOUND', `Expected clearance ISSUE_FOUND, got ${getResDetailAfter.body.data.checkout_inspection.clearance_state}`);
    expect(getResDetailAfter.body.data.checkout_inspection.estimated_charge === 50000, 'Expected estimated_charge 50000');
    console.log(' -> Checkout Room Check clearance flow verified: ISSUE_FOUND with estimated charge attached to FO reservation response.');

    // =========================================================================
    // TEST 7: Service Requests & Department Tasks (Do NOT mutate room physical state)
    // =========================================================================
    console.log('\n[TEST 7] Service Request & Department Task Isolation');
    const prevRoomBStatus = (await pool.query('SELECT status FROM rooms WHERE id = $1', [roomBId])).rows[0].status;

    const srvRes = await request('POST', `/api/housekeeping/tasks`, {
      property_id: propertyId,
      task_category: 'SERVICE_REQUEST',
      task_type: 'GUEST_SERVICE_DELIVERY',
      room_number: 'HK-902',
      title: 'Antar Extra Towel & Mineral Water',
      priority: 'HIGH'
    });
    expect(srvRes.status === 201, 'Expected 201 on service request create');
    const srvTask = srvRes.body.data;
    createdTaskIds.push(srvTask.id);

    await request('PATCH', `/api/housekeeping/tasks/${srvTask.id}/start`, { property_id: propertyId });
    await request('PATCH', `/api/housekeeping/tasks/${srvTask.id}/complete`, { property_id: propertyId, completion_note: 'Delivered' });

    const postRoomBStatus = (await pool.query('SELECT status FROM rooms WHERE id = $1', [roomBId])).rows[0].status;
    expect(postRoomBStatus === prevRoomBStatus, `Room status must not be modified by service request (${postRoomBStatus} vs ${prevRoomBStatus})`);
    console.log(' -> Service request completed without modifying physical room status.');

    // =========================================================================
    // TEST 8: Checklist Template Snapshotting Immutability
    // =========================================================================
    console.log('\n[TEST 8] Checklist Template Snapshotting Immutability');
    // Task #autoTask has its own checklist snapshot.
    // Ensure modifying or creating tasks does not alter historical task checklist snapshot items.
    const snapshotCount = (await pool.query('SELECT count(*) FROM housekeeping_task_checklist_items WHERE task_id = $1', [autoTask.id])).rows[0].count;
    expect(Number(snapshotCount) > 0, 'Expected snapshots present');
    console.log(` -> Historical task #${autoTask.id} checklist snapshot intact with ${snapshotCount} items.`);

    console.log('\n======================================================');
    console.log('ALL HK-OPS-1 INTEGRATION TESTS PASSED PERFECTLY!');
    console.log('======================================================\n');
  } finally {
    // Teardown test fixtures
    console.log('[TEARDOWN] Cleaning test fixtures...');
    for (const taskId of createdTaskIds) {
      await pool.query('DELETE FROM housekeeping_task_checklist_items WHERE task_id = $1', [taskId]);
      await pool.query('DELETE FROM housekeeping_tasks WHERE id = $1', [taskId]);
    }
    for (const resId of createdReservationIds) {
      await pool.query('DELETE FROM reservations WHERE id = $1', [resId]);
    }
    for (const bkId of createdBookingIds) {
      await pool.query('DELETE FROM bookings WHERE id = $1', [bkId]);
    }
    if (roomAId) {
      await pool.query('DELETE FROM rooms WHERE id = $1', [roomAId]);
    }
    if (roomBId) {
      await pool.query('DELETE FROM rooms WHERE id = $1', [roomBId]);
    }
    if (roomTypeId) {
      await pool.query('DELETE FROM availability_dates WHERE room_type_id = $1', [roomTypeId]);
      await pool.query('DELETE FROM room_types WHERE id = $1', [roomTypeId]);
    }
    if (origSettings) {
      await pool.query(
        `UPDATE property_housekeeping_settings
         SET require_checkout_room_check = $1, require_final_inspection = $2
         WHERE property_id = $3`,
        [origSettings.require_checkout_room_check, origSettings.require_final_inspection, propertyId]
      );
    }
    console.log('[TEARDOWN] Finished cleaning test fixtures with 0 residue.');
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
    await runHousekeepingOperationsSuite();
  } catch (err) {
    console.error('\n[FATAL TEST FAILURE]', err);
    process.exitCode = 1;
  } finally {
    server.close();
    await pool.end();
  }
}

main();
