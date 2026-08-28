// backend/test/housekeeping_feature_flags_test.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { once } = require('events');
const { app, pool } = require('../dist/index');
const { initializeDatabase } = require('../dist/db/schema_v3');

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

async function completeTaskChecklist(taskId, propertyId) {
  const itemsRes = await pool.query('SELECT id, is_required FROM housekeeping_task_checklist_items WHERE task_id = $1', [taskId]);
  for (const item of itemsRes.rows) {
    if (item.is_required) {
      await request('PATCH', `/api/housekeeping/tasks/${taskId}/checklist-items/${item.id}`, {
        property_id: propertyId,
        is_completed: true,
        actor_name: 'Attendant Budi'
      });
    }
  }
}

async function runHousekeepingFeatureFlagsSuite() {
  const propertyId = 1;
  const today = toDateKey(new Date());
  const tomorrow = addDays(today, 1);
  const nextWeek = addDays(today, 7);

  console.log('\n======================================================');
  console.log('HK-OPS-1: HOUSEKEEPING FEATURE FLAGS & SETTINGS TEST SUITE');
  console.log('======================================================\n');

  let roomTypeId = null;
  let roomId = null;
  let propertyBId = null;
  const createdBookingIds = [];
  const createdReservationIds = [];
  const createdTaskIds = [];

  try {
    // 0. Setup test fixture: room type and physical room
    const catRes = await pool.query('SELECT id FROM room_categories WHERE property_id = $1 LIMIT 1', [propertyId]);
    const catId = catRes.rows[0]?.id || null;

    const rtRes = await pool.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity, is_active)
       VALUES ($1, $2, $3, $4, 600000, 2, true)
       ON CONFLICT (property_id, code) DO UPDATE SET is_active = true
       RETURNING id`,
      [propertyId, catId, 'HK_FF_TYPE', 'HK Feature Flag Test Room Type']
    );
    roomTypeId = rtRes.rows[0].id;

    const rRes = await pool.query(
      `INSERT INTO rooms (property_id, room_number, room_type_id, status)
       VALUES ($1, $2, $3, 'VACANT_DIRTY')
       ON CONFLICT (property_id, room_number) DO UPDATE SET status = 'VACANT_DIRTY', room_type_id = $3
       RETURNING id`,
      [propertyId, 'HK-FF-101', roomTypeId]
    );
    roomId = rRes.rows[0].id;

    // Seed availability_dates for roomTypeId
    await pool.query('DELETE FROM availability_dates WHERE room_type_id = $1', [roomTypeId]);
    await pool.query(
      `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
       VALUES ($1, 'HK Feature Flag Test Room Type', $2::date, 1, 1),
              ($1, 'HK Feature Flag Test Room Type', $3::date, 1, 0)`,
      [roomTypeId, today, tomorrow]
    );

    // Create a fixture second property to test multi-property isolation
    const pBRes = await pool.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ('HK Test Prop B', 'HKPB', 'Asia/Jakarta', 'IDR', 'Address B', TRUE)
       ON CONFLICT (property_code) DO UPDATE SET is_active = TRUE
       RETURNING id`
    );
    propertyBId = pBRes.rows[0].id;

    console.log(`[SETUP] Test room created: ID=${roomId}, TypeID=${roomTypeId}, PropB=${propertyBId}`);

    // =========================================================================
    // TEST 1: Property Isolation of Feature Flags
    // =========================================================================
    console.log('\n--- TEST 1: Property Isolation of Feature Flags ---');

    // Reset Property 1 flags to defaults
    await request('PATCH', `/api/properties/${propertyId}/features`, {
      features: {
        'housekeeping.enabled': true,
        'housekeeping.room_operations': true,
        'housekeeping.checkout_inspection': true,
        'housekeeping.final_inspection': true,
        'housekeeping.service_requests': true,
        'housekeeping.department_tasks': true
      }
    });

    const getP1Res = await request('GET', `/api/properties/${propertyId}/features`);
    expect(getP1Res.status === 200, `GET features for Property 1 returned ${getP1Res.status}`);
    expect(getP1Res.body.data['housekeeping.enabled'] === true, 'Property 1 housekeeping.enabled should be true');

    // Toggle Property 1 HK master switch OFF
    const patchP1Res = await request('PATCH', `/api/properties/${propertyId}/features/housekeeping.enabled`, {
      enabled: false
    });
    expect(patchP1Res.status === 200, `Disable HK for Property 1 returned ${patchP1Res.status}`);
    expect(patchP1Res.body.data.enabled === false, 'Housekeeping should be disabled on Property 1');

    // Property B should get default or separate state (enabled = true)
    const getPBRes = await request('GET', `/api/properties/${propertyBId}/features`);
    expect(getPBRes.status === 200, `GET features for Property B returned ${getPBRes.status}`);
    expect(getPBRes.body.data['housekeeping.enabled'] === true, 'Property B should retain its own default (true)');

    console.log('✔ Property feature flag isolation verified.');

    // =========================================================================
    // TEST 2: HK Master Switch OFF Enforcements
    // =========================================================================
    console.log('\n--- TEST 2: HK Master Switch OFF Enforcements ---');
    // Attempting to create a task when housekeeping.enabled = false must fail with 403 FEATURE_DISABLED
    const taskAttemptRes = await request('POST', '/api/housekeeping/tasks', {
      property_id: propertyId,
      task_type: 'ROOM_CLEANING',
      room_id: roomId,
      scheduled_date: today,
      title: 'Cleaning while HK is disabled'
    });

    expect(taskAttemptRes.status === 403, `Create task while HK disabled expected 403, got ${taskAttemptRes.status}`);
    expect(taskAttemptRes.body.code === 'FEATURE_DISABLED', `Expected error code FEATURE_DISABLED, got ${taskAttemptRes.body?.code}`);
    console.log('✔ API rejection with 403 FEATURE_DISABLED verified when housekeeping.enabled = false.');

    // Re-enable HK master switch
    await request('PATCH', `/api/properties/${propertyId}/features/housekeeping.enabled`, { enabled: true });

    // Create a task to verify operations work again
    const taskCreateRes = await request('POST', '/api/housekeeping/tasks', {
      property_id: propertyId,
      task_type: 'ROOM_CLEANING',
      room_id: roomId,
      scheduled_date: today,
      title: 'Valid cleaning task'
    });
    expect(taskCreateRes.status === 201, `Create task after re-enabling expected 201, got ${taskCreateRes.status}`);
    const validTaskId = taskCreateRes.body.data.id;
    createdTaskIds.push(validTaskId);

    // Disable HK master switch again and verify historical data remains intact
    await request('PATCH', `/api/properties/${propertyId}/features/housekeeping.enabled`, { enabled: false });
    const checkTaskDb = await pool.query(`SELECT id, status, title FROM housekeeping_tasks WHERE id = $1`, [validTaskId]);
    expect(checkTaskDb.rows.length === 1, 'Task record must remain in database when feature is disabled');
    expect(checkTaskDb.rows[0].title === 'Valid cleaning task', 'Task record must not be corrupted');
    console.log('✔ Historical tasks preserved without deletion or corruption when HK is disabled.');

    // Re-enable HK for subsequent tests
    await request('PATCH', `/api/properties/${propertyId}/features/housekeeping.enabled`, { enabled: true });

    // =========================================================================
    // TEST 3: Sub-Feature Flag: Checkout Inspection (OFF vs ON)
    // =========================================================================
    console.log('\n--- TEST 3: Sub-Feature Flag: Checkout Inspection (OFF vs ON) ---');

    // Create a checked-in reservation
    const bid1 = `HK-FF-BID-${Date.now()}`;
    const bkRes = await pool.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, 'HK Feature Flag Guest', 'ACTIVE')
       RETURNING id`,
      [propertyId, bid1]
    );
    const bookingId = bkRes.rows[0].id;
    createdBookingIds.push(bookingId);

    const resRes = await pool.query(
      `INSERT INTO reservations (booking_id, stay_sequence, room_id, guest_name, check_in, check_out, status, stay_status, booked_room_type_id_snapshot)
       VALUES ($1, 1, $2, 'HK Feature Flag Guest', $3, $4, 'CHECKED_IN', 'IN_HOUSE', $5)
       RETURNING id`,
      [bookingId, roomId, today, tomorrow, roomTypeId]
    );
    const reservationId = resRes.rows[0].id;
    createdReservationIds.push(reservationId);

    // Set room to OCCUPIED_CLEAN
    await pool.query(`UPDATE rooms SET status = 'OCCUPIED_CLEAN' WHERE id = $1`, [roomId]);

    // Subtest 3A: Toggle checkout_inspection OFF
    await request('PATCH', `/api/properties/${propertyId}/features/housekeeping.checkout_inspection`, { enabled: false });

    // Attempting to request checkout inspection must fail with 403 FEATURE_DISABLED
    const reqHkOffRes = await request('POST', `/api/housekeeping/checkout-room-check`, {
      property_id: propertyId,
      reservation_id: reservationId,
      room_id: roomId
    });
    expect(reqHkOffRes.status === 403, `Request room check with flag OFF expected 403, got ${reqHkOffRes.status}`);
    expect(reqHkOffRes.body.code === 'FEATURE_DISABLED', `Expected FEATURE_DISABLED, got ${reqHkOffRes.body?.code}`);
    console.log('✔ requestCheckoutRoomCheck rejected with 403 FEATURE_DISABLED when checkout_inspection is OFF.');

    // Subtest 3B: Toggle checkout_inspection ON + require_checkout_room_check = true (Mandatory policy)
    await request('PATCH', `/api/properties/${propertyId}/features/housekeeping.checkout_inspection`, { enabled: true });
    await request('PATCH', `/api/housekeeping/settings`, {
      property_id: propertyId,
      require_checkout_room_check: true
    });

    // Attempt checkout without completed room check -> Must fail with 400 CHECKOUT_INSPECTION_REQUIRED
    const checkoutBlockedRes = await request('POST', `/api/reservations/${reservationId}/checkout`, { property_id: propertyId });
    expect(checkoutBlockedRes.status === 400, `Mandatory checkout room check expected 400, got ${checkoutBlockedRes.status}`);
    expect(checkoutBlockedRes.body.code === 'CHECKOUT_INSPECTION_REQUIRED', `Expected CHECKOUT_INSPECTION_REQUIRED, got ${checkoutBlockedRes.body?.code}`);
    console.log('✔ Mandatory checkout inspection blocks checkout with 400 CHECKOUT_INSPECTION_REQUIRED.');

    // Request room check and complete inspection with CLEAR
    const reqHkOnRes = await request('POST', `/api/housekeeping/checkout-room-check`, {
      property_id: propertyId,
      reservation_id: reservationId,
      room_id: roomId
    });
    expect(reqHkOnRes.status === 201, `Request room check returned ${reqHkOnRes.status}`);
    const inspectionTaskId = reqHkOnRes.body.data.id;
    createdTaskIds.push(inspectionTaskId);

    // Complete inspection task with CLEAR
    await request('PATCH', `/api/housekeeping/tasks/${inspectionTaskId}/start`, { property_id: propertyId });
    await completeTaskChecklist(inspectionTaskId, propertyId);
    const compInspRes = await request('PATCH', `/api/housekeeping/tasks/${inspectionTaskId}/complete`, {
      property_id: propertyId,
      inspection_result: 'CLEAR',
      issue_note: 'Semua aman dan lengkap'
    });
    expect(compInspRes.status === 200, `Complete inspection returned ${compInspRes.status}`);

    // Now checkout must succeed
    const checkoutSuccessRes = await request('POST', `/api/reservations/${reservationId}/checkout`, { property_id: propertyId });
    expect(checkoutSuccessRes.status === 200, `Checkout after CLEAR expected 200, got ${checkoutSuccessRes.status}`);
    console.log('✔ Checkout proceeds successfully once inspection is CLEAR.');

    // =========================================================================
    // TEST 4: Sub-Feature Flag: Final Inspection (OFF vs ON)
    // =========================================================================
    console.log('\n--- TEST 4: Sub-Feature Flag: Final Inspection (OFF vs ON) ---');

    // Subtest 4A: Final Inspection Flag OFF
    await request('PATCH', `/api/properties/${propertyId}/features/housekeeping.final_inspection`, { enabled: false });
    await request('PATCH', `/api/housekeeping/settings`, {
      property_id: propertyId,
      require_final_inspection: true // policy set to true, but sub-feature flag is OFF
    });

    // Reset room status to VACANT_DIRTY
    await pool.query(`UPDATE rooms SET status = 'VACANT_DIRTY' WHERE id = $1`, [roomId]);

    // Create and complete a ROOM_CLEANING task
    const clTaskA = await request('POST', '/api/housekeeping/tasks', {
      property_id: propertyId,
      task_type: 'ROOM_CLEANING',
      room_id: roomId,
      scheduled_date: today,
      title: 'Cleaning with Final Inspection flag OFF'
    });
    const clTaskAId = clTaskA.body.data.id;
    createdTaskIds.push(clTaskAId);

    await request('PATCH', `/api/housekeeping/tasks/${clTaskAId}/start`, { property_id: propertyId });
    await completeTaskChecklist(clTaskAId, propertyId);
    const compTaskARes = await request('PATCH', `/api/housekeeping/tasks/${clTaskAId}/complete`, { property_id: propertyId });
    expect(compTaskARes.status === 200, `Complete cleaning returned ${compTaskARes.status}`);

    // Verify room is directly VACANT_CLEAN and no supervisor task was generated
    const roomACheck = await pool.query(`SELECT status FROM rooms WHERE id = $1`, [roomId]);
    expect(roomACheck.rows[0].status === 'VACANT_CLEAN', `Expected VACANT_CLEAN, got ${roomACheck.rows[0].status}`);

    const supTaskACheck = await pool.query(
      `SELECT id FROM housekeeping_tasks WHERE room_id = $1 AND task_type = 'FINAL_INSPECTION'`,
      [roomId]
    );
    expect(supTaskACheck.rows.length === 0, 'No FINAL_INSPECTION supervisor task should be generated when final_inspection flag is OFF');
    console.log('✔ Final inspection flag OFF: Cleaning completes directly to VACANT_CLEAN without supervisor task.');

    // Subtest 4B: Final Inspection Flag ON + require_final_inspection = true
    await request('PATCH', `/api/properties/${propertyId}/features/housekeeping.final_inspection`, { enabled: true });
    await pool.query(`UPDATE rooms SET status = 'VACANT_DIRTY' WHERE id = $1`, [roomId]);

    const clTaskB = await request('POST', '/api/housekeeping/tasks', {
      property_id: propertyId,
      task_type: 'ROOM_CLEANING',
      room_id: roomId,
      scheduled_date: today,
      title: 'Cleaning with Final Inspection flag ON'
    });
    const clTaskBId = clTaskB.body.data.id;
    createdTaskIds.push(clTaskBId);

    // Verify task_number format HK-{PROPERTY_CODE}-{YYMMDD}-{SEQ}
    expect(
      Boolean(clTaskB.body.data.task_number && /^HK-[A-Z0-9]+-\d{6}-\d{4}$/.test(clTaskB.body.data.task_number)),
      `Expected task_number format HK-{CODE}-YYMMDD-XXXX, got ${clTaskB.body.data.task_number}`
    );

    await request('PATCH', `/api/housekeeping/tasks/${clTaskBId}/start`, { property_id: propertyId });
    await completeTaskChecklist(clTaskBId, propertyId);
    const compTaskBRes = await request('PATCH', `/api/housekeeping/tasks/${clTaskBId}/complete`, { property_id: propertyId });
    expect(compTaskBRes.status === 200, `Complete cleaning returned ${compTaskBRes.status}`);

    // Authoritative Lifecycle Check: Room MUST transition to VACANT_CLEAN upon cleaning completion
    const roomPostCleanCheck = await pool.query(`SELECT status FROM rooms WHERE id = $1`, [roomId]);
    expect(
      roomPostCleanCheck.rows[0].status === 'VACANT_CLEAN',
      `Expected room status = VACANT_CLEAN immediately after cleaning completion, got ${roomPostCleanCheck.rows[0].status}`
    );

    // Verify FINAL_INSPECTION supervisor task was automatically generated
    const supTaskBCheck = await pool.query(
      `SELECT id, status FROM housekeeping_tasks WHERE room_id = $1 AND task_type = 'FINAL_INSPECTION' ORDER BY id DESC LIMIT 1`,
      [roomId]
    );
    expect(supTaskBCheck.rows.length === 1, 'FINAL_INSPECTION task must be generated when final_inspection flag and policy are ON');
    const supTaskId = supTaskBCheck.rows[0].id;
    createdTaskIds.push(supTaskId);

    // Subtest 4C: Test Supervisor RETURN_TO_CLEANING (Rework Cycle)
    await request('PATCH', `/api/housekeeping/tasks/${supTaskId}/start`, { property_id: propertyId });
    const reworkRes = await request('PATCH', `/api/housekeeping/tasks/${supTaskId}/complete`, {
      property_id: propertyId,
      inspection_result: 'RETURN_TO_CLEANING',
      completion_note: 'Mirror spots found. Needs re-wiping.'
    });
    expect(reworkRes.status === 200, `RETURN_TO_CLEANING returned ${reworkRes.status}`);

    // Room must revert to VACANT_DIRTY
    const reworkRoomCheck = await pool.query(`SELECT status FROM rooms WHERE id = $1`, [roomId]);
    expect(reworkRoomCheck.rows[0].status === 'VACANT_DIRTY', `Expected room status = VACANT_DIRTY on rework, got ${reworkRoomCheck.rows[0].status}`);

    // Rework cleaning task generated
    const reworkTaskCheck = await pool.query(
      `SELECT id FROM housekeeping_tasks WHERE room_id = $1 AND title LIKE '%Rework%' ORDER BY id DESC LIMIT 1`,
      [roomId]
    );
    expect(reworkTaskCheck.rows.length === 1, 'Expected rework cleaning task to be created');
    const reworkTaskId = reworkTaskCheck.rows[0].id;
    createdTaskIds.push(reworkTaskId);

    // Complete rework task -> Room returns to VACANT_CLEAN
    await request('PATCH', `/api/housekeeping/tasks/${reworkTaskId}/start`, { property_id: propertyId });
    await completeTaskChecklist(reworkTaskId, propertyId);
    await request('PATCH', `/api/housekeeping/tasks/${reworkTaskId}/complete`, { property_id: propertyId });

    const postReworkRoomCheck = await pool.query(`SELECT status FROM rooms WHERE id = $1`, [roomId]);
    expect(postReworkRoomCheck.rows[0].status === 'VACANT_CLEAN', `Expected room status = VACANT_CLEAN after rework completion, got ${postReworkRoomCheck.rows[0].status}`);

    // Second supervisor inspection task generated from rework
    const secondSupTaskCheck = await pool.query(
      `SELECT id FROM housekeeping_tasks WHERE room_id = $1 AND task_type = 'FINAL_INSPECTION' AND status = 'ASSIGNED' ORDER BY id DESC LIMIT 1`,
      [roomId]
    );
    expect(secondSupTaskCheck.rows.length === 1, 'Expected second supervisor inspection task after rework');
    const secondSupTaskId = secondSupTaskCheck.rows[0].id;
    createdTaskIds.push(secondSupTaskId);

    // Complete second supervisor inspection with PASS -> Room transitions to INSPECTED
    await request('PATCH', `/api/housekeeping/tasks/${secondSupTaskId}/start`, { property_id: propertyId });
    await completeTaskChecklist(secondSupTaskId, propertyId);
    const compSupRes = await request('PATCH', `/api/housekeeping/tasks/${secondSupTaskId}/complete`, {
      property_id: propertyId,
      inspection_result: 'PASS'
    });
    expect(compSupRes.status === 200, `Complete supervisor inspection returned ${compSupRes.status}`);

    const roomBCheck = await pool.query(`SELECT status FROM rooms WHERE id = $1`, [roomId]);
    expect(roomBCheck.rows[0].status === 'INSPECTED', `Expected room status = INSPECTED after PASS, got ${roomBCheck.rows[0].status}`);
    console.log('✔ Authoritative lifecycle verified: VACANT_DIRTY -> CLEANING -> VACANT_CLEAN -> FINAL_INSPECTION -> (RETURN_TO_CLEANING / PASS) -> INSPECTED.');

    // =========================================================================
    // TEST 5: Verify Inventory Invariants (Zero Drift)
    // =========================================================================
    console.log('\n--- TEST 5: Verifying Invariants & Ledger Consistency ---');
    const driftCheck = await pool.query(`
      SELECT
        ad.room_type_id,
        ad.date,
        ad.reserved_qty,
        COALESCE(e.active_nights, 0) AS expected_qty
      FROM availability_dates ad
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS active_nights
        FROM reservations r
        JOIN rooms rm ON rm.id = r.room_id
        WHERE rm.room_type_id = ad.room_type_id
          AND r.status IN ('BOOKED', 'CHECKED_IN')
          AND r.check_in IS NOT NULL AND r.check_out IS NOT NULL AND r.check_out > r.check_in
          AND ad.date >= r.check_in::date
          AND ad.date < r.check_out::date
      ) e ON TRUE
      WHERE ad.room_type_id = $1
        AND ad.reserved_qty <> COALESCE(e.active_nights, 0)
    `, [roomTypeId]);

    expect(driftCheck.rows.length === 0, `Detected ${driftCheck.rows.length} inventory drift rows!`);
    console.log('✔ Zero inventory drift verified.');

    console.log('\n======================================================');
    console.log('ALL HK FEATURE FLAGS & CENTRAL SETTINGS TESTS PASSED!');
    console.log('======================================================\n');
  } finally {
    // Teardown: isolate and clean all created test fixtures
    console.log('[TEARDOWN] Cleaning test data...');
    try {
      // Restore default features
      await pool.query(`
        UPDATE property_features
        SET enabled = true
        WHERE property_id = $1
      `, [propertyId]);

      // Restore default HK settings
      await pool.query(`
        UPDATE property_housekeeping_settings
        SET require_checkout_room_check = false,
            require_final_inspection = false
        WHERE property_id = $1
      `, [propertyId]);

      if (createdTaskIds.length > 0) {
        await pool.query(`DELETE FROM housekeeping_task_checklist_items WHERE task_id = ANY($1::int[])`, [createdTaskIds]);
        await pool.query(`DELETE FROM housekeeping_tasks WHERE id = ANY($1::int[])`, [createdTaskIds]);
      }
      if (createdReservationIds.length > 0) {
        await pool.query(`DELETE FROM reservations WHERE id = ANY($1::int[])`, [createdReservationIds]);
      }
      if (createdBookingIds.length > 0) {
        await pool.query(`DELETE FROM bookings WHERE id = ANY($1::int[])`, [createdBookingIds]);
      }
      if (roomId) {
        await pool.query(`DELETE FROM housekeeping_tasks WHERE room_id = $1`, [roomId]);
        await pool.query(`DELETE FROM rooms WHERE id = $1`, [roomId]);
      }
      if (roomTypeId) {
        await pool.query(`DELETE FROM availability_dates WHERE room_type_id = $1`, [roomTypeId]);
        await pool.query(`DELETE FROM room_types WHERE id = $1`, [roomTypeId]);
      }
      if (propertyBId) {
        await pool.query(`DELETE FROM property_features WHERE property_id = $1`, [propertyBId]);
        await pool.query(`DELETE FROM property_housekeeping_settings WHERE property_id = $1`, [propertyBId]);
        await pool.query(`DELETE FROM checklist_template_items WHERE template_id IN (SELECT id FROM checklist_templates WHERE property_id = $1)`, [propertyBId]);
        await pool.query(`DELETE FROM checklist_templates WHERE property_id = $1`, [propertyBId]);
        await pool.query(`DELETE FROM properties WHERE id = $1`, [propertyBId]);
      }
      console.log('[TEARDOWN] Complete. Zero test residue.');
    } catch (cleanErr) {
      console.error('[TEARDOWN ERROR]', cleanErr);
    }
  }
}

async function main() {
  await initializeDatabase(pool);

  server = app.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    await runHousekeepingFeatureFlagsSuite();
    process.exitCode = 0;
  } catch (err) {
    console.error('\n❌ Test Suite Failed:', err);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.close();
    }
    await pool.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = { runHousekeepingFeatureFlagsSuite };
