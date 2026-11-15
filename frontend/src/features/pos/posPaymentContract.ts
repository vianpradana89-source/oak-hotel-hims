export const POS_PAYMENT_METHODS = ['CASH', 'QRIS', 'TRANSFER', 'DEBIT'] as const;
export type PosPaymentMethod = typeof POS_PAYMENT_METHODS[number];

export interface PosPaymentConfig {
  property_id: number;
  qris_enabled: boolean;
  qris_image_available: boolean;
  qris_terminal_name: string | null;
  qris_merchant_id: string | null;
  transfer_enabled: boolean;
  transfer_ref_note: string | null;
  bank_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  debit_enabled: boolean;
  debit_edc_terminal: string | null;
}
export interface SettlementRecord {
  id: number;
  property_id: number;
  pos_order_id: number;
  transaction_id: string;
  amount: string;
  payment_method: string;
  status: string;
  idempotency_key: string;
  request_fingerprint: string;
  created_by: string | null;
  cash_received: string | null;
  change_due: string | null;
  payment_reference: string | null;
  verified_by: string | null;
  verified_at: string | null;
}
export interface SaleRecord {
  id: string;
  transaction_no: string;
  payment_status: string;
  payment_method: string;
  source_type: string;
  source_id: string;
}
export interface PayResponseShape {
  status?: string;
  data?: { settlement?: SettlementRecord; sale?: SaleRecord; created?: boolean; replayed?: boolean };
}
export interface PaySnapshot {
  readonly orderId: number;
  readonly propertyId: number;
  readonly key: string;
  readonly paymentMethod: PosPaymentMethod;
  readonly amount: string;
  readonly cashReceived: string | null;
  readonly paymentReference: string | null;
  readonly bodyJson: string;
}

/** Exact comparison in minor units; IDs and decimal strings never pass through Number. */
function cents(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return result <= 999999999999n ? result : null;
}
export function parseCashInput(value: string): number | null {
  const minor = cents(value.trim());
  return minor === null ? null : Number(minor) / 100;
}
const integerId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;
const positiveDigits = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+$/.test(value) && /[1-9]/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

export function readPosPaymentConfig(value: unknown, propertyId: number): PosPaymentConfig | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.property_id !== propertyId || !integerId(propertyId)) return null;
  for (const key of ['qris_enabled', 'qris_image_available', 'transfer_enabled', 'debit_enabled'])
    if (typeof v[key] !== 'boolean') return null;
  for (const key of ['qris_terminal_name', 'qris_merchant_id', 'transfer_ref_note', 'bank_name',
    'bank_account_name', 'bank_account_number', 'debit_edc_terminal'])
    if (v[key] !== null && typeof v[key] !== 'string') return null;
  return v as unknown as PosPaymentConfig;
}
export function isMethodAvailable(method: PosPaymentMethod, config: PosPaymentConfig | null): boolean {
  if (method === 'CASH') return true;
  if (!config) return false;
  if (method === 'QRIS') return config.qris_enabled && config.qris_image_available;
  if (method === 'TRANSFER') return config.transfer_enabled && text(config.bank_account_number);
  return config.debit_enabled && text(config.debit_edc_terminal);
}
export function createPaySnapshot(input: {
  orderId: number; propertyId: number; amount: number | string; key: string;
  method: PosPaymentMethod; cashInput: string; reference: string;
  config: PosPaymentConfig | null; qrisImageLoaded: boolean; verified: boolean;
}): PaySnapshot {
  const amount = String(input.amount);
  const minor = cents(amount);
  if (!integerId(input.orderId) || !integerId(input.propertyId) || minor === null || minor <= 0n)
    throw new Error('Nominal pesanan harus positif dan konteks pesanan harus valid.');
  if (!text(input.key) || input.key.length > 150) throw new Error('Kunci pembayaran tidak valid.');
  if (!POS_PAYMENT_METHODS.includes(input.method)) throw new Error('Metode pembayaran tidak valid.');
  const cfg = input.config?.property_id === input.propertyId ? input.config : null;
  if (!isMethodAvailable(input.method, cfg)) throw new Error('Metode belum dikonfigurasi untuk properti ini.');
  let cashReceived: string | null = null, paymentReference: string | null = null;
  const body: Record<string, string | number | null> = {property_id: input.propertyId, payment_method: input.method};
  if (input.method === 'CASH') {
    cashReceived = input.cashInput.trim();
    const tendered = cents(cashReceived);
    if (tendered === null || tendered < minor) throw new Error('Uang diterima harus sama atau lebih besar dari tagihan.');
    body.cash_received = cashReceived;
  } else {
    if (input.method === 'QRIS' && !input.qrisImageLoaded) throw new Error('Gambar QRIS resmi belum berhasil ditampilkan.');
    if (!input.verified) throw new Error('Konfirmasikan bahwa pembayaran telah diterima dan diperiksa.');
    paymentReference = input.reference.trim() || null;
    if (paymentReference && paymentReference.length > 100) throw new Error('Referensi maksimal 100 karakter.');
    body.payment_reference = paymentReference;
  }
  return Object.freeze({orderId: input.orderId, propertyId: input.propertyId, key: input.key,
    paymentMethod: input.method, amount, cashReceived, paymentReference, bodyJson: JSON.stringify(body)});
}
export function validatePayResponse(httpStatus: number, json: PayResponseShape | null, snap: PaySnapshot): boolean {
  if (!json || typeof json !== 'object' || !json.data || typeof json.data !== 'object') return false;
  const {settlement: s, sale} = json.data;
  if (!s || !sale || typeof s !== 'object' || typeof sale !== 'object') return false;
  if (!integerId(s.id) || s.property_id !== snap.propertyId || s.pos_order_id !== snap.orderId) return false;
  const amount = cents(s.amount), expected = cents(snap.amount);
  if (amount === null || expected === null || amount <= 0n || amount !== expected) return false;
  if (s.status !== 'SUCCESS' || s.payment_method !== snap.paymentMethod || s.idempotency_key !== snap.key) return false;
  if (!text(s.request_fingerprint) || !positiveDigits(s.transaction_id) || !positiveDigits(sale.id)) return false;
  if (sale.id !== s.transaction_id || sale.source_type !== 'POS_ORDER' || sale.source_id !== String(snap.orderId)) return false;
  if (sale.payment_status !== 'PAID' || sale.payment_method !== snap.paymentMethod || !text(sale.transaction_no)) return false;
  if (s.created_by !== null && !text(s.created_by)) return false;
  if (snap.paymentMethod === 'CASH') {
    const tendered = cents(s.cash_received), requested = cents(snap.cashReceived), change = cents(s.change_due);
    if (tendered === null || requested === null || change === null || tendered !== requested || change !== tendered - amount) return false;
    if (s.payment_reference !== null || s.verified_by !== null || s.verified_at !== null) return false;
  } else {
    if (s.cash_received !== null || s.change_due !== null || s.payment_reference !== snap.paymentReference) return false;
    if (!text(s.verified_by) || !text(s.verified_at) || !Number.isFinite(Date.parse(s.verified_at))) return false;
  }
  return httpStatus === 201 ? json.status === 'SUCCESS' && json.data.created === true && json.data.replayed === false
    : httpStatus === 200 && json.status === 'REPLAY' && json.data.created === false && json.data.replayed === true;
}
