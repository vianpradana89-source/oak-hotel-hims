/**
 * POS receipt authoritative types — frontend contract layer.
 *
 * These types mirror the backend receipt response shape.  Monetary values
 * are kept as the exact string the backend emits (whole-rupiah string),
 * never coerced to number.  BIGINT identifiers (sale.id, settlement.
 * transaction_id) are strings.  Item names/codes come exclusively from
 * the immutable snapshot columns, never from the live menu.
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
   * Authoritative whole-rupiah string (e.g. "30000").
   * Must be EXACT-equal to settlement.amount and sale.net_amount.
   */
  total_amount: string;
  discount_type: PosReceiptDiscountType;
  discount_value: string | null;
  discount_reason: string | null;
  discount_amount: string;
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
  /** Authoritative whole-rupiah string; must EXACT-match order.total_amount. */
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
  /** Authoritative whole-rupiah string; must EXACT-match order.total_amount. */
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
