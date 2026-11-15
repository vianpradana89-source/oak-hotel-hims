/**
 * Backend tests for Complimentary APPROVED mutation guard.
 *
 * Verifies that an APPROVED complimentary request blocks protected mutations
 * (room, room type, rate plan, dates, stay type, check-in/out time) across
 * three write paths:
 *   1. reservation edit (conditional — metadata-only allowed)
 *   2. room move (always protected)
 *   3. booked reservation repricing (always protected)
 *
 * Also verifies: REVOKED / PENDING_APPROVAL do NOT block, property isolation,
 * no partial writes on blocked mutation, and idempotent room-move replay is
 * not corrupted by a subsequently-approved complimentary.
 */
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

// ---------------------------------------------------------------------------
// Imports (dist — must be compiled first)
// ---------------------------------------------------------------------------
const { initializeDatabase } = require('../dist/db/schema_v3');
const {
  executeReservationEdit
} = require('../dist/domains/reservations/reservationEditService');
const {
  executeRoomMove
} = require('../dist/domains/reservations/roomMoveService');
const {
  executeBookedReservationReprice
} = require('../dist/domains/reservations/bookedReservationRepriceService');
const complimentary = require('../dist/domains/reservations/complimentaryService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const tag = 'CMG' + String(Date.now()).slice(-8);
const tracked = { propertyId: null, bookingIds: [], reservationIds: [] };
let _propertySeq = 0;

async function setupProperty() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    _propertySeq += 1;
    // Generate a 6-char alphanumeric code that won't collide with existing rows
    const codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += codeChars[Math.floor(Math.random() * codeChars.length)];
    const prop = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1,$2,'Asia/Jakarta','IDR','Guard Test',TRUE) RETURNING id`,
      [tag + '-PROP-' + _propertySeq, code]
    );
    const propertyId = Number(prop.rows[0].id);
    tracked.propertyId = propertyId;

    await client.query(
      `INSERT INTO property_pricing_settings (property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service)
       VALUES ($1,0,0,FALSE,FALSE)`,
      [propertyId]
    );

    const cat = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active)
       VALUES ($1,'CAT1','Category 1',TRUE) RETURNING id`,
      [propertyId]
    );
    const catId = Number(cat.rows[0].id);

    // Two room types so we can move between them
    const types = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity, is_active)
       VALUES ($1,$2,'T1','Type One',100000,2,TRUE),
              ($1,$2,'T2','Type Two',150000,2,TRUE)
       RETURNING id, code`,
      [propertyId, catId]
    );
    const type1 = Number(types.rows.find(r => r.code === 'T1').id);
    const type2 = Number(types.rows.find(r => r.code === 'T2').id);

    const rooms = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1,$2,'101','R101','VACANT_CLEAN',TRUE),
              ($1,$2,'102','R102','VACANT_CLEAN',TRUE),
              ($1,$2,'103','R103','VACANT_CLEAN',TRUE),
              ($1,$3,'201','R201','VACANT_CLEAN',TRUE),
              ($1,$3,'202','R202','VACANT_CLEAN',TRUE)
       RETURNING id, room_number`,
      [propertyId, type1, type2]
    );
    const room = n => Number(rooms.rows.find(r => r.room_number === n).id);

    const plans = await client.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, meal_plan, rate_type, is_active, sort_order)
       VALUES ($1,$2,'RP1','RP Type One',100000,'RO','OVERNIGHT',TRUE,0),
              ($1,$3,'RP2','RP Type Two',150000,'RO','OVERNIGHT',TRUE,0)
       RETURNING id, room_type_id`,
      [propertyId, type1, type2]
    );
    const rp1 = Number(plans.rows[0].id);
    const rp2 = Number(plans.rows[1].id);

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const checkOut = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);

    for (const [tid, label] of [[type1, 'Type One'], [type2, 'Type Two']]) {
      for (const date of [today, tomorrow]) {
        await client.query(
          `INSERT INTO availability_dates (room_type_id, room_type, date, total_rooms, reserved_qty)
           VALUES ($1,$2,$3,10,0) ON CONFLICT DO NOTHING`,
          [tid, label, date]
        );
      }
    }

    await client.query('COMMIT');
    return { propertyId, type1, type2, rp1, rp2, room, today, tomorrow, checkOut };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Helpers for OTA-capable test fixtures
// ---------------------------------------------------------------------------
async function setupOtaSource(propertyId) {
  const ota = await pool.query(
    `INSERT INTO ota_sources (property_id, code, name)
     VALUES ($1,'TEST-OTA','Test OTA') RETURNING id`,
    [propertyId]
  );
  return Number(ota.rows[0].id);
}

async function createBookingAndReservation(fixture, suffix, opts = {}) {
  const { propertyId, room, today, checkOut, type1 } = fixture;
  const roomId = opts.roomId || room('101');
  const typeId = opts.typeId || type1;
  const totalPrice = opts.totalPrice || 200000;
  const status = opts.status || 'BOOKED';
  const effectiveOtaSourceId = opts.ota_source_id !== undefined ? opts.ota_source_id : null;

  // bid must match ^[A-Z0-9-]+$ (uppercase only, no hyphens at start)
  const bid = `CMP-${tag}-${suffix}`.toUpperCase().replace(/[^A-Z0-9-]/g, '-');
  const booking = await pool.query(
    `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
     VALUES ($1,$2,$3,'ACTIVE') RETURNING id`,
    [propertyId, bid, suffix]
  );
  const bookingId = Number(booking.rows[0].id);
  tracked.bookingIds.push(bookingId);

  const reservation = await pool.query(
    `INSERT INTO reservations (
       booking_id, room_id, booked_room_type_id_snapshot, rate_plan_id,
       guest_name, check_in, check_out, subtotal_amount, service_amount,
       tax_amount, total_price, amount_paid, applied_deposit,
       remaining_balance, status, payment_status, stay_type, stay_sequence,
       ota_source_id
     ) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,0,0,$7,0,0,$7,$8,'UNPAID','OVERNIGHT',1,$9)
     RETURNING id`,
    [bookingId, roomId, typeId, suffix, today, checkOut, totalPrice, status, effectiveOtaSourceId]
  );
  const reservationId = Number(reservation.rows[0].id);
  tracked.reservationIds.push(reservationId);

  // Nightly rates (required for complimentary financial calc)
  await pool.query(
    `INSERT INTO reservation_nightly_rates (reservation_id, property_id, stay_date, room_type_id, base_rate, final_room_rate, total_amount)
     VALUES ($1,$2,$3,$4,100000,100000,100000),
            ($1,$2,$5,$4,100000,100000,100000)`,
    [reservationId, propertyId, today, typeId, checkOut]
  );

  // Initial ROOM_CHARGE folio entry
  await pool.query(
    `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction)
     VALUES ($1,$2,'ROOM_CHARGE','Room charge', $3, 'DEBIT')`,
    [reservationId, propertyId, totalPrice]
  );

  // Create a guest record so syncPrimaryGuestFromReservation can find it
  const guest = await pool.query(
    `INSERT INTO guests (full_name, phone, created_property_id)
     VALUES ($1,$2,$3) RETURNING id`,
    [suffix, '0000000000', propertyId]
  );
  await pool.query(
    `INSERT INTO reservation_guests (reservation_id, guest_id, role, is_staying)
     VALUES ($1,$2,'PRIMARY_GUEST',TRUE)`,
    [reservationId, guest.rows[0].id]
  );

  return { bookingId, reservationId };
}

async function approveComplimentary(reservationId, propertyId) {
  const reqActor = { userId: '1', username: 'fo', full_name: 'FO', role: 'FO', property_id: propertyId };
  const actor = { userId: '1', username: 'admin', full_name: 'Admin', role: 'Super Admin', property_id: propertyId };

  const req = await complimentary.createComplimentaryRequest(pool, {
    reservationId,
    propertyId,
    category: 'VIP',
    reason: 'Test guard',
    idempotencyKey: `${tag}-req-${reservationId}`,
    requestor: reqActor
  });
  assert.strictEqual(req.status, 'PENDING_APPROVAL', 'request should start as PENDING_APPROVAL');

  const approved = await complimentary.approveComplimentaryRequest(pool, {
    requestId: req.id,
    reservationId,
    propertyId,
    actor
  });
  assert.strictEqual(approved.request.status, 'APPROVED', 'should be APPROVED after approval');
  return { requestId: req.id, approval: approved };
}

async function revokeComplimentary(requestId, reservationId, propertyId) {
  const actor = { userId: '1', username: 'admin', full_name: 'Admin', role: 'Super Admin', property_id: propertyId };
  const result = await complimentary.revokeComplimentaryRequest(pool, {
    requestId,
    reservationId,
    propertyId,
    reason: 'Test cleanup',
    actor
  });
  assert.strictEqual(result.request.status, 'REVOKED', 'should be REVOKED after revoke');
  return result;
}

async function cleanupAll() {
  const client = await pool.connect();
  try {
    if (tracked.reservationIds.length) {
      await client.query('DELETE FROM reservation_complimentary_requests WHERE reservation_id = ANY($1)', [tracked.reservationIds]).catch(() => {});
      await client.query('DELETE FROM reservation_room_moves WHERE reservation_id = ANY($1)', [tracked.reservationIds]).catch(() => {});
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1)', [tracked.reservationIds]).catch(() => {});
      await client.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1)', [tracked.reservationIds]).catch(() => {});
      await client.query('DELETE FROM transactions WHERE reservation_id = ANY($1)', [tracked.reservationIds]).catch(() => {});
      await client.query('DELETE FROM transaction_items WHERE transaction_id IN (SELECT id FROM transactions WHERE reservation_id = ANY($1))', [tracked.reservationIds]).catch(() => {});
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1)', [tracked.reservationIds]).catch(() => {});
      await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1)', [tracked.reservationIds]).catch(() => {});
      await client.query('DELETE FROM reservations WHERE id = ANY($1)', [tracked.reservationIds]);
    }
    if (tracked.bookingIds.length) {
      await client.query('DELETE FROM bookings WHERE id = ANY($1)', [tracked.bookingIds]);
    }
    if (tracked.propertyId) {
      await client.query('DELETE FROM audit_logs WHERE property_id = $1', [tracked.propertyId]).catch(() => {});
      await client.query('DELETE FROM availability_dates WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = $1)', [tracked.propertyId]).catch(() => {});
      await client.query('DELETE FROM room_operational_blocks WHERE property_id = $1', [tracked.propertyId]).catch(() => {});
      await client.query('DELETE FROM housekeeping_tasks WHERE property_id = $1', [tracked.propertyId]).catch(() => {});
      await client.query('DELETE FROM ota_sources WHERE property_id = $1', [tracked.propertyId]).catch(() => {});
      await client.query('DELETE FROM rate_overrides WHERE property_id = $1', [tracked.propertyId]).catch(() => {});
      await client.query('DELETE FROM rate_plans WHERE property_id = $1', [tracked.propertyId]).catch(() => {});
      await client.query('DELETE FROM rooms WHERE property_id = $1', [tracked.propertyId]).catch(() => {});
      await client.query('DELETE FROM room_types WHERE property_id = $1', [tracked.propertyId]).catch(() => {});
      await client.query('DELETE FROM room_categories WHERE property_id = $1', [tracked.propertyId]).catch(() => {});
      await client.query('DELETE FROM property_pricing_settings WHERE property_id = $1', [tracked.propertyId]).catch(() => {});
      await client.query('DELETE FROM properties WHERE id = $1', [tracked.propertyId]);
    }
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// T1: APPROVED blocks protected reservation edit -> 409 + COMPLIMENTARY_APPROVED_MUTATION_LOCK
// ---------------------------------------------------------------------------
async function test1_approvedBlocksProtectedEdit() {
  console.log('\n=== T1: APPROVED blocks protected reservation edit ===');
  const fixture = await setupProperty();
  const { reservationId } = await createBookingAndReservation(fixture, 't1-edit');
  const { requestId } = await approveComplimentary(reservationId, fixture.propertyId);

  try {
    await executeReservationEdit(pool, reservationId, {
      property_id: fixture.propertyId,
      room_id: fixture.room('102'),
      room_type_id: fixture.type1,
      check_in: fixture.today,
      check_out: fixture.checkOut,
      actor: 'tester'
    });
    throw new Error('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.statusCode, 409, `expected 409, got ${err.statusCode}`);
    assert.strictEqual(err.code, 'COMPLIMENTARY_APPROVED_MUTATION_LOCK', `expected COMPLIMENTARY_APPROVED_MUTATION_LOCK, got ${err.code}`);
    console.log('  [OK] 409 + COMPLIMENTARY_APPROVED_MUTATION_LOCK');
  } finally {
    await revokeComplimentary(requestId, reservationId, fixture.propertyId);
  }
  console.log('  PASS');
}

// ---------------------------------------------------------------------------
// T2: REVOKED does NOT block protected reservation edit
// ---------------------------------------------------------------------------
async function test2_revokedAllowsProtectedEdit() {
  console.log('\n=== T2: REVOKED does not block protected reservation edit ===');
  const fixture = await setupProperty();
  const { reservationId } = await createBookingAndReservation(fixture, 't2-edit');
  const { requestId } = await approveComplimentary(reservationId, fixture.propertyId);
  await revokeComplimentary(requestId, reservationId, fixture.propertyId);

  try {
    const result = await executeReservationEdit(pool, reservationId, {
      property_id: fixture.propertyId,
      room_id: fixture.room('102'),
      room_type_id: fixture.type1,
      check_in: fixture.today,
      check_out: fixture.checkOut,
      actor: 'tester'
    });
    assert(result, 'should return result');
    console.log('  [OK] Edit succeeded after revoke');
  } finally {
    // cleanup handled by cleanupAll
  }
  console.log('  PASS');
}

// ---------------------------------------------------------------------------
// T3: PENDING_APPROVAL does NOT block protected reservation edit
// ---------------------------------------------------------------------------
async function test3_pendingDoesNotBlock() {
  console.log('\n=== T3: PENDING_APPROVAL does not block protected reservation edit ===');
  const fixture = await setupProperty();
  const { reservationId } = await createBookingAndReservation(fixture, 't3-edit');
  const reqActor = { userId: '1', username: 'fo', full_name: 'FO', role: 'FO', property_id: fixture.propertyId };

  await complimentary.createComplimentaryRequest(pool, {
    reservationId,
    propertyId: fixture.propertyId,
    category: 'VIP',
    reason: 'Still pending',
    idempotencyKey: `${tag}-pending-${reservationId}`,
    requestor: reqActor
  });

  try {
    const result = await executeReservationEdit(pool, reservationId, {
      property_id: fixture.propertyId,
      room_id: fixture.room('102'),
      room_type_id: fixture.type1,
      check_in: fixture.today,
      check_out: fixture.checkOut,
      actor: 'tester'
    });
    assert(result, 'should return result');
    console.log('  [OK] Edit succeeded while request is PENDING_APPROVAL');
  } finally {
    // cleanup
  }
  console.log('  PASS');
}

// ---------------------------------------------------------------------------
// T4: Metadata-only edit allowed when Complimentary is APPROVED
// ---------------------------------------------------------------------------
async function test4_metadataOnlyAllowed() {
  console.log('\n=== T4: Metadata-only edit allowed with APPROVED complimentary ===');
  const fixture = await setupProperty();
  const { reservationId } = await createBookingAndReservation(fixture, 't4-meta');
  const { requestId } = await approveComplimentary(reservationId, fixture.propertyId);

  try {
    const result = await executeReservationEdit(pool, reservationId, {
      property_id: fixture.propertyId,
      guest_name: 'New Guest Name',
      guest_phone: '081234567890',
      booker_name: 'New Booker',
      referral: 'WALKIN',
      notes: 'Test notes',
      actor: 'tester'
    });
    assert(result, 'should return result');
    console.log('  [OK] Metadata-only edit allowed with APPROVED complimentary');
  } finally {
    await revokeComplimentary(requestId, reservationId, fixture.propertyId);
  }
  console.log('  PASS');
}

// ---------------------------------------------------------------------------
// T5: APPROVED blocks room move
// ---------------------------------------------------------------------------
async function test5_approvedBlocksRoomMove() {
  console.log('\n=== T5: APPROVED blocks room move ===');
  const fixture = await setupProperty();
  const { reservationId } = await createBookingAndReservation(fixture, 't5-move', { status: 'CHECKED_IN' });
  await pool.query(`UPDATE reservations SET status='CHECKED_IN' WHERE id=$1`, [reservationId]);
  await pool.query(`UPDATE rooms SET status='OCCUPIED_CLEAN' WHERE id=$1 AND property_id=$2`, [fixture.room('101'), fixture.propertyId]);
  const { requestId } = await approveComplimentary(reservationId, fixture.propertyId);

  try {
    await executeRoomMove(pool, reservationId, {
      property_id: fixture.propertyId,
      to_room_id: fixture.room('102'),
      reason_category: 'GUEST_REQUEST',
      reason_detail: 'Guest request',
      pricing_treatment: 'KEEP_CURRENT_RATE'
    }, { id: 1, full_name: 'FO Tester', role: 'Front Office' });
    throw new Error('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.statusCode, 409, `expected 409, got ${err.statusCode}`);
    assert.strictEqual(err.code, 'COMPLIMENTARY_APPROVED_MUTATION_LOCK', `expected COMPLIMENTARY_APPROVED_MUTATION_LOCK, got ${err.code}`);
    console.log('  [OK] 409 + COMPLIMENTARY_APPROVED_MUTATION_LOCK on room move');
  } finally {
    await revokeComplimentary(requestId, reservationId, fixture.propertyId);
  }
  console.log('  PASS');
}

// ---------------------------------------------------------------------------
// T6: APPROVED blocks booked repricing
// ---------------------------------------------------------------------------
async function test6_approvedBlocksReprice() {
  console.log('\n=== T6: APPROVED blocks booked repricing ===');
  const fixture = await setupProperty();
  const { reservationId } = await createBookingAndReservation(fixture, 't6-reprice');
  const { requestId } = await approveComplimentary(reservationId, fixture.propertyId);

  try {
    await executeBookedReservationReprice(pool, reservationId, {
      property_id: fixture.propertyId,
      rate_plan_id: fixture.rp1,
      reason: 'Test repricing guard'
    });
    throw new Error('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.statusCode, 409, `expected 409, got ${err.statusCode}`);
    assert.strictEqual(err.code, 'COMPLIMENTARY_APPROVED_MUTATION_LOCK', `expected COMPLIMENTARY_APPROVED_MUTATION_LOCK, got ${err.code}`);
    console.log('  [OK] 409 + COMPLIMENTARY_APPROVED_MUTATION_LOCK on repricing');
  } finally {
    await revokeComplimentary(requestId, reservationId, fixture.propertyId);
  }
  console.log('  PASS');
}

// ---------------------------------------------------------------------------
// T7: Guard prevents partial writes before error
// ---------------------------------------------------------------------------
async function test7_noPartialWrites() {
  console.log('\n=== T7: Guard prevents partial writes before error ===');
  const fixture = await setupProperty();
  const { reservationId } = await createBookingAndReservation(fixture, 't7-partial');
  const originalRoomId = fixture.room('101');
  const { requestId } = await approveComplimentary(reservationId, fixture.propertyId);

  try {
    await executeReservationEdit(pool, reservationId, {
      property_id: fixture.propertyId,
      room_id: fixture.room('102'),
      room_type_id: fixture.type1,
      check_in: fixture.today,
      check_out: fixture.checkOut,
      actor: 'tester'
    });
    throw new Error('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.statusCode, 409);
    assert.strictEqual(err.code, 'COMPLIMENTARY_APPROVED_MUTATION_LOCK');
  }

  // Verify no partial write occurred — room_id should be unchanged
  const afterCheck = await pool.query(`SELECT room_id, total_price FROM reservations WHERE id=$1`, [reservationId]);
  assert.strictEqual(Number(afterCheck.rows[0].room_id), originalRoomId, 'room_id should be unchanged after blocked edit');
  console.log('  [OK] No partial write — room_id unchanged');

  // Verify no folio/nightly-rate changes
  const nightlyCount = await pool.query(`SELECT COUNT(*)::int AS cnt FROM reservation_nightly_rates WHERE reservation_id=$1`, [reservationId]);
  assert.strictEqual(nightlyCount.rows[0].cnt, 2, 'nightly rates count should be unchanged');
  console.log('  [OK] No partial write — nightly rates unchanged');

  await revokeComplimentary(requestId, reservationId, fixture.propertyId);
  console.log('  PASS');
}

// ---------------------------------------------------------------------------
// T8: Property isolation — APPROVED on one property doesn't block another
// ---------------------------------------------------------------------------
async function test8_propertyIsolation() {
  console.log('\n=== T8: Property isolation ===');
  const fixtureA = await setupProperty();
  const fixtureB = await setupProperty();

  const { reservationId: resA } = await createBookingAndReservation(fixtureA, 't8-a');
  const { reservationId: resB } = await createBookingAndReservation(fixtureB, 't8-b');

  // Approve complimentary on property A's reservation
  const { requestId: reqIdA } = await approveComplimentary(resA, fixtureA.propertyId);

  try {
    // Property B's reservation should NOT be blocked
    const result = await executeReservationEdit(pool, resB, {
      property_id: fixtureB.propertyId,
      room_id: fixtureB.room('102'),
      room_type_id: fixtureB.type1,
      check_in: fixtureB.today,
      check_out: fixtureB.checkOut,
      actor: 'tester'
    });
    assert(result, 'should succeed for different property');
    console.log('  [OK] Different-property reservation not blocked');
  } finally {
    await revokeComplimentary(reqIdA, resA, fixtureA.propertyId);
  }
  console.log('  PASS');
}

// ---------------------------------------------------------------------------
// T9: Idempotent room-move replay not broken by subsequent complimentary approval
// ---------------------------------------------------------------------------
async function test9_idempotentRoomMoveReplay() {
  console.log('\n=== T9: Idempotent room-move replay not broken by later approval ===');
  const fixture = await setupProperty();
  const { reservationId } = await createBookingAndReservation(fixture, 't9-move', { status: 'CHECKED_IN' });
  await pool.query(`UPDATE reservations SET status='CHECKED_IN' WHERE id=$1`, [reservationId]);
  await pool.query(`UPDATE rooms SET status='OCCUPIED_CLEAN' WHERE id=$1 AND property_id=$2`, [fixture.room('101'), fixture.propertyId]);

  const actor = { id: 1, full_name: 'FO Tester', role: 'Front Office' };
  const payload = {
    property_id: fixture.propertyId,
    to_room_id: fixture.room('102'),
    reason_category: 'GUEST_REQUEST',
    reason_detail: 'Guest request',
    pricing_treatment: 'KEEP_CURRENT_RATE',
    idempotency_key: `${tag}-t9-idem`
  };

  // First move — should succeed
  const firstMove = await executeRoomMove(pool, reservationId, payload, actor);
  assert(firstMove.movement, 'first move should succeed');
  console.log('  [OK] First move succeeded');

  // Now approve a complimentary request on the SAME reservation
  const { requestId } = await approveComplimentary(reservationId, fixture.propertyId);

  try {
    // Replay with same idempotency key — should return prior success, NOT 409
    const replay = await executeRoomMove(pool, reservationId, payload, actor);
    assert(replay.movement, 'replay should return prior success');
    assert.strictEqual(Number(replay.movement.id), Number(firstMove.movement.id), 'replay should return same movement record');
    console.log('  [OK] Idempotent replay returns prior success, not 409');
  } finally {
    await revokeComplimentary(requestId, reservationId, fixture.propertyId);
  }
  console.log('  PASS');
}

// ---------------------------------------------------------------------------
// T10: Same stay_type value — no repricing, metadata still allowed
// ---------------------------------------------------------------------------
async function test10_sameStayTypeNoReprice() {
  console.log('\n=== T10: Same stay_type value does not trigger repricing ===');
  const fixture = await setupProperty();
  const { reservationId } = await createBookingAndReservation(fixture, 't10-same');
  const { requestId } = await approveComplimentary(reservationId, fixture.propertyId);

  // Capture BEFORE snapshot
  const preNightly = await pool.query(
    `SELECT id, stay_date, room_type_id, rate_plan_id, base_rate, final_room_rate, total_amount
     FROM reservation_nightly_rates WHERE reservation_id = $1 ORDER BY stay_date, id`,
    [reservationId]
  );
  const preRes = await pool.query(
    `SELECT total_price, subtotal_amount, service_amount, tax_amount
     FROM reservations WHERE id = $1`, [reservationId]
  );

  try {
    const result = await executeReservationEdit(pool, reservationId, {
      property_id: fixture.propertyId,
      stay_type: 'OVERNIGHT',
      guest_name: 'Same Value StayType',
      actor: 'tester'
    });
    assert(result, 'metadata edit should succeed with same stay_type');
    assert.strictEqual(result.guest_name, 'Same Value StayType', 'guest_name must have changed');

    // Verify nightly rates NOT mutated
    const postNightly = await pool.query(
      `SELECT id, stay_date, room_type_id, rate_plan_id, base_rate, final_room_rate, total_amount
       FROM reservation_nightly_rates WHERE reservation_id = $1 ORDER BY stay_date, id`,
      [reservationId]
    );
    assert.deepStrictEqual(postNightly.rows, preNightly.rows,
      'nightly rates must be identical — no repricing triggered by same-value stay_type');

    // Verify reservation pricing totals unchanged
    const postRes = await pool.query(
      `SELECT total_price, subtotal_amount, service_amount, tax_amount
       FROM reservations WHERE id = $1`, [reservationId]
    );
    assert.deepStrictEqual(postRes.rows[0], preRes.rows[0],
      'reservation pricing totals must be unchanged after same-value stay_type edit');
    console.log('  [OK] Same stay_type value does not trigger repricing');
  } finally {
    await revokeComplimentary(requestId, reservationId, fixture.propertyId);
  }
  console.log('  PASS');
}

// ---------------------------------------------------------------------------
// T11: APPROVED + OTA metadata-only edit — pricing/nightly snapshots unchanged
// ---------------------------------------------------------------------------
async function test11_otaMetadataNoSnapshotMutation() {
  console.log('\n=== T11: OTA metadata-only edit does not mutate snapshots ===');
  const fixture = await setupProperty();
  const otaSourceId = await setupOtaSource(fixture.propertyId);
  const { bookingId, reservationId } = await createBookingAndReservation(fixture, 't11-ota', { ota_source_id: otaSourceId });

  // Verify OTA source is actually set on reservation
  const verifyOta = await pool.query(`SELECT ota_source_id FROM reservations WHERE id = $1`, [reservationId]);
  assert.strictEqual(Number(verifyOta.rows[0].ota_source_id), otaSourceId,
    'reservation must have valid OTA source from fixture');
  const { requestId } = await approveComplimentary(reservationId, fixture.propertyId);

  // Capture FULL nightly rates snapshot BEFORE
  const preNightly = await pool.query(
    `SELECT id, stay_date, room_type_id, rate_plan_id, base_rate, final_room_rate, total_amount
     FROM reservation_nightly_rates WHERE reservation_id = $1 ORDER BY stay_date, id`,
    [reservationId]
  );
  // Capture ROOM_CHARGE folio entry BEFORE
  const preFolio = await pool.query(
    `SELECT id, entry_type, amount, direction, description
     FROM folio_entries WHERE reservation_id = $1 AND entry_type = 'ROOM_CHARGE' AND is_voided = FALSE
     ORDER BY id`,
    [reservationId]
  );

  try {
    const result = await executeReservationEdit(pool, reservationId, {
      property_id: fixture.propertyId,
      guest_name: 'OTA Metadata Edit',
      actor: 'tester'
    });
    assert(result, 'OTA metadata edit should succeed');
    assert.strictEqual(result.guest_name, 'OTA Metadata Edit', 'guest_name must have changed');

    // Verify nightly rates NOT mutated — deep snapshot comparison
    const postNightly = await pool.query(
      `SELECT id, stay_date, room_type_id, rate_plan_id, base_rate, final_room_rate, total_amount
       FROM reservation_nightly_rates WHERE reservation_id = $1 ORDER BY stay_date, id`,
      [reservationId]
    );
    assert.deepStrictEqual(postNightly.rows, preNightly.rows,
      'nightly rates snapshot must be identical before and after OTA metadata-only edit');

    // Verify ROOM_CHARGE folio not mutated
    const postFolio = await pool.query(
      `SELECT id, entry_type, amount, direction, description
       FROM folio_entries WHERE reservation_id = $1 AND entry_type = 'ROOM_CHARGE' AND is_voided = FALSE
       ORDER BY id`,
      [reservationId]
    );
    assert.deepStrictEqual(postFolio.rows, preFolio.rows,
      'ROOM_CHARGE folio must be identical before and after OTA metadata-only edit');

    console.log('  [OK] OTA metadata-only edit did not mutate pricing snapshots');
  } finally {
    await revokeComplimentary(requestId, reservationId, fixture.propertyId);
    // cleanup
    await pool.query(`DELETE FROM complimentary_requests WHERE reservation_id = $1`, [reservationId]).catch(() => {});
    await pool.query(`DELETE FROM reservations WHERE id = $1`, [reservationId]).catch(() => {});
    await pool.query(`DELETE FROM bookings WHERE id = $1`, [bookingId]).catch(() => {});
  }
  console.log('  PASS');
}

// ---------------------------------------------------------------------------
// T12: APPROVED + OTA protected mutation — still blocked with 409
// ---------------------------------------------------------------------------
async function test12_otaProtectedMutationStillBlocked() {
  console.log('\n=== T12: OTA protected mutation still blocked by APPROVED complimentary ===');
  const fixture = await setupProperty();
  const otaSourceId = await setupOtaSource(fixture.propertyId);
  const { bookingId, reservationId } = await createBookingAndReservation(fixture, 't12-ota', { ota_source_id: otaSourceId });

  // Verify OTA source is actually set on reservation
  const verifyOta = await pool.query(`SELECT ota_source_id FROM reservations WHERE id = $1`, [reservationId]);
  assert.strictEqual(Number(verifyOta.rows[0].ota_source_id), otaSourceId,
    'reservation must have valid OTA source from fixture');
  const { requestId } = await approveComplimentary(reservationId, fixture.propertyId);

  try {
    await executeReservationEdit(pool, reservationId, {
      property_id: fixture.propertyId,
      room_id: fixture.room('102'),
      room_type_id: fixture.type1,
      check_in: fixture.today,
      check_out: fixture.checkOut,
      actor: 'tester'
    });
    throw new Error('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.statusCode, 409, `expected 409, got ${err.statusCode}`);
    assert.strictEqual(err.code, 'COMPLIMENTARY_APPROVED_MUTATION_LOCK', `expected COMPLIMENTARY_APPROVED_MUTATION_LOCK, got ${err.code}`);
    console.log('  [OK] 409 COMPLIMENTARY_APPROVED_MUTATION_LOCK on OTA protected mutation');

    // Verify no partial write
    const afterRes = await pool.query(
      `SELECT room_id FROM reservations WHERE id = $1`, [reservationId]
    );
    assert.strictEqual(Number(afterRes.rows[0].room_id), fixture.room('101'),
      'room_id must not be mutated on 409');
    console.log('  [OK] No partial write — room_id unchanged after blocked OTA edit');
  } finally {
    await revokeComplimentary(requestId, reservationId, fixture.propertyId);
    // cleanup
    await pool.query(`DELETE FROM complimentary_requests WHERE reservation_id = $1`, [reservationId]).catch(() => {});
    await pool.query(`DELETE FROM reservations WHERE id = $1`, [reservationId]).catch(() => {});
    await pool.query(`DELETE FROM bookings WHERE id = $1`, [bookingId]).catch(() => {});
  }
  console.log('  PASS');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== COMPLIMENTARY MUTATION GUARD TESTS ===');
  try {
    await initializeDatabase(pool);
    await test1_approvedBlocksProtectedEdit();
    await test2_revokedAllowsProtectedEdit();
    await test3_pendingDoesNotBlock();
    await test4_metadataOnlyAllowed();
    await test5_approvedBlocksRoomMove();
    await test6_approvedBlocksReprice();
    await test7_noPartialWrites();
    await test8_propertyIsolation();
    await test9_idempotentRoomMoveReplay();
    await test10_sameStayTypeNoReprice();
    await test11_otaMetadataNoSnapshotMutation();
    await test12_otaProtectedMutationStillBlocked();
    console.log('\n=== ALL TESTS PASSED ===');
    process.exit(0);
  } catch (err) {
    console.error('\n=== TEST FAILED ===');
    console.error(err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await cleanupAll();
    await pool.end();
  }
}

main();
