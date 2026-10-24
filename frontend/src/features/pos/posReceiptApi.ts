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

// ── B4.1 snapshot-field validators ───────────────────────────────────────

/**
 * Returns true when the value is a string representing a non-negative
 * whole-rupiah amount (digits only, value >= 0).
 * Accepts "0" and "30000"; rejects "0.00", "", null, undefined, negative,
 * leading-zero multi-digit forms like "007", and any non-string.
 */
function isNonNegativeWholeRupiahString(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  if (!/^\d+$/.test(v)) return false;
  if (v.length > 1 && v[0] === '0') return false; // "007" → reject
  return true; // "0" and "30000" are valid
}

/**
 * Returns true when the value is a string representing a finite percentage
 * snapshot in the closed range [0, 100], using the exact format the
 * backend emits: decimal digits with an optional fractional part.
 *
 * Accepted: "0", "10", "10.5", "11", "100"
 * Rejected:  "" (empty), " " (whitespace-only), "10 " (trailing space),
 *            "10\t" (tab), "1e2" (exponent), "+10" (sign), "-10" (neg),
 *            "Infinity", "NaN", "0.0.1" (multi-dot), null, undefined,
 *            non-string, any value outside [0, 100].
 */
function isPercentSnapshotString(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  // Strict decimal format: one or more digits, optionally followed by
  // a dot and one or more digits. No leading/trailing whitespace,
  // no exponent, no sign, no multi-dot forms.
  if (!/^\d+(\.\d+)?$/.test(v)) return false;
  const n = Number(v);
  if (!Number.isFinite(n)) return false;
  return n >= 0 && n <= 100;
}

/**
 * Returns true when the value is a strict boolean (true or false).
 * Rejects 0, 1, "true", null, undefined, and any other type.
 */
function isStrictBoolean(v: unknown): boolean {
  return v === true || v === false;
}

/**
 * Validate all six B4.1 snapshot fields on a PosReceiptOrder object.
 * ALL SIX FIELDS ARE REQUIRED — the backend B4.1+ always emits them.
 *
 * Each field must be present AND pass its type guard.  A missing key
 * (undefined), null, wrong-type, or malformed value all cause a throw.
 * This is fail-closed: the receipt is rejected rather than silently
 * falling back to zero or false.
 *
 * Thrown when any field is absent or malformed.
 */
function validateB41SnapshotFields(order: Record<string, unknown>): void {
  const svcAmtKey = 'service_amount';
  const taxAmtKey = 'tax_amount';
  const svcPctKey = 'service_charge_percent_snapshot';
  const taxPctKey = 'tax_percent_snapshot';
  const svcOnKey = 'service_charge_enabled_snapshot';
  const taxOnKey = 'tax_enabled_snapshot';

  // ── service_amount: required, non-negative whole-rupiah string ──────
  if (!isNonNegativeWholeRupiahString(order[svcAmtKey])) {
    throw new Error('Data struk POS tidak valid: service_amount wajib hadir dan valid.');
  }
  // ── tax_amount: required, non-negative whole-rupiah string ──────────
  if (!isNonNegativeWholeRupiahString(order[taxAmtKey])) {
    throw new Error('Data struk POS tidak valid: tax_amount wajib hadir dan valid.');
  }
  // ── service_charge_percent_snapshot: required, strict decimal 0–100 ─
  if (!isPercentSnapshotString(order[svcPctKey])) {
    throw new Error('Data struk POS tidak valid: service_charge_percent_snapshot wajib hadir dan valid.');
  }
  // ── tax_percent_snapshot: required, strict decimal 0–100 ────────────
  if (!isPercentSnapshotString(order[taxPctKey])) {
    throw new Error('Data struk POS tidak valid: tax_percent_snapshot wajib hadir dan valid.');
  }
  // ── service_charge_enabled_snapshot: required, strict boolean ───────
  if (!isStrictBoolean(order[svcOnKey])) {
    throw new Error('Data struk POS tidak valid: service_charge_enabled_snapshot wajib hadir dan valid.');
  }
  // ── tax_enabled_snapshot: required, strict boolean ───────────────────
  if (!isStrictBoolean(order[taxOnKey])) {
    throw new Error('Data struk POS tidak valid: tax_enabled_snapshot wajib hadir dan valid.');
  }
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

  // B4.1 snapshot field validation (fail-closed)
  // ALL SIX snapshot fields are REQUIRED.  The backend B4.1+ always
  // emits them; missing or malformed values reject the receipt.
  validateB41SnapshotFields(order);
  return data as PosReceiptData;
}


// ── WhatsApp Digital Receipt Dispatch ─────────────────────────────────────

export interface SendPosReceiptWhatsAppResult {
  success: boolean;
  message: string;
  data?: {
    order_id: number | string;
    recipient_phone: string;
    recipient_phone_masked: string;
    provider: string;
    log_id?: number;
  };
  error?: string;
  details?: any;
}

export interface PosWhatsAppReceiptLog {
  id: number;
  property_id: number;
  order_id: number;
  recipient_phone: string;
  recipient_phone_masked: string;
  message_content?: string;
  status: 'SENT' | 'FAILED';
  gateway_response?: any;
  error_message?: string | null;
  sent_by_user_id?: string | null;
  created_at: string;
}

/**
 * Dispatch digital receipt directly to customer's WhatsApp via backend gateway.
 */
export async function sendPosReceiptWhatsApp(
  orderId: number,
  propertyId: number,
  phoneNumber: string,
  authFetch: AuthFetch
): Promise<SendPosReceiptWhatsAppResult> {
  if (!isPositiveInt(orderId) || !isPositiveInt(propertyId)) {
    throw new Error('orderId dan propertyId harus integer positif.');
  }

  const cleanPhone = phoneNumber.trim();
  if (!cleanPhone) {
    throw new Error('Nomor telepon WhatsApp penerima tidak boleh kosong.');
  }

  const url = `/api/pos/orders/${orderId}/send-receipt-wa`;
  const res = await authFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Property-Id': String(propertyId),
    },
    body: JSON.stringify({
      property_id: propertyId,
      phone_number: cleanPhone,
    }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const errorMsg = json?.error || json?.message || `Gagal mengirim struk via WhatsApp (HTTP ${res.status})`;
    throw new Error(errorMsg);
  }

  return json as SendPosReceiptWhatsAppResult;
}

/**
 * Fetch WhatsApp receipt delivery logs for a given order.
 */
export async function fetchPosReceiptWhatsAppLogs(
  orderId: number,
  propertyId: number,
  authFetch: AuthFetch
): Promise<PosWhatsAppReceiptLog[]> {
  if (!isPositiveInt(orderId) || !isPositiveInt(propertyId)) {
    throw new Error('orderId dan propertyId harus integer positif.');
  }

  const url = `/api/pos/orders/${orderId}/wa-receipt-logs?property_id=${propertyId}`;
  const res = await authFetch(url, {
    headers: {
      'X-Property-Id': String(propertyId),
    },
  });

  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new Error(json?.error || `Gagal mengambil riwayat kirim WhatsApp (HTTP ${res.status})`);
  }

  const json = await res.json();
  return (json?.data || []) as PosWhatsAppReceiptLog[];
}
