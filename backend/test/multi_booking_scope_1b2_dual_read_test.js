/**
 * multi_booking_scope_1b2_dual_read_test.js
 *
 * MULTI-BOOKING-SCOPE-1B2 — Payment Allocation Domain Core (Read Engine)
 *
 * Tests the dual-read engine for reservation payment attribution:
 *   A. Direct ROOM_RESERVATION payment_transactions
 *   B. Allocated BOOKING_GROUP payments via payment_allocations
 *
 * 1B2 is READ-ONLY. No allocation writes, no schema changes, no group payment creation.
 *
 * Test matrix:
 *  1. Direct ROOM_RESERVATION payment only → unchanged amount_paid
 *  2. Allocation-only reservation → allocated amount becomes amount_paid, fallback MUST NOT execute
 *  3. One BOOKING_GROUP payment split across two reservations → each sees only its allocated_amount
 *  4. Hybrid: direct + allocated → totalEffectivePaid = sum
 *  5. REVERSED allocation → excluded from effective paid, but HISTORY exists (fallback blocked)
 *  6. VOIDED allocation → excluded from effective paid, but HISTORY exists (fallback blocked)
 *  7. Parent payment VOIDED → excluded from effective paid, but HISTORY exists (fallback blocked)
 *  8. Parent payment CORRECTED → excluded from effective paid, but HISTORY exists (fallback blocked)
 *  9. SUCCESS CORRECTION_REPLACEMENT BOOKING_GROUP parent → included
 * 10. DEPOSIT and DEPOSIT_REFUND → excluded from history and effective
 * 11. True legacy: no qualifying canonical source → existing folio/persisted fallback still works
 * 12. Canonical zero-amount direct payment: canonicalPaymentHistoryExists=true, totalEffectivePaid=0, fallback MUST NOT override
 * 13. Gate 4: zero-amount direct payment alone does NOT satisfy positive payment gate
 * 14. Gate 4: allocation-only positive group payment PASSES
 * 15. Gate 5: behavior remains unchanged
 * 16. Cross-property query isolation: helper requires correct propertyId
 * 17. POS/non-reservation payment cannot leak into reservation totals
 * 18. Direct + group allocation does not double-count parent pt.amount
 * 19. Conservation: intentionally deferred to 1B3 write service, NOT DB-enforced
 * 20-23. Stale-fallback resurrection regression: REVERSED/VOIDED/CORRECTED/VOIDED-PARENT
 *         must NOT activate legacy fallback even when stale folio credit exists
 */

require('dotenv').config();
const { Pool } = require('pg');
const { initializeDatabase } = require('../dist/db/schema_v3');
const { recalculateReservationFinancials } = require('../dist/domains/stayCharges/stayChargesService');
const { getEffectivePaymentStateForReservation } = require('../dist/domains/payments/paymentAllocationService');
const { evaluatePreCheckinEligibility } = require('../dist/domains/checkin/checkinGateService');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const runId = `1B2-${String(Date.now()).slice(-8)}`;
const basePropCode = `X${runId.slice(4, 8)}`; // property_code is VARCHAR(6)

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

// ── Per-test fixture helpers ──────────────────────────────────────────────────
// Each test runs inside its own transaction and ALWAYS rolls back, so tests
// leave zero residue (payments, allocations, bookings, properties) in the DB.
async function withTx(client, fn) {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    return result;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

let _seq = 0;

async function mkProperty(client, suffix) {
  // property_code: VARCHAR(6), CHECK (property_code ~ '^[A-Z0-9]{2,6}$'), UNIQUE
  // Build a unique 2-6 char alphanumeric code per run + property index
  if (!mkProperty._n) mkProperty._n = 0;
  mkProperty._n += 1;
  const code = `A${mkProperty._n}${runId.slice(-4)}`.slice(0, 6);
  const res = await client.query(
    `INSERT INTO properties (name, property_code) VALUES ($1, $2) RETURNING id`,
    [`1B2 Prop ${suffix}`, code]
  );
  return res.rows[0].id;
}

async function mkBooking(client, propertyId, suffix) {
  // Use runId + per-invocation counter to ensure unique bid across process restarts
  if (!mkBooking.counter) mkBooking.counter = {};
  const key = `${runId}:${propertyId}:${suffix}`;
  if (!mkBooking.counter[key]) mkBooking.counter[key] = 0;
  mkBooking.counter[key] += 1;
  const n = mkBooking.counter[key];
  const bid = `BID-1B2-${runId}-${n}`;
  const res = await client.query(
    `INSERT INTO bookings (bid, property_id, guest_name_snapshot) VALUES ($1, $2, $3) RETURNING id`,
    [bid, propertyId, `Guest ${suffix}`]
  );
  return res.rows[0].id;
}

async function mkReservation(client, bookingId) {
  _seq += 1;
  const seqNum = (_seq % 50) + 1;
  const res = await client.query(
    `INSERT INTO reservations (booking_id, guest_name, stay_sequence, check_in, check_out, status, total_price)
     VALUES ($1, $2, $3, '2026-10-01', '2026-10-03', 'CONFIRMED', 500000) RETURNING id`,
    [bookingId, `Guest ${_seq}`, seqNum]
  );
  return res.rows[0].id;
}

async function insertPayment(client, data) {
  if (data.reservation_id) {
    const res = await client.query(
      `INSERT INTO payment_transactions
       (property_id, booking_id, reservation_id, transaction_type, amount, scope, reference_code, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [data.property_id, data.booking_id || null, data.reservation_id,
       data.transaction_type || 'PAYMENT', data.amount, data.scope || 'ROOM_RESERVATION',
       data.reference_code || `1B2_${Date.now()}`, data.status || 'SUCCESS']
    );
    return res.rows[0].id;
  } else {
    const res = await client.query(
      `INSERT INTO payment_transactions
       (property_id, booking_id, transaction_type, amount, scope, reference_code, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [data.property_id, data.booking_id || null, data.transaction_type || 'PAYMENT',
       data.amount, data.scope || 'BOOKING_GROUP',
       data.reference_code || `1B2_${Date.now()}`, data.status || 'SUCCESS']
    );
    return res.rows[0].id;
  }
}

async function insertAllocation(client, data) {
  const res = await client.query(
    `INSERT INTO payment_allocations
     (payment_transaction_id, reservation_id, booking_id, property_id,
      allocated_amount, allocation_sequence, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [data.payment_transaction_id, data.reservation_id, data.booking_id, data.property_id,
     data.allocated_amount, data.allocation_sequence || 1, data.status || 'ACTIVE',
     'test']
  );
  return res.rows[0].id;
}

async function insertFolioEntry(client, data) {
  const res = await client.query(
    `INSERT INTO folio_entries
     (reservation_id, property_id, entry_type, amount, direction, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [data.reservation_id, data.property_id, data.entry_type, data.amount,
     data.direction || 'DEBIT', data.status || 'POSTED']
  );
  return res.rows[0].id;
}

// ── Gate mock helpers ────────────────────────────────────────────────────────
function makeGateMock(clientMockData, reservationId, propertyId, roomId = null) {
  const mock = {
    async query(sql, params) {
      if (sql.includes('WITH direct AS') && sql.includes('CROSS JOIN allocated')) {
        const rows = clientMockData.dualReadRows || [{
          direct_paid: '0', direct_source_cnt: '0', direct_positive_cnt: '0',
          allocated_paid: '0', alloc_source_cnt: '0', alloc_positive_cnt: '0'
        }];
        return { rows, rowCount: rows.length || 1 };
      }
      if (sql.includes('payment_evidences') && sql.includes('COUNT(*)')) {
        const cnt = String(clientMockData.evidenceCount || 0);
        return { rows: [{ cnt }], rowCount: 1 };
      }
      if (sql.includes('FROM reservations') && sql.includes('res.id')) {
        return { rows: [{ id: reservationId, room_id: roomId, booking_property_id: propertyId, room_property_id: propertyId }], rowCount: 1 };
      }
      if (sql.includes('PRIMARY_GUEST') && sql.includes('full_name')) {
        return { rows: [{ full_name: 'Test Guest', phone: '081234567890' }], rowCount: 1 };
      }
      if (sql.includes('PRIMARY_GUEST') && sql.includes('identity_storage_key')) {
        return { rows: [{ identity_storage_key: 'key.jpg', has_valid_identity: true }], rowCount: 1 };
      }
      if (sql.includes('identity_custody') && sql.includes('COUNT(*)')) {
        return { rows: [{ cnt: '0' }], rowCount: 1 };
      }
      if (sql.includes('FROM deposits') && sql.includes('SELECT id')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM rooms') && sql.includes('WHERE id =')) {
        return { rows: [{ id: roomId || 999, status: 'VACANT_CLEAN', is_active: true }], rowCount: 1 };
      }
      if (sql.includes('outgoing') || sql.includes('CHECKED_IN')) return { rows: [], rowCount: 0 };
      if (sql.includes('check_in FROM reservations')) return { rows: [{ check_in: '2026-10-01' }], rowCount: 1 };
      if (sql.includes('FROM deposit_events')) return { rows: [], rowCount: 0 };
      throw new Error(`Unhandled query: ${sql.substring(0, 100)}`);
    },
    release() {}
  };
  return mock;
}

async function main() {
  const client = await pool.connect();
  console.log(`\n=== RUNNING MULTI-BOOKING-SCOPE-1B2 DUAL-READ TESTS [runId=${runId}] ===\n`);
  await initializeDatabase(pool);

  try {
    // ═══════════════════════════════════════════════════════════════
    // TEST 1: Direct ROOM_RESERVATION payment only
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('--- Test 1: Direct ROOM_RESERVATION payment only ---');
      const propA = await mkProperty(tx, 'A');
      const bk = await mkBooking(tx, propA, 'DIR');
      const res = await mkReservation(tx, bk);
      const ptId = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 200000, scope: 'ROOM_RESERVATION', reservation_id: res, reference_code: `T1_${Date.now()}` });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.directPaid === 200000, 'T1: directPaid = 200000');
      check(state.allocatedPaid === 0, 'T1: allocatedPaid = 0');
      check(state.totalEffectivePaid === 200000, 'T1: totalEffectivePaid = 200000');
      check(state.canonicalSourceExists === true, 'T1: canonicalSourceExists = true');
      check(state.qualifyingPositivePaymentExists === true, 'T1: qualifyingPositivePaymentExists = true');

      const financials = await recalculateReservationFinancials(tx, res, propA);
      check(financials.amount_paid === 200000, 'T1: amount_paid = 200000');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 2: Allocation-only reservation
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 2: Allocation-only reservation ---');
      const propA = await mkProperty(tx, 'B');
      const bk = await mkBooking(tx, propA, 'GRP');
      const res = await mkReservation(tx, bk);
      const ptId = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 300000, scope: 'BOOKING_GROUP', reference_code: `T2_${Date.now()}` });
      const allocId = await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res, payment_transaction_id: ptId, allocated_amount: 150000 });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.directPaid === 0, 'T2: directPaid = 0');
      check(state.allocatedPaid === 150000, 'T2: allocatedPaid = 150000');
      check(state.totalEffectivePaid === 150000, 'T2: totalEffectivePaid = 150000');
      check(state.canonicalSourceExists === true, 'T2: canonicalSourceExists = true');
      check(state.qualifyingPositivePaymentExists === true, 'T2: qualifyingPositivePaymentExists = true');

      const financials = await recalculateReservationFinancials(tx, res, propA);
      check(financials.amount_paid === 150000, 'T2: amount_paid = 150000 from allocation');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 3: One BG payment split across two reservations
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 3: One BG payment split across 2 reservations ---');
      const propA = await mkProperty(tx, 'C');
      const bk = await mkBooking(tx, propA, 'GRP');
      const res1 = await mkReservation(tx, bk);
      const res2 = await mkReservation(tx, bk);
      const ptId = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 400000, scope: 'BOOKING_GROUP', reference_code: `T3_${Date.now()}` });
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res1, payment_transaction_id: ptId, allocated_amount: 100000 });
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res2, payment_transaction_id: ptId, allocated_amount: 200000 });

      const state1 = await getEffectivePaymentStateForReservation(tx, res1, propA);
      const state2 = await getEffectivePaymentStateForReservation(tx, res2, propA);
      check(state1.allocatedPaid === 100000, 'T3: Res1 sees only its allocated_amount = 100000');
      check(state2.allocatedPaid === 200000, 'T3: Res2 sees only its allocated_amount = 200000');
      check(state1.directPaid === 0, 'T3: Res1 directPaid = 0');
      check(state2.directPaid === 0, 'T3: Res2 directPaid = 0');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 4: Hybrid direct + allocated
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 4: Hybrid direct + allocated ---');
      const propA = await mkProperty(tx, 'D');
      const bk = await mkBooking(tx, propA, 'GRP');
      const res = await mkReservation(tx, bk);
      // Direct payment for this reservation (same booking)
      await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 50000, scope: 'ROOM_RESERVATION', reservation_id: res, reference_code: `T4_${Date.now()}` });
      // Group payment with allocation to same reservation
      const ptGroup = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 200000, scope: 'BOOKING_GROUP', reference_code: `T4g_${Date.now()}` });
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res, payment_transaction_id: ptGroup, allocated_amount: 100000 });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.directPaid === 50000, 'T4: directPaid = 50000');
      check(state.allocatedPaid === 100000, 'T4: allocatedPaid = 100000');
      check(state.totalEffectivePaid === 150000, 'T4: totalEffectivePaid = 150000');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 5: REVERSED allocation excluded
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 5: REVERSED allocation excluded ---');
      const propA = await mkProperty(tx, 'E');
      const bk = await mkBooking(tx, propA, 'GRP');
      const res = await mkReservation(tx, bk);
      const ptId = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 300000, scope: 'BOOKING_GROUP', reference_code: `T5_${Date.now()}` });
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res, payment_transaction_id: ptId, allocated_amount: 150000, status: 'REVERSED' });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.allocatedPaid === 0, 'T5: allocatedPaid = 0 (REVERSED excluded)');
      check(state.canonicalPaymentHistoryExists === true, 'T5: canonicalPaymentHistoryExists = true (history preserved)');
      check(state.qualifyingPositivePaymentExists === false, 'T5: qualifyingPositivePaymentExists = false');

      // Stale-fallback regression: even with stale folio credit, fallback must NOT activate
      await insertFolioEntry(tx, { reservation_id: res, property_id: propA, entry_type: 'PAYMENT', amount: 99999, direction: 'CREDIT' });
      const financials5 = await recalculateReservationFinancials(tx, res, propA);
      check(financials5.amount_paid === 0, 'T5: amount_paid = 0 (stale folio NOT resurrected)');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 6: VOIDED allocation excluded
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 6: VOIDED allocation excluded ---');
      const propA = await mkProperty(tx, 'F');
      const bk = await mkBooking(tx, propA, 'GRP');
      const res = await mkReservation(tx, bk);
      const ptId = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 300000, scope: 'BOOKING_GROUP', reference_code: `T6_${Date.now()}` });
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res, payment_transaction_id: ptId, allocated_amount: 150000, status: 'VOIDED' });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.allocatedPaid === 0, 'T6: allocatedPaid = 0 (VOIDED excluded)');
      check(state.canonicalPaymentHistoryExists === true, 'T6: canonicalPaymentHistoryExists = true (history preserved)');

      // Stale-fallback regression
      await insertFolioEntry(tx, { reservation_id: res, property_id: propA, entry_type: 'PAYMENT', amount: 88888, direction: 'CREDIT' });
      const financials6 = await recalculateReservationFinancials(tx, res, propA);
      check(financials6.amount_paid === 0, 'T6: amount_paid = 0 (stale folio NOT resurrected)');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 7: Parent payment VOIDED excluded
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 7: Parent payment VOIDED excluded ---');
      const propA = await mkProperty(tx, 'G');
      const bk = await mkBooking(tx, propA, 'GRP');
      const res = await mkReservation(tx, bk);
      const ptId = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 300000, scope: 'BOOKING_GROUP', status: 'VOIDED', reference_code: `T7_${Date.now()}` });
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res, payment_transaction_id: ptId, allocated_amount: 150000, status: 'ACTIVE' });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.allocatedPaid === 0, 'T7: allocatedPaid = 0 (parent VOIDED)');
      check(state.canonicalPaymentHistoryExists === true, 'T7: canonicalPaymentHistoryExists = true (history preserved)');

      // Stale-fallback regression
      await insertFolioEntry(tx, { reservation_id: res, property_id: propA, entry_type: 'PAYMENT', amount: 77777, direction: 'CREDIT' });
      const financials7 = await recalculateReservationFinancials(tx, res, propA);
      check(financials7.amount_paid === 0, 'T7: amount_paid = 0 (stale folio NOT resurrected)');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 8: Parent payment CORRECTED excluded
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 8: Parent payment CORRECTED excluded ---');
      const propA = await mkProperty(tx, 'H');
      const bk = await mkBooking(tx, propA, 'GRP');
      const res = await mkReservation(tx, bk);
      const ptId = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 300000, scope: 'BOOKING_GROUP', status: 'CORRECTED', reference_code: `T8_${Date.now()}` });
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res, payment_transaction_id: ptId, allocated_amount: 150000, status: 'ACTIVE' });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.allocatedPaid === 0, 'T8: allocatedPaid = 0 (parent CORRECTED)');
      check(state.canonicalPaymentHistoryExists === true, 'T8: canonicalPaymentHistoryExists = true (history preserved)');

      // Stale-fallback regression
      await insertFolioEntry(tx, { reservation_id: res, property_id: propA, entry_type: 'PAYMENT', amount: 66666, direction: 'CREDIT' });
      const financials8 = await recalculateReservationFinancials(tx, res, propA);
      check(financials8.amount_paid === 0, 'T8: amount_paid = 0 (stale folio NOT resurrected)');
    });

    // ══════════════════════════════════════��════════════════════════
    // TEST 9: CORRECTION_REPLACEMENT BG parent included
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 9: CORRECTION_REPLACEMENT BG parent included ---');
      const propA = await mkProperty(tx, 'I');
      const bk = await mkBooking(tx, propA, 'GRP');
      const res = await mkReservation(tx, bk);
      const ptId = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'CORRECTION_REPLACEMENT', amount: 300000, scope: 'BOOKING_GROUP', reference_code: `T9_${Date.now()}` });
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res, payment_transaction_id: ptId, allocated_amount: 150000 });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.allocatedPaid === 150000, 'T9: allocatedPaid = 150000 (CORRECTION_REPLACEMENT included)');
      check(state.canonicalSourceExists === true, 'T9: canonicalSourceExists = true');
      check(state.qualifyingPositivePaymentExists === true, 'T9: qualifyingPositivePaymentExists = true');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 10: DEPOSIT and DEPOSIT_REFUND excluded
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 10: DEPOSIT/DEPOSIT_REFUND excluded ---');
      const propA = await mkProperty(tx, 'J');
      const bk = await mkBooking(tx, propA, 'GRP');
      const res1 = await mkReservation(tx, bk);
      const res2 = await mkReservation(tx, bk);
      const ptDeposit = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'DEPOSIT', amount: 300000, scope: 'BOOKING_GROUP', reference_code: `T10d_${Date.now()}` });
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res1, payment_transaction_id: ptDeposit, allocated_amount: 150000 });
      const ptRefund = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'DEPOSIT_REFUND', amount: 300000, scope: 'BOOKING_GROUP', reference_code: `T10r_${Date.now()}` });
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res2, payment_transaction_id: ptRefund, allocated_amount: 150000 });

      const state1 = await getEffectivePaymentStateForReservation(tx, res1, propA);
      const state2 = await getEffectivePaymentStateForReservation(tx, res2, propA);
      check(state1.allocatedPaid === 0, 'T10: DEPOSIT excluded');
      check(state1.canonicalSourceExists === false, 'T10: canonicalSourceExists = false');
      check(state2.allocatedPaid === 0, 'T10: DEPOSIT_REFUND also excluded');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 11: True legacy fallback
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 11: True legacy fallback ---');
      const propA = await mkProperty(tx, 'K');
      const bk = await mkBooking(tx, propA, 'LEG');
      const res = await mkReservation(tx, bk);
      await insertFolioEntry(tx, { reservation_id: res, property_id: propA, entry_type: 'PAYMENT', amount: 75000, direction: 'CREDIT' });

      const financials = await recalculateReservationFinancials(tx, res, propA);
      check(financials.amount_paid === 75000, 'T11: legacy fallback uses folio_credit = 75000');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 12: Zero-amount direct payment
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 12: Zero-amount direct payment ---');
      const propA = await mkProperty(tx, 'L');
      const bk = await mkBooking(tx, propA, 'ZERO');
      const res = await mkReservation(tx, bk);
      await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 0, scope: 'ROOM_RESERVATION', reservation_id: res, reference_code: `T12_${Date.now()}` });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.directPaid === 0, 'T12: directPaid = 0');
      check(state.totalEffectivePaid === 0, 'T12: totalEffectivePaid = 0');
      check(state.canonicalPaymentHistoryExists === true, 'T12: canonicalPaymentHistoryExists = true (row exists with status SUCCESS)');
      check(state.qualifyingPositivePaymentExists === false, 'T12: qualifyingPositivePaymentExists = false');

      const financials = await recalculateReservationFinancials(tx, res, propA);
      check(financials.amount_paid === 0, 'T12: amount_paid = 0, fallback NOT activated');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 13: Gate 4 - zero-amount direct payment fails
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 13: Gate 4 zero-amount direct payment ---');
      const propA = await mkProperty(tx, 'M');
      const bk = await mkBooking(tx, propA, 'M');
      const res = await mkReservation(tx, bk);
      await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 0, scope: 'ROOM_RESERVATION', reservation_id: res, reference_code: `T13_${Date.now()}` });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.qualifyingPositivePaymentExists === false, 'T13: qualifyingPositivePaymentExists = false');

      const mock = makeGateMock({ dualReadRows: [{ direct_paid: '0', direct_source_cnt: '1', direct_positive_cnt: '0', allocated_paid: '0', alloc_source_cnt: '0', alloc_positive_cnt: '0' }, { cnt: '0' }], evidenceCount: 0 }, res, propA);
      const result = await evaluatePreCheckinEligibility(mock, propA, res);
      check(result.payment_ok === false, 'T13: Gate 4 fails for zero-amount direct payment');
      check(result.payment_evidence_ok === false, 'T13: Gate 5 also fails (no payment)');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 14: Gate 4 - allocation-only passes
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 14: Gate 4 allocation-only passes ---');
      const propA = await mkProperty(tx, 'N');
      const bk = await mkBooking(tx, propA, 'N');
      const res = await mkReservation(tx, bk);
      const ptId = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 300000, scope: 'BOOKING_GROUP', reference_code: `T14_${Date.now()}` });
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res, payment_transaction_id: ptId, allocated_amount: 150000 });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.qualifyingPositivePaymentExists === true, 'T14: qualifyingPositivePaymentExists = true');

      const mock = makeGateMock({ dualReadRows: [{ direct_paid: '0', direct_source_cnt: '0', direct_positive_cnt: '0', allocated_paid: '150000', alloc_source_cnt: '1', alloc_positive_cnt: '1' }, { cnt: '0' }], evidenceCount: 0 }, res, propA);
      const result = await evaluatePreCheckinEligibility(mock, propA, res);
      check(result.payment_ok === true, 'T14: Gate 4 passes for allocation-only');
      check(result.payment_evidence_ok === false, 'T14: Gate 5 fails (no evidence for group payment)');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 15: Gate 5 unchanged
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 15: Gate 5 unchanged ---');
      const propA = await mkProperty(tx, 'O');
      const bk = await mkBooking(tx, propA, 'O');
      const res = await mkReservation(tx, bk);
      const ptId = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 50000, scope: 'ROOM_RESERVATION', reservation_id: res, reference_code: `T15_${Date.now()}` });

      const mock = makeGateMock({ dualReadRows: [{ direct_paid: '50000', direct_source_cnt: '1', direct_positive_cnt: '1', allocated_paid: '0', alloc_source_cnt: '0', alloc_positive_cnt: '0' }, { cnt: '1' }], evidenceCount: 1 }, res, propA);
      const result = await evaluatePreCheckinEligibility(mock, propA, res);
      check(result.payment_ok === true, 'T15: Gate 4 passes');
      check(result.payment_evidence_ok === true, 'T15: Gate 5 passes (unchanged behavior)');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 16: Cross-property isolation
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 16: Cross-property isolation ---');
      const propA = await mkProperty(tx, 'P');
      const bk = await mkBooking(tx, propA, 'P');
      const res = await mkReservation(tx, bk);
      const ptId = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 300000, scope: 'BOOKING_GROUP', reference_code: `T16_${Date.now()}` });
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res, payment_transaction_id: ptId, allocated_amount: 150000 });

      const stateCorrect = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(stateCorrect.allocatedPaid === 150000, 'T16a: Correct propertyId finds allocation');

      const propB = await mkProperty(tx, 'Q');
      const stateWrong = await getEffectivePaymentStateForReservation(tx, res, propB);
      check(stateWrong.allocatedPaid === 0, 'T16b: Wrong propertyId excludes allocation');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 17: POS/non-reservation payment cannot leak
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 17: POS/non-reservation payment isolation ---');
      const propA = await mkProperty(tx, 'R');
      const bk = await mkBooking(tx, propA, 'R');
      const res = await mkReservation(tx, bk);
      // POS payment with reservation_id = NULL
      await insertPayment(tx, { property_id: propA, booking_id: null, transaction_type: 'PAYMENT', amount: 999999, scope: 'ROOM_RESERVATION', reference_code: `T17_${Date.now()}` });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.directPaid === 0, 'T17: POS payment with null reservation_id not counted');
      check(state.totalEffectivePaid === 0, 'T17: totalEffectivePaid = 0');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 18: No double-counting parent pt.amount
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 18: No double-counting ---');
      const propA = await mkProperty(tx, 'S');
      const bk = await mkBooking(tx, propA, 'S');
      const res1 = await mkReservation(tx, bk);
      const res2 = await mkReservation(tx, bk);
      const ptId = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 1000000, scope: 'BOOKING_GROUP', reference_code: `T18_${Date.now()}` });
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res1, payment_transaction_id: ptId, allocated_amount: 600000 });
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res2, payment_transaction_id: ptId, allocated_amount: 400000 });

      const state1 = await getEffectivePaymentStateForReservation(tx, res1, propA);
      const state2 = await getEffectivePaymentStateForReservation(tx, res2, propA);
      check(state1.allocatedPaid === 600000, 'T18a: Res1 sees only its allocation, not parent amount');
      check(state2.allocatedPaid === 400000, 'T18b: Res2 sees only its allocation, not parent amount');
      check(state1.totalEffectivePaid !== 1000000, 'T18: No double-counting of parent pt.amount');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 19: Conservation is NOT DB-enforced (documented)
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 19: Conservation deferred to 1B3 ---');
      const propA = await mkProperty(tx, 'T');
      const bk = await mkBooking(tx, propA, 'T');
      const res = await mkReservation(tx, bk);
      const ptId = await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 100000, scope: 'BOOKING_GROUP', reference_code: `T19_${Date.now()}` });
      // Over-allocation: allocated > parent (intentionally allowed in 1B2 read)
      await insertAllocation(tx, { property_id: propA, booking_id: bk, reservation_id: res, payment_transaction_id: ptId, allocated_amount: 200000 });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.allocatedPaid === 200000, 'T19: Read engine reflects stored allocation (not capped)');
      check(state.totalEffectivePaid === 200000, 'T19: Conservation is write-time invariant for 1B3');
      console.log('  NOTE: Aggregate conservation (SUM allocated <= parent amount) is intentionally NOT');
      console.log('        enforced by DB in 1B2. This is a mandatory 1B3 write-time invariant.');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 20: REVERSED DIRECT payment — history=true, effective=0, fallback blocked
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 20: REVERSED direct payment — stale fallback regression ---');
      const propA = await mkProperty(tx, 'U');
      const bk = await mkBooking(tx, propA, 'REV');
      const res = await mkReservation(tx, bk);
      await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 200000, scope: 'ROOM_RESERVATION', reservation_id: res, status: 'REVERSED', reference_code: `T20_${Date.now()}` });
      // Stale folio credit that would be resurrected by legacy fallback
      await insertFolioEntry(tx, { reservation_id: res, property_id: propA, entry_type: 'PAYMENT', amount: 99999, direction: 'CREDIT' });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.directPaid === 0, 'T20: directPaid = 0 (REVERSED excluded)');
      check(state.canonicalPaymentHistoryExists === true, 'T20: canonicalPaymentHistoryExists = true');
      check(state.qualifyingPositivePaymentExists === false, 'T20: qualifyingPositivePaymentExists = false');

      const financials = await recalculateReservationFinancials(tx, res, propA);
      check(financials.amount_paid === 0, 'T20: amount_paid = 0 (stale folio NOT resurrected)');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 21: VOIDED DIRECT payment — history=true, effective=0, fallback blocked
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 21: VOIDED direct payment — stale fallback regression ---');
      const propA = await mkProperty(tx, 'V');
      const bk = await mkBooking(tx, propA, 'VID');
      const res = await mkReservation(tx, bk);
      await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 200000, scope: 'ROOM_RESERVATION', reservation_id: res, status: 'VOIDED', reference_code: `T21_${Date.now()}` });
      await insertFolioEntry(tx, { reservation_id: res, property_id: propA, entry_type: 'PAYMENT', amount: 88888, direction: 'CREDIT' });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.directPaid === 0, 'T21: directPaid = 0 (VOIDED excluded)');
      check(state.canonicalPaymentHistoryExists === true, 'T21: canonicalPaymentHistoryExists = true');

      const financials = await recalculateReservationFinancials(tx, res, propA);
      check(financials.amount_paid === 0, 'T21: amount_paid = 0 (stale folio NOT resurrected)');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 22: CORRECTED DIRECT payment — history=true, effective=0, fallback blocked
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 22: CORRECTED direct payment — stale fallback regression ---');
      const propA = await mkProperty(tx, 'W');
      const bk = await mkBooking(tx, propA, 'COR');
      const res = await mkReservation(tx, bk);
      await insertPayment(tx, { property_id: propA, booking_id: bk, transaction_type: 'PAYMENT', amount: 200000, scope: 'ROOM_RESERVATION', reservation_id: res, status: 'CORRECTED', reference_code: `T22_${Date.now()}` });
      await insertFolioEntry(tx, { reservation_id: res, property_id: propA, entry_type: 'PAYMENT', amount: 77777, direction: 'CREDIT' });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.directPaid === 0, 'T22: directPaid = 0 (CORRECTED excluded)');
      check(state.canonicalPaymentHistoryExists === true, 'T22: canonicalPaymentHistoryExists = true');

      const financials = await recalculateReservationFinancials(tx, res, propA);
      check(financials.amount_paid === 0, 'T22: amount_paid = 0 (stale folio NOT resurrected)');
    });

    // ═══════════════════════════════════════════════════════════════
    // TEST 23: True legacy still works — no history at all → fallback activates
    // ═══════════════════════════════════════════════════════════════
    await withTx(client, async (tx) => {
      console.log('\n--- Test 23: True legacy fallback still works ---');
      const propA = await mkProperty(tx, 'X');
      const bk = await mkBooking(tx, propA, 'LEG');
      const res = await mkReservation(tx, bk);
      // No payment at all — only stale folio credit
      await insertFolioEntry(tx, { reservation_id: res, property_id: propA, entry_type: 'PAYMENT', amount: 50000, direction: 'CREDIT' });

      const state = await getEffectivePaymentStateForReservation(tx, res, propA);
      check(state.canonicalPaymentHistoryExists === false, 'T23: canonicalPaymentHistoryExists = false (no history)');

      const financials = await recalculateReservationFinancials(tx, res, propA);
      check(financials.amount_paid === 50000, 'T23: legacy fallback uses folio_credit = 50000');
    });

    console.log(`\n========================================`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`========================================\n`);

  } finally {
    client.release();
  }

  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Test error:', err); process.exit(1); });
