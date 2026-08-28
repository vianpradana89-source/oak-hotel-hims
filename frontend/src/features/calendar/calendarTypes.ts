export type TurnoverState = 'NONE' | 'OUTGOING_OCCUPIED' | 'CLEANING' | 'READY' | 'OUT_OF_SERVICE';

export type ReadinessReasonCode =
  | 'OUTGOING_NOT_CHECKED_OUT'
  | 'HOUSEKEEPING_IN_PROGRESS'
  | 'ROOM_OUT_OF_SERVICE'
  | 'ROOM_NOT_READY';

export interface OutgoingReservationInfo {
  id?: number;
  reservation_id?: number;
  guest_name: string;
  check_out?: string;
  checked_out_at?: string | null;
  status?: string;
  checkout_inspection?: {
    task_id: number;
    status: string;
    clearance_state: 'CLEAR' | 'ISSUE_FOUND' | 'REQUESTED' | 'INSPECTING' | 'NO_CHECK';
    inspection_result?: string | null;
    issue_type?: string | null;
    issue_note?: string | null;
    estimated_charge?: number | null;
  } | null;
}

export interface RoomReadinessInfo {
  is_ready: boolean;
  turnover_state: TurnoverState;
  reason_code: ReadinessReasonCode | null;
  reason_message: string | null;
  room_status: string;
  outgoing_reservation: OutgoingReservationInfo | null;
}

export interface CellTurnoverInfo {
  has_turnover: boolean;
  turnover_state: TurnoverState;
  outgoing: OutgoingReservationInfo | null;
  incoming: {
    reservation_id: number;
    guest_name: string;
    check_in: string;
    status: string;
    is_ready: boolean;
    reason_code: ReadinessReasonCode | null;
    reason_message: string | null;
  } | null;
}

export interface CalendarCell {
  date: string;
  reservations: any[];
  departures?: any[];
  arrivals?: any[];
  turnover?: CellTurnoverInfo | null;
  availability: any | null;
}

export interface CalendarRoom {
  id: number;
  room_id: number;
  room_number: string;
  name: string;
  room_type_id: number | null;
  room_type_code: string | null;
  room_type_name: string;
  room_type_display_order: number;
  room_category_id: number | null;
  room_category_code: string | null;
  room_category_name: string | null;
  room_category_display_order: number;
  room_category_is_active: boolean | null;
  room_is_active: boolean;
  room_type_is_active: boolean;
  floor: string | null;
  status: string | null;
  operational_status: string | null;
  future_reservation_count: number;
  next_future_check_in: string | null;
  cells: CalendarCell[];
}

export interface RoomTypeCalendarGroup {
  key: string;
  roomTypeId: number | null;
  code: string;
  name: string;
  displayOrder: number;
  rooms: CalendarRoom[];
}

export interface RoomCategoryCalendarGroup {
  key: string;
  categoryId: number | null;
  code: string;
  name: string;
  displayOrder: number;
  active: boolean | null;
  roomTypes: RoomTypeCalendarGroup[];
  roomCount: number;
}

export interface TapechartResponse {
  status: string;
  start: string;
  end: string;
  rooms: CalendarRoom[];
}

export type CalendarOperationalFilter = '' | 'Ready' | 'Kotor' | 'Occupied' | 'Maintenance';
export type ReservationLifecycleStatus = 'BOOKED' | 'CHECKED_IN' | 'CHECKED_OUT' | 'CANCELLED';

export function normalizeReservationLifecycle(raw: unknown): {
  status: ReservationLifecycleStatus;
  legacy: boolean;
} {
  const value = String(raw ?? '').trim().toUpperCase();
  if (value === 'BOOKED' || value === 'CHECKED_IN' || value === 'CHECKED_OUT' || value === 'CANCELLED') {
    return { status: value, legacy: false };
  }

  // Compatibility only: legacy null/CONFIRMED rows remain operationally visible,
  // but are explicitly marked rather than silently presented as canonical BOOKED.
  return { status: 'BOOKED', legacy: true };
}
