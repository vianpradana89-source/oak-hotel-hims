'use strict';

require('dotenv').config({ path: 'e:/oak-hotel-hims/backend/.env' });
const http = require('http');
const { once } = require('events');
const { app, pool } = require('../dist/index');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`PASS | ${message}`);
    passed++;
  } else {
    console.error(`FAIL | ${message}`);
    failed++;
  }
}

async function api(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body && method !== 'GET') {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(baseUrl + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function main() {
  console.log('=== Starting Property-Scoped Room Operational Blocks Tests ===\n');

  server = http.createServer(app);
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  let propAId = null;
  let propBId = null;
  let roomTypeIdA = null;
  let roomTypeIdA2 = null;
  let roomTypeIdB = null;
  let room101Id = null;
  let room102Id = null;
  let room103Id = null;
  let room201Id = null;
  let taskIdA = null;
  let taskIdB = null;

  const DATES = {
    AUG_01: '2026-08-01',
    AUG_02: '2026-08-02',
    AUG_03: '2026-08-03',
    AUG_04: '2026-08-04',
    AUG_05: '2026-08-05',
    AUG_06: '2026-08-06',
    AUG_07: '2026-08-07',
    AUG_08: '2026-08-08',
    AUG_09: '2026-08-09',
    AUG_10: '2026-08-10'
  };

  const codeA = 'TA' + Math.floor(1000 + Math.random() * 8999);
  const codeB = 'TB' + Math.floor(1000 + Math.random() * 8999);

  try {
    // 1. Fixture Setup: Property A and Property B
    const propARes = await pool.query(
      "INSERT INTO properties (property_code, name, address, is_active) VALUES ($1, 'Test Block Prop A', 'Test Address A', TRUE) RETURNING id",
      [codeA]
    );
    propAId = propARes.rows[0].id;

    const propBRes = await pool.query(
      "INSERT INTO properties (property_code, name, address, is_active) VALUES ($1, 'Test Block Prop B', 'Test Address B', TRUE) RETURNING id",
      [codeB]
    );
    propBId = propBRes.rows[0].id;

    // Room Types for Prop A
    const rtA1 = await pool.query(
      "INSERT INTO room_types (property_id, code, name, base_rate, capacity, is_active) VALUES ($1, 'DLX', 'Deluxe King', 500000, 2, TRUE) RETURNING id",
      [propAId]
    );
    roomTypeIdA = rtA1.rows[0].id;

    const rtA2 = await pool.query(
      "INSERT INTO room_types (property_id, code, name, base_rate, capacity, is_active) VALUES ($1, 'STE', 'Suite', 900000, 2, TRUE) RETURNING id",
      [propAId]
    );
    roomTypeIdA2 = rtA2.rows[0].id;

    // Room Type for Prop B
    const rtB1 = await pool.query(
      "INSERT INTO room_types (property_id, code, name, base_rate, capacity, is_active) VALUES ($1, 'DLX', 'Deluxe King B', 500000, 2, TRUE) RETURNING id",
      [propBId]
    );
    roomTypeIdB = rtB1.rows[0].id;

    // Rooms for Prop A (Room 101, 102 under roomTypeIdA; Room 103 under roomTypeIdA2)
    const r101 = await pool.query(
      "INSERT INTO rooms (property_id, room_number, name, room_type_id, status, is_active) VALUES ($1, '101', 'Deluxe King', $2, 'VACANT_CLEAN', TRUE) RETURNING id",
      [propAId, roomTypeIdA]
    );
    room101Id = r101.rows[0].id;

    const r102 = await pool.query(
      "INSERT INTO rooms (property_id, room_number, name, room_type_id, status, is_active) VALUES ($1, '102', 'Deluxe King', $2, 'VACANT_CLEAN', TRUE) RETURNING id",
      [propAId, roomTypeIdA]
    );
    room102Id = r102.rows[0].id;

    const r103 = await pool.query(
      "INSERT INTO rooms (property_id, room_number, name, room_type_id, status, is_active) VALUES ($1, '103', 'Suite', $2, 'VACANT_CLEAN', TRUE) RETURNING id",
      [propAId, roomTypeIdA2]
    );
    room103Id = r103.rows[0].id;

    // Room for Prop B
    const r201 = await pool.query(
      "INSERT INTO rooms (property_id, room_number, name, room_type_id, status, is_active) VALUES ($1, '201', 'Deluxe King B', $2, 'VACANT_CLEAN', TRUE) RETURNING id",
      [propBId, roomTypeIdB]
    );
    room201Id = r201.rows[0].id;

    // Seed availability ledger for Prop A (DLX: total_rooms = 2, STE: total_rooms = 1)
    const allDates = Object.values(DATES);
    for (const d of allDates) {
      await pool.query(
        "INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty) VALUES ($1, 'Deluxe King', $2, 2, 0) ON CONFLICT DO NOTHING",
        [roomTypeIdA, d]
      );
      await pool.query(
        "INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty) VALUES ($1, 'Suite', $2, 1, 0) ON CONFLICT DO NOTHING",
        [roomTypeIdA2, d]
      );
    }

    // Maintenance tasks
    const mtA = await pool.query(
      "INSERT INTO maintenance_tasks (property_id, room_number, issue_type, priority, status) VALUES ($1, '101', 'AC Repair', 'HIGH', 'OPEN') RETURNING id",
      [propAId]
    );
    taskIdA = mtA.rows[0].id;

    const mtB = await pool.query(
      "INSERT INTO maintenance_tasks (property_id, room_number, issue_type, priority, status) VALUES ($1, '201', 'Plumbing', 'HIGH', 'OPEN') RETURNING id",
      [propBId]
    );
    taskIdB = mtB.rows[0].id;

    console.log('Setup completed successfully.');

    // ==========================================
    // 1. PROPERTY SCOPING & VALIDATION TESTS
    // ==========================================
    console.log('\n--- 1. Property Scoping & Validation Tests ---');

    // GET without property_id -> 400
    const getNoProp = await api('GET', '/api/room-operational-blocks');
    assert(getNoProp.status === 400, 'GET /api/room-operational-blocks without property_id returns 400');

    // GET with invalid property_id -> 400
    const getInvProp = await api('GET', '/api/room-operational-blocks?property_id=abc');
    assert(getInvProp.status === 400, 'GET /api/room-operational-blocks with invalid property_id returns 400');

    // GET with non-existent property_id -> 404
    const get404Prop = await api('GET', '/api/room-operational-blocks?property_id=999999');
    assert(get404Prop.status === 404, 'GET /api/room-operational-blocks with unknown property_id returns 404');

    // POST without property_id -> 400
    const postNoProp = await api('POST', '/api/room-operational-blocks', {
      room_id: room101Id,
      block_type: 'OUT_OF_ORDER',
      start_date: DATES.AUG_01,
      end_date: DATES.AUG_03
    });
    assert(postNoProp.status === 400, 'POST without property_id returns 400');

    // POST with room belonging to Prop B under Prop A -> 403 PROPERTY_MISMATCH
    const postWrongRoom = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room201Id, // Prop B room
      block_type: 'OUT_OF_ORDER',
      start_date: DATES.AUG_01,
      end_date: DATES.AUG_03
    });
    assert(postWrongRoom.status === 403, 'POST room belonging to another property returns 403 PROPERTY_MISMATCH');

    // POST with maintenance task belonging to Prop B under Prop A -> 403 PROPERTY_MISMATCH
    const postWrongTask = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room101Id,
      block_type: 'OUT_OF_ORDER',
      start_date: DATES.AUG_01,
      end_date: DATES.AUG_03,
      maintenance_task_id: taskIdB // Prop B task
    });
    assert(postWrongTask.status === 403, 'POST maintenance task belonging to another property returns 403 PROPERTY_MISMATCH');

    // ==========================================
    // 2. PARAMETERS & CONSTRAINTS VALIDATION
    // ==========================================
    console.log('\n--- 2. Parameters & Constraints Validation Tests ---');

    // Missing room_id -> 400
    const postNoRoom = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      block_type: 'OUT_OF_ORDER',
      start_date: DATES.AUG_01,
      end_date: DATES.AUG_03
    });
    assert(postNoRoom.status === 400, 'POST without room_id returns 400');

    // Invalid block_type -> 400
    const postBadType = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room101Id,
      block_type: 'DIRTY',
      start_date: DATES.AUG_01,
      end_date: DATES.AUG_03
    });
    assert(postBadType.status === 400, 'POST with invalid block_type (DIRTY) returns 400');

    // Invalid date span (end <= start) -> 400
    const postBadDates = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room101Id,
      block_type: 'OUT_OF_ORDER',
      start_date: DATES.AUG_03,
      end_date: DATES.AUG_01
    });
    assert(postBadDates.status === 400, 'POST with end_date <= start_date returns 400');

    // Same date span (0 night) -> 400
    const postZeroNight = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room101Id,
      block_type: 'OUT_OF_ORDER',
      start_date: DATES.AUG_01,
      end_date: DATES.AUG_01
    });
    assert(postZeroNight.status === 400, 'POST with end_date == start_date returns 400');

    // Room type snapshot mismatch -> 400
    const postBadSnapshot = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room101Id,
      room_type_id: roomTypeIdA2, // 101 is DLX, passing STE type id
      block_type: 'OUT_OF_ORDER',
      start_date: DATES.AUG_01,
      end_date: DATES.AUG_03
    });
    assert(postBadSnapshot.status === 400, 'POST with mismatched room_type_id returns 400');

    // ==========================================
    // 3. SUCCESSFUL CREATION & AUDIT LOG
    // ==========================================
    console.log('\n--- 3. Successful Block Creation & Audit Log ---');

    // Create OUT_OF_ORDER block on Room 101 for Aug 01 -> Aug 03 without providing room_type_id (server-side derivation)
    const createBlock1 = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room101Id,
      // room_type_id omitted -> should be automatically derived from room
      block_type: 'OUT_OF_ORDER',
      start_date: DATES.AUG_01,
      end_date: DATES.AUG_03,
      reason: 'Air conditioner compressor replacement',
      maintenance_task_id: taskIdA,
      created_by: 'Staff Andi'
    });
    assert(createBlock1.status === 201, 'POST valid OUT_OF_ORDER block returns 201');
    const block1 = createBlock1.body.data;
    assert(block1.status === 'ACTIVE', 'Created block status is ACTIVE');
    assert(block1.room_type_id === roomTypeIdA, 'Created block has authoritative room_type_id derived from room');
    assert(block1.start_date === DATES.AUG_01 && block1.end_date === DATES.AUG_03, 'Created block dates match');

    // Verify audit log exists with property_id
    const auditRes = await pool.query(
      "SELECT * FROM audit_logs WHERE entity = 'ROOM_OPERATIONAL_BLOCK' AND record_id = $1",
      [String(block1.id)]
    );
    assert(auditRes.rowCount > 0, 'Audit log entry created for block creation');
    assert(Number(auditRes.rows[0].property_id) === propAId, 'Audit log entry has non-null property_id matching Property A');

    // ==========================================
    // 4. BLOCK OVERLAP PROTECTION
    // ==========================================
    console.log('\n--- 4. Block Overlap Protection ---');

    // Attempt to create overlapping block on Room 101 (Aug 02 -> Aug 04) -> 409 OVERLAPPING_BLOCK
    const postOverlap = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room101Id,
      block_type: 'OUT_OF_SERVICE',
      start_date: DATES.AUG_02,
      end_date: DATES.AUG_04
    });
    assert(postOverlap.status === 409, 'Overlapping active block on same room returns 409');
    assert(postOverlap.body.code === 'OVERLAPPING_BLOCK', 'Error code is OVERLAPPING_BLOCK');

    // Adjacent block (Aug 03 -> Aug 05) on Room 101 -> 201 Success (half-open [01, 03) and [03, 05) do not overlap)
    const postAdjacent = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room101Id,
      block_type: 'OUT_OF_SERVICE',
      start_date: DATES.AUG_03,
      end_date: DATES.AUG_05,
      reason: 'Scheduled deep cleaning'
    });
    assert(postAdjacent.status === 201, 'Adjacent block [03, 05) on same room returns 201');
    const block2 = postAdjacent.body.data;

    // ==========================================
    // 5. RESERVATION OVERLAP GUARDS
    // ==========================================
    console.log('\n--- 5. Reservation Overlap Guards ---');

    // Create an active reservation on Room 102 for Aug 05 -> Aug 07
    const bookingRes = await pool.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, guest_phone_snapshot, booking_status)
       VALUES ($1, 'BID-TEST-B1', 'Guest John', '0812345678', 'ACTIVE') RETURNING id`
      , [propAId]
    );
    const bookingId = bookingRes.rows[0].id;

    const res102 = await pool.query(
      `INSERT INTO reservations (
         booking_id, stay_sequence, room_id, guest_name, check_in, check_out,
         status, stay_status, total_price, payment_status, booked_room_type_id_snapshot, booked_room_type_name_snapshot
       ) VALUES ($1, 1, $2, 'Guest John', $3, $4, 'BOOKED', 'RESERVED', 1000000, 'PAID', $5, 'Deluxe King')
       RETURNING id`,
      [bookingId, room102Id, DATES.AUG_05, DATES.AUG_07, roomTypeIdA]
    );
    const resId = res102.rows[0].id;

    // Attempt to block Room 102 on Aug 06 -> Aug 08 -> 409 ROOM_HAS_ACTIVE_RESERVATIONS
    const blockOnRes = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room102Id,
      block_type: 'OUT_OF_ORDER',
      start_date: DATES.AUG_06,
      end_date: DATES.AUG_08
    });
    assert(blockOnRes.status === 409, 'Creating block on room with active reservation returns 409');
    assert(blockOnRes.body.code === 'ROOM_HAS_ACTIVE_RESERVATIONS', 'Error code is ROOM_HAS_ACTIVE_RESERVATIONS');

    // ==========================================
    // 6. CAPACITY UNDERFLOW PROTECTION
    // ==========================================
    console.log('\n--- 6. Capacity Underflow Protection ---');

    // Room Type Suite (roomTypeIdA2) has total_rooms = 1 (Room 103)
    // Book Suite on Aug 08 -> Aug 10 (reserved_qty = 1)
    await pool.query(
      "UPDATE availability_dates SET reserved_qty = 1 WHERE room_type_id = $1 AND date >= '2026-08-08' AND date < '2026-08-10'",
      [roomTypeIdA2]
    );
    // Attempt to block Room 103 for Aug 08 -> Aug 10 -> 409 INSUFFICIENT_SELLABLE_CAPACITY
    const blockSuite = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room103Id,
      block_type: 'OUT_OF_ORDER',
      start_date: DATES.AUG_08,
      end_date: DATES.AUG_10
    });
    assert(blockSuite.status === 409, 'Blocking room when capacity is fully reserved returns 409');
    assert(blockSuite.body.code === 'INSUFFICIENT_SELLABLE_CAPACITY', 'Error code is INSUFFICIENT_SELLABLE_CAPACITY');

    // Reset reserved_qty for Suite
    await pool.query(
      "UPDATE availability_dates SET reserved_qty = 0 WHERE room_type_id = $1 AND date >= '2026-08-08' AND date < '2026-08-10'",
      [roomTypeIdA2]
    );

    // ==========================================
    // 7. EARLY RELEASE & CANCELLATION LIFECYCLE
    // ==========================================
    console.log('\n--- 7. Early Release & Cancellation Lifecycle ---');

    // Block 1 is Aug 01 -> Aug 03 on Room 101
    // Release Block 1 on Aug 02 (Early release: effective interval becomes Aug 01 -> Aug 02)
    const releaseEarly = await api('PATCH', `/api/room-operational-blocks/${block1.id}/release`, {
      property_id: propAId,
      effective_release_date: DATES.AUG_02,
      released_by: 'Supervisor Budi',
      reason: 'Repairs finished ahead of schedule'
    });
    assert(releaseEarly.status === 200, 'PATCH release early returns 200');
    assert(releaseEarly.body.data.status === 'RELEASED', 'Block status updated to RELEASED');
    assert(releaseEarly.body.data.end_date === DATES.AUG_02, 'Early released block end_date shortened to release date (2026-08-02)');

    // Attempt to release again -> 409 BLOCK_NOT_ACTIVE
    const releaseAgain = await api('PATCH', `/api/room-operational-blocks/${block1.id}/release`, {
      property_id: propAId,
      released_by: 'Supervisor Budi'
    });
    assert(releaseAgain.status === 409, 'Releasing already released block returns 409');

    // Attempt to release with wrong property_id -> 403 PROPERTY_MISMATCH
    const releaseWrongProp = await api('PATCH', `/api/room-operational-blocks/${block2.id}/release`, {
      property_id: propBId,
      released_by: 'Staff Prop B'
    });
    assert(releaseWrongProp.status === 403, 'Releasing block belonging to another property returns 403');

    // Attempt to cancel an already RELEASED block (Block 1) -> 409 BLOCK_ALREADY_RELEASED
    const cancelReleasedBlock = await api('PATCH', `/api/room-operational-blocks/${block1.id}/cancel`, {
      property_id: propAId
    });
    assert(cancelReleasedBlock.status === 409, 'Cancelling already released block returns 409');
    assert(cancelReleasedBlock.body.code === 'BLOCK_ALREADY_RELEASED', 'Error code is BLOCK_ALREADY_RELEASED');

    // Verify historical blocked night on 2026-08-01 remains intact
    const pastNightsCheck = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM room_operational_blocks
       WHERE room_id = $1 AND status IN ('ACTIVE', 'RELEASED') AND start_date <= '2026-08-01'::date AND end_date > '2026-08-01'::date`,
      [room101Id]
    );
    assert(pastNightsCheck.rows[0].cnt === 1, 'Previously effective block night (2026-08-01) is preserved in historical capacity');

    // Verify released night on 2026-08-02 is NOT blocked
    const releasedNightCheck = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM room_operational_blocks
       WHERE room_id = $1 AND status IN ('ACTIVE', 'RELEASED') AND start_date <= '2026-08-02'::date AND end_date > '2026-08-02'::date`,
      [room101Id]
    );
    assert(releasedNightCheck.rows[0].cnt === 0, 'Released date (2026-08-02) is NOT counted as blocked night');

    // 7b. Cancellation Rules: Future vs Today vs Past
    // Create Future Block (2099-01-01 -> 2099-01-05) on Room 102
    const futureBlockRes = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room102Id,
      block_type: 'OUT_OF_ORDER',
      start_date: '2099-01-01',
      end_date: '2099-01-05',
      reason: 'Future renovation'
    });
    assert(futureBlockRes.status === 201, 'Created future block (2099-01-01 -> 2099-01-05)');
    const futureBlockId = futureBlockRes.body.data.id;

    // Cancel Future Block -> succeeds (200)
    const cancelFutureRes = await api('PATCH', `/api/room-operational-blocks/${futureBlockId}/cancel`, {
      property_id: propAId,
      cancelled_by: 'FO Manager',
      reason: 'Future renovation cancelled'
    });
    assert(cancelFutureRes.status === 200, 'Future block cancel succeeds');
    assert(cancelFutureRes.body.data.status === 'CANCELLED', 'Future block status is CANCELLED');

    // Cancelled future block contributes ZERO blocked nights
    const futureNightsCheck = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM room_operational_blocks
       WHERE room_id = $1 AND status IN ('ACTIVE', 'RELEASED') AND start_date <= '2099-01-02'::date AND end_date > '2099-01-02'::date`,
      [room102Id]
    );
    assert(futureNightsCheck.rows[0].cnt === 0, 'Cancelled future block contributes zero blocked nights');

    // Cancel already cancelled -> 409 BLOCK_ALREADY_CANCELLED
    const cancelAgain = await api('PATCH', `/api/room-operational-blocks/${futureBlockId}/cancel`, {
      property_id: propAId
    });
    assert(cancelAgain.status === 409, 'Cancelling already cancelled block returns 409');

    // Past-start block cancel rejected:
    // Block 2 has start_date 2026-08-03 (in the past relative to today)
    const cancelPastBlock = await api('PATCH', `/api/room-operational-blocks/${block2.id}/cancel`, {
      property_id: propAId
    });
    assert(cancelPastBlock.status === 409, 'Past-start active block cancel rejected');
    assert(cancelPastBlock.body.code === 'BLOCK_ALREADY_EFFECTIVE', 'Past-start cancel returns BLOCK_ALREADY_EFFECTIVE');

    // Today-start block cancel rejected:
    const nowWib = new Date(Date.now() + 7 * 3600 * 1000);
    const todayWibStr = nowWib.toISOString().slice(0, 10);
    const tmrwWib = new Date(nowWib.getTime() + 24 * 3600 * 1000);
    const tmrwWibStr = tmrwWib.toISOString().slice(0, 10);

    const todayBlockRes = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room102Id,
      block_type: 'OUT_OF_SERVICE',
      start_date: todayWibStr,
      end_date: tmrwWibStr,
      reason: 'Today block'
    });
    if (todayBlockRes.status !== 201) {
      console.error('DEBUG todayBlockRes failed:', todayBlockRes);
    }
    assert(todayBlockRes.status === 201, 'Created today-start block');
    const todayBlockId = todayBlockRes.body.data?.id;

    const cancelTodayBlock = await api('PATCH', `/api/room-operational-blocks/${todayBlockId}/cancel`, {
      property_id: propAId
    });
    assert(cancelTodayBlock.status === 409, 'Today-start block cancel rejected');
    assert(cancelTodayBlock.body.code === 'BLOCK_ALREADY_EFFECTIVE', 'Today-start cancel returns BLOCK_ALREADY_EFFECTIVE');

    // 7c. Same-Day Release:
    // When released today on same-day (releaseDate <= start_date): status becomes CANCELLED, 0 nights blocked
    const sameDayRelease = await api('PATCH', `/api/room-operational-blocks/${todayBlockId}/release`, {
      property_id: propAId,
      effective_release_date: todayWibStr,
      released_by: 'Staff Andi'
    });
    assert(sameDayRelease.status === 200, 'Same-day release returns 200');
    assert(sameDayRelease.body.data.status === 'CANCELLED', 'Same-day release marks status as CANCELLED (0 nights blocked)');

    const todayNightsCheck = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM room_operational_blocks
       WHERE room_id = $1 AND status IN ('ACTIVE', 'RELEASED') AND start_date <= $2::date AND end_date > $2::date`,
      [room102Id, todayWibStr]
    );
    assert(todayNightsCheck.rows[0].cnt === 0, 'Same-day released block contributes 0 blocked nights for today');

    // ==========================================
    // 8. BOOKING ENGINE INTEGRATION
    // ==========================================
    console.log('\n--- 8. Booking Engine Integration ---');

    // Create a new ACTIVE block on Room 101 for Aug 05 -> Aug 08
    const block3Res = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room101Id,
      block_type: 'OUT_OF_ORDER',
      start_date: DATES.AUG_05,
      end_date: DATES.AUG_08,
      reason: 'Flooring replacement'
    });
    assert(block3Res.status === 201, 'Created active block on Room 101 for Aug 05 -> Aug 08');

    // 8a. Booking creation allocating blocked physical room (Room 101 for Aug 06 -> Aug 08) -> 409
    const bookingOnBlockedRoom = await api('POST', '/api/bookings', {
      property_id: propAId,
      guest_name: 'Guest Blocked',
      reservations: [{
        room_id: room101Id,
        room_type_id: roomTypeIdA,
        check_in: DATES.AUG_06,
        check_out: DATES.AUG_08,
        total_price: 1000000
      }]
    });
    assert(bookingOnBlockedRoom.status === 409, 'Booking creation for blocked physical room returns 409');

    // 8b. Legacy reservation creation allocating blocked room -> 409
    const compatBookingBlocked = await api('POST', '/api/reservations', {
      property_id: propAId,
      room_id: room101Id,
      guest_name: 'Guest Compat',
      check_in: DATES.AUG_06,
      check_out: DATES.AUG_08,
      total_price: 1000000
    });
    assert(compatBookingBlocked.status === 409, 'Legacy reservation creation for blocked room returns 409');

    // 8c. Room move to blocked room:
    // res102 is on Room 102 (Aug 05 -> Aug 07). Attempt to move to Room 101 (blocked Aug 05 -> Aug 08) -> 409
    const moveToBlocked = await api('POST', `/api/reservations/${resId}/move`, {
      property_id: propAId,
      to_room_id: room101Id
    });
    assert(moveToBlocked.status === 409, 'Moving reservation to blocked room returns 409');

    // 8d. Stay extension:
    // Create reservation on Room 103 for Aug 01 -> Aug 03
    const resSuiteRes = await pool.query(
      `INSERT INTO reservations (
         booking_id, stay_sequence, room_id, guest_name, check_in, check_out,
         status, stay_status, total_price, payment_status, booked_room_type_id_snapshot, booked_room_type_name_snapshot
       ) VALUES ($1, 2, $2, 'Guest Suite', $3, $4, 'BOOKED', 'RESERVED', 1800000, 'PAID', $5, 'Suite')
       RETURNING id`,
      [bookingId, room103Id, DATES.AUG_01, DATES.AUG_03, roomTypeIdA2]
    );
    const suiteResId = resSuiteRes.rows[0].id;

    // Create block on Room 103 for Aug 04 -> Aug 06
    const blockSuiteRes = await api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room103Id,
      block_type: 'OUT_OF_SERVICE',
      start_date: DATES.AUG_04,
      end_date: DATES.AUG_06
    });
    assert(blockSuiteRes.status === 201, 'Created block on Room 103 for Aug 04 -> Aug 06');

    // Attempt to extend suite reservation to Aug 05 (overlaps block starting Aug 04) -> 409
    const extendToBlocked = await api('POST', `/api/reservations/${suiteResId}/extend`, {
      property_id: propAId,
      new_check_out: DATES.AUG_05
    });
    assert(extendToBlocked.status === 409, 'Extending reservation into future blocked date returns 409');

    // 8e. Check-in on blocked room:
    // If a reservation existed on Room 101 (e.g. booked before block), check-in should reject
    const preRes101 = await pool.query(
      `INSERT INTO reservations (
         booking_id, stay_sequence, room_id, guest_name, check_in, check_out,
         status, stay_status, total_price, payment_status, booked_room_type_id_snapshot, booked_room_type_name_snapshot
       ) VALUES ($1, 3, $2, 'Guest Prior', $3, $4, 'BOOKED', 'RESERVED', 1000000, 'PAID', $5, 'Deluxe King')
       RETURNING id`,
      [bookingId, room101Id, DATES.AUG_06, DATES.AUG_08, roomTypeIdA]
    );
    const preResId = preRes101.rows[0].id;

    const checkinBlocked = await api('POST', `/api/reservations/${preResId}/checkin`, {
      property_id: propAId
    });
    assert(checkinBlocked.status === 409, 'Checking in reservation on blocked room returns 409');

    // ==========================================
    // 9. CONCURRENCY & RACE CONDITIONS
    // ==========================================
    console.log('\n--- 9. Concurrency & Race Conditions ---');

    // Fire 2 concurrent POST requests to block Room 102 on Aug 01 -> Aug 04
    const p1 = api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room102Id,
      block_type: 'OUT_OF_ORDER',
      start_date: DATES.AUG_01,
      end_date: DATES.AUG_04,
      reason: 'Concurrent test 1'
    });
    const p2 = api('POST', '/api/room-operational-blocks', {
      property_id: propAId,
      room_id: room102Id,
      block_type: 'OUT_OF_SERVICE',
      start_date: DATES.AUG_02,
      end_date: DATES.AUG_05,
      reason: 'Concurrent test 2'
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    const statuses = [r1.status, r2.status].sort();
    assert(statuses[0] === 201 && statuses[1] === 409, 'Concurrent overlapping block requests on same room: exactly 1 succeeds (201), 1 fails (409)');

    // ==========================================
    // 10. GET /api/rooms OPERATIONAL BLOCK SNAPSHOT
    // ==========================================
    console.log('\n--- 10. GET /api/rooms Operational Block Snapshot ---');
    const roomsList = await api('GET', `/api/rooms?property_id=${propAId}`);
    assert(roomsList.status === 200, 'GET /api/rooms returns 200');
    assert(Array.isArray(roomsList.body.data), 'GET /api/rooms returns array');

  } finally {
    // Zero session residue teardown
    console.log('\nCleaning up test fixtures...');
    try {
      if (propAId) {
        await pool.query('DELETE FROM room_operational_blocks WHERE property_id = $1', [propAId]);
        await pool.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [propAId]);
        await pool.query('DELETE FROM bookings WHERE property_id = $1', [propAId]);
        await pool.query('DELETE FROM maintenance_tasks WHERE property_id = $1', [propAId]);
        await pool.query('DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = $1)', [propAId]);
        await pool.query('DELETE FROM rooms WHERE property_id = $1', [propAId]);
        await pool.query('DELETE FROM room_types WHERE property_id = $1', [propAId]);
        await pool.query('DELETE FROM audit_logs WHERE property_id = $1', [propAId]);
        await pool.query('DELETE FROM properties WHERE id = $1', [propAId]);
      }
      if (propBId) {
        await pool.query('DELETE FROM room_operational_blocks WHERE property_id = $1', [propBId]);
        await pool.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [propBId]);
        await pool.query('DELETE FROM bookings WHERE property_id = $1', [propBId]);
        await pool.query('DELETE FROM maintenance_tasks WHERE property_id = $1', [propBId]);
        await pool.query('DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = $1)', [propBId]);
        await pool.query('DELETE FROM rooms WHERE property_id = $1', [propBId]);
        await pool.query('DELETE FROM room_types WHERE property_id = $1', [propBId]);
        await pool.query('DELETE FROM audit_logs WHERE property_id = $1', [propBId]);
        await pool.query('DELETE FROM properties WHERE id = $1', [propBId]);
      }
    } catch (cleanupErr) {
      console.error('Cleanup error:', cleanupErr);
    }

    if (server) {
      server.close();
    }
  }

  console.log(`\n=== Test Summary: ${passed} PASSED, ${failed} FAILED ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
