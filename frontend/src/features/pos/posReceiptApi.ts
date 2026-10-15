import type { PosReceiptData, PosReceiptResponse } from './posReceiptTypes';

/**
 * Type for the caller-provided authenticated fetch.
 * Must attach the Authorization header; this function does not manage
 * credentials.
 */
export type AuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

// ── Internal guards ──────────────────────────────────────────────────────

const isPositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;

/**
 * Canonical whole-rupiah monetary string validator.
 *
 * Kembalikan canonical string (digits integer, tanpa leading zero, tanpa
 * trailing decimal) atau `null` bila input tidak valid.
 *
 * Accept:  "25000" → "25000"  |  "25000.00" → "25000"  |  "25000.000" → "25000"
 * Reject:  "", "0", "0.00", "-1000", "1000.50", "1000.01", "abc",
 *          "007", "001000", "1e5", " 100 ", null, undefined, non-string
 *
 * Deterministic, TIDAK memakai Number() / parseFloat() / arithmetic
 * floating point. Perbandingan antar field dilakukan pada canonical
 * string, bukan raw string.
 */
export function canonicalWholeRupiah(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0) return null;

  // Satu titik desimal maksimum; reject multiple dots
  const dotIdx = raw.indexOf('.');
  let intPart: string;
  let fracPart: string;

  if (dotIdx === -1) {
    intPart = raw;
    fracPart = '';
  } else {
    intPart = raw.slice(0, dotIdx);
    fracPart = raw.slice(dotIdx + 1);
    // Reject second dot (i.e. "1.2.3")
    if (fracPart.indexOf('.') !== -1) return null;
    // Reject trailing dot with empty frac ("123.")
    if (fracPart.length === 0) return null;
  }

  // Integer part must be all digits
  if (!/^\d+$/.test(intPart)) return null;

  // Fractional part (if present) must be all digits
  if (fracPart.length > 0 && !/^\d+$/.test(fracPart)) return null;

  // No leading zero unless intPart is exactly "0"
  if (intPart.length > 1 && intPart[0] === '0') return null;

  // Value must be strictly positive: "0" and "0.00" are rejected
  if (intPart === '0') return null;

  // All fractional digits must be '0'
  for (let i = 0; i < fracPart.length; i++) {
    if (fracPart[i] !== '0') return null;
  }

  return intPart;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch the authoritative POS receipt for a given order.
 *
 * Validation is fail-closed: any structural deviation from the expected
 * shape throws.  Monetary fields are validated as positive whole-rupiah
 * representations; textual scale may differ across sources (e.g.
 * "25000.00" vs "25000").  Equality is checked AFTER canonicalization
 * via canonicalWholeRupiah().
 *
 * @param orderId   – POS order id (positive integer).
 * @param propertyId – property scope id (positive integer).
 * @param authFetch – caller-provided fetch that attaches the JWT.
 * @returns validated PosReceiptData.
 * @throws Error – input validation, HTTP error, or shape validation.
 */
export async function fetchPosReceipt(
  orderId: number,
  propertyId: number,
  authFetch: AuthFetch,
): Promise<PosReceiptData> {
  // ── Input validation ───────────────────────────────────────────────
  if (!isPositiveInt(orderId) || !isPositiveInt(propertyId)) {
    throw new Error('orderId dan propertyId harus integer positif.');
  }

  // ── HTTP request ─────────────���─────────────────────────────────────
  const url = `/api/pos/orders/${orderId}/receipt?property_id=${propertyId}`;
  const res = await authFetch(url);

  if (!res.ok) {
    // Read the JSON body safely; use the backend message when available.
    let backendMsg: string | null = null;
    try {
      const json = (await res.json()) as Partial<PosReceiptResponse>;
      if (typeof json?.message === 'string' && json.message.trim() !== '') {
        backendMsg = json.message.trim();
      }
    } catch {
      /* body may not be JSON */
    }
    throw new Error(
      backendMsg ?? `Gagal mengambil receipt POS (HTTP ${res.status}).`,
    );
  }

  // ── Parse body ─────────────────────────────────────────────────────
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('Data struk POS tidak valid.');
  }

  const env = json as Partial<PosReceiptResponse> | null;
  if (
    !env ||
    typeof env !== 'object' ||
    env.status !== 'SUCCESS' ||
    !env.data ||
    typeof env.data !== 'object'
  ) {
    throw new Error('Data struk POS tidak valid.');
  }

  const data = env.data;

  // ── Property ───────────────────────────────────────────────────────
  const prop = (data as any).property;
  if (
    !prop ||
    typeof prop !== 'object' ||
    prop.id !== propertyId ||
    typeof prop.name !== 'string' ||
    typeof prop.property_code !== 'string'
  ) {
    throw new Error('Data struk POS tidak valid.');
  }

  // ── Order ──────────────────────────────────────────────────────────
  const order = (data as any).order;
  if (
    !order ||
    typeof order !== 'object' ||
    order.id !== orderId ||
    order.property_id !== propertyId ||
    order.status !== 'PAID' ||
    typeof order.order_number !== 'string'
  ) {
    throw new Error('Data struk POS tidak valid.');
  }

  // ── Items ──────────────────────────────────────────────────────────
  const items = (data as any).items;
  if (!Array.isArray(items)) {
    throw new Error('Data struk POS tidak valid.');
  }

  // ── Settlement ─────────────────────────────────────────────────────
  const settlement = (data as any).settlement;
  if (
    !settlement ||
    typeof settlement !== 'object' ||
    settlement.status !== 'SUCCESS' ||
    typeof settlement.payment_method !== 'string'
  ) {
    throw new Error('Data struk POS tidak valid.');
  }

  // ── Sale ───────────────────────────────────────────────────────────
  const sale = (data as any).sale;
  if (
    !sale ||
    typeof sale !== 'object' ||
    sale.transaction_type !== 'SALE' ||
    sale.payment_status !== 'PAID' ||
    typeof sale.id !== 'string' ||
    typeof sale.payment_method !== 'string'
  ) {
    throw new Error('Data struk POS tidak valid.');
  }

  // ── Cross-field integrity ──────────────────────────────────────────

  // payment_method must match between settlement and sale.
  if (settlement.payment_method !== sale.payment_method) {
    throw new Error('Data struk POS tidak valid.');
  }

  // sale.source_id must equal String(orderId).
  if (sale.source_id !== String(orderId)) {
    throw new Error('Data struk POS tidak valid.');
  }

  // sale.source_type must be 'POS_ORDER' or 'POS'.
  const srcType = sale.source_type;
  if (srcType !== 'POS_ORDER' && srcType !== 'POS') {
    throw new Error('Data struk POS tidak valid.');
  }

  // ── Amount integrity (canonical whole-rupiah; TIDAK floating point) ───
  // Backend staging mengirim PostgreSQL NUMERIC string ("25000.00") sedangkan
  // sumber lain dapat mengirim "25000". Canonical string digunakan untuk
  // perbandingan — bukan raw string.
  const canonicalOrder    = canonicalWholeRupiah(order.total_amount);
  const canonicalSettle   = canonicalWholeRupiah(settlement.amount);
  const canonicalSale     = canonicalWholeRupiah(sale.net_amount);

  if (
    canonicalOrder === null ||
    canonicalSettle === null ||
    canonicalSale === null ||
    canonicalOrder !== canonicalSettle ||
    canonicalOrder !== canonicalSale
  ) {
    throw new Error('Data struk POS tidak valid.');
  }

  // ── Return validated data ──────────────────────────────────────────
  return data as PosReceiptData;
}
