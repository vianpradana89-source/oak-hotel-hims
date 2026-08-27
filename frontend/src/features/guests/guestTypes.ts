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
  vip_status: VipStatus;
  notes?: string | null;
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
  check_in: string;
  check_out: string;
  status: string;
  role: string;
  is_legacy_inferred: boolean;
  identity_verified: boolean;
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
