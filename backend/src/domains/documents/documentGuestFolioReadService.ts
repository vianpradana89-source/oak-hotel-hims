/**
 * documentGuestFolioReadService.ts
 *
 * Strictly READ-ONLY projection service for Guest Folio (Tagihan Tamu) documents.
 *
 * Architectural Guarantees:
 *   1. Wrapped in `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
 *      so PostgreSQL guarantees zero writes and a single consistent snapshot.
 *   2. Consumes authoritative financial calculators:
 *        - calculateReservationFinancials
 *        - calculateHotelCollectibleBalance
 *        - getEffectivePaymentStateForReservation
 *        - getDepositsByReservation / deriveDepositBalance
 *   3. Separates unapplied Deposit Custody (held guarantee) from Deposit Applied
 *      (`DEPOSIT_APPLY` / `DEPOSIT_UNAPPLY`) that reduces folio balance.
 *   4. Reconciles line-item Debit (+) and Credit (-) totals 100% against the
 *      authoritative financial summary in both EFFECTIVE and AUDIT view modes.
 *   5. Enforces property scope isolation (`bookings.property_id = propertyId`).
 *   6. Never exposes sensitive identity storage paths (`ktp_path`, `bukti_bayar_path`).
 */

import type { Pool, PoolClient } from 'pg';
import {
  calculateReservationFinancials,
  calculateHotelCollectibleBalance,
} from '../reservations/reservationFinancialCalculator';
import { shouldApplyPostedCommercialDiscount } from '../reservations/reservationBilling';
import { getDepositsByReservation } from '../deposits/depositService';
import { resolvePropertyTimezone } from '../../utils/propertyTimezone';
import { hasPermission, normalizeRoleName } from '../auth/authMiddleware';
import { hasAnyEffectivePermission } from '../settings/accessControlService';
import type { AuthUserPayload } from '../auth/authService';

export type GuestFolioScope = 'GUEST_FOLIO' | 'FULL_RESERVATION';

export interface GuestFolioLineItem {
  line_id: string;
  line_key: string;
  date: string;
  date_display: string;
  datetime_local: string;
  created_at_local: string;
  created_at_iso: string;
  chronology_ts: string;
  category:
    | 'ROOM_CHARGE'
    | 'STAY_EXTENSION'
    | 'STAY_CHARGE'
    | 'INCIDENTAL_CHARGE'
    | 'FNB_POS'
    | 'MINIBAR'
    | 'LAUNDRY'
    | 'DISCOUNT'
    | 'CHARGE_ADJUSTMENT'
    | 'PAYMENT'
    | 'GROUP_PAYMENT_ALLOCATION'
    | 'DEPOSIT_APPLY'
    | 'DEPOSIT_UNAPPLY'
    | 'REVERSAL';
  entry_type: string;
  description: string;
  detail_note: string | null;
  reference: string;
  quantity?: number | null;
  unit?: string | null;
  qty_label?: string | null;
  debit: number;
  credit: number;
  running_balance: number;
  included_in_scope: boolean;
  is_audit_only: boolean;
  status_badge:
    | 'POSTED'
    | 'VOIDED'
    | 'CORRECTED'
    | 'REPLACEMENT'
    | 'REVERSAL'
    | 'GROUP_ALLOCATION'
    | 'OTA_COVERED'
    | null;
  payer_badge: string | null;
  actor_name: string | null;
  notes: string | null;
}

export interface GuestFolioSiblingReservation {
  id: number;
  reservation_id: number;
  guest_name: string;
  room_number: string | null;
  room_type_name: string | null;
  check_in: string;
  check_out: string;
  status: string;
}

export interface GuestFolioDepositCustodyItem {
  id: number;
  deposit_number: string;
  payment_method: string;
  received_at_local: string;
  effective_received: number;
  applied: number;
  refunded: number;
  remaining: number;
  status: string;
  notes: string | null;
}

export interface GuestFolioDepositCustodySummary {
  can_view: boolean;
  has_deposits: boolean;
  deposit_count: number;
  effective_received: number;
  applied_to_folio: number;
  refunded: number;
  remaining_held_custody: number;
  total_received: number;
  total_applied: number;
  total_refunded: number;
  total_remaining_held: number;
  explanatory_note: string;
  items: GuestFolioDepositCustodyItem[];
}

export interface GuestFolioFinancialSummary {
  scope: GuestFolioScope;
  scope_label: string;
  payment_responsibility: 'HOTEL_COLLECT' | 'OTA_COLLECT';
  payment_responsibility_label: string;
  room_charges_total: number;
  additional_charges_total: number;
  discount_total: number;
  gross_charges: number;
  discounts_and_reversals: number;
  net_total_charges: number;
  effective_total_charges: number;
  full_reservation_total_charges: number;
  ota_covered_charges: number;
  ota_room_accommodation_responsibility: number;
  effective_amount_paid: number;
  payments_received_total: number;
  applied_deposit: number;
  deposit_applied_total: number;
  deposit_unapplied_total: number;
  net_deposit_applied_total: number;
  remaining_balance: number;
  overpayment_excess: number;
  payment_status: 'PAID' | 'PARTIAL' | 'UNPAID';
  payment_status_label: 'LUNAS' | 'DIBAYAR SEBAGIAN' | 'BELUM BAYAR';
  canonical_payment_source: 'CANONICAL_TRANSACTIONS' | 'FOLIO_FALLBACK';
}

export interface GuestFolioReconciliation {
  is_reconciled: boolean;
  effective_debit_total: number;
  effective_credit_total: number;
  effective_net_balance: number;
  effective_signed_balance: number;
  audit_debit_total: number;
  audit_credit_total: number;
  audit_net_balance: number;
  audit_signed_balance: number;
  calculator_net_charges: number;
  calculator_effective_paid: number;
  calculator_applied_deposit: number;
  calculator_remaining_balance: number;
  calculator_signed_balance: number;
  discrepancy_amount: number;
  discrepancy_reasons: string[];
}

export interface GuestFolioDocumentData {
  // Identity & Reference
  reservation_id: number;
  booking_id: number;
  bid: string | null;
  legacy_booking_number: string | null;
  folio_number: string;
  folio_reference: string;
  is_derived_reference: boolean;
  folio_label: string;
  reference_label: 'Kode Booking' | 'No. Booking' | 'ID Reservasi' | 'Referensi Reservasi';
  reference_value: string;
  status: string;
  status_label: string;

  property: {
    id: number;
    name: string;
    property_code: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    timezone: string;
  };

  reservation: {
    id: number;
    booking_id: number;
    reservation_code: string;
    bid: string | null;
    legacy_booking_number: string | null;
    status: string;
    status_label: string;
  };

  guest_identity: {
    primary_guest_id: number | null;
    primary_guest_name: string;
    guest_name: string;
    guest_phone: string | null;
    guest_email: string | null;
    guest_address: string | null;
    booker_name: string | null;
    booker_phone: string | null;
    booker_email: string | null;
    ota_name: string | null;
    guest_segment: string | null;
    company_or_agent_name: string | null;
  };

  responsibility: {
    scope: GuestFolioScope;
    scope_label: string;
    scope_description: string;
    payment_responsibility: 'HOTEL_COLLECT' | 'OTA_COLLECT';
    payment_responsibility_label: string;
    is_ota_collect: boolean;
    payer_label: string;
    ota_source: string | null;
  };

  stay: {
    room_id: number | null;
    room_number: string | null;
    room_type_id: number | null;
    room_type_name: string | null;
    room_type_code: string | null;
    check_in: string;
    check_out: string;
    nights: number;
    is_day_use: boolean;
    staying_guest_count: number;
    pax: number;
    adults: number;
    children: number;
    stay_status_label: string;
    is_multi_room_booking: boolean;
    booking_room_count: number;
    sibling_reservations: GuestFolioSiblingReservation[];
  };

  // Guest & Booker / Company / Payer
  primary_guest_id: number | null;
  guest_name: string;
  guest_phone: string | null;
  guest_email: string | null;
  guest_address: string | null;
  booker_name: string | null;
  booker_phone: string | null;
  booker_email: string | null;
  ota_name: string | null;
  guest_segment: string | null;
  booking_source: string | null;
  booking_channel: string | null;
  payment_responsibility: 'HOTEL_COLLECT' | 'OTA_COLLECT';
  payment_responsibility_label: string;

  // Stay & Room
  check_in: string;
  check_out: string;
  nights: number;
  is_day_use: boolean;
  room_id: number | null;
  room_number: string | null;
  room_type_id: number | null;
  room_type_name: string | null;
  room_type_code: string | null;
  staying_guest_count: number;
  pax: number;

  // Multi-room sibling indicator (never merged silently)
  is_multi_room_booking: boolean;
  booking_room_count: number;
  booking_siblings: GuestFolioSiblingReservation[];

  // Scope
  scope: GuestFolioScope;
  scope_label: string;
  scope_description: string;

  // Transaction lines (both Effective and Full Audit Trail)
  effective_lines: GuestFolioLineItem[];
  audit_lines: GuestFolioLineItem[];
  ota_covered_lines: GuestFolioLineItem[];

  // Authoritative Summary & Custody
  summary: GuestFolioFinancialSummary;
  financial_summary: GuestFolioFinancialSummary;
  deposit_custody: GuestFolioDepositCustodySummary;
  reconciliation: GuestFolioReconciliation;

  // Print & Property Metadata
  print_metadata: {
    property_id: number;
    property_name: string;
    property_code: string | null;
    property_address: string | null;
    property_phone: string | null;
    currency: string;
    property_timezone: string;
    printed_at_iso: string;
    printed_at_local: string;
    printed_by_user_id: number | null;
    printed_by_name: string;
    printed_by_role: string;
  };
}

export interface GuestFolioDocumentResult {
  status: 'OK' | 'ERROR';
  code?: string;
  message?: string;
  data?: GuestFolioDocumentData;
}

/* ------------------------------------------------------------------ */
/*  Formatting & Domain Classification Helpers                         */
/* ------------------------------------------------------------------ */

function formatDateInPropertyTz(value: Date | string | null | undefined, tz: string): string {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value || '';
  const m = parts.find((p) => p.type === 'month')?.value || '';
  const day = parts.find((p) => p.type === 'day')?.value || '';
  return y && m && day ? `${y}-${m}-${day}` : '';
}

function formatDateTimeIndonesianInTz(value: Date | string | null | undefined, tz: string): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const formatted = new Intl.DateTimeFormat('id-ID', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  const tzLabel =
    tz === 'Asia/Jakarta'
      ? 'WIB'
      : tz === 'Asia/Makassar' || tz === 'Asia/Ujung_Pandang'
        ? 'WITA'
        : tz === 'Asia/Jayapura'
          ? 'WIT'
          : tz;
  return `${formatted} ${tzLabel}`;
}

function formatReservationStatusLabel(status: string | null | undefined): string {
  const s = String(status || '').toUpperCase();
  if (s === 'BOOKED') return 'Terpesan (Booked)';
  if (s === 'CHECKED_IN') return 'Menginap (Checked-In)';
  if (s === 'CHECKED_OUT') return 'Selesai (Checked-Out)';
  if (s === 'CANCELLED') return 'Dibatalkan (Cancelled)';
  return s || '—';
}

function formatPaymentStatusLabel(
  status: 'PAID' | 'PARTIAL' | 'UNPAID'
): 'LUNAS' | 'DIBAYAR SEBAGIAN' | 'BELUM BAYAR' {
  if (status === 'PAID') return 'LUNAS';
  if (status === 'PARTIAL') return 'DIBAYAR SEBAGIAN';
  return 'BELUM BAYAR';
}

function formatPaymentMethodLabel(method: string | null | undefined): string {
  const m = String(method || 'CASH').toUpperCase();
  if (m === 'CASH') return 'Tunai (Cash)';
  if (m === 'TRANSFER' || m === 'BANK_TRANSFER') return 'Transfer Bank';
  if (m === 'QRIS') return 'QRIS';
  if (m === 'DEBIT' || m === 'DEBIT_CARD') return 'Kartu Debit';
  if (m === 'CREDIT_CARD' || m === 'CARD') return 'Kartu Kredit/EDC';
  return m;
}

function classifyChargeCategory(
  entryType: string,
  sourceType: string | null,
  revenueCategory: string | null,
  description: string
): GuestFolioLineItem['category'] {
  const et = String(entryType || '').toUpperCase();
  const st = String(sourceType || '').toUpperCase();
  const rc = String(revenueCategory || '').toUpperCase();
  const desc = String(description || '').toUpperCase();

  if (et === 'DISCOUNT') return 'DISCOUNT';
  if (et === 'STAY_SHORTEN_ADJUSTMENT') return 'CHARGE_ADJUSTMENT';
  if (et === 'REVERSAL' || et.endsWith('_REVERSAL')) return 'REVERSAL';
  if (st === 'STAY_EXTENSION' || et === 'STAY_EXTENSION') return 'STAY_EXTENSION';
  if (et === 'ROOM_CHARGE' || st === 'ROOM_CHARGE') return 'ROOM_CHARGE';
  if (
    et === 'MINIBAR' ||
    st.includes('MINIBAR') ||
    rc.includes('MINIBAR') ||
    desc.includes('MINIBAR')
  ) {
    return 'MINIBAR';
  }
  if (
    et === 'LAUNDRY' ||
    st.includes('LAUNDRY') ||
    rc.includes('LAUNDRY') ||
    desc.includes('LAUNDRY')
  ) {
    return 'LAUNDRY';
  }
  if (
    et === 'RESTAURANT' ||
    et === 'FNB' ||
    et === 'POS' ||
    et === 'BREAKFAST' ||
    st.includes('POS') ||
    st.includes('RESTAURANT') ||
    rc.includes('FNB') ||
    rc.includes('FOOD')
  ) {
    return 'FNB_POS';
  }
  return 'STAY_CHARGE';
}

function formatFolioEntryDescription(
  row: any,
  roomNumber?: string | null,
  roomTypeName?: string | null
): string {
  const rawDesc = String(row.description || '').trim();
  const entryType = String(row.entry_type || '').toUpperCase();
  const sourceType = String(row.source_type || '').toUpperCase();
  const qty = Number(row.quantity || 1);
  const unitPrice = Number(row.unit_price || 0);

  let baseLabel = rawDesc;
  if (
    !baseLabel ||
    baseLabel === 'Reservasi kamar' ||
    (entryType === 'ROOM_CHARGE' && sourceType !== 'STAY_EXTENSION')
  ) {
    if (entryType === 'ROOM_CHARGE' && sourceType !== 'STAY_EXTENSION') {
      if (roomNumber && roomTypeName) {
        baseLabel = `Kamar ${roomNumber} — ${roomTypeName}`;
      } else if (roomNumber) {
        baseLabel = `Kamar ${roomNumber} — Sewa Kamar`;
      } else if (roomTypeName) {
        baseLabel = `Tagihan Sewa Kamar — ${roomTypeName}`;
      } else {
        baseLabel = 'Tagihan Sewa Kamar';
      }
    } else if (entryType === 'DISCOUNT') {
      baseLabel = 'Potongan / Diskon Reservasi';
    } else if (entryType === 'DEPOSIT_APPLY') {
      baseLabel = 'Penerapan Deposit ke Tagihan';
    } else if (entryType === 'DEPOSIT_UNAPPLY') {
      baseLabel = 'Pembatalan Penerapan Deposit';
    } else {
      baseLabel = entryType.replace(/_/g, ' ');
    }
  }

  if (
    qty > 1 &&
    unitPrice > 0 &&
    !baseLabel.includes('x ') &&
    !baseLabel.includes('malam') &&
    entryType !== 'DEPOSIT_APPLY' &&
    entryType !== 'DEPOSIT_UNAPPLY' &&
    entryType !== 'ROOM_CHARGE'
  ) {
    return `${baseLabel} (${qty} x Rp ${unitPrice.toLocaleString('id-ID')})`;
  }
  return baseLabel;
}

export function resolveLineQtyAndUnit(
  fe: any,
  nights: number,
  postedRoomChargeCount: number
): {
  quantity: number | null;
  unit: string | null;
  qty_label: string;
} {
  const et = String(fe.entry_type || '').toUpperCase();
  const st = String(fe.source_type || '').toUpperCase();
  const rc = String(fe.revenue_category || '').toUpperCase();
  const desc = String(fe.description || '').toUpperCase();
  const ref = String(fe.reference || '').toUpperCase();
  const rawUnit = fe.unit ? String(fe.unit).trim() : null;
  const rawQty = fe.quantity != null && !isNaN(Number(fe.quantity)) ? Number(fe.quantity) : null;
  const calcMethod = fe.calculation_method_snapshot
    ? String(fe.calculation_method_snapshot).toUpperCase()
    : '';

  // 1. Discounts, Adjustments, Reversals -> always '—'
  if (
    et === 'DISCOUNT' ||
    et === 'STAY_SHORTEN_ADJUSTMENT' ||
    et === 'REVERSAL' ||
    et.endsWith('_REVERSAL')
  ) {
    return { quantity: null, unit: null, qty_label: '—' };
  }

  // 2. Day use (nights === 0) for Room Charge -> never '1 malam', return '—'
  if ((et === 'ROOM_CHARGE' || st === 'ROOM_CHARGE') && nights === 0) {
    return { quantity: null, unit: null, qty_label: '—' };
  }

  // 3. Stay Extension: respect explicit duration quantity; never guess 1 malam if missing
  if (st === 'STAY_EXTENSION' || et === 'STAY_EXTENSION') {
    if (rawQty != null && rawQty > 0) {
      const u = rawUnit || 'malam';
      return { quantity: rawQty, unit: u, qty_label: `${rawQty} ${u}` };
    }
    return { quantity: null, unit: rawUnit || null, qty_label: '—' };
  }

  // 4. Room Charge (nights > 0):
  // GB6-F02 (R8): In createCanonicalBooking (backend/src/index.ts), initial ROOM_CHARGE
  // is inserted with quantity = 1 as an aggregate reservation row counter, NOT duration (roomGross for total stay).
  // If rawUnit is null/empty, the unit is unproven and must NOT be defaulted to 'malam'.
  // Only when rawUnit is explicitly recorded (e.g. 'malam' or contractual package) is that unit applied.
  // When unit is null/unproven, return '—'.
  // Never overwrite explicit base room charge duration with total stay nights after extension.
  if (et === 'ROOM_CHARGE' || st === 'ROOM_CHARGE') {
    if (rawUnit === 'malam' && rawQty != null && rawQty > 0) {
      return { quantity: rawQty, unit: 'malam', qty_label: `${rawQty} malam` };
    }
    if (rawUnit && rawQty != null && rawQty > 0) {
      return { quantity: rawQty, unit: rawUnit, qty_label: `${rawQty} ${rawUnit}` };
    }
    return { quantity: null, unit: null, qty_label: '—' };
  }

  // 5. Explicit unit provided, but rawQty is missing/null -> '—' (GB6-F02: do NOT guess 1!)
  if (rawUnit && (rawQty == null || rawQty <= 0)) {
    return { quantity: null, unit: rawUnit, qty_label: '—' };
  }

  // 6. Explicit unit and explicit positive quantity -> return `${rawQty} ${rawUnit}`
  if (rawUnit && rawQty != null && rawQty > 0) {
    return { quantity: rawQty, unit: rawUnit, qty_label: `${rawQty} ${rawUnit}` };
  }

  // 7. Stay Charge calculation methods with explicit quantity (never default to 1 if rawQty is null)
  if (calcMethod === 'PER_NIGHT') {
    if (rawQty != null && rawQty > 0) {
      return { quantity: rawQty, unit: 'malam', qty_label: `${rawQty} malam` };
    }
    return { quantity: null, unit: 'malam', qty_label: '—' };
  }
  if (calcMethod === 'PER_PERSON' || et === 'EXTRA_PERSON' || st === 'EXTRA_PERSON') {
    if (rawQty != null && rawQty > 0) {
      return { quantity: rawQty, unit: 'orang', qty_label: `${rawQty} orang` };
    }
    return { quantity: null, unit: 'orang', qty_label: '—' };
  }
  if (
    calcMethod === 'PER_HOUR' ||
    et === 'EARLY_CHECKIN' ||
    et === 'LATE_CHECKOUT' ||
    st === 'EARLY_CHECKIN' ||
    st === 'LATE_CHECKOUT'
  ) {
    if (rawQty != null && rawQty > 0) {
      return { quantity: rawQty, unit: 'jam', qty_label: `${rawQty} jam` };
    }
    return { quantity: null, unit: 'jam', qty_label: '—' };
  }
  if (calcMethod === 'PER_UNIT' || et === 'EXTRA_BED' || st === 'EXTRA_BED') {
    if (rawQty != null && rawQty > 0) {
      return { quantity: rawQty, unit: 'unit', qty_label: `${rawQty} unit` };
    }
    return { quantity: null, unit: 'unit', qty_label: '—' };
  }

  // 8. POS / FNB: only genuine identified POS order / bill reference is 1 bon (never check desc.includes('BON'))
  if (
    et === 'RESTAURANT' ||
    et === 'FNB' ||
    et === 'POS' ||
    et === 'BREAKFAST' ||
    st.includes('POS') ||
    st.includes('RESTAURANT') ||
    rc.includes('FNB') ||
    rc.includes('FOOD')
  ) {
    const isGenuineBon =
      (st === 'POS_ORDER' || st === 'POS' || ref.startsWith('BON-') || ref.startsWith('POS-')) &&
      fe.source_id;
    if (isGenuineBon) {
      if (rawQty != null && rawQty > 0) {
        return { quantity: rawQty, unit: rawUnit || 'bon', qty_label: `${rawQty} ${rawUnit || 'bon'}` };
      }
      return { quantity: 1, unit: 'bon', qty_label: '1 bon' };
    }
    if (rawQty != null && rawQty > 0) {
      const u = rawUnit || null;
      return { quantity: rawQty, unit: u, qty_label: u ? `${rawQty} ${u}` : `${rawQty}` };
    }
    return { quantity: null, unit: rawUnit || null, qty_label: '—' };
  }

  // 9. Minibar (GB6-F02: do NOT guess 'botol' when unit is unrecorded)
  if (
    et === 'MINIBAR' ||
    st.includes('MINIBAR') ||
    rc.includes('MINIBAR') ||
    desc.includes('MINIBAR')
  ) {
    if (rawQty != null && rawQty > 0) {
      const u = rawUnit || null;
      return { quantity: rawQty, unit: u, qty_label: u ? `${rawQty} ${u}` : `${rawQty}` };
    }
    return { quantity: null, unit: rawUnit || null, qty_label: '—' };
  }

  // 10. Laundry (GB6-F02: do NOT guess 'pcs' when unit is unrecorded)
  if (
    et === 'LAUNDRY' ||
    st.includes('LAUNDRY') ||
    rc.includes('LAUNDRY') ||
    desc.includes('LAUNDRY')
  ) {
    if (rawQty != null && rawQty > 0) {
      const u = rawUnit || null;
      return { quantity: rawQty, unit: u, qty_label: u ? `${rawQty} ${u}` : `${rawQty}` };
    }
    return { quantity: null, unit: rawUnit || null, qty_label: '—' };
  }

  // Fallback for general charges with explicit quantity
  if (rawQty != null && rawQty > 0) {
    if (rawUnit) {
      return { quantity: rawQty, unit: rawUnit, qty_label: `${rawQty} ${rawUnit}` };
    }
    return { quantity: rawQty, unit: null, qty_label: `${rawQty}` };
  }

  return { quantity: null, unit: null, qty_label: '—' };
}

function formatFolioEntryReference(row: any, bid: string | null): string {
  const id = Number(row.id);
  const entryType = String(row.entry_type || '').toUpperCase();
  const sourceType = String(row.source_type || '').toUpperCase();
  const sourceId = row.source_id ? String(row.source_id).trim() : '';
  const ruleCode = row.rule_code_snapshot ? String(row.rule_code_snapshot).trim() : '';

  if (entryType === 'ROOM_CHARGE' && sourceType !== 'STAY_EXTENSION') {
    return bid ? `${bid} / FE-${id}` : `FE-${id}`;
  }
  if (sourceType === 'STAY_EXTENSION') {
    return `EXT / FE-${id}`;
  }
  if (entryType === 'DEPOSIT_APPLY' || entryType === 'DEPOSIT_UNAPPLY') {
    return sourceId ? `DEP-#${sourceId} / FE-${id}` : `DEP / FE-${id}`;
  }
  if (row.minibar_confirmation_id) {
    return `MB-#${row.minibar_confirmation_id} / FE-${id}`;
  }
  if (ruleCode) {
    return `${ruleCode} / FE-${id}`;
  }
  if (sourceId && sourceType && sourceType !== 'MANUAL_STAY_CHARGE') {
    return `${sourceType}-${sourceId} / FE-${id}`;
  }
  return `FE-${id}`;
}

function isOtaCoveredRoomChargeRow(row: any): boolean {
  const entryType = String(row.entry_type || '').toUpperCase();
  const sourceType = String(row.source_type || '').toUpperCase();
  const direction = String(row.direction || '').toUpperCase();
  if (direction === 'DEBIT' && entryType === 'ROOM_CHARGE' && sourceType !== 'STAY_EXTENSION') {
    return true;
  }
  if (
    direction === 'CREDIT' &&
    (entryType === 'ROOM_CHARGE_REVERSAL' ||
      (entryType === 'REVERSAL' && sourceType === 'ROOM_CHARGE'))
  ) {
    return true;
  }
  return false;
}

function formatShortDateIndonesian(dateYmd: string): string {
  if (!dateYmd) return '—';
  const s = String(dateYmd).slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return s;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function makeFolioLineItem(params: {
  line_key: string;
  date: string;
  datetime_local: string;
  created_at_iso: string;
  category: GuestFolioLineItem['category'];
  entry_type: string;
  description: string;
  reference: string;
  quantity?: number | null;
  unit?: string | null;
  qty_label?: string | null;
  debit: number;
  credit: number;
  running_balance?: number;
  included_in_scope: boolean;
  is_audit_only?: boolean;
  status_badge?: GuestFolioLineItem['status_badge'];
  payer_badge?: string | null;
  actor_name?: string | null;
  notes?: string | null;
}): GuestFolioLineItem {
  return {
    line_id: params.line_key,
    line_key: params.line_key,
    date: params.date,
    date_display: formatShortDateIndonesian(params.date),
    datetime_local: params.datetime_local,
    created_at_local: params.datetime_local,
    created_at_iso: params.created_at_iso,
    chronology_ts: params.created_at_iso || params.date,
    category: params.category,
    entry_type: params.entry_type,
    description: params.description,
    detail_note: params.notes || null,
    reference: params.reference,
    quantity: params.quantity !== undefined ? params.quantity : null,
    unit: params.unit !== undefined ? params.unit : null,
    qty_label: params.qty_label !== undefined ? params.qty_label : null,
    debit: params.debit,
    credit: params.credit,
    running_balance: 0,
    included_in_scope: params.included_in_scope,
    is_audit_only: Boolean(params.is_audit_only),
    status_badge: params.status_badge ?? 'POSTED',
    payer_badge: params.payer_badge ?? null,
    actor_name: params.actor_name ?? null,
    notes: params.notes ?? null,
  };
}

function computeRunningBalances(lines: GuestFolioLineItem[]): GuestFolioLineItem[] {
  let running = 0;
  return lines.map((line) => {
    if (line.included_in_scope) {
      running += line.debit - line.credit;
    }
    return {
      ...line,
      running_balance: running,
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Main Public Read Function                                          */
/* ------------------------------------------------------------------ */

export async function getDocumentGuestFolio(
  pool: Pool,
  propertyId: number,
  reservationId: number,
  options?: {
    scope?: string;
    user?: AuthUserPayload;
  }
): Promise<GuestFolioDocumentResult> {
  const requestedScope: GuestFolioScope =
    String(options?.scope || '').toUpperCase() === 'FULL_RESERVATION'
      ? 'FULL_RESERVATION'
      : 'GUEST_FOLIO';

  const client: PoolClient = await pool.connect();
  try {
    // Enforce engine-level read-only snapshot isolation
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    // 1. Load property metadata & canonical timezone
    const propRes = await client.query(
      `SELECT *
       FROM properties
       WHERE id = $1
       LIMIT 1`,
      [propertyId]
    );
    if ((propRes.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return {
        status: 'ERROR',
        code: 'PROPERTY_NOT_FOUND',
        message: `Properti ${propertyId} tidak ditemukan.`,
      };
    }
    const propRow = propRes.rows[0];
    const propertyTimezone = resolvePropertyTimezone(propRow.timezone);

    // 2. Load reservation + booking + canonical PRIMARY_GUEST + BOOKER + Room Master
    //    Strictly anchored on bookings.property_id = $2 for cross-property isolation.
    const resQuery = await client.query(
      `
      SELECT
        r.*,
        b.bid,
        COALESCE(r.booking_number, b.legacy_booking_number) AS legacy_booking_number,

        pg.guest_id AS primary_guest_id,
        COALESCE(NULLIF(TRIM(pg.full_name), ''), r.guest_name) AS guest_name,
        COALESCE(NULLIF(TRIM(pg.phone), ''), r.guest_phone) AS guest_phone,
        pg.email AS guest_email,
        pg.address AS guest_address,

        COALESCE(NULLIF(TRIM(bg.full_name), ''), r.booker_name, b.booker_name) AS booker_name,
        COALESCE(NULLIF(TRIM(bg.phone), ''), r.booker_phone, b.booker_phone) AS booker_phone,
        bg.email AS booker_email,

        COALESCE(NULLIF(TRIM(b.referral), ''), NULLIF(TRIM(b.channel), '')) AS ota_name,
        COALESCE(r.guest_segment, 'Reguler') AS guest_segment,
        b.booking_source,
        COALESCE(b.booking_channel, b.channel, r.booking_channel) AS booking_channel,
        COALESCE(b.payment_responsibility, 'HOTEL_COLLECT') AS payment_responsibility,

        TO_CHAR(r.check_in, 'YYYY-MM-DD') AS check_in,
        TO_CHAR(r.check_out, 'YYYY-MM-DD') AS check_out,
        GREATEST(0, (r.check_out::date - r.check_in::date))::int AS nights,

        rm.room_number,
        rm.room_type_id AS canonical_room_type_id,
        COALESCE(rt.name, r.booked_room_type_name_snapshot) AS room_type_name,
        COALESCE(rt.code, r.booked_room_type_code_snapshot) AS room_type_code,

        COALESCE(gc.staying_count, 1)::int AS staying_guest_count,

        COALESCE(r.total_price, 0)::numeric AS persisted_total_price,
        COALESCE(r.subtotal_amount, 0)::numeric AS persisted_subtotal,
        COALESCE(r.amount_paid, 0)::numeric AS persisted_amount_paid,
        COALESCE(b.created_at, NOW()) AS reservation_created_at
      FROM reservations r
      INNER JOIN bookings b ON b.id = r.booking_id
        AND b.property_id = $2
      LEFT JOIN rooms rm ON rm.id = r.room_id
        AND rm.property_id = b.property_id
      LEFT JOIN room_types rt ON rt.id = rm.room_type_id
        AND rt.property_id = b.property_id
      LEFT JOIN LATERAL (
        SELECT
          rg.guest_id,
          g.full_name,
          g.phone,
          g.email,
          g.address
        FROM reservation_guests rg
        JOIN guests g ON g.id = rg.guest_id
        WHERE rg.reservation_id = r.id
          AND rg.role = 'PRIMARY_GUEST'
        ORDER BY rg.id ASC
        LIMIT 1
      ) pg ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          g.full_name,
          g.phone,
          g.email
        FROM reservation_guests rg
        JOIN guests g ON g.id = rg.guest_id
        WHERE rg.reservation_id = r.id
          AND rg.role = 'BOOKER'
        ORDER BY rg.id ASC
        LIMIT 1
      ) bg ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS staying_count
        FROM reservation_guests rg
        WHERE rg.reservation_id = r.id
          AND rg.is_staying = TRUE
      ) gc ON TRUE
      WHERE r.id = $1
      LIMIT 1
      `,
      [reservationId, propertyId]
    );

    if ((resQuery.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return {
        status: 'ERROR',
        code: 'RESERVATION_NOT_FOUND',
        message: `Reservasi ${reservationId} tidak ditemukan atau bukan milik properti ini.`,
      };
    }

    const row = resQuery.rows[0];
    const bookingId = Number(row.booking_id);
    const bid: string | null = row.bid ? String(row.bid) : null;
    const paymentResponsibility: 'HOTEL_COLLECT' | 'OTA_COLLECT' =
      row.payment_responsibility === 'OTA_COLLECT' ? 'OTA_COLLECT' : 'HOTEL_COLLECT';

    // 3. Load sibling reservations in the same booking (multi-room awareness without merging)
    const siblingsRes = await client.query(
      `
      SELECT
        r2.id,
        r2.guest_name,
        rm2.room_number,
        COALESCE(rt2.name, r2.booked_room_type_name_snapshot) AS room_type_name,
        TO_CHAR(r2.check_in, 'YYYY-MM-DD') AS check_in,
        TO_CHAR(r2.check_out, 'YYYY-MM-DD') AS check_out,
        r2.status
      FROM reservations r2
      INNER JOIN bookings b2 ON b2.id = r2.booking_id
        AND b2.property_id = $2
      LEFT JOIN rooms rm2 ON rm2.id = r2.room_id
        AND rm2.property_id = b2.property_id
      LEFT JOIN room_types rt2 ON rt2.id = rm2.room_type_id
        AND rt2.property_id = b2.property_id
      WHERE r2.booking_id = $1
        AND r2.id <> $3
      ORDER BY r2.id ASC
      `,
      [bookingId, propertyId, reservationId]
    );

    const bookingSiblings: GuestFolioSiblingReservation[] = (siblingsRes.rows || []).map((s: any) => ({
      id: Number(s.id),
      reservation_id: Number(s.id),
      guest_name: s.guest_name || '',
      room_number: s.room_number != null ? String(s.room_number) : null,
      room_type_name: s.room_type_name ? String(s.room_type_name) : null,
      check_in: s.check_in || '',
      check_out: s.check_out || '',
      status: s.status || '',
    }));

    // 4. Authoritative read-only financial calculators
    const fullFinancials = await calculateReservationFinancials(client, reservationId, propertyId);
    const collectibleFinancials = await calculateHotelCollectibleBalance(
      client,
      reservationId,
      propertyId,
      paymentResponsibility
    );

    if (!fullFinancials) {
      await client.query('ROLLBACK');
      return {
        status: 'ERROR',
        code: 'RESERVATION_NOT_FOUND',
        message: `Data finansial reservasi ${reservationId} tidak ditemukan.`,
      };
    }

    // 5. Load all folio_entries for this reservation in strict chronological order (NO LIMIT)
    const folioRes = await client.query(
      `
      SELECT
        fe.*,
        COALESCE(fe.status, 'POSTED') AS status,
        COALESCE(fe.is_voided, FALSE) AS is_voided
      FROM folio_entries fe
      WHERE fe.reservation_id = $1
        AND (fe.property_id = $2 OR fe.property_id IS NULL)
      ORDER BY fe.created_at ASC, fe.id ASC
      `,
      [reservationId, propertyId]
    );
    const folioRows = folioRes.rows || [];

    // 6. Load all canonical payment_transactions & active/historical BOOKING_GROUP allocations (NO LIMIT)
    const directPaymentsRes = await client.query(
      `
      SELECT
        pt.*,
        COALESCE(pt.scope, 'ROOM_RESERVATION') AS scope
      FROM payment_transactions pt
      WHERE pt.reservation_id = $1
        AND COALESCE(pt.scope, 'ROOM_RESERVATION') = 'ROOM_RESERVATION'
        AND (pt.property_id = $2 OR pt.property_id IS NULL)
      ORDER BY pt.created_at ASC, pt.id ASC
      `,
      [reservationId, propertyId]
    );
    const directPaymentRows = directPaymentsRes.rows || [];

    const groupAllocsRes = await client.query(
      `
      SELECT
        pa.id AS allocation_id,
        pa.payment_transaction_id,
        pa.reservation_id,
        pa.allocated_amount,
        pa.status AS allocation_status,
        pa.created_at AS allocation_created_at,
        pt.transaction_type,
        pt.payment_method,
        pt.reference_code,
        pt.status AS payment_status,
        pt.reference_payment_id,
        pt.reason_code,
        pt.reason_text,
        pt.created_by,
        pt.created_at AS payment_created_at
      FROM payment_allocations pa
      INNER JOIN payment_transactions pt ON pt.id = pa.payment_transaction_id
      WHERE pa.reservation_id = $1
        AND pa.property_id = $2
        AND pt.scope = 'BOOKING_GROUP'
        AND pt.property_id = $2
      ORDER BY pt.created_at ASC, pa.id ASC
      `,
      [reservationId, propertyId]
    );
    const groupAllocRows = groupAllocsRes.rows || [];

    const canonicalPaymentHistoryExists =
      directPaymentRows.length > 0 || groupAllocRows.length > 0;

    // 7. Check whether commercial discount credit rows are applied by calculator
    const roomChargePosted = folioRows.reduce((sum: number, r: any) => {
      if (
        String(r.direction).toUpperCase() === 'DEBIT' &&
        String(r.entry_type).toUpperCase() === 'ROOM_CHARGE' &&
        !r.is_voided &&
        String(r.status || 'POSTED').toUpperCase() === 'POSTED'
      ) {
        return sum + Math.round(Number(r.amount || 0));
      }
      return sum;
    }, 0);
    const applyCommercialDiscount = shouldApplyPostedCommercialDiscount({
      roomChargePosted,
      persistedSubtotal: Number(row.persisted_subtotal || 0),
    });

    // 8. Build Reconciled Charge, Discount, Adjustment, Payment, and Deposit-Apply Lines
    const isOtaGuestScope =
      requestedScope === 'GUEST_FOLIO' && paymentResponsibility === 'OTA_COLLECT';

    const effectiveLinesRaw: GuestFolioLineItem[] = [];
    const auditLinesRaw: GuestFolioLineItem[] = [];
    const otaCoveredLinesRaw: GuestFolioLineItem[] = [];

    // Identify voided/corrected charge debit IDs that have a matching CREDIT reversal row
    const chargeReversalByParentId = new Map<number, any>();
    for (const fe of folioRows) {
      const dir = String(fe.direction || '').toUpperCase();
      const et = String(fe.entry_type || '').toUpperCase();
      if (
        dir === 'CREDIT' &&
        !['PAYMENT', 'CORRECTION_REPLACEMENT', 'DEPOSIT_APPLY', 'DISCOUNT'].includes(et) &&
        fe.reversal_of_entry_id != null
      ) {
        chargeReversalByParentId.set(Number(fe.reversal_of_entry_id), fe);
      }
    }

    let postedChargeDebitCount = 0;
    const postedRoomChargeDebitCount = folioRows.filter(
      (r: any) =>
        String(r.direction).toUpperCase() === 'DEBIT' &&
        String(r.entry_type).toUpperCase() === 'ROOM_CHARGE' &&
        String(r.source_type || '').toUpperCase() !== 'STAY_EXTENSION' &&
        !r.is_voided &&
        String(r.status || 'POSTED').toUpperCase() === 'POSTED'
    ).length;

    for (const fe of folioRows) {
      const feId = Number(fe.id);
      const dir = String(fe.direction || '').toUpperCase();
      const et = String(fe.entry_type || '').toUpperCase();
      const st = String(fe.source_type || '').toUpperCase();
      const status = String(fe.status || 'POSTED').toUpperCase();
      const isVoided = Boolean(fe.is_voided);
      const amount = Math.round(Number(fe.amount || 0));
      const localDate =
        fe.hotel_date || formatDateInPropertyTz(fe.created_at, propertyTimezone);
      const localDateTime = formatDateTimeIndonesianInTz(fe.created_at, propertyTimezone);
      const createdAtIso = fe.created_at ? new Date(fe.created_at).toISOString() : '';

      // 8A. Skip payment-mirror folio rows when canonical payment history exists
      if (
        ['PAYMENT', 'CORRECTION_REPLACEMENT', 'PAYMENT_VOID', 'PAYMENT_REVERSAL', 'REFUND_DEBIT'].includes(et)
      ) {
        if (!canonicalPaymentHistoryExists) {
          // Legacy fallback when no payment_transactions exist
          const isPayCredit = dir === 'CREDIT';
          const line = makeFolioLineItem({
            line_key: `fe-pay-${feId}`,
            date: localDate,
            datetime_local: localDateTime,
            created_at_iso: createdAtIso,
            category: 'PAYMENT',
            entry_type: et,
            description: formatFolioEntryDescription(fe),
            reference: `FE-${feId}`,
            debit: isPayCredit ? 0 : amount,
            credit: isPayCredit ? amount : 0,
            running_balance: 0,
            included_in_scope: true,
            status_badge: et.includes('VOID') || et.includes('REVERSAL') ? 'REVERSAL' : null,
            payer_badge: null,
            actor_name: fe.actor_name_snapshot || null,
            notes: fe.notes || null,
          });
          effectiveLinesRaw.push(line);
          auditLinesRaw.push(line);
        }
        continue;
      }

      // 8B. Deposit Apply / Deposit Unapply folio postings
      if (et === 'DEPOSIT_APPLY' || et === 'DEPOSIT_UNAPPLY') {
        if (status === 'POSTED' && !isVoided && fe.reversal_of_entry_id == null) {
          const isApply = et === 'DEPOSIT_APPLY' && dir === 'CREDIT';
          const depLine = makeFolioLineItem({
            line_key: `fe-dep-${feId}`,
            date: localDate,
            datetime_local: localDateTime,
            created_at_iso: createdAtIso,
            category: isApply ? 'DEPOSIT_APPLY' : 'DEPOSIT_UNAPPLY',
            entry_type: et,
            description: isApply
              ? `Penerapan Deposit ke Tagihan (${fe.description || 'Deposit'})`
              : `Pembatalan Penerapan Deposit (${fe.description || 'Deposit'})`,
            reference: formatFolioEntryReference(fe, bid),
            debit: isApply ? 0 : amount,
            credit: isApply ? amount : 0,
            running_balance: 0,
            included_in_scope: true,
            status_badge: 'POSTED',
            payer_badge: null,
            actor_name: fe.actor_name_snapshot || null,
            notes: fe.notes || null,
          });
          effectiveLinesRaw.push(depLine);
          auditLinesRaw.push(depLine);
        }
        continue;
      }

      // 8C. Commercial Discount rows
      if (dir === 'CREDIT' && et === 'DISCOUNT') {
        if (!isVoided && fe.reversal_of_entry_id == null && applyCommercialDiscount) {
          const includedInScope = !isOtaGuestScope;
          const discLine = makeFolioLineItem({
            line_key: `fe-disc-${feId}`,
            date: localDate,
            datetime_local: localDateTime,
            created_at_iso: createdAtIso,
            category: 'DISCOUNT',
            entry_type: et,
            description: formatFolioEntryDescription(fe, row.room_number, row.room_type_name),
            reference: formatFolioEntryReference(fe, bid),
            quantity: null,
            unit: null,
            qty_label: '—',
            debit: 0,
            credit: amount,
            running_balance: 0,
            included_in_scope: includedInScope,
            status_badge: isOtaGuestScope ? 'OTA_COVERED' : null,
            payer_badge: isOtaGuestScope ? 'TAGIHAN KAMAR OTA' : null,
            actor_name: fe.actor_name_snapshot || null,
            notes: fe.notes || null,
          });
          if (includedInScope) {
            effectiveLinesRaw.push(discLine);
            auditLinesRaw.push(discLine);
          } else {
            otaCoveredLinesRaw.push(discLine);
          }
        }
        continue;
      }

      // 8D. Debit Charge rows
      if (dir === 'DEBIT') {
        postedChargeDebitCount += 1;
        const otaCovered = isOtaCoveredRoomChargeRow(fe);
        const includedInScope = !(isOtaGuestScope && otaCovered);
        const pairedReversal = chargeReversalByParentId.get(feId);
        const isCorrectedOrVoidedWithReversal = isVoided && pairedReversal != null;
        const isReplacement = !isVoided && fe.reversal_of_entry_id != null;
        const stayNights =
          Boolean(row.is_day_use) || Number(row.nights) === 0 ? 0 : Number(row.nights || 0);
        const qtyInfo = resolveLineQtyAndUnit(
          fe,
          stayNights,
          postedRoomChargeDebitCount
        );

        const baseChargeLine = makeFolioLineItem({
          line_key: `fe-chg-${feId}`,
          date: localDate,
          datetime_local: localDateTime,
          created_at_iso: createdAtIso,
          category: classifyChargeCategory(et, st, fe.revenue_category, fe.description),
          entry_type: et,
          description: formatFolioEntryDescription(fe, row.room_number, row.room_type_name),
          reference: formatFolioEntryReference(fe, bid),
          quantity: qtyInfo.quantity,
          unit: qtyInfo.unit,
          qty_label: qtyInfo.qty_label,
          debit: amount,
          credit: 0,
          running_balance: 0,
          included_in_scope: includedInScope,
          status_badge: isVoided
            ? status === 'CORRECTED'
              ? 'CORRECTED'
              : 'VOIDED'
            : isReplacement
              ? 'REPLACEMENT'
              : !includedInScope
                ? 'OTA_COVERED'
                : null,
          payer_badge: otaCovered && paymentResponsibility === 'OTA_COLLECT' ? 'DITANGGUNG OTA' : null,
          actor_name: fe.actor_name_snapshot || null,
          notes: fe.void_reason || fe.notes || null,
        });

        if (!includedInScope) {
          if (!isCorrectedOrVoidedWithReversal) {
            otaCoveredLinesRaw.push(baseChargeLine);
          }
          continue;
        }

        // Always push to audit_lines; push to effective_lines only if not voided-with-reversal
        auditLinesRaw.push(baseChargeLine);
        if (!isCorrectedOrVoidedWithReversal) {
          effectiveLinesRaw.push(baseChargeLine);
        }
        continue;
      }

      // 8E. Credit Charge Reversal / Stay Shorten Adjustment rows
      if (
        dir === 'CREDIT' &&
        (fe.reversal_of_entry_id != null ||
          et === 'REVERSAL' ||
          et.endsWith('_REVERSAL') ||
          et === 'STAY_SHORTEN_ADJUSTMENT')
      ) {
        const otaCovered = isOtaCoveredRoomChargeRow(fe);
        const includedInScope = !(isOtaGuestScope && otaCovered);
        const parentId = fe.reversal_of_entry_id != null ? Number(fe.reversal_of_entry_id) : null;
        const pairedWithVoidedDebit =
          parentId != null && chargeReversalByParentId.get(parentId)?.id === fe.id;
        const stayNights =
          Boolean(row.is_day_use) || Number(row.nights) === 0 ? 0 : Number(row.nights || 0);
        const qtyInfo = resolveLineQtyAndUnit(
          fe,
          stayNights,
          postedRoomChargeDebitCount
        );

        const revLine = makeFolioLineItem({
          line_key: `fe-rev-${feId}`,
          date: localDate,
          datetime_local: localDateTime,
          created_at_iso: createdAtIso,
          category: et === 'STAY_SHORTEN_ADJUSTMENT' ? 'CHARGE_ADJUSTMENT' : 'REVERSAL',
          entry_type: et,
          description: formatFolioEntryDescription(fe, row.room_number, row.room_type_name),
          reference: parentId ? `REV-FE-${parentId} / FE-${feId}` : formatFolioEntryReference(fe, bid),
          quantity: qtyInfo.quantity,
          unit: qtyInfo.unit,
          qty_label: qtyInfo.qty_label,
          debit: 0,
          credit: amount,
          running_balance: 0,
          included_in_scope: includedInScope,
          status_badge: 'REVERSAL',
          payer_badge: otaCovered && paymentResponsibility === 'OTA_COLLECT' ? 'DITANGGUNG OTA' : null,
          actor_name: fe.actor_name_snapshot || null,
          notes: fe.notes || null,
        });

        if (!includedInScope) {
          if (!pairedWithVoidedDebit) {
            otaCoveredLinesRaw.push(revLine);
          }
          continue;
        }

        auditLinesRaw.push(revLine);
        if (!pairedWithVoidedDebit) {
          // Standalone credit adjustment (such as STAY_SHORTEN_ADJUSTMENT) affects effective total
          effectiveLinesRaw.push(revLine);
        }
      }
    }

    // Fallback if reservation has persisted_total_price > 0 but 0 posted charge debit rows
    const persistedTotalPrice = Math.round(Number(row.persisted_total_price || 0));
    if (postedChargeDebitCount === 0 && persistedTotalPrice > 0) {
      const isDayUse = Boolean(row.is_day_use) || Number(row.nights) === 0;
      const nights = isDayUse ? 0 : Number(row.nights || 1);
      const otaCovered = paymentResponsibility === 'OTA_COLLECT';
      const includedInScope = !(isOtaGuestScope && otaCovered);
      const fallbackLine = makeFolioLineItem({
        line_key: `res-fallback-charge-${reservationId}`,
        date: row.check_in || formatDateInPropertyTz(row.reservation_created_at, propertyTimezone),
        datetime_local: formatDateTimeIndonesianInTz(row.reservation_created_at, propertyTimezone),
        created_at_iso: row.reservation_created_at
          ? new Date(row.reservation_created_at).toISOString()
          : '',
        category: 'ROOM_CHARGE',
        entry_type: 'ROOM_CHARGE',
        description: row.room_number
          ? isDayUse
            ? `Kamar ${row.room_number} — ${row.room_type_name || 'Sewa Kamar'} (Day Use)`
            : `Kamar ${row.room_number} — ${row.room_type_name || 'Sewa Kamar'} (${nights} malam)`
          : isDayUse
            ? `Tagihan Sewa Kamar (${row.room_type_name || 'Kamar'} · Day Use)`
            : `Tagihan Sewa Kamar (${row.room_type_name || 'Kamar'} · ${nights} malam)`,
        reference: bid || `RES-${reservationId}`,
        quantity: isDayUse ? null : nights,
        unit: isDayUse ? null : 'malam',
        qty_label: isDayUse ? '—' : `${nights} malam`,
        debit: persistedTotalPrice,
        credit: 0,
        running_balance: 0,
        included_in_scope: includedInScope,
        status_badge: !includedInScope ? 'OTA_COVERED' : null,
        payer_badge: otaCovered ? 'DITANGGUNG OTA' : null,
        actor_name: null,
        notes: null,
      });
      if (includedInScope) {
        effectiveLinesRaw.push(fallbackLine);
        auditLinesRaw.push(fallbackLine);
      } else {
        otaCoveredLinesRaw.push(fallbackLine);
      }
    }

    // 9. Append Canonical Direct Payments & Group Allocations
    if (canonicalPaymentHistoryExists) {
      for (const pt of directPaymentRows) {
        const ptId = Number(pt.id);
        const txType = String(pt.transaction_type || '').toUpperCase();
        const ptStatus = String(pt.status || '').toUpperCase();
        const amount = Math.round(Number(pt.amount || 0));
        const methodLabel = formatPaymentMethodLabel(pt.payment_method);
        const localDate = formatDateInPropertyTz(pt.created_at, propertyTimezone);
        const localDateTime = formatDateTimeIndonesianInTz(pt.created_at, propertyTimezone);
        const createdAtIso = pt.created_at ? new Date(pt.created_at).toISOString() : '';
        const refCode = pt.reference_code ? ` (${pt.reference_code})` : '';

        if (
          ptStatus === 'SUCCESS' &&
          (txType === 'PAYMENT' || txType === 'CORRECTION_REPLACEMENT')
        ) {
          const isReplacement = txType === 'CORRECTION_REPLACEMENT' || pt.reference_payment_id != null;
          const payLine = makeFolioLineItem({
            line_key: `pt-${ptId}`,
            date: localDate,
            datetime_local: localDateTime,
            created_at_iso: createdAtIso,
            category: 'PAYMENT',
            entry_type: txType,
            description: isReplacement
              ? `Pembayaran Tamu — ${methodLabel}${refCode} [Koreksi dari #${pt.reference_payment_id}]`
              : `Pembayaran Tamu — ${methodLabel}${refCode}`,
            reference: `PAY-#${ptId}`,
            debit: 0,
            credit: amount,
            running_balance: 0,
            included_in_scope: true,
            status_badge: isReplacement ? 'REPLACEMENT' : null,
            payer_badge: null,
            actor_name: pt.created_by || null,
            notes: pt.reason_text || null,
          });
          effectiveLinesRaw.push(payLine);
          auditLinesRaw.push(payLine);
        } else if (
          (ptStatus === 'VOIDED' || ptStatus === 'CORRECTED') &&
          (txType === 'PAYMENT' || txType === 'CORRECTION_REPLACEMENT')
        ) {
          // Audit mode: show original voided/corrected payment (Credit) AND its offsetting reversal (Debit)
          auditLinesRaw.push(
            makeFolioLineItem({
              line_key: `pt-orig-${ptId}`,
              date: localDate,
              datetime_local: localDateTime,
              created_at_iso: createdAtIso,
              category: 'PAYMENT',
              entry_type: txType,
              description: `Pembayaran Tamu — ${methodLabel}${refCode}`,
              reference: `PAY-#${ptId}`,
              debit: 0,
              credit: amount,
              running_balance: 0,
              included_in_scope: true,
              status_badge: ptStatus === 'CORRECTED' ? 'CORRECTED' : 'VOIDED',
              payer_badge: null,
              actor_name: pt.created_by || null,
              notes: pt.reason_text || null,
            })
          );
        } else if (txType === 'REVERSAL' || txType === 'VOID_REVERSAL' || txType === 'CORRECTION_REVERSAL') {
          auditLinesRaw.push(
            makeFolioLineItem({
              line_key: `pt-rev-${ptId}`,
              date: localDate,
              datetime_local: localDateTime,
              created_at_iso: createdAtIso,
              category: 'REVERSAL',
              entry_type: txType,
              description:
                txType === 'VOID_REVERSAL'
                  ? `Pembatalan (Void) Pembayaran #${pt.reference_payment_id || ptId}`
                  : pt.reference_payment_id
                    ? `Reversal Koreksi Pembayaran #${pt.reference_payment_id}`
                    : `Reversal Pembayaran #${ptId}`,
              reference: `REV-PAY-#${pt.reference_payment_id || ptId} / PAY-#${ptId}`,
              debit: amount,
              credit: 0,
              running_balance: 0,
              included_in_scope: true,
              status_badge: 'REVERSAL',
              payer_badge: null,
              actor_name: pt.created_by || null,
              notes: pt.reason_text || null,
            })
          );
        }
      }

      // Group Booking Payment Allocations
      for (const ga of groupAllocRows) {
        const allocId = Number(ga.allocation_id);
        const ptId = Number(ga.payment_transaction_id);
        const allocStatus = String(ga.allocation_status || '').toUpperCase();
        const ptStatus = String(ga.payment_status || '').toUpperCase();
        const txType = String(ga.transaction_type || '').toUpperCase();
        const amount = Math.round(Number(ga.allocated_amount || 0));
        const methodLabel = formatPaymentMethodLabel(ga.payment_method);
        const ts = ga.payment_created_at || ga.allocation_created_at;
        const localDate = formatDateInPropertyTz(ts, propertyTimezone);
        const localDateTime = formatDateTimeIndonesianInTz(ts, propertyTimezone);
        const createdAtIso = ts ? new Date(ts).toISOString() : '';

        if (
          allocStatus === 'ACTIVE' &&
          ptStatus === 'SUCCESS' &&
          (txType === 'PAYMENT' || txType === 'CORRECTION_REPLACEMENT')
        ) {
          const allocLine = makeFolioLineItem({
            line_key: `ga-${allocId}`,
            date: localDate,
            datetime_local: localDateTime,
            created_at_iso: createdAtIso,
            category: 'GROUP_PAYMENT_ALLOCATION',
            entry_type: 'BOOKING_GROUP_ALLOCATION',
            description: `Alokasi Pembayaran Group Booking — ${methodLabel}`,
            reference: `PAY-#${ptId} / ALLOC-#${allocId}`,
            debit: 0,
            credit: amount,
            running_balance: 0,
            included_in_scope: true,
            status_badge: 'GROUP_ALLOCATION',
            payer_badge: null,
            actor_name: ga.created_by || null,
            notes: ga.reason_text || null,
          });
          effectiveLinesRaw.push(allocLine);
          auditLinesRaw.push(allocLine);
        } else if (allocStatus !== 'ACTIVE' && amount > 0) {
          // Balanced historical pair in audit mode for superseded/reversed group allocation
          auditLinesRaw.push(
            makeFolioLineItem({
              line_key: `ga-orig-${allocId}`,
              date: localDate,
              datetime_local: localDateTime,
              created_at_iso: createdAtIso,
              category: 'GROUP_PAYMENT_ALLOCATION',
              entry_type: 'BOOKING_GROUP_ALLOCATION',
              description: `Alokasi Pembayaran Group Booking — ${methodLabel}`,
              reference: `PAY-#${ptId} / ALLOC-#${allocId}`,
              debit: 0,
              credit: amount,
              running_balance: 0,
              included_in_scope: true,
              status_badge: 'CORRECTED',
              payer_badge: null,
              actor_name: ga.created_by || null,
              notes: ga.reason_text || null,
            })
          );
          auditLinesRaw.push(
            makeFolioLineItem({
              line_key: `ga-rev-${allocId}`,
              date: localDate,
              datetime_local: localDateTime,
              created_at_iso: createdAtIso,
              category: 'REVERSAL',
              entry_type: 'BOOKING_GROUP_ALLOCATION_REVERSAL',
              description: `Reversal Alokasi Pembayaran Group Booking #${allocId}`,
              reference: `REV-ALLOC-#${allocId}`,
              debit: amount,
              credit: 0,
              running_balance: 0,
              included_in_scope: true,
              status_badge: 'REVERSAL',
              payer_badge: null,
              actor_name: ga.created_by || null,
              notes: ga.reason_text || null,
            })
          );
        }
      }
    } else if (
      effectiveLinesRaw.filter((l) => l.category === 'PAYMENT').length === 0 &&
      Number(row.persisted_amount_paid || 0) > 0
    ) {
      const fallbackPaid = Math.round(Number(row.persisted_amount_paid || 0));
      const fallbackPayLine = makeFolioLineItem({
        line_key: `res-fallback-paid-${reservationId}`,
        date: row.check_in || formatDateInPropertyTz(row.reservation_created_at, propertyTimezone),
        datetime_local: formatDateTimeIndonesianInTz(row.reservation_created_at, propertyTimezone),
        created_at_iso: row.reservation_created_at
          ? new Date(row.reservation_created_at).toISOString()
          : '',
        category: 'PAYMENT',
        entry_type: 'PAYMENT',
        description: 'Pembayaran Reservasi Terdaftar',
        reference: bid || `RES-${reservationId}`,
        debit: 0,
        credit: fallbackPaid,
        running_balance: 0,
        included_in_scope: true,
        status_badge: null,
        payer_badge: null,
        actor_name: null,
        notes: null,
      });
      effectiveLinesRaw.push(fallbackPayLine);
      auditLinesRaw.push(fallbackPayLine);
    }

    // Sort chronologically by created_at_iso, then line_key
    const sortChronological = (a: GuestFolioLineItem, b: GuestFolioLineItem) => {
      if (a.created_at_iso && b.created_at_iso && a.created_at_iso !== b.created_at_iso) {
        return a.created_at_iso.localeCompare(b.created_at_iso);
      }
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.line_key.localeCompare(b.line_key);
    };

    const effectiveLines = computeRunningBalances(effectiveLinesRaw.sort(sortChronological));
    const auditLines = computeRunningBalances(auditLinesRaw.sort(sortChronological));
    const otaCoveredLines = computeRunningBalances(otaCoveredLinesRaw.sort(sortChronological));

    // 10. Deposit Custody (Separate from Folio Balance)
    let canViewDepositCustody = true;
    if (options?.user) {
      const hasDepositPerm = await hasPermission(options.user, 'deposit.view', client);
      const hasTransaksiView = await hasAnyEffectivePermission(
        client,
        propertyId,
        Number(options.user.id),
        ['Transaksi'],
        'view'
      );
      canViewDepositCustody = hasDepositPerm || hasTransaksiView;
    }

    let depositCustody: GuestFolioDepositCustodySummary = {
      can_view: canViewDepositCustody,
      has_deposits: false,
      deposit_count: 0,
      effective_received: 0,
      applied_to_folio: 0,
      refunded: 0,
      remaining_held_custody: 0,
      total_received: 0,
      total_applied: 0,
      total_refunded: 0,
      total_remaining_held: 0,
      explanatory_note:
        'Deposit yang masih ditahan (custody) belum mengurangi Sisa Tagihan kecuali telah diterapkan ke folio (DEPOSIT_APPLY).',
      items: [],
    };

    if (canViewDepositCustody) {
      const deposits = await getDepositsByReservation(client, propertyId, reservationId);
      let totalReceived = 0;
      let totalApplied = 0;
      let totalRefunded = 0;
      let totalRemaining = 0;

      const items: GuestFolioDepositCustodyItem[] = deposits.map((d) => {
        const bal = d.balance || d.derived || {};
        const effRecv = Number(bal.effective_received || 0);
        const appAmt = Number(bal.applied || 0);
        const refAmt = Number(bal.refunded || 0);
        const remAmt = Number(bal.remaining || 0);
        totalReceived += effRecv;
        totalApplied += appAmt;
        totalRefunded += refAmt;
        totalRemaining += remAmt;
        return {
          id: Number(d.id),
          deposit_number: d.deposit_number,
          payment_method: formatPaymentMethodLabel(d.payment_method),
          received_at_local: formatDateTimeIndonesianInTz(d.received_at || d.created_at, propertyTimezone),
          effective_received: effRecv,
          applied: appAmt,
          refunded: refAmt,
          remaining: remAmt,
          status: bal.status || d.status || 'RECEIVED',
          notes: d.notes || null,
        };
      });

      depositCustody = {
        can_view: true,
        has_deposits: items.length > 0 && (totalReceived > 0 || totalApplied > 0 || totalRefunded > 0),
        deposit_count: items.length,
        effective_received: totalReceived,
        applied_to_folio: totalApplied,
        refunded: totalRefunded,
        remaining_held_custody: totalRemaining,
        total_received: totalReceived,
        total_applied: totalApplied,
        total_refunded: totalRefunded,
        total_remaining_held: totalRemaining,
        explanatory_note:
          'Deposit yang masih ditahan (custody) belum mengurangi Sisa Tagihan kecuali telah diterapkan ke folio (DEPOSIT_APPLY).',
        items,
      };
    }

    // 11. Build Authoritative Summary & Verify Reconciliation
    const calcNetCharges = isOtaGuestScope
      ? collectibleFinancials.hotel_collectible_total
      : fullFinancials.total_price;
    const calcEffectivePaid = isOtaGuestScope
      ? collectibleFinancials.amount_paid
      : fullFinancials.amount_paid;
    const calcAppliedDeposit = isOtaGuestScope
      ? collectibleFinancials.applied_deposit
      : fullFinancials.applied_deposit;
    const calcRemainingBalance = isOtaGuestScope
      ? collectibleFinancials.hotel_collectible_remaining_balance
      : fullFinancials.remaining_balance;
    const calcPaymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' = isOtaGuestScope
      ? (calcRemainingBalance <= 0 && (calcNetCharges > 0 || calcEffectivePaid > 0 || calcAppliedDeposit > 0)
          ? 'PAID'
          : (calcEffectivePaid > 0 || calcAppliedDeposit > 0 ? 'PARTIAL' : 'UNPAID'))
      : fullFinancials.payment_status;

    const otaCoveredCharges = isOtaGuestScope
      ? Math.max(0, fullFinancials.total_price - collectibleFinancials.hotel_collectible_total)
      : 0;

    const rawNet = calcNetCharges - calcEffectivePaid - calcAppliedDeposit;
    const overpaymentExcess = rawNet < 0 ? Math.abs(rawNet) : 0;

    const calcSignedBalance = rawNet; // positive if debit remaining, negative if credit overpayment

    const effectiveDebitTotal = effectiveLines.reduce(
      (sum, l) => sum + (l.included_in_scope ? l.debit : 0),
      0
    );
    const effectiveCreditTotal = effectiveLines.reduce(
      (sum, l) => sum + (l.included_in_scope ? l.credit : 0),
      0
    );
    const effectiveSignedBalance = effectiveDebitTotal - effectiveCreditTotal;
    const effectiveNetBalance = Math.max(0, effectiveSignedBalance);

    const auditDebitTotal = auditLines.reduce(
      (sum, l) => sum + (l.included_in_scope ? l.debit : 0),
      0
    );
    const auditCreditTotal = auditLines.reduce(
      (sum, l) => sum + (l.included_in_scope ? l.credit : 0),
      0
    );
    const auditSignedBalance = auditDebitTotal - auditCreditTotal;
    const auditNetBalance = Math.max(0, auditSignedBalance);

    const discrepancyReasons: string[] = [];

    if (effectiveSignedBalance !== calcSignedBalance) {
      discrepancyReasons.push(
        `Saldo bersih baris efektif (${effectiveSignedBalance}) tidak cocok dengan saldo kalkulator (${calcSignedBalance}). Selisih: ${Math.abs(effectiveSignedBalance - calcSignedBalance)}.`
      );
    }

    if (auditSignedBalance !== calcSignedBalance) {
      discrepancyReasons.push(
        `Saldo bersih baris audit (${auditSignedBalance}) tidak cocok dengan saldo kalkulator (${calcSignedBalance}). Selisih: ${Math.abs(auditSignedBalance - calcSignedBalance)}.`
      );
    }

    if (effectiveSignedBalance !== auditSignedBalance) {
      discrepancyReasons.push(
        `Saldo bersih baris audit (${auditSignedBalance}) tidak cocok dengan saldo baris efektif (${effectiveSignedBalance}). Jejak audit tidak seimbang.`
      );
    }

    const discrepancyAmount = Math.max(
      Math.abs(effectiveSignedBalance - calcSignedBalance),
      Math.abs(auditSignedBalance - calcSignedBalance)
    );

    const isReconciled = discrepancyReasons.length === 0;

    // Breakdown totals from effectiveLines
    const roomChargesTotal = effectiveLines
      .filter((l) => l.included_in_scope && l.category === 'ROOM_CHARGE' && l.debit > 0)
      .reduce((sum, l) => sum + l.debit, 0);
    const chargeAdjustmentCredits = effectiveLines
      .filter((l) => l.included_in_scope && (l.category === 'CHARGE_ADJUSTMENT' || l.category === 'REVERSAL') && l.credit > 0)
      .reduce((sum, l) => sum + l.credit, 0);
    const additionalChargesTotal = effectiveLines
      .filter(
        (l) =>
          l.included_in_scope &&
          l.debit > 0 &&
          l.category !== 'ROOM_CHARGE' &&
          l.category !== 'DEPOSIT_UNAPPLY' &&
          l.category !== 'PAYMENT' &&
          l.category !== 'REVERSAL'
      )
      .reduce((sum, l) => sum + l.debit, 0);
    const discountTotal = effectiveLines
      .filter((l) => l.included_in_scope && l.category === 'DISCOUNT' && l.credit > 0)
      .reduce((sum, l) => sum + l.credit, 0);
    const depositAppliedTotal = effectiveLines
      .filter((l) => l.included_in_scope && l.category === 'DEPOSIT_APPLY' && l.credit > 0)
      .reduce((sum, l) => sum + l.credit, 0);
    const depositUnappliedTotal = effectiveLines
      .filter((l) => l.included_in_scope && l.category === 'DEPOSIT_UNAPPLY' && l.debit > 0)
      .reduce((sum, l) => sum + l.debit, 0);

    const grossCharges = roomChargesTotal + additionalChargesTotal;
    const discountsAndReversals = discountTotal + chargeAdjustmentCredits;

    const scopeLabel =
      requestedScope === 'FULL_RESERVATION'
        ? 'Seluruh Tagihan Reservasi Kamar'
        : paymentResponsibility === 'OTA_COLLECT'
          ? 'Tagihan Tamu (Biaya Tambahan / Hotel Collect)'
          : 'Tagihan Tamu (Kamar & Biaya Menginap)';

    const scopeDescription =
      requestedScope === 'FULL_RESERVATION'
        ? `Menampilkan seluruh beban dan pembayaran pada reservasi kamar ${row.room_number ? `No. ${row.room_number}` : `#${reservationId}`}.`
        : paymentResponsibility === 'OTA_COLLECT'
          ? `Reservasi OTA Collect${row.ota_name ? ` (${row.ota_name})` : ''}: biaya kamar pokok ditanggung OTA; dokumen ini menagihkan biaya tambahan/insidental yang menjadi tanggung jawab tamu.`
          : `Menampilkan seluruh tagihan kamar, biaya tambahan, pembayaran efektif, dan penggunaan deposit pada reservasi kamar ${row.room_number ? `No. ${row.room_number}` : `#${reservationId}`}.`;

    const paymentResponsibilityLabel =
      paymentResponsibility === 'OTA_COLLECT'
        ? `OTA Collect${row.ota_name ? ` (${row.ota_name})` : ''}`
        : 'Hotel Collect (Tamu / Pemesan)';

    const canonicalPaymentSource: 'CANONICAL_TRANSACTIONS' | 'FOLIO_FALLBACK' =
      canonicalPaymentHistoryExists ? 'CANONICAL_TRANSACTIONS' : 'FOLIO_FALLBACK';

    const summary: GuestFolioFinancialSummary = {
      scope: requestedScope,
      scope_label: scopeLabel,
      payment_responsibility: paymentResponsibility,
      payment_responsibility_label: paymentResponsibilityLabel,
      gross_charges: grossCharges,
      discounts_and_reversals: discountsAndReversals,
      net_total_charges: calcNetCharges,
      full_reservation_total_charges: fullFinancials.total_price,
      ota_covered_charges: otaCoveredCharges,
      effective_amount_paid: calcEffectivePaid,
      applied_deposit: calcAppliedDeposit,
      remaining_balance: calcRemainingBalance,
      overpayment_excess: overpaymentExcess,
      payment_status: calcPaymentStatus,
      payment_status_label: formatPaymentStatusLabel(calcPaymentStatus),
      canonical_payment_source: canonicalPaymentSource,
      room_charges_total: Math.max(0, roomChargesTotal - chargeAdjustmentCredits),
      additional_charges_total: additionalChargesTotal,
      discount_total: discountTotal,
      effective_total_charges: calcNetCharges,
      payments_received_total: calcEffectivePaid,
      deposit_applied_total: depositAppliedTotal,
      deposit_unapplied_total: depositUnappliedTotal,
      net_deposit_applied_total: calcAppliedDeposit,
      ota_room_accommodation_responsibility: otaCoveredCharges,
    };

    const reconciliation: GuestFolioReconciliation = {
      is_reconciled: isReconciled,
      effective_debit_total: effectiveDebitTotal,
      effective_credit_total: effectiveCreditTotal,
      effective_net_balance: effectiveNetBalance,
      effective_signed_balance: effectiveSignedBalance,
      audit_debit_total: auditDebitTotal,
      audit_credit_total: auditCreditTotal,
      audit_net_balance: auditNetBalance,
      audit_signed_balance: auditSignedBalance,
      calculator_net_charges: calcNetCharges,
      calculator_effective_paid: calcEffectivePaid,
      calculator_applied_deposit: calcAppliedDeposit,
      calculator_remaining_balance: calcRemainingBalance,
      calculator_signed_balance: calcSignedBalance,
      discrepancy_amount: discrepancyAmount,
      discrepancy_reasons: discrepancyReasons,
    };

    const now = new Date();
    const printedByName =
      options?.user?.full_name || options?.user?.username || 'Petugas Front Office';
    const printedByRole = normalizeRoleName(options?.user?.role || 'Front Office');

    const referenceValue = bid
      ? `${bid} / RES-${reservationId}`
      : row.legacy_booking_number
        ? `${row.legacy_booking_number} / RES-${reservationId}`
        : `RES-${reservationId}`;

    const officialFolioNumber = row.folio_number ? String(row.folio_number).trim() : null;
    const folioNumber = officialFolioNumber || (bid ? `GF-${bid}-R${reservationId}` : `GF-RES-${reservationId}`);
    const isDerivedReference = !officialFolioNumber;
    const folioLabel = isDerivedReference ? 'No. Referensi Folio (Turunan)' : 'No. Folio';
    const stayingGuestCount = Number(row.staying_guest_count || 1);
    const totalRoomCount = bookingSiblings.length + 1;

    await client.query('COMMIT');

    return {
      status: 'OK',
      data: {
        property: {
          id: Number(propRow.id),
          name: propRow.name || 'OAK Hotel',
          property_code: propRow.property_code ? String(propRow.property_code) : null,
          address: propRow.address ? String(propRow.address) : null,
          phone: propRow.phone ? String(propRow.phone) : null,
          email: propRow.email ? String(propRow.email) : null,
          timezone: propertyTimezone,
        },
        reservation: {
          id: Number(row.id),
          booking_id: bookingId,
          reservation_code: referenceValue,
          bid,
          legacy_booking_number: row.legacy_booking_number ? String(row.legacy_booking_number) : null,
          status: row.status || '',
          status_label: formatReservationStatusLabel(row.status),
        },
        guest_identity: {
          primary_guest_id: row.primary_guest_id != null ? Number(row.primary_guest_id) : null,
          primary_guest_name: row.guest_name || '—',
          guest_name: row.guest_name || '—',
          guest_phone: row.guest_phone ? String(row.guest_phone) : null,
          guest_email: row.guest_email ? String(row.guest_email) : null,
          guest_address: row.guest_address ? String(row.guest_address) : null,
          booker_name: row.booker_name ? String(row.booker_name) : null,
          booker_phone: row.booker_phone ? String(row.booker_phone) : null,
          booker_email: row.booker_email ? String(row.booker_email) : null,
          ota_name: row.ota_name ? String(row.ota_name) : null,
          guest_segment: row.guest_segment ? String(row.guest_segment) : null,
          company_or_agent_name: row.ota_name
            ? String(row.ota_name)
            : row.booker_name
              ? String(row.booker_name)
              : null,
        },
        responsibility: {
          scope: requestedScope,
          scope_label: scopeLabel,
          scope_description: scopeDescription,
          payment_responsibility: paymentResponsibility,
          payment_responsibility_label: paymentResponsibilityLabel,
          is_ota_collect: paymentResponsibility === 'OTA_COLLECT',
          payer_label: paymentResponsibilityLabel,
          ota_source: row.ota_name ? String(row.ota_name) : row.booking_source ? String(row.booking_source) : null,
        },
        stay: {
          check_in: row.check_in || '',
          check_out: row.check_out || '',
          nights: Number(row.nights || 0),
          is_day_use: Boolean(row.is_day_use),
          room_id: row.room_id != null ? Number(row.room_id) : null,
          room_number: row.room_number != null ? String(row.room_number) : null,
          room_type_id: row.canonical_room_type_id != null ? Number(row.canonical_room_type_id) : null,
          room_type_name: row.room_type_name ? String(row.room_type_name) : null,
          room_type_code: row.room_type_code ? String(row.room_type_code) : null,
          staying_guest_count: stayingGuestCount,
          pax: stayingGuestCount,
          adults: stayingGuestCount,
          children: 0,
          stay_status_label: formatReservationStatusLabel(row.status),
          is_multi_room_booking: bookingSiblings.length > 0,
          booking_room_count: totalRoomCount,
          sibling_reservations: bookingSiblings,
        },

        reservation_id: Number(row.id),
        booking_id: bookingId,
        bid,
        legacy_booking_number: row.legacy_booking_number ? String(row.legacy_booking_number) : null,
        folio_number: folioNumber,
        folio_reference: referenceValue,
        is_derived_reference: isDerivedReference,
        folio_label: folioLabel,
        reference_label: 'Referensi Reservasi',
        reference_value: referenceValue,
        status: row.status || '',
        status_label: formatReservationStatusLabel(row.status),

        primary_guest_id: row.primary_guest_id != null ? Number(row.primary_guest_id) : null,
        guest_name: row.guest_name || '—',
        guest_phone: row.guest_phone ? String(row.guest_phone) : null,
        guest_email: row.guest_email ? String(row.guest_email) : null,
        guest_address: row.guest_address ? String(row.guest_address) : null,
        booker_name: row.booker_name ? String(row.booker_name) : null,
        booker_phone: row.booker_phone ? String(row.booker_phone) : null,
        booker_email: row.booker_email ? String(row.booker_email) : null,
        ota_name: row.ota_name ? String(row.ota_name) : null,
        guest_segment: row.guest_segment ? String(row.guest_segment) : null,
        booking_source: row.booking_source ? String(row.booking_source) : null,
        booking_channel: row.booking_channel ? String(row.booking_channel) : null,
        payment_responsibility: paymentResponsibility,
        payment_responsibility_label: paymentResponsibilityLabel,

        check_in: row.check_in || '',
        check_out: row.check_out || '',
        nights: Number(row.nights || 0),
        is_day_use: Boolean(row.is_day_use),
        room_id: row.room_id != null ? Number(row.room_id) : null,
        room_number: row.room_number != null ? String(row.room_number) : null,
        room_type_id:
          row.canonical_room_type_id != null ? Number(row.canonical_room_type_id) : null,
        room_type_name: row.room_type_name ? String(row.room_type_name) : null,
        room_type_code: row.room_type_code ? String(row.room_type_code) : null,
        staying_guest_count: stayingGuestCount,
        pax: stayingGuestCount,

        is_multi_room_booking: bookingSiblings.length > 0,
        booking_room_count: totalRoomCount,
        booking_siblings: bookingSiblings,

        scope: requestedScope,
        scope_label: scopeLabel,
        scope_description: scopeDescription,

        effective_lines: effectiveLines,
        audit_lines: auditLines,
        ota_covered_lines: otaCoveredLines,

        summary,
        financial_summary: summary,
        deposit_custody: depositCustody,
        reconciliation,

        print_metadata: {
          property_id: Number(propRow.id),
          property_name: propRow.name || 'OAK Hotel',
          property_code: propRow.property_code ? String(propRow.property_code) : null,
          property_address: propRow.address ? String(propRow.address) : null,
          property_phone: propRow.phone ? String(propRow.phone) : null,
          currency: propRow.currency_code ? String(propRow.currency_code) : 'IDR',
          property_timezone: propertyTimezone,
          printed_at_iso: now.toISOString(),
          printed_at_local: formatDateTimeIndonesianInTz(now, propertyTimezone),
          printed_by_user_id: options?.user?.id != null ? Number(options.user.id) : null,
          printed_by_name: printedByName,
          printed_by_role: printedByRole,
        },
      },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
