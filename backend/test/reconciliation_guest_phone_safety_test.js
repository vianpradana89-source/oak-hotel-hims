/**
 * reconciliation_guest_phone_safety_test.js
 *
 * Test coverage for reconcile_primary_guest_phones.js:
 * A. Same guest linked to 2 reservations with same normalized phone -> SAFE, one proposed update
 * B. Same guest linked to 2 reservations with different phones -> CONFLICT, zero update
 * C. Execute mode must still skip conflicting guest
 * D. Existing non-empty canonical phone is never modified
 */

require('dotenv').config();
const assert = require('assert');
const { Pool } = require('pg');
const { normalizeDigitsOnly } = require('../dist/domains/guests/guestService');
const {
  classifyReconciliationCandidates,
  reconcilePrimaryGuestPhones
} = require('../scripts/reconcile_primary_guest_phones');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const runId = `REC${String(Date.now()).slice(-8)}`;

async function runUnitTests() {
  console.log('Running unit tests for classifyReconciliationCandidates...');

  // Test A: Same guest with same normalized phone across 2 reservations
  const candidatesA = [
    {
      guest_id: 101,
      canonical_guest_name: 'Guest A',
      reservation_id: 1001,
      reservation_guest_phone: '0812-3456-7890'
    },
    {
      guest_id: 101,
      canonical_guest_name: 'Guest A',
      reservation_id: 1002,
      reservation_guest_phone: '081234567890'
    }
  ];
  const resultA = classifyReconciliationCandidates(candidatesA, normalizeDigitsOnly);
  assert.strictEqual(resultA.safe.length, 1, 'Expected 1 safe candidate');
  assert.strictEqual(resultA.conflicts.length, 0, 'Expected 0 conflicts');
  assert.strictEqual(resultA.safe[0].guestId, 101);
  assert.strictEqual(resultA.safe[0].normalizedPhone, '081234567890');
  assert.deepStrictEqual(resultA.safe[0].reservationIds, [1001, 1002]);
  console.log('PASS | Unit Test A: Same normalized phone across multiple reservations classified as SAFE');

  // Test B: Same guest with different phones across 2 reservations
  const candidatesB = [
    {
      guest_id: 202,
      canonical_guest_name: 'Guest B',
      reservation_id: 2001,
      reservation_guest_phone: '081234567890'
    },
    {
      guest_id: 202,
      canonical_guest_name: 'Guest B',
      reservation_id: 2002,
      reservation_guest_phone: '085566778899'
    }
  ];
  const resultB = classifyReconciliationCandidates(candidatesB, normalizeDigitsOnly);
  assert.strictEqual(resultB.safe.length, 0, 'Expected 0 safe candidates for conflict');
  assert.strictEqual(resultB.conflicts.length, 1, 'Expected 1 conflict');
  assert.strictEqual(resultB.conflicts[0].guestId, 202);
  assert.strictEqual(resultB.conflicts[0].distinctNormalizedPhones.length, 2);
  assert.strictEqual(resultB.conflicts[0].conflictingReservations.length, 2);
  console.log('PASS | Unit Test B: Different phones across reservations classified as CONFLICT');

  // Mixed candidates
  const mixedCandidates = [...candidatesA, ...candidatesB];
  const resultMixed = classifyReconciliationCandidates(mixedCandidates, normalizeDigitsOnly);
  assert.strictEqual(resultMixed.safe.length, 1);
  assert.strictEqual(resultMixed.conflicts.length, 1);
  console.log('PASS | Unit Test Mixed: Cleanly separated safe and conflicting candidates');
}

async function runIntegrationTests() {
  console.log('Running integration tests for reconcilePrimaryGuestPhones in transaction...');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Resolve an available room
    const roomRes = await client.query('SELECT id, room_type_id FROM rooms WHERE property_id = 1 LIMIT 1');
    assert(roomRes.rows.length > 0, 'Need at least 1 room');
    const roomId = roomRes.rows[0].id;
    const roomTypeId = roomRes.rows[0].room_type_id;

    // 1. Setup Guest A: blank phone, 2 reservations with same phone '081122223333'
    const guestARes = await client.query(
      `INSERT INTO guests (full_name, normalized_name, phone, normalized_phone, created_property_id)
       VALUES ($1, $2, NULL, NULL, 1) RETURNING id`,
      [`Guest Safe ${runId}`, `guest safe ${runId}`]
    );
    const guestIdA = Number(guestARes.rows[0].id);

    const bookingARes = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES (1, $1, $2, 'ACTIVE') RETURNING id`,
      [`BID-SAFE-${runId}`, `Guest Safe ${runId}`]
    );
    const bookingIdA = Number(bookingARes.rows[0].id);

    const resA1 = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, booked_room_type_id_snapshot, guest_name, guest_phone,
         check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
         status, payment_status, stay_sequence
       ) VALUES ($1, $2, $3, $4, '0811-2222-3333', '2040-01-01', '2040-01-02', 500000, 500000, 0, 500000, 'BOOKED', 'UNPAID', 1)
       RETURNING id`,
      [bookingIdA, roomId, roomTypeId, `Guest Safe ${runId}`]
    );
    const resA2 = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, booked_room_type_id_snapshot, guest_name, guest_phone,
         check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
         status, payment_status, stay_sequence
       ) VALUES ($1, $2, $3, $4, '081122223333', '2040-01-03', '2040-01-04', 500000, 500000, 0, 500000, 'BOOKED', 'UNPAID', 2)
       RETURNING id`,
      [bookingIdA, roomId, roomTypeId, `Guest Safe ${runId}`]
    );

    await client.query(
      `INSERT INTO reservation_guests (reservation_id, guest_id, role, relationship, is_staying)
       VALUES ($1, $2, 'PRIMARY_GUEST', 'SELF', TRUE), ($3, $2, 'PRIMARY_GUEST', 'SELF', TRUE)`,
      [Number(resA1.rows[0].id), guestIdA, Number(resA2.rows[0].id)]
    );

    // 2. Setup Guest B: blank phone, 2 reservations with conflicting phones
    const guestBRes = await client.query(
      `INSERT INTO guests (full_name, normalized_name, phone, normalized_phone, created_property_id)
       VALUES ($1, $2, NULL, NULL, 1) RETURNING id`,
      [`Guest Conflict ${runId}`, `guest conflict ${runId}`]
    );
    const guestIdB = Number(guestBRes.rows[0].id);

    const bookingBRes = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES (1, $1, $2, 'ACTIVE') RETURNING id`,
      [`BID-CONF-${runId}`, `Guest Conflict ${runId}`]
    );
    const bookingIdB = Number(bookingBRes.rows[0].id);

    const resB1 = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, booked_room_type_id_snapshot, guest_name, guest_phone,
         check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
         status, payment_status, stay_sequence
       ) VALUES ($1, $2, $3, $4, '081100001111', '2040-02-01', '2040-02-02', 500000, 500000, 0, 500000, 'BOOKED', 'UNPAID', 1)
       RETURNING id`,
      [bookingIdB, roomId, roomTypeId, `Guest Conflict ${runId}`]
    );
    const resB2 = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, booked_room_type_id_snapshot, guest_name, guest_phone,
         check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
         status, payment_status, stay_sequence
       ) VALUES ($1, $2, $3, $4, '081199998888', '2040-02-03', '2040-02-04', 500000, 500000, 0, 500000, 'BOOKED', 'UNPAID', 2)
       RETURNING id`,
      [bookingIdB, roomId, roomTypeId, `Guest Conflict ${runId}`]
    );

    await client.query(
      `INSERT INTO reservation_guests (reservation_id, guest_id, role, relationship, is_staying)
       VALUES ($1, $2, 'PRIMARY_GUEST', 'SELF', TRUE), ($3, $2, 'PRIMARY_GUEST', 'SELF', TRUE)`,
      [Number(resB1.rows[0].id), guestIdB, Number(resB2.rows[0].id)]
    );

    // 3. Setup Guest C: already has non-empty phone '087700000000', 1 reservation with phone '087711112222'
    const guestCRes = await client.query(
      `INSERT INTO guests (full_name, normalized_name, phone, normalized_phone, created_property_id)
       VALUES ($1, $2, '087700000000', '087700000000', 1) RETURNING id`,
      [`Guest Existing ${runId}`, `guest existing ${runId}`]
    );
    const guestIdC = Number(guestCRes.rows[0].id);

    const bookingCRes = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES (1, $1, $2, 'ACTIVE') RETURNING id`,
      [`BID-EXIST-${runId}`, `Guest Existing ${runId}`]
    );
    const bookingIdC = Number(bookingCRes.rows[0].id);

    const resC1 = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, booked_room_type_id_snapshot, guest_name, guest_phone,
         check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
         status, payment_status, stay_sequence
       ) VALUES ($1, $2, $3, $4, '087711112222', '2040-03-01', '2040-03-02', 500000, 500000, 0, 500000, 'BOOKED', 'UNPAID', 1)
       RETURNING id`,
      [bookingIdC, roomId, roomTypeId, `Guest Existing ${runId}`]
    );
    await client.query(
      `INSERT INTO reservation_guests (reservation_id, guest_id, role, relationship, is_staying)
       VALUES ($1, $2, 'PRIMARY_GUEST', 'SELF', TRUE)`,
      [Number(resC1.rows[0].id), guestIdC]
    );

    // -------------------------------------------------------------------------
    // TEST DRY-RUN MODE:
    // -------------------------------------------------------------------------
    console.log('Testing reconcilePrimaryGuestPhones in DRY-RUN mode...');
    const dryRunResult = await reconcilePrimaryGuestPhones(client, { isExecuteMode: false });

    // Assert safe candidate includes guestIdA
    const drySafeA = dryRunResult.safe.find(s => s.guestId === guestIdA);
    assert(drySafeA, 'Guest A must be identified as safe in dry-run');
    assert.strictEqual(drySafeA.normalizedPhone, '081122223333');

    // Assert conflicting candidate includes guestIdB
    const dryConfB = dryRunResult.conflicts.find(c => c.guestId === guestIdB);
    assert(dryConfB, 'Guest B must be identified as conflicting in dry-run');

    // Assert guestIdC is neither safe nor conflicting (already has phone)
    assert(!dryRunResult.safe.some(s => s.guestId === guestIdC), 'Guest C must not be in safe');
    assert(!dryRunResult.conflicts.some(c => c.guestId === guestIdC), 'Guest C must not be in conflicts');

    // In dry-run mode, updatedCount must be 0 and DB untouched
    assert.strictEqual(dryRunResult.updatedCount, 0, 'Dry-run updatedCount must be 0');
    const checkGuestADry = await client.query('SELECT phone FROM guests WHERE id = $1', [guestIdA]);
    assert.strictEqual(checkGuestADry.rows[0].phone, null, 'Guest A phone must remain null in dry run');

    console.log('PASS | Dry-Run Mode: Correctly categorized candidates without touching DB');

    // -------------------------------------------------------------------------
    // TEST EXECUTE MODE:
    // -------------------------------------------------------------------------
    console.log('Testing reconcilePrimaryGuestPhones in EXECUTE mode...');
    const execResult = await reconcilePrimaryGuestPhones(client, { isExecuteMode: true });

    // A. Guest A (safe): must be updated
    const checkGuestAExec = await client.query('SELECT phone, normalized_phone FROM guests WHERE id = $1', [guestIdA]);
    assert.strictEqual(checkGuestAExec.rows[0].phone, '0811-2222-3333');
    assert.strictEqual(checkGuestAExec.rows[0].normalized_phone, '081122223333');
    console.log('PASS | Requirement A: Guest with matching normalized phone updated successfully');

    // B & C. Guest B (conflict): MUST NOT BE UPDATED even in execute mode!
    const checkGuestBExec = await client.query('SELECT phone, normalized_phone FROM guests WHERE id = $1', [guestIdB]);
    assert.strictEqual(checkGuestBExec.rows[0].phone, null, 'Conflicting Guest B phone MUST remain null');
    assert.strictEqual(checkGuestBExec.rows[0].normalized_phone, null, 'Conflicting Guest B normalized_phone MUST remain null');
    console.log('PASS | Requirements B & C: Conflicting guest skipped and remained null in execute mode');

    // D. Guest C (already non-empty): MUST NOT BE MODIFIED!
    const checkGuestCExec = await client.query('SELECT phone, normalized_phone FROM guests WHERE id = $1', [guestIdC]);
    assert.strictEqual(checkGuestCExec.rows[0].phone, '087700000000', 'Existing phone must not be overwritten');
    assert.strictEqual(checkGuestCExec.rows[0].normalized_phone, '087700000000', 'Existing normalized phone must not be overwritten');
    console.log('PASS | Requirement D: Existing non-empty phone strictly untouched');

    // Rollback test changes to leave database in pristine state
    await client.query('ROLLBACK');
    console.log('PASS | Transaction safely rolled back, zero test residue');

  } finally {
    client.release();
  }
}

async function main() {
  try {
    await runUnitTests();
    await runIntegrationTests();
    console.log('ALL RECONCILIATION SAFETY TESTS PASSED');
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('FAIL | reconciliation_guest_phone_safety_test failed:', err);
  process.exit(1);
});
