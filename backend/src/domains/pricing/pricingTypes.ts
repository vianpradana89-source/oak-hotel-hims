export type MealPlan = 'RO' | 'BB' | 'HB' | 'FB' | 'AI' | string;

export interface MealPlanMaster {
  id: number;
  property_id: number;
  code: string;
  name: string;
  description: string | null;
  breakfast_included: boolean;
  lunch_included: boolean;
  dinner_included: boolean;
  is_active: boolean;
  is_archived: boolean;
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  // Joins & reference counts
  rate_plans_count?: number;
}

export interface CreateMealPlanDto {
  code: string;
  name: string;
  description?: string | null;
  breakfast_included?: boolean;
  lunch_included?: boolean;
  dinner_included?: boolean;
  is_active?: boolean;
  sort_order?: number;
}

export interface UpdateMealPlanDto {
  code?: string;
  name?: string;
  description?: string | null;
  breakfast_included?: boolean;
  lunch_included?: boolean;
  dinner_included?: boolean;
  is_active?: boolean;
  sort_order?: number;
}

export interface RatePlan {
  id: number;
  property_id: number;
  room_type_id: number;
  code: string;
  name: string;
  description: string | null;
  base_rate: number;
  currency: string;
  meal_plan: string;
  meal_plan_id?: number | null;
  meal_plan_code?: string;
  meal_plan_name?: string;
  refundable: boolean;
  cancellation_policy: string | null;
  payment_policy: string | null;
  valid_from: string | null;
  valid_until: string | null;
  min_stay: number;
  max_stay: number | null;
  min_advance_days: number;
  max_advance_days: number | null;
  extra_person_rate: number;
  extra_bed_rate: number;
  days_of_week: number[] | null;
  rate_type?: 'OVERNIGHT' | 'DAY_USE';
  duration_minutes?: number | null;
  earliest_start_time?: string | null;
  latest_start_time?: string | null;
  turnaround_buffer_minutes?: number;
  is_active: boolean;
  is_archived: boolean;
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  // Joins
  room_type_code?: string;
  room_type_name?: string;
}

export interface CreateRatePlanDto {
  room_type_id: number;
  code: string;
  name: string;
  description?: string | null;
  base_rate: number;
  currency?: string;
  meal_plan?: string;
  meal_plan_id?: number | null;
  refundable?: boolean;
  cancellation_policy?: string | null;
  payment_policy?: string | null;
  valid_from?: string | null;
  valid_until?: string | null;
  min_stay?: number;
  max_stay?: number | null;
  min_advance_days?: number;
  max_advance_days?: number | null;
  extra_person_rate?: number;
  extra_bed_rate?: number;
  days_of_week?: number[] | null;
  rate_type?: 'OVERNIGHT' | 'DAY_USE';
  duration_minutes?: number | null;
  earliest_start_time?: string | null;
  latest_start_time?: string | null;
  turnaround_buffer_minutes?: number;
  is_active?: boolean;
  sort_order?: number;
}

export interface UpdateRatePlanDto {
  room_type_id?: number;
  code?: string;
  name?: string;
  description?: string | null;
  base_rate?: number;
  currency?: string;
  meal_plan?: string;
  meal_plan_id?: number | null;
  refundable?: boolean;
  cancellation_policy?: string | null;
  payment_policy?: string | null;
  valid_from?: string | null;
  valid_until?: string | null;
  min_stay?: number;
  max_stay?: number | null;
  min_advance_days?: number;
  max_advance_days?: number | null;
  extra_person_rate?: number;
  extra_bed_rate?: number;
  days_of_week?: number[] | null;
  rate_type?: 'OVERNIGHT' | 'DAY_USE';
  duration_minutes?: number | null;
  earliest_start_time?: string | null;
  latest_start_time?: string | null;
  turnaround_buffer_minutes?: number;
  is_active?: boolean;
  sort_order?: number;
}

export interface DuplicateRatePlanDto {
  code: string;
  name: string;
  room_type_id?: number;
  base_rate?: number;
  is_active?: boolean;
}

export interface RateOverride {
  id: number;
  property_id: number;
  rate_plan_id: number;
  start_date: string;
  end_date: string;
  override_rate: number;
  days_of_week: number[] | null;
  reason: string | null;
  is_active: boolean;
  is_archived: boolean;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface CreateRateOverrideDto {
  start_date: string;
  end_date: string;
  override_rate: number;
  days_of_week?: number[] | null;
  reason?: string | null;
  replace_existing?: boolean;
}

export interface RateCalendarDay {
  date: string;
  day_of_week: number; // 1 = Mon, 7 = Sun
  day_name: string; // Sen, Sel, Rab, Kam, Jum, Sab, Min
  base_rate: number;
  override_id: number | null;
  override_rate: number | null;
  effective_rate: number;
  is_overridden: boolean;
  reason: string | null;
}

export interface PriceQuoteInput {
  property_id: number;
  room_type_id: number;
  rate_plan_id?: number;
  check_in: string;
  check_out: string;
  stay_type?: 'OVERNIGHT' | 'DAY_USE';
  adults?: number;
  children?: number;
}

export interface NightlyQuote {
  stay_date: string;
  day_of_week: number;
  base_rate: number;
  applied_override_rate: number | null;
  final_room_rate: number;
  service_amount: number;
  tax_amount: number;
  total_amount: number;
}

export interface PriceQuoteResult {
  property_id: number;
  room_type: {
    id: number;
    code: string;
    name: string;
  };
  rate_plan: {
    id: number;
    code: string;
    name: string;
    meal_plan: string;
    meal_plan_id?: number | null;
    meal_plan_code?: string;
    meal_plan_name?: string;
    refundable: boolean;
  };
  check_in: string;
  check_out: string;
  nights: number;
  nightly_breakdown: NightlyQuote[];
  room_subtotal: number;
  service_amount: number;
  tax_amount: number;
  grand_total: number;
  pricing_settings: {
    tax_percent: number;
    service_charge_percent: number;
    prices_include_tax: boolean;
    prices_include_service: boolean;
  };
}

export interface ReservationNightlyRate {
  id: number;
  reservation_id: number;
  property_id: number;
  stay_date: string;
  room_type_id: number;
  room_type_code_snapshot: string | null;
  room_type_name_snapshot: string | null;
  rate_plan_id: number | null;
  rate_plan_code_snapshot: string | null;
  rate_plan_name_snapshot: string | null;
  meal_plan_id?: number | null;
  meal_plan_code_snapshot?: string | null;
  meal_plan_name_snapshot?: string | null;
  base_rate: number;
  applied_override_rate: number | null;
  final_room_rate: number;
  service_amount: number;
  tax_amount: number;
  total_amount: number;
  created_at: string;
}

export interface PropertyPricingSettings {
  property_id: number;
  tax_percent: number;
  service_charge_percent: number;
  prices_include_tax: boolean;
  prices_include_service: boolean;
  created_at: string;
  updated_at: string;
}
