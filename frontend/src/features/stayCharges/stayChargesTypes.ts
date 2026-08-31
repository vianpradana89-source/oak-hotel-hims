export type StayChargeType = 'EXTRA_BED' | 'EXTRA_PERSON' | 'EARLY_CHECKIN' | 'LATE_CHECKOUT' | 'PENALTY';

export type StayChargeCalculationType = 'FIXED' | 'PERCENT_ROOM_RATE' | 'FULL_NIGHT_RATE' | 'FREE' | 'MANUAL';

export interface StayChargeRule {
  id: number;
  property_id: number;
  charge_type: StayChargeType;
  code: string;
  name: string;
  description: string | null;
  calculation_type: StayChargeCalculationType;
  charge_method?: string;
  default_amount: number;
  percentage_of_rate: number | null;
  percentage_rate?: number | null;
  min_hours: number | null;
  max_hours: number | null;
  is_taxable: boolean;
  taxable?: boolean;
  is_service_chargeable: boolean;
  service_chargeable?: boolean;
  is_active: boolean;
  is_archived: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface CreateStayChargeRuleDto {
  property_id: number;
  charge_type: StayChargeType;
  code: string;
  name: string;
  description?: string | null;
  calculation_type: StayChargeCalculationType;
  default_amount?: number;
  percentage_of_rate?: number | null;
  min_hours?: number | null;
  max_hours?: number | null;
  is_taxable?: boolean;
  is_service_chargeable?: boolean;
  is_active?: boolean;
  display_order?: number;
}

export interface UpdateStayChargeRuleDto {
  property_id: number;
  charge_type?: StayChargeType;
  code?: string;
  name?: string;
  description?: string | null;
  calculation_type?: StayChargeCalculationType;
  default_amount?: number;
  percentage_of_rate?: number | null;
  min_hours?: number | null;
  max_hours?: number | null;
  is_taxable?: boolean;
  is_service_chargeable?: boolean;
  is_active?: boolean;
  display_order?: number;
}

export interface PostStayChargeDto {
  property_id: number;
  reservation_id: number;
  rule_id?: number | null;
  charge_type: StayChargeType;
  description: string;
  custom_amount?: number | null;
  quantity?: number;
  hours_applied?: number | null;
  taxable?: boolean;
  service_chargeable?: boolean;
  note?: string | null;
  actor_user_id?: number | null;
  actor_name_snapshot?: string | null;
  actor_role_snapshot?: string | null;
}

export interface VoidFolioEntryDto {
  property_id: number;
  void_reason: string;
  voided_by?: string | null;
  actor_user_id?: number | null;
  actor_role_snapshot?: string | null;
}

export interface CorrectFolioEntryDto {
  property_id: number;
  reason: string;
  charge_type?: StayChargeType;
  rule_id?: number | null;
  custom_description?: string;
  quantity?: number;
  unit_price?: number;
  taxable?: boolean;
  service_chargeable?: boolean;
  note?: string | null;
  actor_user_id?: number | null;
  actor_name?: string | null;
  actor_role?: string | null;
}

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
  status?: 'POSTED' | 'VOIDED' | 'CORRECTED' | 'REVERSED';
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
