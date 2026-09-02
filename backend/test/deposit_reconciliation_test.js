const assert = require('node:assert');
const { reconcileDeposit } = require('../dist/domains/deposits/depositService');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

function paymentEvent(overrides = {}) {
  return {
    id: 1,
    deposit_id: 10,
    property_id: 1,
    reservation_id: 20,
    deposit_property_id: 1,
    deposit_reservation_id: 20,
    event_type: 'RECEIVED',
    amount: 1000,
    payment_transaction_id: 30,
    payment_amount: 1000,
    payment_type: 'DEPOSIT',
    payment_status: 'SUCCESS',
    payment_property_id: 1,
    payment_reservation_id: 20,
    ...overrides
  };
}

function applyEvent(overrides = {}) {
  return {
    id: 2,
    deposit_id: 10,
    property_id: 1,
    reservation_id: 20,
    deposit_property_id: 1,
    deposit_reservation_id: 20,
    event_type: 'APPLY',
    amount: 400,
    folio_entry_id: 40,
    folio_amount: 400,
    folio_type: 'DEPOSIT_APPLY',
    folio_direction: 'CREDIT',
    folio_status: 'POSTED',
    folio_is_voided: false,
    folio_property_id: 1,
    folio_reservation_id: 20,
    folio_source_type: 'DEPOSIT',
    folio_source_id: '10',
    ...overrides
  };
}

function clientFor(rows) {
  return {
    async query(sql, params) {
      assert.ok(String(sql).includes('WHERE e.deposit_id = $1'));
      assert.deepStrictEqual(params, [10]);
      return { rows, rowCount: rows.length };
    }
  };
}

async function codes(rows) {
  return (await reconcileDeposit(clientFor(rows), 10)).map(issue => issue.code);
}

async function main() {
  await test('valid receipt and apply projections reconcile cleanly', async () => {
    assert.deepStrictEqual(await reconcileDeposit(clientFor([paymentEvent(), applyEvent()]), 10), []);
  });
  await test('event ownership mismatch is reported', async () => {
    assert.deepStrictEqual(await codes([paymentEvent({ property_id: 2 })]), ['EVENT_OWNERSHIP_MISMATCH', 'PAYMENT_PROPERTY_MISMATCH']);
  });
  await test('missing payment projection is reported', async () => {
    const result = await codes([paymentEvent({ payment_transaction_id: null, payment_type: null, payment_status: null, payment_amount: null, payment_property_id: null, payment_reservation_id: null })]);
    assert.ok(result.includes('PAYMENT_PROJECTION_MISSING'));
    assert.ok(result.includes('PAYMENT_PROJECTION_INVALID'));
  });
  await test('invalid payment type and status are reported', async () => {
    assert.ok((await codes([paymentEvent({ payment_type: 'PAYMENT', payment_status: 'FAILED' })])).includes('PAYMENT_PROJECTION_INVALID'));
  });
  await test('payment amount mismatch is reported', async () => {
    assert.ok((await codes([paymentEvent({ payment_amount: 999 })])).includes('PAYMENT_AMOUNT_MISMATCH'));
  });
  await test('payment property mismatch is reported', async () => {
    assert.ok((await codes([paymentEvent({ payment_property_id: 2 })])).includes('PAYMENT_PROPERTY_MISMATCH'));
  });
  await test('payment reservation mismatch is reported', async () => {
    assert.ok((await codes([paymentEvent({ payment_reservation_id: 21 })])).includes('PAYMENT_RESERVATION_MISMATCH'));
  });
  await test('refund requires a successful DEPOSIT_REFUND projection', async () => {
    const validRefund = paymentEvent({ id: 3, event_type: 'REFUND', amount: 200, payment_transaction_id: 31, payment_amount: 200, payment_type: 'DEPOSIT_REFUND' });
    assert.deepStrictEqual(await reconcileDeposit(clientFor([paymentEvent(), validRefund]), 10), []);
  });
  await test('reversal requires a successful DEPOSIT_REFUND projection', async () => {
    const reversal = paymentEvent({ id: 3, event_type: 'REVERSAL', payment_type: 'DEPOSIT', reversed_event_type: 'RECEIVED' });
    assert.ok((await codes([paymentEvent(), reversal])).includes('PAYMENT_PROJECTION_INVALID'));
  });
  await test('missing folio projection is reported', async () => {
    assert.ok((await codes([paymentEvent(), applyEvent({ folio_entry_id: null })])).includes('FOLIO_PROJECTION_MISSING'));
  });
  await test('voided or non-posted folio projection is invalid', async () => {
    assert.ok((await codes([paymentEvent(), applyEvent({ folio_is_voided: true })])).includes('FOLIO_PROJECTION_INVALID'));
  });
  await test('folio amount mismatch is reported', async () => {
    assert.ok((await codes([paymentEvent(), applyEvent({ folio_amount: 401 })])).includes('FOLIO_AMOUNT_MISMATCH'));
  });
  await test('folio ownership mismatches are reported independently', async () => {
    const result = await codes([paymentEvent(), applyEvent({ folio_property_id: 2, folio_reservation_id: 21 })]);
    assert.ok(result.includes('FOLIO_PROPERTY_MISMATCH'));
    assert.ok(result.includes('FOLIO_RESERVATION_MISMATCH'));
  });
  await test('folio source must identify the canonical deposit', async () => {
    assert.ok((await codes([paymentEvent(), applyEvent({ folio_source_id: '11' })])).includes('FOLIO_SOURCE_MISMATCH'));
  });
  await test('over-consumed event ledger produces a balance invariant issue', async () => {
    const result = await reconcileDeposit(clientFor([paymentEvent(), applyEvent({ amount: 1001, folio_amount: 1001 })]), 10);
    assert.ok(result.some(issue => issue.event_id === 0 && issue.code === 'DEPOSIT_INVARIANT_VIOLATION'));
  });
  await test('duplicate payment and folio projections are reported', async () => {
    const duplicatePayment = paymentEvent({ id: 3 });
    const duplicateFolio = applyEvent({ id: 4 });
    const result = await codes([paymentEvent(), applyEvent(), duplicatePayment, duplicateFolio]);
    assert.ok(result.includes('DUPLICATE_PAYMENT_PROJECTION'));
    assert.ok(result.includes('DUPLICATE_FOLIO_PROJECTION'));
  });

  console.log(`RESULT: PASS=${passed} FAIL=${failed} TOTAL=${passed + failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  console.log(`RESULT: PASS=${passed} FAIL=${failed + 1} TOTAL=${passed + failed + 1}`);
  process.exitCode = 1;
});
