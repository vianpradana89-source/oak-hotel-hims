export type PaymentEvidenceType =
  | 'CASH_RECEIPT'
  | 'BANK_TRANSFER'
  | 'QRIS_RECEIPT'
  | 'EDC_SLIP'
  | 'DEPOSIT_PROOF'
  | 'BANK_RECEIPT'
  | 'OTHER';

export interface EvidenceTypeOption {
  type: PaymentEvidenceType;
  label: string;
  description: string;
}

export const EVIDENCE_TYPE_OPTIONS: EvidenceTypeOption[] = [
  { type: 'BANK_TRANSFER', label: 'Bukti Transfer Bank', description: 'Tangkapan layar m-banking / bukti transfer ATM' },
  { type: 'QRIS_RECEIPT', label: 'Struk QRIS', description: 'Struk transaksi QRIS / notifikasi merchant' },
  { type: 'CASH_RECEIPT', label: 'Kwitansi / Tanda Terima Tunai', description: 'Foto kwitansi fisik pembayaran tunai' },
  { type: 'EDC_SLIP', label: 'Slip EDC / Kartu', description: 'Slip cetak mesin EDC debit/kredit' },
  { type: 'DEPOSIT_PROOF', label: 'Bukti Deposit / Uang Muka', description: 'Bukti titipan dana deposit tamu' },
  { type: 'BANK_RECEIPT', label: 'Rekening Koran / Bukti Bank', description: 'Konfirmasi cetak bank / mutasi rekening' },
  { type: 'OTHER', label: 'Bukti Lainnya', description: 'Dokumen bukti pendukung lainnya (wajib catatan)' }
];

export interface PaymentEvidenceItem {
  id: number;
  property_id: number;
  reservation_id: number;
  payment_transaction_id: number;
  evidence_type: PaymentEvidenceType;
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
  note?: string | null;
  is_active: boolean;
  uploaded_by_user_id?: string | null;
  uploaded_by_name_snapshot?: string | null;
  uploaded_by_role_snapshot?: string | null;
  uploaded_at: string;
  deactivated_by_user_id?: string | null;
  deactivated_by_name_snapshot?: string | null;
  deactivated_by_role_snapshot?: string | null;
  deactivated_at?: string | null;
  deactivation_reason?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type EvidenceStatus = 'ATTACHED' | 'MISSING';

export interface EvidenceStatusBadgeInfo {
  status: EvidenceStatus;
  label: string;
  count: number;
  badgeClass: string;
}
