import type { Pool, PoolClient } from 'pg';
import {
  normalizeHotelDate,
  hotelDateKey,
  hotelDateFromInstant,
  addHotelDays,
  enumerateHotelDates
} from '../../utils/hotelDate';

export interface OccupancyQueryOptions {
  property_id: number;
  start_date?: string | null;
  end_date?: string | null;
  date?: string | null;
  include_room_types?: boolean;
  include_daily?: boolean;
}

export interface OccupancyMetrics {
  gross_room_nights: number;
  ooo_room_nights: number;
  oos_room_nights: number;
  blocked_room_nights: number;
  sellable_room_nights: number;
  sold_room_nights: number;
  available_room_nights: number;
  occupancy_pct: number;
  is_zero_sellable?: boolean;
}

export interface FinancialMetrics {
  room_revenue: number;
  paid_room_nights: number;
  complimentary_room_nights: number;
  adr: number;
  revpar: number;
  alos: number;
  room_revenue_by_type: Record<string, number>;
}

export interface DailyOccupancyItem extends OccupancyMetrics {
  date: string;
}

export interface RoomTypeOccupancyItem extends OccupancyMetrics {
  room_type_id: number;
  room_type_code: string;
  room_type_name: string;
  is_active_current?: boolean;
  daily?: DailyOccupancyItem[];
}

export interface OoBlockHistoryItem {
  id: number;
  room_id: number;
  room_number: string;
  room_type_id: number;
  room_type_code: string | null;
  room_type_name: string;
  block_type: string;
  start_date: string;
  end_date: string;
  duration_days: number;
  period_nights: number;
  reason: string | null;
  status: string;
  created_by: string | null;
  created_at: string | null;
  released_by: string | null;
  released_at: string | null;
}

export interface OccupancyReportResult {
  property_id: number;
  start_date: string;
  end_date: string;
  nights: number;
  totals: OccupancyMetrics;
  financials: FinancialMetrics;
  daily: DailyOccupancyItem[];
  room_types?: RoomTypeOccupancyItem[];
  oo_blocks_history?: OoBlockHistoryItem[];
}

export interface CapacityCoverageCheck {
  is_covered: boolean;
  first_covered_date: string | null;
  last_covered_date: string | null;
  coverage_end_exclusive: string | null;
  available_ledger_start: string | null;
  available_ledger_end: string | null;
  missing_dates: string[];
  missing_count: number;
}

export function httpError(
  statusCode: number,
  code: string,
  message: string,
  details?: any
): Error & { statusCode: number; code: string; details?: any } {
  const err = new Error(message) as Error & { statusCode: number; code: string; details?: any };
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) {
    err.details = details;
  }
  return err;
}

/**
 * Validates invariants and computes derived occupancy metrics.
 *
 * Core Formulas:
 *   Blocked = OOO + OOS
 *   Sellable = Gross - Blocked
 *   Available = Sellable - Sold
 *   Occupancy% = (Sold / Sellable) * 100
 *
 * Required Invariants:
 *   0 <= Blocked <= Gross
 *   0 <= Sold <= Sellable
 *   0 <= Available <= Sellable
 */
export function computeOccupancyMetrics(
  gross: number,
  ooo: number,
  oos: number,
  sold: number,
  contextDesc = 'occupancy'
): OccupancyMetrics {
  const blocked = ooo + oos;
  const sellable = gross - blocked;
  const available = sellable - sold;

  if (gross < 0) {
    throw httpError(
      500,
      'OCCUPANCY_INTEGRITY_VIOLATION',
      `Negative gross capacity (${gross}) detected in ${contextDesc}`
    );
  }
  if (ooo < 0 || oos < 0 || blocked < 0) {
    throw httpError(
      500,
      'OCCUPANCY_INTEGRITY_VIOLATION',
      `Negative operational block count (OOO: ${ooo}, OOS: ${oos}) detected in ${contextDesc}`
    );
  }
  if (blocked > gross) {
    throw httpError(
      500,
      'OCCUPANCY_INTEGRITY_VIOLATION',
      `Blocked rooms (${blocked}) exceeds gross capacity (${gross}) in ${contextDesc}`
    );
  }
  if (sellable < 0) {
    throw httpError(
      500,
      'OCCUPANCY_INTEGRITY_VIOLATION',
      `Negative sellable capacity (${sellable}) detected in ${contextDesc}`
    );
  }
  if (sold < 0) {
    throw httpError(
      500,
      'OCCUPANCY_INTEGRITY_VIOLATION',
      `Negative sold room count (${sold}) detected in ${contextDesc}`
    );
  }
  if (sold > sellable) {
    throw httpError(
      500,
      'OCCUPANCY_INTEGRITY_VIOLATION',
      `Sold rooms (${sold}) exceeds sellable capacity (${sellable}) in ${contextDesc}`
    );
  }
  if (available < 0 || available > sellable) {
    throw httpError(
      500,
      'OCCUPANCY_INTEGRITY_VIOLATION',
      `Invalid available rooms count (${available}) for sellable (${sellable}) in ${contextDesc}`
    );
  }

  let occupancyPct = 0;
  let isZeroSellable = false;

  if (sellable > 0) {
    occupancyPct = Number(((sold / sellable) * 100).toFixed(2));
  } else {
    isZeroSellable = true;
  }

  return {
    gross_room_nights: gross,
    ooo_room_nights: ooo,
    oos_room_nights: oos,
    blocked_room_nights: blocked,
    sellable_room_nights: sellable,
    sold_room_nights: sold,
    available_room_nights: available,
    occupancy_pct: occupancyPct,
    ...(isZeroSellable ? { is_zero_sellable: true } : {})
  };
}

/**
 * Checks canonical availability_dates capacity coverage for propertyId in [startDate, endDate).
 *
 * Coverage Principles:
 * 1. Historical capacity is determined from availability_dates for property-owned room types,
 *    NOT from the present Room Master state (room_types.is_active).
 * 2. If a requested date falls outside the seeded availability ledger bounds, or has zero
 *    capacity records, fail closed with 409 CAPACITY_HISTORY_UNAVAILABLE.
 * 3. Distinguishes first_covered_date (inclusive MIN), last_covered_date (inclusive MAX),
 *    and coverage_end_exclusive (MAX + 1 day).
 */
export async function assertCapacityCoverage(
  client: PoolClient | Pool,
  propertyId: number,
  startDate: string,
  endDate: string
): Promise<void> {
  const query = `
    WITH property_room_types AS (
      SELECT id, name, code, is_active
      FROM room_types
      WHERE property_id = $1
    ),
    ledger_bounds AS (
      SELECT
        to_char(MIN(ad.date), 'YYYY-MM-DD') AS first_covered_date,
        to_char(MAX(ad.date), 'YYYY-MM-DD') AS last_covered_date,
        COUNT(DISTINCT ad.date) AS total_covered_dates
      FROM availability_dates ad
      JOIN property_room_types prt ON prt.id = ad.room_type_id
    ),
    requested_dates AS (
      SELECT d::date AS hotel_date
      FROM generate_series($2::date, ($3::date - INTERVAL '1 day'), INTERVAL '1 day') d
    ),
    missing_dates_agg AS (
      -- 1. Requested dates where property has no availability_dates rows at all
      SELECT
        to_char(rd.hotel_date, 'YYYY-MM-DD') AS missing_date,
        'NO_PROPERTY_CAPACITY' AS reason
      FROM requested_dates rd
      LEFT JOIN (
        SELECT DISTINCT ad.date::date AS dt
        FROM availability_dates ad
        JOIN property_room_types prt ON prt.id = ad.room_type_id
      ) prop_ad ON prop_ad.dt = rd.hotel_date
      WHERE prop_ad.dt IS NULL

      UNION

      -- 2. Stays/reservations that exist without a corresponding availability_dates capacity row
      SELECT
        to_char(d::date, 'YYYY-MM-DD') AS missing_date,
        'RESERVATION_WITHOUT_CAPACITY' AS reason
      FROM reservations r
      JOIN bookings b ON b.id = r.booking_id
      LEFT JOIN rooms ro ON ro.id = r.room_id
      CROSS JOIN LATERAL generate_series(r.check_in::date, r.check_out::date - INTERVAL '1 day', INTERVAL '1 day') d
      WHERE b.property_id = $1
        AND r.status IN ('BOOKED', 'CHECKED_IN', 'CHECKED_OUT')
        AND b.booking_status != 'CANCELLED'
        AND d >= $2::date
        AND d < $3::date
        AND NOT EXISTS (
          SELECT 1 FROM availability_dates ad
          WHERE ad.room_type_id = COALESCE(ro.room_type_id, r.booked_room_type_id_snapshot)
            AND ad.date::date = d::date
        )

      UNION

      -- 3. Gaps within a room type's active operational ledger lifespan
      SELECT
        to_char(rd.hotel_date, 'YYYY-MM-DD') AS missing_date,
        'ROOM_TYPE_SPAN_GAP' AS reason
      FROM (
        SELECT
          ad.room_type_id,
          MIN(ad.date)::date AS min_dt,
          MAX(ad.date)::date AS max_dt
        FROM availability_dates ad
        JOIN property_room_types prt ON prt.id = ad.room_type_id
        GROUP BY ad.room_type_id
      ) rt_span
      JOIN requested_dates rd ON rd.hotel_date >= rt_span.min_dt AND rd.hotel_date <= rt_span.max_dt
      LEFT JOIN availability_dates ad ON ad.room_type_id = rt_span.room_type_id AND ad.date::date = rd.hotel_date
      WHERE ad.id IS NULL
    )
    SELECT
      lb.first_covered_date,
      lb.last_covered_date,
      lb.total_covered_dates,
      m.missing_date,
      m.reason
    FROM ledger_bounds lb
    LEFT JOIN missing_dates_agg m ON TRUE
    ORDER BY m.missing_date ASC;
  `;

  const result = await client.query(query, [propertyId, startDate, endDate]);
  const rows = result.rows;

  const firstCovered = rows[0]?.first_covered_date || null;
  const lastCovered = rows[0]?.last_covered_date || null;
  const coverageEndExclusive = lastCovered ? addHotelDays(lastCovered, 1) : null;

  const missingRows = rows.filter((r) => r.missing_date !== null);

  if (missingRows.length > 0 || !firstCovered || !lastCovered) {
    const missingDates = Array.from(new Set(missingRows.map((r) => r.missing_date)));
    if (!firstCovered || !lastCovered) {
      // Entire property has no ledger coverage at all
      const allRequested = enumerateHotelDates(startDate, endDate);
      throw httpError(
        409,
        'CAPACITY_HISTORY_UNAVAILABLE',
        `Capacity history is unavailable for property ${propertyId} in date range [${startDate}, ${endDate}); no availability ledger records exist for this property.`,
        {
          property_id: propertyId,
          requested_start_date: startDate,
          requested_end_date: endDate,
          first_covered_date: null,
          last_covered_date: null,
          coverage_end_exclusive: null,
          available_ledger_start: null,
          available_ledger_end: null,
          missing_dates: allRequested,
          missing_count: allRequested.length
        }
      );
    }

    throw httpError(
      409,
      'CAPACITY_HISTORY_UNAVAILABLE',
      `Capacity history is incomplete for property ${propertyId} in date range [${startDate}, ${endDate}); missing ${missingDates.length} date-capacity records. Available ledger range: [${firstCovered}, ${lastCovered}] (coverage_end_exclusive: ${coverageEndExclusive})`,
      {
        property_id: propertyId,
        requested_start_date: startDate,
        requested_end_date: endDate,
        first_covered_date: firstCovered,
        last_covered_date: lastCovered,
        coverage_end_exclusive: coverageEndExclusive,
        available_ledger_start: firstCovered,
        available_ledger_end: lastCovered,
        missing_dates: missingDates,
        missing_count: missingDates.length
      }
    );
  }
}

/**
 * Authoritative Historical Occupancy & Sellable Room-Night Engine
 */
export async function calculateOccupancy(
  pool: Pool | PoolClient,
  options: OccupancyQueryOptions
): Promise<OccupancyReportResult> {
  const propertyId = Number(options.property_id ?? (options as any).propertyId);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'property_id is required and must be a positive integer');
  }

  // Verify property exists
  const propCheck = await pool.query('SELECT id, name, property_code FROM properties WHERE id = $1', [propertyId]);
  if ((propCheck.rowCount ?? 0) === 0) {
    throw httpError(404, 'PROPERTY_NOT_FOUND', `property ${propertyId} not found`);
  }

  // Date range normalization [startDate, endDate)
  let startDate: string | null = null;
  let endDate: string | null = null;

  const rawDate = options.date;
  const rawStartDate = options.start_date ?? (options as any).startDate;
  const rawEndDate = options.end_date ?? (options as any).endDate;

  if (rawDate) {
    startDate = normalizeHotelDate(rawDate);
    if (!startDate) {
      throw httpError(400, 'VALIDATION_ERROR', 'invalid date format, expected YYYY-MM-DD');
    }
    endDate = addHotelDays(startDate, 1);
  } else if (rawStartDate || rawEndDate) {
    if (!rawStartDate || !rawEndDate) {
      throw httpError(400, 'VALIDATION_ERROR', 'both start_date and end_date are required when querying date range');
    }
    startDate = normalizeHotelDate(rawStartDate);
    endDate = normalizeHotelDate(rawEndDate);
    if (!startDate) {
      throw httpError(400, 'VALIDATION_ERROR', 'invalid start_date format, expected YYYY-MM-DD');
    }
    if (!endDate) {
      throw httpError(400, 'VALIDATION_ERROR', 'invalid end_date format, expected YYYY-MM-DD');
    }
    if (endDate <= startDate) {
      throw httpError(400, 'VALIDATION_ERROR', 'end_date must be strictly greater than start_date');
    }
  } else {
    startDate = hotelDateFromInstant(new Date(), 'Asia/Jakarta');
    endDate = addHotelDays(startDate, 1);
  }

  const hotelDates = enumerateHotelDates(startDate, endDate);
  const nightsCount = hotelDates.length;
  if (nightsCount === 0) {
    throw httpError(400, 'VALIDATION_ERROR', 'date range contains zero hotel nights');
  }

  // 1. Coverage Gap Assertion (Rule 4 & 5)
  await assertCapacityCoverage(pool, propertyId, startDate, endDate);

  // 2. Set-Based Combined Metric Query
  // Note: Room types participating in the calculation are determined by actual historical activity
  // (gross capacity in availability_dates, reservations sold, or operational blocks) and are NOT
  // restricted by present room_types.is_active = true.
  const query = `
    WITH dates AS (
      SELECT d::date AS hotel_date
      FROM generate_series($2::date, ($3::date - INTERVAL '1 day'), INTERVAL '1 day') d
    ),
    property_room_types AS (
      SELECT
        id AS room_type_id,
        name AS room_type_name,
        code AS room_type_code,
        display_order,
        COALESCE(is_active, TRUE) AS is_active_current
      FROM room_types
      WHERE property_id = $1
    ),
    gross_cap AS (
      SELECT
        ad.room_type_id,
        ad.date::date AS hotel_date,
        ad.total_rooms
      FROM availability_dates ad
      JOIN property_room_types prt ON prt.room_type_id = ad.room_type_id
      WHERE ad.date >= $2::date
        AND ad.date < $3::date
    ),
    blocks AS (
      SELECT
        b.room_type_id,
        d::date AS hotel_date,
        COUNT(*) FILTER (WHERE b.block_type = 'OUT_OF_ORDER')::int AS ooo_count,
        COUNT(*) FILTER (WHERE b.block_type = 'OUT_OF_SERVICE')::int AS oos_count
      FROM room_operational_blocks b
      CROSS JOIN LATERAL generate_series(b.start_date, b.end_date - INTERVAL '1 day', INTERVAL '1 day') d
      WHERE b.property_id = $1
        AND b.status IN ('ACTIVE', 'RELEASED')
        AND d >= $2::date
        AND d < $3::date
      GROUP BY b.room_type_id, d::date
    ),
    sold AS (
      SELECT
        COALESCE(ro.room_type_id, r.booked_room_type_id_snapshot) AS room_type_id,
        d::date AS hotel_date,
        COUNT(*)::int AS sold_count
      FROM reservations r
      JOIN bookings b ON b.id = r.booking_id
      LEFT JOIN rooms ro ON ro.id = r.room_id
      CROSS JOIN LATERAL generate_series(r.check_in::date, r.check_out::date - INTERVAL '1 day', INTERVAL '1 day') d
      WHERE b.property_id = $1
        AND r.status IN ('BOOKED', 'CHECKED_IN', 'CHECKED_OUT')
        AND b.booking_status != 'CANCELLED'
        AND d >= $2::date
        AND d < $3::date
      GROUP BY COALESCE(ro.room_type_id, r.booked_room_type_id_snapshot), d::date
    ),
    participating_room_types AS (
      -- Include any room type that has gross capacity > 0, sold stays, blocks, OR is currently active with ledger presence
      SELECT DISTINCT prt.room_type_id
      FROM property_room_types prt
      LEFT JOIN gross_cap gc ON gc.room_type_id = prt.room_type_id
      LEFT JOIN blocks bl ON bl.room_type_id = prt.room_type_id
      LEFT JOIN sold s ON s.room_type_id = prt.room_type_id
      WHERE COALESCE(gc.total_rooms, 0) > 0
         OR COALESCE(s.sold_count, 0) > 0
         OR (COALESCE(bl.ooo_count, 0) + COALESCE(bl.oos_count, 0)) > 0
         OR (prt.is_active_current = TRUE AND gc.total_rooms IS NOT NULL)
    ),
    grid AS (
      SELECT
        prt.room_type_id,
        prt.room_type_name,
        prt.room_type_code,
        prt.display_order,
        prt.is_active_current,
        d.hotel_date
      FROM property_room_types prt
      JOIN participating_room_types part ON part.room_type_id = prt.room_type_id
      CROSS JOIN dates d
    )
    SELECT
      g.room_type_id,
      g.room_type_name,
      g.room_type_code,
      g.display_order,
      g.is_active_current,
      to_char(g.hotel_date, 'YYYY-MM-DD') AS hotel_date,
      COALESCE(gc.total_rooms, 0)::int AS gross_rooms,
      COALESCE(bl.ooo_count, 0)::int AS ooo_rooms,
      COALESCE(bl.oos_count, 0)::int AS oos_rooms,
      COALESCE(s.sold_count, 0)::int AS sold_rooms
    FROM grid g
    LEFT JOIN gross_cap gc ON gc.room_type_id = g.room_type_id AND gc.hotel_date = g.hotel_date
    LEFT JOIN blocks bl ON bl.room_type_id = g.room_type_id AND bl.hotel_date = g.hotel_date
    LEFT JOIN sold s ON s.room_type_id = g.room_type_id AND s.hotel_date = g.hotel_date
    ORDER BY g.hotel_date ASC, g.display_order ASC, g.room_type_id ASC;
  `;

  const dbRes = await pool.query(query, [propertyId, startDate, endDate]);
  const rows = dbRes.rows;

  // Aggregate structures
  const dailyMap = new Map<string, { gross: number; ooo: number; oos: number; sold: number }>();
  for (const d of hotelDates) {
    dailyMap.set(d, { gross: 0, ooo: 0, oos: 0, sold: 0 });
  }

  const roomTypeMap = new Map<
    number,
    {
      room_type_id: number;
      room_type_code: string;
      room_type_name: string;
      is_active_current: boolean;
      display_order: number;
      gross: number;
      ooo: number;
      oos: number;
      sold: number;
      dailyMap: Map<string, { gross: number; ooo: number; oos: number; sold: number }>;
    }
  >();

  let totalGross = 0;
  let totalOoo = 0;
  let totalOos = 0;
  let totalSold = 0;

  for (const row of rows) {
    const rtId = Number(row.room_type_id);
    const dateStr = String(row.hotel_date);
    const rawGross = Math.max(0, Number(row.gross_rooms));
    const rawOoo = Math.max(0, Number(row.ooo_rooms));
    const rawOos = Math.max(0, Number(row.oos_rooms));
    const rawSold = Math.max(0, Number(row.sold_rooms));

    // Reconcile historical cell bounds (e.g. same-day turnover or released block on check-in day)
    // so cell invariants 0 <= blocked <= gross and 0 <= sold <= sellable hold without throwing 500
    const gross = rawGross;
    const ooo = Math.min(rawOoo, gross);
    const oos = Math.min(rawOos, Math.max(0, gross - ooo));
    const sellableCell = Math.max(0, gross - (ooo + oos));
    const sold = Math.min(rawSold, sellableCell);

    // Validate cell-level invariants
    computeOccupancyMetrics(gross, ooo, oos, sold, `room_type ${rtId} on ${dateStr}`);

    // Update overall totals
    totalGross += gross;
    totalOoo += ooo;
    totalOos += oos;
    totalSold += sold;

    // Update daily totals
    const dayEntry = dailyMap.get(dateStr);
    if (dayEntry) {
      dayEntry.gross += gross;
      dayEntry.ooo += ooo;
      dayEntry.oos += oos;
      dayEntry.sold += sold;
    }

    // Update room type structures
    let rtEntry = roomTypeMap.get(rtId);
    if (!rtEntry) {
      rtEntry = {
        room_type_id: rtId,
        room_type_code: row.room_type_code,
        room_type_name: row.room_type_name,
        is_active_current: Boolean(row.is_active_current),
        display_order: Number(row.display_order || 0),
        gross: 0,
        ooo: 0,
        oos: 0,
        sold: 0,
        dailyMap: new Map()
      };
      for (const d of hotelDates) {
        rtEntry.dailyMap.set(d, { gross: 0, ooo: 0, oos: 0, sold: 0 });
      }
      roomTypeMap.set(rtId, rtEntry);
    }

    rtEntry.gross += gross;
    rtEntry.ooo += ooo;
    rtEntry.oos += oos;
    rtEntry.sold += sold;

    const rtDayEntry = rtEntry.dailyMap.get(dateStr);
    if (rtDayEntry) {
      rtDayEntry.gross += gross;
      rtDayEntry.ooo += ooo;
      rtDayEntry.oos += oos;
      rtDayEntry.sold += sold;
    }
  }

  // 3. Compile Range Totals
  const totals = computeOccupancyMetrics(
    totalGross,
    totalOoo,
    totalOos,
    totalSold,
    `property ${propertyId} [${startDate}, ${endDate}) range totals`
  );

  // 3. Compute Financial Metrics (ADR, RevPAR, ALOS, revenue) — strictly [startDate, endDate) half-open stay nights
  const isComplimentarySql = `
    (
      (
        COALESCE(r.total_price, 0) = 0
        AND COALESCE(r.amount_paid, 0) = 0
        AND NOT EXISTS (
          SELECT 1
          FROM transactions t
          WHERE t.property_id = b.property_id
            AND t.reservation_id = r.id
            AND t.transaction_type = 'SALE'
            AND t.deleted_at IS NULL
            AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
            AND COALESCE(t.net_amount, 0) > 0
        )
      )
      OR COALESCE(r.discount_percent, 0) >= 100
      OR UPPER(COALESCE(r.payment_status, '')) LIKE '%COMP%'
      OR UPPER(COALESCE(r.payment_status, '')) LIKE '%FREE%'
      OR UPPER(COALESCE(r.payment_status, '')) LIKE '%VOUCHER%'
      OR UPPER(COALESCE(r.special_requests, '')) LIKE '%COMPLIMENT%'
      OR UPPER(COALESCE(r.special_requests, '')) LIKE '%HOUSE USE%'
      OR EXISTS (
        SELECT 1
        FROM reservation_complimentary_requests rcr
        WHERE rcr.reservation_id = r.id
          AND rcr.property_id = b.property_id
          AND rcr.status = 'APPROVED'
      )
    )
  `;

  const financialQuery = `
    SELECT
      COALESCE(SUM(
        CASE
          WHEN NOT ${isComplimentarySql} AND COALESCE(r.total_price, 0) > 0 THEN
            r.total_price * GREATEST(0, (LEAST(r.check_out::date, $3::date) - GREATEST(r.check_in::date, $2::date)))::numeric / GREATEST(1, (r.check_out::date - r.check_in::date))::numeric
          ELSE 0
        END
      ), 0)::numeric(14,2) AS room_revenue,
      COALESCE(COUNT(*) FILTER (WHERE NOT ${isComplimentarySql} AND COALESCE(r.total_price, 0) > 0), 0)::int AS paid_reservation_count,
      COALESCE(SUM(
        GREATEST(0, (LEAST(r.check_out::date, $3::date) - GREATEST(r.check_in::date, $2::date)))
      ) FILTER (
        WHERE NOT ${isComplimentarySql}
      ), 0)::int AS paid_room_nights,
      COALESCE(SUM(
        GREATEST(0, (LEAST(r.check_out::date, $3::date) - GREATEST(r.check_in::date, $2::date)))
      ) FILTER (
        WHERE ${isComplimentarySql}
      ), 0)::int AS complimentary_room_nights,
      COALESCE(AVG(
        GREATEST(1, (r.check_out::date - r.check_in::date))
      ) FILTER (WHERE r.status IN ('BOOKED', 'CHECKED_IN', 'CHECKED_OUT')), 0)::numeric(6,2) AS avg_stay_nights
    FROM reservations r
    JOIN bookings b ON b.id = r.booking_id
    WHERE b.property_id = $1
      AND r.status IN ('BOOKED', 'CHECKED_IN', 'CHECKED_OUT')
      AND COALESCE(b.booking_status, '') != 'CANCELLED'
      AND r.check_in::date < $3::date
      AND r.check_out::date > $2::date
  `;
  const financialRes = await pool.query(financialQuery, [propertyId, startDate, endDate]);
  const finRow = financialRes.rows[0] || {};

  const roomRevenue = Number(finRow.room_revenue || 0);
  const paidRoomNights = Number(finRow.paid_room_nights || 0);
  const complimentaryRoomNights = Number(finRow.complimentary_room_nights || 0);
  const paidReservationCount = Number(finRow.paid_reservation_count || 0);
  const avgStayNights = Number(finRow.avg_stay_nights || 0);

  // Room revenue by room type (period-clipped [startDate, endDate))
  const revenueByTypeQuery = `
    SELECT
      COALESCE(rt.name, r.booked_room_type_name_snapshot, rm.name, 'Unknown') AS room_type_name,
      COALESCE(SUM(
        CASE
          WHEN NOT ${isComplimentarySql} AND COALESCE(r.total_price, 0) > 0 THEN
            r.total_price * GREATEST(0, (LEAST(r.check_out::date, $3::date) - GREATEST(r.check_in::date, $2::date)))::numeric / GREATEST(1, (r.check_out::date - r.check_in::date))::numeric
          ELSE 0
        END
      ), 0)::numeric(14,2) AS revenue
    FROM reservations r
    JOIN bookings b ON b.id = r.booking_id
    LEFT JOIN rooms rm ON rm.id = r.room_id
    LEFT JOIN room_types rt ON rt.id = COALESCE(rm.room_type_id, r.booked_room_type_id_snapshot)
    WHERE b.property_id = $1
      AND r.status IN ('BOOKED', 'CHECKED_IN', 'CHECKED_OUT')
      AND COALESCE(b.booking_status, '') != 'CANCELLED'
      AND r.check_in::date < $3::date
      AND r.check_out::date > $2::date
    GROUP BY COALESCE(rt.name, r.booked_room_type_name_snapshot, rm.name, 'Unknown')
    ORDER BY revenue DESC
  `;
  const revenueByTypeRes = await pool.query(revenueByTypeQuery, [propertyId, startDate, endDate]);
  const roomRevenueByType: Record<string, number> = {};
  for (const row of revenueByTypeRes.rows) {
    roomRevenueByType[row.room_type_name] = Number(row.revenue || 0);
  }

  const sellableRoomNights = totals.sellable_room_nights;
  const adr = paidRoomNights > 0 ? Number((roomRevenue / paidRoomNights).toFixed(2)) : 0;
  const revpar = sellableRoomNights > 0 ? Number((roomRevenue / sellableRoomNights).toFixed(2)) : 0;
  const alos = paidReservationCount > 0 ? Number((avgStayNights).toFixed(2)) : 0;

  const financials: FinancialMetrics = {
    room_revenue: roomRevenue,
    paid_room_nights: paidRoomNights,
    complimentary_room_nights: complimentaryRoomNights,
    adr,
    revpar,
    alos,
    room_revenue_by_type: roomRevenueByType
  };

  // 4. Compile Daily Property Array
  const daily: DailyOccupancyItem[] = [];
  for (const d of hotelDates) {
    const dayData = dailyMap.get(d) || { gross: 0, ooo: 0, oos: 0, sold: 0 };
    const dayMetrics = computeOccupancyMetrics(
      dayData.gross,
      dayData.ooo,
      dayData.oos,
      dayData.sold,
      `property ${propertyId} on ${d}`
    );
    daily.push({
      date: d,
      ...dayMetrics
    });
  }

  // 5. Compile Room Types Breakdown
  const includeRoomTypes = options.include_room_types !== false;
  let roomTypesResult: RoomTypeOccupancyItem[] | undefined = undefined;

  if (includeRoomTypes) {
    roomTypesResult = [];
    const sortedRtEntries = Array.from(roomTypeMap.values()).sort(
      (a, b) => a.display_order - b.display_order || a.room_type_id - b.room_type_id
    );

    for (const rt of sortedRtEntries) {
      const rtMetrics = computeOccupancyMetrics(
        rt.gross,
        rt.ooo,
        rt.oos,
        rt.sold,
        `room type ${rt.room_type_id} (${rt.room_type_name}) total`
      );

      const rtDailyList: DailyOccupancyItem[] = [];
      for (const d of hotelDates) {
        const rtDayData = rt.dailyMap.get(d) || { gross: 0, ooo: 0, oos: 0, sold: 0 };
        const rtDayMetrics = computeOccupancyMetrics(
          rtDayData.gross,
          rtDayData.ooo,
          rtDayData.oos,
          rtDayData.sold,
          `room type ${rt.room_type_id} on ${d}`
        );
        rtDailyList.push({
          date: d,
          ...rtDayMetrics
        });
      }

      roomTypesResult.push({
        room_type_id: rt.room_type_id,
        room_type_code: rt.room_type_code,
        room_type_name: rt.room_type_name,
        is_active_current: rt.is_active_current,
        ...rtMetrics,
        ...(options.include_daily !== false ? { daily: rtDailyList } : {})
      });
    }
  }

  // 6. Query OO / OOS Operational Blocks History (including > 1 day OO blocks)
  const ooBlocksRes = await pool.query(
    `SELECT
       b.id,
       b.room_id,
       b.room_type_id,
       b.block_type,
       to_char(b.start_date, 'YYYY-MM-DD') AS start_date,
       to_char(b.end_date, 'YYYY-MM-DD') AS end_date,
       GREATEST(0, (b.end_date - b.start_date))::int AS duration_days,
       GREATEST(0, (b.end_date - b.start_date))::int AS total_days,
       ((b.end_date - b.start_date) > 1) AS is_multi_day,
       GREATEST(0, (LEAST(b.end_date, $3::date) - GREATEST(b.start_date, $2::date)))::int AS period_nights,
       b.reason,
       b.status,
       b.created_by,
       b.created_at,
       b.released_by,
       b.released_at,
       r.room_number,
       COALESCE(rt.name, 'Standard Room') AS room_type_name,
       rt.code AS room_type_code
     FROM room_operational_blocks b
     JOIN rooms r ON r.id = b.room_id
     LEFT JOIN room_types rt ON rt.id = b.room_type_id
     WHERE b.property_id = $1
       AND b.status IN ('ACTIVE', 'RELEASED')
       AND (
         (b.start_date < $3::date AND b.end_date > $2::date)
         OR (b.end_date - b.start_date) > 1
       )
     ORDER BY
       CASE WHEN b.status = 'ACTIVE' THEN 0 ELSE 1 END ASC,
       CASE WHEN (b.end_date - b.start_date) > 1 THEN 0 ELSE 1 END ASC,
       b.start_date DESC,
       b.id DESC`,
    [propertyId, startDate, endDate]
  );

  return {
    property_id: propertyId,
    start_date: startDate,
    end_date: endDate,
    nights: nightsCount,
    totals,
    financials,
    daily,
    ...(roomTypesResult !== undefined ? { room_types: roomTypesResult } : {}),
    oo_blocks_history: ooBlocksRes.rows
  };
}
