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
  type PosCartLine,
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

console.log(`\n[RESULT] ${pass} PASS, ${process.exitCode ? 'SOME FAILED' : '0 FAIL'}`);
