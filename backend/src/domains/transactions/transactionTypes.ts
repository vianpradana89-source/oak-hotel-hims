export type TransactionType = 'SALE' | 'PURCHASE' | 'EXPENSE' | 'INCOME';

export type TransactionStatus = 'POSTED' | 'VOIDED' | 'REVERSED' | 'CORRECTED' | 'DRAFT';

export type OperationalSheet = 'PROSES' | 'SELESAI' | 'BATAL' | 'HAPUS';

/**
 * ============================================================================
 * REPORTING ELIGIBILITY CONTRACT (TRANSACTION-2E FREEZE)
 * ============================================================================
 * 
 * Reporting eligibility is STRICTLY DERIVED from the operational lifecycle sheet:
 * - PROSES  -> reporting_eligible = false (WIP, draft, unreceived/partial purchases)
 * - SELESAI -> reporting_eligible = true  (Finalized/posted revenue & expense; fully received purchases)
 * - BATAL   -> reporting_eligible = false (Voided/cancelled/reversed transactions excluded from active performance)
 * - HAPUS   -> reporting_eligible = false (Soft-deleted drafts strictly excluded)
 * 
 * PURCHASE REPORTING CONTRACT:
 * - BELUM_DITERIMA     -> PROSES  -> reporting_eligible = false
 * - DITERIMA_SEBAGIAN  -> PROSES  -> reporting_eligible = false
 * - DITERIMA (LENGKAP) -> SELESAI -> reporting_eligible = true
 * - DITERIMA + UNPAID  -> SELESAI -> reporting_eligible = true (receiving drives operational recognition, NOT payment)
 * 
 * Future Reporting Domain must dynamically query canonical data using this rule.
 * DO NOT create duplicate reporting tables (e.g., sales_report_transactions).
 */
export function isReportingEligible(sheet: OperationalSheet): boolean {
  return sheet === 'SELESAI';
}

export type VerificationStatus = 'UNVERIFIED' | 'VERIFIED' | 'REJECTED';

export type ReceivingStatus = 'BELUM_DITERIMA' | 'DITERIMA_SEBAGIAN' | 'DITERIMA';

export type AttachmentPurpose = 'RECEIPT' | 'PAYMENT_PROOF' | 'INVOICE' | 'OTHER';

export type TransactionSourceType =
  | 'ROOM_CHARGE'
  | 'DAY_USE_ROOM'
  | 'EXTRA_BED'
  | 'EXTRA_PERSON'
  | 'EARLY_CHECKIN'
  | 'LATE_CHECKOUT'
  | 'PENALTY'
  | 'POS'
  | 'POS_ORDER'
  | 'MANUAL_INCOME'
  | 'MANUAL_EXPENSE'
  | 'MANUAL_PURCHASE'
  | 'MANUAL_SALE'
  | 'OTHER_SALE'
  | 'OTHER_INCOME'
  | 'OTHER_EXPENSE';

export type DepartmentCode =
  | 'FRONT_OFFICE'
  | 'HOUSEKEEPING'
  | 'FNB'
  | 'MAINTENANCE'
  | 'ADMIN'
  | 'HRD'
  | 'GENERAL';

export interface TransactionLine {
  id: string; // BIGINT as string
  property_id: number;
  transaction_id: string;
  product_id?: string | number | null;
  description_snapshot: string;
  quantity: number | string; // NUMERIC(12,3)
  unit: string;
  unit_price: number | string; // BIGINT integer IDR
  discount_amount: number | string; // BIGINT integer IDR
  line_total: number | string; // BIGINT integer IDR
  sort_order: number;
  created_at: string;
}

export interface TransactionLineInput {
  product_id?: number | string | null;
  description?: string;
  description_snapshot?: string;
  quantity: number;
  unit?: string;
  unit_price: number; // Integer IDR
  discount_amount?: number; // Integer IDR
}

export interface TransactionAttachment {
  id: string;
  property_id: number;
  transaction_id: string;
  file_name: string;
  original_name: string;
  mime_type: string;
  file_size: number;
  storage_path: string;
  uploaded_by: string | null;
  uploaded_at: string;
  attachment_purpose: AttachmentPurpose;
}

export interface TransactionPaymentRecord {
  id: number;
  transaction_id: string;
  amount: number;
  payment_method: string;
  reference_code: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
}

export interface TransactionRow {
  id: string; // BIGINT as string from pg
  property_id: number;
  transaction_no: string;
  transaction_date: string; // 'YYYY-MM-DD'
  transaction_time: string;
  transaction_type: TransactionType;
  source_type: string;
  source_id: string | null;
  source_reference: string | null;
  party_name: string | null;
  phone?: string | null;
  category_code: string;
  category_name: string;
  department_code: string;
  description: string;
  amount: string | number; // BIGINT integer IDR (Subtotal or Gross)
  discount_amount: string | number;
  service_amount: string | number;
  tax_amount: string | number;
  rounding_amount: string | number;
  net_amount: string | number;
  paid_amount?: string | number; // Derived dynamically from payment_transactions
  outstanding_amount?: string | number; // Derived dynamically
  payment_status: string;
  payment_method: string | null;
  transaction_status: TransactionStatus;
  guest_id: number | null;
  guest_name_snapshot: string | null;
  room_number_snapshot: string | null;
  reservation_id: number | null;
  booking_id: string | null;
  supplier_id?: string | number | null;
  supplier_name?: string | null;
  supplier_phone?: string | null;
  supplier_bank_name?: string | null;
  supplier_bank_account?: string | null;
  supplier_address?: string | null;
  receiving_status?: ReceivingStatus | null;
  received_at?: string | null;
  verification_status: VerificationStatus;
  verified_by_user_id?: string | null;
  verified_by_name_snapshot?: string | null;
  verified_at?: string | null;
  verification_note?: string | null;
  reversal_of_transaction_id: string | null;
  correction_group_id: string | null;
  notes: string | null;
  metadata: Record<string, any>;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  deleted_at?: string | null;
  deleted_by_user_id?: string | null;
  deleted_by_name_snapshot?: string | null;
  delete_reason?: string | null;
  operational_sheet?: OperationalSheet;
  lines?: TransactionLine[];
  attachments?: TransactionAttachment[];
  payments?: TransactionPaymentRecord[];
}

export interface CreateTransactionInput {
  propertyId: number;
  transactionNo?: string;
  transactionDate?: string; // default today hotel date
  transactionType: TransactionType;
  sourceType: string;
  sourceId?: string | null;
  sourceReference?: string | null;
  partyName?: string | null;
  phone?: string | null;
  categoryCode: string;
  categoryName: string;
  departmentCode?: DepartmentCode | string;
  description: string;
  amount: number; // integer IDR
  discountAmount?: number;
  serviceAmount?: number;
  taxAmount?: number;
  roundingAmount?: number;
  netAmount?: number;
  paymentStatus?: string;
  paymentMethod?: string | null;
  paidAmount?: number; // Initial payment amount if paid at transaction time
  transactionStatus?: TransactionStatus;
  guestId?: number | null;
  guestNameSnapshot?: string | null;
  roomNumberSnapshot?: string | null;
  reservationId?: number | null;
  bookingId?: number | string | null;
  supplierId?: number | string | null;
  receivingStatus?: ReceivingStatus | null;
  receivedAt?: string | null;
  verificationStatus?: VerificationStatus;
  reversalOfTransactionId?: number | string | null;
  correctionGroupId?: string | null;
  notes?: string | null;
  metadata?: Record<string, any>;
  lines?: TransactionLineInput[];
  actorUserId?: string | null;
  actorName?: string | null;
}

export interface CreatePurchaseTransactionDto {
  property_id: number;
  transaction_date?: string;
  category_code?: string;
  category_name?: string;
  supplier_id?: number | string | null;
  supplier_name?: string | null;
  supplier_phone?: string | null;
  supplier_bank_name?: string | null;
  supplier_bank_account?: string | null;
  supplier_address?: string | null;
  source_reference?: string | null; // e.g. No. Nota / Faktur
  receiving_status?: ReceivingStatus;
  received_at?: string | null;
  department_code?: string;
  description: string;
  lines: TransactionLineInput[];
  discount_amount?: number;
  transaction_discount?: number; // IDR
  rounding_amount?: number; // IDR
  payment_method?: string | null;
  paid_amount?: number; // IDR paid immediately
  transaction_status?: TransactionStatus;
  notes?: string | null;
  actor_name?: string | null;
  actor_user_id?: string | null;
}

export interface CreateExpenseTransactionDto {
  property_id: number;
  transaction_date?: string;
  category_code: string;
  category_name?: string;
  department_code?: string;
  supplier_id?: number | null;
  party_name?: string | null;
  description: string;
  amount: number; // BIGINT integer IDR
  payment_method?: string | null;
  source_reference?: string | null;
  is_paid?: boolean; // If true, registers payment immediately
  transaction_status?: TransactionStatus;
  notes?: string | null;
  actor_name?: string | null;
  actor_user_id?: string | null;
}

export interface CreateIncomeTransactionDto {
  property_id: number;
  transaction_date?: string;
  category_code?: string;
  category_name?: string;
  department_code?: string;
  customer_name: string;
  phone?: string | null;
  description: string;
  amount: number; // BIGINT integer IDR
  payment_method: string;
  source_reference?: string | null;
  lines?: TransactionLineInput[];
  transaction_status?: TransactionStatus;
  notes?: string | null;
  actor_name?: string | null;
  actor_user_id?: string | null;
}

export interface VerifyTransactionDto {
  property_id: number;
  verification_status: VerificationStatus;
  verification_note?: string | null;
  actor_user_id?: string | null;
  actor_name?: string | null;
}

export interface CreateCustomCategoryDto {
  property_id: number;
  code: string;
  name: string;
  transaction_type: TransactionType;
  department_code?: string;
}

export interface CustomCategoryRow {
  id: string;
  property_id: number;
  code: string;
  name: string;
  transaction_type: string;
  department_code: string;
  is_active: boolean;
  created_at: string;
}

export interface CreateManualTransactionDto {
  property_id: number;
  transaction_type: TransactionType;
  category_code: string;
  category_name?: string;
  department_code?: DepartmentCode | string;
  description: string;
  amount: number; // Integer IDR
  party_name?: string | null;
  phone?: string | null;
  source_reference?: string | null;
  payment_method?: string | null;
  notes?: string | null;
  booking_id?: number | null;
  reservation_id?: number | null;
  supplier_id?: number | null;
  lines?: TransactionLineInput[];
  actor_name?: string | null;
  actor_user_id?: string | null;
}

export interface TransactionFilterParams {
  property_id: number;
  transaction_type?: TransactionType;
  source_type?: string;
  category_code?: string;
  department_code?: string;
  payment_status?: string;
  payment_method?: string;
  transaction_status?: TransactionStatus;
  verification_status?: VerificationStatus;
  receiving_status?: ReceivingStatus;
  operational_status?: string; // 'ALL' | 'PROSES' | 'SELESAI' | 'BATAL' | 'HAPUS'
  operational_sheet?: OperationalSheet | string;
  start_date?: string;
  end_date?: string;
  search?: string;
  party_name?: string;
  reservation_id?: number;
  booking_id?: number | string;
  supplier_id?: number;
  limit?: number;
  offset?: number;
}

export interface TransactionSummary {
  total_sale: number;
  total_purchase: number;
  total_expense: number;
  total_income: number;
  count_sale: number;
  count_purchase: number;
  count_expense: number;
  count_income: number;
}

export interface TransactionSheetCounts {
  proses: number;
  selesai: number;
  batal: number;
  hapus?: number;
}

export interface TransactionQueryResult {
  transactions: TransactionRow[];
  total_count: number;
  summary: TransactionSummary;
  sheet_counts: TransactionSheetCounts;
  limit: number;
  offset: number;
}

export interface UpdateReceivingStatusDto {
  property_id: number;
  receiving_status: ReceivingStatus;
  received_at?: string | null;
  actor_name?: string | null;
  actor_user_id?: string | null;
}

export interface SettleTransactionPaymentDto {
  property_id: number;
  amount: number;
  payment_method: string;
  notes?: string | null;
  actor_name?: string | null;
  actor_user_id?: string | null;
}

export interface SoftDeleteTransactionDto {
  property_id: number;
  delete_reason: string;
  actor_name?: string | null;
  actor_user_id?: string | null;
}
