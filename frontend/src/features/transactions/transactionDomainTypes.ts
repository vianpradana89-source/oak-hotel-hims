export type TransactionType = 'SALE' | 'PURCHASE' | 'EXPENSE' | 'INCOME';
export type TransactionStatus = 'POSTED' | 'VOIDED' | 'REVERSED' | 'CORRECTED';
export type VerificationStatus = 'UNVERIFIED' | 'VERIFIED' | 'REJECTED';
export type ReceivingStatus = 'BELUM_DITERIMA' | 'DITERIMA_SEBAGIAN' | 'DITERIMA' | 'DITERIMA_LENGKAP';
export type AttachmentPurpose = 'RECEIPT' | 'PAYMENT_PROOF' | 'INVOICE' | 'OTHER';
export type DepartmentCode = 'FRONT_OFFICE' | 'HOUSEKEEPING' | 'FNB' | 'MAINTENANCE' | 'ADMIN' | 'HRD' | 'GENERAL';

export type SupplierEntityType = 'SUPPLIER' | 'VENDOR' | 'BOTH';
export type SupplierStatus = 'ACTIVE' | 'INACTIVE' | 'BLACKLISTED';

export interface Supplier {
  id: string | number;
  property_id: number;
  code?: string | null;
  name: string;
  legal_name?: string | null;
  entity_type?: SupplierEntityType;
  category?: string | null;
  contact_person?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  bank_name?: string | null;
  bank_account?: string | null;
  bank_holder?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
  tax_id?: string | null;
  payment_terms_days?: number | null;
  default_department_code?: string | null;
  status?: SupplierStatus;
  notes?: string | null;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}


export interface TransactionLine {
  id: string;
  property_id: number;
  transaction_id: string;
  product_id?: string | null;
  description_snapshot: string;
  quantity: number | string;
  unit: string;
  unit_price: number | string;
  discount_amount: number | string;
  line_total: number | string;
  sort_order: number;
  created_at: string;
}

export interface TransactionLineInput {
  product_id?: number | string | null;
  description?: string;
  description_snapshot?: string;
  quantity: number;
  unit?: string;
  unit_price: number;
  discount_amount?: number;
}

export interface TransactionAttachment {
  id: number | string;
  property_id: number;
  transaction_id: number | string;
  file_name: string;
  original_name: string;
  mime_type: string;
  file_size: number;
  storage_path: string;
  uploaded_by: string | null;
  uploaded_at: string;
  attachment_purpose: AttachmentPurpose;
}

export interface CustomCategory {
  id: string;
  property_id: number;
  code: string;
  name: string;
  transaction_type: string;
  department_code: string;
  is_active: boolean;
  created_at: string;
}

export interface TransactionRecord {
  id: number | string;
  property_id: number;
  transaction_no: string;
  transaction_date: string;
  transaction_time: string;
  transaction_type: TransactionType;
  source_type: string;
  source_id: string | null;
  source_reference: string | null;
  party_name: string | null;
  phone?: string | null;
  category_code: string;
  category_name: string;
  department_code: DepartmentCode;
  description: string;
  amount: number;
  discount_amount: number;
  service_amount: number;
  tax_amount: number;
  rounding_amount?: number;
  net_amount: number;
  paid_amount?: number;
  outstanding_amount?: number;
  payment_status: string;
  payment_method: string | null;
  transaction_status: TransactionStatus;
  guest_id: number | null;
  guest_name_snapshot: string | null;
  room_number_snapshot: string | null;
  reservation_id: number | null;
  booking_id: number | string | null;
  booking_number?: string | null;
  booking_bid?: string | null;
  stay_type?: string | null;
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
  reversal_of_transaction_id: number | string | null;
  correction_group_id: string | null;
  notes: string | null;
  metadata: any;
  created_by: string | null;
  created_at: string;
  updated_by?: string | null;
  updated_at?: string;
  deleted_at?: string | null;
  deleted_by_user_id?: string | null;
  deleted_by_name_snapshot?: string | null;
  delete_reason?: string | null;
  operational_sheet?: OperationalSheet;
  lines?: TransactionLine[];
  attachments?: TransactionAttachment[];
  linked_payments?: Array<{
    id: number;
    transaction_type: string;
    amount: number;
    payment_method: string;
    reference_code: string | null;
    status: string;
    created_at: string;
  }>;
  audit_logs?: Array<{
    id: number;
    action: string;
    details: any;
    created_at: string;
  }>;
}

export interface TransactionDetailResponse {
  transaction: TransactionRecord;
  lines: TransactionLine[];
  attachments: TransactionAttachment[];
  payment_ledger: Array<{
    id: number | string;
    payment_no: string;
    amount: number;
    payment_method: string;
    status: string;
    created_at: string;
    notes?: string | null;
  }>;
  audit_logs?: Array<{
    id: number;
    action: string;
    details: any;
    created_at: string;
  }>;
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

export interface CategoryOption {
  code: string;
  name: string;
  type: TransactionType;
  default_department: DepartmentCode;
  allow_manual?: boolean;
  is_custom?: boolean;
  is_active?: boolean;
}

export interface DepartmentOption {
  code: DepartmentCode;
  name: string;
}

export type OperationalSheet = 'PROSES' | 'SELESAI' | 'BATAL' | 'HAPUS';
export type OperationalStatus = 'ALL' | 'PROSES' | 'SELESAI' | 'BATAL' | 'HAPUS';

export interface TransactionSheetCounts {
  proses: number;
  selesai: number;
  batal: number;
  hapus?: number;
}

export interface TransactionQueryResult {
  transactions: TransactionRecord[];
  total_count: number;
  summary: TransactionSummary;
  sheet_counts: TransactionSheetCounts;
  limit: number;
  offset: number;
}

export interface SoftDeleteTransactionPayload {
  property_id: number;
  delete_reason: string;
  actor_name?: string;
  actor_user_id?: string;
}

export interface OperationalStatusDisplay {
  label: string;
  group: 'PROSES' | 'SELESAI' | 'BATAL' | 'HAPUS';
  badgeClass: string;
}

export function mapToOperationalStatus(tx: {
  transaction_type?: string;
  transaction_status: string;
  receiving_status?: string | null;
  deleted_at?: string | null;
  operational_sheet?: OperationalSheet;
}): OperationalStatusDisplay {
  if (tx.operational_sheet === 'HAPUS' || tx.deleted_at) {
    return {
      label: 'Hapus',
      group: 'HAPUS',
      badgeClass: 'bg-slate-100 text-slate-500 border-slate-300'
    };
  }

  const tStatus = String(tx.transaction_status || '').toUpperCase();
  if (['VOIDED', 'CANCELLED', 'REVERSED'].includes(tStatus)) {
    return {
      label: 'Batal',
      group: 'BATAL',
      badgeClass: 'bg-rose-50 text-rose-700 border-rose-200'
    };
  }

  const type = String(tx.transaction_type || '').toUpperCase();
  if (type === 'PURCHASE') {
    const recStatus = String(tx.receiving_status || '').toUpperCase();
    if (['DITERIMA', 'DITERIMA_LENGKAP'].includes(recStatus)) {
      return {
        label: 'Selesai',
        group: 'SELESAI',
        badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200'
      };
    }
    return {
      label: 'Proses',
      group: 'PROSES',
      badgeClass: 'bg-amber-50 text-amber-700 border-amber-200'
    };
  }

  if (tStatus === 'POSTED') {
    return {
      label: 'Selesai',
      group: 'SELESAI',
      badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200'
    };
  }

  return {
    label: 'Proses',
    group: 'PROSES',
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-200'
  };
}

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
