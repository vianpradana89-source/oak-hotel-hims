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
 * Returns true when the value is a string that represents a positive
 * whole-rupiah amount (digits only, value > 0).
 * Accepts "30000" but rejects "30000.00", "0", "", null, undefined.
 */
function isPositiveWholeRupiahString(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  if (!/^\d+$/.test(v)) return false;
  // Reject leading-zero forms like "007" (not canonical whole-rupiah).
  if (v.length > 1 && v[0] === '0') return false;
  return v !== '0';
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch the authoritative POS receipt for a given order.
 *
 * Validation is fail-closed: any structural deviation from the expected
 * shape throws.  Monetary fields are validated as positive whole-rupiah
 * strings and checked for EXACT equality across the three sources.
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

  // ── Amount EXACT equality (all three: positive whole-rupiah string) ─
  const totalAmount = order.total_amount;
  const settlementAmount = settlement.amount;
  const saleNetAmount = sale.net_amount;

  if (
    !isPositiveWholeRupiahString(totalAmount) ||
    !isPositiveWholeRupiahString(settlementAmount) ||
    !isPositiveWholeRupiahString(saleNetAmount) ||
    totalAmount !== settlementAmount ||
    totalAmount !== saleNetAmount
  ) {
    throw new Error('Data struk POS tidak valid.');
  }

  // ── Return validated data ──────────────────────────────────────────
  return data as PosReceiptData;
}
