/**
 * UNIT 3B - DB-free tests for bookingCreatePaymentService (production adapter).
 * Run: node test/booking_create_payment_test.js
 * No Pool / no real database / no GCS / no server.
 * All async IIFEs merged into a single awaited main() - exitCode set after all cases.
 */
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const pathMod = require('node:path');
const ts = require('typescript');
const svc = require('../dist/domains/reservations/bookingCreatePaymentService');
const ctx = require('../dist/domains/reservations/bookingCreateContextService');
const intentSvc = require('../dist/domains/reservations/bookingPaymentIntentService');
const billing = require('../dist/domains/reservations/reservationBilling');

// Fix #7: no require of depositService - core calls tested via injected mock.

let passed = 0, failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { failed++; console.error('FAIL: ' + name + '\n  ' + (e && e.stack ? e.stack : e)); }
}
function intent(mode, opts) {
  return Object.assign(
    { mode, ordinaryAmount: 0, advanceAmount: 0, paymentMethod: null, evidencePath: null, legacy: false },
    opts || {}
  );
}
const ACTOR = { userId: '7', name: 'Front Desk', role: 'Front Office' };
const strictValidator = (f) => {
  if (!f.buffer || !f.mimetype || f.size !== f.buffer.length) {
    return { valid: false, code: 'EVIDENCE_INVALID', error: 'invalid file shape' };
  }
  return { valid: true };
};

async function main() {

  // === Section 1: resolveBookingRequestKey ===
  // Success case: header ' K-1 ' trims to 'K-1'; body 'K-1' matches -> success
  await ok('explicit mode: header " K-1 " + body "K-1" -> success, key K-1', () => {
    const r = svc.resolveBookingRequestKey({ headerKey: ' K-1 ', bodyKey: 'K-1', intent: intent('PAY_BILL') });
    assert.strictEqual(r.requestKey, 'K-1');
    assert.strictEqual(r.explicit, true);
  });
  // Fix #2 regression: different case is REQUEST_KEY_CONFLICT
  await ok('fix#2: header " K-1 " vs body "k-1" (case diff) -> REQUEST_KEY_CONFLICT', () => {
    assert.throws(
      () => svc.resolveBookingRequestKey({ headerKey: ' K-1 ', bodyKey: 'k-1', intent: intent('PAY_BILL') }),
      e => e.statusCode === 400 && e.code === 'REQUEST_KEY_CONFLICT'
    );
  });
  await ok('type-invalid key rejected', () => {
    assert.throws(
      () => svc.resolveBookingRequestKey({ headerKey: 1, bodyKey: null, intent: intent('PAY_BILL') }),
      e => e.statusCode === 400 && e.code === 'REQUEST_KEY_TYPE_INVALID'
    );
  });
  await ok('header K-1 vs body k-1 (case difference) -> REQUEST_KEY_CONFLICT', () => {
    assert.throws(
      () => svc.resolveBookingRequestKey({ headerKey: ' K-1 ', bodyKey: 'k-1', intent: intent('ADVANCE_PAYMENT') }),
      e => e.statusCode === 400 && e.code === 'REQUEST_KEY_CONFLICT'
    );
  });
  await ok('explicit ADVANCE with empty/missing key rejected', () => {
    assert.throws(
      () => svc.resolveBookingRequestKey({ headerKey: '', bodyKey: null, intent: intent('ADVANCE_PAYMENT') }),
      e => e.statusCode === 400 && e.code === 'REQUEST_KEY_REQUIRED'
    );
  });
  await ok('legacy returns null when no key; no 400', () => {
    const r = svc.resolveBookingRequestKey({ headerKey: null, bodyKey: null, intent: intent('LEGACY', { legacy: true }) });
    assert.strictEqual(r.requestKey, null);
    assert.strictEqual(r.explicit, false);
  });
  await ok('key conflict header vs body rejected', () => {
    assert.throws(
      () => svc.resolveBookingRequestKey({ headerKey: 'A', bodyKey: 'B', intent: intent('UNPAID') }),
      e => e.statusCode === 400 && e.code === 'REQUEST_KEY_CONFLICT'
    );
  });

  // === Section 2: convertFileToEvidence ===
  await ok('no file returns null (not an error)', () => {
    assert.strictEqual(svc.convertFileToEvidence(null, strictValidator), null);
    assert.strictEqual(svc.convertFileToEvidence(undefined, strictValidator), null);
  });
  await ok('valid file converts to EvidenceUpload', () => {
    const buf = Buffer.from('dp-proof');
    const e = svc.convertFileToEvidence({ buffer: buf, mimetype: 'image/jpeg', originalname: 'p.jpg', size: buf.length }, strictValidator);
    assert.strictEqual(e.mimetype, 'image/jpeg');
    assert.strictEqual(e.size, buf.length);
    assert.ok(Buffer.isBuffer(e.buffer));
  });
  await ok('invalid file rejected 400 before core', () => {
    assert.throws(
      () => svc.convertFileToEvidence({ buffer: Buffer.alloc(3), mimetype: 'x', originalname: 'a', size: 9 }, strictValidator),
      e => e.statusCode === 400
    );
  });


  // === Section 3: evaluateBookingPaymentGates ===
  const RULES_REQ = { payment_method: 'REQUIRED', payment_amount: 'REQUIRED', payment_evidence: 'OPTIONAL' };
  await ok('HOTEL_COLLECT UNPAID + req.file rejects 400 before write', () => {
    const r = svc.evaluateBookingPaymentGates({
      intent: intent('UNPAID'), rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: null, evidencePath: null, childOrdinaryTotal: 0, filePresent: true
    });
    assert.strictEqual(r.hardReject && r.hardReject.code, 'UNPAID_WITH_RECEIPT_CONFLICT');
    assert.strictEqual(r.hardReject.status, 400);
  });
  await ok('OTA_COLLECT UNPAID + file remains voucher (no hard reject)', () => {
    const r = svc.evaluateBookingPaymentGates({
      intent: intent('UNPAID'), rules: {}, channelType: 'OTA', paymentResponsibility: 'OTA_COLLECT',
      paymentMethod: null, evidencePath: null, childOrdinaryTotal: 0, filePresent: true
    });
    assert.strictEqual(r.hardReject, undefined);
    assert.deepStrictEqual(r.missing, []);
  });
  await ok('OTA_COLLECT + DP positive rejected clearly', () => {
    const r = svc.evaluateBookingPaymentGates({
      intent: intent('ADVANCE_PAYMENT', { advanceAmount: 250000, paymentMethod: 'CASH' }),
      rules: {}, channelType: 'OTA', paymentResponsibility: 'OTA_COLLECT',
      paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, filePresent: false
    });
    assert.strictEqual(r.hardReject && r.hardReject.code, 'OTA_COLLECT_PAYMENT_CONFLICT');
  });
  await ok('OTA_COLLECT + PAY_BILL positive ordinary rejected', () => {
    const r = svc.evaluateBookingPaymentGates({
      intent: intent('PAY_BILL', { ordinaryAmount: 100000, paymentMethod: 'CASH' }),
      rules: {}, channelType: 'OTA', paymentResponsibility: 'OTA_COLLECT',
      paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, filePresent: false
    });
    assert.strictEqual(r.hardReject && r.hardReject.code, 'OTA_COLLECT_PAYMENT_CONFLICT');
  });
  await ok('REQUIRED payment_amount: UNPAID leaves missing; DP satisfies', () => {
    const unpaid = svc.evaluateBookingPaymentGates({
      intent: intent('UNPAID'), rules: RULES_REQ, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: null, evidencePath: null, childOrdinaryTotal: 0, filePresent: false
    });
    assert.ok(unpaid.missing.includes('payment_amount'));
    const dp = svc.evaluateBookingPaymentGates({
      intent: intent('ADVANCE_PAYMENT', { advanceAmount: 200000, paymentMethod: 'CASH' }),
      rules: RULES_REQ, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, filePresent: false
    });
    assert.ok(!dp.missing.includes('payment_amount'));
  });
  await ok('REQUIRED payment_method: cash-now DP without method missing', () => {
    const r = svc.evaluateBookingPaymentGates({
      intent: intent('ADVANCE_PAYMENT', { advanceAmount: 200000, paymentMethod: null }),
      rules: { payment_method: 'REQUIRED' }, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: null, evidencePath: null, childOrdinaryTotal: 0, filePresent: false
    });
    assert.ok(r.missing.includes('payment_method'));
  });
  // Fix #3 regression tests
  await ok('fix#3: REQUIRED payment_method explicit UNPAID cashNow=0 -> missing', () => {
    const r = svc.evaluateBookingPaymentGates({
      intent: intent('UNPAID'), rules: { payment_method: 'REQUIRED' }, channelType: 'WALK_IN',
      paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: null, evidencePath: null, childOrdinaryTotal: 0, filePresent: false
    });
    assert.ok(r.missing.includes('payment_method'), 'UNPAID must not bypass REQUIRED rule');
  });
  await ok('fix#3: REQUIRED payment_method explicit PAY_BILL cashNow=0 -> missing', () => {
    const r = svc.evaluateBookingPaymentGates({
      intent: intent('PAY_BILL'), rules: { payment_method: 'REQUIRED' }, channelType: 'WALK_IN',
      paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: null, evidencePath: null, childOrdinaryTotal: 0, filePresent: false
    });
    assert.ok(r.missing.includes('payment_method'), 'PAY_BILL zero-cash must not bypass REQUIRED rule');
  });


  // === Section 4: buildOrdinaryPaymentPlan ===
  await ok('PAY_BILL single child: booking-level cash, no group', () => {
    const p = svc.buildOrdinaryPaymentPlan({
      intent: intent('PAY_BILL', { ordinaryAmount: 300000, paymentMethod: 'CASH', evidencePath: null }),
      propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, file: null, actor: ACTOR,
      headerKey: 'k', bodyKey: null, childCount: 1
    });
    assert.strictEqual(p.bookingLevelCash, 300000);
    assert.strictEqual(p.useGroupPayment, false);
  });
  await ok('PAY_BILL multi child + cash: group payment', () => {
    const p = svc.buildOrdinaryPaymentPlan({
      intent: intent('PAY_BILL', { ordinaryAmount: 500000 }),
      propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, file: null, actor: ACTOR,
      headerKey: 'k', bodyKey: null, childCount: 2
    });
    assert.strictEqual(p.bookingLevelCash, 500000);
    assert.strictEqual(p.useGroupPayment, true);
  });
  await ok('ADVANCE_PAYMENT: ordinary booking/children zero, no group', () => {
    const p = svc.buildOrdinaryPaymentPlan({
      intent: intent('ADVANCE_PAYMENT', { advanceAmount: 250000 }),
      propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, file: null, actor: ACTOR,
      headerKey: 'k', bodyKey: null, childCount: 1
    });
    assert.strictEqual(p.bookingLevelCash, 0);
    assert.strictEqual(p.useGroupPayment, false);
    assert.strictEqual(p.useBookingLevelPayment, false);
  });
  await ok('UNPAID: zero ordinary, no group', () => {
    const p = svc.buildOrdinaryPaymentPlan({
      intent: intent('UNPAID'),
      propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: null, evidencePath: null, childOrdinaryTotal: 0, file: null, actor: ACTOR,
      headerKey: 'k', bodyKey: null, childCount: 2
    });
    assert.strictEqual(p.bookingLevelCash, 0);
    assert.strictEqual(p.useGroupPayment, false);
  });
  await ok('legacy child-only keeps child cash (booking-level empty)', () => {
    const p = svc.buildOrdinaryPaymentPlan({
      intent: intent('LEGACY', { legacy: true, ordinaryAmount: 0, paymentMethod: 'CASH' }),
      propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 150000, file: null, actor: ACTOR,
      headerKey: null, bodyKey: null, childCount: 1
    });
    assert.strictEqual(p.bookingLevelCash, 0);
    assert.strictEqual(p.useGroupPayment, false);
    assert.strictEqual(p.useBookingLevelPayment, false);
  });
  // Fix #5 regression: ORDINARY evidencePath + file -> ambiguous
  await ok('fix#5: ORDINARY evidencePath + file -> ORDINARY_EVIDENCE_AMBIGUOUS', () => {
    assert.throws(
      () => svc.buildOrdinaryPaymentPlan({
        intent: intent('PAY_BILL', { ordinaryAmount: 100, paymentMethod: 'CASH' }),
        propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
        paymentMethod: 'CASH', evidencePath: 'gs://bucket/x.png', childOrdinaryTotal: 0,
        file: { buffer: Buffer.from('x'), mimetype: 'image/jpeg', originalname: 'x.jpg', size: 1 },
        validateEvidenceUpload: strictValidator,
        actor: ACTOR, headerKey: 'k', bodyKey: null, childCount: 1
      }),
      e => e.statusCode === 400 && e.code === 'ORDINARY_EVIDENCE_AMBIGUOUS'
    );
  });


  // === Section 5: buildDpReceiptPlan ===
  const DP1 = intent('ADVANCE_PAYMENT', { advanceAmount: 250000, paymentMethod: 'CASH' });
  const DP_QRIS = intent('ADVANCE_PAYMENT', { advanceAmount: 250000, paymentMethod: 'QRIS' });
  await ok('single child ROOM_RESERVATION: deterministic anchor + 3A key + actor', () => {
    const plan = svc.buildDpReceiptPlan(
      {
        intent: DP1, propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
        paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0,
        file: { buffer: Buffer.from('x'), mimetype: 'image/jpeg', originalname: 'dp.jpg', size: 1 },
        validateEvidenceUpload: strictValidator,
        actor: ACTOR, headerKey: 'req-1', bodyKey: null, childCount: 1
      },
      'req-1',
      [{ id: 42, stay_sequence: 1, booking_id: 7 }]
    );
    assert.strictEqual(plan.scope, 'ROOM_RESERVATION');
    assert.strictEqual(plan.anchorReservationId, 42);
    assert.strictEqual(plan.purpose, 'ADVANCE_PAYMENT');
    assert.strictEqual(plan.amount, 250000);
    assert.strictEqual(plan.method, 'CASH');
    assert.strictEqual(plan.actor, ACTOR);
    assert.strictEqual(plan.idempotencyKey, ctx.deriveDpReceiptKey({ propertyId: 1, requestKey: 'req-1', intent: DP1 }));
    assert.ok(plan.idempotencyKey.length <= 150 && plan.idempotencyKey.startsWith('dp:'));
  });
  await ok('group BOOKING_GROUP scope + anchor by stay_sequence then id', () => {
    const plan = svc.buildDpReceiptPlan(
      {
        intent: DP_QRIS, propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
        paymentMethod: 'QRIS', evidencePath: null, childOrdinaryTotal: 0, file: null,
        actor: ACTOR, headerKey: 'req-2', bodyKey: null, childCount: 2
      },
      'req-2',
      [
        { id: 9, stay_sequence: 2, booking_id: 7 },
        { id: 5, stay_sequence: 1, booking_id: 7 }
      ]
    );
    assert.strictEqual(plan.scope, 'BOOKING_GROUP');
    assert.strictEqual(plan.anchorReservationId, 5);
    assert.strictEqual(plan.method, 'QRIS');
  });
  // Fix #6 regression: child booking_id mismatch rejected
  await ok('fix#6: DP receipt child booking_id mismatch -> DP_CHILDREN_PARENT_MISMATCH', () => {
    assert.throws(
      () => svc.buildDpReceiptPlan(
        {
          intent: DP1, propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
          paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, file: null,
          actor: ACTOR, headerKey: 'req-m', bodyKey: null, childCount: 1
        },
        'req-m',
        [{ id: 1, stay_sequence: 1, booking_id: 99 }]
      ),
      e => e.statusCode === 400 && e.code === 'DP_CHILDREN_PARENT_MISMATCH'
    );
  });
  // Fix #5 regression: DP evidencePath + file -> ambiguous
  await ok('fix#5: DP evidencePath + file -> DP_EVIDENCE_AMBIGUOUS', () => {
    assert.throws(
      () => svc.buildDpReceiptPlan(
        {
          intent: DP1, propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
          paymentMethod: 'CASH', evidencePath: 'gs://bucket/old.png', childOrdinaryTotal: 0,
          file: { buffer: Buffer.from('x'), mimetype: 'image/jpeg', originalname: 'dp.jpg', size: 1 },
          validateEvidenceUpload: strictValidator,
          actor: ACTOR, headerKey: 'req-a', bodyKey: null, childCount: 1
        },
        'req-a',
        [{ id: 1, stay_sequence: 1, booking_id: 7 }]
      ),
      e => e.statusCode === 400 && e.code === 'DP_EVIDENCE_AMBIGUOUS'
    );
  });
  // Fix #5 regression: DP evidencePath only (no file) -> unsupported
  await ok('fix#5: DP evidencePath only (no file) -> DP_EVIDENCE_PATH_UNSUPPORTED', () => {
    assert.throws(
      () => svc.buildDpReceiptPlan(
        {
          intent: DP1, propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
          paymentMethod: 'CASH', evidencePath: 'gs://bucket/old.png', childOrdinaryTotal: 0, file: null,
          actor: ACTOR, headerKey: 'req-p', bodyKey: null, childCount: 1
        },
        'req-p',
        [{ id: 1, stay_sequence: 1, booking_id: 7 }]
      ),
      e => e.statusCode === 400 && e.code === 'DP_EVIDENCE_PATH_UNSUPPORTED'
    );
  });
  await ok('explicit DP without request key rejected', () => {
    assert.throws(
      () => svc.buildDpReceiptPlan(
        {
          intent: DP1, propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
          paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, file: null,
          actor: ACTOR, headerKey: null, bodyKey: null, childCount: 1
        },
        null,
        [{ id: 1, stay_sequence: 1, booking_id: 7 }]
      ),
      e => e.statusCode === 400 && e.code === 'DP_RECEIPT_KEY_REQUIRED'
    );
  });
  await ok('non-ADVANCE intent cannot build DP plan', () => {
    assert.throws(
      () => svc.buildDpReceiptPlan(
        {
          intent: intent('UNPAID'), propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
          paymentMethod: null, evidencePath: null, childOrdinaryTotal: 0, file: null,
          actor: ACTOR, headerKey: 'k', bodyKey: null, childCount: 1
        },
        'k',
        [{ id: 1, stay_sequence: 1, booking_id: 7 }]
      ),
      e => e.code === 'ADVANCE_RECEIPT_MODE_INVALID'
    );
  });
  await ok('DP receipt method must be core-supported (not invented)', () => {
    assert.throws(
      () => svc.buildDpReceiptPlan(
        {
          intent: intent('ADVANCE_PAYMENT', { advanceAmount: 100, paymentMethod: 'VOUCHER_X' }),
          propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
          paymentMethod: 'VOUCHER_X', evidencePath: null, childOrdinaryTotal: 0, file: null,
          actor: ACTOR, headerKey: 'k', bodyKey: null, childCount: 1
        },
        'k',
        [{ id: 1, stay_sequence: 1, booking_id: 7 }]
      ),
      e => e.statusCode === 400 && e.code === 'UNSUPPORTED_PAYMENT_METHOD'
    );
  });
  // Fix #4 regression: file with size mismatch and injected validator -> 400
  await ok('fix#4: file with size mismatch, injected validator -> EVIDENCE_SIZE_MISMATCH', () => {
    assert.throws(
      () => svc.buildDpReceiptPlan(
        {
          intent: intent('ADVANCE_PAYMENT', { advanceAmount: 100, paymentMethod: 'CASH' }),
          propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
          paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0,
          file: { buffer: Buffer.alloc(3), mimetype: 'image/jpeg', originalname: 'a.jpg', size: 99 },
          validateEvidenceUpload: strictValidator,
          actor: ACTOR, headerKey: 'k4', bodyKey: null, childCount: 1
        },
        'k4',
        [{ id: 1, stay_sequence: 1, booking_id: 7 }]
      ),
      e => e.statusCode === 400 && e.code === 'EVIDENCE_SIZE_MISMATCH'
    );
  });


  // === Section 6: callDpReceiptInBookingTransaction ===
  function dpPlan() {
    const intent_ = intent('ADVANCE_PAYMENT', { advanceAmount: 10000, paymentMethod: 'CASH' });
    return svc.buildDpReceiptPlan(
      {
        intent: intent_, propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
        paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0,
        file: { buffer: Buffer.from('dp'), mimetype: 'image/jpeg', originalname: 'dp.jpg', size: 2 },
        validateEvidenceUpload: strictValidator,
        actor: ACTOR, headerKey: 'req-call', bodyKey: null, childCount: 1
      },
      'req-call',
      [{ id: 30, stay_sequence: 1, booking_id: 7 }]
    );
  }
  function mockCore() {
    const calls = [];
    const receive = async (client, input, owner) => {
      calls.push({ client, input, owner });
      if (input.evidence && owner && owner.isOwnedByCaller()) {
        owner.registerStorageKey('mock-evidence-key');
      }
      return { deposit: { id: 77, deposit_number: 'DEP-X-1' }, payment: { id: 88 }, idempotent_replay: false };
    };
    return { receive, calls };
  }
  // Fix #7: owner registration + core-throw test (no depositService import needed)
  await ok('single core call, same client, owner registers immediately', async () => {
    const savedEvidenceKeys = [];
    const { receive, calls } = mockCore();
    const client = { marker: 'booking-tx-client' };
    const result = await svc.callDpReceiptInBookingTransaction(client, dpPlan(), {
      receiveDepositInTransaction: receive, propertyId: 1, savedEvidenceKeys
    });
    assert.strictEqual(calls.length, 1, 'receiveDepositInTransaction called exactly once');
    assert.strictEqual(calls[0].client, client, 'same caller-owned client passed');
    assert.deepStrictEqual(savedEvidenceKeys, ['mock-evidence-key'], 'owner registered storage key');
    assert.strictEqual(result.deposit.id, 77);
  });
  // Fix #7 + owner-accepts-storage-key-before-throw test
  await ok('core throw after registration: keys remain in savedEvidenceKeys (rollback cleanup)', async () => {
    const savedEvidenceKeys = [];
    const coreErr = new Error('core blew up');
    const receive = async (client, input, owner) => {
      // Simulate owner accepting the storage key before the core throws
      if (owner && owner.isOwnedByCaller()) {
        owner.registerStorageKey('late-fail-key');
      }
      throw coreErr;
    };
    await assert.rejects(
      svc.callDpReceiptInBookingTransaction({ marker: 'fake-client' }, dpPlan(), {
        receiveDepositInTransaction: receive, propertyId: 1, savedEvidenceKeys
      }),
      e => e === coreErr
    );
    assert.deepStrictEqual(savedEvidenceKeys, ['late-fail-key'], 'owner-registered key persists through throw');
  });
  await ok('no-evidence DP: no owner registration, no save needed', async () => {
    const savedEvidenceKeys = [];
    const { receive } = mockCore();
    const intent_ = intent('ADVANCE_PAYMENT', { advanceAmount: 10000, paymentMethod: 'TRANSFER' });
    const plan = svc.buildDpReceiptPlan(
      {
        intent: intent_, propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
        paymentMethod: 'TRANSFER', evidencePath: null, childOrdinaryTotal: 0, file: null,
        actor: ACTOR, headerKey: 'req-nofile', bodyKey: null, childCount: 1
      },
      'req-nofile',
      [{ id: 31, stay_sequence: 1, booking_id: 7 }]
    );
    await svc.callDpReceiptInBookingTransaction({ marker: 'fake-client' }, plan, {
      receiveDepositInTransaction: async () => ({ deposit: { id: 1 }, payment: { id: 2 } }),
      propertyId: 1, savedEvidenceKeys
    });
    assert.deepStrictEqual(savedEvidenceKeys, []);
    assert.strictEqual(plan.evidence, null);
  });


  // === Section 7: buildDpResultMetadata + end-to-end adapter shape ===
  await ok('DP success metadata carries deposit/payment/purpose/scope without replay claim', () => {
    const intent_ = intent('ADVANCE_PAYMENT', { advanceAmount: 50000, paymentMethod: 'CASH' });
    const plan = svc.buildDpReceiptPlan(
      {
        intent: intent_, propertyId: 2, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
        paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, file: null,
        actor: ACTOR, headerKey: 'meta-1', bodyKey: null, childCount: 1
      },
      'meta-1',
      [{ id: 55, stay_sequence: 1, booking_id: 7 }]
    );
    const meta = svc.buildDpResultMetadata(intent_, {
      deposit: { id: 9, deposit_number: 'DEP-9' }, payment: { id: 10 }, idempotent_replay: false
    }, plan);
    assert.strictEqual(meta.deposit_id, 9);
    assert.strictEqual(meta.deposit_payment_id, 10);
    assert.strictEqual(meta.deposit_amount, 50000);
    assert.strictEqual(meta.deposit_purpose, 'ADVANCE_PAYMENT');
    assert.strictEqual(meta.deposit_scope, 'ROOM_RESERVATION');
    assert.strictEqual(meta.deposit_replayed, false);
  });
  await ok('non-DP intent returns null metadata (legacy return shape unchanged)', () => {
    const meta = svc.buildDpResultMetadata(intent('UNPAID'), { deposit: { id: 1 } }, null);
    assert.strictEqual(meta, null);
  });
  await ok('UNPAID writes no ordinary cash or DP receipt plan (adapter contract)', () => {
    const p = svc.buildOrdinaryPaymentPlan({
      intent: intent('UNPAID'),
      propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: null, evidencePath: null, childOrdinaryTotal: 0, file: null, actor: ACTOR,
      headerKey: 'u1', bodyKey: null, childCount: 1
    });
    assert.strictEqual(p.bookingLevelCash, 0);
    assert.strictEqual(p.useGroupPayment, false);
  });


  // Focused regression cases for the remaining step-1 gaps.
  const reviewBase = {
    intent: intent('ADVANCE_PAYMENT', { advanceAmount: 100, paymentMethod: 'CASH' }),
    propertyId: 1, bookingId: 7, childCount: 1, rules: {}, channelType: 'WALK_IN',
    paymentResponsibility: 'HOTEL_COLLECT', paymentMethod: 'CASH', evidencePath: null,
    childOrdinaryTotal: 0, file: null, actor: ACTOR, headerKey: 'review', bodyKey: null
  };
  const reviewChildren = [{ id: 42, booking_id: 7, stay_sequence: 1 }];
  const reviewFile = { buffer: Buffer.from('x'), mimetype: 'image/jpeg', originalname: 'x.jpg', size: 1 };
  const expectCode = code => e => e.statusCode === 400 && e.code === code;
  await ok('R1 supplied file without buffer is invalid, not absent', () => {
    assert.throws(() => svc.convertFileToEvidence({ mimetype: 'image/jpeg', originalname: 'x.jpg', size: 1 }, strictValidator), expectCode('EVIDENCE_INVALID'));
  });
  await ok('R2 declared zero size is not replaced by buffer length', () => {
    assert.throws(() => svc.convertFileToEvidence({ ...reviewFile, size: 0 }, strictValidator), expectCode('EVIDENCE_SIZE_MISMATCH'));
  });
  await ok('R3 supplied size string is rejected without coercion', () => {
    assert.throws(() => svc.convertFileToEvidence({ ...reviewFile, size: '1' }, strictValidator), expectCode('EVIDENCE_SIZE_MISMATCH'));
  });
  await ok('R4 uploaded DP file requires injected existing validator', () => {
    assert.throws(() => svc.buildDpReceiptPlan({ ...reviewBase, file: reviewFile }, 'review', reviewChildren), expectCode('EVIDENCE_VALIDATOR_REQUIRED'));
  });
  await ok('R5 injected MIME policy rejection is propagated', () => {
    assert.throws(() => svc.buildDpReceiptPlan({ ...reviewBase, file: { ...reviewFile, mimetype: 'application/x-invalid' }, validateEvidenceUpload: () => ({ valid: false, code: 'UNSUPPORTED_MIME_TYPE', error: 'policy rejected MIME' }) }, 'review', reviewChildren), expectCode('UNSUPPORTED_MIME_TYPE'));
  });
  await ok('R6 injected upload size policy rejection is propagated', () => {
    assert.throws(() => svc.buildDpReceiptPlan({ ...reviewBase, file: reviewFile, validateEvidenceUpload: () => ({ valid: false, code: 'FILE_TOO_LARGE', error: 'policy rejected size' }) }, 'review', reviewChildren), expectCode('FILE_TOO_LARGE'));
  });
  await ok('R7 missing child booking_id is rejected', () => {
    assert.throws(() => svc.buildDpReceiptPlan(reviewBase, 'review', [{ id: 42, stay_sequence: 1 }]), expectCode('DP_CHILDREN_PARENT_MISMATCH'));
  });
  await ok('R8 invalid expected parent cannot disable binding check', () => {
    assert.throws(() => svc.buildDpReceiptPlan({ ...reviewBase, bookingId: 0 }, 'review', [{ id: 42, booking_id: 999 }]), expectCode('DP_PARENT_BOOKING_INVALID'));
  });
  await ok('R9 null child booking_id is rejected', () => {
    assert.throws(() => svc.buildDpReceiptPlan(reviewBase, 'review', [{ id: 42, booking_id: null }]), expectCode('DP_CHILDREN_PARENT_MISMATCH'));
  });
  await ok('R10 partial child set cannot produce single-room scope', () => {
    assert.throws(() => svc.buildDpReceiptPlan({ ...reviewBase, childCount: 2 }, 'review', reviewChildren), expectCode('DP_CHILD_COUNT_MISMATCH'));
  });
  await ok('R11 mixed group with missing parent is rejected', () => {
    assert.throws(() => svc.buildDpReceiptPlan({ ...reviewBase, childCount: 2 }, 'review', [...reviewChildren, { id: 43, stay_sequence: 2 }]), expectCode('DP_CHILDREN_PARENT_MISMATCH'));
  });
  await ok('R12 valid file policy is called once with unchanged bytes/size', () => {
    let called = 0;
    const plan = svc.buildDpReceiptPlan({ ...reviewBase, file: reviewFile, validateEvidenceUpload: file => {
      called++; assert.strictEqual(file.buffer, reviewFile.buffer); assert.strictEqual(file.size, 1); return { valid: true };
    } }, 'review', reviewChildren);
    assert.strictEqual(called, 1); assert.strictEqual(plan.evidence.buffer, reviewFile.buffer);
  });

  // === Section 8: Step-2 wiring functions (production DTOs, DB-free) ===
  // Mirrors the values createCanonicalBooking passes to the production helpers.
  const wirePlanInput = (normalizedIntent, overrides) => Object.assign({
    intent: normalizedIntent,
    propertyId: 1,
    bookingId: 7,
    rules: {},
    channelType: 'WALK_IN',
    paymentResponsibility: 'HOTEL_COLLECT',
    paymentMethod: normalizedIntent.paymentMethod,
    evidencePath: normalizedIntent.evidencePath,
    childOrdinaryTotal: 0,
    file: null,
    actor: ACTOR,
    headerKey: 'wire-key',
    bodyKey: null,
    childCount: 1
  }, overrides || {});

  await ok('wiring key: explicit PAY_BILL requires key; header/body alias accepted', () => {
    const normalized = intentSvc.normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', amount_paid: 1000 });
    assert.throws(
      () => svc.resolveBookingRequestKey({ headerKey: null, bodyKey: null, intent: normalized }),
      e => e.statusCode === 400 && e.code === 'REQUEST_KEY_REQUIRED'
    );
    const resolved = svc.resolveBookingRequestKey({ headerKey: ' wire-1 ', bodyKey: 'wire-1', intent: normalized });
    assert.strictEqual(resolved.requestKey, 'wire-1');
  });
  await ok('wiring PAY_BILL single: amount_paid + equal initial_payment counted once', () => {
    const normalized = intentSvc.normalizeBookingPaymentIntent({
      payment_mode: 'PAY_BILL',
      amount_paid: 300000,
      initial_payment: { amount: 300000, payment_method: 'CASH' }
    });
    const plan = svc.buildOrdinaryPaymentPlan(wirePlanInput(normalized, { childCount: 1 }));
    assert.strictEqual(normalized.legacy, false);
    assert.strictEqual(normalized.ordinaryAmount, 300000);
    assert.strictEqual(plan.bookingLevelCash, 300000);
    assert.strictEqual(plan.useBookingLevelPayment, true);
    assert.strictEqual(plan.useGroupPayment, false);
    assert.strictEqual(plan.method, 'CASH');
  });
  await ok('wiring PAY_BILL group: same amount once, group allocation enabled', () => {
    const normalized = intentSvc.normalizeBookingPaymentIntent({
      payment_mode: 'PAY_BILL',
      amount_paid: 300000
    });
    const single = svc.buildOrdinaryPaymentPlan(wirePlanInput(normalized, { childCount: 1 }));
    const group = svc.buildOrdinaryPaymentPlan(wirePlanInput(normalized, { childCount: 2 }));
    assert.strictEqual(single.bookingLevelCash, 300000);
    assert.strictEqual(group.bookingLevelCash, single.bookingLevelCash);
    assert.strictEqual(group.useGroupPayment, true);
    assert.strictEqual(single.useGroupPayment, false);
  });
  await ok('wiring PAY_BILL partial payment is legal (cash < booking net)', () => {
    const normalized = intentSvc.normalizeBookingPaymentIntent({ payment_mode: 'PAY_BILL', amount_paid: 125000 });
    const plan = svc.buildOrdinaryPaymentPlan(wirePlanInput(normalized, { childCount: 1 }));
    const allocation = billing.allocateBookingPaymentToChildren([500000], plan.bookingLevelCash);
    assert.strictEqual(allocation.totalAllocated, 125000);
    assert.strictEqual(allocation.remainingBalance, 375000);
  });
  await ok('wiring ADVANCE_PAYMENT: zero ordinary cash, no group/child payment', () => {
    const normalized = intentSvc.normalizeBookingPaymentIntent({
      payment_mode: 'ADVANCE_PAYMENT', advance_amount: 250000, payment_method: 'CASH'
    });
    const plan = svc.buildOrdinaryPaymentPlan(wirePlanInput(normalized, { childCount: 2 }));
    assert.strictEqual(normalized.ordinaryAmount, 0);
    assert.strictEqual(plan.bookingLevelCash, 0);
    assert.strictEqual(plan.useBookingLevelPayment, false);
    assert.strictEqual(plan.useGroupPayment, false);
  });
  await ok('wiring UNPAID: zero ordinary cash, no group/child payment', () => {
    const normalized = intentSvc.normalizeBookingPaymentIntent({ payment_mode: 'UNPAID' });
    const plan = svc.buildOrdinaryPaymentPlan(wirePlanInput(normalized, { childCount: 2 }));
    assert.strictEqual(plan.bookingLevelCash, 0);
    assert.strictEqual(plan.useBookingLevelPayment, false);
    assert.strictEqual(plan.useGroupPayment, false);
  });
  await ok('wiring gates: PAY_BILL REQUIRED method/amount/evidence satisfied', () => {
    const normalized = intentSvc.normalizeBookingPaymentIntent({
      payment_mode: 'PAY_BILL', amount_paid: 100000, payment_method: 'CASH',
      bukti_bayar_path: 'gs://bucket/x.jpg'
    });
    const r = svc.evaluateBookingPaymentGates({
      intent: normalized, rules: RULES_REQ, channelType: 'WALK_IN',
      paymentResponsibility: 'HOTEL_COLLECT', paymentMethod: normalized.paymentMethod,
      evidencePath: normalized.evidencePath, childOrdinaryTotal: 0, filePresent: false
    });
    assert.strictEqual(r.hardReject, undefined);
    assert.deepStrictEqual(r.missing, []);
  });
  await ok('wiring gates: PAY_BILL REQUIRED evidence missing without path/file', () => {
    const normalized = intentSvc.normalizeBookingPaymentIntent({
      payment_mode: 'PAY_BILL', amount_paid: 100000, payment_method: 'CASH'
    });
    const r = svc.evaluateBookingPaymentGates({
      intent: normalized, rules: { payment_evidence: 'REQUIRED' }, channelType: 'WALK_IN',
      paymentResponsibility: 'HOTEL_COLLECT', paymentMethod: normalized.paymentMethod,
      evidencePath: null, childOrdinaryTotal: 0, filePresent: false
    });
    assert.ok(r.missing.includes('payment_evidence'));
  });
  await ok('wiring gates: OTA UNPAID voucher file bypasses hotel requirements', () => {
    const normalized = intentSvc.normalizeBookingPaymentIntent({ payment_mode: 'UNPAID' });
    const r = svc.evaluateBookingPaymentGates({
      intent: normalized, rules: RULES_REQ, channelType: 'OTA',
      paymentResponsibility: 'OTA_COLLECT', paymentMethod: null,
      evidencePath: null, childOrdinaryTotal: 0, filePresent: true
    });
    assert.strictEqual(r.hardReject, undefined);
    assert.deepStrictEqual(r.missing, []);
  });
  await ok('wiring gates: OTA DP positive with voucher file still rejected', () => {
    const normalized = intentSvc.normalizeBookingPaymentIntent({
      payment_mode: 'ADVANCE_PAYMENT', advance_amount: 100000, payment_method: 'CASH'
    });
    const r = svc.evaluateBookingPaymentGates({
      intent: normalized, rules: {}, channelType: 'OTA',
      paymentResponsibility: 'OTA_COLLECT', paymentMethod: 'CASH',
      evidencePath: null, childOrdinaryTotal: 0, filePresent: true
    });
    assert.strictEqual(r.hardReject && r.hardReject.code, 'OTA_COLLECT_PAYMENT_CONFLICT');
  });
  await ok('wiring DP precheck: unsupported method rejected before writer', () => {
    assert.throws(() => svc.validateDpReceiptMethod('VOUCHER_X'), expectCode('UNSUPPORTED_PAYMENT_METHOD'));
    assert.strictEqual(svc.validateDpReceiptMethod('qris'), 'QRIS');
  });
  await ok('wiring legacy: no payment_mode stays legacy, child payment preserved', () => {
    const normalized = intentSvc.normalizeBookingPaymentIntent({
      amount_paid: 0,
      reservations: [{ amount_paid: 150000 }]
    });
    assert.strictEqual(normalized.legacy, true);
    const plan = svc.buildOrdinaryPaymentPlan(wirePlanInput(normalized, {
      childOrdinaryTotal: 150000, childCount: 1, headerKey: null
    }));
    assert.strictEqual(plan.bookingLevelCash, 0);
    assert.strictEqual(plan.useBookingLevelPayment, false);
    assert.strictEqual(plan.useGroupPayment, false);
  });

  // === Section 9: Production wiring AST check (step 2 + step 3) ===
  // Fix #8: AST CallExpression scoped to createCanonicalBooking; imports alone are not proof.
  await ok('wiring AST: step-2 payment calls are inside createCanonicalBooking', () => {
    const indexTs = fs.readFileSync(pathMod.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const sf = ts.createSourceFile('index.ts', indexTs, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const foundCalls = new Set();
    function visit(node) {
      if (ts.isCallExpression(node)) foundCalls.add(node.expression.getText(sf));
      ts.forEachChild(node, visit);
    }
    let foundFn = false;
    function findFn(node) {
      if (ts.isFunctionDeclaration(node) && node.name && node.name.text === 'createCanonicalBooking') {
        foundFn = true;
        ts.forEachChild(node, visit);
        return;
      }
      ts.forEachChild(node, findFn);
    }
    ts.forEachChild(sf, findFn);
    assert.strictEqual(foundFn, true, 'createCanonicalBooking declaration must exist');
    const step2Calls = [
      'normalizeBookingPaymentIntent',
      'resolveBookingRequestKey',
      'evaluateBookingPaymentGates',
      'buildOrdinaryPaymentPlan',
      'convertFileToEvidence',
      'validateDpReceiptMethod'
    ];
    const missing = step2Calls.filter(name => !foundCalls.has(name));
    assert.deepStrictEqual(missing, [], 'missing step-2 calls: ' + missing.join(', '));
    const step3Calls = ['buildDpReceiptPlan', 'callDpReceiptInBookingTransaction'];
    const missing3 = step3Calls.filter(name => !foundCalls.has(name));
    assert.deepStrictEqual(missing3, [], 'missing step-3 calls: ' + missing3.join(', '));
  });


  // === Section 10: Step-3 DP receipt wiring (production functions, DB-free) ===

  // preValidatedEvidence path: skips convertFileToEvidence, uses the accepted DTO directly.
  await ok('step3: preValidatedEvidence bypasses re-validation, evidence used directly', () => {
    const preEvidence = { buffer: Buffer.from('dp'), mimetype: 'image/jpeg', originalname: 'dp.jpg', size: 2 };
    const plan = svc.buildDpReceiptPlan({
      intent: intent('ADVANCE_PAYMENT', { advanceAmount: 10000, paymentMethod: 'CASH' }),
      propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0,
      file: null,
      actor: ACTOR, headerKey: 'req-s3', bodyKey: null, childCount: 1,
      preValidatedEvidence: preEvidence
    }, 'req-s3', [{ id: 30, stay_sequence: 1, booking_id: 7 }]);
    assert.strictEqual(plan.evidence, preEvidence, 'preValidatedEvidence object is passed through unchanged');
  });

  // Without preValidatedEvidence, file=null means evidence=null (no re-validation needed).
  await ok('step3: no preValidatedEvidence + no file -> evidence null', () => {
    const plan = svc.buildDpReceiptPlan({
      intent: intent('ADVANCE_PAYMENT', { advanceAmount: 10000, paymentMethod: 'CASH' }),
      propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0,
      file: null, actor: ACTOR, headerKey: 'req-s3b', bodyKey: null, childCount: 1
    }, 'req-s3b', [{ id: 30, stay_sequence: 1, booking_id: 7 }]);
    assert.strictEqual(plan.evidence, null);
  });

  // Same client, same savedEvidenceKeys array shared between owner and cleanup.
  await ok('step3: same client + shared savedEvidenceKeys array used by owner registration', async () => {
    const savedEvidenceKeys = [];
    const client = { marker: 'shared-client' };
    const coreCalls = [];
    const mockReceive = async (cl, input, owner) => {
      coreCalls.push({ client: cl, key: input.idempotencyKey });
      if (owner && owner.isOwnedByCaller()) {
        owner.registerStorageKey('shared-key-1');
      }
      return { deposit: { id: 1, deposit_number: 'DEP-1' }, payment: { id: 2 }, idempotent_replay: false };
    };
    const plan = svc.buildDpReceiptPlan({
      intent: intent('ADVANCE_PAYMENT', { advanceAmount: 5000, paymentMethod: 'CASH' }),
      propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, file: null,
      actor: ACTOR, headerKey: 'req-s3c', bodyKey: null, childCount: 1,
      preValidatedEvidence: { buffer: Buffer.from('e'), mimetype: 'image/png', originalname: 'e.png', size: 1 }
    }, 'req-s3c', [{ id: 42, stay_sequence: 1, booking_id: 7 }]);
    const result = await svc.callDpReceiptInBookingTransaction(client, plan, {
      receiveDepositInTransaction: mockReceive, propertyId: 1, savedEvidenceKeys
    });
    assert.strictEqual(coreCalls.length, 1, 'core called exactly once');
    assert.strictEqual(coreCalls[0].client, client, 'same caller-owned client passed to core');
    assert.deepStrictEqual(savedEvidenceKeys, ['shared-key-1'], 'owner registered key in shared array');
    assert.strictEqual(result.deposit.id, 1);
  });

  // Core throw after key registration: keys persist for rollback cleanup.
  await ok('step3: core throw after key registration leaves keys in savedEvidenceKeys', async () => {
    const savedEvidenceKeys = [];
    const coreErr = new Error('core failure after key registration');
    const mockReceive = async (cl, input, owner) => {
      if (owner && owner.isOwnedByCaller()) {
        owner.registerStorageKey('failed-key');
      }
      throw coreErr;
    };
    const plan = svc.buildDpReceiptPlan({
      intent: intent('ADVANCE_PAYMENT', { advanceAmount: 5000, paymentMethod: 'CASH' }),
      propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, file: null,
      actor: ACTOR, headerKey: 'req-s3d', bodyKey: null, childCount: 1
    }, 'req-s3d', [{ id: 43, stay_sequence: 1, booking_id: 7 }]);
    await assert.rejects(
      svc.callDpReceiptInBookingTransaction({ marker: 'fake' }, plan, {
        receiveDepositInTransaction: mockReceive, propertyId: 1, savedEvidenceKeys
      }),
      e => e === coreErr
    );
    assert.deepStrictEqual(savedEvidenceKeys, ['failed-key'], 'owner-registered key persists through core throw');
  });

  // Replay: idempotent_replay=true, no new receipt/file, savedEvidenceKeys unchanged.
  await ok('step3: replay returns idempotent_replay, no new storage key registered', async () => {
    const savedEvidenceKeys = [];
    const mockReceive = async (cl, input, owner) => {
      // Replay: no evidence save, no registration
      return {
        deposit: { id: 99, deposit_number: 'DEP-X-99' },
        payment: { id: 100 },
        idempotent_replay: true
      };
    };
    const plan = svc.buildDpReceiptPlan({
      intent: intent('ADVANCE_PAYMENT', { advanceAmount: 10000, paymentMethod: 'CASH' }),
      propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, file: null,
      actor: ACTOR, headerKey: 'req-replay', bodyKey: null, childCount: 1
    }, 'req-replay', [{ id: 44, stay_sequence: 1, booking_id: 7 }]);
    const result = await svc.callDpReceiptInBookingTransaction({ marker: 'replay-client' }, plan, {
      receiveDepositInTransaction: mockReceive, propertyId: 1, savedEvidenceKeys
    });
    assert.strictEqual(result.idempotent_replay, true);
    assert.deepStrictEqual(savedEvidenceKeys, [], 'replay registers no new storage key');
    const meta = svc.buildDpResultMetadata(intent('ADVANCE_PAYMENT', { advanceAmount: 10000, paymentMethod: 'CASH' }), result, plan);
    assert.strictEqual(meta.deposit_replayed, true);
    assert.strictEqual(meta.deposit_id, 99);
  });

  // DP/UNPAID: no ordinary payment writer is triggered (adapter contract unchanged).
  await ok('step3: UNPAID and ADVANCE_PAYMENT skip ordinary PAY_BILL writer paths', () => {
    for (const mode of ['UNPAID', 'ADVANCE_PAYMENT']) {
      const p = svc.buildOrdinaryPaymentPlan({
        intent: intent(mode, { advanceAmount: mode === 'ADVANCE_PAYMENT' ? 100000 : 0 }),
        propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
        paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, file: null,
        actor: ACTOR, headerKey: 'req-x', bodyKey: null, childCount: 2
      });
      assert.strictEqual(p.bookingLevelCash, 0, mode + ': no ordinary cash');
      assert.strictEqual(p.useGroupPayment, false, mode + ': no group payment');
      assert.strictEqual(p.useBookingLevelPayment, false, mode + ': no booking-level payment');
    }
  });

  // PAY_BILL existing paths remain correct.
  await ok('step3 regression: PAY_BILL single child group=false, booking-level payment=true', () => {
    const p = svc.buildOrdinaryPaymentPlan({
      intent: intent('PAY_BILL', { ordinaryAmount: 200000, paymentMethod: 'CASH' }),
      propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, file: null,
      actor: ACTOR, headerKey: 'req-pb', bodyKey: null, childCount: 1
    });
    assert.strictEqual(p.bookingLevelCash, 200000);
    assert.strictEqual(p.useGroupPayment, false);
    assert.strictEqual(p.useBookingLevelPayment, true);
  });
  await ok('step3 regression: PAY_BILL multi-child group=true', () => {
    const p = svc.buildOrdinaryPaymentPlan({
      intent: intent('PAY_BILL', { ordinaryAmount: 300000, paymentMethod: 'CASH' }),
      propertyId: 1, bookingId: 7, rules: {}, channelType: 'WALK_IN', paymentResponsibility: 'HOTEL_COLLECT',
      paymentMethod: 'CASH', evidencePath: null, childOrdinaryTotal: 0, file: null,
      actor: ACTOR, headerKey: 'req-pb', bodyKey: null, childCount: 3
    });
    assert.strictEqual(p.bookingLevelCash, 300000);
    assert.strictEqual(p.useGroupPayment, true);
    assert.strictEqual(p.useBookingLevelPayment, true);
  });

  // buildDpResultMetadata: non-DP returns null (legacy shape unchanged).
  await ok('step3: buildDpResultMetadata returns null for non-DP modes', () => {
    assert.strictEqual(svc.buildDpResultMetadata(intent('PAY_BILL'), { deposit: { id: 1 } }, null), null);
    assert.strictEqual(svc.buildDpResultMetadata(intent('UNPAID'), { deposit: { id: 1 } }, null), null);
  });

  // === Section 11: AST scoped check — DP calls are outside child loop, before COMMIT ===
  await ok('AST: buildDpReceiptPlan+callDpReceiptInBookingTransaction positioned after child loop, before COMMIT', () => {
    const indexTs = fs.readFileSync(pathMod.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    // Find the line index (approximate) of insertedChildren.push and COMMIT within createCanonicalBooking.
    // Use string positions in the source file to verify order.
    const fnStart = indexTs.indexOf('async function createCanonicalBooking(');
    assert.ok(fnStart >= 0, 'createCanonicalBooking must exist');
    const childPushPos = indexTs.indexOf('insertedChildren.push', fnStart);
    assert.ok(childPushPos > 0, 'insertedChildren.push must exist inside createCanonicalBooking');
    const dpPlanPos = indexTs.indexOf('buildDpReceiptPlan(', fnStart);
    const dpCallPos = indexTs.indexOf('callDpReceiptInBookingTransaction(', fnStart);
    const commitPos = indexTs.indexOf("await client.query('COMMIT')", fnStart);
    assert.ok(dpPlanPos > 0 && dpPlanPos > childPushPos, 'buildDpReceiptPlan must appear after child loop (insertedChildren.push)');
    assert.ok(dpCallPos > 0 && dpCallPos > dpPlanPos, 'callDpReceiptInBookingTransaction must appear after buildDpReceiptPlan');
    assert.ok(commitPos > 0 && commitPos > dpCallPos, 'COMMIT must come after DP call');
    // The DP call is between the child loop end and COMMIT.
    assert.ok(dpPlanPos < commitPos, 'DP call must be before COMMIT');
  });



  // Execute the actual canonical COMMIT/catch/finally source with mock I/O.
  // Financial writers are not executed; work() models a completed/failed receipt.
  const vm = require('node:vm');
  const lifecycleSource = fs.readFileSync(pathMod.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const lifecycleSf = ts.createSourceFile('index.ts', lifecycleSource, ts.ScriptTarget.Latest, true);
  const canonicalFn = lifecycleSf.statements.find(n => ts.isFunctionDeclaration(n) && n.name && n.name.text === 'createCanonicalBooking' && n.body);
  assert.ok(canonicalFn, 'canonical declaration must exist');
  const outerTx = canonicalFn.body.statements.find(n => ts.isTryStatement(n) && n.finallyBlock);
  assert.ok(outerTx && outerTx.catchClause, 'canonical transaction catch/finally must exist');
  const lifecycleNames = new Set(['committed', 'commitAttempted', 'discardClient']);
  const declarations = canonicalFn.body.statements.filter(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => lifecycleNames.has(d.name.getText(lifecycleSf)))).map(n => n.getText(lifecycleSf)).join('\n');
  const commitIndex = outerTx.tryBlock.statements.findIndex(n => ts.isExpressionStatement(n) && ts.isAwaitExpression(n.expression) && ts.isCallExpression(n.expression.expression) && n.expression.expression.expression.getText(lifecycleSf) === 'client.query' && n.expression.expression.arguments[0] && n.expression.expression.arguments[0].text === 'COMMIT');
  assert.ok(commitIndex >= 0, 'canonical COMMIT statement must exist');
  let commitStatements = outerTx.tryBlock.statements.slice(commitIndex, commitIndex + 2);
  const preceding = outerTx.tryBlock.statements[commitIndex - 1];
  if (preceding && /commitAttempted\s*=\s*true/.test(preceding.getText(lifecycleSf))) commitStatements.unshift(preceding);
  const harnessSource = `async function runLifecycle(deps) {
    const client = deps.client;
    const savedEvidenceKeys = deps.savedEvidenceKeys;
    const bookingPropertyId = 1;
    const correlationId = 'lifecycle-test';
    ${declarations}
    try {
      await deps.work(client, savedEvidenceKeys);
      ${commitStatements.map(n => n.getText(lifecycleSf)).join('\n')}
      return deps.makeResult();
    } ${outerTx.catchClause.getText(lifecycleSf)} finally ${outerTx.finallyBlock.getText(lifecycleSf)}
  }
  globalThis.runLifecycle = runLifecycle;`;
  const harnessJs = ts.transpileModule(harnessSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  function makeLifecycle(overrides) {
    const calls = [];
    const releases = [];
    const keys = [];
    const defaults = {
      savedEvidenceKeys: keys,
      work: async () => {}, makeResult: () => ({ ok: true }),
      client: { query: async sql => { calls.push(sql); return {}; }, release: discard => { releases.push(discard); } },
      deleteEvidenceFile: async key => { calls.push('DELETE:' + key); }
    };
    const deps = Object.assign(defaults, overrides || {});
    const sandbox = { console: { error() {} }, deleteEvidenceFile: deps.deleteEvidenceFile,
      require: name => { if (name === 'fs') return { writeFileSync() {} }; throw new Error('Unexpected dependency ' + name); } };
    vm.createContext(sandbox); vm.runInContext(harnessJs, sandbox);
    return { deps, calls, releases, keys, run: () => sandbox.runLifecycle(deps) };
  }
  await ok('L1 actual canonical success retains evidence, releases once', async () => {
    const h = makeLifecycle(); h.keys.push('proof');
    assert.strictEqual((await h.run()).ok, true);
    assert.deepStrictEqual(h.calls, ['COMMIT']); assert.strictEqual(h.releases.length, 1);
    assert.notStrictEqual(h.releases[0], true);
  });
  await ok('L2 actual pre-COMMIT failure rolls back before evidence cleanup', async () => {
    const original = new Error('late writer failed');
    const h = makeLifecycle({ work: async () => { throw original; } }); h.keys.push('proof');
    await assert.rejects(h.run(), e => e === original);
    assert.deepStrictEqual(h.calls, ['ROLLBACK', 'DELETE:proof']); assert.strictEqual(h.releases.length, 1);
  });
  await ok('L3 COMMIT acknowledgement loss preserves potentially committed evidence', async () => {
    const original = new Error('COMMIT acknowledgement lost');
    const h = makeLifecycle(); h.keys.push('proof'); let serverCommitted = false;
    h.deps.client.query = async sql => { h.calls.push(sql); if (sql === 'COMMIT') { serverCommitted = true; throw original; } return {}; };
    await assert.rejects(h.run(), e => e === original);
    assert.strictEqual(serverCommitted, true); assert.deepStrictEqual(h.calls, ['COMMIT']);
    assert.deepStrictEqual(h.releases, [true]);
  });
  await ok('L4 failed ROLLBACK retains evidence, discards client, preserves original error', async () => {
    const original = new Error('writer failed'); const rollback = new Error('ROLLBACK failed');
    const h = makeLifecycle({ work: async () => { throw original; } }); h.keys.push('proof');
    h.deps.client.query = async sql => { h.calls.push(sql); throw rollback; };
    await assert.rejects(h.run(), e => e === original);
    assert.deepStrictEqual(h.calls, ['ROLLBACK']); assert.deepStrictEqual(h.releases, [true]);
  });
  await ok('L5 cleanup failure cannot replace original or prevent remaining cleanup', async () => {
    const original = new Error('writer failed');
    const attempted = [];
    const h = makeLifecycle({ work: async () => { throw original; }, deleteEvidenceFile: async key => {
      attempted.push(key); if (key === 'first') throw new Error('delete failed');
    } }); h.keys.push('first', 'second');
    await assert.rejects(h.run(), e => e === original);
    assert.deepStrictEqual(h.calls, ['ROLLBACK']); assert.deepStrictEqual(attempted, ['first', 'second']);
    assert.strictEqual(h.releases.length, 1);
  });
  await ok('L6 post-COMMIT result failure never deletes committed evidence', async () => {
    const original = new Error('return formatting failed');
    const h = makeLifecycle({ makeResult: () => { throw original; } }); h.keys.push('proof');
    await assert.rejects(h.run(), e => e === original);
    assert.deepStrictEqual(h.calls, ['COMMIT']); assert.strictEqual(h.releases.length, 1);
    assert.notStrictEqual(h.releases[0], true);
  });
  await ok('L7 real receipt adapter owner key survives throw and is cleaned after rollback', async () => {
    const original = new Error('receipt failed after save');
    const plan = svc.buildDpReceiptPlan(reviewBase, 'review-owner', reviewChildren);
    const h = makeLifecycle({ work: async (client, savedEvidenceKeys) => {
      await svc.callDpReceiptInBookingTransaction(client, plan, {
        propertyId: 1, savedEvidenceKeys,
        receiveDepositInTransaction: async (actualClient, input, owner) => {
          assert.strictEqual(actualClient, client); owner.registerStorageKey('owner-proof'); throw original;
        }
      });
    } });
    await assert.rejects(h.run(), e => e === original);
    assert.deepStrictEqual(h.keys, ['owner-proof']);
    assert.deepStrictEqual(h.calls, ['ROLLBACK', 'DELETE:owner-proof']);
  });
  await ok('L8 AST confirms one DP call outside loops after child loop and before COMMIT', () => {
    const found = [];
    function visit(node) {
      if (ts.isCallExpression(node)) found.push(node);
      ts.forEachChild(node, visit);
    }
    visit(canonicalFn.body);
    const dpCalls = found.filter(n => n.expression.getText(lifecycleSf) === 'callDpReceiptInBookingTransaction');
    assert.strictEqual(dpCalls.length, 1);
    const dp = dpCalls[0];
    const isLoop = n => ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n);
    for (let parent = dp.parent; parent && parent !== canonicalFn; parent = parent.parent) assert.ok(!isLoop(parent), 'DP call cannot have a loop ancestor');
    const push = found.find(n => n.expression.getText(lifecycleSf) === 'insertedChildren.push');
    let loop = push.parent; while (loop && !isLoop(loop)) loop = loop.parent;
    assert.ok(loop && loop.end < dp.getStart(lifecycleSf), 'entire child loop must end before DP call');
    assert.ok(dp.end < outerTx.tryBlock.statements[commitIndex].getStart(lifecycleSf));
  });


  // === Summary & exit code ===
  console.log('RESULT: PASS=' + passed + ' FAIL=' + failed + ' TOTAL=' + (passed + failed));
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
