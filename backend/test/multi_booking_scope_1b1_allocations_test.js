/**
 * multi_booking_scope_1b1_allocations_test.js
 *
 * Test suite for MULTI-BOOKING-SCOPE-1B1:
 * Verifies schema changes, foreign key constraints (RESTRICT), composite FK
 * database ownership integrity (cross-booking, cross-property rejection),
 * uniqueness rules, money invariants, idempotency, and non-regression of
 * payment_evidences.
 *
 * Invariant Validation (A through P):
 * A. payment_allocations table exists
 * B. FK delete semantics are RESTRICT (confdeltype = 'r')
 * C. Invalid payment_transaction_id rejected
 * D. Invalid reservation_id rejected
 * E. Invalid booking_id rejected
 * F. Invalid property_id rejected
 * G. allocated_amount <= 0 rejected
 * H. Invalid status rejected
 * I. Valid allocation accepted
 * J. Duplicate allocation for same (payment_transaction_id, reservation_id) rejected
 * K. Cross-booking allocation rejected by database integrity constraint
 * L. Cross-property allocation rejected by database integrity constraint
 * M. Migration rerun idempotent
 * N. Existing payment/deposit/evidence/folio rows unchanged
 * O. payment_evidences.reservation_id remains NOT NULL
 * P. Existing payment evidence invariants remain unchanged
 */

require('dotenv').config();
const { Pool } = require('pg');
const { initializeDatabase } = require('../dist/db/schema_v3');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const runId = `1B1-${String(Date.now()).slice(-8)}`;

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

async function run() {
  const client = await pool.connect();

  // Test fixtures created during this run for cleanup
  const createdAllocationIds = [];
  const createdPaymentIds = [];
  const createdReservationIds = [];
  const createdBookingIds = [];
  const createdPropertyIds = [];

  try {
    console.log(`\n=== RUNNING MULTI-BOOKING-SCOPE-1B1 ALLOCATIONS TESTS [runId=${runId}] ===\n`);

    // Setup: Clean experimental 1B1 artifacts from local test DB (if present)
    // NOTE: Strictly isolated to local test setup; does not touch historical business data.
    await client.query(`
      DROP TABLE IF EXISTS payment_allocations CASCADE;
      ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS uq_payment_transactions_id_booking_id;
      DELETE FROM schema_migrations WHERE version = 'multi_booking_scope_1b_payment_allocations_v1';
    `);

    // 0. Capture pre-migration baseline counts
    const prePayments = await client.query('SELECT COUNT(*)::bigint as count, COALESCE(SUM(amount), 0) as total FROM payment_transactions');
    const preDeposits = await client.query('SELECT COUNT(*)::bigint as count, COALESCE(SUM(original_amount), 0) as total FROM deposits');
    const preFolio = await client.query('SELECT COUNT(*)::bigint as count, COALESCE(SUM(amount), 0) as total FROM folio_entries');
    const preEvidences = await client.query('SELECT COUNT(*)::bigint as count FROM payment_evidences');

    // 1. Run initializeDatabase to execute migration on clean state without v1 marker
    console.log('Running initializeDatabase(pool) [First Run - Clean State]...');
    await initializeDatabase(pool);
    console.log('initializeDatabase(pool) completed successfully.\n');

    // Check M1: Migration v1 recorded in schema_migrations
    console.log('Verifying Migration Immutability & Marker (M)...');
    const migrationRow1 = await client.query(
      `SELECT version FROM schema_migrations WHERE version = 'multi_booking_scope_1b_payment_allocations_v1'`
    );
    check(migrationRow1.rowCount === 1, 'M1. Clean database without v1 marker receives final schema + marker');

    // Check M2: Second initializeDatabase call with marker present performs no schema changes & retains exactly 1 marker
    await initializeDatabase(pool);
    const markerCountRes = await client.query(
      `SELECT COUNT(*)::int as count FROM schema_migrations WHERE version = 'multi_booking_scope_1b_payment_allocations_v1'`
    );
    check(markerCountRes.rows[0].count === 1, 'M2. Second initializeDatabase call with marker present retains exactly 1 marker');

    // Check A: Table exists
    console.log('\nVerifying Table Existence (A)...');
    const tableCheck = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'payment_allocations'`
    );
    check(tableCheck.rowCount === 1, 'A. payment_allocations table exists in information_schema');

    // Check Parent UNIQUE Constraints:
    console.log('\nVerifying Parent Unique Constraints...');
    const uqBkProp = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = 'uq_bookings_id_property_id'`);
    check(uqBkProp.rowCount === 1, 'U1. bookings table has composite UNIQUE uq_bookings_id_property_id (id, property_id)');

    const uqResBk = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = 'uq_reservations_id_booking_id'`);
    check(uqResBk.rowCount === 1, 'U2. reservations table has composite UNIQUE uq_reservations_id_booking_id (id, booking_id)');

    const uqPtProp = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = 'uq_payment_transactions_id_booking_property'`);
    check(uqPtProp.rowCount === 1, 'U3. payment_transactions table has composite UNIQUE uq_payment_transactions_id_booking_property (id, booking_id, property_id)');

    const uqPtBkOld = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = 'uq_payment_transactions_id_booking_id'`);
    check(uqPtBkOld.rowCount === 0, 'U4. payment_transactions table DOES NOT have redundant 2-column UNIQUE uq_payment_transactions_id_booking_id');

    // Check B: All FK delete actions are RESTRICT (confdeltype = 'r')
    console.log('\nVerifying FK Delete Semantics & Catalog Constraints (B)...');
    const fkCheck = await client.query(`
      SELECT
        c.conname,
        c.confdeltype,
        CASE c.confdeltype
          WHEN 'r' THEN 'RESTRICT'
          WHEN 'c' THEN 'CASCADE'
          WHEN 'n' THEN 'SET NULL'
          WHEN 'd' THEN 'SET DEFAULT'
          WHEN 'a' THEN 'NO ACTION'
          ELSE c.confdeltype::text
        END as action_label
      FROM pg_constraint c
      WHERE c.conrelid = 'payment_allocations'::regclass
        AND c.contype = 'f'
      ORDER BY c.conname;
    `);

    check(fkCheck.rows.length === 7, `B1. Found exactly ${fkCheck.rows.length} foreign keys on payment_allocations (expected 7)`);
    const allRestrict = fkCheck.rows.every((row) => row.confdeltype === 'r');
    check(allRestrict, 'B2. All foreign keys on payment_allocations have confdeltype = "r" (RESTRICT)');
    for (const row of fkCheck.rows) {
      console.log(`     FK: ${row.conname} -> ${row.action_label} (${row.confdeltype})`);
    }

    const has3ColFk = fkCheck.rows.some((row) => row.conname === 'fk_payment_alloc_pt_booking_prop');
    check(has3ColFk, 'B3. payment_allocations contains canonical 3-column FK fk_payment_alloc_pt_booking_prop');

    const hasOld2ColFk = fkCheck.rows.some((row) => row.conname === 'fk_payment_alloc_pt_booking');
    check(!hasOld2ColFk, 'B4. payment_allocations DOES NOT contain superseded 2-column FK fk_payment_alloc_pt_booking');

    // Check O: payment_evidences.reservation_id remains NOT NULL
    console.log('\nVerifying payment_evidences Schema Preservation (O, P)...');
    const peColCheck = await client.query(`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'payment_evidences' AND column_name = 'reservation_id'
    `);
    check(peColCheck.rowCount === 1, 'O1. payment_evidences.reservation_id column exists');
    check(peColCheck.rows[0].is_nullable === 'NO', 'O2. payment_evidences.reservation_id remains strictly NOT NULL');

    // Check P: payment_evidences invariants preserved
    const peFkCheck = await client.query(`
      SELECT conname, confdeltype
      FROM pg_constraint
      WHERE conrelid = 'payment_evidences'::regclass AND contype = 'f'
    `);
    const peHasRestrict = peFkCheck.rows.some((row) => row.confdeltype === 'r');
    check(peHasRestrict, 'P. payment_evidences foreign keys remain active with RESTRICT semantics');

    // Setup Test Fixtures: Property, Bookings, Reservations, PaymentTransactions
    console.log('\nSetting up isolated test fixtures...');
    const propCode1 = `P${String(Date.now()).slice(-5)}`;
    const propRes = await client.query(`
      INSERT INTO properties (name, property_code)
      VALUES ('Prop ${runId}', $1)
      RETURNING id
    `, [propCode1]);
    const propId = propRes.rows[0].id;
    createdPropertyIds.push(propId);

    // Booking 1
    const b1Res = await client.query(`
      INSERT INTO bookings (bid, property_id, guest_name_snapshot)
      VALUES ('BID1-${runId}', $1, 'Guest B1')
      RETURNING id
    `, [propId]);
    const b1Id = b1Res.rows[0].id;
    createdBookingIds.push(b1Id);

    // Reservation 1 (belongs to Booking 1)
    const r1Res = await client.query(`
      INSERT INTO reservations (booking_id, guest_name, stay_sequence, check_in, check_out, status, total_price)
      VALUES ($1, 'Guest B1 Room 1', 1, '2026-09-11', '2026-09-12', 'BOOKED', 500000)
      RETURNING id
    `, [b1Id]);
    const r1Id = r1Res.rows[0].id;
    createdReservationIds.push(r1Id);

    // Reservation 2 (also belongs to Booking 1)
    const r2Res = await client.query(`
      INSERT INTO reservations (booking_id, guest_name, stay_sequence, check_in, check_out, status, total_price)
      VALUES ($1, 'Guest B1 Room 2', 2, '2026-09-11', '2026-09-12', 'BOOKED', 500000)
      RETURNING id
    `, [b1Id]);
    const r2Id = r2Res.rows[0].id;
    createdReservationIds.push(r2Id);

    // Payment 1 for Booking 1 (Group Payment, Rp 1.000.000)
    const pt1Res = await client.query(`
      INSERT INTO payment_transactions (property_id, booking_id, amount, scope, status, transaction_type)
      VALUES ($1, $2, 1000000.00, 'BOOKING_GROUP', 'SUCCESS', 'PAYMENT')
      RETURNING id
    `, [propId, b1Id]);
    const pt1Id = pt1Res.rows[0].id;
    createdPaymentIds.push(pt1Id);

    // Booking 2 & Reservation 3 & Payment 2 (for cross-booking test)
    const b2Res = await client.query(`
      INSERT INTO bookings (bid, property_id, guest_name_snapshot)
      VALUES ('BID2-${runId}', $1, 'Guest B2')
      RETURNING id
    `, [propId]);
    const b2Id = b2Res.rows[0].id;
    createdBookingIds.push(b2Id);

    const r3Res = await client.query(`
      INSERT INTO reservations (booking_id, guest_name, stay_sequence, check_in, check_out, status, total_price)
      VALUES ($1, 'Guest B2 Room 1', 1, '2026-09-11', '2026-09-12', 'BOOKED', 750000)
      RETURNING id
    `, [b2Id]);
    const r3Id = r3Res.rows[0].id;
    createdReservationIds.push(r3Id);

    const pt2Res = await client.query(`
      INSERT INTO payment_transactions (property_id, booking_id, amount, scope, status, transaction_type)
      VALUES ($1, $2, 750000.00, 'BOOKING_GROUP', 'SUCCESS', 'PAYMENT')
      RETURNING id
    `, [propId, b2Id]);
    const pt2Id = pt2Res.rows[0].id;
    createdPaymentIds.push(pt2Id);

    // Property 2 (for cross-property test)
    const propCode2 = `Q${String(Date.now()).slice(-5)}`;
    const prop2Res = await client.query(`
      INSERT INTO properties (name, property_code)
      VALUES ('Prop2 ${runId}', $1)
      RETURNING id
    `, [propCode2]);
    const prop2Id = prop2Res.rows[0].id;
    createdPropertyIds.push(prop2Id);

    console.log('Fixtures established successfully.\n');

    async function expectDbError(queryFn, expectedCode, expectedConstraint) {
      await client.query('BEGIN');
      try {
        await queryFn();
        await client.query('COMMIT');
        return false;
      } catch (err) {
        await client.query('ROLLBACK');
        if (expectedConstraint) {
          return err.code === expectedCode && err.constraint === expectedConstraint;
        }
        return err.code === expectedCode;
      }
    }

    // Check C: Invalid payment_transaction_id rejected
    console.log('Verifying FK Violation Rejections (C, D, E, F)...');
    const cRejected = await expectDbError(
      () => client.query(`
        INSERT INTO payment_allocations (payment_transaction_id, reservation_id, booking_id, property_id, allocated_amount)
        VALUES (999999999, $1, $2, $3, 100000)
      `, [r1Id, b1Id, propId]),
      '23503'
    );
    check(cRejected, 'C. Invalid payment_transaction_id rejected with foreign_key_violation (23503)');

    // Check D: Invalid reservation_id rejected
    const dRejected = await expectDbError(
      () => client.query(`
        INSERT INTO payment_allocations (payment_transaction_id, reservation_id, booking_id, property_id, allocated_amount)
        VALUES ($1, 999999999, $2, $3, 100000)
      `, [pt1Id, b1Id, propId]),
      '23503'
    );
    check(dRejected, 'D. Invalid reservation_id rejected with foreign_key_violation (23503)');

    // Check E: Invalid booking_id rejected
    const eRejected = await expectDbError(
      () => client.query(`
        INSERT INTO payment_allocations (payment_transaction_id, reservation_id, booking_id, property_id, allocated_amount)
        VALUES ($1, $2, 999999999, $3, 100000)
      `, [pt1Id, r1Id, propId]),
      '23503'
    );
    check(eRejected, 'E. Invalid booking_id rejected with foreign_key_violation (23503)');

    // Check F: Invalid property_id rejected
    const fRejected = await expectDbError(
      () => client.query(`
        INSERT INTO payment_allocations (payment_transaction_id, reservation_id, booking_id, property_id, allocated_amount)
        VALUES ($1, $2, $3, 999999999, 100000)
      `, [pt1Id, r1Id, b1Id]),
      '23503'
    );
    check(fRejected, 'F. Invalid property_id rejected with foreign_key_violation (23503)');

    // Check G: allocated_amount <= 0 rejected
    console.log('\nVerifying Check Constraints (G, H)...');
    const gZeroRejected = await expectDbError(
      () => client.query(`
        INSERT INTO payment_allocations (payment_transaction_id, reservation_id, booking_id, property_id, allocated_amount)
        VALUES ($1, $2, $3, $4, 0.00)
      `, [pt1Id, r1Id, b1Id, propId]),
      '23514'
    );
    const gNegRejected = await expectDbError(
      () => client.query(`
        INSERT INTO payment_allocations (payment_transaction_id, reservation_id, booking_id, property_id, allocated_amount)
        VALUES ($1, $2, $3, $4, -50000.00)
      `, [pt1Id, r1Id, b1Id, propId]),
      '23514'
    );
    check(gZeroRejected && gNegRejected, 'G. allocated_amount <= 0 rejected with check_violation (23514)');

    // Check H: Invalid status rejected
    const hRejected = await expectDbError(
      () => client.query(`
        INSERT INTO payment_allocations (payment_transaction_id, reservation_id, booking_id, property_id, allocated_amount, status)
        VALUES ($1, $2, $3, $4, 100000.00, 'INVALID_STATUS')
      `, [pt1Id, r1Id, b1Id, propId]),
      '23514'
    );
    check(hRejected, 'H. Invalid status rejected with check_violation (23514)');

    // Check I: Valid allocation accepted
    console.log('\nVerifying Valid Allocation Creation (I)...');
    const validAlloc1 = await client.query(`
      INSERT INTO payment_allocations (
        payment_transaction_id, reservation_id, booking_id, property_id,
        allocated_amount, allocation_sequence, status, notes, created_by
      ) VALUES ($1, $2, $3, $4, 500000.00, 1, 'ACTIVE', 'Initial room 1 allocation', 'Staff Tester')
      RETURNING *
    `, [pt1Id, r1Id, b1Id, propId]);
    check(validAlloc1.rowCount === 1, 'I1. Valid allocation 1 inserted successfully');
    createdAllocationIds.push(validAlloc1.rows[0].id);

    const validAlloc2 = await client.query(`
      INSERT INTO payment_allocations (
        payment_transaction_id, reservation_id, booking_id, property_id,
        allocated_amount, allocation_sequence, status, notes, created_by
      ) VALUES ($1, $2, $3, $4, 500000.00, 2, 'ACTIVE', 'Initial room 2 allocation', 'Staff Tester')
      RETURNING *
    `, [pt1Id, r2Id, b1Id, propId]);
    check(validAlloc2.rowCount === 1, 'I2. Valid allocation 2 inserted successfully');
    createdAllocationIds.push(validAlloc2.rows[0].id);

    check(
      Number(validAlloc1.rows[0].allocated_amount) + Number(validAlloc2.rows[0].allocated_amount) === 1000000,
      'I3. Sum of active child allocations strictly equals canonical payment amount (1.000.000)'
    );

    // Check J: Duplicate allocation rejected
    console.log('\nVerifying Uniqueness Constraint (J)...');
    const jRejected = await expectDbError(
      () => client.query(`
        INSERT INTO payment_allocations (payment_transaction_id, reservation_id, booking_id, property_id, allocated_amount)
        VALUES ($1, $2, $3, $4, 100000.00)
      `, [pt1Id, r1Id, b1Id, propId]),
      '23505'
    );
    check(jRejected, 'J. Duplicate allocation for same (payment_transaction_id, reservation_id) rejected with unique_violation (23505)');

    // Check K: Cross-booking allocation rejected by database integrity mechanism
    console.log('\nVerifying Cross-Booking Database Ownership Integrity (K)...');
    // Attempting to allocate pt1 (Booking 1) to r3 (Booking 2) using booking_id = b1Id
    // Should fail fk_payment_alloc_res_booking because (r3Id, b1Id) does not exist in reservations!
    const k1Rejected = await expectDbError(
      () => client.query(`
        INSERT INTO payment_allocations (payment_transaction_id, reservation_id, booking_id, property_id, allocated_amount)
        VALUES ($1, $2, $3, $4, 100000.00)
      `, [pt1Id, r3Id, b1Id, propId]),
      '23503',
      'fk_payment_alloc_res_booking'
    );
    check(k1Rejected, 'K1. Cross-booking allocation rejected: reservation belongs to a different booking (fk_payment_alloc_res_booking)');

    // Attempting to allocate pt1 (Booking 1) to r3 (Booking 2) using booking_id = b2Id
    // Should fail fk_payment_alloc_pt_booking_prop because (pt1Id, b2Id, propId) does not exist in payment_transactions!
    const k2Rejected = await expectDbError(
      () => client.query(`
        INSERT INTO payment_allocations (payment_transaction_id, reservation_id, booking_id, property_id, allocated_amount)
        VALUES ($1, $2, $3, $4, 100000.00)
      `, [pt1Id, r3Id, b2Id, propId]),
      '23503',
      'fk_payment_alloc_pt_booking_prop'
    );
    check(k2Rejected, 'K2. Cross-booking allocation rejected: payment belongs to a different booking (fk_payment_alloc_pt_booking_prop)');

    // Check L: Cross-property database ownership integrity
    console.log('\nVerifying Cross-Property Database Ownership Integrity (L)...');
    // L1. Attempting to allocate pt2 (Booking 2, Prop 1) with prop2Id (Prop 2)
    // Should fail fk_payment_alloc_booking_prop because (b2Id, prop2Id) does not exist in bookings!
    const l1Rejected = await expectDbError(
      () => client.query(`
        INSERT INTO payment_allocations (payment_transaction_id, reservation_id, booking_id, property_id, allocated_amount)
        VALUES ($1, $2, $3, $4, 100000.00)
      `, [pt2Id, r3Id, b2Id, prop2Id]),
      '23503',
      'fk_payment_alloc_booking_prop'
    );
    check(l1Rejected, 'L1. Cross-property allocation rejected: allocation.property_id != booking.property_id (fk_payment_alloc_booking_prop)');

    // L2. Explicit regression test: Malformed payment_transaction where pt.property_id != booking.property_id
    // Property A (propId), Property B (prop2Id)
    // Booking A (b1Id) belongs to Property A
    // Create malformed payment whose booking_id = b1Id, but property_id = prop2Id
    const malformedPtRes = await client.query(`
      INSERT INTO payment_transactions (property_id, booking_id, amount, scope, status)
      VALUES ($1, $2, 250000.00, 'BOOKING_GROUP', 'SUCCESS')
      RETURNING id
    `, [prop2Id, b1Id]);
    const malformedPtId = malformedPtRes.rows[0].id;
    createdPaymentIds.push(malformedPtId);

    // Case A: Allocation provides property_id = propId (matching booking A)
    // Rejected because (malformedPtId, b1Id, propId) does NOT exist in payment_transactions!
    const l2CaseARejected = await expectDbError(
      () => client.query(`
        INSERT INTO payment_allocations (payment_transaction_id, reservation_id, booking_id, property_id, allocated_amount)
        VALUES ($1, $2, $3, $4, 250000.00)
      `, [malformedPtId, r2Id, b1Id, propId]),
      '23503',
      'fk_payment_alloc_pt_booking_prop'
    );
    check(l2CaseARejected, 'L2-A. Allocation to malformed payment rejected when alloc.prop = booking.prop (fk_payment_alloc_pt_booking_prop)');

    // Case B: Allocation provides property_id = prop2Id (matching malformed pt)
    // Rejected because (b1Id, prop2Id) does NOT exist in bookings!
    const l2CaseBRejected = await expectDbError(
      () => client.query(`
        INSERT INTO payment_allocations (payment_transaction_id, reservation_id, booking_id, property_id, allocated_amount)
        VALUES ($1, $2, $3, $4, 250000.00)
      `, [malformedPtId, r2Id, b1Id, prop2Id]),
      '23503',
      'fk_payment_alloc_booking_prop'
    );
    check(l2CaseBRejected, 'L2-B. Allocation to malformed payment rejected when alloc.prop = payment.prop (fk_payment_alloc_booking_prop)');

    // Clean up test allocations so we can test RESTRICT deletion on parent entities
    console.log('\nTesting RESTRICT Delete Behavior on Parent Entities...');
    const delPtBlocked = await expectDbError(
      () => client.query('DELETE FROM payment_transactions WHERE id = $1', [pt1Id]),
      '23503'
    );
    check(delPtBlocked, 'B3. Deleting parent payment_transaction blocked by ON DELETE RESTRICT (23503)');

    const delResBlocked = await expectDbError(
      () => client.query('DELETE FROM reservations WHERE id = $1', [r1Id]),
      '23503'
    );
    check(delResBlocked, 'B4. Deleting parent reservation blocked by ON DELETE RESTRICT (23503)');

    const delBkBlocked = await expectDbError(
      () => client.query('DELETE FROM bookings WHERE id = $1', [b1Id]),
      '23503'
    );
    check(delBkBlocked, 'B5. Deleting parent booking blocked by ON DELETE RESTRICT (23503)');

    // Clean up created test allocations
    if (createdAllocationIds.length > 0) {
      await client.query('DELETE FROM payment_allocations WHERE id = ANY($1)', [createdAllocationIds]);
    }

    // Clean up test payments
    if (createdPaymentIds.length > 0) {
      await client.query('DELETE FROM payment_transactions WHERE id = ANY($1)', [createdPaymentIds]);
    }

    // Clean up test reservations
    if (createdReservationIds.length > 0) {
      await client.query('DELETE FROM reservations WHERE id = ANY($1)', [createdReservationIds]);
    }

    // Clean up test bookings
    if (createdBookingIds.length > 0) {
      await client.query('DELETE FROM bookings WHERE id = ANY($1)', [createdBookingIds]);
    }

    // Clean up test properties
    if (createdPropertyIds.length > 0) {
      await client.query('DELETE FROM properties WHERE id = ANY($1)', [createdPropertyIds]);
    }

    // Check N: Existing payment/deposit/evidence/folio rows unchanged
    console.log('\nVerifying Existing Data Integrity (N)...');
    const postPayments = await client.query('SELECT COUNT(*)::bigint as count, COALESCE(SUM(amount), 0) as total FROM payment_transactions');
    const postDeposits = await client.query('SELECT COUNT(*)::bigint as count, COALESCE(SUM(original_amount), 0) as total FROM deposits');
    const postFolio = await client.query('SELECT COUNT(*)::bigint as count, COALESCE(SUM(amount), 0) as total FROM folio_entries');
    const postEvidences = await client.query('SELECT COUNT(*)::bigint as count FROM payment_evidences');

    check(
      prePayments.rows[0].count === postPayments.rows[0].count && prePayments.rows[0].total === postPayments.rows[0].total,
      'N1. payment_transactions count and total amount completely unchanged'
    );
    check(
      preDeposits.rows[0].count === postDeposits.rows[0].count && preDeposits.rows[0].total === postDeposits.rows[0].total,
      'N2. deposits count and total amount completely unchanged'
    );
    check(
      preFolio.rows[0].count === postFolio.rows[0].count && preFolio.rows[0].total === postFolio.rows[0].total,
      'N3. folio_entries count and total amount completely unchanged'
    );
    check(
      preEvidences.rows[0].count === postEvidences.rows[0].count,
      'N4. payment_evidences count completely unchanged'
    );

    console.log('\n=== MULTI-BOOKING-SCOPE-1B1 SUMMARY ===');
    console.log(`TOTAL CHECKS: ${passed + failed}`);
    console.log(`PASSED: ${passed}`);
    console.log(`FAILED: ${failed}`);

    if (failed > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('UNEXPECTED TEST ERROR:', err);
    process.exitCode = 1;
  } finally {
    try {
      if (createdAllocationIds.length > 0) {
        await client.query('DELETE FROM payment_allocations WHERE id = ANY($1)', [createdAllocationIds]);
      }
      if (createdPaymentIds.length > 0) {
        await client.query('DELETE FROM payment_transactions WHERE id = ANY($1)', [createdPaymentIds]);
      }
      if (createdReservationIds.length > 0) {
        await client.query('DELETE FROM reservations WHERE id = ANY($1)', [createdReservationIds]);
      }
      if (createdBookingIds.length > 0) {
        await client.query('DELETE FROM bookings WHERE id = ANY($1)', [createdBookingIds]);
      }
      if (createdPropertyIds.length > 0) {
        await client.query('DELETE FROM properties WHERE id = ANY($1)', [createdPropertyIds]);
      }
    } catch (cleanErr) {
      console.error('Fixture cleanup error:', cleanErr);
    }
    client.release();
    await pool.end();
  }
}

run();
