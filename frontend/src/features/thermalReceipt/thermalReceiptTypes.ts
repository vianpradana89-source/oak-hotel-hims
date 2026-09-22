/**
 * Thermal Receipt — Shared Type Definitions
 *
 * Semua tipe yang dibutuhkan oleh thermal receipt system.
 * Dipisah agar semua komponen di folder ini menggunakan definisi yang sama.
 */

// ─── Data Sources ────────────────────────────────────────────────────────────

export interface FolioFinancials {
  total_price: number;
  amount_paid: number;
  applied_deposit: number;
  remaining_balance: number;
  payment_status: 'UNPAID' | 'PARTIAL' | 'PAID';
}

export interface ThermalDeposit {
  id: number;
  deposit_number: string;
  original_amount: number;
  payment_method: string;
  status: 'RECEIVED' | 'PARTIALLY_USED' | 'CLOSED' | 'CANCELLED';
  received_by: string;
  notes: string | null;
  created_at: string;
}

export interface ThermalIdentityRecord {
  id: number;
  document_type: string;
  document_holder_name: string;
  document_number_masked: string | null;
  status: 'HELD' | 'RETURNED';
  received_by: string;
  storage_location: string | null;
  notes: string | null;
  returned_by: string | null;
  returned_at: string | null;
  created_at: string;
}

export interface PropertyBrandingInfo {
  displayName: string;
  logoUrl: string | null;
  tagline: string | null;
  address: string | null;
  phone: string | null;
}

/** Full property info including address/phone (from properties list API). */
export interface PropertyInfo {
  id?: number;
  name?: string;
  address?: string | null;
  phone?: string | null;
  [key: string]: any;
}

// ─── Reservation Context ─────────────────────────────────────────────────────

export interface ThermalReceiptReservation {
  id: number;
  bid: string | null;
  guest_name: string;
  room_number: string | null;
  room_type_name: string | null;
  check_in: string;
  check_out: string;
  nights: number;
  guest_count: number;
  source: string | null;
  status: string;
}

// ─── Receipt Data (assembled before rendering) ───────────────────────────────

export interface ThermalReceiptData {
  property: PropertyBrandingInfo;
  reservation: ThermalReceiptReservation;
  printedBy: string;
  printedAt: string;
  width: ThermalWidth;
}

export interface ThermalDepositReceiptData extends ThermalReceiptData {
  deposit: ThermalDeposit;
}

export interface ThermalIdentityReceiptData extends ThermalReceiptData {
  identity: ThermalIdentityRecord;
}

// ─── Modal State ─────────────────────────────────────────────────────────────

export type ThermalStep =
  | 'select-type'       // Step 1: Pilih jenis receipt
  | 'select-subtype'    // Step 2 (Deposit only): Uang vs Identitas
  | 'select-record'     // Step 3: Pilih record jika banyak
  | 'confirm-print';    // Step 4: Preview + Print

export type ThermalWidth = 58 | 80;

export type ThermalReceiptType = 'folio' | 'deposit' | 'identity' | 'registration_form';
export type ThermalDepositSubType = 'cash' | 'identity';
