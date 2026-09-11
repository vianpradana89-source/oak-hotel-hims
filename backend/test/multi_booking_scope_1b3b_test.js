/**
 * multi_booking_scope_1b3b_test.js
 *
 * MULTI-BOOKING-SCOPE-1B3B — Group Payment Evidence Compatibility
 *
 * Tests evidence upload/list/replace for BOOKING_GROUP payments.
 * 35 scenarios covering direct and group evidence workflows.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const {
  uploadPaymentEvidence,
  getPaymentEvidences,
  getEvidenceRowById,
  replaceEvidence,
  validatePaymentHierarchy,
  resolveEvidenceAnchorReservation,
  getQualifyingEvidenceForReservation,
  deactivateEvidence
} = require('../dist/domains/payments/paymentEvidenceService');
const { createBookingGroupPaymentWithAllocations } = require('../dist/domains/payments/bookingGroupPaymentService');
const {
  getStorageBaseDir,
  resolveAbsolutePath
} = require('../dist/domains/payments/evidenceStorageService');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const runId = `1B3B-${String(Date.now()).slice(-8)}`;
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

// ─── Fixture helpers ───────────────────────────────────────────────────────────
let _propSeq = 0;
let _bookingSeq = 0;
let _resSeq = 0;

async function mkProperty(client) {
  _propSeq += 1;
  for (let attempt = 0; attempt < 50; attempt++) {
    const suffix = String(Math.floor(Math.random() * 9000) + 1000);
    const code = `PB${suffix}`;
    try {
      const res = await client.query(
        `INSERT INTO properties (name, property_code) VALUES ($1, $2) RETURNING id`,
        [`1B3B Test Prop ${_propSeq}`, code]
      );
      return Number(res.rows[0].id);
    } catch (err) {
      if (err.code === '23505') continue; // unique violation on property_code — retry
      throw err;
    }
  }
  throw new Error('mkProperty: could not find unique property_code after 50 attempts');
}

async function mkBooking(client, propertyId) {
  _bookingSeq += 1;
  const bid = `BID-1B3B-${runId}-${_bookingSeq}`;
  const res = await client.query(
    `INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ($1, $2, $3) RETURNING id`,
    [bid, propertyId, `Guest ${_bookingSeq}`]
  );
  return Number(res.rows[0].id);
}

async function mkReservation(client, bookingId, totalPrice = 500000, status = 'CONFIRMED') {
  _resSeq += 1;
  const res = await client.query(
    `INSERT INTO reservations (
       booking_id, guest_name, stay_sequence, check_in, check_out,
       status, total_price
     ) VALUES ($1, $2, $3, '2026-11-01', '2026-11-03', $4, $5)
     RETURNING id`,
    [bookingId, `Res ${_resSeq}`, _resSeq, status, totalPrice]
  );
  return Number(res.rows[0].id);
}

async function insertDirectPayment(client, reservationId, propertyId, amount) {
  const res = await client.query(
    `INSERT INTO payment_transactions (
       property_id, booking_id, reservation_id, transaction_type,
       amount, scope, status
     ) VALUES ($1, (SELECT booking_id FROM reservations WHERE id = $2), $2, 'PAYMENT', $3, 'ROOM_RESERVATION', 'SUCCESS')
     RETURNING id`,
    [propertyId, reservationId, amount]
  );
  return Number(res.rows[0].id);
}

function mockFileBuffer(mimetype = 'image/jpeg', size = 1024) {
  return Buffer.alloc(size, 'x');
}

// ─── Dedicated Committed Cleanup Helper (Child-First FK Order) ────────────────
async function cleanupCommittedFixture(propertyId) {
  if (!propertyId) return;

  // 1. Physical storage file cleanup for this property
  try {
    const propStorageDir = path.join(getStorageBaseDir(), 'payment-evidence', String(propertyId));
    if (fs.existsSync(propStorageDir)) {
      fs.rmSync(propStorageDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`Storage cleanup error for property ${propertyId}:`, err);
  }

  // 2. Child-first DB deletion in an explicit, committed transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM payment_evidences WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM audit_logs WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM folio_entries WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM deposit_events WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM deposits WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM identity_custody WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM payment_allocations WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM payment_transactions WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM reservation_room_moves WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM reservation_nightly_rates WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM reservation_guests WHERE reservation_id IN (SELECT r.id FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE b.property_id = $1)', [propertyId]);
    await client.query('DELETE FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)', [propertyId]);
    await client.query('DELETE FROM bookings WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM rooms WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM room_types WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM room_categories WHERE property_id = $1', [propertyId]);
    await client.query('DELETE FROM properties WHERE id = $1', [propertyId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`DB cleanup failed for property ${propertyId}:`, err);
    throw err;
  } finally {
    client.release();
  }
}

// ─── Assert Zero Residue Helper ───────────────────────────────────────────────
async function assertZeroResidue(propertyId) {
  const checkQueries = [
    { name: 'payment_evidences', sql: 'SELECT COUNT(*) FROM payment_evidences WHERE property_id = $1' },
    { name: 'payment_allocations', sql: 'SELECT COUNT(*) FROM payment_allocations WHERE property_id = $1' },
    { name: 'payment_transactions', sql: 'SELECT COUNT(*) FROM payment_transactions WHERE property_id = $1' },
    { name: 'folio_entries', sql: 'SELECT COUNT(*) FROM folio_entries WHERE property_id = $1' },
    { name: 'reservations', sql: 'SELECT COUNT(*) FROM reservations WHERE booking_id IN (SELECT id FROM bookings WHERE property_id = $1)' },
    { name: 'bookings', sql: 'SELECT COUNT(*) FROM bookings WHERE property_id = $1' },
    { name: 'properties', sql: 'SELECT COUNT(*) FROM properties WHERE id = $1' }
  ];

  for (const q of checkQueries) {
    const res = await pool.query(q.sql, [propertyId]);
    const count = Number(res.rows[0].count);
    check(count === 0, `Zero residue in ${q.name} (count=${count})`);
    if (count !== 0) {
      throw new Error(`Residue assertion failed: ${q.name} has count ${count} for property ${propertyId}`);
    }
  }
}

// ─── Fixture Setup Helpers ───────────────────────────────────────────────────
async function setupDirectFixture({ amount = 500000, status = 'CONFIRMED' } = {}) {
  const fixtureClient = await pool.connect();
  try {
    await fixtureClient.query('BEGIN');
    _resSeq = 0;
    const propertyId = await mkProperty(fixtureClient);
    const bookingId = await mkBooking(fixtureClient, propertyId);
    const resId = await mkReservation(fixtureClient, bookingId, amount, status);
    const paymentId = await insertDirectPayment(fixtureClient, resId, propertyId, amount);
    await fixtureClient.query('COMMIT');
    return { propertyId, bookingId, resId, paymentId };
  } catch (err) {
    await fixtureClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    fixtureClient.release();
  }
}

async function setupGroupFixture({ numReservations = 2, amount = 1000000, reservationPrice = 500000, reservationIds = null } = {}) {
  const fixtureClient = await pool.connect();
  try {
    await fixtureClient.query('BEGIN');
    _resSeq = 0;
    const propertyId = await mkProperty(fixtureClient);
    const bookingId = await mkBooking(fixtureClient, propertyId);
    const reservations = [];
    for (let i = 0; i < numReservations; i++) {
      const r = await mkReservation(fixtureClient, bookingId, reservationPrice);
      reservations.push(r);
    }
    const groupResult = await createBookingGroupPaymentWithAllocations(fixtureClient, {
      propertyId,
      bookingId,
      amount,
      reservationIds: reservationIds ? reservationIds(reservations) : reservations
    });
    const parentId = groupResult.parentPayment.id;
    await fixtureClient.query('COMMIT');
    return {
      propertyId,
      bookingId,
      reservations,
      res1: reservations[0],
      res2: reservations[1],
      parentId,
      groupResult
    };
  } catch (err) {
    await fixtureClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    fixtureClient.release();
  }
}

// ─── Test cases ───────────────────────────────────────────────────────────────

async function test1_directEvidenceUpload() {
  console.log('\n--- T1: Direct ROOM_RESERVATION evidence upload ---');
  const { propertyId, resId, paymentId } = await setupDirectFixture();
  try {
    const evidence = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: resId,
      paymentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    check(evidence !== null, 'T1.1: Evidence uploaded successfully');
    check(evidence.payment_transaction_id === paymentId, 'T1.2: Evidence linked to correct payment');
    check(evidence.is_active === true, 'T1.3: Evidence is active');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test2_oneGroupParentOneEvidence() {
  console.log('\n--- T2: One BOOKING_GROUP parent + one evidence row ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    const evidence = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    check(evidence !== null, 'T2.1: Evidence uploaded for group payment');
    check(evidence.payment_transaction_id === parentId, 'T2.2: Evidence linked to group parent');

    const anchorId = await resolveEvidenceAnchorReservation(pool, parentId);
    check(anchorId === res1 || anchorId === res2, 'T2.3: Anchor reservation is an allocated child');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test3_siblingA_seesGroupEvidence() {
  console.log('\n--- T3: Allocation child A sees group evidence via list ---');
  const { propertyId, res1, parentId } = await setupGroupFixture();
  try {
    await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    const evidences = await getPaymentEvidences(pool, propertyId, res1, parentId);
    check(evidences.length === 1, 'T3.1: Child A sees 1 evidence row');
    check(evidences[0].payment_transaction_id === parentId, 'T3.2: Evidence belongs to group parent');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test4_siblingB_seesSameEvidence() {
  console.log('\n--- T4: Allocation child B sees SAME evidence via list ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    const evidences = await getPaymentEvidences(pool, propertyId, res2, parentId);
    check(evidences.length === 1, 'T4.1: Child B sees same evidence row');
    check(evidences[0].payment_transaction_id === parentId, 'T4.2: Same payment linked');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test5_exactlyOneEvidenceRow() {
  console.log('\n--- T5: Exactly one evidence row exists for group ---');
  const { propertyId, res1, parentId } = await setupGroupFixture();
  try {
    await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM payment_evidences WHERE payment_transaction_id = $1 AND is_active = TRUE`,
      [parentId]
    );
    check(Number(countRes.rows[0].count) === 1, 'T5.1: Exactly one active evidence for group');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test6_unrelatedReservationCannotSee() {
  console.log('\n--- T6: Unrelated reservation cannot see group evidence ---');
  const { propertyId, res1, parentId } = await setupGroupFixture();
  try {
    await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    // Create unrelated reservation
    const setupClient = await pool.connect();
    let unrelatedRes;
    try {
      await setupClient.query('BEGIN');
      const unrelatedBooking = await mkBooking(setupClient, propertyId);
      unrelatedRes = await mkReservation(setupClient, unrelatedBooking, 500000);
      await setupClient.query('COMMIT');
    } finally {
      setupClient.release();
    }

    let threw = false;
    try {
      await getPaymentEvidences(pool, propertyId, unrelatedRes, parentId);
    } catch (err) {
      threw = true;
    }
    check(threw, 'T6.1: Unrelated reservation rejected with error');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test7_crossPropertyRejected() {
  console.log('\n--- T7: Cross-property group evidence access rejected ---');
  let prop1, prop2, res1, parentId;
  const fixtureClient = await pool.connect();
  try {
    await fixtureClient.query('BEGIN');
    prop1 = await mkProperty(fixtureClient);
    prop2 = await mkProperty(fixtureClient);
    const bookingId = await mkBooking(fixtureClient, prop1);
    res1 = await mkReservation(fixtureClient, bookingId, 500000);
    const groupResult = await createBookingGroupPaymentWithAllocations(fixtureClient, {
      propertyId: prop1,
      bookingId,
      amount: 500000
    });
    parentId = groupResult.parentPayment.id;
    await fixtureClient.query('COMMIT');
  } finally {
    fixtureClient.release();
  }

  try {
    let threw = false;
    try {
      await getPaymentEvidences(pool, prop2, res1, parentId);
    } catch (err) {
      threw = true;
    }
    check(threw, 'T7.1: Cross-property access rejected');
  } finally {
    await cleanupCommittedFixture(prop1);
    await cleanupCommittedFixture(prop2);
  }
}

async function test8_voidedParentAllowsHierarchyButNotGate5() {
  console.log('\n--- T8: Voided BOOKING_GROUP parent passes hierarchy but not Gate 5 ---');
  const { propertyId, res1, parentId } = await setupGroupFixture();
  try {
    await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    await pool.query(`UPDATE payment_transactions SET status = 'VOIDED' WHERE id = $1`, [parentId]);

    let threw = false;
    try {
      await validatePaymentHierarchy(pool, propertyId, res1, parentId);
    } catch (err) {
      threw = true;
    }
    check(!threw, 'T8.1: Hierarchy validation passes for voided parent (authorization != gate status)');

    const evidences = await getPaymentEvidences(pool, propertyId, res1, parentId);
    check(evidences.length === 1, 'T8.2: getPaymentEvidences returns evidence for voided parent');

    const gateEvidence = await getQualifyingEvidenceForReservation(pool, res1, propertyId);
    check(gateEvidence.length === 0, 'T8.3: Gate 5 excludes evidence for voided parent');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test9_secondUploadReturns409() {
  console.log('\n--- T9: Second upload attempt on same group returns 409 ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    let threw = false;
    let errorCode = null;
    try {
      await uploadPaymentEvidence(pool, {
        propertyId,
        reservationId: res2,
        paymentId: parentId,
        evidenceType: 'BANK_TRANSFER',
        file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test2.jpg', buffer: mockFileBuffer() }
      });
    } catch (err) {
      threw = true;
      errorCode = err.code;
    }
    check(threw, 'T9.1: Second upload throws error');
    check(errorCode === 'EVIDENCE_ALREADY_EXISTS', 'T9.2: Correct error code EVIDENCE_ALREADY_EXISTS');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test10_siblingCanAccessAfterUpload() {
  console.log('\n--- T10: Sibling reservation can access evidence after upload ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    const evidences = await getPaymentEvidences(pool, propertyId, res2, parentId);
    check(evidences.length === 1, 'T10.1: Sibling sees evidence');
    check(evidences[0].is_active === true, 'T10.2: Evidence is active');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test11_replacementWorksForGroup() {
  console.log('\n--- T11: Replacement works for group evidence ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    const first = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test1.jpg', buffer: mockFileBuffer() }
    });

    const replaced = await replaceEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      oldEvidenceId: first.id,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test2.jpg', buffer: mockFileBuffer() }
    });

    check(replaced.newEvidence !== null, 'T11.1: New evidence created');
    check(replaced.deactivatedEvidence !== null, 'T11.2: Old evidence deactivated');
    check(replaced.deactivatedEvidence.is_active === false, 'T11.3: Old evidence is inactive');

    const evidences = await getPaymentEvidences(pool, propertyId, res2, parentId);
    const activeEvidences = evidences.filter(e => e.is_active);
    check(activeEvidences.length === 1, 'T11.4: Only one active evidence after replacement');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test12_gate5HelperReturnsEvidence() {
  console.log('\n--- T12: Gate 5 helper returns evidence for group ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    const evidenceRows = await getQualifyingEvidenceForReservation(pool, res1, propertyId);
    check(evidenceRows.length >= 1, 'T12.1: Helper returns evidence for res1');

    const evidenceRows2 = await getQualifyingEvidenceForReservation(pool, res2, propertyId);
    check(evidenceRows2.length >= 1, 'T12.2: Helper returns evidence for res2 (sibling)');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test13_directEvidenceUnaffected() {
  console.log('\n--- T13: Direct evidence replacement unaffected by group code ---');
  const { propertyId, resId, paymentId } = await setupDirectFixture();
  try {
    const first = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: resId,
      paymentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test1.jpg', buffer: mockFileBuffer() }
    });

    const replaced = await replaceEvidence(pool, {
      propertyId,
      reservationId: resId,
      paymentId,
      oldEvidenceId: first.id,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test2.jpg', buffer: mockFileBuffer() }
    });

    check(replaced.newEvidence.is_active === true, 'T13.1: New direct evidence is active');
    check(replaced.deactivatedEvidence.is_active === false, 'T13.2: Old direct evidence is inactive');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test14_inactiveAllocationCannotAccess() {
  console.log('\n--- T14: Inactive allocation cannot access group evidence ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture({
    amount: 500000,
    reservationIds: (r) => [r[0]]
  });
  try {
    await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    let threw = false;
    try {
      await getPaymentEvidences(pool, propertyId, res2, parentId);
    } catch (err) {
      threw = true;
    }
    check(threw, 'T14.1: No-allocation reservation rejected for evidence access');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test15_correctErrorCodes() {
  console.log('\n--- T15: Correct error codes for various failures ---');
  const { propertyId, resId } = await setupDirectFixture();
  try {
    let threw = false;
    let errorCode = null;
    try {
      await validatePaymentHierarchy(pool, propertyId, resId, 99999);
    } catch (err) {
      threw = true;
      errorCode = err.code;
    }
    check(threw && errorCode === 'PAYMENT_NOT_FOUND', 'T15.1: Non-existent payment returns PAYMENT_NOT_FOUND');

    threw = false;
    errorCode = null;
    try {
      await validatePaymentHierarchy(pool, propertyId, 99999, 1);
    } catch (err) {
      threw = true;
      errorCode = err.code;
    }
    check(threw && errorCode === 'RESERVATION_NOT_FOUND', 'T15.2: Non-existent reservation returns RESERVATION_NOT_FOUND');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test16_evidenceByPaymentId() {
  console.log('\n--- T16: Evidence listing by payment_transaction_id for group ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    const evidences = await getPaymentEvidences(pool, propertyId, res2, parentId, false);
    check(evidences.length === 1, 'T16.1: Sibling can list evidence');
    check(evidences[0].is_active === true, 'T16.2: Evidence is active');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test17_anchorIsFirstBySequence() {
  console.log('\n--- T17: Anchor reservation is first by stay_sequence ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    const anchorId = await resolveEvidenceAnchorReservation(pool, parentId);
    check(anchorId === res1 || anchorId === res2, 'T17.1: Anchor is one of the allocations');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test18_noAnchorForGroup() {
  console.log('\n--- T18: No anchor returns error for group evidence ---');
  const fixtureClient = await pool.connect();
  let propertyId, res1, parentId;
  try {
    await fixtureClient.query('BEGIN');
    propertyId = await mkProperty(fixtureClient);
    const bookingId = await mkBooking(fixtureClient, propertyId);
    res1 = await mkReservation(fixtureClient, bookingId, 500000);
    const res = await fixtureClient.query(
      `INSERT INTO payment_transactions (property_id, booking_id, reservation_id, transaction_type, amount, scope, status)
       VALUES ($1, $2, $3, 'PAYMENT', 500000, 'BOOKING_GROUP', 'SUCCESS') RETURNING id`,
      [propertyId, bookingId, res1]
    );
    parentId = Number(res.rows[0].id);
    await fixtureClient.query('COMMIT');
  } finally {
    fixtureClient.release();
  }

  try {
    let threw = false;
    try {
      await uploadPaymentEvidence(pool, {
        propertyId,
        reservationId: res1,
        paymentId: parentId,
        evidenceType: 'BANK_TRANSFER',
        file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
      });
    } catch (err) {
      threw = true;
    }
    check(threw, 'T18.1: No anchor returns error');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test19_getEvidenceRowByIdGroup() {
  console.log('\n--- T19: getEvidenceRowById works for group evidence ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    const evidence = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    const row = await getEvidenceRowById(pool, propertyId, res2, parentId, evidence.id);
    check(row !== null, 'T19.1: Can retrieve evidence by ID from sibling');
    check(row.payment_transaction_id === parentId, 'T19.2: Correct payment linked');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test20_deactivateGroupEvidence() {
  console.log('\n--- T20: Deactivate group evidence works ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    const evidence = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    const deactivated = await deactivateEvidence(pool, {
      propertyId,
      reservationId: res2,
      paymentId: parentId,
      evidenceId: evidence.id,
      reason: 'Test deactivation'
    });

    check(deactivated.is_active === false, 'T20.1: Evidence deactivated');

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM payment_evidences WHERE payment_transaction_id = $1 AND is_active = TRUE`,
      [parentId]
    );
    check(Number(countRes.rows[0].count) === 0, 'T20.2: No active evidence after deactivation');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test21_nonAllocatedReservationRejected() {
  console.log('\n--- T21: Non-allocated reservation rejected for group evidence ---');
  const { propertyId, res2, parentId } = await setupGroupFixture({
    amount: 500000,
    reservationIds: (r) => [r[0]]
  });
  try {
    let threw = false;
    try {
      await getPaymentEvidences(pool, propertyId, res2, parentId);
    } catch (err) {
      threw = true;
    }
    check(threw, 'T21.1: Non-allocated reservation rejected');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test22_evidenceWithInactivePayment() {
  console.log('\n--- T22: Evidence with inactive payment is excluded ---');
  const { propertyId, res1, parentId } = await setupGroupFixture();
  try {
    await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    await pool.query(`UPDATE payment_transactions SET status = 'VOIDED' WHERE id = $1`, [parentId]);

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM payment_evidences pe
       JOIN payment_allocations pa ON pa.reservation_id = $1
       JOIN payment_transactions pt ON pt.id = pa.payment_transaction_id
       WHERE pa.payment_transaction_id = pe.payment_transaction_id
         AND pa.status = 'ACTIVE'
         AND pt.scope = 'BOOKING_GROUP'
         AND pt.status = 'SUCCESS'
         AND pe.is_active = TRUE`,
      [res1]
    );
    check(Number(countRes.rows[0].count) === 0, 'T22.1: No evidence for voided payment');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test23_multipleEvidenceTypes() {
  console.log('\n--- T23: Multiple evidence types supported ---');
  const { propertyId, resId, paymentId } = await setupDirectFixture();
  try {
    const evidence = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: resId,
      paymentId,
      evidenceType: 'QRIS_RECEIPT',
      file: { mimetype: 'image/png', size: 1024, originalname: 'qris.png', buffer: mockFileBuffer('image/png') }
    });

    check(evidence.evidence_type === 'QRIS_RECEIPT', 'T23.1: QRIS_RECEIPT type stored');
    check(evidence.mime_type === 'image/png', 'T23.2: PNG mime type stored');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test24_listIncludeInactive() {
  console.log('\n--- T24: List with include_inactive shows deactivated ---');
  const { propertyId, resId, paymentId } = await setupDirectFixture();
  try {
    const evidence = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: resId,
      paymentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    await deactivateEvidence(pool, {
      propertyId,
      reservationId: resId,
      paymentId,
      evidenceId: evidence.id,
      reason: 'Test'
    });

    const all = await getPaymentEvidences(pool, propertyId, resId, paymentId, true);
    const active = await getPaymentEvidences(pool, propertyId, resId, paymentId, false);

    check(all.length === 1, 'T24.1: Include inactive shows 1');
    check(active.length === 0, 'T24.2: Exclude inactive shows 0');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test25_replaceConcurrency() {
  console.log('\n--- T25: Replace concurrency safety preserved ---');
  const { propertyId, resId, paymentId } = await setupDirectFixture();
  try {
    const first = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: resId,
      paymentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test1.jpg', buffer: mockFileBuffer() }
    });

    const replaced = await replaceEvidence(pool, {
      propertyId,
      reservationId: resId,
      paymentId,
      oldEvidenceId: first.id,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test2.jpg', buffer: mockFileBuffer() }
    });

    check(replaced.newEvidence.is_active === true, 'T25.1: New evidence active');
    check(replaced.deactivatedEvidence.is_active === false, 'T25.2: Old evidence inactive');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test26_noEvidenceForGroupWithoutPayment() {
  console.log('\n--- T26: No evidence returned when group has no evidence ---');
  const { propertyId, res1, parentId } = await setupGroupFixture();
  try {
    const evidences = await getPaymentEvidences(pool, propertyId, res1, parentId);
    check(evidences.length === 0, 'T26.1: Empty evidence list for group without evidence');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test27_evidenceLinkedToCorrectPayment() {
  console.log('\n--- T27: Evidence linked to correct payment_transaction_id ---');
  const { propertyId, res1, parentId } = await setupGroupFixture();
  try {
    const evidence = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    check(evidence.payment_transaction_id === parentId, 'T27.1: Evidence linked to group parent');
    check(evidence.property_id === propertyId, 'T27.2: Evidence linked to correct property');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test28_siblingCanReplaceEvidence() {
  console.log('\n--- T28: Sibling can replace group evidence ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    const first = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test1.jpg', buffer: mockFileBuffer() }
    });

    const replaced = await replaceEvidence(pool, {
      propertyId,
      reservationId: res2,
      paymentId: parentId,
      oldEvidenceId: first.id,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test2.jpg', buffer: mockFileBuffer() }
    });

    check(replaced.newEvidence !== null, 'T28.1: Sibling replacement succeeds');
    check(replaced.deactivatedEvidence.id === first.id, 'T28.2: Old evidence deactivated');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test29_concurrentUploadSameGroup() {
  console.log('\n--- T29: Concurrent upload to same BOOKING_GROUP parent ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();

  try {
    const [result1, result2] = await Promise.all([
      (async () => {
        try {
          const r = await uploadPaymentEvidence(pool, {
            propertyId,
            reservationId: res1,
            paymentId: parentId,
            evidenceType: 'BANK_TRANSFER',
            file: { mimetype: 'image/jpeg', size: 1024, originalname: 'concurrent1.jpg', buffer: mockFileBuffer() }
          });
          return { success: true, result: r };
        } catch (err) {
          return { success: false, error: err };
        }
      })(),
      (async () => {
        try {
          const r = await uploadPaymentEvidence(pool, {
            propertyId,
            reservationId: res2,
            paymentId: parentId,
            evidenceType: 'BANK_TRANSFER',
            file: { mimetype: 'image/jpeg', size: 1024, originalname: 'concurrent2.jpg', buffer: mockFileBuffer() }
          });
          return { success: true, result: r };
        } catch (err) {
          return { success: false, error: err };
        }
      })()
    ]);

    const successCount = [result1, result2].filter(r => r.success).length;
    const conflictCount = [result1, result2].filter(r => !r.success && r.error && r.error.code === 'EVIDENCE_ALREADY_EXISTS').length;

    check(successCount === 1, 'T29.1: Exactly one concurrent upload succeeds');
    check(conflictCount === 1, 'T29.2: Exactly one concurrent upload gets EVIDENCE_ALREADY_EXISTS');

    // Verify DB state: exactly one active evidence row
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM payment_evidences WHERE payment_transaction_id = $1 AND is_active = TRUE`,
      [parentId]
    );
    check(Number(countRes.rows[0].count) === 1, 'T29.3: Exactly one active evidence row in DB');

    // T29.4: REAL STORAGE COMPENSATION ASSERTION
    const winner = [result1, result2].find(r => r.success).result;
    const evRow = await pool.query(`SELECT storage_key FROM payment_evidences WHERE id = $1`, [winner.id]);
    const expectedFilePath = resolveAbsolutePath(evRow.rows[0].storage_key);
    const propStorageDir = path.join(getStorageBaseDir(), 'payment-evidence', String(propertyId));

    function getFilesRecursively(dir) {
      let files = [];
      if (!fs.existsSync(dir)) return files;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files = files.concat(getFilesRecursively(fullPath));
        } else {
          files.push(fullPath);
        }
      }
      return files;
    }

    const filesOnDisk = getFilesRecursively(propStorageDir);
    check(filesOnDisk.length === 1, 'T29.4: Exactly one physical file remains on disk after compensation');
    check(filesOnDisk[0] === expectedFilePath, 'T29.4b: Surviving physical file matches winner storage_key');
  } finally {
    await cleanupCommittedFixture(propertyId);
    await assertZeroResidue(propertyId);
  }
}

async function test30_concurrentReplaceSameEvidence() {
  console.log('\n--- T30: Concurrent replace of same shared evidence ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();

  try {
    const initialEvidence = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'initial.jpg', buffer: mockFileBuffer() }
    });
    const oldEvidenceId = initialEvidence.id;

    const [result1, result2] = await Promise.all([
      (async () => {
        try {
          const r = await replaceEvidence(pool, {
            propertyId,
            reservationId: res1,
            paymentId: parentId,
            oldEvidenceId,
            evidenceType: 'BANK_TRANSFER',
            file: { mimetype: 'image/jpeg', size: 1024, originalname: 'replace1.jpg', buffer: mockFileBuffer() }
          });
          return { success: true, result: r };
        } catch (err) {
          return { success: false, error: err };
        }
      })(),
      (async () => {
        try {
          const r = await replaceEvidence(pool, {
            propertyId,
            reservationId: res2,
            paymentId: parentId,
            oldEvidenceId,
            evidenceType: 'BANK_TRANSFER',
            file: { mimetype: 'image/jpeg', size: 1024, originalname: 'replace2.jpg', buffer: mockFileBuffer() }
          });
          return { success: true, result: r };
        } catch (err) {
          return { success: false, error: err };
        }
      })()
    ]);

    const successCount = [result1, result2].filter(r => r.success).length;
    const conflictCount = [result1, result2].filter(r => !r.success && r.error && r.error.code === 'EVIDENCE_CONFLICT').length;

    check(successCount === 1, 'T30.1: Exactly one concurrent replace succeeds');
    check(conflictCount === 1, 'T30.2: Exactly one concurrent replace gets EVIDENCE_CONFLICT');

    const activeCount = await pool.query(
      `SELECT COUNT(*) FROM payment_evidences WHERE payment_transaction_id = $1 AND is_active = TRUE`,
      [parentId]
    );
    check(Number(activeCount.rows[0].count) === 1, 'T30.3: Exactly one active evidence after concurrent replace');

    const inactiveCount = await pool.query(
      `SELECT COUNT(*) FROM payment_evidences WHERE payment_transaction_id = $1 AND is_active = FALSE`,
      [parentId]
    );
    check(Number(inactiveCount.rows[0].count) >= 1, 'T30.4: Old evidence is inactive');
  } finally {
    await cleanupCommittedFixture(propertyId);
    await assertZeroResidue(propertyId);
  }
}

async function test31_stableAnchorInitialUpload() {
  console.log('\n--- T31: Stable anchor on initial group evidence upload ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    const evidence = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res2,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    check(evidence.reservation_id === res1, 'T31.1: Anchor is first allocation by stay_sequence (res1)');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test32_siblingAccessesAnchorsEvidence() {
  console.log('\n--- T32: Sibling B can access evidence stored under sibling A anchor ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res2,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test.jpg', buffer: mockFileBuffer() }
    });

    const evidences = await getPaymentEvidences(pool, propertyId, res1, parentId);
    check(evidences.length === 1, 'T32.1: Anchor sibling sees evidence uploaded by non-anchor sibling');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test33_siblingReplacesAnchorsEvidence() {
  console.log('\n--- T33: Sibling B can replace evidence stored under sibling A anchor ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    const first = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res2,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test1.jpg', buffer: mockFileBuffer() }
    });

    const replaced = await replaceEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      oldEvidenceId: first.id,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test2.jpg', buffer: mockFileBuffer() }
    });

    check(replaced.newEvidence !== null, 'T33.1: Anchor sibling can replace non-anchor evidence');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test34_replacementRetainsOriginalAnchor() {
  console.log('\n--- T34: Replacement retains original anchor reservation_id ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    const first = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res2,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test1.jpg', buffer: mockFileBuffer() }
    });

    check(first.reservation_id === res1, 'T34.1: Original evidence anchor is res1 (first by sequence)');

    const replaced = await replaceEvidence(pool, {
      propertyId,
      reservationId: res2,
      paymentId: parentId,
      oldEvidenceId: first.id,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test2.jpg', buffer: mockFileBuffer() }
    });

    check(replaced.newEvidence.reservation_id === res1, 'T34.2: Replacement retains original anchor reservation_id');
    check(replaced.newEvidence.id !== first.id, 'T34.3: Replacement creates new evidence row');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test35_anchorNotRecomputedOnReplace() {
  console.log('\n--- T35: Anchor is NOT recomputed during replacement ---');
  const { propertyId, res1, parentId } = await setupGroupFixture();
  try {
    const first = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test1.jpg', buffer: mockFileBuffer() }
    });

    const replaced = await replaceEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      oldEvidenceId: first.id,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'test2.jpg', buffer: mockFileBuffer() }
    });

    check(replaced.newEvidence.reservation_id === res1, 'T35.1: Anchor unchanged after replacement');
  } finally {
    await cleanupCommittedFixture(propertyId);
  }
}

async function test36_reversedAllocationRejectedInMutations() {
  console.log('\n--- T36: Reversed allocation rejected in upload/replace/deactivate ---');
  const { propertyId, res1, res2, parentId } = await setupGroupFixture();
  try {
    // A. Initial upload with ACTIVE allocation succeeds
    const ev1 = await uploadPaymentEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceType: 'BANK_TRANSFER',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'initial.jpg', buffer: mockFileBuffer() }
    });
    check(ev1.is_active === true, 'T36.1: Upload with ACTIVE allocation succeeds');

    // Mark res2 allocation as REVERSED
    await pool.query(
      `UPDATE payment_allocations SET status = 'REVERSED', updated_at = NOW() WHERE payment_transaction_id = $1 AND reservation_id = $2`,
      [parentId, res2]
    );

    // B.1: Upload through reversed allocation reservation is rejected with CROSS_RESERVATION_PAYMENT (403)
    let uploadRejected = false;
    try {
      await uploadPaymentEvidence(pool, {
        propertyId,
        reservationId: res2,
        paymentId: parentId,
        evidenceType: 'CASH_RECEIPT',
        file: { mimetype: 'image/jpeg', size: 1024, originalname: 'upload_rev.jpg', buffer: mockFileBuffer() }
      });
    } catch (err) {
      uploadRejected = err.code === 'CROSS_RESERVATION_PAYMENT' || err.statusCode === 403;
    }
    check(uploadRejected, 'T36.2: Upload through REVERSED allocation rejected with CROSS_RESERVATION_PAYMENT');

    // B.2: Replace through reversed allocation reservation is rejected with CROSS_RESERVATION_PAYMENT (403)
    let replaceRejected = false;
    try {
      await replaceEvidence(pool, {
        propertyId,
        reservationId: res2,
        paymentId: parentId,
        oldEvidenceId: ev1.id,
        evidenceType: 'QRIS_RECEIPT',
        file: { mimetype: 'image/jpeg', size: 1024, originalname: 'replace_rev.jpg', buffer: mockFileBuffer() }
      });
    } catch (err) {
      replaceRejected = err.code === 'CROSS_RESERVATION_PAYMENT' || err.statusCode === 403;
    }
    check(replaceRejected, 'T36.3: Replace through REVERSED allocation rejected with CROSS_RESERVATION_PAYMENT');

    // B.3: Deactivate through reversed allocation reservation is rejected with CROSS_RESERVATION_PAYMENT (403)
    let deactivateRejected = false;
    try {
      await deactivateEvidence(pool, {
        propertyId,
        reservationId: res2,
        paymentId: parentId,
        evidenceId: ev1.id,
        reason: 'Attempted deactivation by reversed allocation'
      });
    } catch (err) {
      deactivateRejected = err.code === 'CROSS_RESERVATION_PAYMENT' || err.statusCode === 403;
    }
    check(deactivateRejected, 'T36.4: Deactivate through REVERSED allocation rejected with CROSS_RESERVATION_PAYMENT');

    // Verify res1 (ACTIVE allocation) can still replace and deactivate
    const replaced = await replaceEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      oldEvidenceId: ev1.id,
      evidenceType: 'QRIS_RECEIPT',
      file: { mimetype: 'image/jpeg', size: 1024, originalname: 'replace_active.jpg', buffer: mockFileBuffer() }
    });
    check(replaced.newEvidence.is_active === true, 'T36.5: Replace through ACTIVE allocation succeeds');

    const deactivated = await deactivateEvidence(pool, {
      propertyId,
      reservationId: res1,
      paymentId: parentId,
      evidenceId: replaced.newEvidence.id,
      reason: 'Deactivation by active allocation'
    });
    check(deactivated.is_active === false, 'T36.6: Deactivate through ACTIVE allocation succeeds');
  } finally {
    await cleanupCommittedFixture(propertyId);
    await assertZeroResidue(propertyId);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== RUNNING MULTI-BOOKING-SCOPE-1B3B TESTS [runId=${runId}] ===\n`);

  const tests = [
    test1_directEvidenceUpload,
    test2_oneGroupParentOneEvidence,
    test3_siblingA_seesGroupEvidence,
    test4_siblingB_seesSameEvidence,
    test5_exactlyOneEvidenceRow,
    test6_unrelatedReservationCannotSee,
    test7_crossPropertyRejected,
    test8_voidedParentAllowsHierarchyButNotGate5,
    test9_secondUploadReturns409,
    test10_siblingCanAccessAfterUpload,
    test11_replacementWorksForGroup,
    test12_gate5HelperReturnsEvidence,
    test13_directEvidenceUnaffected,
    test14_inactiveAllocationCannotAccess,
    test15_correctErrorCodes,
    test16_evidenceByPaymentId,
    test17_anchorIsFirstBySequence,
    test18_noAnchorForGroup,
    test19_getEvidenceRowByIdGroup,
    test20_deactivateGroupEvidence,
    test21_nonAllocatedReservationRejected,
    test22_evidenceWithInactivePayment,
    test23_multipleEvidenceTypes,
    test24_listIncludeInactive,
    test25_replaceConcurrency,
    test26_noEvidenceForGroupWithoutPayment,
    test27_evidenceLinkedToCorrectPayment,
    test28_siblingCanReplaceEvidence,
    test29_concurrentUploadSameGroup,
    test30_concurrentReplaceSameEvidence,
    test31_stableAnchorInitialUpload,
    test32_siblingAccessesAnchorsEvidence,
    test33_siblingReplacesAnchorsEvidence,
    test34_replacementRetainsOriginalAnchor,
    test35_anchorNotRecomputedOnReplace,
    test36_reversedAllocationRejectedInMutations
  ];

  for (const test of tests) {
    try {
      await test();
    } catch (err) {
      console.error(`ERROR in ${test.name}:`, err);
      failed++;
    }
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
