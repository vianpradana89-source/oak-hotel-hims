import { hotelDateKey } from './hotelDate';

export function isDayUseStay(stayType: unknown): boolean {
  return String(stayType || '').toUpperCase() === 'DAY_USE';
}

/**
 * Whether a reservation occupies a tapechart hotel-date cell.
 * Overnight: [check_in, check_out). Same-day overnight is excluded.
 * DAY_USE: only the check_in hotel date, including check_in === check_out.
 */
export function reservationOccupiesTapechartDate(
  reservation: { check_in?: unknown; check_out?: unknown; stay_type?: unknown },
  dateStr: string
): boolean {
  const ci = hotelDateKey(reservation.check_in);
  if (!ci || !dateStr) return false;

  if (isDayUseStay(reservation.stay_type)) {
    return dateStr === ci;
  }

  const co = hotelDateKey(reservation.check_out);
  return Boolean(co) && dateStr >= ci && dateStr < co;
}

export function toTapechartCellReservation(r: any) {
  return {
    id: r.id,
    reservation_id: r.reservation_id,
    booking_id: r.booking_id,
    bid: r.bid,
    stay_sequence: r.stay_sequence,
    guest_name: r.guest_name,
    guest_phone: r.guest_phone,
    guest_segment: r.guest_segment,
    booking_number: r.booking_number,
    legacy_booking_number: r.legacy_booking_number,
    booking_type: r.booking_type,
    payment_status: r.payment_status,
    check_in: hotelDateKey(r.check_in),
    check_out: hotelDateKey(r.check_out),
    stay_type: r.stay_type ?? null,
    start_at: r.start_at ?? null,
    end_at: r.end_at ?? null,
    booked_room_type_id_snapshot: r.booked_room_type_id_snapshot,
    booked_room_type_code_snapshot: r.booked_room_type_code_snapshot,
    booked_room_type_name_snapshot: r.booked_room_type_name_snapshot,
    booked_room_category_id_snapshot: r.booked_room_category_id_snapshot,
    booked_room_category_code_snapshot: r.booked_room_category_code_snapshot,
    booked_room_category_name_snapshot: r.booked_room_category_name_snapshot,
    classification_snapshot_source: r.classification_snapshot_source,
    classification_snapshotted_at: r.classification_snapshotted_at,
    status: r.status ?? null,
    legacy_status: r.status == null
  };
}
