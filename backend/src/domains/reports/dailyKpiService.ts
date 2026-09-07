import type { Pool, PoolClient } from 'pg';
import { hotelDateFromInstant, normalizeHotelDate } from '../../utils/hotelDate';
import {
  InvalidPropertyTimezoneError,
  requirePropertyTimezone,
} from '../../utils/propertyTimezone';
import { httpError } from './occupancyService';

export const CHECKOUT_ROOM_CHECK_PENDING_STATUSES = [
  'REQUESTED',
  'PENDING',
  'ASSIGNED',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
] as const;

export interface DailyKpiOccupancy {
  occupied_rooms: number;
  sellable_rooms: number;
  occupancy_pct: number | null;
  ooo_oos_rooms: number;
}

export interface DailyKpiResult {
  property_id: number;
  business_date: string;
  timezone: string;
  occupancy: DailyKpiOccupancy;
  booked_today: { rooms: number; bookings: number };
  check_in_today: { rooms: number };
  check_out_today: { rooms: number };
  rooms: {
    dirty: number;
    vacant_clean: number;
    maintenance_ooo_oos: number;
  };
  checkout_check: { pending: number };
}

/**
 * Hotel calendar date of a timestamptz or timestamp column in IANA zone $tzParam.
 * timestamptz: (col AT TIME ZONE tz)::date
 * timestamp without time zone: treat stored clock as UTC then convert
 * (same convention as reports cash-collected for naive TIMESTAMP).
 */
function hotelInstantDateSql(column: string, tzParam: string): string {
  return `(
    CASE
      WHEN pg_typeof(${column})::text = 'timestamp with time zone'
        THEN (${column} AT TIME ZONE ${tzParam})
      ELSE ((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${tzParam})
    END
  )::date`;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function occupancyPercent(occupied: number, sellable: number): number | null {
  if (sellable <= 0) return null;
  return Number(((occupied / sellable) * 100).toFixed(1));
}

async function loadPropertyTimezone(
  client: Pool | PoolClient,
  propertyId: number
): Promise<string> {
  const propRes = await client.query(
    'SELECT id, timezone FROM properties WHERE id = $1',
    [propertyId]
  );
  if ((propRes.rowCount ?? 0) === 0) {
    throw httpError(404, 'PROPERTY_NOT_FOUND', `property ${propertyId} not found`);
  }
  try {
    return requirePropertyTimezone(propRes.rows[0].timezone);
  } catch (err) {
    if (err instanceof InvalidPropertyTimezoneError) {
      throw httpError(400, 'PROPERTY_TIMEZONE_INVALID', err.message);
    }
    throw err;
  }
}

export async function getDailyKpis(
  client: Pool | PoolClient,
  propertyId: number,
  dateValue?: string | null
): Promise<DailyKpiResult> {
  const timezone = await loadPropertyTimezone(client, propertyId);

  let businessDate: string | null;
  if (dateValue != null && String(dateValue).trim() !== '') {
    businessDate = normalizeHotelDate(dateValue);
    if (!businessDate) {
      throw httpError(400, 'VALIDATION_ERROR', 'invalid hotel date format, expected YYYY-MM-DD');
    }
  } else {
    businessDate = hotelDateFromInstant(new Date(), timezone);
    if (!businessDate) {
      throw httpError(500, 'INTERNAL_ERROR', 'unable to derive hotel business date');
    }
  }

  const createdHotelDate = hotelInstantDateSql('b.created_at', '$3');
  const checkedInHotelDate = hotelInstantDateSql('r.checked_in_at', '$3');
  const checkedOutHotelDate = hotelInstantDateSql('r.checked_out_at', '$3');

  const result = await client.query(
    `
    WITH active_rooms AS (
      SELECT r.id, r.status
      FROM rooms r
      WHERE r.property_id = $1
        AND COALESCE(r.is_active, TRUE) = TRUE
    ),
    blocked_rooms AS (
      SELECT DISTINCT ar.id
      FROM active_rooms ar
      WHERE UPPER(ar.status) IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
      UNION
      SELECT DISTINCT b.room_id
      FROM room_operational_blocks b
      JOIN active_rooms ar ON ar.id = b.room_id
      WHERE b.property_id = $1
        AND b.status = 'ACTIVE'
        AND b.block_type IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
        AND b.start_date <= $2::date
        AND b.end_date > $2::date
        AND b.room_id IS NOT NULL
    ),
    occupied AS (
      SELECT COUNT(*)::int AS occupied_rooms
      FROM reservations r
      JOIN bookings b ON b.id = r.booking_id
      WHERE b.property_id = $1
        AND COALESCE(b.booking_status, 'ACTIVE') <> 'CANCELLED'
        AND UPPER(r.status) IN ('BOOKED', 'CHECKED_IN')
        AND (
          CASE
            WHEN UPPER(COALESCE(r.stay_type, 'OVERNIGHT')) = 'DAY_USE'
              THEN r.check_in::date = $2::date
            ELSE r.check_in::date <= $2::date AND r.check_out::date > $2::date
          END
        )
    ),
    booked_today AS (
      SELECT
        COUNT(DISTINCT b.id)::int AS bookings,
        COUNT(r.id) FILTER (
          WHERE r.id IS NOT NULL
            AND UPPER(COALESCE(r.status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
        )::int AS rooms
      FROM bookings b
      LEFT JOIN reservations r ON r.booking_id = b.id
      WHERE b.property_id = $1
        AND COALESCE(b.booking_status, 'ACTIVE') <> 'CANCELLED'
        AND ${createdHotelDate} = $2::date
    ),
    check_in_today AS (
      SELECT COUNT(*)::int AS rooms
      FROM reservations r
      JOIN bookings b ON b.id = r.booking_id
      WHERE b.property_id = $1
        AND r.checked_in_at IS NOT NULL
        AND UPPER(r.status) IN ('CHECKED_IN', 'CHECKED_OUT')
        AND UPPER(r.status) NOT IN ('CANCELLED', 'NO_SHOW')
        AND ${checkedInHotelDate} = $2::date
    ),
    check_out_today AS (
      SELECT COUNT(*)::int AS rooms
      FROM reservations r
      JOIN bookings b ON b.id = r.booking_id
      WHERE b.property_id = $1
        AND UPPER(r.status) = 'CHECKED_OUT'
        AND r.checked_in_at IS NOT NULL
        AND r.checked_out_at IS NOT NULL
        AND ${checkedOutHotelDate} = $2::date
    ),
    checkout_pending AS (
      SELECT COUNT(*)::int AS pending
      FROM housekeeping_tasks t
      WHERE t.property_id = $1
        AND t.task_type = 'CHECKOUT_ROOM_CHECK'
        AND COALESCE(t.is_archived, FALSE) = FALSE
        AND UPPER(t.status) = ANY($4::text[])
    )
    SELECT
      (SELECT COUNT(*)::int FROM active_rooms) AS gross_active,
      (SELECT COUNT(*)::int FROM blocked_rooms) AS ooo_oos_rooms,
      (SELECT occupied_rooms FROM occupied) AS occupied_rooms,
      (SELECT bookings FROM booked_today) AS booked_bookings,
      (SELECT rooms FROM booked_today) AS booked_rooms,
      (SELECT rooms FROM check_in_today) AS check_in_rooms,
      (SELECT rooms FROM check_out_today) AS check_out_rooms,
      (SELECT COUNT(*)::int FROM active_rooms WHERE UPPER(status) IN ('VACANT_DIRTY', 'OCCUPIED_DIRTY')) AS dirty,
      (SELECT COUNT(*)::int FROM active_rooms WHERE status = 'VACANT_CLEAN') AS vacant_clean,
      (SELECT pending FROM checkout_pending) AS checkout_pending
    `,
    [propertyId, businessDate, timezone, CHECKOUT_ROOM_CHECK_PENDING_STATUSES]
  );

  const row = result.rows[0] || {};
  const occupiedRooms = toCount(row.occupied_rooms);
  const oooOosRooms = toCount(row.ooo_oos_rooms);
  const grossActive = toCount(row.gross_active);
  const sellableRooms = Math.max(0, grossActive - oooOosRooms);

  return {
    property_id: propertyId,
    business_date: businessDate,
    timezone,
    occupancy: {
      occupied_rooms: occupiedRooms,
      sellable_rooms: sellableRooms,
      occupancy_pct: occupancyPercent(occupiedRooms, sellableRooms),
      ooo_oos_rooms: oooOosRooms,
    },
    booked_today: {
      rooms: toCount(row.booked_rooms),
      bookings: toCount(row.booked_bookings),
    },
    check_in_today: { rooms: toCount(row.check_in_rooms) },
    check_out_today: { rooms: toCount(row.check_out_rooms) },
    rooms: {
      dirty: toCount(row.dirty),
      vacant_clean: toCount(row.vacant_clean),
      maintenance_ooo_oos: oooOosRooms,
    },
    checkout_check: { pending: toCount(row.checkout_pending) },
  };
}
