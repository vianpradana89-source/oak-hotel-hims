export type PaymentEvidenceType =
  | 'CASH_RECEIPT'
  | 'BANK_TRANSFER'
  | 'QRIS_RECEIPT'
  | 'EDC_SLIP'
  | 'DEPOSIT_PROOF'
  | 'BANK_RECEIPT'
  | 'OTHER';

export const ALLOWED_EVIDENCE_TYPES: PaymentEvidenceType[] = [
  'CASH_RECEIPT',
  'BANK_TRANSFER',
  'QRIS_RECEIPT',
  'EDC_SLIP',
  'DEPOSIT_PROOF',
  'BANK_RECEIPT',
  'OTHER'
];

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf'
] as const;

export type AllowedMimeType = typeof ALLOWED_MIME_TYPES[number];

export const MAX_EVIDENCE_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export interface PaymentEvidenceRow {
  id: number;
  property_id: number;
  reservation_id: number;
  payment_transaction_id: number;
  evidence_type: PaymentEvidenceType;
  storage_key: string;
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
  note: string | null;
  is_active: boolean;
  uploaded_by_user_id: string | null;
  uploaded_by_name_snapshot: string | null;
  uploaded_by_role_snapshot: string | null;
  uploaded_at: string;
  deactivated_by_user_id: string | null;
  deactivated_by_name_snapshot: string | null;
  deactivated_by_role_snapshot: string | null;
  deactivated_at: string | null;
  deactivation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentEvidenceMetadata {
  id: number;
  property_id: number;
  reservation_id: number;
  payment_transaction_id: number;
  evidence_type: PaymentEvidenceType;
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
  note: string | null;
  is_active: boolean;
  uploaded_by_user_id: string | null;
  uploaded_by_name_snapshot: string | null;
  uploaded_by_role_snapshot: string | null;
  uploaded_at: string;
  deactivated_by_user_id: string | null;
  deactivated_by_name_snapshot: string | null;
  deactivated_by_role_snapshot: string | null;
  deactivated_at: string | null;
  deactivation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export function toEvidenceMetadata(row: PaymentEvidenceRow): PaymentEvidenceMetadata {
  return {
    id: row.id,
    property_id: row.property_id,
    reservation_id: row.reservation_id,
    payment_transaction_id: row.payment_transaction_id,
    evidence_type: row.evidence_type,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    file_size_bytes: Number(row.file_size_bytes),
    note: row.note,
    is_active: row.is_active,
    uploaded_by_user_id: row.uploaded_by_user_id,
    uploaded_by_name_snapshot: row.uploaded_by_name_snapshot,
    uploaded_by_role_snapshot: row.uploaded_by_role_snapshot,
    uploaded_at: row.uploaded_at,
    deactivated_by_user_id: row.deactivated_by_user_id,
    deactivated_by_name_snapshot: row.deactivated_by_name_snapshot,
    deactivated_by_role_snapshot: row.deactivated_by_role_snapshot,
    deactivated_at: row.deactivated_at,
    deactivation_reason: row.deactivation_reason,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
