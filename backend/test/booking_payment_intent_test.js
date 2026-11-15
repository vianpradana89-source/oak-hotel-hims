// booking_payment_intent_test.js
// DB-free test for bookingPaymentIntentService (Phase 2B-1 unit 1).
// Calls the production helper directly — no mocks, no Pool, no HTTP.
const assert = require('node:assert');
const { normalizeBookingPaymentIntent } = require('../dist/domains/reservations/bookingPaymentIntentService');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS: ${name}`); }
  catch (e) { failed += 1; console.error(`FAIL: ${name}\n  ${e.message}`); }
}

function throwsCode(payload, code) {
  assert.throws(() => normalizeBookingPaymentIntent(payload),
    (e) => e.code === code && e.statusCode === 400,
    `expected code=${code} got=${(err=>err.code)(new Error())}`);
}

async function main() {
  // ═══════════ LEGACY ═══════════
  await test('L1: no payment_mode + amount_paid=500000 → LEGACY, ordinary=500000', () => {
    const r = normalizeBookingPaymentIntent({ amount_paid: 500000, payment_method: 'CASH', bukti_bayar_path: '/e/b.jpg' });
    assert.strictEqual(r.mode, 'LEGACY');
    assert.strictEqual(r.legacy, true);
    assert.strictEqual(r.ordinaryAmount, 500000);
    assert.strictEqual(r.advanceAmount, 0);
    assert.strictEqual(r.paymentMethod, 'CASH');
    assert.strictEqual(r.evidencePath, '/e/b.jpg');
  });

  await test('L2: empty/null payload → LEGACY zeros', () => {
    assert.strictEqual(normalizeBookingPaymentIntent(null).legacy, true);
    assert.strictEqual(normalizeBookingPaymentIntent(undefined).mode, 'LEGACY');
  });

  await test('L3: legacy with initial_payment.amount (no amount_paid) → ordinary from alias', () => {
    const r = normalizeBookingPaymentIntent({ initial_payment: { amount: 250000, payment_method: 'CASH' } });
    assert.strictEqual(r.mode, 'LEGACY');
    assert.strictEqual(r.ordinaryAmount, 250000);
  });

  await test('L4: legacy amount_paid=300000 wins over initial_payment.amount=250000 (no 400 in legacy)', () => {
    const r = normalizeBookingPaymentIntent({ amount_paid: 300000, initial_payment: { amount: 250000 } });
    assert.strictEqual(r.mode, 'LEGACY');
    assert.strictEqual(r.ordinaryAmount, 300000); // no double-count: amount_paid wins
  });

  // ═══════════ PAY_BILL ═══════════
  await test('P1: PAY_BILL amount_paid=300000 → ordinary=300000, advance=0', () => {
    const r = normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', amount_paid: 300000, payment_method: 'CASH' });
    assert.strictEqual(r.mode, 'PAY_BILL');
    assert.strictEqual(r.ordinaryAmount, 300000);
    assert.strictEqual(r.advanceAmount, 0);
    assert.strictEqual(r.legacy, false);
  });

  await test('P2: PAY_BILL numeric-string "500000" parsed to 500000', () => {
    const r = normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', amount_paid: '500000' });
    assert.strictEqual(r.ordinaryAmount, 500000);
  });

  await test('P3: PAY_BILL amount_paid + initial_payment same value → no 400, ordinary from amount_paid', () => {
    const r = normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', amount_paid: 100, initial_payment: { amount: 100 } });
    assert.strictEqual(r.ordinaryAmount, 100);
  });

  await test('P4: PAY_BILL amount_paid=200 vs initial_payment.amount=300 → AMBIGUOUS_ORDINARY_AMOUNT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', amount_paid: 200, initial_payment: { amount: 300 } }),
      (e) => e.code === 'AMBIGUOUS_ORDINARY_AMOUNT'
    );
  });

  await test('P5: PAY_BILL with advance_amount=50000 → ADVANCE_IN_PAY_BILL 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', amount_paid: 100, advance_amount: 50000 }),
      (e) => e.code === 'ADVANCE_IN_PAY_BILL'
    );
  });

  await test('P6: PAY_BILL amount_paid negative → INVALID_AMOUNT_FORMAT 400 (no silent fallback)', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', amount_paid: -100 }),
      (e) => e.code === 'INVALID_AMOUNT_FORMAT'
    );
  });

  await test('P7: PAY_BILL amount_paid=Infinity → INVALID_AMOUNT_FORMAT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', amount_paid: Infinity }),
      (e) => e.code === 'INVALID_AMOUNT_FORMAT'
    );
  });

  await test('P8: PAY_BILL amount_paid=true (boolean) → INVALID_AMOUNT_FORMAT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', amount_paid: true }),
      (e) => e.code === 'INVALID_AMOUNT_FORMAT'
    );
  });

  await test('P9: PAY_BILL amount_paid=[1,2] (array) → INVALID_AMOUNT_FORMAT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', amount_paid: [1, 2] }),
      (e) => e.code === 'INVALID_AMOUNT_FORMAT'
    );
  });

  await test('P10: PAY_BILL child amount_paid negative → INVALID_AMOUNT_FORMAT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'PAY_BILL', amount_paid: 0,
        reservations: [{ amount_paid: -5 }]
      }),
      (e) => e.code === 'INVALID_AMOUNT_FORMAT'
    );
  });

  await test('P11: PAY_BILL initial_payment malformed (string) → INVALID_INITIAL_PAYMENT_FORMAT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', initial_payment: 'oops' }),
      (e) => e.code === 'INVALID_INITIAL_PAYMENT_FORMAT'
    );
  });

  await test('P12: PAY_BILL reservations not array → INVALID_RESERVATIONS_FORMAT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', reservations: { foo: 1 } }),
      (e) => e.code === 'INVALID_RESERVATIONS_FORMAT'
    );
  });

  await test('P13: PAY_BILL reservations[0] not object → INVALID_RESERVATIONS_FORMAT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', reservations: ['x'] }),
      (e) => e.code === 'INVALID_RESERVATIONS_FORMAT'
    );
  });

  // ═══════════ ADVANCE_PAYMENT ═══════════
  await test('A1: ADVANCE advance_amount=200000 → ordinary=0, advance=200000', () => {
    const r = normalizeBookingPaymentIntent({ payment_mode: 'ADVANCE_PAYMENT', advance_amount: 200000, payment_method: 'CASH' });
    assert.strictEqual(r.mode, 'ADVANCE_PAYMENT');
    assert.strictEqual(r.ordinaryAmount, 0);
    assert.strictEqual(r.advanceAmount, 200000);
    assert.strictEqual(r.legacy, false);
  });

  await test('A2: ADVANCE advance_amount="100000" (numeric string) accepted', () => {
    const r = normalizeBookingPaymentIntent({ payment_mode: 'ADVANCE_PAYMENT', advance_amount: '100000' });
    assert.strictEqual(r.advanceAmount, 100000);
  });

  await test('A3: ADVANCE advance_amount=0 → ADVANCE_AMOUNT_REQUIRED 400 (0 = DP inactive, not positive)', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'ADVANCE_PAYMENT', advance_amount: 0 }),
      (e) => e.code === 'ADVANCE_AMOUNT_REQUIRED'
    );
  });

  await test('A4: ADVANCE advance_amount missing → ADVANCE_AMOUNT_REQUIRED 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'ADVANCE_PAYMENT', payment_method: 'CASH' }),
      (e) => e.code === 'ADVANCE_AMOUNT_REQUIRED'
    );
  });

  await test('A5: ADVANCE advance_amount=9007199254740993 (unsafe int) → INVALID_ADVANCE_AMOUNT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'ADVANCE_PAYMENT', advance_amount: 9007199254740993 }),
      (e) => e.code === 'INVALID_ADVANCE_AMOUNT'
    );
  });

  await test('A6: ADVANCE advance_amount=-100 → INVALID_ADVANCE_AMOUNT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'ADVANCE_PAYMENT', advance_amount: -100 }),
      (e) => e.code === 'INVALID_ADVANCE_AMOUNT'
    );
  });

  await test('A7: ADVANCE advance_amount=true → INVALID_ADVANCE_AMOUNT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'ADVANCE_PAYMENT', advance_amount: true }),
      (e) => e.code === 'INVALID_ADVANCE_AMOUNT'
    );
  });

  await test('A8: ADVANCE with amount_paid=50000 → ORDINARY_AND_ADVANCE_CONFLICT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'ADVANCE_PAYMENT', advance_amount: 100, amount_paid: 50000 }),
      (e) => e.code === 'ORDINARY_AND_ADVANCE_CONFLICT'
    );
  });

  await test('A9: ADVANCE with child amount_paid=200 → ORDINARY_AND_ADVANCE_CONFLICT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'ADVANCE_PAYMENT', advance_amount: 100,
        reservations: [{ amount_paid: 200 }]
      }),
      (e) => e.code === 'ORDINARY_AND_ADVANCE_CONFLICT'
    );
  });

  // ═══════════ UNPAID ═══════════
  await test('U1: UNPAID no inputs → all zeros, legacy=false', () => {
    const r = normalizeBookingPaymentIntent({ payment_mode: 'UNPAID' });
    assert.strictEqual(r.mode, 'UNPAID');
    assert.strictEqual(r.ordinaryAmount, 0);
    assert.strictEqual(r.advanceAmount, 0);
    assert.strictEqual(r.legacy, false);
  });

  await test('U2: UNPAID with amount_paid=100 → UNPAID_CONFLICTS_WITH_PAYMENT_INPUT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'UNPAID', amount_paid: 100 }),
      (e) => e.code === 'UNPAID_CONFLICTS_WITH_PAYMENT_INPUT'
    );
  });

  await test('U3: UNPAID with advance_amount=100 → UNPAID_CONFLICTS_WITH_PAYMENT_INPUT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'UNPAID', advance_amount: 100 }),
      (e) => e.code === 'UNPAID_CONFLICTS_WITH_PAYMENT_INPUT'
    );
  });

  await test('U4: UNPAID with child amount_paid=50 → UNPAID_CONFLICTS_WITH_PAYMENT_INPUT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'UNPAID', reservations: [{ amount_paid: 50 }] }),
      (e) => e.code === 'UNPAID_CONFLICTS_WITH_PAYMENT_INPUT'
    );
  });

  await test('U5: UNPAID with bukti_bayar_path populated → UNPAID_CONFLICTS_WITH_PAYMENT_INPUT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'UNPAID', bukti_bayar_path: '/e/x.jpg' }),
      (e) => e.code === 'UNPAID_CONFLICTS_WITH_PAYMENT_INPUT'
    );
  });

  await test('U6: UNPAID with initial_payment.amount=200 → UNPAID_CONFLICTS_WITH_PAYMENT_INPUT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'UNPAID', initial_payment: { amount: 200 } }),
      (e) => e.code === 'UNPAID_CONFLICTS_WITH_PAYMENT_INPUT'
    );
  });

  // ═══════════ Unknown mode ═══════════
  await test('X1: unknown payment_mode → UNKNOWN_PAYMENT_MODE 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'CREDIT_CARD_INSTALLMENT', amount_paid: 0 }),
      (e) => e.code === 'UNKNOWN_PAYMENT_MODE' && e.statusCode === 400
    );
  });

  // ═══════════ Reviewer reproduction table (BU-R1-01) ═══════════

  // Row 1: unsafe ordinary amount must be rejected before money/FP is used
  await test('R1: PAY_BILL amount_paid=9007199254740992 (unsafe) → INVALID_AMOUNT_FORMAT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', amount_paid: 9007199254740992 }),
      (e) => e.code === 'INVALID_AMOUNT_FORMAT' && e.statusCode === 400
    );
  });

  // Row 2: LEGACY amount_paid=-1 must NOT add new rejection; original ordinary
  // allocation uses max(0, roundIdr), existing final validation remains authoritative.
  await test('R2: LEGACY amount_paid=-1 → accepted as legacy (ordinary=0), no 400 from helper', () => {
    const r = normalizeBookingPaymentIntent({ amount_paid: -1 });
    assert.strictEqual(r.mode, 'LEGACY');
    assert.strictEqual(r.legacy, true);
    // Tolerant legacy path: negative raw → 0 (original existing behaviour preserved)
    assert.strictEqual(r.ordinaryAmount, 0);
  });

  // Row 3: UNPAID advance_amount=0 must be equivalent to no DP (inactive), not 400
  await test('R3: UNPAID advance_amount=0 → treated as DP inactive, all zeros', () => {
    const r = normalizeBookingPaymentIntent({ payment_mode: 'UNPAID', advance_amount: 0 });
    assert.strictEqual(r.mode, 'UNPAID');
    assert.strictEqual(r.ordinaryAmount, 0);
    assert.strictEqual(r.advanceAmount, 0);
  });

  // Row 4: ADVANCE advance_amount=100 with amount_paid=0.1 (rounds to 0)
  // must NOT silently lose the positive raw ordinary value.
  await test('R4: ADVANCE advance_amount=100 + amount_paid=0.1 → ORDINARY_AND_ADVANCE_CONFLICT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'ADVANCE_PAYMENT', advance_amount: 100, amount_paid: 0.1
      }),
      (e) => e.code === 'ORDINARY_AND_ADVANCE_CONFLICT'
    );
  });

  // Row 5: PAY_BILL booking amount=100 + child amount=50 → conflict 400
  await test('R5: PAY_BILL amount_paid=100 + reservations[0].amount_paid=50 → AMBIGUOUS_ORDINARY_AMOUNT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'PAY_BILL', amount_paid: 100,
        reservations: [{ amount_paid: 50 }]
      }),
      (e) => e.code === 'AMBIGUOUS_ORDINARY_AMOUNT'
    );
  });

  // Row 5b: child-only without booking amount ��� unsupported, 400
  await test('R5b: PAY_BILL amount_paid=0 + child amount=100 → UNSUPPORTED_CHILD_ONLY_PAYMENT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'PAY_BILL', amount_paid: 0,
        reservations: [{ amount_paid: 100 }]
      }),
      (e) => e.code === 'UNSUPPORTED_CHILD_ONLY_PAYMENT'
    );
  });

  // Row 6: UNPAID with initial_payment.evidence alias must be rejected
  await test('R6: UNPAID initial_payment.payment_evidence_path set → UNPAID_CONFLICTS_WITH_PAYMENT_INPUT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'UNPAID',
        initial_payment: { amount: 0, payment_evidence_path: '/proof.jpg' }
      }),
      (e) => e.code === 'UNPAID_CONFLICTS_WITH_PAYMENT_INPUT'
    );
  });

  // Row 7: PAY_BILL initial_payment.method/evidence aliases must be resolved
  await test('R7: PAY_BILL initial_payment {amount,method,evidence} → method+evidence resolved', () => {
    const r = normalizeBookingPaymentIntent({
      payment_mode: 'PAY_BILL',
      initial_payment: { amount: 100, payment_method: 'CASH', payment_evidence_path: '/proof.jpg' }
    });
    assert.strictEqual(r.ordinaryAmount, 100);
    assert.strictEqual(r.paymentMethod, 'CASH');
    assert.strictEqual(r.evidencePath, '/proof.jpg');
  });

  // UNPAID advance_amount missing/null/blank → DP inactive, all zeros
  await test('R8: UNPAID advance_amount missing → all zeros, legacy=false', () => {
    const r = normalizeBookingPaymentIntent({ payment_mode: 'UNPAID', advance_amount: undefined });
    assert.strictEqual(r.advanceAmount, 0);
    assert.strictEqual(r.ordinaryAmount, 0);
  });

  // UNPAID advance_amount=null → DP inactive
  await test('R9: UNPAID advance_amount=null → all zeros', () => {
    const r = normalizeBookingPaymentIntent({ payment_mode: 'UNPAID', advance_amount: null });
    assert.strictEqual(r.advanceAmount, 0);
  });

  // UNPAID advance_amount='' (blank) → DP inactive
  await test('R10: UNPAID advance_amount="" (blank) → all zeros', () => {
    const r = normalizeBookingPaymentIntent({ payment_mode: 'UNPAID', advance_amount: '' });
    assert.strictEqual(r.advanceAmount, 0);
  });

  // UNPAID positive advance_amount must still conflict
  await test('R11: UNPAID advance_amount=100 → UNPAID_CONFLICTS_WITH_PAYMENT_INPUT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({ payment_mode: 'UNPAID', advance_amount: 100 }),
      (e) => e.code === 'UNPAID_CONFLICTS_WITH_PAYMENT_INPUT'
    );
  });

  // ADVANCE amount_paid=0.1 raw positive that rounds to 0 must conflict
  await test('R12: ADVANCE amount_paid=0.1 (raw positive rounds to 0) → ORDINARY_AND_ADVANCE_CONFLICT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'ADVANCE_PAYMENT', advance_amount: 500, amount_paid: 0.1
      }),
      (e) => e.code === 'ORDINARY_AND_ADVANCE_CONFLICT'
    );
  });

  // Unsafe child total must be rejected
  await test('R13: PAY_BILL child amount_paid=9007199254740992 (unsafe) → INVALID_AMOUNT_FORMAT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'PAY_BILL', amount_paid: 0,
        reservations: [{ amount_paid: 9007199254740992 }]
      }),
      (e) => e.code === 'INVALID_AMOUNT_FORMAT'
    );
  });

  // Blank/null evidence aliases are not receipt evidence
  await test('R14: PAY_BILL with evidence aliases blank/null → evidencePath=null (no 400)', () => {
    const r = normalizeBookingPaymentIntent({
      payment_mode: 'PAY_BILL', amount_paid: 100,
      bukti_bayar_path: '',
      initial_payment: { amount: 100, payment_evidence_path: null }
    });
    assert.strictEqual(r.evidencePath, null);
  });

  // Conflicting nonblank evidence aliases must be rejected
  await test('R15: PAY_BILL conflicting evidence aliases → CONFLICTING_ALIAS_VALUES 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'PAY_BILL', amount_paid: 100,
        bukti_bayar_path: '/a.jpg',
        initial_payment: { amount: 100, payment_evidence_path: '/b.jpg' }
      }),
      (e) => e.code === 'CONFLICTING_ALIAS_VALUES'
    );
  });

  // Conflicting nonblank method aliases must be rejected
  await test('R16: PAY_BILL conflicting method aliases → CONFLICTING_ALIAS_VALUES 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'PAY_BILL', amount_paid: 100,
        payment_method: 'CASH',
        initial_payment: { amount: 100, payment_method: 'TRANSFER' }
      }),
      (e) => e.code === 'CONFLICTING_ALIAS_VALUES'
    );
  });

  // UNPAID must check ALL evidence aliases including initial_payment
  await test('R17: UNPAID with initial_payment.payment_method alias → UNPAID_CONFLICTS_WITH_PAYMENT_INPUT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'UNPAID',
        initial_payment: { amount: 0, payment_method: 'CASH' }
      }),
      (e) => e.code === 'UNPAID_CONFLICTS_WITH_PAYMENT_INPUT'
    );
  });


  // ═══════════ BU-R2-05: raw positive child amount (pre-rounding) ═══════════

  // UNPAID + child amount_paid=0.1 (raw positive, rounds to 0) → must conflict
  await test('R18: UNPAID + reservations[0].amount_paid=0.1 (raw positive, rounds to 0) → UNPAID_CONFLICTS_WITH_PAYMENT_INPUT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'UNPAID',
        reservations: [{ amount_paid: 0.1 }]
      }),
      (e) => e.code === 'UNPAID_CONFLICTS_WITH_PAYMENT_INPUT'
    );
  });

  // UNPAID + child amount_paid='0.1' (string raw positive, rounds to 0) → must conflict
  await test('R19: UNPAID + reservations[0].amount_paid="0.1" (string, raw positive) → UNPAID_CONFLICTS_WITH_PAYMENT_INPUT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'UNPAID',
        reservations: [{ amount_paid: '0.1' }]
      }),
      (e) => e.code === 'UNPAID_CONFLICTS_WITH_PAYMENT_INPUT'
    );
  });

  // ADVANCE_PAYMENT + child amount_paid=0.1 (raw positive, rounds to 0) → must conflict
  await test('R20: ADVANCE_PAYMENT + reservations[0].amount_paid=0.1 (raw positive) → ORDINARY_AND_ADVANCE_CONFLICT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'ADVANCE_PAYMENT', advance_amount: 100,
        reservations: [{ amount_paid: 0.1 }]
      }),
      (e) => e.code === 'ORDINARY_AND_ADVANCE_CONFLICT'
    );
  });

  // ADVANCE_PAYMENT + child amount_paid='0.1' (string raw positive) → must conflict
  await test('R21: ADVANCE_PAYMENT + reservations[0].amount_paid="0.1" (string, raw positive) → ORDINARY_AND_ADVANCE_CONFLICT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'ADVANCE_PAYMENT', advance_amount: 100,
        reservations: [{ amount_paid: '0.1' }]
      }),
      (e) => e.code === 'ORDINARY_AND_ADVANCE_CONFLICT'
    );
  });

  // UNPAID + child amount_paid=0 → NOT positive, no conflict
  await test('R22: UNPAID + reservations[0].amount_paid=0 → no conflict, all zeros', () => {
    const r = normalizeBookingPaymentIntent({
      payment_mode: 'UNPAID',
      reservations: [{ amount_paid: 0 }]
    });
    assert.strictEqual(r.mode, 'UNPAID');
    assert.strictEqual(r.ordinaryAmount, 0);
    assert.strictEqual(r.advanceAmount, 0);
  });

  // UNPAID + child amount_paid=null → NOT positive, no conflict
  await test('R23: UNPAID + reservations[0].amount_paid=null → no conflict, all zeros', () => {
    const r = normalizeBookingPaymentIntent({
      payment_mode: 'UNPAID',
      reservations: [{ amount_paid: null }]
    });
    assert.strictEqual(r.mode, 'UNPAID');
    assert.strictEqual(r.ordinaryAmount, 0);
  });

  // UNPAID + child amount_paid='' (blank) → NOT positive, no conflict
  await test('R24: UNPAID + reservations[0].amount_paid="" (blank) → no conflict, all zeros', () => {
    const r = normalizeBookingPaymentIntent({
      payment_mode: 'UNPAID',
      reservations: [{ amount_paid: '' }]
    });
    assert.strictEqual(r.mode, 'UNPAID');
    assert.strictEqual(r.ordinaryAmount, 0);
  });

  // PAY_BILL + child-only (amount_paid=0, child amount_paid=100) → UNSUPPORTED_CHILD_ONLY_PAYMENT
  // (uses rounded totalChildPaid, not rawPositiveChild — this is the existing behaviour)
  await test('R25: PAY_BILL amount_paid=0 + child amount_paid=100 → UNSUPPORTED_CHILD_ONLY_PAYMENT 400', () => {
    assert.throws(
      () => normalizeBookingPaymentIntent({
        payment_mode: 'PAY_BILL', amount_paid: 0,
        reservations: [{ amount_paid: 100 }]
      }),
      (e) => e.code === 'UNSUPPORTED_CHILD_ONLY_PAYMENT'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
