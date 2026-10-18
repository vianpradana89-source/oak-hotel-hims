/**
 * pos_order_draft_test.ts
 *
 * Unit tests for posOrderDraft.ts — per-order Service Charge & PPN overrides.
 * Covers:
 *   1. previewPosDraft with pricing params (svc/tax enabled/disabled/absent)
 *   2. buildPosOrderDraft payload: explicit true/false, expected_total
 *   3. Backward compatibility: absent fields → payload omits svc/tax keys
 *   4. Strict boolean validation: null/string/number rejected
 *   5. expected_total validation: safe integer ≥ 0
 *   6. canonical formula: base → svc → tax → total
 *
 * Run:  cd frontend && node --experimental-strip-types test/pos_order_draft_test.ts
 */
import { strict as assert } from 'node:assert';
import {
  previewPosDraft,
  buildPosOrderDraft,
  normalizeDiscountInput,
  effectiveDiscount,
  type PosCartLine,
  type PosDiscountType,
  type PosDraftDetails,
  type PosPricingPreviewParams,
} from '../src/features/pos/posOrderDraft.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const plain: PosCartLine = { item: { id: 1, name: 'Coffee', price: 13_000 }, qty: 2 };
const lines: PosCartLine[] = [plain];

const details: PosDraftDetails = {
  propertyId: 7,
  reservationId: null,
  tableNumber: 'A1',
  guestName: 'Walk-in',
  guestPhone: '',
  notes: '',
  discountType: '',
  discountInput: '',
  discountReason: '',
};

let pass = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// ── 1. previewPosDraft: backward compat (no pricing param) ─────────────────

check('previewPosDraft no pricing param → svc=0, tax=0, total unchanged (backward compat)', () => {
  const p = previewPosDraft(lines, '', '');
  assert.equal(p.serviceCharge, 0);
  assert.equal(p.tax, 0);
  assert.equal(p.total, 26_000);
});

check('previewPosDraft with empty pricing → same as absent', () => {
  const p = previewPosDraft(lines, '', '', {});
  assert.equal(p.serviceCharge, 0);
  assert.equal(p.tax, 0);
  assert.equal(p.total, 26_000);
});

// ── 2. Canonical formula ────────────────────────────────────────────────────

check('Canonical formula: 13000×2, svc 10%, PPN 11% → total = 26000 + 2600 + 3146 = 31746', () => {
  // base = 26000 (no discount)
  // svc  = round(26000 * 10 / 100) = 2600
  // tax  = round((26000 + 2600) * 11 / 100) = round(2975) = 3146
  // total = 26000 + 2600 + 3146 = 31746
  const pricing: PosPricingPreviewParams = {
    serviceChargeEnabled: true,
    serviceChargePercent: 10,
    taxEnabled: true,
    taxPercent: 11,
  };
  const p = previewPosDraft(lines, '', '', pricing);
  assert.equal(p.serviceCharge, 2600, `svc expected 2600, got ${p.serviceCharge}`);
  assert.equal(p.tax, 3146, `tax expected 3146, got ${p.tax}`);
  assert.equal(p.total, 31746, `total expected 31746, got ${p.total}`);
});

check('svc OFF, PPN ON: tax basis is base only (no svc)', () => {
  // base = 26000
  // svc  = 0 (disabled)
  // tax  = round(26000 * 11 / 100) = 2860
  // total = 26000 + 0 + 2860 = 28860
  const pricing: PosPricingPreviewParams = {
    serviceChargeEnabled: false,
    serviceChargePercent: 10,
    taxEnabled: true,
    taxPercent: 11,
  };
  const p = previewPosDraft(lines, '', '', pricing);
  assert.equal(p.serviceCharge, 0);
  assert.equal(p.tax, 2860, `tax expected 2860, got ${p.tax}`);
  assert.equal(p.total, 28860, `total expected 28860, got ${p.total}`);
});

check('svc ON, PPN OFF: no tax in total', () => {
  // base = 26000, svc = 2600, tax = 0
  // total = 28600
  const pricing: PosPricingPreviewParams = {
    serviceChargeEnabled: true,
    serviceChargePercent: 10,
    taxEnabled: false,
    taxPercent: 11,
  };
  const p = previewPosDraft(lines, '', '', pricing);
  assert.equal(p.serviceCharge, 2600);
  assert.equal(p.tax, 0);
  assert.equal(p.total, 28600, `total expected 28600, got ${p.total}`);
});

check('Both ON with discount: base after discount is the tax basis', () => {
  // 13000×2 = 26000 gross, order discount NOMINAL 1000
  // base = 25000
  // svc  = round(25000 * 10 / 100) = 2500
  // tax  = round((25000 + 2500) * 11 / 100) = round(2925) = 3025
  // total = 25000 + 2500 + 3025 = 30525
  const pricing: PosPricingPreviewParams = {
    serviceChargeEnabled: true,
    serviceChargePercent: 10,
    taxEnabled: true,
    taxPercent: 11,
  };
  const p = previewPosDraft(lines, 'NOMINAL', '1000', pricing);
  assert.equal(p.orderDiscount, 1000);
  assert.equal(p.serviceCharge, 2500, `svc expected 2500, got ${p.serviceCharge}`);
  assert.equal(p.tax, 3025, `tax expected 3025, got ${p.tax}`);
  assert.equal(p.total, 30525, `total expected 30525, got ${p.total}`);
});

check('Rounding: 101×1 with 50% svc → round(101*0.5)=51 (not 50.5)', () => {
  const single: PosCartLine[] = [{ item: { id: 1, name: 'Item', price: 101 }, qty: 1 }];
  const pricing: PosPricingPreviewParams = { serviceChargeEnabled: true, serviceChargePercent: 50 };
  const p = previewPosDraft(single, '', '', pricing);
  assert.equal(p.serviceCharge, 51, `svc expected 51 (round 50.5), got ${p.serviceCharge}`);
});

// ── 3. buildPosOrderDraft: payload shape ────────────────────────────────────

check('buildPosOrderDraft: explicit true → payload has service_charge_enabled=true, tax_enabled=true', () => {
  const payload = buildPosOrderDraft(lines, {
    ...details,
    serviceChargeEnabled: true,
    taxEnabled: true,
    expectedTotal: 31756,
  }, false);
  assert.equal(payload.service_charge_enabled, true);
  assert.equal(payload.tax_enabled, true);
  assert.equal(payload.expected_total, 31756);
});

check('buildPosOrderDraft: explicit false → payload has service_charge_enabled=false, tax_enabled=false', () => {
  const payload = buildPosOrderDraft(lines, {
    ...details,
    serviceChargeEnabled: false,
    taxEnabled: false,
  }, false);
  assert.equal(payload.service_charge_enabled, false);
  assert.equal(payload.tax_enabled, false);
  assert.equal('expected_total' in payload, false, 'expected_total absent when not set');
});

check('buildPosOrderDraft: absent fields → payload omits svc/tax keys (backward compat)', () => {
  const payload = buildPosOrderDraft(lines, details, false);
  assert.equal('service_charge_enabled' in payload, false);
  assert.equal('tax_enabled' in payload, false);
  assert.equal('expected_total' in payload, false);
});

check('buildPosOrderDraft: expected_total only sent when explicitly set', () => {
  const p1 = buildPosOrderDraft(lines, { ...details, expectedTotal: 0 }, false);
  assert.equal(p1.expected_total, 0, 'expected_total=0 is valid and sent');
  const p2 = buildPosOrderDraft(lines, details, false);
  assert.equal('expected_total' in p2, false, 'absent expected_total → key omitted');
});

// ── 4. Strict boolean validation ────────────────────────────────────────────

check('buildPosOrderDraft: null rejected (not a strict boolean)', () => {
  assert.throws(
    () => buildPosOrderDraft(lines, { ...details, serviceChargeEnabled: null as unknown as boolean }, false),
    /harus boolean strict/,
  );
});

check('buildPosOrderDraft: string "true" rejected', () => {
  assert.throws(
    () => buildPosOrderDraft(lines, { ...details, serviceChargeEnabled: 'true' as unknown as boolean }, false),
    /harus boolean strict/,
  );
});

check('buildPosOrderDraft: number 1 rejected', () => {
  assert.throws(
    () => buildPosOrderDraft(lines, { ...details, taxEnabled: 1 as unknown as boolean }, false),
    /harus boolean strict/,
  );
});

check('buildPosOrderDraft: taxEnabled null rejected', () => {
  assert.throws(
    () => buildPosOrderDraft(lines, { ...details, taxEnabled: null as unknown as boolean }, false),
    /harus boolean strict/,
  );
});

// ── 5. expected_total validation ────────────────────────────────────────────

check('expected_total: negative rejected', () => {
  assert.throws(
    () => buildPosOrderDraft(lines, { ...details, expectedTotal: -1 }, false),
    /harus whole-rupiah integer ≥ 0/,
  );
});

check('expected_total: non-integer (float) rejected', () => {
  assert.throws(
    () => buildPosOrderDraft(lines, { ...details, expectedTotal: 100.5 }, false),
    /harus whole-rupiah integer ≥ 0/,
  );
});

check('expected_total: safe integer 0 accepted', () => {
  const p = buildPosOrderDraft(lines, { ...details, expectedTotal: 0 }, false);
  assert.equal(p.expected_total, 0);
});

// ── 6. Integration: preview matches build expected_total ───────────────────

check('previewPosDraft total matches expected_total sent in buildPosOrderDraft', () => {
  const pricing: PosPricingPreviewParams = {
    serviceChargeEnabled: true,
    serviceChargePercent: 10,
    taxEnabled: true,
    taxPercent: 11,
  };
  const preview = previewPosDraft(lines, '', '', pricing);
  const payload = buildPosOrderDraft(lines, {
    ...details,
    serviceChargeEnabled: true,
    taxEnabled: true,
    expectedTotal: preview.total,
  }, false);
  assert.equal(payload.expected_total, preview.total, 'expected_total must equal preview.total');
  assert.equal(payload.expected_total, 31746);
});

check('previewPosDraft with svc+tax OFF gives same total as absent (backward compat)', () => {
  const pOff = previewPosDraft(lines, '', '', { serviceChargeEnabled: false, taxEnabled: false });
  const pAbsent = previewPosDraft(lines, '', '');
  assert.equal(pOff.total, pAbsent.total, 'explicit OFF must equal absent for zero-percent scenarios');
});

// ── 7. Discount input normalization & effectiveDiscount ─────────────────────
// Regression: UI diskon baru (input angka langsung + satuan Rp/%).
// Keputusan #5: input kosong = tanpa diskon (bukan error).
// Keputusan #6: nilai 0 = tanpa diskon, permission tidak teraktifkan.
// Keputusan #4: Rp bulat, % maks 100 & maks 2 desimal.
// Keputusan #3: leading-zero tidak boleh menghasilkan 01/05/0050.

check('normalizeDiscountInput: 01 → 1, 0050 → 50, 0 → 0 (leading-zero strip)', () => {
  assert.equal(normalizeDiscountInput('01', 'NOMINAL'), '1');
  assert.equal(normalizeDiscountInput('0050', 'NOMINAL'), '50');
  assert.equal(normalizeDiscountInput('0', 'NOMINAL'), '0');
});

check('normalizeDiscountInput: 0.5, 10.25, 0.05 preserved (PERCENT decimal)', () => {
  assert.equal(normalizeDiscountInput('0.5', 'PERCENT'), '0.5');
  assert.equal(normalizeDiscountInput('10.25', 'PERCENT'), '10.25');
  assert.equal(normalizeDiscountInput('0.05', 'PERCENT'), '0.05');
});

check('normalizeDiscountInput: 1.001 → 1.00 (PERCENT 2-decimal limit)', () => {
  assert.equal(normalizeDiscountInput('1.001', 'PERCENT'), '1.00');
});

check('normalizeDiscountInput: empty stays empty', () => {
  assert.equal(normalizeDiscountInput('', 'NOMINAL'), '');
  assert.equal(normalizeDiscountInput('', 'PERCENT'), '');
});

check('effectiveDiscount: empty/0 → no discount (type cleared)', () => {
  for (const [t, inp] of [['NOMINAL','0'],['NOMINAL',''],['PERCENT','0'],['PERCENT','']]) {
    const r = effectiveDiscount(t as PosDiscountType, inp);
    assert.equal(r.type, '', `${t} ${JSON.stringify(inp)} → type cleared`);
    assert.equal(r.input, '', `${t} ${JSON.stringify(inp)} → input cleared`);
  }
  // Positive value keeps type:
  const r1 = effectiveDiscount('NOMINAL', '100');
  assert.equal(r1.type, 'NOMINAL');
  assert.equal(r1.input, '100');
  const r2 = effectiveDiscount('PERCENT', '5.5');
  assert.equal(r2.type, 'PERCENT');
  assert.equal(r2.input, '5.5');
});

check('previewPosDraft: 0.5% PERCENT order discount on 13000 → 65', () => {
  const p = previewPosDraft(
    [{ item: { id: 1, name: 'Coffee', price: 13_000 }, qty: 1 }],
    'PERCENT', '0.5',
  );
  assert.equal(p.orderDiscount, 65, `expected 65, got ${p.orderDiscount}`);
});

check('previewPosDraft: 10.25% PERCENT order discount on 10000 → 1025', () => {
  const p = previewPosDraft(
    [{ item: { id: 1, name: 'X', price: 10_000 }, qty: 1 }],
    'PERCENT', '10.25',
  );
  assert.equal(p.orderDiscount, 1_025, `expected 1025, got ${p.orderDiscount}`);
});

check('previewPosDraft: 0% PERCENT discount = no discount (total unchanged)', () => {
  const p = previewPosDraft(lines, 'PERCENT', '0');
  assert.equal(p.orderDiscount, 0);
  assert.equal(p.total, 26_000, 'total unchanged when 0% discount');
});

check('previewPosDraft: line discount 0.5% on 13000 → 65', () => {
  const p = previewPosDraft(
    [{ item: { id: 1, name: 'Coffee', price: 13_000 }, qty: 1, discountType: 'PERCENT', discountInput: '0.5' }],
    '', '',
  );
  assert.equal(p.lines[0].discount, 65);
  assert.equal(p.lines[0].net, 12_935);
});

check('previewPosDraft: 100% PERCENT line discount → total 0', () => {
  const p = previewPosDraft(
    [{ item: { id: 1, name: 'Coffee', price: 13_000 }, qty: 1, discountType: 'PERCENT', discountInput: '100' }],
    '', '',
  );
  assert.equal(p.lines[0].discount, 13_000);
  assert.equal(p.total, 0);
});

check('previewPosDraft: discount exceeding basis → throw', () => {
  assert.throws(
    () => previewPosDraft(
      [{ item: { id: 1, name: 'Coffee', price: 13_000 }, qty: 1, discountType: 'NOMINAL', discountInput: '13001' }],
      '', '',
    ),
    /Diskon melebihi subtotal/,
  );
  assert.throws(
    () => previewPosDraft(lines, 'NOMINAL', '61001'),
    /Diskon melebihi subtotal/,
  );
});

check('buildPosOrderDraft: PERCENT 0 → no discount_type in payload, no permission needed', () => {
  const payload = buildPosOrderDraft(
    [{ item: { id: 1, name: 'Coffee', price: 13_000 }, qty: 1, discountType: 'PERCENT', discountInput: '0' }],
    { ...details, discountType: 'PERCENT', discountInput: '0' },
    false, // no permission
  );
  assert.equal('discount_type' in payload, false, 'order discount_type absent');
  assert.equal('discount_type' in payload.items[0], false, 'item discount_type absent');
});

check('buildPosOrderDraft: empty input = no discount, no permission, no payload field', () => {
  const payload = buildPosOrderDraft(
    [{ item: { id: 1, name: 'Coffee', price: 13_000 }, qty: 1, discountType: 'NOMINAL', discountInput: '' }],
    { ...details, discountType: 'NOMINAL', discountInput: '' },
    false,
  );
  assert.equal('discount_type' in payload, false);
  assert.equal('discount_type' in payload.items[0], false);
});

check('buildPosOrderDraft: positive line discount still requires permission', () => {
  assert.throws(
    () => buildPosOrderDraft(
      [{ item: { id: 1, name: 'Coffee', price: 13_000 }, qty: 3, discountType: 'NOMINAL', discountInput: '5000' }],
      details,
      false,
    ),
    /izin diskon/,
  );
});

check('buildPosOrderDraft: PERCENT 50% on 13000 → discount_value=50 in payload', () => {
  const payload = buildPosOrderDraft(
    [{ item: { id: 1, name: 'Coffee', price: 13_000 }, qty: 1, discountType: 'PERCENT', discountInput: '50' }],
    { ...details, discountType: 'PERCENT', discountInput: '50' },
    true,
  );
  assert.equal(payload.items[0].discount_type, 'PERCENT');
  assert.equal(payload.items[0].discount_value, 50, 'discount_value is the percent, not the rupiah amount');
});

// ── 8. Invalid PERCENT input: tidak valid tidak diubah diam-diam (regression) ─

check('normalizeDiscountInput PERCENT: invalid characters not silently stripped', () => {
  // Karakter tidak valid dalam bagian desimal TIDAK dihapus diam-diam;
  // nilai dilewatkan apa adanya ke discount() sehingga validasi regex menolak.
  assert.equal(normalizeDiscountInput('1.a5', 'PERCENT'), '1.a5', 'huruf a tidak dihapus');
  assert.equal(normalizeDiscountInput('1.-5', 'PERCENT'), '1.-5', 'tanda minus tidak dihapus');
  assert.equal(normalizeDiscountInput('1e2', 'PERCENT'), '1e2', 'e (scientific) tidak dihapus');
  assert.equal(normalizeDiscountInput('NaN', 'PERCENT'), 'NaN', 'huruf NaN tidak dihapus');
});

check('previewPosDraft PERCENT: invalid inputs throw (not silently converted)', () => {
  // Setiap input berikut TIDAK menghasilkan diskon positif valid;
  // discount() melempar error karena regex /^\d+(\.\d{1,2})?$/ gagal.
  // Catatan: '1.5' PERCENT = 1.5% (VALID) — hanya '1.5' NOMINAL yang invalid.
  for (const inp of ['1.a5', '1.-5', '1e2', 'NaN']) {
    assert.throws(
      () => previewPosDraft(lines, 'PERCENT', inp),
      /Diskon persen maksimal dua angka desimal/,
      `expected throw for ${JSON.stringify(inp)}`,
    );
  }
});

check('previewPosDraft PERCENT: valid decimals still work', () => {
  // Perilaku valid yang dipertahankan.
  const p1 = previewPosDraft(lines, 'PERCENT', '0.5');
  assert.equal(p1.orderDiscount, 130, '0.5% of 26000 = 130');
  const p2 = previewPosDraft(lines, 'PERCENT', '10.25');
  assert.equal(p2.orderDiscount, 2665, '10.25% of 26000 = 2665');
  const p3 = previewPosDraft(lines, 'PERCENT', '1.00');
  assert.equal(p3.orderDiscount, 260, '1.00% of 26000 = 260');
});

console.log(`\n[RESULT] ${pass} PASS, ${process.exitCode ? 'SOME FAILED' : '0 FAIL'}`);
