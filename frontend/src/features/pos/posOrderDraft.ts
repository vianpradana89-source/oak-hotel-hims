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
    const amount = discount(line.discountType || '', line.discountInput || '', gross).amount;
    return {gross, discount: amount, net: gross - amount};
  });
  const gross = values.reduce((sum, v) => sum + v.gross, 0);
  const subtotal = values.reduce((sum, v) => sum + v.net, 0);
  if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(subtotal)) throw new Error('Total pesanan melebihi batas.');
  const orderDiscount = discount(type, input, subtotal).amount;
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
  const usesDiscount = !!details.discountType || lines.some(line => !!line.discountType);
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
      if (line.discountType) {
        item.discount_type = line.discountType;
        item.discount_value = discount(line.discountType, line.discountInput || '', Number(line.item.price) * line.qty).value;
      }
      return item;
    }),
  };
  if (details.reservationId !== null) payload.reservation_id = details.reservationId;
  if (details.discountType) {
    payload.discount_type = details.discountType;
    payload.discount_value = discount(details.discountType, details.discountInput, preview.subtotal).value;
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
