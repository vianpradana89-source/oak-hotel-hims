/**
 * booking_create_context_test.js
 * Unit 3A — DB-free tests for bookingCreateContextService pure helpers.
 *
 * Run: node test/booking_create_context_test.js
 * No Pool, no server, no storage, no DB side effects.
 */
'use strict';
const assert = require('node:assert');
const {
  resolveRequestKey,
  buildBookingCreateFingerprint,
  buildEvidenceDescriptor,
  deriveDpReceiptKey
} = require('../dist/domains/reservations/bookingCreateContextService');

// Shared fixtures
const INTENT_PAY_BILL = { mode: 'PAY_BILL', ordinaryAmount: 500000, advanceAmount: 0, paymentMethod: 'CASH', evidencePath: null, legacy: false };
const INTENT_ADVANCE_1 = { mode: 'ADVANCE_PAYMENT', ordinaryAmount: 0, advanceAmount: 250000, paymentMethod: 'CASH', evidencePath: null, legacy: false };
const INTENT_ADVANCE_2 = { mode: 'ADVANCE_PAYMENT', ordinaryAmount: 0, advanceAmount: 250000, paymentMethod: 'CASH', evidencePath: null, legacy: false };
const INTENT_UNPAID   = { mode: 'UNPAID', ordinaryAmount: 0, advanceAmount: 0, paymentMethod: null, evidencePath: null, legacy: false };
const SNAP_BASE = { check_in: '2026-11-20', check_out: '2026-11-22', room_type_id: 7, rate: 650000, ota_channel: 'DIRECT' };

let passed = 0, failed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { failed++; console.error('FAIL: ' + name + '\n  ' + e.message); }
}
function expect400(fn, codePrefix) {
  try { fn(); assert.fail('expected 400 domain error, no error thrown'); }
  catch (e) {
    assert.strictEqual(e.statusCode, 400, `expected statusCode 400, got ${e.statusCode}`);
    if (codePrefix) assert.ok(String(e.code).startsWith(codePrefix),
      `expected code starting with "${codePrefix}", got "${e.code}"`);
  }
}
// ─── 1. resolveRequestKey ─────────────────────────────────────────────────────
console.log('\n[1] resolveRequestKey');
ok('header + body same → returns trimmed key', () => {
  const r = resolveRequestKey({ headerKey: ' abc-123 ', bodyKey: 'abc-123', explicit: true });
  assert.strictEqual(r, 'abc-123');
});
ok('header only, explicit → returns header key', () => {
  const r = resolveRequestKey({ headerKey: 'K1', bodyKey: undefined, explicit: true });
  assert.strictEqual(r, 'K1');
});
ok('body only, explicit → returns body key', () => {
  const r = resolveRequestKey({ headerKey: null, bodyKey: 'K2', explicit: true });
  assert.strictEqual(r, 'K2');
});
ok('both blank, legacy → null', () => {
  const r = resolveRequestKey({ headerKey: '', bodyKey: '  ', explicit: false });
  assert.strictEqual(r, null);
});
ok('both absent, explicit → 400 REQUEST_KEY_REQUIRED', () => {
  try {
    resolveRequestKey({ headerKey: undefined, bodyKey: undefined, explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('REQUEST_KEY_REQUIRED')); }
});
ok('two different nonblank aliases → 400 CONFLICT', () => {
  try {
    resolveRequestKey({ headerKey: 'AAA', bodyKey: 'BBB', explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('CONFLICT')); }
});
ok('header is array → 400 type invalid', () => {
  try {
    resolveRequestKey({ headerKey: ['x'], bodyKey: null, explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('TYPE_INVALID')); }
});
ok('header is boolean → 400 type invalid', () => {
  try {
    resolveRequestKey({ headerKey: true, bodyKey: null, explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('TYPE_INVALID')); }
});
ok('header is number → 400 type invalid (U3A-F03: no String() coercion)', () => {
  try {
    resolveRequestKey({ headerKey: 42, bodyKey: null, explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('TYPE_INVALID')); }
});
ok('body is number → 400 type invalid (U3A-F03)', () => {
  try {
    resolveRequestKey({ headerKey: null, bodyKey: 123, explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('TYPE_INVALID')); }
});
ok('header is object → 400 type invalid (U3A-F03)', () => {
  try {
    resolveRequestKey({ headerKey: { id: 1 }, bodyKey: null, explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('TYPE_INVALID')); }
});
ok('header is bigint → 400 type invalid (U3A-F03)', () => {
  try {
    resolveRequestKey({ headerKey: 1n, bodyKey: null, explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('TYPE_INVALID')); }
});
ok('header is function → 400 type invalid (U3A-F03)', () => {
  try {
    resolveRequestKey({ headerKey: () => {}, bodyKey: null, explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('TYPE_INVALID')); }
});
ok('body is symbol → 400 type invalid (U3A-F03)', () => {
  try {
    resolveRequestKey({ headerKey: null, bodyKey: Symbol('s'), explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('TYPE_INVALID')); }
});
ok('body is boolean false → 400 type invalid (U3A-F03)', () => {
  try {
    resolveRequestKey({ headerKey: null, bodyKey: false, explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('TYPE_INVALID')); }
});
ok('key with invalid char (space) → 400', () => {
  try {
    resolveRequestKey({ headerKey: 'has space', bodyKey: null, explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('REQUEST_KEY_INVALID')); }
});
ok('key exactly 200 chars OK', () => {
  const k = 'a'.repeat(200);
  assert.strictEqual(resolveRequestKey({ headerKey: k, bodyKey: null, explicit: true }), k);
});
ok('key 201 chars → 400', () => {
  try {
    resolveRequestKey({ headerKey: 'a'.repeat(201), bodyKey: null, explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); }
});

// ─── 2. buildBookingCreateFingerprint ────────────────────────────────────────
console.log('\n[2] buildBookingCreateFingerprint');
ok('same snapshot + intent → deterministic FP (same hex)', () => {
  const a = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  const b = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  assert.strictEqual(a, b);
  assert.strictEqual(a.length, 64);
});
ok('different propertyId → different FP', () => {
  const a = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  const b = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 2, childCount: 1 });
  assert.notStrictEqual(a, b);
});
ok('ADVANCE intent (childCount=1) → different FP vs PAY_BILL same snapshot', () => {
  const payBill = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  const advance = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_ADVANCE_1, propertyId: 1, childCount: 1 });
  assert.notStrictEqual(payBill, advance);
});
ok('childCount 1 vs 2 → different FP (scope change)', () => {
  const one = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  const two = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 2 });
  assert.notStrictEqual(one, two);
});
ok('UNPAID intent → different FP vs PAY_BILL', () => {
  const unpaid = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_UNPAID, propertyId: 1, childCount: 1 });
  const payBill = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  assert.notStrictEqual(unpaid, payBill);
});
ok('snapshot key order does NOT matter (same FP)', () => {
  const s1 = { a: 1, b: 2, c: 3 };
  const s2 = { c: 3, a: 1, b: 2 };
  const f1 = buildBookingCreateFingerprint({ businessSnapshot: s1, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  const f2 = buildBookingCreateFingerprint({ businessSnapshot: s2, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  assert.strictEqual(f1, f2);
});
ok('child array order DOES matter (different FP)', () => {
  const s1 = { children: [ {id:1, name:'A'}, {id:2, name:'B'} ] };
  const s2 = { children: [ {id:2, name:'B'}, {id:1, name:'A'} ] };
  const f1 = buildBookingCreateFingerprint({ businessSnapshot: s1, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 2 });
  const f2 = buildBookingCreateFingerprint({ businessSnapshot: s2, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 2 });
  assert.notStrictEqual(f1, f2);
});
ok('null vs absent field → different FP', () => {
  const s1 = { discount: null };
  const s2 = {};
  const f1 = buildBookingCreateFingerprint({ businessSnapshot: s1, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  const f2 = buildBookingCreateFingerprint({ businessSnapshot: s2, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  assert.notStrictEqual(f1, f2);
});
ok('leading-zero string preserved in FP (not coerced to number)', () => {
  const s1 = { phone: '081234' };
  const s2 = { phone: '81234' };
  const f1 = buildBookingCreateFingerprint({ businessSnapshot: s1, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  const f2 = buildBookingCreateFingerprint({ businessSnapshot: s2, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  assert.notStrictEqual(f1, f2);
});
ok('input snapshot not mutated by buildBookingCreateFingerprint', () => {
  const snap = { check_in: '2026-11-20', children: [{id:1}] };
  const snapCopy = JSON.parse(JSON.stringify(snap));
  buildBookingCreateFingerprint({ businessSnapshot: snap, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  assert.deepStrictEqual(snap, snapCopy);
});
ok('UNPAID + evidenceDescriptor → 400 UNPAID_EVIDENCE_CONFLICT', () => {
  const desc = buildEvidenceDescriptor({ bytes: Buffer.from('x'), mime: 'application/pdf' });
  try {
    buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_UNPAID, propertyId: 1, childCount: 1, evidenceDescriptor: desc });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('UNPAID_EVIDENCE_CONFLICT')); }
});
ok('childCount=0 → 400 CHILD_COUNT_INVALID (U3A-F04)', () => {
  expect400(() => buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 0 }), 'CHILD_COUNT_INVALID');
});
ok('childCount=-1 → 400 CHILD_COUNT_INVALID', () => {
  expect400(() => buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: -1 }), 'CHILD_COUNT_INVALID');
});
ok('childCount=1.5 (fractional) → 400 CHILD_COUNT_INVALID', () => {
  expect400(() => buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1.5 }), 'CHILD_COUNT_INVALID');
});
ok('childCount=1 → valid FP (ROOM_RESERVATION scope)', () => {
  const fp = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  assert.strictEqual(fp.length, 64);
});
ok('childCount=2 → valid FP (BOOKING_GROUP scope)', () => {
  const fp = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 2 });
  assert.strictEqual(fp.length, 64);
});

// ─── 3. buildEvidenceDescriptor ──────────────────────────────────────────────
console.log('\n[3] buildEvidenceDescriptor');
ok('same bytes + different filename → same sha256 (stable)', () => {
  const bytes = Buffer.from('hello');
  const d1 = buildEvidenceDescriptor({ bytes, filename: 'a.pdf' });
  const d2 = buildEvidenceDescriptor({ bytes, filename: 'b.pdf' });
  assert.strictEqual(d1.sha256, d2.sha256);
  assert.strictEqual(d1.byteLength, d2.byteLength);
});
ok('same filename + different bytes → different sha256', () => {
  const d1 = buildEvidenceDescriptor({ bytes: Buffer.from('abc'), filename: 'f.pdf' });
  const d2 = buildEvidenceDescriptor({ bytes: Buffer.from('abd'), filename: 'f.pdf' });
  assert.notStrictEqual(d1.sha256, d2.sha256);
});
ok('declaredSize matching bytes.length → OK', () => {
  const d = buildEvidenceDescriptor({ bytes: Buffer.from('12345'), declaredSize: 5, mime: 'application/pdf' });
  assert.strictEqual(d.byteLength, 5);
  assert.strictEqual(d.mime, 'application/pdf');
});
ok('declaredSize mismatch → 400', () => {
  try {
    buildEvidenceDescriptor({ bytes: Buffer.from('12345'), declaredSize: 999 });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('SIZE_MISMATCH')); }
});
ok('bytes not Buffer/Uint8Array → 400', () => {
  try {
    buildEvidenceDescriptor({ bytes: 'not-a-buffer' });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('BYTES_INVALID')); }
});
ok('bytes is null → 400', () => {
  try {
    buildEvidenceDescriptor({ bytes: null });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('BYTES_INVALID')); }
});
ok('deterministic: same input called twice → same descriptor', () => {
  const bytes = Buffer.from([1,2,3]);
  const d1 = buildEvidenceDescriptor({ bytes, mime: 'image/png' });
  const d2 = buildEvidenceDescriptor({ bytes, mime: 'image/png' });
  assert.deepStrictEqual(d1, d2);
});

// ─── 4. deriveDpReceiptKey ────────────────────────────────────────────────────
console.log('\n[4] deriveDpReceiptKey');
ok('ADVANCE + valid requestKey → returns key ≤150 chars', () => {
  const key = deriveDpReceiptKey({ propertyId: 1, requestKey: 'my-key', intent: INTENT_ADVANCE_1 });
  assert.ok(key !== null, 'key should not be null for ADVANCE');
  assert.ok(key.length <= 150, `key length ${key.length} > 150`);
  assert.ok(key.startsWith('dp:'), 'key must have dp: namespace');
});
ok('same inputs → deterministic key', () => {
  const a = deriveDpReceiptKey({ propertyId: 1, requestKey: 'abc', intent: INTENT_ADVANCE_1 });
  const b = deriveDpReceiptKey({ propertyId: 1, requestKey: 'abc', intent: INTENT_ADVANCE_1 });
  assert.strictEqual(a, b);
});
ok('different propertyId → different key', () => {
  const a = deriveDpReceiptKey({ propertyId: 1, requestKey: 'abc', intent: INTENT_ADVANCE_1 });
  const b = deriveDpReceiptKey({ propertyId: 2, requestKey: 'abc', intent: INTENT_ADVANCE_1 });
  assert.notStrictEqual(a, b);
});
ok('different requestKey → different key', () => {
  const a = deriveDpReceiptKey({ propertyId: 1, requestKey: 'abc', intent: INTENT_ADVANCE_1 });
  const b = deriveDpReceiptKey({ propertyId: 1, requestKey: 'xyz', intent: INTENT_ADVANCE_1 });
  assert.notStrictEqual(a, b);
});
ok('non-ADVANCE intent → null (no fake receipt key)', () => {
  assert.strictEqual(deriveDpReceiptKey({ propertyId: 1, requestKey: 'abc', intent: INTENT_PAY_BILL }), null);
  assert.strictEqual(deriveDpReceiptKey({ propertyId: 1, requestKey: 'abc', intent: INTENT_UNPAID }), null);
});
ok('empty requestKey → null', () => {
  assert.strictEqual(deriveDpReceiptKey({ propertyId: 1, requestKey: '', intent: INTENT_ADVANCE_1 }), null);
});
ok('key is NOT the raw request key (namespace separated)', () => {
  const key = deriveDpReceiptKey({ propertyId: 1, requestKey: 'my-booking-key', intent: INTENT_ADVANCE_1 });
  assert.ok(key !== 'my-booking-key', 'DP key must not equal raw request key');
  assert.ok(key.includes('dp:'), 'DP key has dp: namespace prefix');
});

// ─── 5. U3A-F01: evidence filename not in FP identity ────────────────────────
console.log('\n[5] U3A-F01: evidence filename not in FP identity');
ok('same bytes + MIME + size, different filename → SAME FP (U3A-F01)', () => {
  const bytes = Buffer.from('test-file-content');
  const d1 = buildEvidenceDescriptor({ bytes, filename: 'invoice.pdf', mime: 'application/pdf' });
  const d2 = buildEvidenceDescriptor({ bytes, filename: 'receipt.pdf', mime: 'application/pdf' });
  const fp1 = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_ADVANCE_1, propertyId: 1, childCount: 1, evidenceDescriptor: d1 });
  const fp2 = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_ADVANCE_1, propertyId: 1, childCount: 1, evidenceDescriptor: d2 });
  assert.strictEqual(fp1, fp2, 'same bytes+MIME+size with different filename must produce same FP');
});
ok('same filename, different bytes → DIFFERENT FP (U3A-F01)', () => {
  const d1 = buildEvidenceDescriptor({ bytes: Buffer.from('aaa'), filename: 'doc.pdf', mime: 'application/pdf' });
  const d2 = buildEvidenceDescriptor({ bytes: Buffer.from('bbb'), filename: 'doc.pdf', mime: 'application/pdf' });
  const fp1 = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_ADVANCE_1, propertyId: 1, childCount: 1, evidenceDescriptor: d1 });
  const fp2 = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_ADVANCE_1, propertyId: 1, childCount: 1, evidenceDescriptor: d2 });
  assert.notStrictEqual(fp1, fp2, 'different bytes must produce different FP');
});
ok('buildEvidenceDescriptor still returns filename for audit (U3A-F01)', () => {
  const d = buildEvidenceDescriptor({ bytes: Buffer.from('x'), filename: 'audit-name.txt', mime: 'text/plain' });
  assert.strictEqual(d.filename, 'audit-name.txt', 'filename must be in descriptor for audit');
  assert.ok(d.sha256, 'sha256 must be present');
});
ok('no evidenceDescriptor vs with evidenceDescriptor → different FP', () => {
  const desc = buildEvidenceDescriptor({ bytes: Buffer.from('evidence-bytes'), mime: 'application/pdf' });
  const fpNo  = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_ADVANCE_1, propertyId: 1, childCount: 1 });
  const fpYes = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_ADVANCE_1, propertyId: 1, childCount: 1, evidenceDescriptor: desc });
  assert.notStrictEqual(fpNo, fpYes);
});
ok('evidenceDescriptor with same sha256+MIME, different filename → same FP via descriptor', () => {
  // Simulate two descriptors that differ only in filename
  const bytes = Buffer.from('identical-bytes');
  const descA = { sha256: 'aaaa', byteLength: 15, mime: 'application/pdf', filename: 'a.pdf' };
  const descB = { sha256: 'aaaa', byteLength: 15, mime: 'application/pdf', filename: 'b.pdf' };
  const fpA = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_ADVANCE_1, propertyId: 1, childCount: 1, evidenceDescriptor: descA });
  const fpB = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_ADVANCE_1, propertyId: 1, childCount: 1, evidenceDescriptor: descB });
  assert.strictEqual(fpA, fpB, 'filename must not affect FP');
});
ok('UNPAID + evidenceDescriptor still rejected (UNPAID gate not weakened)', () => {
  const desc = buildEvidenceDescriptor({ bytes: Buffer.from('x'), mime: 'application/pdf' });
  expect400(() => buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_UNPAID, propertyId: 1, childCount: 1, evidenceDescriptor: desc }), 'UNPAID_EVIDENCE_CONFLICT');
});

// ─── 6. U3A-F02: businessSnapshot nested, not spread ───────────────��─────────
console.log('\n[6] U3A-F02: businessSnapshot nested, not spread');
ok('businessSnapshot with _fp_context key does NOT overwrite generated context (U3A-F02)', () => {
  const snapA = { ...SNAP_BASE, _fp_context: { malicious: true } };
  const snapB = { ...SNAP_BASE };
  const fpA = buildBookingCreateFingerprint({ businessSnapshot: snapA, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  const fpB = buildBookingCreateFingerprint({ businessSnapshot: snapB, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  assert.notStrictEqual(fpA, fpB, 'different businessSnapshot (with _fp_context key) must produce different FP');
});
ok('same businessSnapshot content (key order irrelevant) → same FP (U3A-F02)', () => {
  const s1 = { b: 2, a: 1, c: 3 };
  const s2 = { a: 1, b: 2, c: 3 };
  const fp1 = buildBookingCreateFingerprint({ businessSnapshot: s1, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  const fp2 = buildBookingCreateFingerprint({ businessSnapshot: s2, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  assert.strictEqual(fp1, fp2, 'key order within businessSnapshot must not affect FP');
});
ok('businessSnapshot not mutated after call (U3A-F02)', () => {
  const snap = { check_in: '2026-11-20', extra: 'field', _fp_context: { original: true } };
  const snapCopy = JSON.parse(JSON.stringify(snap));
  buildBookingCreateFingerprint({ businessSnapshot: snap, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  assert.deepStrictEqual(snap, snapCopy, 'input businessSnapshot must not be mutated');
});
ok('different businessSnapshot values → different FP (U3A-F02)', () => {
  const s1 = { ...SNAP_BASE, rate: 650000 };
  const s2 = { ...SNAP_BASE, rate: 700000 };
  const fp1 = buildBookingCreateFingerprint({ businessSnapshot: s1, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  const fp2 = buildBookingCreateFingerprint({ businessSnapshot: s2, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  assert.notStrictEqual(fp1, fp2);
});

// ─── 7. Intent field changes → FP changes ────────────────────────────────────
console.log('\n[7] Intent field changes → FP changes');
ok('different ordinaryAmount → different FP', () => {
  const i1 = { ...INTENT_PAY_BILL, ordinaryAmount: 500000 };
  const i2 = { ...INTENT_PAY_BILL, ordinaryAmount: 600000 };
  const fp1 = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: i1, propertyId: 1, childCount: 1 });
  const fp2 = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: i2, propertyId: 1, childCount: 1 });
  assert.notStrictEqual(fp1, fp2);
});
ok('different advanceAmount → different FP', () => {
  const i1 = { ...INTENT_ADVANCE_1, advanceAmount: 250000 };
  const i2 = { ...INTENT_ADVANCE_1, advanceAmount: 300000 };
  const fp1 = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: i1, propertyId: 1, childCount: 1 });
  const fp2 = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: i2, propertyId: 1, childCount: 1 });
  assert.notStrictEqual(fp1, fp2);
});
ok('different paymentMethod → different FP', () => {
  const i1 = { ...INTENT_PAY_BILL, paymentMethod: 'CASH' };
  const i2 = { ...INTENT_PAY_BILL, paymentMethod: 'TRANSFER' };
  const fp1 = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: i1, propertyId: 1, childCount: 1 });
  const fp2 = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: i2, propertyId: 1, childCount: 1 });
  assert.notStrictEqual(fp1, fp2);
});
ok('different intent mode → different FP', () => {
  const fpPB = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  const fpAP = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_ADVANCE_1, propertyId: 1, childCount: 1 });
  assert.notStrictEqual(fpPB, fpAP);
});

// ─── 8. U3A-F03: alias invalid on both sources ───────────────────────────────
console.log('\n[8] U3A-F03: alias invalid on both sources');
ok('both header and body are number → 400 (first source hits, still 400)', () => {
  try {
    resolveRequestKey({ headerKey: 42, bodyKey: 99, explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('TYPE_INVALID')); }
});
ok('header is valid string, body is number → 400 (both sources validated)', () => {
  try {
    resolveRequestKey({ headerKey: 'valid-key', bodyKey: 123, explicit: true });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('TYPE_INVALID')); }
});
ok('legacy mode: both aliases absent → null (still valid)', () => {
  const r = resolveRequestKey({ headerKey: undefined, bodyKey: undefined, explicit: false });
  assert.strictEqual(r, null);
});
ok('legacy mode: one alias number → 400 even in legacy mode', () => {
  try {
    resolveRequestKey({ headerKey: 7, bodyKey: undefined, explicit: false });
    assert.fail('no error');
  } catch (e) { assert.strictEqual(e.statusCode, 400); assert.ok(e.code.includes('TYPE_INVALID')); }
});

// ─── 9. U3A-F04: childCount single vs group ───────────────────────────────────
console.log('\n[9] U3A-F04: childCount single vs group');
ok('childCount=1 vs childCount=2 → different FP (scope change, both valid)', () => {
  const fp1 = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 1 });
  const fp2 = buildBookingCreateFingerprint({ businessSnapshot: SNAP_BASE, intent: INTENT_PAY_BILL, propertyId: 1, childCount: 2 });
  assert.notStrictEqual(fp1, fp2);
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('\n───────────────────────────────────────────────────');
console.log(`Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);

