/**
 * POS Pricing Core — PHASE B1 pure unit test (tanpa DB).
 *
 * Mengimpor computePosPricing + PosPricingError langsung dari dist
 * (hasil build) agar identik dengan kode yang di-deploy.
 *
 * Run (dari backend/):
 *   npm run build
 *   node test/pos_pricing_core_test.js
 */
'use strict';

const assert = require('assert');
const { computePosPricing, PosPricingError } = require('../dist/domains/pos/posPricingCore.js');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; failures.push(label); console.error('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function rejects(label, fn, code) {
  try {
    fn();
    ok(label, false, 'tidak throw (seharusnya throw ' + code + ')');
  } catch (e) {
    if (e instanceof PosPricingError) {
      ok(label, e.code === code, `code=${e.code} expected=${code}`);
    } else {
      ok(label, false, 'throw bukan PosPricingError: ' + (e && e.message));
    }
  }
}

const NO_SVC_TAX = {
  serviceChargeEnabled: false,
  serviceChargePercent: 0,
  taxEnabled: false,
  taxPercent: 0,
};

function noDiscount() {
  return { orderDiscountType: null, orderDiscountValue: null };
}

function item(qty, price, disType = null, disVal = null) {
  return { quantity: qty, unitPrice: price, discountType: disType, discountValue: disVal };
}

console.log('=== POS PRICING CORE — PURE UNIT TEST (PHASE B1) ===\n');

// ─── 1. No discount, no service, no tax ──────────────────────────────────────
{
  const r = computePosPricing({
    ...noDiscount(),
    ...NO_SVC_TAX,
    items: [item(2, 50000), item(1, 30000)],
  });
  eq('1a grossItems = 130000', r.grossItems, 130000);
  eq('1b itemDiscountTotal = 0', r.itemDiscountTotal, 0);
  eq('1c afterItemDiscount = 130000', r.afterItemDiscount, 130000);
  eq('1d orderDiscountAmount = 0', r.orderDiscountAmount, 0);
  eq('1e discountedSubtotal = 130000', r.discountedSubtotal, 130000);
  eq('1f serviceAmount = 0', r.serviceAmount, 0);
  eq('1g taxAmount = 0', r.taxAmount, 0);
  eq('1h totalAmount = 130000', r.totalAmount, 130000);
  eq('1i items.length = 2', r.items.length, 2);
  eq('1j line0 gross', r.items[0].lineGross, 100000);
  eq('1k line1 net', r.items[1].lineNet, 30000);
  eq('1l svc snapshot percent = 0', r.serviceChargePercentSnapshot, 0);
  eq('1m tax snapshot percent = 0', r.taxPercentSnapshot, 0);
  eq('1n svc enabled snapshot = false', r.serviceChargeEnabledSnapshot, false);
  eq('1o tax enabled snapshot = false', r.taxEnabledSnapshot, false);
}

// ─── 2. Item NOMINAL discount ────────────────────────────────────────────────
{
  const r = computePosPricing({
    ...noDiscount(),
    ...NO_SVC_TAX,
    items: [item(2, 50000, 'NOMINAL', 10000), item(1, 30000)],
  });
  eq('2a itemDiscountTotal = 10000', r.itemDiscountTotal, 10000);
  eq('2b afterItemDiscount = 120000', r.afterItemDiscount, 120000);
  eq('2c totalAmount = 120000', r.totalAmount, 120000);
  eq('2d line0 discount', r.items[0].lineDiscountAmount, 10000);
  eq('2e line0 net = 90000', r.items[0].lineNet, 90000);
}

// ─── 3. Item PERCENT discount ────────────────────────────────────────────────
{
  const r = computePosPricing({
    ...noDiscount(),
    ...NO_SVC_TAX,
    items: [item(2, 50000, 'PERCENT', 10)], // 100000 × 10% = 10000
  });
  eq('3a itemDiscountTotal = 10000', r.itemDiscountTotal, 10000);
  eq('3b totalAmount = 90000', r.totalAmount, 90000);
  eq('3c line0 discount = 10000', r.items[0].lineDiscountAmount, 10000);
}

// ─── 4. Order NOMINAL discount ──────────────────────────────────────────────
{
  const r = computePosPricing({
    orderDiscountType: 'NOMINAL',
    orderDiscountValue: 20000,
    ...NO_SVC_TAX,
    items: [item(2, 50000), item(1, 30000)],
  });
  eq('4a orderDiscountAmount = 20000', r.orderDiscountAmount, 20000);
  eq('4b discountedSubtotal = 110000', r.discountedSubtotal, 110000);
  eq('4c totalAmount = 110000', r.totalAmount, 110000);
}

// ─── 5. Order PERCENT discount ───────────────────────────────────────────────
{
  const r = computePosPricing({
    orderDiscountType: 'PERCENT',
    orderDiscountValue: 10,
    ...NO_SVC_TAX,
    items: [item(2, 50000), item(1, 30000)], // 130000 × 10% = 13000
  });
  eq('5a orderDiscountAmount = 13000', r.orderDiscountAmount, 13000);
  eq('5b totalAmount = 117000', r.totalAmount, 117000);
}

// ─── 6. Kombinasi item + order discount ─────────────────────────────────────
{
  const r = computePosPricing({
    orderDiscountType: 'PERCENT',
    orderDiscountValue: 5,
    ...NO_SVC_TAX,
    items: [item(2, 50000, 'PERCENT', 10)], // gross=100000, disc=10000 → after=90000; 5% → 4500
  });
  eq('6a afterItemDiscount = 90000', r.afterItemDiscount, 90000);
  eq('6b orderDiscountAmount = 4500', r.orderDiscountAmount, 4500);
  eq('6c totalAmount = 85500', r.totalAmount, 85500);
}

// ─── 7. Service only ─────────────────────────────────────────────────────────
{
  const r = computePosPricing({
    ...noDiscount(),
    serviceChargeEnabled: true,
    serviceChargePercent: 10,
    taxEnabled: false,
    taxPercent: 0,
    items: [item(2, 50000)],
  });
  eq('7a serviceAmount = 10000', r.serviceAmount, 10000);
  eq('7b taxAmount = 0', r.taxAmount, 0);
  eq('7c totalAmount = 110000', r.totalAmount, 110000);
  eq('7d svc percent snapshot = 10', r.serviceChargePercentSnapshot, 10);
  eq('7e svc enabled snapshot = true', r.serviceChargeEnabledSnapshot, true);
}

// ─── 8. Tax only ──��──────────────────────────────────────────────────────────
{
  const r = computePosPricing({
    ...noDiscount(),
    serviceChargeEnabled: false,
    serviceChargePercent: 0,
    taxEnabled: true,
    taxPercent: 11,
    items: [item(2, 50000)], // subtotal 100000, PPN 11% atas 100000 = 11000
  });
  eq('8a serviceAmount = 0', r.serviceAmount, 0);
  eq('8b taxAmount = 11000', r.taxAmount, 11000);
  eq('8c totalAmount = 111000', r.totalAmount, 111000);
  eq('8d tax percent snapshot = 11', r.taxPercentSnapshot, 11);
  eq('8e tax enabled snapshot = true', r.taxEnabledSnapshot, true);
}

// ─── 9. Service + tax (tax base termasuk service) ───────────────────────────
{
  // subtotal=100000 → svc 10% = 10000; PPN base = 110000 × 11% = 12100; total = 122100
  const r = computePosPricing({
    ...noDiscount(),
    serviceChargeEnabled: true,
    serviceChargePercent: 10,
    taxEnabled: true,
    taxPercent: 11,
    items: [item(2, 50000)],
  });
  eq('9a serviceAmount = 10000', r.serviceAmount, 10000);
  eq('9b taxAmount = 12100', r.taxAmount, 12100);
  eq('9c totalAmount = 122100', r.totalAmount, 122100);
}

// ─── 10. Contoh desain: discountedSubtotal=10000, svc 10% → 1000, PPN 11% atas 11000 → 1210, total 12210 ──
{
  const r = computePosPricing({
    ...noDiscount(),
    serviceChargeEnabled: true,
    serviceChargePercent: 10,
    taxEnabled: true,
    taxPercent: 11,
    items: [item(1, 10000)],
  });
  eq('10a serviceAmount = 1000', r.serviceAmount, 1000);
  eq('10b taxAmount = 1210', r.taxAmount, 1210);
  eq('10c totalAmount = 12210', r.totalAmount, 12210);
}

// ─── 11. Service disabled + percent non-zero → amount 0, snapshot percent preserved ──
{
  const r = computePosPricing({
    ...noDiscount(),
    serviceChargeEnabled: false,
    serviceChargePercent: 7.5,
    taxEnabled: false,
    taxPercent: 0,
    items: [item(1, 10000)],
  });
  eq('11a serviceAmount = 0 (disabled)', r.serviceAmount, 0);
  eq('11b svc percent snapshot = 7.5 (preserved)', r.serviceChargePercentSnapshot, 7.5);
  eq('11c svc enabled snapshot = false', r.serviceChargeEnabledSnapshot, false);
  eq('11d totalAmount = 10000', r.totalAmount, 10000);
}

// ─── 12. Tax disabled + percent non-zero → amount 0, snapshot preserved ─────
{
  const r = computePosPricing({
    ...noDiscount(),
    serviceChargeEnabled: false,
    serviceChargePercent: 0,
    taxEnabled: false,
    taxPercent: 11,
    items: [item(1, 10000)],
  });
  eq('12a taxAmount = 0 (disabled)', r.taxAmount, 0);
  eq('12b tax percent snapshot = 11 (preserved)', r.taxPercentSnapshot, 11);
  eq('12c tax enabled snapshot = false', r.taxEnabledSnapshot, false);
}

// ─── 13. 0% service/tax enabled → amount 0 ──────────────────────────────────
{
  const r = computePosPricing({
    ...noDiscount(),
    serviceChargeEnabled: true,
    serviceChargePercent: 0,
    taxEnabled: true,
    taxPercent: 0,
    items: [item(1, 10000)],
  });
  eq('13a service 0% enabled → 0', r.serviceAmount, 0);
  eq('13b tax 0% enabled → 0', r.taxAmount, 0);
  eq('13c totalAmount = 10000', r.totalAmount, 10000);
}

// ─── 14. 100% discount & 100% percent ───────────────────────────────────────
{
  // Item PERCENT 100% → net 0
  const r1 = computePosPricing({
    ...noDiscount(),
    ...NO_SVC_TAX,
    items: [item(2, 50000, 'PERCENT', 100)],
  });
  eq('14a item 100% → net 0', r1.items[0].lineNet, 0);
  eq('14b totalAmount = 0', r1.totalAmount, 0);

  // Order PERCENT 100% → subtotal habis
  const r2 = computePosPricing({
    orderDiscountType: 'PERCENT',
    orderDiscountValue: 100,
    ...NO_SVC_TAX,
    items: [item(2, 50000)],
  });
  eq('14c order 100% → discountedSubtotal 0', r2.discountedSubtotal, 0);
  eq('14d totalAmount = 0', r2.totalAmount, 0);

  // Service 100%
  const r3 = computePosPricing({
    ...noDiscount(),
    serviceChargeEnabled: true,
    serviceChargePercent: 100,
    taxEnabled: false,
    taxPercent: 0,
    items: [item(1, 10000)],
  });
  eq('14e service 100% → 10000', r3.serviceAmount, 10000);
  eq('14f totalAmount = 20000', r3.totalAmount, 20000);
}

// ─── 15. Percent 5.55 valid ──────────────────────────────────────────────────
{
  const r = computePosPricing({
    ...noDiscount(),
    serviceChargeEnabled: true,
    serviceChargePercent: 5.55,
    taxEnabled: false,
    taxPercent: 0,
    items: [item(1, 10000)],
  });
  eq('15a service 5.55% atas 10000 = 555', r.serviceAmount, 555);
  eq('15b svc snapshot = 5.55', r.serviceChargePercentSnapshot, 5.55);
}

// ─── 16. Percent 10.5 valid ──────────────────────────────────────────────────
{
  const r = computePosPricing({
    orderDiscountType: 'PERCENT',
    orderDiscountValue: 10.5,
    serviceChargeEnabled: false,
    serviceChargePercent: 0,
    taxEnabled: false,
    taxPercent: 0,
    items: [item(1, 10000)], // 10000 × 10.5% = 1050
  });
  eq('16a order 10.5% = 1050', r.orderDiscountAmount, 1050);
  eq('16b totalAmount = 8950', r.totalAmount, 8950);
}

// ─── 17. Percent > 100 reject ────────────────────────────────────────────────
rejects('17a svc percent 101 reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: true, serviceChargePercent: 101, taxEnabled: false, taxPercent: 0, items: [item(1, 10000)] }), 'PERCENT_EXCEEDS_100');
rejects('17b tax percent 150 reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: false, serviceChargePercent: 0, taxEnabled: true, taxPercent: 150, items: [item(1, 10000)] }), 'PERCENT_EXCEEDS_100');
rejects('17c order discount percent 100.5 reject', () =>
  computePosPricing({ orderDiscountType: 'PERCENT', orderDiscountValue: 100.5, ...NO_SVC_TAX, items: [item(1, 10000)] }), 'PERCENT_EXCEEDS_100');
rejects('17d item discount percent 120 reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [item(1, 10000, 'PERCENT', 120)] }), 'PERCENT_EXCEEDS_100');

// ─── 18. Percent/nominal negatif reject ─────────────────────────────────────
rejects('18a svc percent -1 reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: true, serviceChargePercent: -1, taxEnabled: false, taxPercent: 0, items: [item(1, 10000)] }), 'PERCENT_NEGATIVE');
rejects('18b tax percent -0.5 reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: false, serviceChargePercent: 0, taxEnabled: true, taxPercent: -0.5, items: [item(1, 10000)] }), 'PERCENT_NEGATIVE');
rejects('18c item discount percent -10 reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [item(1, 10000, 'PERCENT', -10)] }), 'PERCENT_NEGATIVE');
rejects('18d item discount NOMINAL -1 reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [item(1, 10000, 'NOMINAL', -1)] }), 'NEGATIVE_VALUE');
rejects('18e order discount NOMINAL -500 reject', () =>
  computePosPricing({ orderDiscountType: 'NOMINAL', orderDiscountValue: -500, ...NO_SVC_TAX, items: [item(1, 10000)] }), 'NEGATIVE_VALUE');

// ─── 19. Percent lebih dari 2 desimal reject ────────────────────────────────
rejects('19a svc percent 10.125 reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: true, serviceChargePercent: 10.125, taxEnabled: false, taxPercent: 0, items: [item(1, 10000)] }), 'PERCENT_TOO_MANY_DECIMALS');
rejects('19b tax percent 11.123 reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: false, serviceChargePercent: 0, taxEnabled: true, taxPercent: 11.123, items: [item(1, 10000)] }), 'PERCENT_TOO_MANY_DECIMALS');
rejects('19c order discount percent 5.555 reject', () =>
  computePosPricing({ orderDiscountType: 'PERCENT', orderDiscountValue: 5.555, ...NO_SVC_TAX, items: [item(1, 10000)] }), 'PERCENT_TOO_MANY_DECIMALS');
rejects('19d item discount percent 9.999 reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [item(1, 10000, 'PERCENT', 9.999)] }), 'PERCENT_TOO_MANY_DECIMALS');

// ─── 20. Item discount NOMINAL > gross reject ───────────────────────────────
rejects('20a item NOMINAL 60000 > gross 50000 reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [item(1, 50000, 'NOMINAL', 60000)] }), 'ITEM_DISCOUNT_EXCEEDS_GROSS');

// ─── 21. Order discount NOMINAL > subtotal reject ───────────────────────────
rejects('21a order NOMINAL 999999 > afterItemDiscount reject', () =>
  computePosPricing({ orderDiscountType: 'NOMINAL', orderDiscountValue: 999999, ...NO_SVC_TAX, items: [item(1, 50000)] }), 'ORDER_DISCOUNT_EXCEEDS_SUBTOTAL');

// ─── 22. Quantity invalid reject ─────────────────────────��──────────────────
rejects('22a quantity 0 reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [item(0, 10000)] }), 'INVALID_QUANTITY');
rejects('22b quantity -1 reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [item(-1, 10000)] }), 'NEGATIVE_VALUE');
rejects('22c quantity 1.5 reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [{ quantity: 1.5, unitPrice: 10000, discountType: null, discountValue: null }] }), 'NOT_SAFE_INTEGER');
rejects('22d items kosong reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [] }), 'NO_ITEMS');

// ─── 23. unitPrice & overflow reject ────────────────────────────────────────
rejects('23a unitPrice -1 reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [item(1, -1)] }), 'NEGATIVE_VALUE');
rejects('23b unitPrice 1.5 reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [{ quantity: 1, unitPrice: 1.5, discountType: null, discountValue: null }] }), 'NOT_SAFE_INTEGER');
rejects('23c overflow quantity × unitPrice reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [item(9007199254740993, 2)] }), 'NOT_SAFE_INTEGER');
rejects('23d NaN quantity reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [{ quantity: NaN, unitPrice: 10000, discountType: null, discountValue: null }] }), 'INVALID_NUMBER');
rejects('23e Infinity tax percent reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: false, serviceChargePercent: 0, taxEnabled: true, taxPercent: Infinity, items: [item(1, 10000)] }), 'INVALID_NUMBER');
rejects('23f overflow hasil perkalian reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [item(3037000500, 3037000500)] }), 'OVERFLOW');

// ─── 24/25. Invariants ───────────────────────────────────────────────────────
{
  const r = computePosPricing({
    orderDiscountType: 'PERCENT',
    orderDiscountValue: 5,
    serviceChargeEnabled: true,
    serviceChargePercent: 10,
    taxEnabled: true,
    taxPercent: 11,
    items: [item(3, 45000, 'NOMINAL', 5000), item(2, 25000, 'PERCENT', 12)],
  });
  eq('24 invariant total = subtotal+svc+tax', r.totalAmount, r.discountedSubtotal + r.serviceAmount + r.taxAmount);
  eq('25 invariant afterItem = gross - itemDisc', r.afterItemDiscount, r.grossItems - r.itemDiscountTotal);
  ok('25b semua output safe integer',
    [r.grossItems, r.itemDiscountTotal, r.afterItemDiscount, r.orderDiscountAmount,
     r.discountedSubtotal, r.serviceAmount, r.taxAmount, r.totalAmount]
      .every(v => Number.isSafeInteger(v)));
  ok('25c line results safe integer',
    r.items.every(l => Number.isSafeInteger(l.lineGross) && Number.isSafeInteger(l.lineDiscountAmount) && Number.isSafeInteger(l.lineNet)));
}

// ─── 26/27. Rounding examples ────────────────────────────────────────────────
{
  // 650 × 10% = 65
  const r1 = computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [item(1, 650, 'PERCENT', 10)] });
  eq('26 rounding 650×10% = 65', r1.items[0].lineDiscountAmount, 65);

  // 6551 × 10% = 655.1 → Math.round → 655
  const r2 = computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [item(1, 6551, 'PERCENT', 10)] });
  eq('27 rounding 6551×10% = 655 (bukan 656)', r2.items[0].lineDiscountAmount, 655);

  // Tax rounding: (10000 + 1000) × 11% = 1210 (tepat, contoh desain)
  const r3 = computePosPricing({
    ...noDiscount(),
    serviceChargeEnabled: true, serviceChargePercent: 10,
    taxEnabled: true, taxPercent: 11,
    items: [item(1, 10000)],
  });
  eq('27b tax base termasuk service → 1210', r3.taxAmount, 1210);
}

// ─── 28. Invalid discount type string reject ───────────────────────��───────
rejects('28a orderDiscountType "GAMBLANG" reject', () =>
  computePosPricing({ orderDiscountType: 'GAMBLANG', orderDiscountValue: 1000, ...NO_SVC_TAX, items: [item(1, 10000)] }), 'INVALID_DISCOUNT_TYPE');
rejects('28b item discountType "persen" reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [{ quantity: 1, unitPrice: 10000, discountType: 'persen', discountValue: 10 }] }), 'INVALID_DISCOUNT_TYPE');

// ─── 29. discountValue terisi tapi discountType null → reject ─────────────
rejects('29a inconsistent item discount reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [{ quantity: 1, unitPrice: 10000, discountType: null, discountValue: 5000 }] }), 'INCONSISTENT_DISCOUNT');
rejects('29b inconsistent order discount reject', () =>
  computePosPricing({ orderDiscountType: null, orderDiscountValue: 5000, ...NO_SVC_TAX, items: [item(1, 10000)] }), 'INCONSISTENT_ORDER_DISCOUNT');

// ─── 30. NOMINAL discount string/angka desimal reject ───────────────────────
rejects('30a item NOMINAL desimal 10.5 reject', () =>
  computePosPricing({ ...noDiscount(), ...NO_SVC_TAX, items: [item(1, 10000, 'NOMINAL', 10.5)] }), 'NOT_SAFE_INTEGER');
rejects('30b order NOMINAL string "abc" reject', () =>
  computePosPricing({ orderDiscountType: 'NOMINAL', orderDiscountValue: NaN, ...NO_SVC_TAX, items: [item(1, 10000)] }), 'INVALID_NUMBER');

// ─── 31. STRICT boolean — rejection non-boolean coercion (financial core) ───
// Kontrak: serviceChargeEnabled / taxEnabled HANYA valid bila typeof === 'boolean'.
// String "false"/"true", angka 1/0, null, undefined, object SEMUA ditolak.
rejects('31a serviceChargeEnabled="false" reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: 'false', serviceChargePercent: 10, taxEnabled: false, taxPercent: 0, items: [item(1, 10000)] }), 'INVALID_BOOLEAN');
rejects('31b serviceChargeEnabled=1 reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: 1, serviceChargePercent: 10, taxEnabled: false, taxPercent: 0, items: [item(1, 10000)] }), 'INVALID_BOOLEAN');
rejects('31c serviceChargeEnabled=0 reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: 0, serviceChargePercent: 0, taxEnabled: false, taxPercent: 0, items: [item(1, 10000)] }), 'INVALID_BOOLEAN');
rejects('31d serviceChargeEnabled=null reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: null, serviceChargePercent: 0, taxEnabled: false, taxPercent: 0, items: [item(1, 10000)] }), 'INVALID_BOOLEAN');
rejects('31e taxEnabled="true" reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: false, serviceChargePercent: 0, taxEnabled: 'true', taxPercent: 11, items: [item(1, 10000)] }), 'INVALID_BOOLEAN');
rejects('31f taxEnabled=null reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: false, serviceChargePercent: 0, taxEnabled: null, taxPercent: 0, items: [item(1, 10000)] }), 'INVALID_BOOLEAN');
rejects('31g taxEnabled=1 reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: false, serviceChargePercent: 0, taxEnabled: 1, taxPercent: 11, items: [item(1, 10000)] }), 'INVALID_BOOLEAN');
rejects('31h serviceChargeEnabled={} reject', () =>
  computePosPricing({ ...noDiscount(), serviceChargeEnabled: {}, serviceChargePercent: 0, taxEnabled: false, taxPercent: 0, items: [item(1, 10000)] }), 'INVALID_BOOLEAN');

// Boolean false/true valid — snapshot memakai flag ASLI (bukan coercion):
{
  const rFalse = computePosPricing({
    ...noDiscount(),
    serviceChargeEnabled: false,
    serviceChargePercent: 7.5,
    taxEnabled: false,
    taxPercent: 11,
    items: [item(1, 10000)],
  });
  ok('31i boolean false valid → amount 0, snapshot preserved',
    rFalse.serviceAmount === 0 && rFalse.taxAmount === 0 &&
    rFalse.serviceChargePercentSnapshot === 7.5 && rFalse.taxPercentSnapshot === 11 &&
    rFalse.serviceChargeEnabledSnapshot === false && rFalse.taxEnabledSnapshot === false);

  const rTrue = computePosPricing({
    ...noDiscount(),
    serviceChargeEnabled: true,
    serviceChargePercent: 10,
    taxEnabled: true,
    taxPercent: 11,
    items: [item(1, 10000)],
  });
  ok('31j boolean true valid → amount dihitung',
    rTrue.serviceAmount === 1000 && rTrue.taxAmount === 1210 &&
    rTrue.serviceChargeEnabledSnapshot === true && rTrue.taxEnabledSnapshot === true);
}

// ─── Ringkasan ───────────────────────────────────────────────────────────────
console.log('\n========================================');
if (failed > 0) {
  console.error(`RINGKASAN: PASS ${passed} / FAIL ${failed}`);
  for (const f of failures) console.error('  FAIL → ' + f);
  process.exit(1);
} else {
  console.log(`ALL ${passed} POS PRICING CORE TESTS PASSED!`);
  console.log('========================================');
  process.exit(0);
}
