/**
 * Shared reservation lifecycle helpers.
 *
 * Extracted verbatim from index.ts to allow test suites to import the
 * production implementations directly via dist without side-effectful
 * server initialisation.
 *
 * No database pool is created, no dotenv is read, no Express app is
 * constructed — pure functions and DTO queries only.
 */

import { hotelDateKey } from '../../utils/hotelDate';

// ── hasRows local helper (same semantics as index.ts line 238) ─────────────
const hasRows = (result: { rowCount?: number | null } | null | undefined): boolean =>
  Number(result?.rowCount ?? 0) > 0;

// ── withReservationHotelDates ──────────────────────────────────────────────
// index.ts line 735: normalizes check_in / check_out to Asia/Jakarta date keys.
export function withReservationHotelDates<T extends Record<string, any>>(row: T): T {
  if (!row) return row;
  return {
    ...row,
    check_in: row.check_in == null ? row.check_in : hotelDateKey(row.check_in),
    check_out: row.check_out == null ? row.check_out : hotelDateKey(row.check_out)
  };
}

// ── BookingChildStatusSummary ──────────────────────────────────────────────
// index.ts line 887
export type BookingChildStatusSummary = {
  total: number;
  booked: number;
  checkedIn: number;
  checkedOut: number;
  cancelled: number;
  unsupported: number;
  statuses: Array<{ reservation_id: number; status: string }>;
  hasTerminalCheckedOut: boolean;
  hasActiveChild: boolean;
  allCancelled: boolean;
};

// ── buildBookingChildStatusSummary ─────────────────────────────────────────
// index.ts line 900: priority is checkedOut > cancelled > unsupported > active
export function buildBookingChildStatusSummary(children: any[]): BookingChildStatusSummary {
  const summary: BookingChildStatusSummary = {
    total: children.length,
    booked: 0,
    checkedIn: 0,
    checkedOut: 0,
    cancelled: 0,
    unsupported: 0,
    statuses: [],
    hasTerminalCheckedOut: false,
    hasActiveChild: false,
    allCancelled: children.length > 0
  };

  for (const child of children) {
    const status = String(child.status || '').toUpperCase();
    summary.statuses.push({ reservation_id: Number(child.id), status });

    if (status === 'BOOKED') {
      summary.booked += 1;
      summary.hasActiveChild = true;
      summary.allCancelled = false;
      continue;
    }

    if (status === 'CHECKED_IN') {
      summary.checkedIn += 1;
      summary.hasActiveChild = true;
      summary.allCancelled = false;
      continue;
    }

    if (status === 'CHECKED_OUT') {
      summary.checkedOut += 1;
      summary.hasTerminalCheckedOut = true;
      summary.allCancelled = false;
      continue;
    }

    if (status === 'CANCELLED') {
      summary.cancelled += 1;
      continue;
    }

    summary.unsupported += 1;
    summary.hasActiveChild = true;
    summary.allCancelled = false;
  }

  if (summary.booked > 0 || summary.checkedIn > 0 || summary.unsupported > 0) {
    summary.hasActiveChild = true;
  }

  summary.allCancelled = summary.total > 0 && summary.cancelled === summary.total;
  return summary;
}

// ── deriveBookingLifecycleStatus ───────────────────────────────────────────
// index.ts line 990: current status takes priority over summary-derived state
export function deriveBookingLifecycleStatus(
  currentBookingStatus: any,
  summary: BookingChildStatusSummary
): 'ACTIVE' | 'CANCELLED' | 'COMPLETED' {
  const normalizedCurrent = String(currentBookingStatus || '').toUpperCase();
  if (normalizedCurrent === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (normalizedCurrent === 'COMPLETED') {
    return 'COMPLETED';
  }

  if (summary.allCancelled) {
    return 'CANCELLED';
  }

  if (summary.hasActiveChild) {
    return 'ACTIVE';
  }

  if (summary.hasTerminalCheckedOut) {
    return 'COMPLETED';
  }

  return 'ACTIVE';
}

// ── buildBookingCompletionAuditPayload ─────────────────────────────────────
// index.ts line 1015: uses child_status_summary key, no property_id
export function buildBookingCompletionAuditPayload(
  booking: any,
  previousStatus: string,
  newStatus: string,
  summary: BookingChildStatusSummary,
  triggerReservationId: number
) {
  return {
    booking_id: Number(booking.id),
    bid: booking.bid,
    previous_status: previousStatus,
    new_status: newStatus,
    child_status_summary: summary,
    trigger_reservation_id: triggerReservationId
  };
}

// ── getCanonicalReservationDto ─────────────────────────────────────────────
// index.ts line 3121: canonical joined reservation DTO with hotel-date normalization
export async function getCanonicalReservationDto(clientOrPool: any, reservationId: number) {
  const result = await clientOrPool.query(`
    SELECT
      r.*,
      r.id AS reservation_id,
      r.booking_number AS legacy_booking_number,
      b.bid,
      b.id AS booking_id_value,
      b.property_id AS booking_property_id,
      COALESCE(r.booker_name, b.booker_name) AS booker_name,
      COALESCE(r.booker_phone, b.booker_phone) AS booker_phone,
      b.booking_source,
      COALESCE(b.booking_channel, r.booking_channel) AS booking_channel,
      ota.name AS ota_source_name,
      r.rate_plan_id,
      r.rate_plan_code_snapshot,
      r.rate_plan_name_snapshot,
      r.special_requests,
      r.is_manual_override,
      ro.room_number,
      ro.floor,
      COALESCE(ro.room_type_id, r.booked_room_type_id_snapshot) AS room_type_id,
      COALESCE(rt_current.name, rt.name, ro.name, 'Standard Room') AS room_type,
      COALESCE(rt_current.name, rt.name, ro.name, 'Standard Room') AS room_type_name,
      COALESCE(rt_current.code, rt.code) AS room_type_code,
      r.booked_room_type_id_snapshot AS booked_room_type_id_snapshot,
      r.booked_room_type_name_snapshot AS booked_room_type_name_snapshot,
      r.booked_room_type_code_snapshot AS booked_room_type_code_snapshot
    FROM reservations r
    LEFT JOIN bookings b ON b.id = r.booking_id
    LEFT JOIN ota_sources ota ON ota.id = r.ota_source_id
    LEFT JOIN rooms ro ON ro.id = r.room_id
    LEFT JOIN room_types rt_current ON rt_current.id = ro.room_type_id
    LEFT JOIN room_types rt ON rt.id = r.booked_room_type_id_snapshot
    WHERE r.id = $1
  `, [reservationId]);

  if (!hasRows(result)) return null;
  return withReservationHotelDates(result.rows[0]);
}
