export interface ApiEnvelope<T> {
  status: string;
  data: T;
  code?: string;
  message?: string;
  meta?: { note?: string };
}

export class RoomMasterApiError extends Error {
  code: string;
  httpStatus: number;

  constructor(message: string, code: string, httpStatus: number) {
    super(message);
    this.name = 'RoomMasterApiError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface RoomCategory {
  id: number;
  property_id?: number | null;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  display_order: number | null;
  room_type_count?: number;
  physical_room_count?: number;
}

export type RoomCategoryWritePayload = {
  code?: string;
  name?: string;
  description?: string | null;
};

export type RoomCategoryReorderPayload = {
  property_id: number;
  category_ids: number[];
};

export interface RoomType {
  id: number;
  property_id?: number | null;
  code: string;
  name: string;
  room_category_id: number | null;
  room_category_code?: string | null;
  room_category_name?: string | null;
  room_category_is_active?: boolean | null;
  description: string | null;
  capacity: number | null;
  max_adults: number | null;
  max_children: number | null;
  bed_type: string | null;
  base_rate: number | string | null;
  is_active: boolean;
  display_order: number | null;
  physical_room_count?: number;
  active_physical_rooms?: number;
  active_reservation_count?: number;
  future_reserved_peak?: number;
}

export type RoomTypeWritePayload = {
  code?: string;
  name?: string;
  room_category_id?: number | null;
  description?: string | null;
  capacity?: number;
  max_adults?: number;
  max_children?: number;
  bed_type?: string | null;
  display_order?: number;
};

export interface PhysicalRoom {
  id: number;
  property_id?: number | null;
  room_number: string;
  name?: string | null;
  legacy_name?: string | null;
  room_type_id: number | null;
  room_type_code: string | null;
  room_type_name: string | null;
  floor: string | null;
  notes: string | null;
  status: string | null;
  is_active: boolean;
  active_reservation_count?: number;
}

export interface ActiveRoomReservation {
  id: number;
  room_id: number;
  room_number: string;
  bid: string | null;
  booking_number: string | null;
  guest_name: string;
  status: 'BOOKED' | 'CHECKED_IN';
  check_in: string;
  check_out: string;
  nights: number;
  classification: 'IN_HOUSE' | 'UPCOMING';
}

export interface ActiveRoomReservationDrilldown {
  room_id: number;
  room_number: string;
  active_reservation_count: number;
  reservations: ActiveRoomReservation[];
}

export type PhysicalRoomWritePayload = {
  room_number?: string;
  room_type_id?: number;
  floor?: string | null;
  notes?: string | null;
  is_active?: boolean;
};

export const OPERATIONAL_STATUS_LABELS: Record<string, string> = {
  VACANT_CLEAN: 'Vacant Clean',
  VACANT_DIRTY: 'Vacant Dirty',
  OCCUPIED_CLEAN: 'Occupied Clean',
  OCCUPIED_DIRTY: 'Occupied Dirty',
  OUT_OF_ORDER: 'Out of Order',
  OUT_OF_SERVICE: 'Out of Service'
};
