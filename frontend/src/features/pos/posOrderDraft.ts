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
}
export interface PosDraftPreview {
  gross: number;
  itemDiscount: number;
  subtotal: number;
  orderDiscount: number;
  total: number;
  lines: {gross: number; discount: number; net: number}[];
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
export function previewPosDraft(lines: PosCartLine[], type: PosDiscountType, input: string): PosDraftPreview {
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
  return {gross, itemDiscount: gross - subtotal, subtotal, orderDiscount, total: subtotal - orderDiscount, lines: values};
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
  return payload;
}
