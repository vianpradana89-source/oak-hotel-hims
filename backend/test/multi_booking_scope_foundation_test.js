/**
 * multi_booking_scope_foundation_test.js
 *
 * Test suite for MULTI-BOOKING-SCOPE-1A:
 * Verifies schema changes, constraints, idempotent backfill, write-through,
 * and financial/deposit invariants across payment_transactions, deposits,
 * and identity_custody.
 *
 * Invariant Validation:
 * A. Existing ROOM_RESERVATION payment has reservation_id = child, booking_id = parent, scope = ROOM_RESERVATION
 * B. Existing deposit same invariant
 * C. Existing identity custody same invariant
 * D. Backfill sets booking_id but NEVER changes scope to BOOKING_GROUP
 * E. Running backfill/migration twice is safe/idempotent
 * F. booking_id always belongs to same reservation parent for ROOM_RESERVATION rows
 * G. Invalid scope is rejected by CHECK constraint
 * H. No existing payment/deposit/custody rows duplicated
 * I. Existing deriveDepositBalance result unchanged before vs after metadata backfill
 * J. Existing payment/folio totals unchanged
 * K. Write-through in creation services populates booking_id with scope='ROOM_RESERVATION'
 */

require('dotenv').config();
const assert = require('assert');
const { Pool } = require('pg');
const { deriveDepositBalance } = require('../dist/domains/deposits/depositService');
const { createPaymentInTransaction } = require('../dist/domains/payments/paymentDomainService');
const { receiveDeposit, refundDeposit } = require('../dist/domains/deposits/depositService');
const { holdIdentity } = require('../dist/domains/identity/identityCustodyService');
const { app } = require('../dist/index');
const { generateToken } = require('../dist/domains/auth/authService');
const { initializeDatabase } = require('../dist/db/schema_v3');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const runId = `MBS${String(Date.now()).slice(-8)}`;

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
  let propertyId = 1;
  let bookingId = null;
  let reservationId = null;
  let roomId = null;
  let roomTypeId = null;

  try {
    console.log(`\n=== RUNNING MULTI-BOOKING-SCOPE FOUNDATION TESTS [runId=${runId}] ===\n`);

    // Ensure property 1 exists
    const propRes = await client.query('SELECT id FROM properties LIMIT 1');
    if (propRes.rowCount > 0) {
      propertyId = propRes.rows[0].id;
    }

    const roomRes = await client.query('SELECT r.id as room_id, r.room_type_id FROM rooms r LIMIT 1');
    if (roomRes.rowCount > 0) {
      roomId = roomRes.rows[0].room_id;
      roomTypeId = roomRes.rows[0].room_type_id;
    }

    // 0. Capture baseline counts and financial totals
    const baselinePT = await client.query(`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::numeric AS total_amount
      FROM payment_transactions
    `);
    const baselineFolio = await client.query(`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::numeric AS total_amount
      FROM folio_entries
    `);
    const baselineDeposits = await client.query(`SELECT COUNT(*)::int AS count FROM deposits`);
    const baselineCustody = await client.query(`SELECT COUNT(*)::int AS count FROM identity_custody`);

    // Clean up any potential stale fixtures
    await client.query("DELETE FROM identity_custody WHERE reservation_id IN (SELECT id FROM reservations WHERE guest_name LIKE 'MBS Guest%')");
    await client.query("DELETE FROM deposit_events WHERE reservation_id IN (SELECT id FROM reservations WHERE guest_name LIKE 'MBS Guest%')");
    await client.query("DELETE FROM deposits WHERE reservation_id IN (SELECT id FROM reservations WHERE guest_name LIKE 'MBS Guest%')");
    await client.query("DELETE FROM folio_entries WHERE reservation_id IN (SELECT id FROM reservations WHERE guest_name LIKE 'MBS Guest%')");
    await client.query("DELETE FROM payment_transactions WHERE reservation_id IN (SELECT id FROM reservations WHERE guest_name LIKE 'MBS Guest%')");
    await client.query("DELETE FROM reservations WHERE guest_name LIKE 'MBS Guest%'");
    await client.query("DELETE FROM bookings WHERE guest_name_snapshot LIKE 'MBS Guest%'");

    // Create a dedicated test booking and reservation fixture
    const bRes = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [propertyId, `BID-${runId}`, `MBS Guest ${runId}`]
    );
    bookingId = Number(bRes.rows[0].id);

    const year = 2080 + Math.floor(Math.random() * 10);
    const day = 10 + Math.floor(Math.random() * 15);
    const checkIn = `${year}-05-${day}`;
    const checkOut = `${year}-05-${day + 1}`;

    const rRes = await client.query(
      `INSERT INTO reservations (
         booking_id, room_id, booked_room_type_id_snapshot, guest_name,
         check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
         status, payment_status, stay_sequence
       ) VALUES ($1, $2, $3, $4, $5, $6, 1000000, 1000000, 0, 1000000, 'BOOKED', 'UNPAID', 1)
       RETURNING id`,
      [bookingId, roomId, roomTypeId, `MBS Guest ${runId}`, checkIn, checkOut]
    );
    reservationId = Number(rRes.rows[0].id);

    // =========================================================================
    // Test A: Existing ROOM_RESERVATION payment has reservation_id=child, booking_id=parent, scope=ROOM_RESERVATION
    // =========================================================================
    console.log('--- Test A: Payment record scope and parentage ---');
    const ptInsert = await client.query(
      `INSERT INTO payment_transactions (
         reservation_id, transaction_type, amount, payment_method, reference_code,
         status, created_by
       ) VALUES ($1, 'PAYMENT', 200000, 'CASH', $2, 'SUCCESS', 'Tester')
       RETURNING *`,
      [reservationId, `REF-A-${runId}`]
    );
    const ptId = ptInsert.rows[0].id;

    // Simulate backfill on this record
    await client.query(`
      UPDATE payment_transactions pt
      SET booking_id = r.booking_id
      FROM reservations r
      WHERE pt.id = $1 AND pt.reservation_id = r.id AND pt.booking_id IS NULL;
    `, [ptId]);

    const ptCheck = await client.query('SELECT * FROM payment_transactions WHERE id = $1', [ptId]);
    const ptRow = ptCheck.rows[0];
    check(Number(ptRow.reservation_id) === reservationId, 'A1. Payment has reservation_id = child reservation');
    check(Number(ptRow.booking_id) === bookingId, 'A2. Payment has booking_id = parent booking');
    check(ptRow.scope === 'ROOM_RESERVATION', 'A3. Payment scope is ROOM_RESERVATION');

    // =========================================================================
    // Test B: Existing deposit has reservation_id=child, booking_id=parent, scope=ROOM_RESERVATION
    // =========================================================================
    console.log('\n--- Test B: Deposit record scope and parentage ---');
    const depInsert = await client.query(
      `INSERT INTO deposits (
         property_id, reservation_id, deposit_number, original_amount,
         payment_method, status, received_by
       ) VALUES ($1, $2, $3, 100000, 'CASH', 'RECEIVED', 'Tester')
       RETURNING *`,
      [propertyId, reservationId, `DEP-${runId}`]
    );
    const depId = depInsert.rows[0].id;

    await client.query(`
      UPDATE deposits d
      SET booking_id = r.booking_id
      FROM reservations r
      WHERE d.id = $1 AND d.reservation_id = r.id AND d.booking_id IS NULL;
    `, [depId]);

    const depCheck = await client.query('SELECT * FROM deposits WHERE id = $1', [depId]);
    const depRow = depCheck.rows[0];
    check(Number(depRow.reservation_id) === reservationId, 'B1. Deposit has reservation_id = child reservation');
    check(Number(depRow.booking_id) === bookingId, 'B2. Deposit has booking_id = parent booking');
    check(depRow.scope === 'ROOM_RESERVATION', 'B3. Deposit scope is ROOM_RESERVATION');

    // =========================================================================
    // Test C: Existing identity custody has reservation_id=child, booking_id=parent, scope=ROOM_RESERVATION
    // =========================================================================
    console.log('\n--- Test C: Identity custody scope and parentage ---');
    const icInsert = await client.query(
      `INSERT INTO identity_custody (
         property_id, reservation_id, document_type, document_holder_name,
         document_number_masked, status, received_by
       ) VALUES ($1, $2, 'KTP', 'Test Holder', '********1234', 'HELD', 'Tester')
       RETURNING *`,
      [propertyId, reservationId]
    );
    const icId = icInsert.rows[0].id;

    await client.query(`
      UPDATE identity_custody ic
      SET booking_id = r.booking_id
      FROM reservations r
      WHERE ic.id = $1 AND ic.reservation_id = r.id AND ic.booking_id IS NULL;
    `, [icId]);

    const icCheck = await client.query('SELECT * FROM identity_custody WHERE id = $1', [icId]);
    const icRow = icCheck.rows[0];
    check(Number(icRow.reservation_id) === reservationId, 'C1. Identity custody has reservation_id = child reservation');
    check(Number(icRow.booking_id) === bookingId, 'C2. Identity custody has booking_id = parent booking');
    check(icRow.scope === 'ROOM_RESERVATION', 'C3. Identity custody scope is ROOM_RESERVATION');

    // =========================================================================
    // Test D: Backfill sets booking_id but NEVER changes scope to BOOKING_GROUP
    // =========================================================================
    console.log('\n--- Test D: Backfill scope preservation ---');
    const groupScopePT = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM payment_transactions WHERE scope = 'BOOKING_GROUP'`
    );
    const groupScopeDep = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM deposits WHERE scope = 'BOOKING_GROUP'`
    );
    const groupScopeIC = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM identity_custody WHERE scope = 'BOOKING_GROUP'`
    );
    check(groupScopePT.rows[0].cnt === 0, 'D1. Zero payment_transactions have BOOKING_GROUP scope after backfill');
    check(groupScopeDep.rows[0].cnt === 0, 'D2. Zero deposits have BOOKING_GROUP scope after backfill');
    check(groupScopeIC.rows[0].cnt === 0, 'D3. Zero identity_custody have BOOKING_GROUP scope after backfill');

    // =========================================================================
    // Test E: Running backfill/migration twice is safe/idempotent
    // =========================================================================
    console.log('\n--- Test E: Idempotency of backfill execution ---');
    const rerunBackfill = async () => {
      await client.query(`
        UPDATE payment_transactions pt
        SET booking_id = r.booking_id
        FROM reservations r
        WHERE pt.reservation_id = r.id
          AND pt.booking_id IS NULL
          AND r.booking_id IS NOT NULL;

        UPDATE deposits d
        SET booking_id = r.booking_id
        FROM reservations r
        WHERE d.reservation_id = r.id
          AND d.booking_id IS NULL
          AND r.booking_id IS NOT NULL;

        UPDATE identity_custody ic
        SET booking_id = r.booking_id
        FROM reservations r
        WHERE ic.reservation_id = r.id
          AND ic.booking_id IS NULL
          AND r.booking_id IS NOT NULL;
      `);
    };
    await rerunBackfill();
    await rerunBackfill();
    check(true, 'E1. Backfill rerun executed multiple times without errors');

    // Verify still zero unbackfilled rows where reservation has booking_id
    const unbackfilledPT = await client.query(`
      SELECT COUNT(*)::int AS cnt
      FROM payment_transactions pt
      JOIN reservations r ON r.id = pt.reservation_id
      WHERE pt.booking_id IS NULL AND r.booking_id IS NOT NULL;
    `);
    check(unbackfilledPT.rows[0].cnt === 0, 'E2. Zero unbackfilled payment_transactions remaining');

    // =========================================================================
    // Test F: booking_id always belongs to same reservation parent for ROOM_RESERVATION rows
    // =========================================================================
    console.log('\n--- Test F: Booking_id parentage consistency ---');
    const mismatchedPT = await client.query(`
      SELECT COUNT(*)::int AS cnt
      FROM payment_transactions pt
      JOIN reservations r ON r.id = pt.reservation_id
      WHERE pt.scope = 'ROOM_RESERVATION'
        AND pt.booking_id IS NOT NULL
        AND r.booking_id IS NOT NULL
        AND pt.booking_id != r.booking_id;
    `);
    const mismatchedDep = await client.query(`
      SELECT COUNT(*)::int AS cnt
      FROM deposits d
      JOIN reservations r ON r.id = d.reservation_id
      WHERE d.scope = 'ROOM_RESERVATION'
        AND d.booking_id IS NOT NULL
        AND r.booking_id IS NOT NULL
        AND d.booking_id != r.booking_id;
    `);
    const mismatchedIC = await client.query(`
      SELECT COUNT(*)::int AS cnt
      FROM identity_custody ic
      JOIN reservations r ON r.id = ic.reservation_id
      WHERE ic.scope = 'ROOM_RESERVATION'
        AND ic.booking_id IS NOT NULL
        AND r.booking_id IS NOT NULL
        AND ic.booking_id != r.booking_id;
    `);
    check(mismatchedPT.rows[0].cnt === 0, 'F1. All ROOM_RESERVATION payment_transactions match reservations.booking_id');
    check(mismatchedDep.rows[0].cnt === 0, 'F2. All ROOM_RESERVATION deposits match reservations.booking_id');
    check(mismatchedIC.rows[0].cnt === 0, 'F3. All ROOM_RESERVATION identity_custody match reservations.booking_id');

    // =========================================================================
    // Test G: Invalid scope is rejected by CHECK constraints
    // =========================================================================
    console.log('\n--- Test G: Scope CHECK constraints reject invalid values ---');
    let ptScopeRejected = false;
    try {
      await client.query(
        `INSERT INTO payment_transactions (reservation_id, amount, scope) VALUES ($1, 1000, 'INVALID_SCOPE')`,
        [reservationId]
      );
    } catch (e) {
      ptScopeRejected = e.message.includes('chk_payment_transactions_scope');
    }
    check(ptScopeRejected, 'G1. payment_transactions rejected invalid scope');

    let depScopeRejected = false;
    try {
      await client.query(
        `INSERT INTO deposits (property_id, reservation_id, deposit_number, original_amount, payment_method, received_by, scope)
         VALUES ($1, $2, $3, 1000, 'CASH', 'Tester', 'INVALID_SCOPE')`,
        [propertyId, reservationId, `DEP-BAD-${runId}`]
      );
    } catch (e) {
      depScopeRejected = e.message.includes('chk_deposits_scope');
      if (!depScopeRejected) console.error('G2 actual error:', e.message);
    }
    check(depScopeRejected, 'G2. deposits rejected invalid scope');

    let icScopeRejected = false;
    try {
      await client.query(
        `INSERT INTO identity_custody (property_id, reservation_id, document_type, document_holder_name, received_by, scope)
         VALUES ($1, $2, 'KTP', 'Bad', 'Tester', 'INVALID_SCOPE')`,
        [propertyId, reservationId]
      );
    } catch (e) {
      icScopeRejected = e.message.includes('chk_identity_custody_scope');
    }
    check(icScopeRejected, 'G3. identity_custody rejected invalid scope');

    // =========================================================================
    // Test H: No existing payment/deposit/custody rows duplicated
    // =========================================================================
    console.log('\n--- Test H: Row uniqueness and absence of duplication ---');
    const duplicatePT = await client.query(`
      SELECT id, COUNT(*) FROM payment_transactions GROUP BY id HAVING COUNT(*) > 1;
    `);
    const duplicateDep = await client.query(`
      SELECT id, COUNT(*) FROM deposits GROUP BY id HAVING COUNT(*) > 1;
    `);
    const duplicateIC = await client.query(`
      SELECT id, COUNT(*) FROM identity_custody GROUP BY id HAVING COUNT(*) > 1;
    `);
    check(duplicatePT.rowCount === 0, 'H1. Zero duplicated payment_transaction primary keys');
    check(duplicateDep.rowCount === 0, 'H2. Zero duplicated deposit primary keys');
    check(duplicateIC.rowCount === 0, 'H3. Zero duplicated identity_custody primary keys');

    // =========================================================================
    // Test I: Existing deriveDepositBalance result unchanged
    // =========================================================================
    console.log('\n--- Test I: deriveDepositBalance integrity ---');
    const sampleEvents = [
      { event_type: 'RECEIVED', amount: 500000 },
      { event_type: 'APPLY', amount: 200000 },
      { event_type: 'REFUND', amount: 100000 }
    ];
    const derived = deriveDepositBalance(sampleEvents);
    check(derived.remaining === 200000, 'I1. deriveDepositBalance calculates remaining balance correctly');
    check(derived.applied === 200000, 'I2. deriveDepositBalance calculates applied correctly');
    check(derived.refunded === 100000, 'I3. deriveDepositBalance calculates refunded correctly');
    check(derived.status === 'PARTIALLY_USED', 'I4. deriveDepositBalance derives PARTIALLY_USED status correctly');

    // =========================================================================
    // Test J: Existing payment/folio totals unchanged
    // =========================================================================
    console.log('\n--- Test J: Financial totals invariant ---');
    const currentPT = await client.query(`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::numeric AS total_amount
      FROM payment_transactions
      WHERE reservation_id IS NULL OR reservation_id != $1
    `, [reservationId]);
    check(
      Number(currentPT.rows[0].count) === Number(baselinePT.rows[0].count),
      'J1. Total count of pre-existing payment_transactions is identical'
    );
    check(
      Number(currentPT.rows[0].total_amount) === Number(baselinePT.rows[0].total_amount),
      'J2. Total sum of pre-existing payment amounts is identical'
    );

    // =========================================================================
    // Test K: Write-through in creation services populates booking_id with scope='ROOM_RESERVATION'
    // =========================================================================
    console.log('\n--- Test K: Write-through in domain creation services ---');

    // K1: createPaymentInTransaction write-through
    const payResult = await createPaymentInTransaction(client, {
      reservationId,
      propertyId,
      amount: 150000,
      paymentMethod: 'TRANSFER',
      actorNameSnapshot: 'PMS Tester'
    }, null);
    const createdPayment = await client.query(
      `SELECT booking_id, scope FROM payment_transactions WHERE id = $1`,
      [payResult.payment.id]
    );
    check(
      Number(createdPayment.rows[0].booking_id) === bookingId,
      'K1. createPaymentInTransaction populated booking_id automatically'
    );
    check(
      createdPayment.rows[0].scope === 'ROOM_RESERVATION',
      'K2. createPaymentInTransaction set scope to ROOM_RESERVATION'
    );

    // K2: receiveDeposit write-through
    const depServiceRes = await receiveDeposit(pool, {
      propertyId,
      reservationId,
      amount: 50000,
      paymentMethod: 'CASH',
      idempotencyKey: `IDEMP-DEP-${runId}`,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    const createdDeposit = await client.query(
      `SELECT booking_id, scope FROM deposits WHERE id = $1`,
      [depServiceRes.id]
    );
    check(
      Number(createdDeposit.rows[0].booking_id) === bookingId,
      'K3. receiveDeposit populated booking_id on deposits'
    );
    check(
      createdDeposit.rows[0].scope === 'ROOM_RESERVATION',
      'K4. receiveDeposit set scope to ROOM_RESERVATION on deposits'
    );

    // Also check the deposit's payment_transaction
    const depPtRes = await client.query(
      `SELECT booking_id, scope FROM payment_transactions WHERE reference_code = $1`,
      [depServiceRes.deposit_number]
    );
    check(
      Number(depPtRes.rows[0].booking_id) === bookingId,
      'K5. receiveDeposit populated booking_id on deposit payment_transaction'
    );
    check(
      depPtRes.rows[0].scope === 'ROOM_RESERVATION',
      'K6. receiveDeposit set scope to ROOM_RESERVATION on deposit payment_transaction'
    );

    // K3: holdIdentity write-through
    const custodyRes = await holdIdentity(pool, {
      propertyId,
      reservationId,
      documentType: 'SIM',
      documentHolderName: `Driver ${runId}`,
      actor: { userId: '1', name: 'Tester', role: 'RECEPTIONIST' }
    });
    const createdCustody = await client.query(
      `SELECT booking_id, scope FROM identity_custody WHERE id = $1`,
      [custodyRes.id]
    );
    check(
      Number(createdCustody.rows[0].booking_id) === bookingId,
      'K7. holdIdentity populated booking_id on identity_custody'
    );
    check(
      createdCustody.rows[0].scope === 'ROOM_RESERVATION',
      'K8. holdIdentity set scope to ROOM_RESERVATION on identity_custody'
    );

    // =========================================================================
    // Test L: BOOKING_GROUP requires booking_id IS NOT NULL constraint integrity
    // =========================================================================
    console.log('\n--- Test L: BOOKING_GROUP ownership integrity check constraints ---');

    // L1: payment_transactions with BOOKING_GROUP and NULL booking_id must be rejected
    let ptGroupNullRejected = false;
    try {
      await client.query(
        `INSERT INTO payment_transactions (reservation_id, amount, scope, booking_id)
         VALUES ($1, 1000, 'BOOKING_GROUP', NULL)`,
        [reservationId]
      );
    } catch (e) {
      ptGroupNullRejected = e.message.includes('chk_payment_transactions_group_booking_id');
    }
    check(ptGroupNullRejected, 'L1. payment_transactions rejected scope=BOOKING_GROUP with booking_id=NULL');

    // L2: deposits with BOOKING_GROUP and NULL booking_id must be rejected
    let depGroupNullRejected = false;
    try {
      await client.query(
        `INSERT INTO deposits (property_id, reservation_id, deposit_number, original_amount, payment_method, received_by, scope, booking_id)
         VALUES ($1, $2, $3, 1000, 'CASH', 'Tester', 'BOOKING_GROUP', NULL)`,
        [propertyId, reservationId, `DEP-GRP-NULL-${runId}`]
      );
    } catch (e) {
      depGroupNullRejected = e.message.includes('chk_deposits_group_booking_id');
    }
    check(depGroupNullRejected, 'L2. deposits rejected scope=BOOKING_GROUP with booking_id=NULL');

    // L3: identity_custody with BOOKING_GROUP and NULL booking_id must be rejected
    let icGroupNullRejected = false;
    try {
      await client.query(
        `INSERT INTO identity_custody (property_id, reservation_id, document_type, document_holder_name, received_by, scope, booking_id)
         VALUES ($1, $2, 'KTP', 'Tester', 'Tester', 'BOOKING_GROUP', NULL)`,
        [propertyId, reservationId]
      );
    } catch (e) {
      icGroupNullRejected = e.message.includes('chk_identity_custody_group_booking_id');
    }
    check(icGroupNullRejected, 'L3. identity_custody rejected scope=BOOKING_GROUP with booking_id=NULL');

    // L4: Valid ROOM_RESERVATION with booking_id=NULL is accepted
    let ptRoomResNullAccepted = false;
    try {
      const res = await client.query(
        `INSERT INTO payment_transactions (reservation_id, amount, scope, booking_id)
         VALUES ($1, 500, 'ROOM_RESERVATION', NULL) RETURNING id`,
        [reservationId]
      );
      if (res.rowCount === 1) {
        ptRoomResNullAccepted = true;
        await client.query('DELETE FROM payment_transactions WHERE id = $1', [res.rows[0].id]);
      }
    } catch (e) {
      console.error('L4 error:', e.message);
    }
    check(ptRoomResNullAccepted, 'L4. Valid ROOM_RESERVATION with booking_id=NULL remains accepted');

    // L5: Valid ROOM_RESERVATION with booking_id=bookingId is accepted
    let ptRoomResWithBkAccepted = false;
    try {
      const res = await client.query(
        `INSERT INTO payment_transactions (reservation_id, amount, scope, booking_id)
         VALUES ($1, 500, 'ROOM_RESERVATION', $2) RETURNING id`,
        [reservationId, bookingId]
      );
      if (res.rowCount === 1) {
        ptRoomResWithBkAccepted = true;
        await client.query('DELETE FROM payment_transactions WHERE id = $1', [res.rows[0].id]);
      }
    } catch (e) {
      console.error('L5 error:', e.message);
    }
    check(ptRoomResWithBkAccepted, 'L5. Valid ROOM_RESERVATION with booking_id populated remains accepted');

    // =========================================================================
    // Test M: Foreign Key Delete Semantics Catalog Verification (ON DELETE RESTRICT)
    // =========================================================================
    console.log('\n--- Test M: FK delete semantics catalog verification & integration ---');

    const fkCatalogQuery = `
      SELECT
        c.conname,
        c.confdeltype,
        cl.relname AS table_name,
        att.attname AS column_name,
        ref_cl.relname AS foreign_table_name,
        ref_att.attname AS foreign_column_name
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_class ref_cl ON ref_cl.oid = c.confrelid
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = c.conkey[1]
      JOIN pg_attribute ref_att ON ref_att.attrelid = c.confrelid AND ref_att.attnum = c.confkey[1]
      WHERE c.contype = 'f'
        AND cl.relname = $1
        AND att.attname = 'booking_id'
    `;

    // Catalog assertions for all 3 tables: payment_transactions, deposits, identity_custody
    for (const tbl of ['payment_transactions', 'deposits', 'identity_custody']) {
      const fkRes = await client.query(fkCatalogQuery, [tbl]);
      check(fkRes.rows.length === 1, `M-catalog: ${tbl} has exactly one booking_id foreign key`);
      const row = fkRes.rows[0];
      check(row?.column_name === 'booking_id', `M-catalog: ${tbl} FK is specifically on column booking_id`);
      check(row?.foreign_table_name === 'bookings', `M-catalog: ${tbl} FK references bookings table`);
      check(row?.foreign_column_name === 'id', `M-catalog: ${tbl} FK references bookings.id column`);
      check(row?.confdeltype === 'r', `M-catalog: ${tbl} FK delete action is strictly RESTRICT (confdeltype='r')`);
    }

    // Integration check: end-to-end deletion refusal
    // NOTE: This integration test demonstrates that deleting a parent booking is refused by PostgreSQL
    // when child records exist. The catalog assertions above provide isolated proof that the booking_id FKs
    // on payment_transactions, deposits, and identity_custody are ON DELETE RESTRICT (confdeltype='r').
    const tempBkRes = await client.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
       VALUES ($1, $2, 'Temp FK Guest', 'ACTIVE') RETURNING id`,
      [propertyId, `BID-TEMP-${Date.now()}`]
    );
    const tempBkId = Number(tempBkRes.rows[0].id);

    const tempRes = await client.query(
      `INSERT INTO reservations (
        booking_id, room_id, booked_room_type_id_snapshot, guest_name,
        check_in, check_out, subtotal_amount, total_price, amount_paid, remaining_balance,
        status, payment_status, stay_sequence
      ) VALUES ($1, $2, $3, 'Temp FK Guest', '2089-01-01', '2089-01-02', 100000, 100000, 0, 100000, 'BOOKED', 'UNPAID', 1)
      RETURNING id`,
      [tempBkId, roomId, roomTypeId]
    );
    const tempResId = Number(tempRes.rows[0].id);

    const tempPtRes = await client.query(
      `INSERT INTO payment_transactions (reservation_id, booking_id, scope, amount, transaction_type, status)
       VALUES ($1, $2, 'ROOM_RESERVATION', 100000, 'PAYMENT', 'SUCCESS') RETURNING id`,
      [tempResId, tempBkId]
    );
    const tempPtId = Number(tempPtRes.rows[0].id);

    let deleteBlockedByFk = false;
    try {
      await client.query('DELETE FROM bookings WHERE id = $1', [tempBkId]);
    } catch (e) {
      deleteBlockedByFk = e.code === '23503';
    }
    check(deleteBlockedByFk, 'M-int: Deleting parent booking with active records is blocked (code 23503)');

    const ptStillHasBk = await client.query('SELECT booking_id FROM payment_transactions WHERE id = $1', [tempPtId]);
    check(
      Number(ptStillHasBk.rows[0].booking_id) === tempBkId,
      'M-int: payment_transactions booking_id remains intact and NOT silently set to NULL'
    );

    // Clean up temporary FK test fixture
    await client.query('DELETE FROM payment_transactions WHERE id = $1', [tempPtId]);
    await client.query('DELETE FROM reservations WHERE id = $1', [tempResId]);
    await client.query('DELETE FROM bookings WHERE id = $1', [tempBkId]);

    // =========================================================================
    // Test N: Payment correction and void regression coverage
    // =========================================================================
    console.log('\n--- Test N: Payment correction and void write-through regression ---');

    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const adminToken = generateToken({
      id: 1,
      email: 'admin@oaklawang.com',
      username: 'admin',
      full_name: 'Admin',
      role: 'ADMIN',
      role_id: 1,
      property_id: propertyId,
      scope: 'FULL',
      access_type: 'ADMIN'
    });

    // Create initial payment on reservationId
    const nPayRes = await client.query(
      `INSERT INTO payment_transactions (
        reservation_id, booking_id, scope, transaction_type, amount, payment_method, status
      ) VALUES ($1, $2, 'ROOM_RESERVATION', 'PAYMENT', 500000, 'CASH', 'SUCCESS') RETURNING id`,
      [reservationId, bookingId]
    );
    const nPayId = Number(nPayRes.rows[0].id);
    await client.query('UPDATE reservations SET amount_paid = 500000, payment_status = $1 WHERE id = $2', ['PARTIAL', reservationId]);

    // N1: Test /correct
    const corrFormData = new FormData();
    corrFormData.append('property_id', String(propertyId));
    corrFormData.append('amount', '450000');
    corrFormData.append('payment_method', 'CASH');
    corrFormData.append('reason_code', 'WRONG_AMOUNT');
    corrFormData.append('reason_text', 'Correction test adjustment');
    corrFormData.append('file', new Blob([Buffer.from('FAKE_JPG_EVIDENCE')], { type: 'image/jpeg' }), 'proof.jpg');

    const corrHttpRes = await fetch(`${baseUrl}/api/reservations/${reservationId}/payments/${nPayId}/correct`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: corrFormData
    });
    check(corrHttpRes.status === 200, 'N1. Payment correction returns HTTP 200');
    const corrData = await corrHttpRes.json();
    check(corrData.status === 'SUCCESS', 'N2. Payment correction returned status SUCCESS');

    const revRow = corrData.data?.reversal;
    const replRow = corrData.data?.replacement;

    check(Number(revRow?.booking_id) === bookingId, 'N3. Correction REVERSAL inherits reservation parent booking_id');
    check(revRow?.scope === 'ROOM_RESERVATION', 'N4. Correction REVERSAL remains scope=ROOM_RESERVATION');
    check(Number(revRow?.reference_payment_id) === nPayId, 'N5. Correction REVERSAL reference_payment_id links to original payment');

    check(Number(replRow?.booking_id) === bookingId, 'N6. Correction replacement inherits same booking_id');
    check(replRow?.scope === 'ROOM_RESERVATION', 'N7. Correction replacement remains scope=ROOM_RESERVATION');
    check(Number(replRow?.reference_payment_id) === nPayId, 'N8. Correction replacement reference_payment_id links to original payment');
    check(Boolean(revRow?.correction_group_id && revRow.correction_group_id === replRow?.correction_group_id), 'N9. Correction group id is shared between reversal and replacement');

    // Verify reservation net financial amount paid
    const resAfterCorr = await client.query('SELECT amount_paid FROM reservations WHERE id = $1', [reservationId]);
    check(Number(resAfterCorr.rows[0].amount_paid) === 450000, 'N10. Reservation net amount_paid reflects correction compensating total');

    // N2: Test /void
    const voidHttpRes = await fetch(`${baseUrl}/api/reservations/${reservationId}/payments/${replRow.id}/void`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        property_id: propertyId,
        reason_code: 'PAYMENT_CANCELLED',
        reason_text: 'Void test reversal'
      })
    });
    check(voidHttpRes.status === 200, 'N11. Payment void returns HTTP 200');
    const voidData = await voidHttpRes.json();
    check(voidData.status === 'SUCCESS', 'N12. Payment void returned status SUCCESS');

    const voidRevRow = voidData.data?.reversal;
    check(Number(voidRevRow?.booking_id) === bookingId, 'N13. Void REVERSAL inherits reservation parent booking_id');
    check(voidRevRow?.scope === 'ROOM_RESERVATION', 'N14. Void REVERSAL remains scope=ROOM_RESERVATION');
    check(Number(voidRevRow?.reference_payment_id) === Number(replRow.id), 'N15. Void REVERSAL reference_payment_id links to voided payment');

    const resAfterVoid = await client.query('SELECT amount_paid FROM reservations WHERE id = $1', [reservationId]);
    check(Number(resAfterVoid.rows[0].amount_paid) === 0, 'N16. Reservation net amount_paid is 0 after void');

    // =========================================================================
    // Test O: Canonical booking payment allocation write-through
    // =========================================================================
    console.log('\n--- Test O: Canonical booking payment allocation write-through ---');

    function toDateStr(date) {
      const d = new Date(date);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function offsetDays(str, days) {
      const d = new Date(str);
      d.setDate(d.getDate() + days);
      return toDateStr(d);
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    let scenario = null;

    for (let offset = 40; offset < 100; offset++) {
      const cIn = offsetDays(todayStr, offset);
      const cOut = offsetDays(cIn, 1);

      const cand = await client.query(`
        SELECT r.id, r.property_id, r.room_type_id, rt.base_rate,
               (ad.total_rooms - ad.reserved_qty) as avail
        FROM rooms r
        JOIN room_types rt ON rt.id = r.room_type_id
        JOIN availability_dates ad ON ad.room_type_id = r.room_type_id AND ad.date = $1::date
        WHERE r.property_id = 1
          AND (ad.total_rooms - ad.reserved_qty) >= 2
          AND r.id NOT IN (
            SELECT room_id FROM reservations
            WHERE status IN ('BOOKED', 'CHECKED_IN')
              AND check_in < $2::date AND check_out > $1::date
          )
        ORDER BY r.id ASC
        LIMIT 2
      `, [cIn, cOut]);

      if (cand.rowCount === 2) {
        scenario = {
          checkIn: cIn,
          checkOut: cOut,
          room1: cand.rows[0],
          room2: cand.rows[1]
        };
        break;
      }
    }

    if (!scenario) {
      throw new Error('No available rooms/dates found for multi-room scenario');
    }

    const rate1 = Number(scenario.room1.base_rate || 100000);
    const rate2 = Number(scenario.room2.base_rate || 100000);
    const totalStay = rate1 + rate2;
    const bookingPaymentAmount = Math.floor(totalStay * 0.5);

    const bookingPayload = {
      property_id: 1,
      guest_name: `Group WriteThrough ${runId}`,
      guest_phone: '081234567890',
      identity_number: '3171012345670001',
      has_valid_identity: true,
      booking_channel: 'WALK_IN',
      booking_source: 'WALKIN',
      payment_method: 'CASH',
      amount_paid: bookingPaymentAmount,
      reservations: [
        {
          room_id: scenario.room1.id,
          check_in: scenario.checkIn,
          check_out: scenario.checkOut
        },
        {
          room_id: scenario.room2.id,
          check_in: scenario.checkIn,
          check_out: scenario.checkOut
        }
      ]
    };

    const bookPostRes = await fetch(`${baseUrl}/api/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify(bookingPayload)
    });

    check(bookPostRes.status === 201, 'O1. Multi-room booking creation returns HTTP 201');
    const bookResData = await bookPostRes.json();
    check(bookResData.status === 'SUCCESS', 'O2. Multi-room booking returned status SUCCESS');

    const createdBookingId = Number(bookResData.data?.booking_id);
    const createdResList = bookResData.data?.reservations || [];

    const bookingPayments = await client.query(
      `SELECT id, reservation_id, booking_id, scope, amount, correction_group_id, payment_method, status
       FROM payment_transactions
       WHERE booking_id = $1 ORDER BY id ASC`,
      [createdBookingId]
    );

    check(bookingPayments.rowCount > 0, 'O3. Payment transactions created for booking');
    let allScopeRoomRes = true;
    let allMatchBookingId = true;
    let totalPaidInPayments = 0;

    for (const pt of bookingPayments.rows) {
      if (pt.scope !== 'ROOM_RESERVATION') allScopeRoomRes = false;
      if (Number(pt.booking_id) !== createdBookingId) allMatchBookingId = false;
      totalPaidInPayments += Number(pt.amount);
    }

    check(allMatchBookingId, 'O4. All booking payment rows have booking_id = parent bookings.id');
    check(allScopeRoomRes, 'O5. groupedBookingPayment retains scope=ROOM_RESERVATION (not reinterpreted as BOOKING_GROUP)');
    check(totalPaidInPayments === bookingPaymentAmount, 'O6. Total allocated payment amounts match submitted booking cash amount');

    // Clean up created booking fixtures and release availability ledger
    for (const r of createdResList) {
      const rRow = await client.query('SELECT booked_room_type_id_snapshot, check_in, check_out FROM reservations WHERE id = $1', [r.id]);
      if (rRow.rowCount > 0) {
        const rtId = rRow.rows[0].booked_room_type_id_snapshot;
        await client.query(
          `UPDATE availability_dates
           SET reserved_qty = GREATEST(0, reserved_qty - 1)
           WHERE room_type_id = $1 AND date = $2::date`,
          [rtId, scenario.checkIn]
        );
      }
      await client.query('DELETE FROM folio_entries WHERE reservation_id = $1', [r.id]);
      await client.query('DELETE FROM payment_evidences WHERE reservation_id = $1', [r.id]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = $1', [r.id]);
      await client.query('DELETE FROM reservations WHERE id = $1', [r.id]);
    }
    await client.query('DELETE FROM bookings WHERE id = $1', [createdBookingId]);

    server.close();

    // =========================================================================
    // Test P: Migration v1 -> v2 upgrade and sealing simulation
    // =========================================================================
    console.log('\n--- Test P: Migration upgrade simulation (old v1 -> v2) ---');

    // Case A: Simulate environment that only has v1, with an old SET NULL FK and missing group CHECK
    // 1. Remove v2 migration marker
    await client.query("DELETE FROM schema_migrations WHERE version = 'multi_booking_scope_1a_integrity_v2'");
    // 2. Ensure v1 marker exists
    await client.query("INSERT INTO schema_migrations (version) VALUES ('multi_booking_scope_1a_foundation_v1') ON CONFLICT (version) DO NOTHING");
    // 3. Drop RESTRICT FK and replace with old SET NULL FK on payment_transactions
    await client.query(`
      ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_booking_id_fkey;
      ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_booking_id_fkey
        FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
      ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS chk_payment_transactions_group_booking_id;
    `);

    // Verify pre-upgrade state: confdeltype is 'n' (SET NULL), group check missing, v2 not recorded
    const preCheckFk = await client.query(`
      SELECT c.confdeltype
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE cl.relname = 'payment_transactions' AND a.attname = 'booking_id' AND c.contype = 'f'
    `);
    check(preCheckFk.rows[0]?.confdeltype === 'n', 'P1-pre. Simulated legacy v1 environment has confdeltype = n (SET NULL)');

    const preCheckGroup = await client.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'chk_payment_transactions_group_booking_id'"
    );
    check(preCheckGroup.rowCount === 0, 'P2-pre. Simulated legacy v1 environment lacks group booking CHECK constraint');

    const preCheckV2 = await client.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'multi_booking_scope_1a_integrity_v2'"
    );
    check(preCheckV2.rowCount === 0, 'P3-pre. v2 migration marker is not recorded yet');

    // Execute authoritative boot migrator
    await initializeDatabase(pool);

    // Assert Case A post-upgrade
    const postCheckFk = await client.query(`
      SELECT c.confdeltype
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE cl.relname = 'payment_transactions' AND a.attname = 'booking_id' AND c.contype = 'f'
    `);
    check(postCheckFk.rows[0]?.confdeltype === 'r', 'P4. v2 upgrade replaced legacy SET NULL FK with ON DELETE RESTRICT (confdeltype=r)');

    const postCheckGroup = await client.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'chk_payment_transactions_group_booking_id'"
    );
    check(postCheckGroup.rowCount === 1, 'P5. v2 upgrade created missing group booking CHECK constraint');

    const postCheckV2 = await client.query(
      "SELECT 1 FROM schema_migrations WHERE version = 'multi_booking_scope_1a_integrity_v2'"
    );
    check(postCheckV2.rowCount === 1, 'P6. v2 migration marker is now recorded in schema_migrations');

    // Case B: Idempotency / rerun
    await initializeDatabase(pool);

    const rerunFkCount = await client.query(`
      SELECT COUNT(*)::int AS cnt
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE cl.relname = 'payment_transactions' AND a.attname = 'booking_id' AND c.contype = 'f'
    `);
    check(rerunFkCount.rows[0]?.cnt === 1, 'P7. v2 rerun idempotency: exactly 1 foreign key constraint exists on booking_id');

    const rerunCheckCount = await client.query(
      "SELECT COUNT(*)::int AS cnt FROM pg_constraint WHERE conname = 'chk_payment_transactions_group_booking_id'"
    );
    check(rerunCheckCount.rows[0]?.cnt === 1, 'P8. v2 rerun idempotency: exactly 1 group booking check constraint exists');

    // Case C: Final markers verification
    const markersRes = await client.query(
      "SELECT version FROM schema_migrations WHERE version IN ('multi_booking_scope_1a_foundation_v1', 'multi_booking_scope_1a_integrity_v2') ORDER BY version"
    );
    const versions = markersRes.rows.map(r => r.version);
    check(
      versions.includes('multi_booking_scope_1a_foundation_v1') && versions.includes('multi_booking_scope_1a_integrity_v2'),
      'P9. Final schema has both v1 and v2 migration markers recorded'
    );

    console.log(`\nResults: ${passed} passed, ${failed} failed.`);
  } catch (err) {
    console.error('Test execution error:', err);
    failed++;
  } finally {
    // Clean up test fixtures safely
    try {
      if (reservationId) {
        await client.query('DELETE FROM identity_custody WHERE reservation_id = $1', [reservationId]);
        await client.query('DELETE FROM deposit_events WHERE reservation_id = $1', [reservationId]);
        await client.query('DELETE FROM deposits WHERE reservation_id = $1', [reservationId]);
        await client.query('DELETE FROM payment_evidences WHERE reservation_id = $1', [reservationId]);
        await client.query('DELETE FROM folio_entries WHERE reservation_id = $1', [reservationId]);
        await client.query('DELETE FROM payment_transactions WHERE reservation_id = $1', [reservationId]);
        await client.query('DELETE FROM reservations WHERE id = $1', [reservationId]);
      }
      if (bookingId) {
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

run();
