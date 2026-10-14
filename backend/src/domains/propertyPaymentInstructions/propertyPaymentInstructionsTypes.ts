export interface PropertyPaymentInstructionsRecord {
  id?: number;
  property_id: number;
  bank_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_branch: string | null;
  payment_note: string | null;
  is_active: boolean;
  qris_enabled?: boolean;
  qris_terminal_name?: string | null;
  qris_merchant_id?: string | null;
  qris_image_path?: string | null;
  transfer_enabled?: boolean;
  transfer_ref_note?: string | null;
  debit_enabled?: boolean;
  debit_edc_terminal?: string | null;
  created_at?: string;
  updated_at?: string;
  updated_by?: string | null;
}

export interface UpdatePropertyPaymentInstructionsDTO {
  property_id?: number;
  bank_name?: string | null;
  bank_account_name?: string | null;
  bank_account_number?: string | null;
  bank_branch?: string | null;
  payment_note?: string | null;
  is_active?: boolean;
  qris_enabled?: boolean;
  qris_terminal_name?: string | null;
  qris_merchant_id?: string | null;
  transfer_enabled?: boolean;
  transfer_ref_note?: string | null;
  debit_enabled?: boolean;
  debit_edc_terminal?: string | null;
}
