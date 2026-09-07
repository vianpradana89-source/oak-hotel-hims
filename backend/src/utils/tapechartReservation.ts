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

export function reservationLifecycleStatus(reservation: { status?: unknown }): string {
  return String(reservation?.status ?? '').trim().toUpperCase();
}

export function toIsoTimestamp(value: unknown): string | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function hasCanonicalTimestamp(value: unknown): boolean {
  return toIsoTimestamp(value) != null;
}

export function toCanonicalRoomId(value: unknown): number | null {
  const roomId = Number(value);
  return Number.isInteger(roomId) && roomId > 0 ? roomId : null;
}

function reservationIdentity(reservation: { id?: unknown; reservation_id?: unknown }): string {
  const id = reservation?.id ?? reservation?.reservation_id;
  if (id == null || id === '') return '';
  return String(id);
}

/**
 * Successful in-house or completed stay with an actual check-in timestamp.
 * Planned check_in date alone is never enough.
 */
export function isEffectiveArrival(reservation: {
  status?: unknown;
  checked_in_at?: unknown;
}): boolean {
  const status = reservationLifecycleStatus(reservation);
  if (status === 'CANCELLED' || status === 'NO_SHOW') return false;
  if (status !== 'CHECKED_IN' && status !== 'CHECKED_OUT') return false;
  return hasCanonicalTimestamp(reservation.checked_in_at);
}

/**
 * Successful checkout of an effective arrival.
 * CHECKED_OUT without checked_in_at must not invent DEP.
 */
export function isEffectiveDeparture(reservation: {
  status?: unknown;
  checked_in_at?: unknown;
  checked_out_at?: unknown;
}): boolean {
  if (!isEffectiveArrival(reservation)) return false;
  return reservationLifecycleStatus(reservation) === 'CHECKED_OUT'
    && hasCanonicalTimestamp(reservation.checked_out_at);
}

export type EffectiveStayMarker = {
  id: number | string;
  reservation_id: number | string;
  guest_name: string | null;
  room_id: number | null;
  status: string | null;
  stay_status: string | null;
  check_in: string;
  check_out: string;
  checked_in_at: string | null;
  checked_out_at: string | null;
};

export function toEffectiveStayMarker(reservation: any): EffectiveStayMarker {
  const identity = reservationIdentity(reservation);
  return {
    id: reservation?.id ?? reservation?.reservation_id ?? identity,
    reservation_id: reservation?.reservation_id ?? reservation?.id ?? identity,
    guest_name: reservation?.guest_name ?? null,
    room_id: toCanonicalRoomId(reservation?.room_id),
    status: reservation?.status ?? null,
    stay_status: reservation?.stay_status ?? null,
    check_in: hotelDateKey(reservation?.check_in),
    check_out: hotelDateKey(reservation?.check_out),
    checked_in_at: toIsoTimestamp(reservation?.checked_in_at),
    checked_out_at: toIsoTimestamp(reservation?.checked_out_at)
  };
}

function uniqueEffectiveMarkers(
  reservations: any[],
  dateStr: string,
  eligible: (reservation: any) => boolean,
  placementDate: (reservation: any) => string
): EffectiveStayMarker[] {
  const seen = new Set<string>();
  const markers: EffectiveStayMarker[] = [];
  for (const reservation of reservations || []) {
    if (!eligible(reservation)) continue;
    if (placementDate(reservation) !== dateStr) continue;
    const identity = reservationIdentity(reservation);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    markers.push(toEffectiveStayMarker(reservation));
  }
  return markers;
}

export function listEffectiveArrivalsForDate(reservations: any[], dateStr: string): EffectiveStayMarker[] {
  return uniqueEffectiveMarkers(
    reservations,
    dateStr,
    isEffectiveArrival,
    (reservation) => hotelDateKey(reservation?.check_in)
  );
}

export function listEffectiveDeparturesForDate(reservations: any[], dateStr: string): EffectiveStayMarker[] {
  return uniqueEffectiveMarkers(
    reservations,
    dateStr,
    isEffectiveDeparture,
    (reservation) => hotelDateKey(reservation?.check_out)
  );
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
    room_id: toCanonicalRoomId(r.room_id),
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
    stay_status: r.stay_status ?? null,
    checked_in_at: toIsoTimestamp(r.checked_in_at),
    checked_out_at: toIsoTimestamp(r.checked_out_at),
    legacy_status: r.status == null
  };
}
