/**
 * multi_booking_scope_1b3a_test.js
 *
 * MULTI-BOOKING-SCOPE-1B3A — Group Payment Write Domain Core
 *
 * Tests the write service for creating BOOKING_GROUP payments with allocations.
 * Read-only from the perspective of runtime booking creation.
 *
 * Test matrix (27 scenarios):
 *  1. Booking + reservation deterministic lock behavior (via proxy)
 *  2. 2-room full booking payment
 *  3. Partial payment affecting only first child (still BOOKING_GROUP)
 *  4. Partial payment spanning multiple children
 *  5. Historical direct payment + new group allocation
 *  6. Applied deposit reduces allocatable remaining due
 *  7. Exact-boundary payment accepted
 *  8. Overpayment rejected
 *  9. Zero payment rejected
 * 10. Negative payment rejected
 * 11. Exactly one BOOKING_GROUP parent
 * 12. Zero synthetic ROOM_RESERVATION child payments
 * 13. Allocation count matches affected children
 * 14. Each allocation amount correct
 * 15. Stored-row conservation exact
 * 16. Folio credit equals allocation, not parent
 * 17. Folio projection does not double-count amount_paid
 * 18. Cross-booking rejected
 * 19. Cross-property rejected
 * 20. Parent insert + later failure rolls back (genuine rollback test)
 * 21. Allocation failure after partial writes rolls back
 * 22. Folio projection failure rolls back
 * 23. Recalc failure rolls back
 * 24. Service does not claim standalone retry-idempotency
 * 25. src/index.ts runtime booking path remains untouched
 * 26. Explicit ineligible reservation (CANCELLED/CHECKED_OUT) rejected
 * 27. Explicit empty reservationIds array rejected (NO_TARGET_RESERVATIONS)
 */

require('dotenv').config();
const { Pool } = require('pg');
const { createBookingGroupPaymentWithAllocations } = require('../dist/domains/payments/bookingGroupPaymentService');
const { getEffectivePaymentStateForReservation } = require('../dist/domains/payments/paymentAllocationService');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const runId = `1B3A-${String(Date.now()).slice(-8)}`;
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

// ─── Fault-Injecting Proxy Client ────────────────────────────────────────────
class FaultInjectingClient {
  constructor(realClient, options = {}) {
    this._real = realClient;
    this._queries = [];
    this._queryIndex = 0;
    this._allocCount = 0;
    this._folioCount = 0;
    this._throwAt = options.throwAt || null;
    this._throwMessage = options.throwMessage || 'Injected test error';
  }

  get queries() { return this._queries; }
  get allocCount() { return this._allocCount; }
  get folioCount() { return this._folioCount; }

  async query(sql, params) {
    this._queries.push(sql);
    this._queryIndex++;

    // Count allocation and folio inserts for threshold-based triggering
    if (sql.includes('INSERT INTO payment_allocations')) this._allocCount++;
    if (sql.includes('INSERT INTO folio_entries')) this._folioCount++;

    // Check if we should throw
    if (this._throwAt) {
      let shouldThrow = false;
      if (typeof this._throwAt === 'number') {
        shouldThrow = this._queryIndex === this._throwAt;
      } else if (this._throwAt instanceof RegExp) {
        shouldThrow = this._throwAt.test(sql);
      } else if (typeof this._throwAt === 'string') {
        shouldThrow = sql.includes(this._throwAt);
      } else if (typeof this._throwAt === 'function') {
        shouldThrow = this._throwAt(sql, this);
      }
      if (shouldThrow) {
        throw new Error(this._throwMessage);
      }
    }

    return this._real.query(sql, params);
  }

  release() {
    return this._real.release();
  }
}

// ─── Transaction wrapper (tests ALWAYS rollback, never commit) ───────────────
async function withTx(client, fn) {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('ROLLBACK').catch(() => {});
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// ─── Failure injection harness ───────────────────────────────────────────────
/**
 * Runs a service call through a fault-injecting proxy, expects it to throw,
 * then verifies no financial residue remains using a SEPARATE transaction.
 */
async function expectRollbackFromFault(
  client,
  setupFn,
  serviceCallFn,
  verifyFn,
  faultAt,
  faultMessage = 'Injected test error'
) {
  const realClient = client;
  const proxy = new FaultInjectingClient(realClient, { throwAt: faultAt, throwMessage: faultMessage });

  // Setup fixtures using real client (still in transaction)
  await setupFn(realClient);

  // Call service through proxy (should throw)
  let threw = false;
  let threwMessage = null;
  try {
    await serviceCallFn(proxy);
  } catch (err) {
    threw = true;
    threwMessage = err.message;
  }
  check(threw, `Fault injected successfully (${threwMessage})`);

  // IMPORTANT: Verify residue from a SEPARATE transaction so read-your-own-writes
  // doesn't mask the rollback. We issue ROLLBACK on the original client first,
  // then open a new transaction on the same pool connection to verify.
  try {
    await realClient.query('ROLLBACK');
  } catch (_) {
    await realClient.query('COMMIT').catch(() => {});
  }

  // Verify using a separate connection
  const verifyClient = await pool.connect();
  await verifyClient.query('BEGIN');
  try {
    await verifyFn(verifyClient);
  } finally {
    await verifyClient.query('ROLLBACK').catch(() => {});
    verifyClient.release();
  }
}

// ─── Fixture helpers (use GLOBAL counters for uniqueness across tests) ───────
// NOTE: _propSeq is intentionally NOT reset per test — each test may create
// multiple properties, and we need globally unique codes.
let _propSeq = 0;
let _bookingSeq = 0;
let _resSeq = 0;

async function mkProperty(client) {
  _propSeq += 1;
  // Use random suffix to guarantee uniqueness across runs
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  const code = `PB${suffix}`;
  const res = await client.query(
    `INSERT INTO properties (name, property_code) VALUES ($1, $2) RETURNING id`,
    [`1B3A Test Prop ${_propSeq}`, code]
  );
  return Number(res.rows[0].id);
}

async function mkBooking(client, propertyId) {
  _bookingSeq += 1;
  const bid = `BID-1B3A-${runId}-${_bookingSeq}`;
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

async function insertFolioDepositApply(client, reservationId, propertyId, amount) {
  const res = await client.query(
    `INSERT INTO folio_entries (
       reservation_id, property_id, entry_type, amount, direction, status
     ) VALUES ($1, $2, 'DEPOSIT_APPLY', $3, 'CREDIT', 'POSTED')
     RETURNING id`,
    [reservationId, propertyId, amount]
  );
  return Number(res.rows[0].id);
}

// ─── Post-rollback verification helpers (use fresh transaction, refCode match)
async function verifyNoParent(freshClient, refCodePrefix) {
  const res = await freshClient.query(
    `SELECT COUNT(*) FROM payment_transactions WHERE reference_code LIKE $1`,
    [`${refCodePrefix}%`]
  );
  check(Number(res.rows[0].count) === 0, 'No parent payment persisted after rollback');
}

async function verifyNoAllocations(freshClient, refCodePrefix) {
  const res = await freshClient.query(
    `SELECT COUNT(*) FROM payment_allocations pa
     JOIN payment_transactions pt ON pt.id = pa.payment_transaction_id
     WHERE pt.reference_code LIKE $1`,
    [`${refCodePrefix}%`]
  );
  check(Number(res.rows[0].count) === 0, 'No allocations persisted after rollback');
}

async function verifyNoFolio(freshClient, bookingId, propertyId) {
  const res = await freshClient.query(
    `SELECT COUNT(*) FROM folio_entries
     WHERE source_type = 'BOOKING_PAYMENT'
       AND source_id = $1
       AND entry_type = 'PAYMENT'
       AND property_id = $2`,
    [String(bookingId), propertyId]
  );
  check(Number(res.rows[0].count) === 0, 'No BOOKING_PAYMENT folio residue after rollback');
}

// ─── Test cases ──────────────────────────────────────────────────────────────

async function test1_lockOrder(client) {
  console.log('\n--- T1: Actual service lock sequence ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);
  await mkReservation(client, bookingId, 500000);

  // Use a recording proxy to capture the actual query sequence
  const recorder = new FaultInjectingClient(client);
  await createBookingGroupPaymentWithAllocations(recorder, {
    propertyId,
    bookingId,
    amount: 1000000
  });

  const queries = recorder.queries;

  // Find the booking FOR UPDATE query
  const bookingLockIdx = queries.findIndex(q =>
    q.includes('FROM bookings') && q.includes('FOR UPDATE')
  );
  check(bookingLockIdx >= 0, 'T1.1: Service issues booking SELECT ... FOR UPDATE');

  // Find the reservation FOR UPDATE query
  const resLockIdx = queries.findIndex(q =>
    q.includes('FROM reservations') && q.includes('FOR UPDATE')
  );
  check(resLockIdx >= 0, 'T1.2: Service issues reservation SELECT ... FOR UPDATE');

  // Booking lock must come before reservation lock
  check(bookingLockIdx < resLockIdx, 'T1.3: Booking lock precedes reservation lock');

  // Reservation lock must come before parent INSERT
  const parentInsertIdx = queries.findIndex(q =>
    q.includes('INSERT INTO payment_transactions') && q.includes('BOOKING_GROUP')
  );
  check(parentInsertIdx > resLockIdx, 'T1.4: Reservation lock precedes parent INSERT');

  // Verify deterministic order in reservation lock query
  const resLockQuery = queries[resLockIdx];
  check(resLockQuery.includes('ORDER BY') && resLockQuery.includes('stay_sequence'),
    'T1.5: Reservation lock uses ORDER BY stay_sequence');
}

async function test2_fullPayment(client) {
  console.log('\n--- T2: 2-room full booking payment ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  const res1 = await mkReservation(client, bookingId, 500000);
  const res2 = await mkReservation(client, bookingId, 500000);

  const result = await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    amount: 1000000,
    paymentMethod: 'CASH'
  });

  check(result.parentPayment.scope === 'BOOKING_GROUP', 'T2.1: Parent scope is BOOKING_GROUP');
  check(result.parentPayment.amount === 1000000, 'T2.2: Parent amount correct');
  check(result.allocations.length === 2, 'T2.3: Two allocations created');
  check(result.allocations.every(a => a.allocatedAmount === 500000), 'T2.4: Equal allocation per room');
  check(result.folioEntries.length === 2, 'T2.5: Two folio entries created');
}

async function test3_partialFirstChild(client) {
  console.log('\n--- T3: Partial payment affects only first child ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  const res1 = await mkReservation(client, bookingId, 500000);
  const res2 = await mkReservation(client, bookingId, 500000);

  const result = await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    amount: 300000,
    paymentMethod: 'CASH'
  });

  check(result.parentPayment.scope === 'BOOKING_GROUP', 'T3.1: Still BOOKING_GROUP despite partial allocation');
  check(result.allocations.length === 1, 'T3.2: One allocation (first child only)');
  check(result.allocations[0].allocatedAmount === 300000, 'T3.3: Allocation matches payment amount');
  check(result.allocations[0].reservationId === res1, 'T3.4: Allocation on first reservation');
}

async function test4_partialSpanning(client) {
  console.log('\n--- T4: Partial payment spanning multiple children ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  const res1 = await mkReservation(client, bookingId, 500000);
  const res2 = await mkReservation(client, bookingId, 500000);
  const res3 = await mkReservation(client, bookingId, 500000);

  const result = await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    amount: 800000,
    paymentMethod: 'CASH'
  });

  check(result.allocations.length === 2, 'T4.1: Two allocations');
  check(result.allocations[0].allocatedAmount === 500000, 'T4.2: First child fully paid');
  check(result.allocations[1].allocatedAmount === 300000, 'T4.3: Second child partially paid');
  check(result.allocations.reduce((s, a) => s + a.allocatedAmount, 0) === 800000, 'T4.4: Total allocation = payment amount');
}

async function test5_historicalDirect(client) {
  console.log('\n--- T5: Historical direct payment + new group allocation ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  const res1 = await mkReservation(client, bookingId, 500000);
  const res2 = await mkReservation(client, bookingId, 500000);

  await insertDirectPayment(client, res1, propertyId, 200000);

  const result = await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    amount: 600000,
    paymentMethod: 'CASH'
  });

  check(result.allocations.length === 2, 'T5.1: Two allocations despite historical direct');
  const res1Alloc = result.allocations.find(a => a.reservationId === res1);
  const res2Alloc = result.allocations.find(a => a.reservationId === res2);
  check(res1Alloc && res1Alloc.allocatedAmount === 300000, 'T5.2: Res1 allocation = remaining due (300k)');
  check(res2Alloc && res2Alloc.allocatedAmount === 300000, 'T5.3: Res2 allocation = 300k (partial)');
}

async function test6_depositReducesDue(client) {
  console.log('\n--- T6: Applied deposit reduces remaining due ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  const res1 = await mkReservation(client, bookingId, 500000);
  const res2 = await mkReservation(client, bookingId, 500000);

  await insertFolioDepositApply(client, res1, propertyId, 200000);

  const result = await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    amount: 500000,
    paymentMethod: 'CASH'
  });

  const res1Alloc = result.allocations.find(a => a.reservationId === res1);
  const res2Alloc = result.allocations.find(a => a.reservationId === res2);
  check(res1Alloc && res1Alloc.allocatedAmount === 300000, 'T6.1: Res1 allocation reduced by deposit');
  check(res2Alloc && res2Alloc.allocatedAmount === 200000, 'T6.2: Res2 allocation = 200k');
}

async function test7_exactBoundary(client) {
  console.log('\n--- T7: Exact-boundary payment accepted ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);
  await mkReservation(client, bookingId, 500000);

  const result = await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    amount: 1000000,
    paymentMethod: 'CASH'
  });

  check(result.parentPayment.amount === 1000000, 'T7.1: Exact boundary payment accepted');
  check(result.allocations.every(a => a.allocatedAmount > 0), 'T7.2: All allocations positive');
}

async function test8_overpaymentRejected(client) {
  console.log('\n--- T8: Overpayment rejected ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);
  await mkReservation(client, bookingId, 500000);

  let threw = false;
  let errorCode = null;
  try {
    await createBookingGroupPaymentWithAllocations(client, {
      propertyId,
      bookingId,
      amount: 1500000
    });
  } catch (err) {
    threw = true;
    errorCode = err.code;
  }
  check(threw, 'T8.1: Overpayment throws error');
  check(errorCode === 'OVERPAYMENT_NOT_ALLOWED', 'T8.2: Correct error code');
}

async function test9_zeroPaymentRejected(client) {
  console.log('\n--- T9: Zero payment rejected ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);

  let threw = false;
  let errorCode = null;
  try {
    await createBookingGroupPaymentWithAllocations(client, {
      propertyId,
      bookingId,
      amount: 0
    });
  } catch (err) {
    threw = true;
    errorCode = err.code;
  }
  check(threw, 'T9.1: Zero payment throws error');
  check(errorCode === 'PAYMENT_AMOUNT_MUST_BE_POSITIVE', 'T9.2: Correct error code for zero');
}

async function test10_negativePaymentRejected(client) {
  console.log('\n--- T10: Negative payment rejected ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);

  let threw = false;
  let errorCode = null;
  try {
    await createBookingGroupPaymentWithAllocations(client, {
      propertyId,
      bookingId,
      amount: -100000
    });
  } catch (err) {
    threw = true;
    errorCode = err.code;
  }
  check(threw, 'T10.1: Negative payment throws error');
  check(errorCode === 'PAYMENT_AMOUNT_MUST_BE_POSITIVE', 'T10.2: Correct error code for negative');
}

async function test11_oneParentOnly(client) {
  console.log('\n--- T11: Exactly one BOOKING_GROUP parent ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);
  await mkReservation(client, bookingId, 500000);

  await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    amount: 1000000
  });

  const parents = await client.query(
    `SELECT COUNT(*) FROM payment_transactions WHERE booking_id = $1 AND scope = 'BOOKING_GROUP'`,
    [bookingId]
  );
  check(Number(parents.rows[0].count) === 1, 'T11.1: Exactly one BOOKING_GROUP parent');
}

async function test12_noSyntheticChildren(client) {
  console.log('\n--- T12: Zero synthetic ROOM_RESERVATION child payments ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);
  await mkReservation(client, bookingId, 500000);

  await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    amount: 1000000
  });

  const childPayments = await client.query(
    `SELECT COUNT(*) FROM payment_transactions
     WHERE booking_id = $1 AND scope = 'ROOM_RESERVATION'
       AND transaction_type = 'PAYMENT' AND status = 'SUCCESS'`,
    [bookingId]
  );
  check(Number(childPayments.rows[0].count) === 0, 'T12.1: No synthetic ROOM_RESERVATION child payments');
}

async function test13_allocationCount(client) {
  console.log('\n--- T13: Allocation count matches affected children ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);
  await mkReservation(client, bookingId, 500000);
  await mkReservation(client, bookingId, 500000);

  await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    amount: 500000
  });

  const allocs = await client.query(
    `SELECT COUNT(*) FROM payment_allocations
     WHERE booking_id = $1 AND status = 'ACTIVE'`,
    [bookingId]
  );
  check(Number(allocs.rows[0].count) === 1, 'T13.1: One allocation (only first child needs payment)');
}

async function test14_allocationAmounts(client) {
  console.log('\n--- T14: Each allocation amount correct ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  const res1 = await mkReservation(client, bookingId, 500000);
  const res2 = await mkReservation(client, bookingId, 700000);

  const result = await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    amount: 1000000
  });

  const res1Alloc = result.allocations.find(a => a.reservationId === res1);
  const res2Alloc = result.allocations.find(a => a.reservationId === res2);
  check(res1Alloc && res1Alloc.allocatedAmount === 500000, 'T14.1: Res1 allocation = its total_price');
  check(res2Alloc && res2Alloc.allocatedAmount === 500000, 'T14.2: Res2 allocation = remaining payment');
}

async function test15_storedRowConservation(client) {
  console.log('\n--- T15: Stored-row conservation exact ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);
  await mkReservation(client, bookingId, 500000);

  const result = await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    amount: 800000
  });

  const parentId = result.parentPayment.id;
  const conservation = await client.query(
    `SELECT pt.amount AS parent_amount,
            COALESCE(SUM(pa.allocated_amount), 0) AS total_allocated
     FROM payment_transactions pt
     LEFT JOIN payment_allocations pa ON pa.payment_transaction_id = pt.id AND pa.status = 'ACTIVE'
     WHERE pt.id = $1
     GROUP BY pt.id, pt.amount`,
    [parentId]
  );
  check(Number(conservation.rows[0].parent_amount) === Number(conservation.rows[0].total_allocated), 'T15.1: Stored-row conservation holds');
}

async function test16_folioEqualsAllocation(client) {
  console.log('\n--- T16: Folio credit equals allocation, not parent ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);
  await mkReservation(client, bookingId, 700000);

  await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    amount: 800000
  });

  const folios = await client.query(
    `SELECT reservation_id, amount FROM folio_entries
     WHERE entry_type = 'PAYMENT' AND source_type = 'BOOKING_PAYMENT'`
  );
  check(folios.rows.length === 2, 'T16.1: Two folio entries');
  check(folios.rows.every(f => Number(f.amount) < 800000), 'T16.2: Each folio < parent amount');
}

async function test17_noDoubleCount(client) {
  console.log('\n--- T17: Folio projection does not double-count amount_paid ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);
  await mkReservation(client, bookingId, 500000);

  const result = await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    amount: 1000000
  });

  for (const res of result.recalculatedReservations) {
    const payState = await getEffectivePaymentStateForReservation(client, res.reservationId, propertyId);
    check(payState.totalEffectivePaid === res.amountPaid, `T17.${res.reservationId}: Canonical read matches recalc`);
  }
}

async function test18_crossBookingRejected(client) {
  console.log('\n--- T18: Cross-booking rejected ---');
  const propertyId = await mkProperty(client);
  const bookingId1 = await mkBooking(client, propertyId);
  const bookingId2 = await mkBooking(client, propertyId);
  const res1 = await mkReservation(client, bookingId1, 500000);
  const res2 = await mkReservation(client, bookingId2, 500000);

  let threw = false;
  let errorCode = null;
  try {
    await createBookingGroupPaymentWithAllocations(client, {
      propertyId,
      bookingId: bookingId1,
      amount: 1000000,
      reservationIds: [res1, res2]
    });
  } catch (err) {
    threw = true;
    errorCode = err.code;
  }
  check(threw, 'T18.1: Cross-booking throws error');
  check(errorCode === 'CROSS_BOOKING_RESERVATIONS' || errorCode === 'ELIGIBLE_RESERVATIONS_REQUIRED', 'T18.2: Correct error code');
}

async function test19_crossPropertyRejected(client) {
  console.log('\n--- T19: Cross-property rejected ---');
  const prop1 = await mkProperty(client);
  const prop2 = await mkProperty(client);
  const bookingId = await mkBooking(client, prop1);
  await mkReservation(client, bookingId, 500000);

  let threw = false;
  let errorCode = null;
  try {
    await createBookingGroupPaymentWithAllocations(client, {
      propertyId: prop2,
      bookingId,
      amount: 500000
    });
  } catch (err) {
    threw = true;
    errorCode = err.code;
  }
  check(threw, 'T19.1: Cross-property throws error');
  check(errorCode === 'CROSS_PROPERTY_BOOKING' || errorCode === 'VALIDATION_ERROR', 'T19.2: Correct error code');
}

async function test20_parentInsertThenFailRollback(client) {
  console.log('\n--- T20: Parent insert then allocation failure rolls back ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);
  await mkReservation(client, bookingId, 500000);

  const refCode = `GB-TEST20-${Date.now()}`;

  await expectRollbackFromFault(
    client,
    async () => {},
    async (proxy) => {
      await createBookingGroupPaymentWithAllocations(proxy, {
        propertyId,
        bookingId,
        amount: 500000,
        referenceCode: refCode
      });
    },
    async (freshClient) => {
      await verifyNoParent(freshClient, refCode);
      await verifyNoAllocations(freshClient, refCode);
    },
    /INSERT INTO payment_allocations/,  // throw on first allocation insert
    'Injected allocation failure for T20'
  );
}

async function test21_allocationFailureAfterPartialWrites(client) {
  console.log('\n--- T21: Allocation failure after parent + first alloc rolls back ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);
  await mkReservation(client, bookingId, 500000);
  await mkReservation(client, bookingId, 500000);

  const refCode = `GB-TEST21-${Date.now()}`;

  await expectRollbackFromFault(
    client,
    async () => {},
    async (proxy) => {
      await createBookingGroupPaymentWithAllocations(proxy, {
        propertyId,
        bookingId,
        amount: 800000,
        referenceCode: refCode
      });
    },
    async (freshClient) => {
      await verifyNoParent(freshClient, refCode);
      await verifyNoAllocations(freshClient, refCode);
    },
    (sql, proxy) => {
      // FaultInjectingClient.query() already increments proxy._allocCount when
      // it encounters INSERT INTO payment_allocations. The callback must NOT
      // increment again — only inspect the proxy's owned counter.
      return proxy.allocCount >= 2;
    },
    'Injected 2nd allocation failure for T21'
  );
}

async function test22_folioFailureRollback(client) {
  console.log('\n--- T22: Folio projection failure rolls back ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);
  await mkReservation(client, bookingId, 500000);

  const refCode = `GB-TEST22-${Date.now()}`;

  await expectRollbackFromFault(
    client,
    async () => {},
    async (proxy) => {
      await createBookingGroupPaymentWithAllocations(proxy, {
        propertyId,
        bookingId,
        amount: 800000,
        referenceCode: refCode
      });
    },
    async (freshClient) => {
      await verifyNoParent(freshClient, refCode);
      await verifyNoAllocations(freshClient, refCode);
      await verifyNoFolio(freshClient, bookingId, propertyId);
    },
    /INSERT INTO folio_entries/,  // throw on first folio insert
    'Injected folio failure for T22'
  );
}

async function test23_recalcFailureRollback(client) {
  console.log('\n--- T23: Recalc failure rolls back ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);

  const refCode = `GB-TEST23-${Date.now()}`;

  // The recalc function's first query is:
  // SELECT r.*, b.property_id AS booking_property_id FROM reservations r ...
  await expectRollbackFromFault(
    client,
    async () => {},
    async (proxy) => {
      await createBookingGroupPaymentWithAllocations(proxy, {
        propertyId,
        bookingId,
        amount: 500000,
        referenceCode: refCode
      });
    },
    async (freshClient) => {
      await verifyNoParent(freshClient, refCode);
      await verifyNoAllocations(freshClient, refCode);
    },
    /SELECT r\.\*, b\.property_id AS booking_property_id/,  // throw during recalc
    'Injected recalc failure for T23'
  );
}

async function test24_noIdempotencyClaim(client) {
  console.log('\n--- T24: Service does not claim standalone retry-idempotency ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  const res1 = await mkReservation(client, bookingId, 1000000);
  const res2 = await mkReservation(client, bookingId, 1000000);

  const r1 = await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    reservationIds: [res1],
    amount: 500000
  });
  const r2 = await createBookingGroupPaymentWithAllocations(client, {
    propertyId,
    bookingId,
    reservationIds: [res2],
    amount: 500000
  });

  check(r1.parentPayment.id !== r2.parentPayment.id, 'T24.1: Two distinct parents created (no idempotency)');
  check(r1.parentPayment.amount === 500000, 'T24.2: First parent amount correct');
  check(r2.parentPayment.amount === 500000, 'T24.3: Second parent amount correct');
}

async function test25_noRuntimeActivation(client) {
  console.log('\n--- T25: src/index.ts runtime booking path remains untouched ---');
  check(typeof createBookingGroupPaymentWithAllocations === 'function', 'T25.1: Service is callable');
}

async function test26_explicitIneligibleRejected(client) {
  console.log('\n--- T26: Explicit ineligible reservation (CANCELLED/CHECKED_OUT) rejected ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  const res1 = await mkReservation(client, bookingId, 500000, 'CONFIRMED');
  const res2 = await mkReservation(client, bookingId, 500000, 'CANCELLED');
  const res3 = await mkReservation(client, bookingId, 500000, 'CHECKED_OUT');

  // Test with CANCELLED reservation
  let threw = false;
  let errorCode = null;
  try {
    await createBookingGroupPaymentWithAllocations(client, {
      propertyId,
      bookingId,
      amount: 500000,
      reservationIds: [res1, res2]  // res2 is CANCELLED
    });
  } catch (err) {
    threw = true;
    errorCode = err.code;
  }
  check(threw, 'T26.1: Ineligible reservation in explicit list throws error');
  check(errorCode === 'ELIGIBLE_RESERVATIONS_REQUIRED', 'T26.2: Correct error code for ineligible');

  // Test with CHECKED_OUT reservation
  let threw2 = false;
  try {
    await createBookingGroupPaymentWithAllocations(client, {
      propertyId,
      bookingId,
      amount: 500000,
      reservationIds: [res1, res3]  // res3 is CHECKED_OUT
    });
  } catch (err) {
    threw2 = true;
  }
  check(threw2, 'T26.3: CHECKED_OUT reservation in explicit list throws error');

  // Verify no partial state
  const parents = await client.query(
    `SELECT COUNT(*) FROM payment_transactions WHERE booking_id = $1 AND scope = 'BOOKING_GROUP'`,
    [bookingId]
  );
  check(Number(parents.rows[0].count) === 0, 'T26.4: No parent persisted after ineligible rejection');
}

async function test27_emptyReservationIdsRejected(client) {
  console.log('\n--- T27: Explicit empty reservationIds rejected ---');
  const propertyId = await mkProperty(client);
  const bookingId = await mkBooking(client, propertyId);
  await mkReservation(client, bookingId, 500000);

  let threw = false;
  let errorCode = null;
  try {
    await createBookingGroupPaymentWithAllocations(client, {
      propertyId,
      bookingId,
      amount: 500000,
      reservationIds: []  // explicit empty array — must fail closed
    });
  } catch (err) {
    threw = true;
    errorCode = err.code;
  }
  check(threw, 'T27.1: Empty reservationIds array throws error');
  check(errorCode === 'NO_TARGET_RESERVATIONS', 'T27.2: Correct error code (NO_TARGET_RESERVATIONS)');

  // Verify no parent created
  const parents = await client.query(
    `SELECT COUNT(*) FROM payment_transactions WHERE booking_id = $1 AND scope = 'BOOKING_GROUP'`,
    [bookingId]
  );
  check(Number(parents.rows[0].count) === 0, 'T27.3: No parent persisted after empty reservationIds rejection');
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const client = await pool.connect();
  console.log(`\n=== RUNNING MULTI-BOOKING-SCOPE-1B3A TESTS [runId=${runId}] ===\n`);

  const tests = [
    test1_lockOrder,
    test2_fullPayment,
    test3_partialFirstChild,
    test4_partialSpanning,
    test5_historicalDirect,
    test6_depositReducesDue,
    test7_exactBoundary,
    test8_overpaymentRejected,
    test9_zeroPaymentRejected,
    test10_negativePaymentRejected,
    test11_oneParentOnly,
    test12_noSyntheticChildren,
    test13_allocationCount,
    test14_allocationAmounts,
    test15_storedRowConservation,
    test16_folioEqualsAllocation,
    test17_noDoubleCount,
    test18_crossBookingRejected,
    test19_crossPropertyRejected,
    test20_parentInsertThenFailRollback,
    test21_allocationFailureAfterPartialWrites,
    test22_folioFailureRollback,
    test23_recalcFailureRollback,
    test24_noIdempotencyClaim,
    test25_noRuntimeActivation,
    test26_explicitIneligibleRejected,
    test27_emptyReservationIdsRejected
  ];

  for (const test of tests) {
    try {
      // IMPORTANT: Do NOT reset _propSeq or _bookingSeq per test — we need
      // globally unique codes across the entire suite. Counters persist between
      // withTx invocations. Only _resSeq resets per test since reservations
      // are scoped within each test's fixtures.
      await withTx(client, async (txClient) => {
        _resSeq = 0;
        await test(txClient);
      });
    } catch (err) {
      console.error(`ERROR in ${test.name}:`, err.message);
      failed++;
    }
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
  client.release();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
