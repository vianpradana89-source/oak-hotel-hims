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
}

export interface GuestCrmSummary {
  property_id: number;
  hotel_date: string;
  total_guests: number;
  guests_with_qualifying_stay: number;
  repeat_guests: number;
  repeat_rate: number;
  new_guests_last_30d: number;
  dormant_guests_90d: number;
  birthdays_this_month: GuestCrmBirthdayItem[];
  follow_up_candidates: GuestCrmFollowUpItem[];
}

export interface DuplicateCandidateCluster {
  match_reason: 'PHONE' | 'EMAIL' | 'NAME_BIRTH_DATE';
  match_key: string;
  guests: Guest[];
}

export type GuestCrmTab = 'summary' | 'database';

export interface GuestFilterState {
  search: string;
  segment: BehavioralSegment;
  page: number;
  pageSize: number;
}
