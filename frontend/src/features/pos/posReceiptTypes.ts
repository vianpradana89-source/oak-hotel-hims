/**
 * POS receipt authoritative types — frontend contract layer.
 *
 * These types mirror the backend receipt response shape.  Monetary values
 * are kept as strings, never coerced to number.  PostgreSQL NUMERIC columns
 * can emit different textual scales ("25000.00" vs "25000") while
 * representing the same positive whole-rupiah amount; validation uses
 * canonicalWholeRupiah() (posReceiptApi.ts) to normalize before comparison.
 * BIGINT identifiers (sale.id, settlement.transaction_id) are strings.
 * Item names/codes come exclusively from the immutable snapshot columns,
 * never from the live menu.
 */

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

export interface PosReceiptBranding {
  property_id: number;
  display_name: string;
  short_name: string;
  tagline: string;
  primary_color: string;
  accent_color: string;
  logo_url: string | null;
  compact_logo_url: string | null;
  /** Present when a property_brandings row exists; optional otherwise. */
  id?: number;
  created_at?: string | null;
  updated_at?: string | null;
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

export interface PosReceiptProperty {
  id: number;
  name: string;
  property_code: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  currency: string;
  /**
   * Property branding (always present as an object or null).
   * The backend returns the result of getPropertyBranding, which falls
   * back to a derived record when no custom row exists.
   */
  branding: PosReceiptBranding | null;
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

export type PosReceiptDiscountType = 'NOMINAL' | 'PERCENT' | null;

export interface PosReceiptOrder {
  id: number;
  order_number: string;
  property_id: number;
  /** Always 'PAID' in a successful receipt response. */
  status: string;
  /** Snapshot taken at order creation; authoritative for WhatsApp. */
  guest_name: string | null;
  guest_phone: string | null;
  table_number: string | null;
  notes: string | null;
  /**
   * Positive whole-rupiah amount.  PostgreSQL NUMERIC can emit
   * "25000.00" (scale 2) or "25000" (scale 0) — both represent the
   * same value.  Validation normalizes via canonicalWholeRupiah()
   * before comparing with settlement.amount and sale.net_amount.
   */
  total_amount: string;
  discount_type: PosReceiptDiscountType;
  discount_value: string | null;
  discount_reason: string | null;
  discount_amount: string;
  /**
   * Phase 2A snapshot fields (immutable after order create).
   * All monetary values are PostgreSQL NUMERIC strings (e.g. "6300.00").
   * Boolean flags are the order's own toggle state at creation time.
   * Legacy orders (pre-Phase-2A) will have `false` / "0" defaults from DDL.
   * Consumers MUST NOT re-compute; use these values as the display source.
   */
  tax_enabled: boolean;
  /** PostgreSQL NUMERIC(5,2) as string, e.g. "10.00" (snapshot rate). */
  tax_rate: string;
  /** Whole-rupiah string; "0" when tax disabled. */
  tax_amount: string;
  service_charge_enabled: boolean;
  /** PostgreSQL NUMERIC(5,2) as string, e.g. "10.00" (snapshot rate). */
  service_charge_rate: string;
  /** Whole-rupiah string; "0" when service charge disabled. */
  service_charge_amount: string;
  created_at: string | null;
  updated_at: string | null;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface PosReceiptItem {
  id: number;
  menu_item_id: number;
  /** Immutable historical snapshot — NOT the live menu name. */
  item_name_snapshot: string;
  item_code_snapshot: string | null;
  quantity: number;
  /** Authoritative whole-rupiah string. */
  unit_price: string;
  notes: string | null;
  discount_type: PosReceiptDiscountType;
  discount_value: string | null;
  discount_amount: string;
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export type PosReceiptPaymentMethod = 'CASH' | 'QRIS' | 'TRANSFER' | 'DEBIT';

export interface PosReceiptSettlement {
  id: number;
  /**
   * Positive whole-rupiah amount (same value as order.total_amount).
   * Textual scale may differ (e.g. "25000.00" vs "25000").
   * Normalized via canonicalWholeRupiah() before comparison.
   */
  amount: string;
  payment_method: string;
  /** Always 'SUCCESS' in a successful receipt response. */
  status: string;
  /** CASH only; null for QRIS/TRANSFER/DEBIT. */
  cash_received: string | null;
  /** CASH only; null for non-CASH methods. */
  change_due: string | null;
  payment_reference: string | null;
  created_by: string | null;
  created_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
}

// ---------------------------------------------------------------------------
// Sale (transaction)
// ---------------------------------------------------------------------------

export interface PosReceiptSale {
  /**
   * BIGINT identifier from the transactions table.
   * MUST be a string; never pass through Number().
   */
  id: string;
  transaction_no: string;
  /** Always 'SALE' in a successful receipt response. */
  transaction_type: string;
  /** 'POS_ORDER' or 'POS'. */
  source_type: string;
  /** String(orderId) — the POS order that produced this sale. */
  source_id: string;
  /** Always 'PAID' in a successful receipt response. */
  payment_status: string;
  payment_method: string;
  /**
   * Positive whole-rupiah amount (same value as order.total_amount).
   * Textual scale may differ (e.g. "25000" vs "25000.00").
   * Normalized via canonicalWholeRupiah() before comparison.
   */
  net_amount: string;
  created_at: string | null;
}

// ---------------------------------------------------------------------------
// Combined data
// ---------------------------------------------------------------------------

export interface PosReceiptData {
  property: PosReceiptProperty;
  order: PosReceiptOrder;
  items: PosReceiptItem[];
  settlement: PosReceiptSettlement;
  sale: PosReceiptSale;
}

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

export interface PosReceiptResponse {
  status: string;
  /** Present only when status === 'SUCCESS'. */
  data?: PosReceiptData;
  /** Present on error responses. */
  code?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Shared snapshot helpers (Phase 2C)
// ---------------------------------------------------------------------------

/**
 * Parse a PostgreSQL NUMERIC whole-rupiah snapshot string.
 *
 * Returns a discriminated union:
 *   - { valid: true,  value: 0 }     for "0" or "0.00"  (valid zero)
 *   - { valid: true,  value: N }     for "N" or "N.00"  (valid positive)
 *   - { valid: false }               for malformed / negative / null / undefined
 *
 * This distinguishes a valid zero from an invalid value, so callers can
 * decide whether to show "Rp 0" (valid zero snapshot) or "Rp --" (invalid).
 *
 * Accepts:  "6300", "6300.00", "0", "0.00", "100.00"
 * Rejects:  null, undefined, "", "abc", "-100", "100.50", "007", "1e5", " 100 "
 *
 * No floating-point arithmetic: integer part is parsed via Number() with
 * isSafeInteger guard; fractional part must be all zeros.
 */
export type SnapshotParseResult =
  | { valid: true; value: number }
  | { valid: false };

export function parseSnapshotWholeRupiah(
  raw: string | null | undefined,
): SnapshotParseResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { valid: false };
  }
  // Accept: digits with optional single decimal point + fractional digits
  if (!/^\d+(\.\d+)?$/.test(raw)) return { valid: false };

  const dotIdx = raw.indexOf('.');
  const intPart = dotIdx === -1 ? raw : raw.slice(0, dotIdx);
  const fracPart = dotIdx === -1 ? '' : raw.slice(dotIdx + 1);

  // No leading-zero padding ("007" is invalid; "0" alone is valid zero)
  if (intPart.length > 1 && intPart[0] === '0') return { valid: false };

  // Whole-rupiah invariant: all fractional digits must be '0'
  for (let i = 0; i < fracPart.length; i++) {
    if (fracPart[i] !== '0') return { valid: false };
  }

  const parsed = Number(intPart);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return { valid: false };

  return { valid: true, value: parsed };
}

/**
 * Parse a PostgreSQL NUMERIC rate snapshot string into a display label.
 *
 * Accepts ONLY well-formed non-negative decimal strings:
 *   - Digits with an optional single decimal point and fractional digits
 *   - No whitespace, no exponent notation, no leading + / - sign
 *
 * Returns:
 *   - a trimmed string like "10" or "5.5" for valid non-negative finite rates
 *   - null for invalid / negative / NaN / null / undefined / empty /
 *     whitespace / exponent / signed input
 *
 * Examples:
 *   "10.00" -> "10"   "5.50" -> "5.5"   "0" -> "0"   "0.00" -> "0"
 *   " 10"   -> null  "+10" -> null  "1e2" -> null  "10.5.0" -> null
 *
 * A null return means the caller must NOT display a "(X%)" suffix;
 * it does NOT mean the rate was 0.
 */
export function parseSnapshotRateLabel(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // Strict: digits, optional single dot, optional fractional digits.
  // Rejects whitespace, +/- signs, exponent (1e2), and multi-dot input.
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  // "10.00" -> "10";  "5.50" -> "5.5";  "0" -> "0"
  const s = String(n);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}
