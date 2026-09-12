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
const { getBookingGroupGuaranteeReleaseState, enrichGroupRowsWithReleaseMetadata } =
  require('../dist/domains/guarantees/bookingGroupReleaseEligibility');
const { getDepositsByReservation } = require('../dist/domains/deposits/depositService');
const { getIdentityCustodyByReservation } = require('../dist/domains/identity/identityCustodyService');

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

async function createBooking(client, propertyId, status = 'ACTIVE') {
  const res = await client.query(
    `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [propertyId, `BID-1B-${runId}`, `1B Guest ${runId}`, status]
  );
  return Number(res.rows[0].id);
}

async function createReservation(client, bookingId, roomId, roomTypeId, status, seq) {
  const year = 2080;
  // Use different dates for each reservation in the same booking to avoid overlap
  const day = 10 + seq;
  const res = await client.query(
    `INSERT INTO reservations (
       booking_id, room_id, booked_room_type_id_snapshot, guest_name,
       check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
       status, payment_status, stay_sequence
     ) VALUES ($1, $2, $3, $4, $5, $6, 1000000, 1000000, 0, 1000000, $7, 'UNPAID', $8)
     RETURNING id`,
    [bookingId, roomId, roomTypeId, `1B Guest ${runId}`,
     `${year}-05-${day}`, `${year}-05-${day + 1}`, status, seq]
  );
  return Number(res.rows[0].id);
}

async function createDeposit(client, propertyId, reservationId, bookingId, scope) {
  const res = await client.query(
    `INSERT INTO deposits (
       property_id, reservation_id, booking_id, deposit_number, original_amount,
       payment_method, status, received_by, scope
     ) VALUES ($1, $2, $3, $4, $5, $6, 'RECEIVED', 'Tester', $7)
     RETURNING id`,
    [propertyId, reservationId, bookingId, `DEP-1B-${runId}`, 10000, 'CASH', scope]
  );
  return Number(res.rows[0].id);
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

async function cleanup(client, bookingId, reservationIds) {
  for (const rid of reservationIds) {
    await client.query('DELETE FROM identity_custody WHERE reservation_id = $1', [rid]);
    await client.query('DELETE FROM deposits WHERE reservation_id = $1', [rid]);
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

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
