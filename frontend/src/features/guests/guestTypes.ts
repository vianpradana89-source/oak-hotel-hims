export type VipStatus = 'STANDARD' | 'VIP' | 'VVIP';

export type BehavioralSegment =
  | 'SEMUA'
  | 'VIP'
  | 'VVIP'
  | 'REPEAT'
  | 'BARU'
  | 'TIDAK_AKTIF';

export interface GuestStayStatistics {
  visit_count: number;
  room_nights: number;
  first_stay: string | null;
  last_stay: string | null;
}

export interface Guest {
  id: number;
  guest_code?: string | null;
  full_name: string;
  preferred_name?: string | null;
  gender?: 'MALE' | 'FEMALE' | 'OTHER' | null;
  birth_place?: string | null;
  birth_date?: string | null;
  nationality?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  guest_segment?: string | null;
  vip_status: VipStatus;
  preferences?: string | null;
  identity_type?: string | null;
  identity_number?: string | null;
  identity_path?: string | null;
  has_valid_identity?: boolean | null;
  identity_storage_key?: string | null;
  rt_rw?: string | null;
  village_kelurahan?: string | null;
  district_kecamatan?: string | null;
  religion?: string | null;
  marital_status?: string | null;
  occupation?: string | null;
  citizenship?: string | null;
  valid_until?: string | null;
  ktp_ocr_confidence?: number | null;
  ktp_ocr_provider?: string | null;
  ktp_extracted_at?: string | null;
  ktp_regency_id?: number | null;
  notes?: string | null;
  is_archived?: boolean;
  is_active?: boolean;
  created_property_id?: number | null;
  created_at?: string;
  updated_at?: string;
  visit_count?: number;
  room_nights?: number;
  first_stay?: string | null;
  last_stay?: string | null;
  total_spend?: number;
  earned_points?: number;
  bonus_points?: number;
  redeemed_points?: number;
  loyalty_points?: number;
  point_value_idr?: number;
  loyalty_tier?: 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM';
  loyalty_tier_name?: string;
  tier_discount_pct?: number;
}

export interface GuestStay {
  reservation_id: number;
  booking_id: number;
  bid: string;
  room_number: string | null;
  room_type_name: string | null;
  rate_plan_name?: string | null;
  check_in: string;
  check_out: string;
  status: string;
  stay_type?: string;
  total_price?: number;
  guest_segment?: string;
  booking_source?: string;
  booking_channel?: string;
  role: string;
  is_legacy_inferred: boolean;
  identity_verified: boolean;
}

export interface DuplicateCandidate {
  id: number;
  guest_code: string | null;
  full_name: string;
  phone: string | null;
  email: string | null;
  identity_number: string | null;
  birth_date: string | null;
  guest_segment: string | null;
  vip_status: VipStatus;
  has_valid_identity: boolean;
  visit_count?: number;
  last_stay?: string | null;
  match_strength: 'STRONG_PHONE' | 'STRONG_NIK' | 'STRONG_EMAIL' | 'SOFT_NAME_PHONE' | 'SOFT_NAME_DOB';
  match_reason: string;
}

export interface DuplicateCheckResult {
  has_duplicate: boolean;
  candidates: DuplicateCandidate[];
}

export interface GuestDetail extends Guest {
  stays: GuestStay[];
}

export interface GuestCrmBirthdayItem {
  id: number;
  full_name: string;
  phone: string | null;
  email: string | null;
  birth_date: string;
  birth_day: number;
  birth_month: number;
  vip_status: VipStatus;
}

export interface GuestCrmFollowUpItem {
  id: number;
  full_name: string;
  phone: string | null;
  email: string | null;
  vip_status: VipStatus;
  last_stay: string;
  days_since_last_stay: number;
  visit_count: number;
  total_spend?: number;
}

export interface GuestCrmCityStat {
  city: string;
  guest_count: number;
  pct: number;
  total_spend: number;
}

export interface GuestCrmDemographics {
  wni_count: number;
  wna_count: number;
  wni_pct: number;
  wna_pct: number;
  known_city_guests: number;
  unknown_city_guests: number;
  top_cities: GuestCrmCityStat[];
}

export interface GuestCrmSummary {
  property_id: number;
  hotel_date: string;
  total_guests: number;
  guests_with_qualifying_stay: number;
  repeat_guests: number;
  repeat_rate: number;
  new_guests_last_30d: number;
  dormant_guests_30d?: number;
  dormant_guests_60d?: number;
  dormant_guests_90d: number;
  total_customer_revenue?: number;
  avg_customer_ltv?: number;
  birthdays_this_month: GuestCrmBirthdayItem[];
  follow_up_candidates: GuestCrmFollowUpItem[];
  demographics?: GuestCrmDemographics;
}

export interface DuplicateCandidateCluster {
  match_reason: 'PHONE' | 'EMAIL' | 'NAME_BIRTH_DATE' | 'NAME_AND_DOB';
  match_key: string;
  guests: Guest[];
}

export interface GuestLoyaltyLedgerEntry {
  id: number;
  property_id: number;
  guest_id: number;
  guest_name?: string;
  entry_type: 'BONUS' | 'REDEEM' | 'ADJUSTMENT';
  points: number;
  description: string;
  reference_no: string | null;
  created_by: string | null;
  created_at: string;
}

export type LoyaltyTierCode = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM';
export type LoyaltyCalculationPeriod = 'CUMULATIVE' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

export interface PropertyLoyaltyTierConfig {
  code: LoyaltyTierCode;
  name: string;
  min_spend: number;
  discount_pct: number;
}

export interface PropertyLoyaltySettings {
  property_id: number;
  points_enabled: boolean;
  spend_per_point: number;
  points_earned_per_unit: number;
  points_per_visit: number;
  point_value_idr: number;
  min_redeem_points: number;
  point_expiry_months: number;
  silver_point_threshold: number;
  gold_point_threshold: number;
  platinum_point_threshold: number;
  tier_calculation_period: LoyaltyCalculationPeriod;
  tiers_config: PropertyLoyaltyTierConfig[];
  wa_birthday_message: string;
  wa_followup_message: string;
  wa_database_message: string;
  followup_threshold_days: number;
  updated_at?: string;
}

export type GuestCrmTab = 'summary' | 'database' | 'communication' | 'loyalty';

export interface GuestFilterState {
  search: string;
  segment: BehavioralSegment;
  page: number;
  pageSize: number;
}
