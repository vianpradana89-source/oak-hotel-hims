/**
 * posReceiptApi.ts — regression tests for canonicalWholeRupiah + fetchPosReceipt
 * monetary validation.
 *
 * Run: node test/pos_receipt_api_test.ts
 * (or: node --experimental-strip-types test/pos_receipt_api_test.ts)
 */
import assert from 'node:assert/strict';
import { canonicalWholeRupiah, fetchPosReceipt } from '../src/features/pos/posReceiptApi.ts';
import type { PosReceiptData } from '../src/features/pos/posReceiptTypes.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting POS Receipt API Monetary Validation Tests ===\n');

// ============================================================================
// Test 1: canonicalWholeRupiah — accepted forms
// ============================================================================
console.log('--- Test 1: canonicalWholeRupiah — valid inputs ---');

check(canonicalWholeRupiah('25000') === '25000', '1.1 "25000" → "25000"');
check(canonicalWholeRupiah('25000.00') === '25000', '1.2 "25000.00" → "25000"');
check(canonicalWholeRupiah('25000.000') === '25000', '1.3 "25000.000" → "25000"');
check(canonicalWholeRupiah('1000') === '1000', '1.4 "1000" → "1000"');
check(canonicalWholeRupiah('1000.00') === '1000', '1.5 "1000.00" → "1000"');
check(canonicalWholeRupiah('1') === '1', '1.6 "1" → "1"');

// ============================================================================
// Test 2: canonicalWholeRupiah — rejected forms
// ============================================================================
console.log('\n--- Test 2: canonicalWholeRupiah — invalid inputs ---');

check(canonicalWholeRupiah('') === null, '2.1 empty string → null');
check(canonicalWholeRupiah('0') === null, '2.2 "0" → null');
check(canonicalWholeRupiah('0.00') === null, '2.3 "0.00" → null');
check(canonicalWholeRupiah('0.000') === null, '2.4 "0.000" → null');
check(canonicalWholeRupiah('-1000') === null, '2.5 "-1000" → null');
check(canonicalWholeRupiah('1000.50') === null, '2.6 "1000.50" → null');
check(canonicalWholeRupiah('1000.01') === null, '2.7 "1000.01" → null');
check(canonicalWholeRupiah('abc') === null, '2.8 "abc" → null');
check(canonicalWholeRupiah('01') === null, '2.9 "01" leading zero → null');
check(canonicalWholeRupiah('001000.00') === null, '2.10 "001000.00" leading zero → null');
check(canonicalWholeRupiah('1e5') === null, '2.11 "1e5" → null');
check(canonicalWholeRupiah(' 100 ') === null, '2.12 " 100 " (spaces) → null');
check(canonicalWholeRupiah(null) === null, '2.13 null → null');
check(canonicalWholeRupiah(undefined) === null, '2.14 undefined → null');
check(canonicalWholeRupiah(25000) === null, '2.15 number (not string) → null');
check(canonicalWholeRupiah('1.2.3') === null, '2.16 multiple dots → null');
check(canonicalWholeRupiah('123.') === null, '2.17 trailing dot → null');
check(canonicalWholeRupiah('.00') === null, '2.18 leading dot → null');
check(canonicalWholeRupiah('12.30.45') === null, '2.19 multi-dot → null');

// ============================================================================
// Test 3: fetchPosReceipt — mixed-scale monetary validation (real staging shape)
// ============================================================================
console.log('\n--- Test 3: fetchPosReceipt — "25000.00" vs "25000" → VALID ---');

function makeValidReceipt(overrides?: Partial<{
  totalAmount: string;
  settlementAmount: string;
  saleNetAmount: string;
}>): PosReceiptData {
  const total = overrides?.totalAmount ?? '25000';
  const settle = overrides?.settlementAmount ?? '25000';
  const sale = overrides?.saleNetAmount ?? '25000';
  return {
    property: {
      id: 1,
      name: 'Test Property',
      property_code: 'TST',
      address: null,
      phone: null,
      timezone: 'Asia/Jakarta',
      currency: 'IDR',
      branding: null,
    },
    order: {
      id: 101,
      order_number: 'ORD-001',
      property_id: 1,
      status: 'PAID',
      guest_name: null,
      guest_phone: null,
      table_number: null,
      notes: null,
      total_amount: total,
      discount_type: null,
      discount_value: null,
      discount_reason: null,
      discount_amount: '0',
      created_at: null,
      updated_at: null,
    },
    items: [
      {
        id: 1,
        menu_item_id: 1,
        item_name_snapshot: 'Item A',
        item_code_snapshot: null,
        quantity: 1,
        unit_price: '25000',
        notes: null,
        discount_type: null,
        discount_value: null,
        discount_amount: '0',
      },
    ],
    settlement: {
      id: 1,
      amount: settle,
      payment_method: 'CASH',
      status: 'SUCCESS',
      cash_received: settle,
      change_due: '0',
      payment_reference: null,
      created_by: null,
      created_at: null,
      verified_by: null,
      verified_at: null,
    },
    sale: {
      id: '900001',
      transaction_no: 'TRX-001',
      transaction_type: 'SALE',
      source_type: 'POS_ORDER',
      source_id: '101',
      payment_status: 'PAID',
      payment_method: 'CASH',
      net_amount: sale,
      created_at: null,
    },
  };
}

// Build a fake Response
function fakeResponse(body: unknown): Response {
  const jsonStr = JSON.stringify(body);
  return new Response(jsonStr, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function fakeAuthFetch(body: unknown) {
  return async (_url: string) => fakeResponse(body);
}

// 3.1: Real staging shape — order "25000.00", settlement "25000.00", sale "25000"
{
  const receipt = makeValidReceipt({
    totalAmount: '25000.00',
    settlementAmount: '25000.00',
    saleNetAmount: '25000',
  });
  const envelope = { status: 'SUCCESS', data: receipt };
  const result = await fetchPosReceipt(101, 1, fakeAuthFetch(envelope));
  check(result.order.total_amount === '25000.00', '3.1 receipt returned without mutation of total_amount');
  check(result.settlement.amount === '25000.00', '3.2 receipt returned without mutation of settlement.amount');
  check(result.sale.net_amount === '25000', '3.3 receipt returned without mutation of sale.net_amount');
  console.log('PASS: "25000.00" / "25000.00" / "25000" → VALID, raw strings preserved');
}

// 3.2: All same scale "25000" / "25000" / "25000"
{
  const receipt = makeValidReceipt({
    totalAmount: '25000',
    settlementAmount: '25000',
    saleNetAmount: '25000',
  });
  const envelope = { status: 'SUCCESS', data: receipt };
  const result = await fetchPosReceipt(101, 1, fakeAuthFetch(envelope));
  check(result !== null, '3.4 all-same-scale "25000" → VALID');
}

// ============================================================================
// Test 4: fetchPosReceipt — fractional decimal → INVALID
// ============================================================================
console.log('\n--- Test 4: fetchPosReceipt — "25000.50" → INVALID ---');

{
  const receipt = makeValidReceipt({
    totalAmount: '25000.50',
    settlementAmount: '25000.50',
    saleNetAmount: '25000.50',
  });
  const envelope = { status: 'SUCCESS', data: receipt };
  let threw = false;
  try {
    await fetchPosReceipt(101, 1, fakeAuthFetch(envelope));
  } catch (err) {
    threw = true;
    check(
      err instanceof Error && err.message === 'Data struk POS tidak valid.',
      '4.1 "25000.50" throws expected message',
    );
  }
  check(threw, '4.2 "25000.50" throws');
}

// ============================================================================
// Test 5: fetchPosReceipt — cross-amount mismatch (even after canonical)
// ============================================================================
console.log('\n--- Test 5: fetchPosReceipt — cross-amount mismatch → INVALID ---');

{
  const receipt = makeValidReceipt({
    totalAmount: '25000.00',
    settlementAmount: '25000',
    saleNetAmount: '24000',  // different value
  });
  const envelope = { status: 'SUCCESS', data: receipt };
  let threw = false;
  try {
    await fetchPosReceipt(101, 1, fakeAuthFetch(envelope));
  } catch (err) {
    threw = true;
    check(
      err instanceof Error && err.message === 'Data struk POS tidak valid.',
      '5.1 mismatched amounts throw expected message',
    );
  }
  check(threw, '5.2 mismatched amounts throw');
}

// ============================================================================
// Test 6: fetchPosReceipt — zero values → INVALID
// ============================================================================
console.log('\n--- Test 6: fetchPosReceipt — "0.00" zero → INVALID ---');

{
  const receipt = makeValidReceipt({
    totalAmount: '0.00',
    settlementAmount: '0.00',
    saleNetAmount: '0.00',
  });
  const envelope = { status: 'SUCCESS', data: receipt };
  let threw = false;
  try {
    await fetchPosReceipt(101, 1, fakeAuthFetch(envelope));
  } catch (err) {
    threw = true;
  }
  check(threw, '6.1 "0.00" zero amount → INVALID (throw)');
}

// ============================================================================
// Test 7: fetchPosReceipt — fail-closed checks (existing contract)
// ============================================================================
console.log('\n--- Test 7: fetchPosReceipt — fail-closed checks remain ---');

function expectThrow(body: unknown, label: string) {
  return (async () => {
    let threw = false;
    try {
      await fetchPosReceipt(101, 1, fakeAuthFetch(body));
    } catch {
      threw = true;
    }
    check(threw, label);
  })();
}

// 7.1: env.status !== SUCCESS
await expectThrow({ status: 'ERROR', data: null }, '7.1 status!=SUCCESS → throw');

// 7.2: order.status !== PAID
{
  const r = makeValidReceipt();
  r.order.status = 'PENDING';
  await expectThrow({ status: 'SUCCESS', data: r }, '7.2 order.status PENDING → throw');
}

// 7.3: settlement.status !== SUCCESS
{
  const r = makeValidReceipt();
  r.settlement.status = 'FAILED';
  await expectThrow({ status: 'SUCCESS', data: r }, '7.3 settlement.status FAILED → throw');
}

// 7.4: sale.transaction_type !== SALE
{
  const r = makeValidReceipt();
  r.sale.transaction_type = 'REFUND';
  await expectThrow({ status: 'SUCCESS', data: r }, '7.4 sale.transaction_type REFUND → throw');
}

// 7.5: payment_method mismatch
{
  const r = makeValidReceipt();
  r.settlement.payment_method = 'QRIS';
  r.sale.payment_method = 'CASH';
  await expectThrow({ status: 'SUCCESS', data: r }, '7.5 payment_method mismatch → throw');
}

// 7.6: sale.source_id mismatch
{
  const r = makeValidReceipt();
  r.sale.source_id = '999';
  await expectThrow({ status: 'SUCCESS', data: r }, '7.6 sale.source_id mismatch → throw');
}

// 7.7: items not array
{
  const r = makeValidReceipt() as any;
  r.items = null;
  await expectThrow({ status: 'SUCCESS', data: r }, '7.7 items null → throw');
}

// 7.8: property mismatch
{
  const r = makeValidReceipt();
  r.property.id = 999;
  await expectThrow({ status: 'SUCCESS', data: r }, '7.8 property.id mismatch → throw');
}

// 7.9: order.id mismatch
{
  const r = makeValidReceipt();
  r.order.id = 999;
  await expectThrow({ status: 'SUCCESS', data: r }, '7.9 order.id mismatch → throw');
}

// 7.10: sale.payment_status !== PAID
{
  const r = makeValidReceipt();
  r.sale.payment_status = 'PENDING';
  await expectThrow({ status: 'SUCCESS', data: r }, '7.10 sale.payment_status PENDING → throw');
}

// 7.11: non-string monetary value (number instead of string)
{
  const r = makeValidReceipt() as any;
  r.order.total_amount = 25000;  // number, not string
  await expectThrow({ status: 'SUCCESS', data: r }, '7.11 total_amount as number → throw');
}

console.log(`\n=== All ${assertions} assertions passed ===`);
