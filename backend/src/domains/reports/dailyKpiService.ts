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

export const DAILY_KPI_DRILLDOWN_TYPES = [
  'occupancy',
  'booked',
  'checkin',
  'checkout',
  'dirty',
  'vacant_clean',
  'checkout_check',
  'maintenance',
] as const;

export type DailyKpiDrilldownType = (typeof DAILY_KPI_DRILLDOWN_TYPES)[number];

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

export interface DailyKpiStayItem {
  reservation_id: number;
  booking_id: number;
  bid: string | null;
  guest_name: string | null;
  room_id: number | null;
  room_number: string | null;
  room_type_name: string | null;
  status: string | null;
  stay_type: string | null;
  check_in: string | null;
  check_out: string | null;
  checked_in_at?: string | null;
  checked_out_at?: string | null;
}

export interface DailyKpiBookedChild {
  reservation_id: number;
  room_id: number | null;
  room_number: string | null;
  room_type_name: string | null;
  status: string | null;
}

export interface DailyKpiBookedGroup {
  booking_id: number;
  bid: string | null;
  guest_name: string | null;
  booking_status: string | null;
  booking_source: string | null;
  created_at: string | null;
  room_count: number;
  children: DailyKpiBookedChild[];
}

export interface DailyKpiRoomItem {
  room_id: number;
  room_number: string | null;
  room_type_name: string | null;
  status: string | null;
}

export interface DailyKpiCheckoutCheckItem {
  task_id: number;
  task_number: string | null;
  status: string | null;
  room_id: number | null;
  room_number: string | null;
  room_type_name: string | null;
  reservation_id: number | null;
  guest_name: string | null;
  bid: string | null;
  created_at: string | null;
}

export interface DailyKpiMaintenanceItem {
  room_id: number;
  room_number: string | null;
  room_type_name: string | null;
  room_status: string | null;
  from_room_status: boolean;
  from_operational_block: boolean;
  block_type: string | null;
}

interface DailyKpiDrilldownBase {
  property_id: number;
  business_date: string;
  timezone: string;
  count: number;
}

export type DailyKpiDrilldownResult =
  | (DailyKpiDrilldownBase & { type: 'occupancy'; items: DailyKpiStayItem[] })
  | (DailyKpiDrilldownBase & {
      type: 'booked';
      groups: DailyKpiBookedGroup[];
      bookings: number;
      rooms: number;
    })
  | (DailyKpiDrilldownBase & { type: 'checkin'; items: DailyKpiStayItem[] })
  | (DailyKpiDrilldownBase & { type: 'checkout'; items: DailyKpiStayItem[] })
  | (DailyKpiDrilldownBase & { type: 'dirty'; items: DailyKpiRoomItem[] })
  | (DailyKpiDrilldownBase & { type: 'vacant_clean'; items: DailyKpiRoomItem[] })
  | (DailyKpiDrilldownBase & { type: 'checkout_check'; items: DailyKpiCheckoutCheckItem[] })
  | (DailyKpiDrilldownBase & { type: 'maintenance'; items: DailyKpiMaintenanceItem[] });

const STAY_SELECT = `
  r.id AS reservation_id,
  b.id AS booking_id,
  COALESCE(b.bid, r.booking_number) AS bid,
  COALESCE(r.guest_name, b.guest_name_snapshot) AS guest_name,
  r.room_id,
  rm.room_number,
  COALESCE(rt.name, r.booked_room_type_name_snapshot) AS room_type_name,
  r.status,
  r.stay_type,
  to_char(r.check_in::date, 'YYYY-MM-DD') AS check_in,
  to_char(r.check_out::date, 'YYYY-MM-DD') AS check_out
`;

const STAY_JOINS = `
  FROM reservations r
  JOIN bookings b ON b.id = r.booking_id
  LEFT JOIN rooms rm ON rm.id = r.room_id
  LEFT JOIN room_types rt ON rt.id = COALESCE(rm.room_type_id, r.booked_room_type_id_snapshot)
`;

const ACTIVE_ROOMS_CTE = `
  active_rooms AS (
    SELECT r.id, r.status
    FROM rooms r
    WHERE r.property_id = $1
      AND COALESCE(r.is_active, TRUE) = TRUE
  )
`;

const BLOCKED_ROOMS_CTE = `
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
  )
`;

const OCCUPANCY_PREDICATE = `
  b.property_id = $1
  AND COALESCE(b.booking_status, 'ACTIVE') <> 'CANCELLED'
  AND UPPER(r.status) IN ('BOOKED', 'CHECKED_IN')
  AND (
    CASE
      WHEN UPPER(COALESCE(r.stay_type, 'OVERNIGHT')) = 'DAY_USE'
        THEN r.check_in::date = $2::date
      ELSE r.check_in::date <= $2::date AND r.check_out::date > $2::date
    END
  )
`;

const BOOKED_TODAY_BOOKING_PREDICATE = (createdHotelDate: string) => `
  b.property_id = $1
  AND COALESCE(b.booking_status, 'ACTIVE') <> 'CANCELLED'
  AND ${createdHotelDate} = $2::date
`;

const BOOKED_TODAY_CHILD_PREDICATE = `
  r.id IS NOT NULL
  AND UPPER(COALESCE(r.status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
`;

const CHECK_IN_TODAY_PREDICATE = (checkedInHotelDate: string) => `
  b.property_id = $1
  AND r.checked_in_at IS NOT NULL
  AND UPPER(r.status) IN ('CHECKED_IN', 'CHECKED_OUT')
  AND UPPER(r.status) NOT IN ('CANCELLED', 'NO_SHOW')
  AND ${checkedInHotelDate} = $2::date
`;

const CHECK_OUT_TODAY_PREDICATE = (checkedOutHotelDate: string) => `
  b.property_id = $1
  AND UPPER(r.status) = 'CHECKED_OUT'
  AND r.checked_in_at IS NOT NULL
  AND r.checked_out_at IS NOT NULL
  AND ${checkedOutHotelDate} = $2::date
`;

const CHECKOUT_PENDING_PREDICATE = (statusParam: string) => `
  t.property_id = $1
  AND t.task_type = 'CHECKOUT_ROOM_CHECK'
  AND COALESCE(t.is_archived, FALSE) = FALSE
  AND UPPER(t.status) = ANY(${statusParam}::text[])
`;

const DIRTY_STATUS_PREDICATE = `UPPER(status) IN ('VACANT_DIRTY', 'OCCUPIED_DIRTY')`;
const VACANT_CLEAN_STATUS_PREDICATE = `status = 'VACANT_CLEAN'`;

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

function toNullableInt(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function occupancyPercent(occupied: number, sellable: number): number | null {
  if (sellable <= 0) return null;
  return Number(((occupied / sellable) * 100).toFixed(1));
}

function asIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const text = String(value).trim();
  return text === '' ? null : text;
}

function asText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function asBool(value: unknown): boolean {
  return value === true || value === 't' || value === 'true';
}

export function isDailyKpiDrilldownType(value: unknown): value is DailyKpiDrilldownType {
  return typeof value === 'string' && (DAILY_KPI_DRILLDOWN_TYPES as readonly string[]).includes(value);
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

async function resolveKpiScope(
  client: Pool | PoolClient,
  propertyId: number,
  dateValue?: string | null
): Promise<{ timezone: string; businessDate: string }> {
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

  return { timezone, businessDate };
}

function kpiParams(propertyId: number, businessDate: string, timezone: string): unknown[] {
  return [propertyId, businessDate, timezone, CHECKOUT_ROOM_CHECK_PENDING_STATUSES];
}

function mapStayItem(row: any, extra: Partial<DailyKpiStayItem> = {}): DailyKpiStayItem {
  return {
    reservation_id: Number(row.reservation_id),
    booking_id: Number(row.booking_id),
    bid: asText(row.bid),
    guest_name: asText(row.guest_name),
    room_id: toNullableInt(row.room_id),
    room_number: asText(row.room_number),
    room_type_name: asText(row.room_type_name),
    status: asText(row.status),
    stay_type: asText(row.stay_type),
    check_in: asText(row.check_in),
    check_out: asText(row.check_out),
    ...extra,
  };
}

function mapRoomItem(row: any): DailyKpiRoomItem {
  return {
    room_id: Number(row.room_id),
    room_number: asText(row.room_number),
    room_type_name: asText(row.room_type_name),
    status: asText(row.status),
  };
}

function parseBookedChildren(value: unknown): DailyKpiBookedChild[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? JSON.parse(value) : [];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((child) => child && child.reservation_id != null)
    .map((child) => ({
      reservation_id: Number(child.reservation_id),
      room_id: toNullableInt(child.room_id),
      room_number: asText(child.room_number),
      room_type_name: asText(child.room_type_name),
      status: asText(child.status),
    }));
}

export async function getDailyKpis(
  client: Pool | PoolClient,
  propertyId: number,
  dateValue?: string | null
): Promise<DailyKpiResult> {
  const { timezone, businessDate } = await resolveKpiScope(client, propertyId, dateValue);

  const createdHotelDate = hotelInstantDateSql('b.created_at', '$3');
  const checkedInHotelDate = hotelInstantDateSql('r.checked_in_at', '$3');
  const checkedOutHotelDate = hotelInstantDateSql('r.checked_out_at', '$3');

  const result = await client.query(
    `
    WITH ${ACTIVE_ROOMS_CTE},
    ${BLOCKED_ROOMS_CTE},
    occupied AS (
      SELECT COUNT(*)::int AS occupied_rooms
      FROM reservations r
      JOIN bookings b ON b.id = r.booking_id
      WHERE ${OCCUPANCY_PREDICATE}
    ),
    booked_today AS (
      SELECT
        COUNT(DISTINCT b.id)::int AS bookings,
        COUNT(r.id) FILTER (WHERE ${BOOKED_TODAY_CHILD_PREDICATE})::int AS rooms
      FROM bookings b
      LEFT JOIN reservations r ON r.booking_id = b.id
      WHERE ${BOOKED_TODAY_BOOKING_PREDICATE(createdHotelDate)}
    ),
    check_in_today AS (
      SELECT COUNT(*)::int AS rooms
      FROM reservations r
      JOIN bookings b ON b.id = r.booking_id
      WHERE ${CHECK_IN_TODAY_PREDICATE(checkedInHotelDate)}
    ),
    check_out_today AS (
      SELECT COUNT(*)::int AS rooms
      FROM reservations r
      JOIN bookings b ON b.id = r.booking_id
      WHERE ${CHECK_OUT_TODAY_PREDICATE(checkedOutHotelDate)}
    ),
    checkout_pending AS (
      SELECT COUNT(*)::int AS pending
      FROM housekeeping_tasks t
      WHERE ${CHECKOUT_PENDING_PREDICATE('$4')}
    )
    SELECT
      (SELECT COUNT(*)::int FROM active_rooms) AS gross_active,
      (SELECT COUNT(*)::int FROM blocked_rooms) AS ooo_oos_rooms,
      (SELECT occupied_rooms FROM occupied) AS occupied_rooms,
      (SELECT bookings FROM booked_today) AS booked_bookings,
      (SELECT rooms FROM booked_today) AS booked_rooms,
      (SELECT rooms FROM check_in_today) AS check_in_rooms,
      (SELECT rooms FROM check_out_today) AS check_out_rooms,
      (SELECT COUNT(*)::int FROM active_rooms WHERE ${DIRTY_STATUS_PREDICATE}) AS dirty,
      (SELECT COUNT(*)::int FROM active_rooms WHERE ${VACANT_CLEAN_STATUS_PREDICATE}) AS vacant_clean,
      (SELECT pending FROM checkout_pending) AS checkout_pending
    `,
    kpiParams(propertyId, businessDate, timezone)
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

export async function getDailyKpiDrilldown(
  client: Pool | PoolClient,
  propertyId: number,
  typeValue: unknown,
  dateValue?: string | null
): Promise<DailyKpiDrilldownResult> {
  if (!isDailyKpiDrilldownType(typeValue)) {
    throw httpError(
      400,
      'VALIDATION_ERROR',
      'type is required and must be one of: occupancy, booked, checkin, checkout, dirty, vacant_clean, checkout_check, maintenance'
    );
  }

  const { timezone, businessDate } = await resolveKpiScope(client, propertyId, dateValue);
  const createdHotelDate = hotelInstantDateSql('b.created_at', '$3');
  const checkedInHotelDate = hotelInstantDateSql('r.checked_in_at', '$3');
  const checkedOutHotelDate = hotelInstantDateSql('r.checked_out_at', '$3');
  const dateParams = [propertyId, businessDate];
  const tzParams = [propertyId, businessDate, timezone];
  const base = {
    property_id: propertyId,
    business_date: businessDate,
    timezone,
  };

  if (typeValue === 'occupancy') {
    const result = await client.query(
      `
      SELECT ${STAY_SELECT}
      ${STAY_JOINS}
      WHERE ${OCCUPANCY_PREDICATE}
      ORDER BY rm.room_number NULLS LAST, b.bid, r.stay_sequence, r.id
      `,
      dateParams
    );
    const items = result.rows.map((row) => mapStayItem(row));
    return { ...base, type: 'occupancy', count: items.length, items };
  }

  if (typeValue === 'booked') {
    const result = await client.query(
      `
      SELECT
        b.id AS booking_id,
        b.bid,
        b.guest_name_snapshot AS guest_name,
        b.booking_status,
        b.booking_source,
        b.created_at,
        COUNT(r.id) FILTER (WHERE ${BOOKED_TODAY_CHILD_PREDICATE})::int AS room_count,
        COALESCE(
          json_agg(
            json_build_object(
              'reservation_id', r.id,
              'room_id', r.room_id,
              'room_number', rm.room_number,
              'room_type_name', COALESCE(rt.name, r.booked_room_type_name_snapshot),
              'status', r.status
            ) ORDER BY r.stay_sequence, r.id
          ) FILTER (WHERE ${BOOKED_TODAY_CHILD_PREDICATE}),
          '[]'::json
        ) AS children
      FROM bookings b
      LEFT JOIN reservations r ON r.booking_id = b.id
      LEFT JOIN rooms rm ON rm.id = r.room_id
      LEFT JOIN room_types rt ON rt.id = COALESCE(rm.room_type_id, r.booked_room_type_id_snapshot)
      WHERE ${BOOKED_TODAY_BOOKING_PREDICATE(createdHotelDate)}
      GROUP BY b.id, b.bid, b.guest_name_snapshot, b.booking_status, b.booking_source, b.created_at
      ORDER BY b.created_at, b.id
      `,
      tzParams
    );
    const groups: DailyKpiBookedGroup[] = result.rows.map((row) => ({
      booking_id: Number(row.booking_id),
      bid: asText(row.bid),
      guest_name: asText(row.guest_name),
      booking_status: asText(row.booking_status),
      booking_source: asText(row.booking_source),
      created_at: asIso(row.created_at),
      room_count: toCount(row.room_count),
      children: parseBookedChildren(row.children),
    }));
    const rooms = groups.reduce((sum, group) => sum + group.room_count, 0);
    return {
      ...base,
      type: 'booked',
      count: rooms,
      groups,
      bookings: groups.length,
      rooms,
    };
  }

  if (typeValue === 'checkin') {
    const result = await client.query(
      `
      SELECT ${STAY_SELECT}, r.checked_in_at
      ${STAY_JOINS}
      WHERE ${CHECK_IN_TODAY_PREDICATE(checkedInHotelDate)}
      ORDER BY r.checked_in_at, r.id
      `,
      tzParams
    );
    const items = result.rows.map((row) => mapStayItem(row, { checked_in_at: asIso(row.checked_in_at) }));
    return { ...base, type: 'checkin', count: items.length, items };
  }

  if (typeValue === 'checkout') {
    const result = await client.query(
      `
      SELECT ${STAY_SELECT}, r.checked_in_at, r.checked_out_at
      ${STAY_JOINS}
      WHERE ${CHECK_OUT_TODAY_PREDICATE(checkedOutHotelDate)}
      ORDER BY r.checked_out_at, r.id
      `,
      tzParams
    );
    const items = result.rows.map((row) =>
      mapStayItem(row, {
        checked_in_at: asIso(row.checked_in_at),
        checked_out_at: asIso(row.checked_out_at),
      })
    );
    return { ...base, type: 'checkout', count: items.length, items };
  }

  if (typeValue === 'dirty' || typeValue === 'vacant_clean') {
    const statusPredicate = typeValue === 'dirty'
      ? `UPPER(ar.status) IN ('VACANT_DIRTY', 'OCCUPIED_DIRTY')`
      : `ar.status = 'VACANT_CLEAN'`;
    const result = await client.query(
      `
      WITH ${ACTIVE_ROOMS_CTE}
      SELECT
        ar.id AS room_id,
        rm.room_number,
        rt.name AS room_type_name,
        ar.status
      FROM active_rooms ar
      JOIN rooms rm ON rm.id = ar.id
      LEFT JOIN room_types rt ON rt.id = rm.room_type_id
      WHERE ${statusPredicate}
      ORDER BY rm.room_number, ar.id
      `,
      [propertyId]
    );
    const items = result.rows.map(mapRoomItem);
    return { ...base, type: typeValue, count: items.length, items };
  }

  if (typeValue === 'checkout_check') {
    const result = await client.query(
      `
      SELECT
        t.id AS task_id,
        t.task_number,
        t.status,
        t.room_id,
        rm.room_number,
        rt.name AS room_type_name,
        t.reservation_id,
        COALESCE(res.guest_name, b.guest_name_snapshot) AS guest_name,
        COALESCE(b.bid, res.booking_number) AS bid,
        t.created_at
      FROM housekeeping_tasks t
      LEFT JOIN rooms rm ON rm.id = t.room_id
      LEFT JOIN room_types rt ON rt.id = rm.room_type_id
      LEFT JOIN reservations res ON res.id = t.reservation_id
      LEFT JOIN bookings b ON b.id = res.booking_id
      WHERE ${CHECKOUT_PENDING_PREDICATE('$2')}
      ORDER BY t.created_at, t.id
      `,
      [propertyId, CHECKOUT_ROOM_CHECK_PENDING_STATUSES]
    );
    const items: DailyKpiCheckoutCheckItem[] = result.rows.map((row) => ({
      task_id: Number(row.task_id),
      task_number: asText(row.task_number),
      status: asText(row.status),
      room_id: toNullableInt(row.room_id),
      room_number: asText(row.room_number),
      room_type_name: asText(row.room_type_name),
      reservation_id: toNullableInt(row.reservation_id),
      guest_name: asText(row.guest_name),
      bid: asText(row.bid),
      created_at: asIso(row.created_at),
    }));
    return { ...base, type: 'checkout_check', count: items.length, items };
  }

  const result = await client.query(
    `
    WITH ${ACTIVE_ROOMS_CTE},
    ${BLOCKED_ROOMS_CTE},
    status_blocked AS (
      SELECT ar.id
      FROM active_rooms ar
      WHERE UPPER(ar.status) IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
    ),
    op_blocked AS (
      SELECT DISTINCT b.room_id AS id, b.block_type
      FROM room_operational_blocks b
      JOIN active_rooms ar ON ar.id = b.room_id
      WHERE b.property_id = $1
        AND b.status = 'ACTIVE'
        AND b.block_type IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')
        AND b.start_date <= $2::date
        AND b.end_date > $2::date
        AND b.room_id IS NOT NULL
    )
    SELECT
      ar.id AS room_id,
      rm.room_number,
      rt.name AS room_type_name,
      ar.status AS room_status,
      EXISTS (SELECT 1 FROM status_blocked sb WHERE sb.id = ar.id) AS from_room_status,
      EXISTS (SELECT 1 FROM op_blocked ob WHERE ob.id = ar.id) AS from_operational_block,
      (SELECT ob.block_type FROM op_blocked ob WHERE ob.id = ar.id ORDER BY ob.block_type LIMIT 1) AS block_type
    FROM blocked_rooms br
    JOIN active_rooms ar ON ar.id = br.id
    JOIN rooms rm ON rm.id = ar.id
    LEFT JOIN room_types rt ON rt.id = rm.room_type_id
    ORDER BY rm.room_number, ar.id
    `,
    dateParams
  );
  const items: DailyKpiMaintenanceItem[] = result.rows.map((row) => ({
    room_id: Number(row.room_id),
    room_number: asText(row.room_number),
    room_type_name: asText(row.room_type_name),
    room_status: asText(row.room_status),
    from_room_status: asBool(row.from_room_status),
    from_operational_block: asBool(row.from_operational_block),
    block_type: asText(row.block_type),
  }));
  return { ...base, type: 'maintenance', count: items.length, items };
}
