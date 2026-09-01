export type MealPlan = 'RO' | 'BB' | 'HB' | 'FB' | 'AI';

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
  is_active: boolean;
  is_archived: boolean;
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  room_type_code?: string;
  room_type_name?: string;
  rate_type?: 'OVERNIGHT' | 'DAY_USE';
  duration_minutes?: number | null;
  earliest_start_time?: string | null;
  latest_start_time?: string | null;
  turnaround_buffer_minutes?: number | null;
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
  is_active?: boolean;
  sort_order?: number;
  rate_type?: 'OVERNIGHT' | 'DAY_USE';
  duration_minutes?: number | null;
  earliest_start_time?: string | null;
  latest_start_time?: string | null;
  turnaround_buffer_minutes?: number | null;
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
  is_active?: boolean;
  sort_order?: number;
  rate_type?: 'OVERNIGHT' | 'DAY_USE';
  duration_minutes?: number | null;
  earliest_start_time?: string | null;
  latest_start_time?: string | null;
  turnaround_buffer_minutes?: number | null;
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
  created_at: string;
}

export interface CreateRateOverrideDto {
  start_date: string;
  end_date: string;
  override_rate: number;
  days_of_week?: number[] | null;
  reason?: string | null;
  replace_existing?: boolean;
}

export interface BulkRateOverrideDto {
  rate_plan_ids: number[];
  start_date: string;
  end_date: string;
  override_rate: number;
  days_of_week?: number[] | null;
  reason?: string | null;
  preview_token?: string;
}

export interface BulkRateOverridePreviewItem {
  stay_date: string;
  day_of_week: number;
  day_name: string;
  room_type_id: number;
  room_type_name: string;
  rate_plan_id: number;
  rate_plan_name: string;
  rate_plan_code: string;
  base_rate: number;
  current_effective_rate: number;
  proposed_rate: number;
  existing_override_id: number | null;
  status: 'NEW' | 'REPLACE' | 'UNCHANGED' | 'CONFLICT';
  reason: string | null;
}

export interface BulkRateOverridePreviewResult {
  property_id: number;
  affected_dates_count: number;
  replacements_count: number;
  preview_token: string;
  breakdown: BulkRateOverridePreviewItem[];
}

export interface RateCalendarDay {
  date: string;
  day_of_week: number;
  day_name: string;
  base_rate: number;
  override_id: number | null;
  override_rate: number | null;
  effective_rate: number;
  is_overridden: boolean;
  reason: string | null;
}

export interface RateCalendarMatrix {
  rate_plan: RatePlan;
  days: RateCalendarDay[];
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

export interface NightlyQuote {
  stay_date: string;
  day_of_week: number;
  base_rate: number;
  applied_override_rate: number | null;
  final_room_rate: number;
  service_amount: number;
  tax_amount: number;
  total_amount: number;
  date?: string;
}

export interface ReservationNightlyRate {
  id: number;
  reservation_id: number;
  stay_date: string;
  room_rate: number;
  rate_plan_id: number | null;
  rate_plan_code: string | null;
  rate_plan_name: string | null;
  meal_plan_code: string | null;
  meal_plan_name: string | null;
  base_rate: number | null;
  is_override: boolean;
  override_id: number | null;
  service_percent: number;
  service_amount: number;
  tax_percent: number;
  tax_amount: number;
  total_night_amount: number;
  is_manual_override: boolean;
  manual_override_reason: string | null;
  created_at: string;
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

const API_BASE = '/api/pricing';

async function handleResponse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error || data.message || `Request failed with status ${res.status}`;
    const err = new Error(message) as Error & { collision?: boolean; status?: number; code?: string };
    err.status = res.status;
    if (data.collision) err.collision = true;
    if (data.code) err.code = data.code;
    throw err;
  }
  return data as T;
}

export const pricingApi = {
  async getSettings(propertyId: number): Promise<PropertyPricingSettings> {
    const res = await fetch(`${API_BASE}/settings?property_id=${propertyId}`);
    return handleResponse<PropertyPricingSettings>(res);
  },

  async updateSettings(propertyId: number, data: Partial<PropertyPricingSettings>): Promise<PropertyPricingSettings> {
    const res = await fetch(`${API_BASE}/settings?property_id=${propertyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return handleResponse<PropertyPricingSettings>(res);
  },

  // Meal Plan Master
  async listMealPlans(
    propertyId: number,
    options?: { is_active?: boolean; include_archived?: boolean }
  ): Promise<MealPlanMaster[]> {
    const params = new URLSearchParams({ property_id: String(propertyId) });
    if (options?.is_active !== undefined) params.set('is_active', String(options.is_active));
    if (options?.include_archived) params.set('include_archived', 'true');

    const res = await fetch(`${API_BASE}/meal-plans?${params.toString()}`);
    return handleResponse<MealPlanMaster[]>(res);
  },

  async getMealPlan(propertyId: number, id: number): Promise<MealPlanMaster> {
    const res = await fetch(`${API_BASE}/meal-plans/${id}?property_id=${propertyId}`);
    return handleResponse<MealPlanMaster>(res);
  },

  async createMealPlan(propertyId: number, data: CreateMealPlanDto): Promise<MealPlanMaster> {
    const res = await fetch(`${API_BASE}/meal-plans?property_id=${propertyId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return handleResponse<MealPlanMaster>(res);
  },

  async updateMealPlan(propertyId: number, id: number, data: UpdateMealPlanDto): Promise<MealPlanMaster> {
    const res = await fetch(`${API_BASE}/meal-plans/${id}?property_id=${propertyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return handleResponse<MealPlanMaster>(res);
  },

  async setMealPlanActive(propertyId: number, id: number, isActive: boolean): Promise<MealPlanMaster> {
    const res = await fetch(`${API_BASE}/meal-plans/${id}/status?property_id=${propertyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: isActive })
    });
    return handleResponse<MealPlanMaster>(res);
  },

  async deleteMealPlan(propertyId: number, id: number): Promise<{ deleted: boolean; archived: boolean; message: string }> {
    const res = await fetch(`${API_BASE}/meal-plans/${id}?property_id=${propertyId}`, {
      method: 'DELETE'
    });
    return handleResponse<{ deleted: boolean; archived: boolean; message: string }>(res);
  },

  async listRatePlans(
    propertyId: number,
    options?: { room_type_id?: number; is_active?: boolean; include_archived?: boolean }
  ): Promise<RatePlan[]> {
    const params = new URLSearchParams({ property_id: String(propertyId) });
    if (options?.room_type_id) params.set('room_type_id', String(options.room_type_id));
    if (options?.is_active !== undefined) params.set('is_active', String(options.is_active));
    if (options?.include_archived) params.set('include_archived', 'true');

    const res = await fetch(`${API_BASE}/rate-plans?${params.toString()}`);
    return handleResponse<RatePlan[]>(res);
  },

  async getRatePlan(propertyId: number, id: number): Promise<RatePlan> {
    const res = await fetch(`${API_BASE}/rate-plans/${id}?property_id=${propertyId}`);
    return handleResponse<RatePlan>(res);
  },

  async createRatePlan(propertyId: number, data: CreateRatePlanDto): Promise<RatePlan> {
    const res = await fetch(`${API_BASE}/rate-plans?property_id=${propertyId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return handleResponse<RatePlan>(res);
  },

  async updateRatePlan(propertyId: number, id: number, data: UpdateRatePlanDto): Promise<RatePlan> {
    const res = await fetch(`${API_BASE}/rate-plans/${id}?property_id=${propertyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return handleResponse<RatePlan>(res);
  },

  async duplicateRatePlan(propertyId: number, id: number, data: DuplicateRatePlanDto): Promise<RatePlan> {
    const res = await fetch(`${API_BASE}/rate-plans/${id}/duplicate?property_id=${propertyId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return handleResponse<RatePlan>(res);
  },

  async setRatePlanActive(propertyId: number, id: number, isActive: boolean): Promise<RatePlan> {
    const res = await fetch(`${API_BASE}/rate-plans/${id}/status?property_id=${propertyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: isActive })
    });
    return handleResponse<RatePlan>(res);
  },

  async deleteRatePlan(propertyId: number, id: number): Promise<{ deleted: boolean; archived: boolean; message: string }> {
    const res = await fetch(`${API_BASE}/rate-plans/${id}?property_id=${propertyId}`, {
      method: 'DELETE'
    });
    return handleResponse<{ deleted: boolean; archived: boolean; message: string }>(res);
  },

  async getRateCalendar(propertyId: number, ratePlanId: number, startDate: string, endDate: string): Promise<RateCalendarMatrix> {
    const params = new URLSearchParams({
      property_id: String(propertyId),
      start_date: startDate,
      end_date: endDate
    });
    const res = await fetch(`${API_BASE}/rate-plans/${ratePlanId}/calendar?${params.toString()}`);
    return handleResponse<RateCalendarMatrix>(res);
  },

  async upsertRateOverride(propertyId: number, ratePlanId: number, data: CreateRateOverrideDto): Promise<RateOverride> {
    const res = await fetch(`${API_BASE}/rate-plans/${ratePlanId}/overrides?property_id=${propertyId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return handleResponse<RateOverride>(res);
  },

  async deleteRateOverride(propertyId: number, overrideId: number, targetDate?: string): Promise<{ success: boolean; message: string }> {
    const params = new URLSearchParams({ property_id: String(propertyId) });
    if (targetDate) params.set('target_date', targetDate);
    const res = await fetch(`${API_BASE}/rate-overrides/${overrideId}?${params.toString()}`, {
      method: 'DELETE'
    });
    return handleResponse<{ success: boolean; message: string }>(res);
  },

  async previewBulkRateOverrides(propertyId: number, data: BulkRateOverrideDto): Promise<BulkRateOverridePreviewResult> {
    const res = await fetch(`${API_BASE}/bulk-overrides/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-property-id': String(propertyId) },
      body: JSON.stringify({ ...data, property_id: propertyId })
    });
    return handleResponse<BulkRateOverridePreviewResult>(res);
  },

  async applyBulkRateOverrides(
    propertyId: number,
    data: BulkRateOverrideDto
  ): Promise<{ success: boolean; message: string; preview_token: string }> {
    const res = await fetch(`${API_BASE}/bulk-overrides/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-property-id': String(propertyId) },
      body: JSON.stringify({ ...data, property_id: propertyId })
    });
    return handleResponse<{ success: boolean; message: string; preview_token: string }>(res);
  },

  async calculateQuote(payload: {
    property_id: number;
    room_type_id: number;
    rate_plan_id?: number;
    check_in: string;
    check_out: string;
    stay_type?: 'OVERNIGHT' | 'DAY_USE';
    adults?: number;
    children?: number;
  }): Promise<PriceQuoteResult> {
    const res = await fetch(`${API_BASE}/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return handleResponse<PriceQuoteResult>(res);
  },

  async getReservationRateSnapshots(propertyId: number, reservationId: number): Promise<ReservationNightlyRate[]> {
    const res = await fetch(`${API_BASE}/reservations/${reservationId}/rate-snapshots?property_id=${propertyId}`);
    return handleResponse<ReservationNightlyRate[]>(res);
  }
};
