export type StayChargeType = 'EXTRA_BED' | 'EXTRA_PERSON' | 'EARLY_CHECKIN' | 'LATE_CHECKOUT' | 'PENALTY';

export type ChargeMethod = 'FIXED_AMOUNT' | 'PERCENTAGE_OF_NIGHTLY_RATE' | 'FULL_NIGHT' | 'FREE' | 'MANUAL';

export interface StayChargeRule {
  id: number;
  property_id: number;
  charge_type: StayChargeType;
  code: string;
  name: string;
  description: string | null;
  charge_method: ChargeMethod;
  default_amount: number;
  percentage_rate: number;
  cutoff_time: string | null;
  taxable: boolean;
  service_chargeable: boolean;
  requires_note: boolean;
  requires_photo: boolean;
  requires_supervisor_approval: boolean;
  approval_threshold: number;
  is_active: boolean;
  is_archived: boolean;
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface CreateStayChargeRuleDto {
  charge_type: StayChargeType;
  code: string;
  name: string;
  description?: string | null;
  charge_method?: ChargeMethod;
  default_amount?: number;
  percentage_rate?: number;
  cutoff_time?: string | null;
  taxable?: boolean;
  service_chargeable?: boolean;
  requires_note?: boolean;
  requires_photo?: boolean;
  requires_supervisor_approval?: boolean;
  approval_threshold?: number;
  is_active?: boolean;
  sort_order?: number;
}

export interface UpdateStayChargeRuleDto {
  code?: string;
  name?: string;
  description?: string | null;
  charge_method?: ChargeMethod;
  default_amount?: number;
  percentage_rate?: number;
  cutoff_time?: string | null;
  taxable?: boolean;
  service_chargeable?: boolean;
  requires_note?: boolean;
  requires_photo?: boolean;
  requires_supervisor_approval?: boolean;
  approval_threshold?: number;
  is_active?: boolean;
  sort_order?: number;
}

export interface PostStayChargeDto {
  reservation_id: number;
  rule_id?: number;
  charge_type: StayChargeType;
  custom_description?: string;
  quantity?: number;
  unit_price?: number; // For manual or overridden amounts
  is_override?: boolean;
  override_amount?: number;
  override_reason?: string;
  override_by?: string;
  override_at?: string;
  revenue_category?: string;
  note?: string;
  actor_user_id?: string;
  actor_name?: string;
  actor_role?: string;
}

export interface VoidFolioEntryDto {
  reason: string;
  actor_user_id?: string;
  actor_name?: string;
  actor_role?: string;
}

export interface CorrectFolioEntryDto {
  reason: string;
  charge_type?: StayChargeType;
  rule_id?: number;
  custom_description?: string;
  quantity?: number;
  unit_price?: number;
  taxable?: boolean;
  service_chargeable?: boolean;
  note?: string;
  actor_user_id?: string;
  actor_name?: string;
  actor_role?: string;
}

export type FolioEntryStatus = 'POSTED' | 'VOIDED' | 'CORRECTED' | 'REVERSED';

export interface FolioEntry {
  id: number;
  reservation_id: number;
  property_id?: number | null;
  entry_type: string;
  source_type?: string | null;
  source_id?: string | null;
  description: string;
  amount: number;
  direction: 'DEBIT' | 'CREDIT';
  base_amount?: number;
  unit_price?: number;
  quantity?: number;
  tax_amount?: number;
  service_amount?: number;
  reversal_of_entry_id?: number | null;
  correction_group_id?: string | null;
  status?: FolioEntryStatus;
  notes?: string | null;
  is_voided: boolean;
  void_reason?: string | null;
  voided_at?: string | null;
  voided_by?: string | null;
  actor_user_id?: string | null;
  actor_name_snapshot?: string | null;
  actor_role_snapshot?: string | null;
  created_at: string;
}
