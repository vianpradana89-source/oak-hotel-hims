export type PosDiscountType = '' | 'NOMINAL' | 'PERCENT';
export interface PosCartLine {
  item: {id: number; name: string; price: number | string};
  qty: number;
  discountType?: PosDiscountType;
  discountInput?: string;
  notes?: string;
}
export interface PosDraftDetails {
  propertyId: number;
  reservationId: number | null;
  tableNumber: string;
  guestName: string;
  guestPhone: string;
  notes: string;
  discountType: PosDiscountType;
  discountInput: string;
  discountReason: string;
  /**
   * Per-order Service Charge override (strict boolean).
   *   - true  = kasir ON-eksplisit (hanya valid bila properti mengizinkan)
   *   - false = kasir OFF-eksplisit
   *   - absent = mengikuti properti (backward compat)
   */
  serviceChargeEnabled?: boolean;
  /** Per-order PBJT override (strict boolean). Semantik sama dengan serviceChargeEnabled. */
  taxEnabled?: boolean;
  /**
   * Nominal total yang ditampilkan kasir sebelum submit (whole rupiah ≥ 0).
   * Backend bandingkan dengan computed total; mismatch → 409 PRICING_TOTAL_CHANGED.
   * opsional — bila ada, dikirim sebagai integer.
   */
  expectedTotal?: number;
}
export interface PosDraftPreview {
  gross: number;
  itemDiscount: number;
  subtotal: number;
  orderDiscount: number;
  /** Nominal Service Charge (whole rupiah). 0 bila disabled. */
  serviceCharge: number;
  /** Nominal PBJT (whole rupiah). 0 bila disabled. */
  tax: number;
  /** Total = subtotal − orderDiscount + serviceCharge + tax (semua whole rupiah). */
  total: number;
  lines: {gross: number; discount: number; net: number}[];
}

/**
 * Parametrisasi estimasi Service Charge & PBJT per draft.
 * Persentase selalu berasal dari pengaturan properti (backend authority).
 * `serviceChargePercent` / `taxPercent` bersifat 0..100, maks. 2 desimal.
 */
export interface PosPricingPreviewParams {
  serviceChargeEnabled?: boolean;
  serviceChargePercent?: number;
  taxEnabled?: boolean;
  taxPercent?: number;
}
function discount(type: PosDiscountType, input: string, basis: number): {value: number | null; amount: number} {
  if (type === '') return {value: null, amount: 0};
  if (type !== 'NOMINAL' && type !== 'PERCENT') throw new Error('Jenis diskon tidak valid.');
  const trimmed = input.trim();
  if (!(type === 'NOMINAL' ? /^\d+$/ : /^\d+(\.\d{1,2})?$/).test(trimmed))
    throw new Error(type === 'NOMINAL' ? 'Diskon nominal harus berupa rupiah bulat.' : 'Diskon persen maksimal dua angka desimal.');
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 9999999999.99 || (type === 'NOMINAL' && !Number.isSafeInteger(value)))
    throw new Error('Nilai diskon tidak valid.');
  if (type === 'PERCENT' && value > 100) throw new Error('Diskon persen maksimal 100%.');
  const amount = type === 'NOMINAL' ? value : Math.round(basis * value / 100);
  if (amount > basis) throw new Error('Diskon melebihi subtotal.');
  return {value, amount};
}

/**
 * Normalisasi input angka diskon dari UI:
 *
 * Perilaku per jenis:
 *  - NOMINAL: hanya strip leading zeros (01→1, 0050→50). Karakter desimal
 *    atau non-digit (mis. '1.5', '-1', '1e3') DITETAPKAN sebagai-isinya —
 *    tidak diubah menjadi nilai valid; validasi di discount() akan menolak.
 *  - PERCENT: selain strip leading zeros, bagian setelah titik desimal
 *    dibatasi 2 digit (1.001 → 1.00; 0.5, 10.25, 0.05 tetap).
 *  - Strip leading zeros hanya berlaku bila digit nol di depan diikuti
 *    digit lain: 01 → 1, 0050 → 50; tetapi 0, 0.5, 0.05 TIDAK berubah
 *    (regex ^0+(?=\d) tidak cocok karena titik bukan digit).
 *  - Input kosong → tetap kosong (= tanpa diskon).
 *
 * Jaminan penting (keputusan #4): nilai yang tidak valid secara sintaks
 * (mis. '-1', '1e3', 'NaN', '1.5' untuk NOMINAL) TIDAK dikonversi secara
 * diam-diam menjadi nilai valid; nilai tersebut dilewatkan apa adanya ke
 * discount() sehingga validasi regex/range melempar error — bukan diam-diam
 * menghasilkan diskon positif yang berbeda dari yang diketik user.
 *
 * Di-export untuk dipakai oleh PosWorkspace (onChange input) & test.
 */
export function normalizeDiscountInput(raw: string, type: PosDiscountType): string {
  // Kosong / tanpa diskon → kosong.
  if (raw === '') return '';
  let s = raw;
  if (type === 'PERCENT') {
    // Batasi 2 angka desimal: '1.001' → '1.00', '0.5' tetap '0.5'.
    // PENTING: hanya batasi panjang desimal bila seluruh bagian desimal
    // terdiri dari digit. Jika mengandung karakter tidak valid (huruf,
    // tanda, dll — mis. '1.a5', '1.-5'), biarkan apa adanya agar
    // discount() menolak (regex /^\d+(\.\d{1,2})?$/ gagal).
    // Tidak boleh secara diam-diam menghapus karakter tidak valid
    // karena itu menghasilkan nilai valid yang berbeda dari input user.
    const dot = s.indexOf('.');
    if (dot !== -1) {
      const int = s.slice(0, dot);
      const dec = s.slice(dot + 1);
      // Hanya batasi desimal bila dec seluruhnya digit.
      if (/^\d+$/.test(dec)) {
        s = int + '.' + dec.slice(0, 2);
      }
      // Jika dec mengandung karakter tidak valid → s tetap raw (discount() akan reject).
    }
  }
  // Strip leading zeros hanya bila diikuti digit lain:
  //   01 → 1, 0050 → 50, tetapi 0.5 → 0.5, 0 → 0.
  //   (regex ^0+(?=\d) tidak cocok bila setelah 0 ada titik atau string habis)
  s = s.replace(/^0+(?=\d)/, '');
  return s;
}

/**
 * Diskon EFEKTIF: nilai kosong ATAU 0 berarti TIDAK ADA diskon
 * (type dinormalisasi ke ''). Ini membuat:
 *  - permission diskon tidak teraktifkan untuk nilai nol/kosong,
 *  - payload tidak mengirim diskon nol (tidak ada discount_type/value 0),
 *  - preview menampilkan 0 untuk item/order discount.
 * Nilai > 0 mengembalikan (type, input) yang tetap valid untuk discount().
 */
export function effectiveDiscount(type: PosDiscountType, input: string): {type: PosDiscountType; input: string} {
  const t = (type || '') as PosDiscountType;
  if (t === '') return {type: '', input: ''};
  const trimmed = input.trim();
  // Kosong = tanpa diskon (keputusan #5).
  if (trimmed === '') return {type: '', input: ''};
  // Nol eksplisit = tanpa diskon (keputusan #6). Cek string untuk menghindari
  // mengkonversi nilai invalid (mis. '-1', '1e3') menjadi Number dan
  // mengira itu "nol" — nilai invalid harus tetap melewati discount()
  // agar validasi regex/range melempar error.
  if (trimmed === '0' || trimmed === '0.0' || trimmed === '0.00') return {type: '', input: ''};
  return {type: t, input: trimmed};
}
export function previewPosDraft(
  lines: PosCartLine[],
  type: PosDiscountType,
  input: string,
  pricing?: PosPricingPreviewParams,
): PosDraftPreview {
  const values = lines.map(line => {
    const price = Number(line.item.price), gross = price * line.qty;
    if (!Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(line.qty) || line.qty <= 0 || !Number.isSafeInteger(gross))
      throw new Error('Harga dan jumlah item belum valid.');
    const eff = effectiveDiscount(line.discountType || '', line.discountInput || '');
    const amount = discount(eff.type, eff.input, gross).amount;
    return {gross, discount: amount, net: gross - amount};
  });
  const gross = values.reduce((sum, v) => sum + v.gross, 0);
  const subtotal = values.reduce((sum, v) => sum + v.net, 0);
  if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(subtotal)) throw new Error('Total pesanan melebihi batas.');
  const effOrder = effectiveDiscount(type, input);
  const orderDiscount = discount(effOrder.type, effOrder.input, subtotal).amount;
  // ── Canonical POS formula (identik dengan computePosPricing backend): ─────
  // 1. base     = subtotal − orderDiscount   (= afterItemDiscount di backend)
  // 2. svc      = svcEnabled ? round(base × svcPct / 100) : 0
  // 3. tax      = taxEnabled ? round((base + svc) × taxPct / 100) : 0
  // 4. total    = base + svc + tax
  const base = subtotal - orderDiscount;
  const svcEnabled = pricing?.serviceChargeEnabled ?? false;
  const svcPct = pricing?.serviceChargePercent ?? 0;
  const serviceCharge = svcEnabled
    ? Math.round(base * svcPct / 100)
    : 0;
  const taxEnabled = pricing?.taxEnabled ?? false;
  const taxPct = pricing?.taxPercent ?? 0;
  const tax = taxEnabled
    ? Math.round((base + serviceCharge) * taxPct / 100)
    : 0;
  const total = base + serviceCharge + tax;
  if (!Number.isSafeInteger(total)) throw new Error('Total pesanan melebihi batas.');
  return {gross, itemDiscount: gross - subtotal, subtotal, orderDiscount, serviceCharge, tax, total, lines: values};
}
function optional(value: string, max: number, name: string): string | null {
  const v = value.trim();
  if (v.length > max) throw new Error(`${name} maksimal ${max} karakter.`);
  return v || null;
}
export function buildPosOrderDraft(lines: PosCartLine[], details: PosDraftDetails, canDiscount: boolean): Record<string, unknown> {
  if (!Number.isInteger(details.propertyId) || details.propertyId <= 0 || details.propertyId > 2147483647 || lines.length === 0)
    throw new Error('Properti dan item pesanan harus valid.');
  if (details.reservationId !== null && (!Number.isInteger(details.reservationId) || details.reservationId <= 0 || details.reservationId > 2147483647))
    throw new Error('Reservasi tidak valid.');
  const usesDiscount =
    effectiveDiscount(details.discountType, details.discountInput).type !== '' ||
    lines.some(line => effectiveDiscount(line.discountType || '', line.discountInput || '').type !== '');
  if (usesDiscount && !canDiscount) throw new Error('Anda tidak memiliki izin diskon POS. Hapus diskon untuk menyimpan pesanan biasa.');
  const preview = previewPosDraft(lines, details.discountType, details.discountInput);
  const payload: Record<string, unknown> = {
    property_id: details.propertyId,
    table_number: optional(details.tableNumber, 50, 'Nomor meja'),
    guest_name: optional(details.guestName, 150, 'Nama pelanggan'),
    guest_phone: optional(details.guestPhone, 50, 'Nomor WhatsApp'),
    notes: optional(details.notes, 1000, 'Catatan pesanan'),
    items: lines.map(line => {
      if (!Number.isInteger(line.item.id) || line.item.id <= 0 || line.item.id > 2147483647) throw new Error('Item menu tidak valid.');
      const item: Record<string, unknown> = {menu_item_id: line.item.id, quantity: line.qty};
      const notes = optional(line.notes || '', 1000, 'Catatan item');
      if (notes) item.notes = notes;
      // Hanya kirim field diskon bila nilai > 0 (kosong/nol = tanpa diskon).
      const effLine = effectiveDiscount(line.discountType || '', line.discountInput || '');
      if (effLine.type !== '') {
        item.discount_type = effLine.type;
        item.discount_value = discount(effLine.type, effLine.input, Number(line.item.price) * line.qty).value;
      }
      return item;
    }),
  };
  if (details.reservationId !== null) payload.reservation_id = details.reservationId;
  const effOrder = effectiveDiscount(details.discountType, details.discountInput);
  if (effOrder.type !== '') {
    payload.discount_type = effOrder.type;
    payload.discount_value = discount(effOrder.type, effOrder.input, preview.subtotal).value;
    payload.discount_reason = optional(details.discountReason, 100, 'Alasan diskon');
  }
  // ── Per-order Service Charge & PBJT override ──────────────────────────────────
  // Klien baru WAJIB mengirim true/false eksplisit.
  // absent = mengikuti properti (backward compat, hanya untuk klien lama).
  // Backend menolak null/string/number dengan 400 VALIDATION_ERROR.
  if (details.serviceChargeEnabled !== undefined) {
    if (typeof details.serviceChargeEnabled !== 'boolean')
      throw new Error('serviceChargeEnabled harus boolean strict.');
    payload.service_charge_enabled = details.serviceChargeEnabled;
  }
  if (details.taxEnabled !== undefined) {
    if (typeof details.taxEnabled !== 'boolean')
      throw new Error('taxEnabled harus boolean strict.');
    payload.tax_enabled = details.taxEnabled;
  }
  // expected_total: whole-rupiah integer ≥ 0 (opsional, klien baru).
  // Dibandingkan dengan computed total di backend; mismatch → 409 PRICING_TOTAL_CHANGED.
  if (details.expectedTotal !== undefined) {
    if (!Number.isSafeInteger(details.expectedTotal) || details.expectedTotal < 0)
      throw new Error('expectedTotal harus whole-rupiah integer ≥ 0.');
    payload.expected_total = details.expectedTotal;
  }
  return payload;
}

// ── POS-EDIT-1B.1 — Kontrak data & payload builder untuk EDIT order (PUT /api/pos/orders/:id) ──
// Fondasi di atas kontrak backend POS-EDIT-1A:
//  - GET /api/pos/orders/:id/detail  → shape PosOrderDetail (di bawah)
//  - PUT /api/pos/orders/:id         → payload PosOrderEditPayload (buildPosOrderEditPayload)
//
// Aturan builder (gugur bila dilanggar):
//  - ID order TIDAK ada di payload (ID berada di path :id) — TIDAK boleh muncul.
//  - TIDAK mengirim reservation_id / service_charge_enabled / tax_enabled
//    (backend PUT menolak dengan 400 UNSUPPORTED_FIELD, termasuk null).
//  - TIDAK mengirim unit_price (harga menu live) — backend memertahankan
//    snapshot unit_price item existing dan mengambil harga DB untuk item baru.
//  - Item existing DIMEWAKAI lewat items[].id (pos_order_items.id dari GET detail)
//    sehingga snapshot harga & notes/diskon lama dapat dipertahankan; item baru
//    dikirim TANPA id (hanya menu_item_id).
//  - items=[] DITOLAK (sesuai backend: payload items kosong dilarang).
//    Untuk "tanpa perubahan item", field items di-omitted (undefined) —
//    backend memertahankan seluruh item existing.
//  - Diskon order memakai KUNCI order_discount_type / order_discount_value
//    (BUKAN kunci create discount_type / discount_value).
//  - idempotency_key DITERIMA SEBAGAI INPUT (string eksplisit), TIDAK dibuat
//    otomatis per pemanggilan — agar caller dapat mempertahankan payload
//    identik saat retry. Builder hanya memvalidasi bentuk (string non-kosong
//    setelah trim, panjang dipotong ≤ 150 sesuai backend).
//  - expected_version WAJIB integer ≥ 1 (anti-stale, optimistik).

/** Shape respons data.items dari GET /api/pos/orders/:id/detail. */
export interface PosOrderDetailItem {
  /** pos_order_items.id — identitas item existing; WAJIB dikirim balik di payload edit. */
  id: number;
  /** pos_menu_items.id (property-scoped). */
  menu_item_id: number | null;
  quantity: number;
  /** Snapshot harga per item — TIDAK dikirim balik; backend yang memertahankan. */
  unit_price: number;
  discount_type: 'NOMINAL' | 'PERCENT' | null;
  discount_value: number | null;
  discount_amount: number | null;
  notes: string | null;
  item_name_snapshot: string | null;
  item_code_snapshot: string | null;
  menu_item_is_active: boolean;
  menu_item_name: string | null;
}

/** Shape respons data.order dari GET /api/pos/orders/:id/detail. */
export interface PosOrderDetail {
  /** ID internal order — dipakai HANYA di path PUT (:id), TIDAK di body. */
  id: number;
  order_number: string;
  property_id: number;
  reservation_id: number | null;
  table_number: string | null;
  guest_name: string | null;
  guest_phone: string | null;
  notes: string | null;
  /** OPEN | PAID | VOIDED (sumber kebenaran status dari backend). */
  status: string;
  total_amount: number;
  discount_type: 'NOMINAL' | 'PERCENT' | null;
  discount_value: number | null;
  discount_reason: string | null;
  discount_amount: number | null;
  service_charge_percent_snapshot: number | null;
  tax_percent_snapshot: number | null;
  service_charge_enabled_snapshot: boolean;
  tax_enabled_snapshot: boolean;
  service_amount: number | null;
  tax_amount: number | null;
  /** Versi terkini — WAJIB dikirim sebagai expected_version di payload PUT. */
  version: number | null;
  /** Idempotency key create — TIDAK dipakai untuk edit; edit punya key sendiri. */
  idempotency_key: string | null;
  created_at: string | null;
  updated_at: string | null;
  items: PosOrderDetailItem[];
}

/** Item di payload edit (full-replace): existing = ada orderId; baru = tanpa orderId. */
export interface PosOrderEditItem {
  /** pos_order_items.id (dari GET detail). Hanya untuk item existing; undefined untuk item baru. */
  orderId?: number;
  /** menu_item_id WAJIB — identitas item yang dipertahankan/ditambah. */
  menu_item_id: number;
  /** Quantity 1..9999 (integer) — sesuai validasi backend. */
  quantity: number;
  /**
   * Catatan item.
   *
   * Perilaku payload:
   *  - undefined → key `notes` TIDAK dikirim dalam payload item.
   *  - null      → `notes: null` dikirim (hapus catatan eksplisit).
   *  - string    → nilai di-trim & dibatasi 1000 karakter.
   *
   * ⚠️ PENTING (semantik backend full-replace, berbeda dengan metadata order):
   * Karena `pos_order_items` di-UPDATE oleh backend POS-EDIT-1A HANYA untuk
   * item yang TERSEBUT dalam `items[]` dan kolom `notes` selalu di-SET
   * (string di-trim atau null), maka:
   *  - key `notes` ter-omit (undefined) TIDAK mempertahankan catatan existing —
   *    backend tetap menulis ulang kolom `notes` menjadi `NULL`.
   *  - Untuk MEMERTAHANKAN catatan item existing, caller WAJIB mengirim
   *    ulang string catatan dari GET /detail (field `notes`).
   *  - Untuk MENGHAPUS catatan, kirim `null` (atau string kosong → backend
   *    menormalkan ke null).
   */
  notes?: string | null;
  /**
   * Pasangan diskon item — harus berpasangan (sama-sama ada / sama-sama absen).
   *
   * Perilaku payload:
   *  - keduanya undefined → key `discount_type` & `discount_value` TIDAK
   *    dikirim dalam payload item.
   *  - keduanya null      → diskon item dihapus eksplisit.
   *  - keduanya terisi    → nilai harus valid (NOMINAL whole-rupiah /
   *    PERCENT ≤ 100, maks 2 desimal) dan berpasangan.
   *
   * ⚠️ PENTING (semantik backend full-replace, berbeda dengan metadata order):
   * Kolom diskon item selalu di-SET oleh backend untuk item yang ada di
   * `items[]`. Meng-omit kedua key diskon (undefined) TIDAK mempertahankan
   * diskon existing — backend menulis ulang `discount_type` & `discount_value`
   * menjadi `NULL`. Untuk MEMERTAHANKAN diskon item existing, caller WAJIB
   * mengirim ulang `discount_type` + `discount_value` dari GET /detail.
   */
  discount_type?: 'NOMINAL' | 'PERCENT' | null;
  discount_value?: number | null;
}

/** Details (seluruh field) untuk buildPosOrderEditPayload. */
export interface PosOrderEditDetails {
  /** property_id WAJIB (integer > 0, ≤ 2147483647) — sesuai validasi backend. */
  property_id: number;
  /** expected_version WAJIB integer ≥ 1 (dari PosOrderDetail.version ?? 1). */
  expected_version: number;
  /** idempotency_key WAJIB string non-kosong (diterima dari caller; dipotong ≤ 150). */
  idempotency_key: string;
  /**
   * Item full-replace. undefined = tanpa perubahan item (semua dipertahankan).
   * [] DITOLAK (sesuai backend). Item baru = tanpa `orderId`.
   */
  items?: PosOrderEditItem[];
  /**
   * Metadata tri-state SEMESTIS (undefined vs null vs string):
   *  - undefined → kolom TIDAK berubah (di-omitted dari payload)
   *  - null      → SET NULL
   *  - string    → trim + batas panjang
   * Panjang maksimum sesuai backend: table_number 20, guest_name 100,
   * guest_phone 50, notes 1000, discount_reason 100.
   */
  table_number?: string | null;
  guest_name?: string | null;
  guest_phone?: string | null;
  notes?: string | null;
  discount_reason?: string | null;
  /**
   * Diskon order — KUNCI order_discount_type / order_discount_value (BUKAN kunci create).
   * undefined = tanpa perubahan; null = hapus diskon; 'NOMINAL'/'PERCENT' = set.
   * Nilai ≥ 0; PERCENT ≤ 100 dengan maks 2 desimal; NOMINAL whole-rupiah.
   */
  order_discount_type?: 'NOMINAL' | 'PERCENT' | null;
  order_discount_value?: number | null;
  /** expected_total: whole-rupiah integer ≥ 0 (opsional, anti-stale harga). */
  expected_total?: number;
}

/**
 * Hasil buildPosOrderEditPayload — objek siap JSON.stringify sebagai body PUT.
 * Field immutable (reservation_id, service_charge_enabled, tax_enabled) TIDAK
 * pernah muncul; order.id TIDAK ada di sini; unit_price TIDADA (backend
 * memertahankan snapshot). items[].id hanya untuk item existing.
 */
export type PosOrderEditPayload = Record<string, unknown> & {
  property_id: number;
  expected_version: number;
  idempotency_key: string;
};

/**
 * Helper validasi panjang metadata — sama dengan backend PUT handler
 * (normalizeSnapshotText): trim + batas maksimum, throw bila melebihi.
 * Di-ekspor untuk reuse & test.
 */
function checkSnapshotTextLength(raw: unknown, field: string, maxLength: number): void {
  if (raw == null) return;
  if (typeof raw !== 'string') throw new Error(`${field} harus string.`);
  const s = raw.trim();
  if (s.length > maxLength) {
    throw new Error(`${field} maksimal ${maxLength} karakter.`);
  }
}

/**
 * Helper validasi nilai diskon (same as backend isDiscountValue):
 *  - harus finite ≥ 0;
 *  - NOMINAL → integer whole-rupiah;
 *  - PERCENT → ≤ 100 dengan maks 2 desimal;
 *  - null/undefined → valid (tidak ada diskon).
 */
function isEditDiscountValue(value: unknown, type: 'NOMINAL' | 'PERCENT' | null | undefined): boolean {
  if (value == null) return true;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return false;
  if (type === 'NOMINAL') return Number.isInteger(n);
  if (type === 'PERCENT') return n <= 100 && Number((n * 100).toFixed(2)) === n * 100;
  return n <= 100;
}

/**
 * Bangun payload PUT /api/pos/orders/:id (body JSON) — pure, tanpa side-effect.
 *
 * Aturan (semua gugur):
 *  1. order.id TIDADA di payload (ID di path, bukan body).
 *  2. TIDAK mengirim reservation_id / service_charge_enabled / tax_enabled
 *     (400 UNSUPPORTED_FIELD di backend).
 *  3. TIDAK mengirim unit_price — backend memertahankan snapshot lama.
 *  4. Item existing (orderId terisi) → items[].id = orderId dipertahankan.
 *  5. items=[] DITOLAK (sesuai backend). items undefined = tanpa perubahan.
 *  6. Diskon order pakai KUNCI order_discount_type / order_discount_value
 *     (Bukan kunci create discount_type / discount_value).
 *  7. idempotency_key diterima sebagai input (string, dipotong ≤ 150),
 *     TIDAK dibuat otomatis — caller bertanggung jawab menyediakan key.
 *  8. expected_version WAJIB integer ≥ 1.
 *  9. Metadata ORDER (table_number, guest_name, guest_phone, notes,
 *     discount_reason) tri-state: undefined → kolom TIDAK berubah
 *     (dipertahankan), null → SET NULL, string → trim + batas.
 *     KUNCI order discount (order_discount_type / order_discount_value)
 *     sama: undefined = tanpa perubahan, null+null = hapus diskon.
 * 10. Field ITEM (items[].notes, items[].discount_type / discount_value)
 *     SEMANTIK LAIN: undefined → key di-omit dari payload item, NAMUN
 *     backend selalu menulis ulang kolom item ke NULL (full-replace).
 *     Omit TIDAK mempertahankan nilai existing — untuk mempertahankan,
 *     caller WAJIB mengirim ulang nilai dari GET /detail. Lihat JSDoc
 *     PosOrderEditItem.
 * 11. Diskon item berpasangan: type & value harus sama-sama ada /
 *      sama-sama absen per item (sesuai backend).
 */
export function buildPosOrderEditPayload(
  details: PosOrderEditDetails,
  canDiscount: boolean
): PosOrderEditPayload {
  // ── Validasi property_id ──
  if (
    !Number.isInteger(details.property_id) ||
    details.property_id <= 0 ||
    details.property_id > 2147483647
  ) {
    throw new Error('property_id tidak valid.');
  }

  // ── Validasi expected_version (integer ≥ 1) ──
  if (!Number.isInteger(details.expected_version) || details.expected_version < 1) {
    throw new Error('expected_version harus integer ≥ 1.');
  }

  // ── Validasi idempotency_key (string non-kosong, dipotong ≤ 150) ──
  if (typeof details.idempotency_key !== 'string') {
    throw new Error('idempotency_key harus string (diterima sebagai input).');
  }
  const idemKey = details.idempotency_key.trim().slice(0, 150);
  if (idemKey === '') {
    throw new Error('idempotency_key tidak boleh kosong (setelah trim).');
  }

  // ── Bangun payload dasar ──
  const payload: Record<string, unknown> = {
    property_id: details.property_id,
    expected_version: details.expected_version,
    idempotency_key: idemKey,
  };

  // ── Metadata tri-state (undefined → omitted, null → SET NULL, string → trim) ──
  // Urutan field deterministik (property bag, JSON.stringify stable).
  const metadataFields: Array<[string, string | null | undefined, number, string]> = [
    ['table_number', details.table_number, 20, 'table_number'],
    ['guest_name', details.guest_name, 100, 'guest_name'],
    ['guest_phone', details.guest_phone, 50, 'guest_phone'],
    ['notes', details.notes, 1000, 'notes'],
    ['discount_reason', details.discount_reason, 100, 'discount_reason'],
  ];
  for (const [key, val, max, label] of metadataFields) {
    if (val === undefined) continue; // omitted — kolom tidak berubah
    checkSnapshotTextLength(val, label, max);
    // null → null (SET NULL); string → hasil trim
    payload[key] = val === null ? null : val.trim();
  }

  // ── Items (full-replace) ──
  if (details.items !== undefined) {
    // items=[] ditolak (sesuai backend: untuk memertahankan item tanpa
    // perubahan, items di-omitted / tidak dikirim, BUKAN mengirim []).
    if (details.items.length === 0) {
      throw new Error('items=[] tidak diperbolehkan. Untuk tanpa perubahan item, kirim undefined (tanpa field items).');
    }
    // Cek diskon sebelum bangun items — gate permission.
    const hasItemDiscount = details.items.some(
      (it) =>
        (it.discount_type != null && it.discount_value != null) ||
        (it.discount_type == null && it.discount_value != null) ||
        (it.discount_type != null && it.discount_value == null)
    );
    if (hasItemDiscount && !canDiscount) {
      throw new Error('Anda tidak memiliki izin diskon POS. Hapus diskon item untuk menyimpan.');
    }
    const itemsPayload: unknown[] = details.items.map((it, i) => {
      // menu_item_id WAJIB — identitas item (existing atau baru).
      if (!Number.isInteger(it.menu_item_id) || it.menu_item_id <= 0) {
        throw new Error(`items[${i}].menu_item_id harus integer positif.`);
      }
      // quantity integer 1..9999 (sesuai backend).
      if (!Number.isInteger(it.quantity) || it.quantity <= 0 || it.quantity > 9999) {
        throw new Error(`items[${i}].quantity harus integer 1..9999.`);
      }
      // Item existing: orderId WAJIB integer positif (sesuai backend: id
      // tidak di order → 400 ITEM_NOT_FOUND).
      if (it.orderId !== undefined) {
        if (!Number.isInteger(it.orderId) || it.orderId <= 0) {
          throw new Error(`items[${i}].orderId harus integer positif (pos_order_items.id).`);
        }
      }
      // Diskon item: pasangan type+value (sama-sama ada / sama-sama absen).
      const hasDisType = it.discount_type != null;
      const hasDisVal = it.discount_value != null;
      if (hasDisType !== hasDisVal) {
        throw new Error(`items[${i}]: discount_type dan discount_value harus dikirim berpasangan.`);
      }
      if (hasDisType && !isEditDiscountValue(it.discount_value, it.discount_type)) {
        throw new Error(`items[${i}].discount_value tidak valid (NOMINAL whole-rupiah / PERCENT ≤ 100, maks 2 desimal).`);
      }
      // notes: tri-state — undefined → omitted, null → null, string → trim.
      if (it.notes !== undefined) {
        checkSnapshotTextLength(it.notes, `items[${i}].notes`, 1000);
      }
      const item: Record<string, unknown> = {
        menu_item_id: it.menu_item_id,
        quantity: it.quantity,
      };
      // Item existing → kirim id (memertahankan snapshot harga lama).
      if (it.orderId !== undefined) item.id = it.orderId;
      // Diskon item (hanya bila ada).
      if (hasDisType) {
        item.discount_type = it.discount_type;
        item.discount_value = it.discount_value;
      }
      // notes (hanya bila terisi / explicit null untuk hapus).
      if (it.notes !== undefined) {
        item.notes = it.notes === null ? null : it.notes.trim();
      }
      return item;
    });
    payload.items = itemsPayload;
  }

  // ── Diskon order (KUNCI order_discount_type / order_discount_value) ──
  // undefined = tanpa perubahan (di-omitted); null = hapus diskon;
  // 'NOMINAL'/'PERCENT' = set. Nilai ≥ 0; PERCENT ≤ 100 maks 2 desimal.
  const hasOrderDisType = details.order_discount_type != null;
  const hasOrderDisVal = details.order_discount_value != null;
  // Pasangan diskon order: sama-sama ada / sama-sama absen / null eksplisit.
  // null + null = hapus diskon (valid). undefined + undefined = tanpa perubahan.
  const bothNull = details.order_discount_type === null && details.order_discount_value === null;
  if (!bothNull && hasOrderDisType !== hasOrderDisVal) {
    throw new Error('order_discount_type dan order_discount_value harus dikirim berpasangan (atau keduanya null untuk hapus diskon).');
  }
  if (hasOrderDisType && !canDiscount) {
    throw new Error('Anda tidak memiliki izin diskon POS. Hapus diskon pesanan untuk menyimpan.');
  }
  if (hasOrderDisType) {
    if (details.order_discount_type !== 'NOMINAL' && details.order_discount_type !== 'PERCENT') {
      throw new Error("order_discount_type harus 'NOMINAL', 'PERCENT', atau null.");
    }
  }
  if (hasOrderDisVal && !isEditDiscountValue(details.order_discount_value, details.order_discount_type)) {
    throw new Error('order_discount_value tidak valid (NOMINAL whole-rupiah / PERCENT ≤ 100, maks 2 desimal).');
  }
  if (hasOrderDisType || hasOrderDisVal || bothNull) {
    payload.order_discount_type = bothNull ? null : (details.order_discount_type ?? null);
    payload.order_discount_value = bothNull ? null : (details.order_discount_value ?? null);
  }

  // ── expected_total (whole-rupiah integer ≥ 0, opsional) ──
  if (details.expected_total !== undefined) {
    if (!Number.isSafeInteger(details.expected_total) || details.expected_total < 0) {
      throw new Error('expected_total harus whole-rupiah integer ≥ 0.');
    }
    payload.expected_total = details.expected_total;
  }

  // ── Guard final: pastikan field immutable TIDAK ada di payload ──
  // (fail-closed: bahkan bila caller secara tidak sengaja menyisipkan
  //  field ini, buang untuk mencegah 400 UNSUPPORTED_FIELD di backend).
  for (const forbidden of ['reservation_id', 'service_charge_enabled', 'tax_enabled']) {
    delete payload[forbidden];
  }

  return payload as PosOrderEditPayload;
}
