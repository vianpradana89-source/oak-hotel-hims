export interface PropertyPaymentInstructionsDto {
  id?: number;
  property_id: number;
  bank_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_branch: string | null;
  payment_note: string | null;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
  updated_by?: string | null;
}

export interface UpdatePropertyPaymentInstructionsPayload {
  property_id: number;
  bank_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_branch: string | null;
  payment_note: string | null;
  is_active: boolean;
}
