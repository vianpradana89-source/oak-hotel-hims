export type GuestRole = 'BOOKER' | 'PRIMARY_GUEST' | 'ADDITIONAL_GUEST';
export type VipStatus = 'STANDARD' | 'VIP' | 'VVIP';
export type MatchClassification = 'POSSIBLE_MATCH' | 'NEW_GUEST';

export interface Guest {
  id: number;
  guest_code?: string | null;
  full_name: string;
  normalized_name?: string | null;
  preferred_name: string | null;
  gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
  birth_place: string | null;
  birth_date: string | null;
  nationality: string | null;
  phone: string | null;
  normalized_phone?: string | null;
  email: string | null;
  normalized_email?: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  guest_segment?: string | null;
  vip_status: VipStatus;
  preferences?: string | null;
  is_blacklisted: boolean;
  blacklist_reason: string | null;
  identity_type?: string | null;
  identity_number?: string | null;
  normalized_identity_number?: string | null;
  identity_path?: string | null;
  has_valid_identity?: boolean;
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
  notes: string | null;
  is_archived?: boolean;
  is_active?: boolean;
  created_property_id?: number | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  stays?: any[];
}

export interface GuestCreateInput {
  property_id: number;
  guest_code?: string | null;
  full_name: string;
  preferred_name?: string | null;
  gender?: 'MALE' | 'FEMALE' | 'OTHER' | null;
  birth_place?: string | null;
  birth_date?: string | null;
  nationality?: string | null;
  phone?: string | null;
  email?: string | null;
  identity_type?: string | null;
  identity_number?: string | null;
  identity_path?: string | null;
  has_valid_identity?: boolean;
  address?: string | null;
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
  city?: string | null;
  province?: string | null;
  country?: string | null;
  guest_segment?: string | null;
  vip_status?: VipStatus;
  preferences?: string | null;
  notes?: string | null;
  is_archived?: boolean;
  is_active?: boolean;
  created_by?: string | null;
}

export interface GuestUpdateInput {
  property_id: number;
  guest_code?: string | null;
  full_name?: string;
  preferred_name?: string | null;
  gender?: 'MALE' | 'FEMALE' | 'OTHER' | null;
  birth_place?: string | null;
  birth_date?: string | null;
  nationality?: string | null;
  phone?: string | null;
  email?: string | null;
  identity_type?: string | null;
  identity_number?: string | null;
  identity_path?: string | null;
  has_valid_identity?: boolean;
  address?: string | null;
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
  ktp_regency_id?: number | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  guest_segment?: string | null;
  vip_status?: VipStatus;
  preferences?: string | null;
  is_blacklisted?: boolean;
  blacklist_reason?: string | null;
  notes?: string | null;
  is_archived?: boolean;
  is_active?: boolean;
}

export interface DuplicateCheckInput {
  property_id: number;
  phone?: string | null;
  nik?: string | null;
  email?: string | null;
  name?: string | null;
  birth_date?: string | null;
  exclude_guest_id?: number | null;
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

export interface ReservationGuest {
  id: number;
  reservation_id: number;
  guest_id: number;
  role: GuestRole;
  relationship: string | null;
  is_staying: boolean;
  identity_verified: boolean;
  relation_source: string;
  is_legacy_inferred: boolean;
  checked_in_at: string | null;
  checked_out_at: string | null;
  created_at: string;
  updated_at: string;
  full_name?: string;
  phone?: string | null;
  email?: string | null;
  vip_status?: VipStatus;
  is_blacklisted?: boolean;
}

export interface ReservationGuestCreateInput {
   property_id: number;
   guest_id: number;
   role: GuestRole;
   relationship?: string | null;
   is_staying?: boolean;
   identity_verified?: boolean;
   relation_source?: string;
   /** Expected current PRIMARY_GUEST guest_id for optimistic CAS. When provided and doesn't match, returns 409. */
   expected_primary_guest_id?: number | null;
 }

export interface ReservationGuestUpdateInput {
  property_id: number;
  role?: GuestRole;
  relationship?: string | null;
  is_staying?: boolean;
  identity_verified?: boolean;
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

export interface GuestStayStatistics {
  visit_count: number;
  room_nights: number;
  first_stay: string | null;
  last_stay: string | null;
  total_spend?: number;
  earned_points?: number;
  bonus_points?: number;
  redeemed_points?: number;
  loyalty_points?: number;
  point_value_idr?: number;
  loyalty_tier?: LoyaltyTierCode;
  loyalty_tier_name?: string;
  tier_discount_pct?: number;
}

export interface GuestWithStats extends Guest, GuestStayStatistics {}

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

export interface GuestMergeInput {
  property_id: number;
  primary_guest_id: number;
  duplicate_guest_ids: number[];
  actor_name?: string | null;
}

export interface GuestMergeResult {
  primary_guest: Guest;
  merged_guest_ids: number[];
  relinked_reservations: number;
  relinked_transactions: number;
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
  match_reason: 'PHONE' | 'EMAIL' | 'NAME_AND_DOB';
  match_key: string;
  guests: GuestWithStats[];
}
