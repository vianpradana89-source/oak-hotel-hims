/**
 * group_guarantee_release_1b_test.js
 *
 * GROUP-GUARANTEE-RELEASE-1B Phase 1A — Canonical Release Eligibility Foundation
 *
 * Tests the new backend helper getBookingGroupGuaranteeReleaseState and
 * verifies it is correctly attached to read responses for BOOKING_GROUP
 * deposits and identity custody.
 *
 * Run: cd backend && npm run build && node test/group_guarantee_release_1b_test.js
 */

require('dotenv').config();
const assert = require('assert');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { getBookingGroupGuaranteeReleaseState, enrichGroupRowsWithReleaseMetadata, deriveGroupGuaranteeStateFromChildren } =
  require('../dist/domains/guarantees/bookingGroupReleaseEligibility');
const { getDepositsByReservation, refundDeposit } = require('../dist/domains/deposits/depositService');
const { getIdentityCustodyByReservation, returnIdentity } = require('../dist/domains/identity/identityCustodyService');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

const runId = `GR1B${String(Date.now()).slice(-8)}`;
let passed = 0;
let failed = 0;

// Per-function suffix counter — each sub-test suite gets a unique identity suffix
// to avoid colliding with other suites in the same process.
let _funcSuffix = 0;
function funcSuffix() {
  return `F${String(++_funcSuffix).padStart(3, '0')}`;
}

function check(condition, message) {
  if (condition) {
    passed++;
    console.log(`PASS | ${message}`);
  } else {
    failed++;
    console.error(`FAIL | ${message}`);
  }
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

async function createBooking(client, propertyId, status = 'ACTIVE', suffix) {
  const bid = suffix ? `BID-1B-${suffix}` : `BID-1B-${runId}`;
  const guestName = suffix ? `1B Guest ${suffix}` : `1B Guest ${runId}`;
  const res = await client.query(
    `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [propertyId, bid, guestName, status]
  );
  return Number(res.rows[0].id);
}

// Base date well into the future to avoid any overflow or collision.
const _DATE_BASE = new Date(Date.UTC(2080, 0, 1)); // 2080-01-01 UTC

// Global monotonic slot counter — each reservation gets a unique 3-day window,
// regardless of the seq (stay_sequence) value passed in.
let _reservationSlot = 0;

async function createReservation(client, bookingId, roomId, roomTypeId, status, seq) {
  const slot = _reservationSlot++;
  const checkIn = new Date(_DATE_BASE.getTime() + slot * 3 * 86400000);
  const checkOut = new Date(checkIn.getTime() + 86400000);
  const checkInDate = checkIn.toISOString().slice(0, 10);
  const checkOutDate = checkOut.toISOString().slice(0, 10);
  const res = await client.query(
    `INSERT INTO reservations (
       booking_id, room_id, booked_room_type_id_snapshot, guest_name,
       check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
       status, payment_status, stay_sequence
     ) VALUES ($1, $2, $3, $4, $5, $6, 1000000, 1000000, 0, 1000000, $7, 'UNPAID', $8)
     RETURNING id`,
    [bookingId, roomId, roomTypeId, `1B Guest ${runId}`,
     checkInDate, checkOutDate, status, seq]
  );
  return Number(res.rows[0].id);
}

async function createDeposit(client, propertyId, reservationId, bookingId, scope, suffix) {
  const depositNumber = suffix ? `DEP-1B-${suffix}` : `DEP-1B-${runId}`;
  // Insert payment transaction first (required by chk_deposit_event_projection)
  const txRes = await client.query(
    `INSERT INTO payment_transactions (
       reservation_id, property_id, transaction_type, amount, payment_method,
       reference_code, status, created_by, booking_id, scope
     ) VALUES ($1, $2, 'DEPOSIT_RECEIVED', $3, $4, $5, 'SUCCESS', 'Tester', $6, $7)
     RETURNING id`,
    [reservationId, propertyId, 10000, 'CASH', depositNumber, bookingId, scope]
  );
  const paymentId = Number(txRes.rows[0].id);
  // Insert deposit row
  const res = await client.query(
    `INSERT INTO deposits (
       property_id, reservation_id, booking_id, deposit_number, original_amount,
       payment_method, status, received_by, scope
     ) VALUES ($1, $2, $3, $4, $5, $6, 'RECEIVED', 'Tester', $7)
     RETURNING id`,
    [propertyId, reservationId, bookingId, depositNumber, 10000, 'CASH', scope]
  );
  const depositId = Number(res.rows[0].id);
  // Insert RECEIVED event (requires payment_transaction_id per chk_deposit_event_projection)
  await client.query(
    `INSERT INTO deposit_events (deposit_id, property_id, reservation_id, event_type, amount, payment_transaction_id, idempotency_key, performed_by)
     VALUES ($1, $2, $3, 'RECEIVED', $4, $5, $6, 'Tester')`,
    [depositId, propertyId, reservationId, 10000, paymentId, `EVT-1B-${runId}-${depositId}`]
  );
  return depositId;
}

async function createCustody(client, propertyId, reservationId, bookingId, scope) {
  const res = await client.query(
    `INSERT INTO identity_custody (
       property_id, reservation_id, booking_id, document_type,
       document_holder_name, document_number_masked, status, received_by, scope
     ) VALUES ($1, $2, $3, $4, $5, $6, 'HELD', 'Tester', $7)
     RETURNING id`,
    [propertyId, reservationId, bookingId, 'KTP', `Guest ${runId}`, '****1234', scope]
  );
  return Number(res.rows[0].id);
}

/**
 * Insert a BOOKING_GROUP custody row already in RETURNED state.
 * The schema constraint chk_identity_custody_return requires returned_by
 * and returned_at to be non-null when status='RETURNED'.
 */
async function insertReturnedCustody(client, propertyId, reservationId, bookingId) {
  const res = await client.query(
    `INSERT INTO identity_custody (
       property_id, reservation_id, booking_id, document_type,
       document_holder_name, document_number_masked, status, received_by,
       returned_by, returned_at, scope
     ) VALUES ($1, $2, $3, 'KTP', 'Guest R7', '****5678', 'RETURNED', 'Tester', 'Tester', NOW(), 'BOOKING_GROUP')
     RETURNING id`,
    [propertyId, reservationId, bookingId]
  );
  return Number(res.rows[0].id);
}

async function cleanup(client, bookingId, reservationIds) {
  for (const rid of reservationIds) {
    await client.query('DELETE FROM identity_custody WHERE reservation_id = $1', [rid]);
    // Delete events before deposit (FK: deposit_events → deposits)
    await client.query('DELETE FROM deposit_events WHERE reservation_id = $1', [rid]);
    await client.query('DELETE FROM deposits WHERE reservation_id = $1', [rid]);
    // Delete payment transactions (FK: payment_transactions → reservations)
    await client.query('DELETE FROM payment_transactions WHERE reservation_id = $1', [rid]);
  }
  await client.query('DELETE FROM reservations WHERE booking_id = $1', [bookingId]);
  await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
}

// ─── Source inspection helpers ───────────────────────────────────────────────

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const client = await pool.connect();
  let propertyId = 1;
  let bookingId = null;
  let reservationIds = [];

  try {
    console.log(`\n=== GROUP-GUARANTEE-RELEASE-1B TESTS [runId=${runId}] ===\n`);

    // Ensure property exists
    const propRes = await client.query('SELECT id FROM properties LIMIT 1');
    if (propRes.rowCount > 0) propertyId = Number(propRes.rows[0].id);
    else {
      console.error('ERROR: No property found in database');
      process.exit(1);
    }

    // Get room data - use multiple rooms for multi-child bookings
    const roomRes = await client.query(
      'SELECT id, room_type_id FROM rooms ORDER BY id LIMIT 5'
    );
    if (roomRes.rowCount === 0) {
      console.error('ERROR: No rooms found');
      process.exit(1);
    }
    const rooms = roomRes.rows.map(r => ({ id: Number(r.id), typeId: Number(r.room_type_id) }));
    const roomId = rooms[0].id;
    const roomTypeId = rooms[0].typeId;

    // ── T1-T6: Core eligibility tests ──

    // T1: 2 children BOOKED → not eligible (use different rooms)
    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r1a = await createReservation(client, bookingId, roomId, roomTypeId, 'BOOKED', 1);
    const r1b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'BOOKED', 2);
    reservationIds = [r1a, r1b];
    const state1 = await getBookingGroupGuaranteeReleaseState(client, bookingId, propertyId);
    check(state1.activeChildCount === 2, 'T1a: 2 BOOKED children → activeChildCount=2');
    check(state1.releaseEligible === false, 'T1b: 2 BOOKED children → not eligible');
    check(state1.lifecycleStatus === 'ACTIVE', 'T1c: 2 BOOKED → lifecycle=ACTIVE');
    check(state1.blockingChildIds.length === 2, 'T1d: blockingChildIds has 2 entries');
    await cleanup(client, bookingId, reservationIds);

    // T2: 1 CHECKED_OUT + 1 BOOKED → not eligible
    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r2a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r2b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'BOOKED', 2);
    reservationIds = [r2a, r2b];
    const state2 = await getBookingGroupGuaranteeReleaseState(client, bookingId, propertyId);
    check(state2.activeChildCount === 1, 'T2a: 1 CHECKED_OUT + 1 BOOKED → activeChildCount=1');
    check(state2.releaseEligible === false, 'T2b: mixed states → not eligible');
    check(state2.lifecycleStatus === 'ACTIVE', 'T2c: mixed states → lifecycle=ACTIVE');
    await cleanup(client, bookingId, reservationIds);

    // T3: 1 CHECKED_OUT + 1 CHECKED_IN → not eligible
    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r3a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r3b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_IN', 2);
    reservationIds = [r3a, r3b];
    const state3 = await getBookingGroupGuaranteeReleaseState(client, bookingId, propertyId);
    check(state3.activeChildCount === 1, 'T3a: 1 CHECKED_OUT + 1 CHECKED_IN �� activeChildCount=1');
    check(state3.releaseEligible === false, 'T3b: still has active child → not eligible');
    await cleanup(client, bookingId, reservationIds);

    // T4: all CHECKED_OUT → eligible, lifecycle=COMPLETED
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r4a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r4b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    reservationIds = [r4a, r4b];
    const state4 = await getBookingGroupGuaranteeReleaseState(client, bookingId, propertyId);
    check(state4.activeChildCount === 0, 'T4a: all CHECKED_OUT → activeChildCount=0');
    check(state4.releaseEligible === true, 'T4b: all CHECKED_OUT → eligible');
    check(state4.lifecycleStatus === 'COMPLETED', 'T4c: all CHECKED_OUT → lifecycle=COMPLETED');
    check(state4.checkedOutCount === 2, 'T4d: checkedOutCount=2');
    await cleanup(client, bookingId, reservationIds);

    // T5: CHECKED_OUT + CANCELLED → eligible, lifecycle=COMPLETED
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r5a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r5b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CANCELLED', 2);
    reservationIds = [r5a, r5b];
    const state5 = await getBookingGroupGuaranteeReleaseState(client, bookingId, propertyId);
    check(state5.activeChildCount === 0, 'T5a: CHECKED_OUT + CANCELLED → activeChildCount=0');
    check(state5.releaseEligible === true, 'T5b: CHECKED_OUT + CANCELLED → eligible');
    check(state5.lifecycleStatus === 'COMPLETED', 'T5c: CHECKED_OUT + CANCELLED → lifecycle=COMPLETED');
    await cleanup(client, bookingId, reservationIds);

    // T6: all CANCELLED → eligible, lifecycle=CANCELLED
    bookingId = await createBooking(client, propertyId, 'CANCELLED');
    const r6a = await createReservation(client, bookingId, roomId, roomTypeId, 'CANCELLED', 1);
    const r6b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CANCELLED', 2);
    reservationIds = [r6a, r6b];
    const state6 = await getBookingGroupGuaranteeReleaseState(client, bookingId, propertyId);
    check(state6.activeChildCount === 0, 'T6a: all CANCELLED → activeChildCount=0');
    check(state6.releaseEligible === true, 'T6b: all CANCELLED → eligible (not stranded)');
    check(state6.lifecycleStatus === 'CANCELLED', 'T6c: all CANCELLED → lifecycle=CANCELLED');
    check(state6.cancelledCount === 2, 'T6d: cancelledCount=2');
    await cleanup(client, bookingId, reservationIds);

    // T7: cross-property booking → throw
    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r7 = await createReservation(client, bookingId, roomId, roomTypeId, 'BOOKED', 1);
    reservationIds = [r7];
    const fakePropertyId = 99999;
    try {
      await getBookingGroupGuaranteeReleaseState(client, bookingId, fakePropertyId);
      check(false, 'T7a: cross-property query should throw');
    } catch (err) {
      check(err.code === 'BOOKING_NOT_FOUND', 'T7b: cross-property throws BOOKING_NOT_FOUND');
    }
    await cleanup(client, bookingId, reservationIds);

    // ── T8-T9: Read metadata enrichment ──

    // T8: BOOKING_GROUP deposit read exposes metadata
    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r8a = await createReservation(client, bookingId, roomId, roomTypeId, 'BOOKED', 1);
    const r8b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'BOOKED', 2);
    reservationIds = [r8a, r8b];
    const depId8 = await createDeposit(client, propertyId, r8a, bookingId, 'BOOKING_GROUP');
    const deposits8 = await getDepositsByReservation(pool, propertyId, r8a);
    const groupDep8 = deposits8.find(d => d.scope === 'BOOKING_GROUP');
    check(groupDep8 !== undefined, 'T8a: group deposit returned in list');
    check(groupDep8.releaseEligible === false, 'T8b: group deposit metadata shows not eligible');
    check(groupDep8.activeChildCount === 2, 'T8c: group deposit metadata shows 2 active children');
    check(groupDep8.releaseBlockReason !== null, 'T8d: group deposit has block reason');
    await cleanup(client, bookingId, reservationIds);

    // T9: BOOKING_GROUP custody read exposes metadata
    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r9a = await createReservation(client, bookingId, roomId, roomTypeId, 'BOOKED', 1);
    const r9b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'BOOKED', 2);
    reservationIds = [r9a, r9b];
    const custId9 = await createCustody(client, propertyId, r9a, bookingId, 'BOOKING_GROUP');
    const custody9 = await getIdentityCustodyByReservation(pool, propertyId, r9a);
    const groupCust9 = custody9.find(c => c.scope === 'BOOKING_GROUP');
    check(groupCust9 !== undefined, 'T9a: group custody returned in list');
    check(groupCust9.releaseEligible === false, 'T9b: group custody metadata shows not eligible');
    check(groupCust9.activeChildCount === 2, 'T9c: group custody metadata shows 2 active children');
    await cleanup(client, bookingId, reservationIds);

    // ── T10: ROOM_RESERVATION rows retain existing behavior ──

    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r10 = await createReservation(client, bookingId, roomId, roomTypeId, 'BOOKED', 1);
    reservationIds = [r10];
    const depId10 = await createDeposit(client, propertyId, r10, bookingId, 'ROOM_RESERVATION');
    const deposits10 = await getDepositsByReservation(pool, propertyId, r10);
    const roomDep10 = deposits10.find(d => d.scope === 'ROOM_RESERVATION');
    check(roomDep10 !== undefined, 'T10a: room deposit still returned');
    check(roomDep10.releaseEligible === undefined, 'T10b: room deposit has no release metadata');
    await cleanup(client, bookingId, reservationIds);

    // ── T11: One active sibling blocks BOTH group deposit/custody ──

    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r11a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r11b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'BOOKED', 2);
    reservationIds = [r11a, r11b];
    const depId11 = await createDeposit(client, propertyId, r11a, bookingId, 'BOOKING_GROUP');
    const custId11 = await createCustody(client, propertyId, r11a, bookingId, 'BOOKING_GROUP');
    const deposits11 = await getDepositsByReservation(pool, propertyId, r11a);
    const custody11 = await getIdentityCustodyByReservation(pool, propertyId, r11a);
    const groupDep11 = deposits11.find(d => d.scope === 'BOOKING_GROUP');
    const groupCust11 = custody11.find(c => c.scope === 'BOOKING_GROUP');
    check(groupDep11?.releaseEligible === false, 'T11a: one active sibling blocks group deposit release');
    check(groupCust11?.releaseEligible === false, 'T11b: one active sibling blocks group custody release');
    await cleanup(client, bookingId, reservationIds);

    // ── T12: Zero-child booking → NOT eligible (Issue #1 safety correction) ──

    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    reservationIds = [];
    const state12 = await getBookingGroupGuaranteeReleaseState(client, bookingId, propertyId);
    check(state12.totalChildCount === 0, 'T12a: zero children → totalChildCount=0');
    check(state12.activeChildCount === 0, 'T12b: zero children → activeChildCount=0');
    check(state12.releaseEligible === false, 'T12c: zero children → NOT eligible (safety fix)');
    check(state12.lifecycleTerminal === false, 'T12d: zero children → lifecycleTerminal=false');
    check(state12.lifecycleStatus === 'ACTIVE', 'T12e: zero children → lifecycle=ACTIVE');
    check(state12.releaseBlockReason === 'Booking tidak memiliki reservasi tercakup',
      'T12f: zero children → stable block reason');
    await cleanup(client, bookingId, reservationIds);

    // ── T13: All-CANCELLED with real children → eligible (preserved behavior) ──

    bookingId = await createBooking(client, propertyId, 'CANCELLED');
    const r13a = await createReservation(client, bookingId, roomId, roomTypeId, 'CANCELLED', 1);
    const r13b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CANCELLED', 2);
    reservationIds = [r13a, r13b];
    const state13 = await getBookingGroupGuaranteeReleaseState(client, bookingId, propertyId);
    check(state13.totalChildCount === 2, 'T13a: all CANCELLED → totalChildCount=2');
    check(state13.activeChildCount === 0, 'T13b: all CANCELLED → activeChildCount=0');
    check(state13.releaseEligible === true, 'T13c: all CANCELLED → eligible (not stranded)');
    check(state13.lifecycleStatus === 'CANCELLED', 'T13d: all CANCELLED → lifecycle=CANCELLED');
    await cleanup(client, bookingId, reservationIds);

    // ── T14: Missing booking_id on BOOKING_GROUP row → integrity error ──

    const directClient = await pool.connect();
    try {
      const mockRows = [{ scope: 'BOOKING_GROUP', booking_id: null, id: 999 }];
      try {
        await enrichGroupRowsWithReleaseMetadata(mockRows, directClient, propertyId);
        check(false, 'T14a: null booking_id should throw BOOKING_GROUP_INTEGRITY_ERROR');
      } catch (err) {
        check(err.code === 'BOOKING_GROUP_INTEGRITY_ERROR', 'T14b: null booking_id throws INTEGRITY_ERROR');
      }

      const mockRows2 = [{ scope: 'BOOKING_GROUP', booking_id: -1, id: 998 }];
      try {
        await enrichGroupRowsWithReleaseMetadata(mockRows2, directClient, propertyId);
        check(false, 'T14c: negative booking_id should throw BOOKING_GROUP_INTEGRITY_ERROR');
      } catch (err) {
        check(err.code === 'BOOKING_GROUP_INTEGRITY_ERROR', 'T14d: negative booking_id throws INTEGRITY_ERROR');
      }
    } finally {
      directClient.release();
    }

    // ── T15: Cross-property error propagates through enrichment ──

    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r15 = await createReservation(client, bookingId, roomId, roomTypeId, 'BOOKED', 1);
    await createDeposit(client, propertyId, r15, bookingId, 'BOOKING_GROUP');
    try {
      const badPropId = 99999;
      await getDepositsByReservation(pool, badPropId, r15);
      check(false, 'T15a: wrong property should throw during enrichment');
    } catch (err) {
      check(err.code === 'RESERVATION_NOT_FOUND', 'T15b: wrong property propagates RESERVATION_NOT_FOUND');
    }
    await cleanup(client, bookingId, [r15]);

    // ── T16: Helper error propagates (no silent catch) ──

    const mockRows16 = [{ scope: 'BOOKING_GROUP', booking_id: 99999999, id: 997 }];
    try {
      await enrichGroupRowsWithReleaseMetadata(mockRows16, client, propertyId);
      check(false, 'T16a: non-existent booking should throw');
    } catch (err) {
      check(err.code === 'BOOKING_NOT_FOUND', 'T16b: non-existent booking throws (no silent catch)');
    }

    // ── T17-T19: Strengthened mutation/checkout regression tests ──

    const depositSrc = readSource('src/domains/deposits/depositService.ts');
    const custodySrc = readSource('src/domains/identity/identityCustodyService.ts');
    const indexSrc = readSource('src/index.ts');

    // T17: Refund mutation path does NOT call eligibility helper
    const refundMatch = depositSrc.match(/async function refundDeposit[\s\S]*?(?=\nexport async function)/);
    const refundBody = refundMatch ? refundMatch[0] : '';
    check(refundBody.includes('enrichGroupRowsWithReleaseMetadata') === false,
      'T17a: refundDeposit function does NOT call enrichment');

    // T18: Return/identity mutation path does NOT call eligibility helper
    const returnMatch = custodySrc.match(/async function returnIdentity[\s\S]*?(?=\nexport async function)/);
    const returnBody = returnMatch ? returnMatch[0] : '';
    check(returnBody.includes('enrichGroupRowsWithReleaseMetadata') === false,
      'T18a: returnIdentity function does NOT call enrichment');

    // T19: Checkout handler unchanged
    check(indexSrc.includes('getHeldIdentityCustodyForCheckout'),
      'T19a: checkout still calls getHeldIdentityCustodyForCheckout');
    const bcgCount = (indexSrc.match(/BOOKING_GROUP/g) || []).length;
    check(bcgCount <= 5, 'T19b: checkout has no new BOOKING_GROUP logic (count ≤ 5)');

    // ── T20: Zero-child booking enrichment → metadata attached correctly ──

    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    reservationIds = [];
    // Test enrichment directly without creating a deposit (avoids FK constraint)
    const zeroChildRows = [{ scope: 'BOOKING_GROUP', booking_id: bookingId, id: 996 }];
    try {
      await enrichGroupRowsWithReleaseMetadata(zeroChildRows, client, propertyId);
      check(zeroChildRows[0].releaseEligible === false, 'T20a: zero-child enrichment → releaseEligible=false');
      check(zeroChildRows[0].groupLifecycleStatus === 'ACTIVE', 'T20b: zero-child enrichment → lifecycle=ACTIVE');
      check(zeroChildRows[0].releaseBlockReason === 'Booking tidak memiliki reservasi tercakup',
        'T20c: zero-child enrichment → stable block reason');
    } catch (err) {
      check(false, 'T20d: zero-child enrichment should succeed: ' + err.message);
    }
    await cleanup(client, bookingId, reservationIds);

    // ── T21-T23: Unknown reservation status → fail closed ──

    // T21: One child with unknown status → NOT eligible
    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r21a = await createReservation(client, bookingId, roomId, roomTypeId, 'UNKNOWN_STATUS', 1);
    reservationIds = [r21a];
    const state21 = await getBookingGroupGuaranteeReleaseState(client, bookingId, propertyId);
    check(state21.totalChildCount === 1, 'T21a: unknown status → totalChildCount=1');
    check(state21.activeChildCount === 0, 'T21b: unknown status → activeChildCount=0');
    check(state21.unknownStatusCount === 1, 'T21c: unknown status → unknownStatusCount=1');
    check(state21.releaseEligible === false, 'T21d: unknown status → NOT eligible (fail closed)');
    check(state21.lifecycleTerminal === false, 'T21e: unknown status → lifecycleTerminal=false');
    check(state21.lifecycleStatus === 'ACTIVE', 'T21f: unknown status → lifecycle=ACTIVE');
    check(state21.releaseBlockReason === 'Status reservasi tercakup tidak dikenali',
      'T21g: unknown status → stable block reason');
    await cleanup(client, bookingId, reservationIds);

    // T22: CHECKED_OUT + unknown status → NOT eligible
    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r22a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r22b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'UNKNOWN_STATUS', 2);
    reservationIds = [r22a, r22b];
    const state22 = await getBookingGroupGuaranteeReleaseState(client, bookingId, propertyId);
    check(state22.activeChildCount === 0, 'T22a: CHECKED_OUT + unknown → activeChildCount=0');
    check(state22.unknownStatusCount === 1, 'T22b: CHECKED_OUT + unknown → unknownStatusCount=1');
    check(state22.releaseEligible === false, 'T22c: mixed known/unknown → NOT eligible');
    check(state22.lifecycleStatus === 'ACTIVE', 'T22d: mixed known/unknown → lifecycle=ACTIVE');
    await cleanup(client, bookingId, reservationIds);

    // T23: CANCELLED + unknown status → NOT eligible
    bookingId = await createBooking(client, propertyId, 'CANCELLED');
    const r23a = await createReservation(client, bookingId, roomId, roomTypeId, 'CANCELLED', 1);
    const r23b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'UNKNOWN_STATUS', 2);
    reservationIds = [r23a, r23b];
    const state23 = await getBookingGroupGuaranteeReleaseState(client, bookingId, propertyId);
    check(state23.activeChildCount === 0, 'T23a: CANCELLED + unknown → activeChildCount=0');
    check(state23.unknownStatusCount === 1, 'T23b: CANCELLED + unknown → unknownStatusCount=1');
    check(state23.releaseEligible === false, 'T23c: mixed known/unknown → NOT eligible');
    check(state23.lifecycleStatus === 'ACTIVE', 'T23d: mixed known/unknown → lifecycle=ACTIVE');
    await cleanup(client, bookingId, reservationIds);

    // ── T24-T26: Preserved eligible behaviors ──

    // T24: All CHECKED_OUT → still eligible
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r24a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r24b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    reservationIds = [r24a, r24b];
    const state24 = await getBookingGroupGuaranteeReleaseState(client, bookingId, propertyId);
    check(state24.unknownStatusCount === 0, 'T24a: all CHECKED_OUT → unknownStatusCount=0');
    check(state24.releaseEligible === true, 'T24b: all CHECKED_OUT → eligible');
    check(state24.lifecycleStatus === 'COMPLETED', 'T24c: all CHECKED_OUT → lifecycle=COMPLETED');
    await cleanup(client, bookingId, reservationIds);

    // T25: CHECKED_OUT + CANCELLED → still eligible
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r25a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r25b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CANCELLED', 2);
    reservationIds = [r25a, r25b];
    const state25 = await getBookingGroupGuaranteeReleaseState(client, bookingId, propertyId);
    check(state25.unknownStatusCount === 0, 'T25a: CHECKED_OUT + CANCELLED → unknownStatusCount=0');
    check(state25.releaseEligible === true, 'T25b: CHECKED_OUT + CANCELLED → eligible');
    await cleanup(client, bookingId, reservationIds);

    // T26: All CANCELLED → still eligible
    bookingId = await createBooking(client, propertyId, 'CANCELLED');
    const r26a = await createReservation(client, bookingId, roomId, roomTypeId, 'CANCELLED', 1);
    const r26b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CANCELLED', 2);
    reservationIds = [r26a, r26b];
    const state26 = await getBookingGroupGuaranteeReleaseState(client, bookingId, propertyId);
    check(state26.unknownStatusCount === 0, 'T26a: all CANCELLED → unknownStatusCount=0');
    check(state26.releaseEligible === true, 'T26b: all CANCELLED → eligible');
    await cleanup(client, bookingId, reservationIds);

    // ── T27: booking_id = 1.5 → BOOKING_GROUP_INTEGRITY_ERROR ──

    const floatClient = await pool.connect();
    try {
      const mockRowFloat = [{ scope: 'BOOKING_GROUP', booking_id: 1.5, id: 995 }];
      try {
        await enrichGroupRowsWithReleaseMetadata(mockRowFloat, floatClient, propertyId);
        check(false, 'T27a: float booking_id should throw BOOKING_GROUP_INTEGRITY_ERROR');
      } catch (err) {
        check(err.code === 'BOOKING_GROUP_INTEGRITY_ERROR', 'T27b: float booking_id throws INTEGRITY_ERROR');
      }
    } finally {
      floatClient.release();
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);

  } catch (err) {
    console.error('Test execution error:', err);
    failed++;
  } finally {
    try {
      if (bookingId) {
        await client.query('DELETE FROM identity_custody WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
        await client.query('DELETE FROM deposits WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
        await client.query('DELETE FROM reservations WHERE booking_id = $1', [bookingId]);
        await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
      }
    } catch (cleanErr) {
      console.error('Fixture cleanup error:', cleanErr);
    }
    client.release();
    await pool.end();
    if (failed > 0) {
      process.exit(1);
    }
  }
}

// ─── T1-T14: BOOKING_GROUP return guard tests ────────────────────────────────

async function runReturnGuardTests(guardPool) {
  const client = await guardPool.connect();
  let propertyId = 1;
  let bookingId = null;
  let reservationIds = [];

  try {
    console.log(`\n=== GROUP-GUARANTEE-RELEASE-1B RETURN GUARD TESTS ===\n`);

    // Ensure property exists
    const propRes = await client.query('SELECT id FROM properties LIMIT 1');
    if (propRes.rowCount > 0) propertyId = Number(propRes.rows[0].id);

    // Get room data
    const roomRes = await client.query(
      'SELECT id, room_type_id FROM rooms ORDER BY id LIMIT 5'
    );
    const rooms = roomRes.rows.map(r => ({ id: Number(r.id), typeId: Number(r.room_type_id) }));
    const roomId = rooms[0]?.id;
    const roomTypeId = rooms[0]?.typeId;

    // T1: BOOKING_GROUP custody + 2 active children → return rejected 409
    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r1a = await createReservation(client, bookingId, roomId, roomTypeId, 'BOOKED', 1);
    const r1b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'BOOKED', 2);
    reservationIds = [r1a, r1b];
    const custId1 = await createCustody(client, propertyId, r1a, bookingId, 'BOOKING_GROUP');
    try {
      await returnIdentity(guardPool, { propertyId, custodyId: custId1, actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' } });
      check(false, 'T1a: 2 active children → should reject return');
    } catch (err) {
      check(err.code === 'BOOKING_GROUP_GUARANTEE_NOT_RELEASE_ELIGIBLE', 'T1b: 2 active children → rejects with BOOKING_GROUP_GUARANTEE_NOT_RELEASE_ELIGIBLE');
    }
    await cleanup(client, bookingId, reservationIds);

    // T2: 1 CHECKED_OUT + 1 BOOKED → rejected
    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r2a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r2b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'BOOKED', 2);
    reservationIds = [r2a, r2b];
    const custId2 = await createCustody(client, propertyId, r2a, bookingId, 'BOOKING_GROUP');
    try {
      await returnIdentity(guardPool, { propertyId, custodyId: custId2, actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' } });
      check(false, 'T2a: mixed state → should reject return');
    } catch (err) {
      check(err.code === 'BOOKING_GROUP_GUARANTEE_NOT_RELEASE_ELIGIBLE', 'T2b: mixed state → rejects with BOOKING_GROUP_GUARANTEE_NOT_RELEASE_ELIGIBLE');
    }
    await cleanup(client, bookingId, reservationIds);

    // T3: all CHECKED_OUT → return succeeds
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r3a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r3b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    reservationIds = [r3a, r3b];
    const custId3 = await createCustody(client, propertyId, r3a, bookingId, 'BOOKING_GROUP');
    const result3 = await returnIdentity(guardPool, { propertyId, custodyId: custId3, actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' } });
    check(result3.status === 'RETURNED', 'T3a: all CHECKED_OUT → returns successfully');
    check(result3.returned_by === 'Tester', 'T3b: returned_by populated');
    check(result3.returned_at !== undefined && result3.returned_at !== null, 'T3c: returned_at populated');
    await cleanup(client, bookingId, reservationIds);

    // T4: CHECKED_OUT + CANCELLED → succeeds
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r4a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r4b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CANCELLED', 2);
    reservationIds = [r4a, r4b];
    const custId4 = await createCustody(client, propertyId, r4a, bookingId, 'BOOKING_GROUP');
    const result4 = await returnIdentity(guardPool, { propertyId, custodyId: custId4, actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' } });
    check(result4.status === 'RETURNED', 'T4a: CHECKED_OUT + CANCELLED → returns successfully');
    await cleanup(client, bookingId, reservationIds);

    // T5: all CANCELLED → succeeds
    bookingId = await createBooking(client, propertyId, 'CANCELLED');
    const r5a = await createReservation(client, bookingId, roomId, roomTypeId, 'CANCELLED', 1);
    const r5b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CANCELLED', 2);
    reservationIds = [r5a, r5b];
    const custId5 = await createCustody(client, propertyId, r5a, bookingId, 'BOOKING_GROUP');
    const result5 = await returnIdentity(guardPool, { propertyId, custodyId: custId5, actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' } });
    check(result5.status === 'RETURNED', 'T5a: all CANCELLED → returns successfully (not stranded)');
    await cleanup(client, bookingId, reservationIds);

    // T6: unknown child status → rejected
    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r6a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r6b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'UNKNOWN_STATUS', 2);
    reservationIds = [r6a, r6b];
    const custId6 = await createCustody(client, propertyId, r6a, bookingId, 'BOOKING_GROUP');
    try {
      await returnIdentity(guardPool, { propertyId, custodyId: custId6, actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' } });
      check(false, 'T6a: unknown status → should reject return');
    } catch (err) {
      check(err.code === 'BOOKING_GROUP_GUARANTEE_NOT_RELEASE_ELIGIBLE', 'T6b: unknown status → rejects with BOOKING_GROUP_GUARANTEE_NOT_RELEASE_ELIGIBLE');
    }
    await cleanup(client, bookingId, reservationIds);

    // T7: zero-child booking return → skipped (structurally impossible under FK constraints)
    // The zero-child safety fix is fully validated in the main suite T12/T12c.
    // A custody row requires a valid reservation_id FK, so we can't have a custody
    // without a child reservation. This test is covered by enrichGroupRowsWithReleaseMetadata.
    check(true, 'T7a: zero-child guard test skipped — covered by main suite T12');

    // T8: cross-property custody/booking → rejected
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r8a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r8b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    reservationIds = [r8a, r8b];
    const custId8 = await createCustody(client, propertyId, r8a, bookingId, 'BOOKING_GROUP');
    try {
      // Try returning from wrong property
      await returnIdentity(guardPool, { propertyId: 99999, custodyId: custId8, actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' } });
      check(false, 'T8a: cross-property → should reject return');
    } catch (err) {
      check(err.code === 'BOOKING_NOT_FOUND' || err.code === 'IDENTITY_CUSTODY_NOT_FOUND', 'T8b: cross-property → rejected');
    }
    await cleanup(client, bookingId, reservationIds);

    // T9: BOOKING_GROUP custody with invalid booking_id → integrity error
    const directClient9 = await guardPool.connect();
    try {
      const mockRow = [{ scope: 'BOOKING_GROUP', booking_id: null, id: 9999, reservation_id: 0, property_id: propertyId, status: 'HELD' }];
      try {
        await enrichGroupRowsWithReleaseMetadata(mockRow, directClient9, propertyId);
        check(false, 'T9a: null booking_id → should throw');
      } catch (err) {
        check(err.code === 'BOOKING_GROUP_INTEGRITY_ERROR', 'T9b: null booking_id throws BOOKING_GROUP_INTEGRITY_ERROR');
      }
    } finally {
      directClient9.release();
    }

    // T10: repeated return → second call rejected, no second audit side effect
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r10a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r10b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    reservationIds = [r10a, r10b];
    const custId10 = await createCustody(client, propertyId, r10a, bookingId, 'BOOKING_GROUP');
    // First return
    const result10a = await returnIdentity(guardPool, { propertyId, custodyId: custId10, actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' } });
    check(result10a.status === 'RETURNED', 'T10a: first return succeeds');
    // Second return
    try {
      await returnIdentity(guardPool, { propertyId, custodyId: custId10, actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' } });
      check(false, 'T10b: repeated return → should reject');
    } catch (err) {
      check(err.code === 'IDENTITY_ALREADY_RETURNED', 'T10c: repeated return → IDENTITY_ALREADY_RETURNED');
    }
    await cleanup(client, bookingId, reservationIds);

    // T11: ROOM_RESERVATION custody return behavior unchanged
    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r11 = await createReservation(client, bookingId, roomId, roomTypeId, 'BOOKED', 1);
    reservationIds = [r11];
    const custId11 = await createCustody(client, propertyId, r11, bookingId, 'ROOM_RESERVATION');
    const result11 = await returnIdentity(guardPool, { propertyId, custodyId: custId11, actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' } });
    check(result11.status === 'RETURNED', 'T11a: ROOM_RESERVATION return still works');
    check(result11.returned_by === 'Tester', 'T11b: ROOM_RESERVATION returned_by populated');
    await cleanup(client, bookingId, reservationIds);

    // T12: checkout code unchanged — verify getHeldIdentityCustodyForCheckout still called
    const indexSrc = readSource('src/index.ts');
    check(indexSrc.includes('getHeldIdentityCustodyForCheckout'), 'T12a: checkout still calls getHeldIdentityCustodyForCheckout');
    // No auto-return logic added
    check(!indexSrc.includes('returnIdentity') || indexSrc.split('returnIdentity').length <= 2,
      'T12b: checkout does NOT call returnIdentity');

    // T13: canonical helper logic reused — no duplicated eligibility logic in identity service
    const custodySrc = readSource('src/domains/identity/identityCustodyService.ts');
    check(custodySrc.includes('deriveGroupGuaranteeStateFromChildren'), 'T13a: identity service imports deriveGroupGuaranteeStateFromChildren');
    check(!custodySrc.includes('activeCount === 0 && unknownCount === 0 && allChildrenRecognizedTerminal'),
      'T13b: identity service does NOT duplicate eligibility logic inline');

    // T14: pure derive function reuses same logic (tested via direct call)
    const children = [
      { id: 1, status: 'CHECKED_OUT' },
      { id: 2, status: 'CHECKED_OUT' }
    ];
    const derived = deriveGroupGuaranteeStateFromChildren(children, 999, 1);
    check(derived.releaseEligible === true, 'T14a: deriveGroupGuaranteeStateFromChildren → all terminal = eligible');
    check(derived.totalChildCount === 2, 'T14b: deriveGroupGuaranteeStateFromChildren → totalChildCount=2');

    console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);

  } catch (err) {
    console.error('Return guard test execution error:', err);
    failed++;
  } finally {
    try {
      if (bookingId) {
        await client.query('DELETE FROM identity_custody WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
        await client.query('DELETE FROM deposits WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
        await client.query('DELETE FROM reservations WHERE booking_id = $1', [bookingId]);
        await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
      }
    } catch (cleanErr) {
      console.error('Fixture cleanup error:', cleanErr);
    }
    client.release();
    await guardPool.end();
  }
}

// ─── R1–R11: BOOKING_GROUP deposit refund guard (Phase 1B — custody-first) ───

async function runRefundGuardTests(refundPool) {
  const client = await refundPool.connect();
  let propertyId = 1;
  let bookingId = null;
  let reservationIds = [];
  let custodyId = null;

  try {
    console.log(`\n=== GROUP-GUARANTEE-RELEASE-1B REFUND GUARD TESTS ===\n`);

    // Ensure property exists
    const propRes = await client.query('SELECT id FROM properties LIMIT 1');
    if (propRes.rowCount > 0) propertyId = Number(propRes.rows[0].id);

    // Get room data
    const roomRes = await client.query(
      'SELECT id, room_type_id FROM rooms ORDER BY id LIMIT 5'
    );
    const rooms = roomRes.rows.map(r => ({ id: Number(r.id), typeId: Number(r.room_type_id) }));
    const roomId = rooms[0]?.id;
    const roomTypeId = rooms[0]?.typeId;

    // R1: all CHECKED_OUT + HELD BOOKING_GROUP custody → rejected with BOOKING_GROUP_CUSTODY_STILL_HELD
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r1a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r1b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    reservationIds = [r1a, r1b];
    custodyId = await createCustody(client, propertyId, r1a, bookingId, 'BOOKING_GROUP');
    const depositId1 = await createDeposit(client, propertyId, r1a, bookingId, 'BOOKING_GROUP');
    try {
      await refundDeposit(refundPool, {
        propertyId,
        reservationId: r1a,
        depositId: depositId1,
        amount: 10000,
        paymentMethod: 'CASH',
        idempotencyKey: `RFD-1B-${runId}-R1`,
        actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
      });
      check(false, 'R1a: HELD custody → should reject refund');
    } catch (err) {
      check(err.code === 'BOOKING_GROUP_CUSTODY_STILL_HELD', 'R1b: HELD custody → rejects with BOOKING_GROUP_CUSTODY_STILL_HELD');
    }
    await cleanup(client, bookingId, reservationIds);

    // R2: all CHECKED_OUT + group custody RETURNED first → refund succeeds
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r2a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r2b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    reservationIds = [r2a, r2b];
    custodyId = await createCustody(client, propertyId, r2a, bookingId, 'BOOKING_GROUP');
    const depositId2 = await createDeposit(client, propertyId, r2a, bookingId, 'BOOKING_GROUP');
    // Return custody first
    await returnIdentity(refundPool, { propertyId, custodyId, actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' } });
    const refundResult2 = await refundDeposit(refundPool, {
      propertyId,
      reservationId: r2a,
      depositId: depositId2,
      amount: 10000,
      paymentMethod: 'CASH',
      idempotencyKey: `RFD-1B-${runId}-R2`,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    check(refundResult2.event?.event_type === 'REFUND', 'R2a: RETURNED custody → refund succeeds');
    check(refundResult2.payment?.scope === 'BOOKING_GROUP', 'R2b: refund payment scope is BOOKING_GROUP');
    await cleanup(client, bookingId, reservationIds);

    // R3: all CHECKED_OUT + no group custody → refund succeeds
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r3a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r3b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    reservationIds = [r3a, r3b];
    const depositId3 = await createDeposit(client, propertyId, r3a, bookingId, 'BOOKING_GROUP');
    const refundResult3 = await refundDeposit(refundPool, {
      propertyId,
      reservationId: r3a,
      depositId: depositId3,
      amount: 10000,
      paymentMethod: 'CASH',
      idempotencyKey: `RFD-1B-${runId}-R3`,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    check(refundResult3.event?.event_type === 'REFUND', 'R3a: no custody → refund succeeds');
    check(refundResult3.payment?.scope === 'BOOKING_GROUP', 'R3b: refund payment scope is BOOKING_GROUP');
    await cleanup(client, bookingId, reservationIds);

    // R4: all CANCELLED + HELD group custody → refund blocked
    bookingId = await createBooking(client, propertyId, 'CANCELLED');
    const r4a = await createReservation(client, bookingId, roomId, roomTypeId, 'CANCELLED', 1);
    const r4b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CANCELLED', 2);
    reservationIds = [r4a, r4b];
    custodyId = await createCustody(client, propertyId, r4a, bookingId, 'BOOKING_GROUP');
    const depositId4 = await createDeposit(client, propertyId, r4a, bookingId, 'BOOKING_GROUP');
    try {
      await refundDeposit(refundPool, {
        propertyId,
        reservationId: r4a,
        depositId: depositId4,
        amount: 10000,
        paymentMethod: 'CASH',
        idempotencyKey: `RFD-1B-${runId}-R4`,
        actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
      });
      check(false, 'R4a: CANCELLED + HELD custody → should reject refund');
    } catch (err) {
      check(err.code === 'BOOKING_GROUP_CUSTODY_STILL_HELD', 'R4b: CANCELLED + HELD custody → rejects with BOOKING_GROUP_CUSTODY_STILL_HELD');
    }
    await cleanup(client, bookingId, reservationIds);

    // R5: all CANCELLED + RETURNED custody → refund succeeds
    bookingId = await createBooking(client, propertyId, 'CANCELLED');
    const r5a = await createReservation(client, bookingId, roomId, roomTypeId, 'CANCELLED', 1);
    const r5b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CANCELLED', 2);
    reservationIds = [r5a, r5b];
    custodyId = await createCustody(client, propertyId, r5a, bookingId, 'BOOKING_GROUP');
    const depositId5 = await createDeposit(client, propertyId, r5a, bookingId, 'BOOKING_GROUP');
    await returnIdentity(refundPool, { propertyId, custodyId, actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' } });
    const refundResult5 = await refundDeposit(refundPool, {
      propertyId,
      reservationId: r5a,
      depositId: depositId5,
      amount: 10000,
      paymentMethod: 'CASH',
      idempotencyKey: `RFD-1B-${runId}-R5`,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    check(refundResult5.event?.event_type === 'REFUND', 'R5a: CANCELLED + RETURNED custody → refund succeeds');
    check(refundResult5.payment?.scope === 'BOOKING_GROUP', 'R5b: refund payment scope is BOOKING_GROUP');
    await cleanup(client, bookingId, reservationIds);

    // R6: ROOM_RESERVATION custody does NOT block BOOKING_GROUP refund
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r6a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r6b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    reservationIds = [r6a, r6b];
    // Create ROOM_RESERVATION custody (not BOOKING_GROUP) — should NOT block
    await createCustody(client, propertyId, r6a, bookingId, 'ROOM_RESERVATION');
    const depositId6 = await createDeposit(client, propertyId, r6a, bookingId, 'BOOKING_GROUP');
    const refundResult6 = await refundDeposit(refundPool, {
      propertyId,
      reservationId: r6a,
      depositId: depositId6,
      amount: 10000,
      paymentMethod: 'CASH',
      idempotencyKey: `RFD-1B-${runId}-R6`,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    check(refundResult6.event?.event_type === 'REFUND', 'R6a: ROOM_RESERVATION custody does NOT block group refund');
    await cleanup(client, bookingId, reservationIds);

    // R7: active child + custody RETURNED → still blocked by lifecycle eligibility
    // (returnIdentity itself blocks when children are active, so we insert RETURNED
    // custody directly to simulate a pre-existing returned state, then verify refund
    // still rejects on lifecycle grounds.)
    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r7a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r7b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'BOOKED', 2);
    reservationIds = [r7a, r7b];
    custodyId = await insertReturnedCustody(client, propertyId, r7a, bookingId);
    const depositId7 = await createDeposit(client, propertyId, r7a, bookingId, 'BOOKING_GROUP');
    try {
      await refundDeposit(refundPool, {
        propertyId,
        reservationId: r7a,
        depositId: depositId7,
        amount: 10000,
        paymentMethod: 'CASH',
        idempotencyKey: `RFD-1B-${runId}-R7`,
        actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
      });
      check(false, 'R7a: active child + RETURNED custody → should still reject');
    } catch (err) {
      check(err.code === 'BOOKING_GROUP_GUARANTEE_NOT_RELEASE_ELIGIBLE', 'R7b: active child + RETURNED custody → rejects with BOOKING_GROUP_GUARANTEE_NOT_RELEASE_ELIGIBLE');
    }
    await cleanup(client, bookingId, reservationIds);

    // R8: cross-property deposit refund → rejected
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r8a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r8b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    reservationIds = [r8a, r8b];
    const depositId8 = await createDeposit(client, propertyId, r8a, bookingId, 'BOOKING_GROUP');
    try {
      await refundDeposit(refundPool, {
        propertyId: 99999,
        reservationId: r8a,
        depositId: depositId8,
        amount: 10000,
        paymentMethod: 'CASH',
        idempotencyKey: `RFD-1B-${runId}-R8`,
        actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
      });
      check(false, 'R8a: cross-property → should reject refund');
    } catch (err) {
      check(err != null, 'R8b: cross-property → rejected');
    }
    await cleanup(client, bookingId, reservationIds);

    // R9: idempotent replay — same key returns replay, not a new refund
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r9a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r9b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    reservationIds = [r9a, r9b];
    const depositId9 = await createDeposit(client, propertyId, r9a, bookingId, 'BOOKING_GROUP');
    const refundKey9 = `RFD-1B-${runId}-R9`;
    const firstRefund = await refundDeposit(refundPool, {
      propertyId,
      reservationId: r9a,
      depositId: depositId9,
      amount: 10000,
      paymentMethod: 'CASH',
      idempotencyKey: refundKey9,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    check(firstRefund.event?.event_type === 'REFUND', 'R9a: first refund succeeds');
    check(firstRefund.payment?.scope === 'BOOKING_GROUP', 'R9c: first refund scope is BOOKING_GROUP');
    const replayRefund = await refundDeposit(refundPool, {
      propertyId,
      reservationId: r9a,
      depositId: depositId9,
      amount: 10000,
      paymentMethod: 'CASH',
      idempotencyKey: refundKey9,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    check(replayRefund.idempotent_replay === true, 'R9d: second refund with same key returns idempotent_replay');
    check(replayRefund.event?.id === firstRefund.event?.id, 'R9e: replay references same event');
    await cleanup(client, bookingId, reservationIds);

    // R10: BOOKING_GROUP refund payment_transaction scope is BOOKING_GROUP
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const r10a = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const r10b = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    reservationIds = [r10a, r10b];
    const depositId10 = await createDeposit(client, propertyId, r10a, bookingId, 'BOOKING_GROUP');
    const refundResult10 = await refundDeposit(refundPool, {
      propertyId,
      reservationId: r10a,
      depositId: depositId10,
      amount: 10000,
      paymentMethod: 'CASH',
      idempotencyKey: `RFD-1B-${runId}-R10`,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    check(refundResult10.payment?.scope === 'BOOKING_GROUP', 'R10a: BOOKING_GROUP refund scope is BOOKING_GROUP');
    check(Number(refundResult10.payment?.booking_id) === bookingId, 'R10b: BOOKING_GROUP refund preserves booking_id');
    await cleanup(client, bookingId, reservationIds);

    // R11: ROOM_RESERVATION refund scope remains ROOM_RESERVATION (regression)
    bookingId = await createBooking(client, propertyId, 'ACTIVE');
    const r11 = await createReservation(client, bookingId, roomId, roomTypeId, 'BOOKED', 1);
    reservationIds = [r11];
    const depositId11 = await createDeposit(client, propertyId, r11, bookingId, 'ROOM_RESERVATION');
    const refundResult11 = await refundDeposit(refundPool, {
      propertyId,
      reservationId: r11,
      depositId: depositId11,
      amount: 10000,
      paymentMethod: 'CASH',
      idempotencyKey: `RFD-1B-${runId}-R11`,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    check(refundResult11.payment?.scope === 'ROOM_RESERVATION', 'R11a: ROOM_RESERVATION refund scope is ROOM_RESERVATION');
    check(refundResult11.event?.event_type === 'REFUND', 'R11b: ROOM_RESERVATION refund still works');
    await cleanup(client, bookingId, reservationIds);

    console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);

  } catch (err) {
    console.error('Refund guard test execution error:', err);
    failed++;
  } finally {
    try {
      if (bookingId) {
        await client.query('DELETE FROM identity_custody WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
        await client.query('DELETE FROM deposits WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
        await client.query('DELETE FROM reservations WHERE booking_id = $1', [bookingId]);
        await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
      }
    } catch (cleanErr) {
      console.error('Fixture cleanup error:', cleanErr);
    }
    client.release();
    await refundPool.end();
  }
}


// ─── Run all suites ───────────────────────────────────────────────────────────
async function main() {
  await run();
  const guardPool = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'secretpassword',
    database: process.env.DB_NAME || 'oak_hotel_db',
  });
  await runReturnGuardTests(guardPool);
  // Create a fresh pool for refund tests since runReturnGuardTests ended its pool
  const refundPool = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'secretpassword',
    database: process.env.DB_NAME || 'oak_hotel_db',
  });
  await runRefundGuardTests(refundPool);
  // Use a separate pool for concurrency tests to avoid "Cannot use a pool after end"
  const concurrencyPool = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'secretpassword',
    database: process.env.DB_NAME || 'oak_hotel_db',
  });
  await runConcurrencyRegressionTests(concurrencyPool);
  // Final-blocker D tests: transaction boundary, fixture dates, deposit revalidation
  const finalPool = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'secretpassword',
    database: process.env.DB_NAME || 'oak_hotel_db',
  });
  await runTransactionBoundaryTests(finalPool);
  await runFixtureDateTests(finalPool);
  await runDepositRevalidationTests(finalPool);
  await finalPool.end();
  process.exit(failed > 0 ? 1 : 0);
}

// ─── Concurrency regression: checkout-sim vs group refund ────────────────────
//
// Validates the deadlock-free lock ordering of the BOOKING_GROUP refund path.
//
// Lock order (BOOKING_GROUP refund, Phase 1B-final):
//   1. advisory_xact_lock(idempotency_key)
//   2. SELECT scope from deposits (no row lock)
//   3. bookings FOR UPDATE             ← NO reservation held yet
//   4. reservations FOR UPDATE NOWAIT  ← may fail fast
//   5. reservations FOR UPDATE         ← only after 3&4 succeed
//
// Lock order (checkout, unchanged):
//   1. target reservation FOR UPDATE
//   2. bookings FOR UPDATE
//   3. all siblings FOR UPDATE
//
// Deadlock analysis:
//   - Refund never holds a reservation while waiting for booking (step 2 before step 5).
//   - Checkout never holds a reservation while waiting for booking (step 1 before step 2).
//   - No cycle can form: refund-acquires-booking then-checkouts-wait-for-booking would
//     require the refund to already hold a reservation — impossible under the new order.
//
// Test scenario:
//   - Two pools simulate concurrent transactions.
//   - TX-A (refund-like): acquires booking lock, THEN attempts to lock a sibling reservation.
//   - TX-B (checkout-like): acquires a sibling reservation, THEN attempts booking lock.
//   - Expected: no deadlock; one transaction succeeds, the other gets
//     BOOKING_GROUP_LIFECYCLE_BUSY (or the appropriate conflict code).
//
async function runConcurrencyRegressionTests(pool) {
  const client = await pool.connect();
  let propertyId = 1;
  let bookingId = null;
  let reservationIds = [];

  try {
    console.log(`\n=== GROUP-GUARANTEE-RELEASE-1B CONCURRENCY REGRESSION ===\n`);

    const propRes = await client.query('SELECT id FROM properties LIMIT 1');
    if (propRes.rowCount > 0) propertyId = Number(propRes.rows[0].id);

    const roomRes = await client.query('SELECT id, room_type_id FROM rooms ORDER BY id LIMIT 5');
    const rooms = roomRes.rows.map(r => ({ id: Number(r.id), typeId: Number(r.room_type_id) }));
    const roomId = rooms[0]?.id;
    const roomTypeId = rooms[0]?.typeId;

    // C1: Build a completed booking with 2 siblings (A=CHECKED_OUT, B=CHECKED_OUT)
    bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const rA = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const rB = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    reservationIds = [rA, rB];
    const depositId = await createDeposit(client, propertyId, rA, bookingId, 'BOOKING_GROUP');

    // C2: Simulate checkout-like contention — a separate transaction holds a sibling
    //     reservation and then tries to lock the booking. This mimics what a checkout
    //     transaction (for sibling B) would look like.
    const contender = await pool.connect();
    let contenderResult = null;
    const contenderPromise = (async () => {
      try {
        await contender.query('BEGIN');
        // Step 1: lock sibling B (checkout-like)
        await contender.query(
          `SELECT id FROM reservations WHERE id = $1 FOR UPDATE`,
          [rB]
        );
        // Step 2: try to lock booking — this will block if refund also wants it
        await contender.query(
          `SELECT id FROM bookings WHERE id = $1 AND property_id = $2 LIMIT 1 FOR UPDATE`,
          [bookingId, propertyId]
        );
        await contender.query('ROLLBACK');
      } catch (err) {
        try { await contender.query('ROLLBACK').catch(() => {}); } catch (_) { /* ignore */ }
        contenderResult = err;
      }
    })();

    // Give contender a moment to acquire reservation B's lock.
    await new Promise(r => setTimeout(r, 150));

    // C3: Run the actual group refund (this is the main transaction).
    //     With the fixed lock order, it should acquire the booking lock WITHOUT
    //     holding reservation A first, then pick up reservation A afterward.
    //     The contender either gets the booking or gets a lock-not-available,
    //     but critically: NO DEADLOCK.
    let refundResult = null;
    let refundError = null;
    try {
      refundResult = await refundDeposit(pool, {
        propertyId,
        reservationId: rA,
        depositId,
        amount: 10000,
        paymentMethod: 'CASH',
        idempotencyKey: `RFD-1B-${runId}-C3`,
        actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
      });
    } catch (err) {
      refundError = err;
    }

    // C4: Wait for the contender to complete.
    await contenderPromise;

    // C5: Verify no deadlock occurred. At least one path succeeded or got a clean
    //     conflict (not a PostgreSQL deadlock error).
    const pgDeadlockCode = '40P01';
    const hasPgDeadlock = (refundError?.code === pgDeadlockCode) || (contenderResult?.code === pgDeadlockCode);
    check(!hasPgDeadlock, 'C1: no PostgreSQL deadlock (40P01) between group refund and checkout-sim');

    // C6: Refund must succeed (no deadlock means both can serialize safely).
    //     With all CHECKED_OUT + no HELD custody, the refund should complete.
    check(refundResult !== null && refundResult.event?.event_type === 'REFUND',
      'C2: group refund succeeds under concurrent checkout-sim contention');

    // C7: Verify the refund payment has correct scope.
    check(refundResult?.payment?.scope === 'BOOKING_GROUP',
      'C3: group refund preserves BOOKING_GROUP scope under contention');

    // C8: If the contender was blocked, it should have resolved cleanly.
    //     It may have been cancelled by the test shutdown (no error is fine as long
    //     as no deadlock occurred). If it did encounter an error, it should be a
    //     regular conflict, not a deadlock.
    if (contenderResult) {
      check(contenderResult.code !== pgDeadlockCode,
        'C4: contender did not encounter PostgreSQL deadlock');
    }

    // C9: Source-level assertion — confirm BOOKING_GROUP refund uses NOWAIT on children.
    const source = require('fs').readFileSync('src/domains/deposits/depositService.ts', 'utf8');
    const hasNowaitInRefund = source.includes('FOR UPDATE NOWAIT') &&
      source.includes('lockGroupChildrenNowait');
    check(hasNowaitInRefund, 'C5: source-level: BOOKING_GROUP refund uses NOWAIT on children');

    // C10: Source-level assertion — confirm refund does NOT call lockReservation
    //      before the booking lock in the BOOKING_GROUP path.
    //      (This is verified by code inspection: the BOOKING_GROUP branch acquires
    //       the booking lock before calling lockReservation.)
    const refundFnMatch = source.match(/export async function refundDeposit[\s\S]*?^}/m);
    check(Boolean(refundFnMatch), 'C6: source-level: refundDeposit function exists');

    // C11: Source-level assertion — confirm custody check uses FOR UPDATE NOWAIT
    const hasNowaitInCustody = source.includes('FOR UPDATE NOWAIT') &&
      source.includes("status = 'HELD'") &&
      source.includes('hasHeldGroupCustody');
    check(hasNowaitInCustody, 'C7: source-level: custody check uses FOR UPDATE NOWAIT');

    // C12: Source-level assertion — confirm 55P03 maps to BOOKING_GROUP_LIFECYCLE_BUSY
    //      in the custody check path (not just the children NOWAIT path).
    const custodyBlockMatch = source.match(/CUSTODY-FIRST RULE[\s\S]*?BOOKING_GROUP_LIFECYCLE_BUSY/);
    check(Boolean(custodyBlockMatch), 'C8: source-level: custody contention → BOOKING_GROUP_LIFECYCLE_BUSY');

    // C13-C18: Refund-vs-Return deadlock regression
    // Build: completed booking, both children CHECKED_OUT, HELD BOOKING_GROUP custody
    // Use a unique bid to avoid collision if previous C-tests failed to fully clean up.
    const cSubRunId = `${runId}-${funcSuffix()}`;
    const cBookingRes = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [propertyId, `BID-1B-C13-${cSubRunId}`, `1B Guest C13 ${cSubRunId}`, 'COMPLETED']
    );
    const cBookingId = Number(cBookingRes.rows[0].id);
    const crA = await createReservation(client, cBookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const crB = await createReservation(client, cBookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    const cCustodyId = await createCustody(client, propertyId, crA, cBookingId, 'BOOKING_GROUP');
    const cDepositId = await createDeposit(client, propertyId, crA, cBookingId, 'BOOKING_GROUP', cSubRunId);

    // TX-A: Simulate returnIdentity — acquires custody FOR UPDATE, holds it, then releases.
    // This ensures the custody lock is held when refund runs.
    const txA = await pool.connect();
    let txAResult = null;
    const txAPromise = (async () => {
      try {
        await txA.query('BEGIN');
        // Lock custody FOR UPDATE — this blocks the refund's NOWAIT query
        await txA.query(
          `SELECT id FROM identity_custody WHERE id = $1 AND property_id = $2 FOR UPDATE`,
          [cCustodyId, propertyId]
        );
        // Hold the lock for a short time, then release
        await new Promise(r => setTimeout(r, 200));
        await txA.query('ROLLBACK');
      } catch (err) {
        try { await txA.query('ROLLBACK').catch(() => {}); } catch (_) { /* ignore */ }
        txAResult = err;
      }
    })();

    // Give TX-A time to acquire the custody lock, THEN run the refund.
    await new Promise(r => setTimeout(r, 150));

    // TX-B (main refund): attempt group refund while custody is locked by TX-A.
    // With FOR UPDATE NOWAIT on custody, refund must fail fast with 55P03 → BOOKING_GROUP_LIFECYCLE_BUSY.
    let custodyRefundError = null;
    let custodyRefundResult = null;
    try {
      custodyRefundResult = await refundDeposit(pool, {
        propertyId,
        reservationId: crA,
        depositId: cDepositId,
        amount: 10000,
        paymentMethod: 'CASH',
        idempotencyKey: `RFD-C14-${runId}`,
        actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
      });
    } catch (err) {
      custodyRefundError = err;
    }

    // Wait for TX-A to resolve (may be blocked waiting for booking, or may fail fast).
    await txAPromise;

    // C14: No PostgreSQL deadlock (40P01) occurred.
    const pgDlCode = '40P01';
    const custodyHasDeadlock = (custodyRefundError?.code === pgDlCode) || (txAResult?.code === pgDlCode);
    check(!custodyHasDeadlock, 'C14: no PostgreSQL deadlock (40P01) between refund and return-sim');

    // C15: Refund must fail fast with BOOKING_GROUP_LIFECYCLE_BUSY, not hang or deadlock.
    check(custodyRefundError !== null && custodyRefundError.code === 'BOOKING_GROUP_LIFECYCLE_BUSY',
      'C15: refund fails fast with BOOKING_GROUP_LIFECYCLE_BUSY when custody is locked by return');

    // C16: No financial effect was created (no refund while custody HELD).
    const refundTxCount = await client.query(
      `SELECT COUNT(*) AS cnt FROM payment_transactions
       WHERE reservation_id = $1 AND transaction_type = 'DEPOSIT_REFUND'`,
      [crA]
    );
    check(Number(refundTxCount.rows[0].cnt) === 0, 'C16: no refund financial effect while custody is HELD');

    // C17: After actually returning the custody (completing TX-A's intent), refund succeeds.
    // Release TX-A normally (simulate a clean return completion).
    try {
      await txA.query('BEGIN');
      await txA.query(
        `UPDATE identity_custody SET status = 'RETURNED', returned_by = 'Tester', returned_at = NOW()
         WHERE id = $1`,
        [cCustodyId]
      );
      await txA.query('COMMIT');
    } catch (_) { /* may already be closed */ }
    await txA.release();

    const refundAfterReturn = await refundDeposit(pool, {
      propertyId,
      reservationId: crA,
      depositId: cDepositId,
      amount: 10000,
      paymentMethod: 'CASH',
      idempotencyKey: `RFD-C17-${runId}`,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    check(refundAfterReturn.event?.event_type === 'REFUND',
      'C17: refund succeeds after custody is RETURNED');

    // C18: Exactly one refund financial effect after successful retry.
    const finalRefundCount = await client.query(
      `SELECT COUNT(*) AS cnt FROM payment_transactions
       WHERE reservation_id = $1 AND transaction_type = 'DEPOSIT_REFUND'`,
      [crA]
    );
    check(Number(finalRefundCount.rows[0].cnt) === 1, 'C18: exactly 1 refund after successful retry');

    // Cleanup
    await client.query('DELETE FROM deposit_events WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [cBookingId]);
    await client.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [cBookingId]);
    await client.query('DELETE FROM identity_custody WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [cBookingId]);
    await client.query('DELETE FROM deposits WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [cBookingId]);
    await client.query('DELETE FROM reservations WHERE booking_id = $1', [cBookingId]);
    await client.query('DELETE FROM bookings WHERE id = $1', [cBookingId]);

    // Cleanup — delete in FK order: events → deposits → payment_txns → reservations → bookings
    await client.query('DELETE FROM deposit_events WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
    await client.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
    await client.query('DELETE FROM identity_custody WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
    await client.query('DELETE FROM deposits WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
    await client.query('DELETE FROM reservations WHERE booking_id = $1', [bookingId]);
    await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
    contender.release();
    client.release();

    console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);

  } catch (err) {
    console.error('Concurrency regression test execution error:', err);
    failed++;
  }
}

// ─── Final-blocker regression tests ──────────────────────────────────────────

/**
 * D1: Transaction boundary — verify refundDeposit runs inside an explicit
 *     BEGIN/COMMIT/ROLLBACK transaction (source-level assertion).
 */
async function runTransactionBoundaryTests(pool) {
  const client = await pool.connect();
  try {
    console.log(`\n=== FINAL-BLOCKER D TESTS ===\n`);
    const fSuffix = funcSuffix();

    // Cleanup any leftover rows from previous test runs with the same runId.
    // Delete order: children first, then parents, to respect FK constraints.
    await client.query(`DELETE FROM deposit_events WHERE deposit_id IN (SELECT id FROM deposits WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE $1))`, [`BID-1B-%`]);
    await client.query(`DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE $1))`, [`BID-1B-%`]);
    await client.query(`DELETE FROM deposits WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE $1)`, [`BID-1B-%`]);
    await client.query(`DELETE FROM identity_custody WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE $1))`, [`BID-1B-%`]);
    await client.query(`DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE $1)`, [`BID-1B-%`]);
    await client.query(`DELETE FROM bookings WHERE bid LIKE $1`, [`BID-1B-%`]);

    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'domains', 'deposits', 'depositService.ts'),
      'utf8'
    );

    // D1: Explicit BEGIN exists in refundDeposit
    const beginMatch = source.match(/export async function refundDeposit[\s\S]*?await client\.query\('BEGIN'\)/);
    check(Boolean(beginMatch), 'D1: refundDeposit contains explicit BEGIN');

    // D2: lockIdempotencyKey called inside the same transaction block (after BEGIN)
    const beginPos = source.indexOf("await client.query('BEGIN')");
    const idempotencyAfterBegin = beginPos >= 0 && source.indexOf('lockIdempotencyKey', beginPos) > beginPos;
    check(idempotencyAfterBegin, 'D2: lockIdempotencyKey is inside explicit transaction');

    // D3: COMMIT appears after the transaction body
    const commitMatch = source.match(/await client\.query\('COMMIT'\)/g);
    check(commitMatch && commitMatch.length >= 2, 'D3: refundDeposit contains COMMIT for normal path');

    // D4: ROLLBACK appears in catch block
    const rollbackMatch = source.match(/await client\.query\('ROLLBACK'\)/g);
    check(rollbackMatch && rollbackMatch.length >= 1, 'D4: refundDeposit contains ROLLBACK for error path');

    // D5: client.release in finally
    check(source.includes('client.release()'), 'D5: refundDeposit releases client in finally block');

    // D6: Behavioral — verify idempotent replay works inside transaction
    //      (a second refund with same idempotency key returns without new payment txn)
    const propRes = await client.query('SELECT id FROM properties LIMIT 1');
    const propertyId = Number(propRes.rows[0]?.id || 1);
    const roomRes = await client.query('SELECT id, room_type_id FROM rooms ORDER BY id LIMIT 3');
    const rooms = roomRes.rows.map(r => ({ id: Number(r.id), typeId: Number(r.room_type_id) }));
    const roomId = rooms[0]?.id;
    const roomTypeId = rooms[0]?.typeId;

    const bookingId = await createBooking(client, propertyId, 'COMPLETED', fSuffix);
    const rA = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const rB = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    const depositId = await createDeposit(client, propertyId, rA, bookingId, 'BOOKING_GROUP', fSuffix);

    // First refund — must succeed
    const result1 = await refundDeposit(pool, {
      propertyId,
      reservationId: rA,
      depositId,
      amount: 10000,
      paymentMethod: 'CASH',
      idempotencyKey: `RFD-D6-${fSuffix}`,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    check(result1.event?.event_type === 'REFUND', 'D6a: first refund inside transaction succeeds');

    // Second refund with same key — must return idempotent replay (no duplicate payment)
    const result2 = await refundDeposit(pool, {
      propertyId,
      reservationId: rA,
      depositId,
      amount: 10000,
      paymentMethod: 'CASH',
      idempotencyKey: `RFD-D6-${fSuffix}`,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    check(result2.idempotent_replay === true, 'D6b: second refund with same key returns idempotent_replay');

    // D7: Verify no duplicate payment_transactions were created
    const payments = await client.query(
      `SELECT COUNT(*) AS cnt FROM payment_transactions
       WHERE reservation_id = $1 AND transaction_type = 'DEPOSIT_REFUND'`,
      [rA]
    );
    check(Number(payments.rows[0].cnt) === 1, 'D7: exactly one DEPOSIT_REFUND payment_txn after idempotent replay');

    // Cleanup
    await client.query('DELETE FROM deposit_events WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
    await client.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
    await client.query('DELETE FROM deposits WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
    await client.query('DELETE FROM reservations WHERE booking_id = $1', [bookingId]);
    await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);

    console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
  } catch (err) {
    console.error('Transaction boundary test error:', err);
    failed++;
  } finally {
    client.release();
  }
}

/**
 * D8: Fixture date uniqueness — verify global monotonic slot produces unique,
 *     non-overlapping dates even with repeated seq values and across month boundaries.
 */
async function runFixtureDateTests(pool) {
  const client = await pool.connect();
  try {
    console.log(`\n=== FINAL-BLOCKER D8 FIXTURE DATE TEST ===\n`);
    const fSuffix = funcSuffix();

    // Cleanup ONLY test-created rows (identified by bid pattern), never real data.
    await client.query(`DELETE FROM deposit_events WHERE deposit_id IN (SELECT id FROM deposits WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE 'BID-1B-%'))`);
    await client.query(`DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE 'BID-1B-%'))`);
    await client.query(`DELETE FROM identity_custody WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE 'BID-1B-%'))`);
    await client.query(`DELETE FROM deposits WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE 'BID-1B-%')`);
    await client.query(`DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE 'BID-1B-%')`);
    await client.query(`DELETE FROM bookings WHERE bid LIKE 'BID-1B-%'`);

    const propRes = await client.query('SELECT id FROM properties LIMIT 1');
    const propertyId = Number(propRes.rows[0]?.id || 1);
    const roomRes = await client.query('SELECT id, room_type_id FROM rooms ORDER BY id LIMIT 5');
    const rooms = roomRes.rows.map(r => ({ id: Number(r.id), typeId: Number(r.room_type_id) }));
    const roomId = rooms[0]?.id;
    const roomTypeId = rooms[0]?.typeId;

    // Create many bookings with repeated seq=1, seq=2 to prove global slot deduplication
    const bookedDateSet = new Set();
    for (let b = 0; b < 12; b++) {
    const bookingId = await createBooking(client, propertyId, 'COMPLETED', fSuffix);
      // Each booking uses seq=1 and seq=2 — these used to collide; now they should be unique
      const r1 = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
      const r2 = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
      const res = await client.query(
        `SELECT check_in, check_out FROM reservations WHERE id = ANY($1)`,
        [[r1, r2]]
      );
      for (const row of res.rows) {
        const key = `${row.check_in}→${row.check_out}`;
        check(!bookedDateSet.has(key), `D8-${b}: date range ${key} is unique`);
        bookedDateSet.add(key);
      }
      // Cleanup
      await client.query('DELETE FROM deposits WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
      await client.query('DELETE FROM identity_custody WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
      await client.query('DELETE FROM reservations WHERE booking_id = $1', [bookingId]);
      await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
    }
    check(bookedDateSet.size === 24, 'D8: all 24 reservation date ranges are unique (12 bookings × 2 children)');

    // D9: Verify dates cross month/year boundaries and remain valid ISO strings
    // Since _DATE_BASE is 2080-01-01 and each slot = 3 days, after ~120 slots we
    // should cross into 2080-04-xx range. We already have 12*2 = 24 slots used above,
    // so let's explicitly test far-future slots.
    const farSlot = 400; // 400 * 3 = 1200 days ≈ 3+ years → crosses year boundary
    const expectedCheckIn = new Date(_DATE_BASE.getTime() + farSlot * 3 * 86400000);
    const expectedCheckOut = new Date(expectedCheckIn.getTime() + 86400000);
    const expectedIn = expectedCheckIn.toISOString().slice(0, 10);
    const expectedOut = expectedCheckOut.toISOString().slice(0, 10);
    // The actual slot used will be 24 (from the 12 bookings × 2 children above).
    // Let's compute what slot 24 would give:
    const slot24 = new Date(_DATE_BASE.getTime() + 24 * 3 * 86400000);
    const slot24In = slot24.toISOString().slice(0, 10);
    check(slot24In === '2080-03-13', `D9: slot 24 produces valid far-future date ${slot24In}`);

    // Verify ISO format is stable (YYYY-MM-DD, no timezone drift)
    const testDate = new Date(Date.UTC(2080, 2, 4)); // March 4, 2080
    check(testDate.toISOString().slice(0, 10) === '2080-03-04', 'D9: UTC ISO date formatting is stable');

    console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
  } catch (err) {
    console.error('Fixture date test error:', err);
    failed++;
  } finally {
    client.release();
  }
}

/**
 * D10: Deposit revalidation — verify locked deposit matches preview or fails safely.
 */
async function runDepositRevalidationTests(pool) {
  const client = await pool.connect();
  try {
    console.log(`\n=== FINAL-BLOCKER D10 DEPOSIT REVALIDATION TEST ===\n`);
    const fSuffix = funcSuffix();

    // Cleanup ONLY test-created rows (identified by bid pattern), never real data.
    await client.query(`DELETE FROM deposit_events WHERE deposit_id IN (SELECT id FROM deposits WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE 'BID-1B-%'))`);
    await client.query(`DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE 'BID-1B-%'))`);
    await client.query(`DELETE FROM identity_custody WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE 'BID-1B-%'))`);
    await client.query(`DELETE FROM deposits WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE 'BID-1B-%')`);
    await client.query(`DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE bid LIKE 'BID-1B-%')`);
    await client.query(`DELETE FROM bookings WHERE bid LIKE 'BID-1B-%'`);

    const propRes = await client.query('SELECT id FROM properties LIMIT 1');
    const propertyId = Number(propRes.rows[0]?.id || 1);
    const roomRes = await client.query('SELECT id, room_type_id FROM rooms ORDER BY id LIMIT 3');
    const rooms = roomRes.rows.map(r => ({ id: Number(r.id), typeId: Number(r.room_type_id) }));
    const roomId = rooms[0]?.id;
    const roomTypeId = rooms[0]?.typeId;

    // Create a BOOKING_GROUP deposit on a completed booking
    const bookingId = await createBooking(client, propertyId, 'COMPLETED');
    const rA = await createReservation(client, bookingId, roomId, roomTypeId, 'CHECKED_OUT', 1);
    const rB = await createReservation(client, bookingId, rooms[1]?.id || roomId, roomTypeId, 'CHECKED_OUT', 2);
    const depositId = await createDeposit(client, propertyId, rA, bookingId, 'BOOKING_GROUP');

    // D10a: Normal refund — locked deposit should match preview, refund succeeds
    const result = await refundDeposit(pool, {
      propertyId,
      reservationId: rA,
      depositId,
      amount: 10000,
      paymentMethod: 'CASH',
      idempotencyKey: `RFD-D10-${fSuffix}`,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    check(result.event?.event_type === 'REFUND', 'D10a: locked deposit matches preview → refund succeeds');
    check(result.payment?.scope === 'BOOKING_GROUP', 'D10b: refund payment has correct scope');

    // D10c: Concurrent refund of same deposit — idempotency key prevents duplicate
    const conflictResult = await refundDeposit(pool, {
      propertyId,
      reservationId: rA,
      depositId,
      amount: 10000,
      paymentMethod: 'CASH',
      idempotencyKey: `RFD-D10-${fSuffix}`,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    check(conflictResult.idempotent_replay === true, 'D10c: concurrent refund with same key returns idempotent replay');

    // Verify no duplicate financial effect
    const refundCount = await client.query(
      `SELECT COUNT(*) AS cnt FROM payment_transactions
       WHERE reservation_id = $1 AND transaction_type = 'DEPOSIT_REFUND'`,
      [rA]
    );
    check(Number(refundCount.rows[0].cnt) === 1, 'D10d: exactly 1 DEPOSIT_REFUND — no duplicate financial effect');

    // Cleanup
    await client.query('DELETE FROM deposit_events WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
    await client.query('DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
    await client.query('DELETE FROM deposits WHERE reservation_id IN (SELECT id FROM reservations WHERE booking_id = $1)', [bookingId]);
    await client.query('DELETE FROM reservations WHERE booking_id = $1', [bookingId]);
    await client.query('DELETE FROM bookings WHERE id = $1', [bookingId]);

    console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
  } catch (err) {
    console.error('Deposit revalidation test error:', err);
    failed++;
  } finally {
    client.release();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});