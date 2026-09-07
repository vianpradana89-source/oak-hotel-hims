import { normalizeHotelDate } from './calendarDates.ts';

export function reservationLifecycleStatus(reservation: { status?: unknown } | null | undefined): string {
  return String(reservation?.status ?? '').trim().toUpperCase();
}

export function hasCanonicalTimestamp(value: unknown): boolean {
  if (value == null || value === '') return false;
  const date = value instanceof Date ? value : new Date(String(value));
  return !Number.isNaN(date.getTime());
}

export function reservationMarkerId(reservation: { id?: unknown; reservation_id?: unknown } | null | undefined): string {
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
} | null | undefined): boolean {
  const status = reservationLifecycleStatus(reservation);
  if (status === 'CANCELLED' || status === 'NO_SHOW') return false;
  if (status !== 'CHECKED_IN' && status !== 'CHECKED_OUT') return false;
  return hasCanonicalTimestamp(reservation?.checked_in_at);
}

/**
 * Successful checkout of an effective arrival.
 * CHECKED_OUT without checked_in_at must not invent DEP.
 */
export function isEffectiveDeparture(reservation: {
  status?: unknown;
  checked_in_at?: unknown;
  checked_out_at?: unknown;
} | null | undefined): boolean {
  if (!isEffectiveArrival(reservation)) return false;
  return reservationLifecycleStatus(reservation) === 'CHECKED_OUT'
    && hasCanonicalTimestamp(reservation?.checked_out_at);
}

export type EffectiveStayMarker = {
  id?: unknown;
  reservation_id?: unknown;
  guest_name?: string | null;
  room_id?: number | null;
  status?: string | null;
  check_in?: unknown;
  check_out?: unknown;
  checked_in_at?: unknown;
  checked_out_at?: unknown;
};

export function markerPlacementDate(value: unknown): string {
  return normalizeHotelDate(value);
}

/**
 * Empty-cell ARR chips must not repeat a stay that already has a visible reservation bar.
 * DEP is never painted on the bar, so it remains an empty-cell chip.
 */
export function emptyCellEffectiveMarkers(
  cell: { effective_arrivals?: EffectiveStayMarker[] | null; effective_departures?: EffectiveStayMarker[] | null } | null | undefined,
  visibleBarReservationIds: Iterable<unknown>
): { arrivals: EffectiveStayMarker[]; departures: EffectiveStayMarker[] } {
  const barIds = new Set(
    [...visibleBarReservationIds].map((id) => String(id)).filter(Boolean)
  );

  const uniqueById = (markers: EffectiveStayMarker[]) => {
    const seen = new Set<string>();
    const unique: EffectiveStayMarker[] = [];
    for (const marker of markers) {
      const id = reservationMarkerId(marker);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      unique.push(marker);
    }
    return unique;
  };

  const arrivals = uniqueById(cell?.effective_arrivals || []).filter((marker) => !barIds.has(reservationMarkerId(marker)));
  const departures = uniqueById(cell?.effective_departures || []);
  return { arrivals, departures };
}

export function uniqueMarkerIds(markers: EffectiveStayMarker[]): string[] {
  const seen = new Set<string>();
  for (const marker of markers || []) {
    const id = reservationMarkerId(marker);
    if (id) seen.add(id);
  }
  return [...seen];
}
