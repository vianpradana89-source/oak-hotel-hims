export type GuestRole = 'BOOKER' | 'PRIMARY_GUEST' | 'ADDITIONAL_GUEST';
export type VipStatus = 'STANDARD' | 'VIP' | 'VVIP';
export type MatchClassification = 'POSSIBLE_MATCH' | 'NEW_GUEST';

export interface Guest {
  id: number;
  full_name: string;
  preferred_name: string | null;
  gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
  birth_place: string | null;
  birth_date: string | null;
  nationality: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  vip_status: VipStatus;
  is_blacklisted: boolean;
  blacklist_reason: string | null;
  notes: string | null;
  created_property_id?: number | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  stays?: any[];
}

export interface GuestCreateInput {
  property_id: number;
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
  vip_status?: VipStatus;
  notes?: string | null;
  created_by?: string | null;
}

export interface GuestUpdateInput {
  property_id: number;
  full_name?: string;
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
  vip_status?: VipStatus;
  is_blacklisted?: boolean;
  blacklist_reason?: string | null;
  notes?: string | null;
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
}

export interface ReservationGuestUpdateInput {
  property_id: number;
  role?: GuestRole;
  relationship?: string | null;
  is_staying?: boolean;
  identity_verified?: boolean;
}
