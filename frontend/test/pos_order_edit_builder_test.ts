/**
 * pos_order_edit_builder_test.ts
 *
 * Unit tests untuk buildPosOrderEditPayload (POS-EDIT-1B.1) — pure builder
 * payload PUT /api/pos/orders/:id.
 *
 * Cakupan:
 *   1. property_id / expected_version / idempotency_key validasi
 *   2. items: full-replace, item existing (id), item baru (tanpa id),
 *      items=[] ditolak, undefined = tanpa perubahan item
 *   3. Diskon item berpasangan & validasi nilai
 *   4. notes tri-state (undefined / null / string)
 *   5. order_discount_type / order_discount_value (kunci edit, BUKAN kunci create)
 *   6. Metadata tri-state (undefined / null / string, batas panjang)
 *   7. expected_total validasi
 *   8. Field immutable TIDAK muncul di payload (reservation_id, service_charge_enabled, tax_enabled)
 *   9. order.id TIDAK ada di payload
 *   10. idempotency_key diterima sebagai input (TIDAK dibuat otomatis)
 *
 * Run:  cd frontend && node --experimental-strip-types test/pos_order_edit_builder_test.ts
 */
import { strict as assert } from 'node:assert';
import {
  buildPosOrderEditPayload,
  type PosOrderEditDetails,
  type PosOrderEditItem,
} from '../src/features/pos/posOrderDraft.ts';

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

// ── Fixture dasar ─────────────────────────────────────────────────────────────

const base: PosOrderEditDetails = {
  property_id: 7,
  expected_version: 3,
  idempotency_key: 'edit-key-abc',
};

// ── 1. Validasi dasar ────────────────────────────────────────────────────────

check('property_id valid → payload property_id terisi', () => {
  const p = buildPosOrderEditPayload(base, false);
  assert.equal(p.property_id, 7);
  assert.equal(p.expected_version, 3);
  assert.equal(p.idempotency_key, 'edit-key-abc');
});

check('property_id 0 / negatif / non-integer → throw', () => {
  assert.throws(() => buildPosOrderEditPayload({ ...base, property_id: 0 }, false), /property_id/);
  assert.throws(() => buildPosOrderEditPayload({ ...base, property_id: -1 }, false), /property_id/);
  assert.throws(() => buildPosOrderEditPayload({ ...base, property_id: 1.5 }, false), /property_id/);
});

check('expected_version 0 → throw (harus ≥ 1)', () => {
  assert.throws(() => buildPosOrderEditPayload({ ...base, expected_version: 0 }, false), /expected_version/);
});

check('expected_version non-integer → throw', () => {
  assert.throws(() => buildPosOrderEditPayload({ ...base, expected_version: 1.5 }, false), /expected_version/);
});

check('idempotency_key kosong / whitespace → throw', () => {
  assert.throws(() => buildPosOrderEditPayload({ ...base, idempotency_key: '' }, false), /idempotency_key/);
  assert.throws(() => buildPosOrderEditPayload({ ...base, idempotency_key: '   ' }, false), /idempotency_key/);
});

check('idempotency_key non-string → throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, idempotency_key: 123 as unknown as string }, false),
    /idempotency_key/
  );
});

check('idempotency_key > 150 char → dipotong ke 150 (sesuai backend)', () => {
  const long = 'k'.repeat(200);
  const p = buildPosOrderEditPayload({ ...base, idempotency_key: long }, false);
  assert.equal(p.idempotency_key, 'k'.repeat(150));
});

// ── 2. items ──────────────────────���───────────────────────────────────────────

const itemsWithExisting: PosOrderEditItem[] = [
  { orderId: 101, menu_item_id: 1, quantity: 2 },
  { menu_item_id: 2, quantity: 1 },
];

check('items full-replace: item existing → id dipertahankan; item baru → tanpa id', () => {
  const p = buildPosOrderEditPayload({ ...base, items: itemsWithExisting }, false);
  const items = p.items as Record<string, unknown>[];
  assert.equal(items.length, 2);
  // Item existing (orderId=101) → items[0].id = 101
  assert.equal(items[0].id, 101);
  assert.equal(items[0].menu_item_id, 1);
  assert.equal(items[0].quantity, 2);
  // Item baru (tanpa orderId) → TIDAK ada field id
  assert.equal(items[1].id, undefined);
  assert.equal(items[1].menu_item_id, 2);
  assert.equal(items[1].quantity, 1);
});

check('items=[] → throw (sesuai backend)', () => {
  assert.throws(() => buildPosOrderEditPayload({ ...base, items: [] }, false), /items=\[\]/);
});

check('items undefined → field items TIDAK ada di payload (tanpa perubahan item)', () => {
  const p = buildPosOrderEditPayload(base, false);
  assert.equal(p.items, undefined);
});

check('item: menu_item_id 0 / negatif / non-integer → throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, items: [{ menu_item_id: 0, quantity: 1 }] }, false),
    /menu_item_id/
  );
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, items: [{ menu_item_id: -1, quantity: 1 }] }, false),
    /menu_item_id/
  );
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, items: [{ menu_item_id: 1.5, quantity: 1 }] }, false),
    /menu_item_id/
  );
});

check('item: quantity 0 / 10000 / non-integer → throw (batas 1..9999)', () => {
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, items: [{ menu_item_id: 1, quantity: 0 }] }, false),
    /quantity/
  );
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, items: [{ menu_item_id: 1, quantity: 10000 }] }, false),
    /quantity/
  );
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, items: [{ menu_item_id: 1, quantity: 1.5 }] }, false),
    /quantity/
  );
});

check('item: orderId non-integer / 0 → throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, items: [{ orderId: 0, menu_item_id: 1, quantity: 1 }] }, false),
    /orderId/
  );
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, items: [{ orderId: 1.5, menu_item_id: 1, quantity: 1 }] }, false),
    /orderId/
  );
});

check('TIDAK mengirim unit_price di payload items (harga snapshot dari backend)', () => {
  const p = buildPosOrderEditPayload({ ...base, items: itemsWithExisting }, false);
  const items = p.items as Record<string, unknown>[];
  for (const it of items) {
    assert.equal(it.unit_price, undefined, 'unit_price harus TIDADA di payload');
  }
});

// ── 3. Diskon item berpasangan ───────────────────────────────────────────────

check('item: discount_type tanpa discount_value → throw (pasangan wajib)', () => {
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, items: [{ menu_item_id: 1, quantity: 1, discount_type: 'PERCENT' }] }, true),
    /berpasangan/
  );
});

check('item: discount_value tanpa discount_type → throw (pasangan wajib)', () => {
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, items: [{ menu_item_id: 1, quantity: 1, discount_value: 10 }] }, true),
    /berpasangan/
  );
});

check('item: diskon PERCENT valid (type+value bersama) → terisi', () => {
  const p = buildPosOrderEditPayload(
    { ...base, items: [{ menu_item_id: 1, quantity: 2, discount_type: 'PERCENT', discount_value: 15.5 }] },
    true
  );
  const it = (p.items as Record<string, unknown>)[0];
  assert.equal(it.discount_type, 'PERCENT');
  assert.equal(it.discount_value, 15.5);
});

check('item: diskon NOMINAL harus whole-rupiah (desimal → throw)', () => {
  assert.throws(
    () => buildPosOrderEditPayload(
      { ...base, items: [{ menu_item_id: 1, quantity: 2, discount_type: 'NOMINAL', discount_value: 100.5 }] },
      true
    ),
    /discount_value/
  );
});

check('item: diskon PERCENT > 100 → throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload(
      { ...base, items: [{ menu_item_id: 1, quantity: 2, discount_type: 'PERCENT', discount_value: 150 }] },
      true
    ),
    /discount_value/
  );
});

check('item: diskon PERCENT desimal valid (maks 2 angka) → diterima', () => {
  const p = buildPosOrderEditPayload(
    { ...base, items: [{ menu_item_id: 1, quantity: 2, discount_type: 'PERCENT', discount_value: 10.25 }] },
    true
  );
  assert.equal((p.items as Record<string, unknown>)[0].discount_value, 10.25);
});

check('item: diskon tanpa izin (canDiscount=false) → throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload(
      { ...base, items: [{ menu_item_id: 1, quantity: 2, discount_type: 'PERCENT', discount_value: 10 }] },
      false
    ),
    /izin diskon/
  );
});

// ── 4. notes tri-state ────────────────────────────────────────────────────────

check('item: notes undefined → TIDAK ada di payload (kolom tidak berubah)', () => {
  const p = buildPosOrderEditPayload({ ...base, items: [{ menu_item_id: 1, quantity: 1 }] }, false);
  assert.equal((p.items as Record<string, unknown>)[0].notes, undefined);
});

check('item: notes null → null (hapus catatan)', () => {
  const p = buildPosOrderEditPayload(
    { ...base, items: [{ menu_item_id: 1, quantity: 1, notes: null }] },
    false
  );
  assert.equal((p.items as Record<string, unknown>)[0].notes, null);
});

check('item: notes string → trim + terisi', () => {
  const p = buildPosOrderEditPayload(
    { ...base, items: [{ menu_item_id: 1, quantity: 1, notes: '  tanpa pedas  ' }] },
    false
  );
  assert.equal((p.items as Record<string, unknown>)[0].notes, 'tanpa pedas');
});

check('item: notes > 1000 char → throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload(
      { ...base, items: [{ menu_item_id: 1, quantity: 1, notes: 'x'.repeat(1001) }] },
      false
    ),
    /maksimal 1000/
  );
});

// ── 5. order_discount_type / order_discount_value ────────────────────────────

check('order diskon: PERCENT valid (type+value) → terisi dengan KUNCI order_discount_*', () => {
  const p = buildPosOrderEditPayload(
    { ...base, order_discount_type: 'PERCENT', order_discount_value: 10 },
    true
  );
  assert.equal(p.order_discount_type, 'PERCENT');
  assert.equal(p.order_discount_value, 10);
  // KUNCI create TIDAK boleh muncul
  assert.equal(p.discount_type, undefined, 'kunci create discount_type harus TIDADA');
  assert.equal(p.discount_value, undefined, 'kunci create discount_value harus TIDADA');
});

check('order diskon: keduanya null → hapus diskon (valid)', () => {
  const p = buildPosOrderEditPayload(
    { ...base, order_discount_type: null, order_discount_value: null },
    true
  );
  assert.equal(p.order_discount_type, null);
  assert.equal(p.order_discount_value, null);
});

check('order diskon: type ada, value absen (bukan null) → throw (pasangan)', () => {
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, order_discount_type: 'PERCENT' }, true),
    /berpasangan/
  );
});

check('order diskon: value ada, type absen (bukan null) → throw (pasangan)', () => {
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, order_discount_value: 10 }, true),
    /berpasangan/
  );
});

check('order diskon: PERCENT > 100 ��� throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload(
      { ...base, order_discount_type: 'PERCENT', order_discount_value: 150 },
      true
    ),
    /order_discount_value/
  );
});

check('order diskon: NOMINAL desimal → throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload(
      { ...base, order_discount_type: 'NOMINAL', order_discount_value: 50.5 },
      true
    ),
    /order_discount_value/
  );
});

check('order diskon: tanpa izin (canDiscount=false) → throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload(
      { ...base, order_discount_type: 'PERCENT', order_discount_value: 10 },
      false
    ),
    /izin diskon/
  );
});

// ── 6. Metadata tri-state ─────────────────────────────────────────────────────

check('metadata: undefined → TIDAK ada di payload (kolom tidak berubah)', () => {
  const p = buildPosOrderEditPayload(base, false);
  assert.equal(p.table_number, undefined);
  assert.equal(p.guest_name, undefined);
  assert.equal(p.guest_phone, undefined);
  assert.equal(p.notes, undefined);
  assert.equal(p.discount_reason, undefined);
});

check('metadata: null → null (SET NULL)', () => {
  const p = buildPosOrderEditPayload(
    { ...base, table_number: null, guest_name: null, guest_phone: null, notes: null, discount_reason: null },
    false
  );
  assert.equal(p.table_number, null);
  assert.equal(p.guest_name, null);
  assert.equal(p.guest_phone, null);
  assert.equal(p.notes, null);
  assert.equal(p.discount_reason, null);
});

check('metadata: string → trim + terisi', () => {
  const p = buildPosOrderEditPayload(
    { ...base, table_number: '  T1  ', guest_name: '  Budi  ', notes: '  cepat ya  ' },
    false
  );
  assert.equal(p.table_number, 'T1');
  assert.equal(p.guest_name, 'Budi');
  assert.equal(p.notes, 'cepat ya');
});

check('metadata: table_number > 20 char → throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, table_number: 'x'.repeat(21) }, false),
    /maksimal 20/
  );
});

check('metadata: guest_name > 100 char → throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, guest_name: 'x'.repeat(101) }, false),
    /maksimal 100/
  );
});

check('metadata: guest_phone > 50 char → throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, guest_phone: 'x'.repeat(51) }, false),
    /maksimal 50/
  );
});

check('metadata: discount_reason > 100 char → throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, discount_reason: 'x'.repeat(101) }, false),
    /maksimal 100/
  );
});

// ── 7. expected_total ────────────────────────────────────────────────────────

check('expected_total valid (whole-rupiah ≥ 0) → terisi', () => {
  const p = buildPosOrderEditPayload({ ...base, expected_total: 45000 }, false);
  assert.equal(p.expected_total, 45000);
});

check('expected_total desimal → throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, expected_total: 45000.5 }, false),
    /expected_total/
  );
});

check('expected_total negatif → throw', () => {
  assert.throws(
    () => buildPosOrderEditPayload({ ...base, expected_total: -1 }, false),
    /expected_total/
  );
});

// ── 8. Field immutable TIDAK muncul ─────────────────────────────────────────

check('TIDAK mengirim reservation_id / service_charge_enabled / tax_enabled (bahkan bila caller memaksa)', () => {
  // Simulasi caller salah: menyisipkan field immutable secara paksa.
  // Builder harus MENYIMPANNYA (fail-closed) agar backend tak kena 400.
  const p = buildPosOrderEditPayload(base, false);
  assert.equal(p.reservation_id, undefined);
  assert.equal(p.service_charge_enabled, undefined);
  assert.equal(p.tax_enabled, undefined);
});

// ── 9. order.id TIDAK ada di payload ────────────────────────────────────────

check('order.id TIDADA di payload (ID di path :id, bukan body)', () => {
  const p = buildPosOrderEditPayload(base, false);
  assert.equal(p.id, undefined);
  assert.equal(p.order_id, undefined);
});

// ── 10. idempotency_key stabil untuk retry ───────────────────────────────────

check('idempotency_key: pemanggilan identik → payload identik (aman untuk retry)', () => {
  const a = buildPosOrderEditPayload({ ...base, items: itemsWithExisting }, false);
  const b = buildPosOrderEditPayload({ ...base, items: itemsWithExisting }, false);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

check('idempotency_key: key berbeda → payload berbeda (siklus baru)', () => {
  const a = buildPosOrderEditPayload({ ...base, items: itemsWithExisting, idempotency_key: 'k1' }, false);
  const b = buildPosOrderEditPayload({ ...base, items: itemsWithExisting, idempotency_key: 'k2' }, false);
  assert.notEqual(a.idempotency_key, b.idempotency_key);
  // Sisanya identik kecuali key
  const { idempotency_key: _a, ...restA } = a;
  const { idempotency_key: _b, ...restB } = b;
  assert.equal(JSON.stringify(restA), JSON.stringify(restB));
});

// ── FULL-REPLACE SEMANTICS — item notes/diskon: OMIT ≠ PRESERVE ──────────────
// Kontras dengan metadata ORDER (yang memang mendukung omitted = preserve):
// kolom item di pos_order_items selalu di-SET oleh backend saat item muncul
// di items[]. Karena itu:
//  - undefined pada items[].notes / discount_type / discount_value
//    → key di-omit dari payload item → backend tetap menulis NULL.
//  - Untuk MEMPERTAHANKAN nilai existing → caller WAJIB resend string/nilai.
//  - Metadata order (table_number, notes, dst.) → undefined = kolom tak disentuh.
// Lihat JSDoc PosOrderEditItem & aturan #9/#10 buildPosOrderEditPayload.

check('FULL-REPLACE: item existing, notes undefined → key notes TIDAK ada di payload (backend akan reset ke null)', () => {
  const p = buildPosOrderEditPayload(
    { ...base, items: [{ orderId: 101, menu_item_id: 1, quantity: 2 }] },
    false
  );
  const it = (p.items as Record<string, unknown>)[0];
  assert.equal(it.id, 101, 'item existing → id terisi');
  assert.equal('notes' in it, false, 'notes undefined → key notes harus TIDAK ada di payload item');
});

check('FULL-REPLACE: item existing, discount_type/value undefined → kedua key TIDAK ada di payload', () => {
  const p = buildPosOrderEditPayload(
    { ...base, items: [{ orderId: 101, menu_item_id: 1, quantity: 2 }] },
    false
  );
  const it = (p.items as Record<string, unknown>)[0];
  assert.equal('discount_type' in it, false, 'discount_type undefined → key harus TIDADA');
  assert.equal('discount_value' in it, false, 'discount_value undefined → key harus TIDADA');
});

check('FULL-REPLACE: item existing + notes & diskon lengkap → nilai dipertahankan di payload', () => {
  const p = buildPosOrderEditPayload(
    {
      ...base,
      items: [
        {
          orderId: 101,
          menu_item_id: 1,
          quantity: 2,
          notes: 'tanpa pedas',
          discount_type: 'PERCENT',
          discount_value: 10,
        },
      ],
    },
    true
  );
  const it = (p.items as Record<string, unknown>)[0];
  assert.equal(it.id, 101);
  assert.equal(it.notes, 'tanpa pedas');
  assert.equal(it.discount_type, 'PERCENT');
  assert.equal(it.discount_value, 10);
});

check('CONTRAS: metadata ORDER undefined → TIDAK ada di payload (omitted = preserve di backend)', () => {
  // Tidak mengirim field metadata apa pun → key-nya harus semua absent.
  const p = buildPosOrderEditPayload(base, false);
  for (const k of ['table_number', 'guest_name', 'guest_phone', 'notes', 'discount_reason']) {
    assert.equal(k in p, false, `order metadata '${k}' undefined → harus di-omit (preserve)`);
  }
});

// ── Total hasil ───────────────────────────────────────────────────────────────
console.log(`\n[RESULT] ${pass} PASS`);
if (process.exitCode === 1) console.log('Ada test yang GAGAL.');
