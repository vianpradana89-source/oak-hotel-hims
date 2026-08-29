export type TurnoverState = 'READY' | 'OUTGOING_OCCUPIED' | 'CLEANING' | 'OUT_OF_SERVICE' | 'NONE';

export type ReadinessReasonCode =
  | 'OUTGOING_NOT_CHECKED_OUT'
  | 'HOUSEKEEPING_IN_PROGRESS'
  | 'ROOM_OUT_OF_SERVICE'
  | 'BLOCKING_FINDING_ACTIVE'
  | 'ROOM_NOT_READY';

export interface OutgoingReservationInfo {
  id: number;
  guest_name: string;
  check_out: string;
  checked_out_at: string | null;
  status: string;
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
    reason_code: string | null;
    reason_message: string | null;
  } | null;
}
