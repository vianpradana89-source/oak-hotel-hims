import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { hotelDateFromInstant, normalizeHotelDate } from '../../utils/hotelDate';
import { getDailyKpiDrilldown, getDailyKpiHistory, getDailyKpis } from './dailyKpiService';
import { calculateOccupancy } from './occupancyService';
import { calculateFinancials } from './financialsService';
import { getTransactions } from '../transactions/transactionService';

function parsePositiveInt(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
}

export function createReportsRouter(pool: Pool): Router {
  const router = Router();

  router.use((_req: Request, res: Response, next) => {
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    next();
  });

  /**
   * GET /api/reports/daily-operations
   * Query params:
   *   - property_id (required, positive integer)
   *   - date (optional, YYYY-MM-DD, defaults to hotel today in Asia/Jakarta)
   */
  router.get('/daily-operations', async (req: Request, res: Response) => {
    const rawPropId = req.query.property_id;
    const propertyId = parsePositiveInt(rawPropId);
    if (propertyId === null) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'property_id is required and must be a positive integer'
      });
    }

    // Assert property exists
    try {
      const propCheck = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
      if ((propCheck.rowCount ?? 0) === 0) {
        return res.status(404).json({
          status: 'ERROR',
          code: 'PROPERTY_NOT_FOUND',
          message: `property ${propertyId} not found`
        });
      }

      // Determine date (default: Asia/Jakarta hotel today)
      let targetDate: string | null;
      if (req.query.date) {
        targetDate = normalizeHotelDate(req.query.date);
        if (!targetDate) {
          return res.status(400).json({
            status: 'ERROR',
            code: 'VALIDATION_ERROR',
            message: 'invalid hotel date format, expected YYYY-MM-DD'
          });
        }
      } else {
        targetDate = hotelDateFromInstant(new Date(), 'Asia/Jakarta');
      }

      // 1. Lifecycle counters
      const lifecycleRes = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE r.check_in::date = $2::date AND r.status != 'CANCELLED')::int AS arrivals_today,
          COUNT(*) FILTER (WHERE r.check_out::date = $2::date AND r.status != 'CANCELLED')::int AS departures_today,
          COUNT(*) FILTER (WHERE r.status = 'CHECKED_IN')::int AS in_house,
          COUNT(*) FILTER (WHERE r.status = 'BOOKED' AND r.check_in::date >= $2::date)::int AS booked_future_or_today
        FROM reservations r
        JOIN bookings b ON b.id = r.booking_id
        WHERE b.property_id = $1
      `, [propertyId, targetDate]);

      const lifecycle = lifecycleRes.rows[0] || {
        arrivals_today: 0,
        departures_today: 0,
        in_house: 0,
        booked_future_or_today: 0
      };

      // 2. Room live status pulse (active rooms owned by property)
      const roomsRes = await pool.query(`
        SELECT
          COUNT(*)::int AS total_active_rooms,
          COUNT(*) FILTER (WHERE status = 'VACANT_CLEAN')::int AS vacant_ready,
          COUNT(*) FILTER (WHERE status = 'VACANT_DIRTY')::int AS vacant_dirty,
          COUNT(*) FILTER (WHERE status = 'CLEANING')::int AS cleaning,
          COUNT(*) FILTER (WHERE status = 'INSPECTED')::int AS waiting_inspection,
          COUNT(*) FILTER (WHERE status IN ('OCCUPIED_CLEAN', 'OCCUPIED_DIRTY'))::int AS occupied,
          COUNT(*) FILTER (WHERE status = 'OUT_OF_ORDER')::int AS out_of_order,
          COUNT(*) FILTER (WHERE status = 'OUT_OF_SERVICE')::int AS out_of_service,
          COUNT(*) FILTER (WHERE status IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE'))::int AS out_of_order_or_service
        FROM rooms
        WHERE property_id = $1 AND COALESCE(is_active, TRUE) = TRUE
      `, [propertyId]);

      const rooms = roomsRes.rows[0] || {
        total_active_rooms: 0,
        vacant_ready: 0,
        vacant_dirty: 0,
        cleaning: 0,
        waiting_inspection: 0,
        occupied: 0,
        out_of_order: 0,
        out_of_service: 0,
        out_of_order_or_service: 0
      };

      // 3. Financial pulse
      // Cash collected on target date (explicit UTC -> Asia/Jakarta timezone projection)
      const cashRes = await pool.query(`
        SELECT COALESCE(SUM(pt.amount), 0)::numeric(12,2) AS cash_collected_today
        FROM payment_transactions pt
        JOIN reservations r ON r.id = pt.reservation_id
        JOIN bookings b ON b.id = r.booking_id
        WHERE b.property_id = $1
          AND pt.status = 'SUCCESS'
          AND ((pt.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta')::date = $2::date
      `, [propertyId, targetDate]);

      // Outstanding balance across active non-cancelled reservations (current live snapshot)
      const balanceRes = await pool.query(`
        SELECT COALESCE(SUM(COALESCE(r.remaining_balance, GREATEST(0, r.total_price - COALESCE(r.amount_paid, 0)))), 0)::numeric(12,2) AS outstanding_guest_balance
        FROM reservations r
        JOIN bookings b ON b.id = r.booking_id
        WHERE b.property_id = $1
          AND UPPER(COALESCE(r.status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
          AND UPPER(COALESCE(r.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
          AND UPPER(COALESCE(b.booking_status, '')) != 'CANCELLED'
          AND UPPER(COALESCE(r.payment_status, '')) NOT IN ('PAID', 'LUNAS', 'COMPLIMENTARY', 'FREE', 'VOUCHER')
          AND COALESCE(r.discount_percent, 0) < 100
          AND NOT EXISTS (
            SELECT 1 FROM reservation_complimentary_requests rcr
            WHERE rcr.reservation_id = r.id
              AND rcr.property_id = b.property_id
              AND rcr.status = 'APPROVED'
          )
      `, [propertyId]);

      const arrivalsToday = Number(lifecycle.arrivals_today || 0);
      const departuresToday = Number(lifecycle.departures_today || 0);
      const inHouseCurrent = Number(lifecycle.in_house || 0);
      const bookedFutureOrToday = Number(lifecycle.booked_future_or_today || 0);
      const cashCollectedToday = Number(cashRes.rows[0]?.cash_collected_today || 0);
      const outstandingGuestBalance = Number(balanceRes.rows[0]?.outstanding_guest_balance || 0);

      const roomMetrics = {
        total_active_rooms: Number(rooms.total_active_rooms || 0),
        vacant_ready: Number(rooms.vacant_ready || 0),
        vacant_dirty: Number(rooms.vacant_dirty || 0),
        cleaning: Number(rooms.cleaning || 0),
        waiting_inspection: Number(rooms.waiting_inspection || 0),
        occupied: Number(rooms.occupied || 0),
        out_of_order: Number(rooms.out_of_order || 0),
        out_of_service: Number(rooms.out_of_service || 0),
        out_of_order_or_service: Number(rooms.out_of_order_or_service || 0)
      };

      return res.json({
        status: 'SUCCESS',
        data: {
          property_id: propertyId,
          business_date: targetDate,
          // Explicit business date metrics tied to requested hotel date
          business_date_metrics: {
            date: targetDate,
            arrivals: arrivalsToday,
            departures: departuresToday,
            cash_collected: cashCollectedToday
          },
          // Explicit real-time operational snapshot
          live_snapshot: {
            in_house_current: inHouseCurrent,
            booked_active: bookedFutureOrToday,
            ...roomMetrics,
            outstanding_guest_balance_current: outstandingGuestBalance
          },
          // Backward-compatible fields
          date: targetDate,
          lifecycle: {
            arrivals_today: arrivalsToday,
            departures_today: departuresToday,
            in_house: inHouseCurrent,
            booked_future_or_today: bookedFutureOrToday
          },
          rooms: roomMetrics,
          financials: {
            cash_collected_today: cashCollectedToday,
            outstanding_guest_balance: outstandingGuestBalance
          }
        }
      });
    } catch (err: any) {
      console.error('Error in /api/reports/daily-operations:', err);
      return res.status(500).json({
        status: 'ERROR',
        message: err.message || 'Internal server error'
      });
    }
  });

  /**
   * GET /api/reports/daily-kpis/drilldown
   * Query params:
   *   - property_id (required, positive integer)
   *   - type (required): occupancy | booked | checkin | checkout | dirty | vacant_clean | checkout_check | maintenance
   *   - date (optional, YYYY-MM-DD, defaults to hotel today in property timezone)
   */
  router.get('/daily-kpis/drilldown', async (req: Request, res: Response) => {
    const propertyId = parsePositiveInt(req.query.property_id);
    if (propertyId === null) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'property_id is required and must be a positive integer'
      });
    }

    try {
      const data = await getDailyKpiDrilldown(
        pool,
        propertyId,
        req.query.type,
        req.query.date as string | undefined
      );
      return res.json({
        status: 'SUCCESS',
        data
      });
    } catch (err: any) {
      if (err.statusCode && err.code) {
        return res.status(err.statusCode).json({
          status: 'ERROR',
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {})
        });
      }
      console.error('Error in /api/reports/daily-kpis/drilldown:', err);
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error'
      });
    }
  });

  /**
   * GET /api/reports/daily-kpis
   * Query params:
   *   - property_id (required, positive integer)
   *   - date (optional, YYYY-MM-DD, defaults to hotel today in property timezone)
   */
  router.get('/daily-kpis', async (req: Request, res: Response) => {
    const propertyId = parsePositiveInt(req.query.property_id);
    if (propertyId === null) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'property_id is required and must be a positive integer'
      });
    }

    try {
      const data = await getDailyKpis(pool, propertyId, req.query.date as string | undefined);
      return res.json({
        status: 'SUCCESS',
        data
      });
    } catch (err: any) {
      if (err.statusCode && err.code) {
        return res.status(err.statusCode).json({
          status: 'ERROR',
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {})
        });
      }
      console.error('Error in /api/reports/daily-kpis:', err);
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error'
      });
    }
  });

  /**
   * GET /api/reports/daily-kpis/history
   * Query params:
   *   - property_id (required, positive integer)
   *   - date (optional, YYYY-MM-DD, defaults to hotel today in property timezone)
   *   - days (optional, integer 1-90)
   */
  router.get('/daily-kpis/history', async (req: Request, res: Response) => {
    const propertyId = parsePositiveInt(req.query.property_id);
    if (propertyId === null) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'property_id is required and must be a positive integer'
      });
    }
    const days = parsePositiveInt(req.query.days);
    // days must be explicitly provided and between 1-90; reject null/missing
    if (days === null) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: 'days is required and must be an integer between 1 and 90'
      });
    }
    const daysCount = days;

    try {
      const data = await getDailyKpiHistory(pool, propertyId, daysCount, req.query.date as string | undefined);
      return res.json({
        status: 'SUCCESS',
        data
      });
    } catch (err: any) {
      if (err.statusCode && err.code) {
        return res.status(err.statusCode).json({
          status: 'ERROR',
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {})
        });
      }
      console.error('Error in /api/reports/daily-kpis/history:', err);
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error'
      });
    }
  });

  /**
   * GET /api/reports/occupancy
   * Query params:
   *   - property_id (required, positive integer)
   *   - start_date (optional, YYYY-MM-DD)
   *   - end_date (optional, YYYY-MM-DD)
   *   - date (optional, YYYY-MM-DD)
   *   - include_room_types (optional boolean, default true)
   *   - include_daily (optional boolean, default true)
   */
  router.get('/occupancy', async (req: Request, res: Response) => {
    try {
      const rawPropId = req.query.property_id;
      const propertyId = parsePositiveInt(rawPropId);
      if (propertyId === null) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id is required and must be a positive integer'
        });
      }

      const includeRoomTypes = req.query.include_room_types !== 'false';
      const includeDaily = req.query.include_daily !== 'false';

      const result = await calculateOccupancy(pool, {
        property_id: propertyId,
        start_date: req.query.start_date as string | undefined,
        end_date: req.query.end_date as string | undefined,
        date: req.query.date as string | undefined,
        include_room_types: includeRoomTypes,
        include_daily: includeDaily
      });

      return res.json({
        status: 'SUCCESS',
        data: result
      });
    } catch (err: any) {
      if (err.statusCode && err.code) {
        return res.status(err.statusCode).json({
          status: 'ERROR',
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {})
        });
      }
      console.error('Error in /api/reports/occupancy:', err);
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error'
      });
    }
  });

  /**
   * GET /api/reports/financials
   * Comprehensive financial aggregation for the 7-tab Laporan workspace:
   *   - income (SALE + INCOME) totals, by category, by payment method
   *   - expense totals, by category, by department
   *   - purchase totals, by payment status, by department
   *   - cross-type payment method summary
   *
   * Query params:
   *   - property_id (required, positive integer)
   *   - start_date (optional, YYYY-MM-DD, defaults to 30 days ago)
   *   - end_date (optional, YYYY-MM-DD, defaults to today)
   *   - date (optional, YYYY-MM-DD, single-day query)
   */
  router.get('/financials', async (req: Request, res: Response) => {
    try {
      const rawPropId = req.query.property_id;
      const propertyId = parsePositiveInt(rawPropId);
      if (propertyId === null) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id is required and must be a positive integer'
        });
      }

      const result = await calculateFinancials(pool, {
        property_id: propertyId,
        start_date: req.query.start_date as string | undefined,
        end_date: req.query.end_date as string | undefined,
        date: req.query.date as string | undefined
      });

      return res.json({
        status: 'SUCCESS',
        data: result
      });
    } catch (err: any) {
      if (err.statusCode && err.code) {
        return res.status(err.statusCode).json({
          status: 'ERROR',
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {})
        });
      }
      console.error('Error in /api/reports/financials:', err);
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error'
      });
    }
  });

  /**
   * GET /api/reports/analytics-hub
   * Comprehensive analytics for the 7-tab Laporan workspace:
   *   - per-room occupancy & revenue ranking
   *   - POS item sales with HPP (average_cost / last_cost) & profit
   *   - purchase line items with supplier & payment status
   *   - complimentary stays & POS complimentary items
   */
  router.get('/analytics-hub', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePositiveInt(req.query.property_id);
      if (propertyId === null) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id is required and must be a positive integer'
        });
      }

      const todayStr = hotelDateFromInstant(new Date(), 'Asia/Jakarta');
      const startDate = normalizeHotelDate(req.query.start_date) || todayStr;
      const endDate = normalizeHotelDate(req.query.end_date) || startDate;

      const isCompReservationSql = `
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

      // 1. Per-Room Occupancy & Revenue Ranking in [startDate, endDate] inclusive
      const roomsRankingRes = await pool.query(
        `
        WITH active_rooms AS (
          SELECT
            rm.id AS room_id,
            rm.room_number,
            rm.status AS room_status,
            COALESCE(rt.name, rm.name, 'Standard') AS room_type_name,
            COALESCE(rt.code, '') AS room_type_code
          FROM rooms rm
          LEFT JOIN room_types rt ON rt.id = rm.room_type_id AND rt.property_id = rm.property_id
          WHERE rm.property_id = $1
            AND COALESCE(rm.is_active, TRUE) = TRUE
        ),
        room_stays AS (
          SELECT
            r.room_id,
            r.id AS reservation_id,
            b.bid,
            r.guest_name,
            r.check_in::date AS check_in_date,
            r.check_out::date AS check_out_date,
            GREATEST(1, (r.check_out::date - r.check_in::date))::int AS total_stay_nights,
            GREATEST(
              0,
              (LEAST(r.check_out::date, ($3::date + INTERVAL '1 day')::date) - GREATEST(r.check_in::date, $2::date))
            )::int AS period_nights,
            COALESCE(
              NULLIF(r.total_price, 0),
              (
                SELECT COALESCE(SUM(t.net_amount), 0)
                FROM transactions t
                WHERE t.property_id = b.property_id
                  AND t.reservation_id = r.id
                  AND t.transaction_type = 'SALE'
                  AND t.deleted_at IS NULL
                  AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
              ),
              0
            )::numeric AS total_price,
            COALESCE(r.amount_paid, 0)::numeric AS amount_paid,
            ${isCompReservationSql} AS is_comp
          FROM reservations r
          JOIN bookings b ON b.id = r.booking_id
          WHERE b.property_id = $1
            AND r.status IN ('BOOKED', 'CHECKED_IN', 'CHECKED_OUT')
            AND UPPER(COALESCE(r.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
            AND COALESCE(b.booking_status, '') != 'CANCELLED'
            AND r.check_in::date <= $3::date
            AND GREATEST(r.check_out::date, (r.check_in::date + INTERVAL '1 day')::date) > $2::date
        )
        SELECT
          ar.room_id,
          ar.room_number,
          ar.room_type_name,
          ar.room_type_code,
          ar.room_status,
          COUNT(DISTINCT rs.reservation_id)::int AS booking_count,
          COALESCE(SUM(rs.period_nights), 0)::int AS occupied_nights,
          COALESCE(
            SUM(
              CASE
                WHEN rs.is_comp THEN 0
                WHEN rs.total_stay_nights > 0 THEN (rs.total_price * rs.period_nights::numeric / rs.total_stay_nights::numeric)
                ELSE rs.total_price
              END
            ),
            0
          )::numeric(14,2) AS room_revenue,
          COUNT(DISTINCT rs.reservation_id) FILTER (WHERE rs.is_comp)::int AS complimentary_booking_count,
          COALESCE(SUM(rs.period_nights) FILTER (WHERE rs.is_comp), 0)::int AS complimentary_nights
        FROM active_rooms ar
        LEFT JOIN room_stays rs ON rs.room_id = ar.room_id
        GROUP BY ar.room_id, ar.room_number, ar.room_type_name, ar.room_type_code, ar.room_status
        ORDER BY room_revenue DESC, booking_count DESC, ar.room_number ASC
        `,
        [propertyId, startDate, endDate]
      );

      // 2. Complimentary Reservations & Stays Summary in [startDate, endDate]
      const compStaysRes = await pool.query(
        `
        SELECT
          r.id AS reservation_id,
          COALESCE(b.bid, r.booking_number, 'RES-' || r.id::text) AS booking_code,
          COALESCE(NULLIF(BTRIM(r.guest_name), ''), NULLIF(BTRIM(b.guest_name_snapshot), ''), 'Tamu Hotel') AS guest_name,
          COALESCE(rm.room_number, '-') AS room_number,
          COALESCE(rt.name, r.booked_room_type_name_snapshot, rm.name, 'Kamar') AS room_type_name,
          to_char(r.check_in::date, 'YYYY-MM-DD') AS check_in,
          to_char(r.check_out::date, 'YYYY-MM-DD') AS check_out,
          GREATEST(
            1,
            (LEAST(GREATEST(r.check_out::date, (r.check_in::date + INTERVAL '1 day')::date), ($3::date + INTERVAL '1 day')::date) - GREATEST(r.check_in::date, $2::date))
          )::int AS nights,
          GREATEST(1, (r.check_out::date - r.check_in::date))::int AS total_stay_nights,
          COALESCE(r.total_price, 0)::numeric(14,2) AS total_price,
          COALESCE(rt.base_rate, 0)::numeric(14,2) AS reference_rate,
          ROUND(
            COALESCE(
              NULLIF(rcr.applied_adjustment_amount, 0),
              NULLIF(rcr.original_gross_amount, 0),
              (GREATEST(1, (r.check_out::date - r.check_in::date)) * COALESCE(rt.base_rate, 0))
            )
            * GREATEST(
                1,
                (LEAST(GREATEST(r.check_out::date, (r.check_in::date + INTERVAL '1 day')::date), ($3::date + INTERVAL '1 day')::date) - GREATEST(r.check_in::date, $2::date))
              )::numeric
            / GREATEST(1, (r.check_out::date - r.check_in::date))::numeric,
            2
          )::numeric(14,2) AS estimated_comp_value,
          COALESCE(rcr.category, NULLIF(BTRIM(r.payment_status), ''), 'COMPLIMENTARY') AS payment_method,
          r.status,
          COALESCE(NULLIF(BTRIM(rcr.reason), ''), NULLIF(BTRIM(r.discount_reason), ''), NULLIF(BTRIM(r.special_requests), ''), '') AS notes
        FROM reservations r
        JOIN bookings b ON b.id = r.booking_id
        LEFT JOIN rooms rm ON rm.id = r.room_id AND rm.property_id = b.property_id
        LEFT JOIN room_types rt ON rt.id = COALESCE(rm.room_type_id, r.booked_room_type_id_snapshot) AND rt.property_id = b.property_id
        LEFT JOIN reservation_complimentary_requests rcr
          ON rcr.reservation_id = r.id
         AND rcr.property_id = b.property_id
         AND rcr.status = 'APPROVED'
        WHERE b.property_id = $1
          AND r.status IN ('BOOKED', 'CHECKED_IN', 'CHECKED_OUT')
          AND UPPER(COALESCE(r.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
          AND COALESCE(b.booking_status, '') != 'CANCELLED'
          AND r.check_in::date <= $3::date
          AND GREATEST(r.check_out::date, (r.check_in::date + INTERVAL '1 day')::date) > $2::date
          AND ${isCompReservationSql}
        ORDER BY r.check_in DESC, r.id DESC
        `,
        [propertyId, startDate, endDate]
      );

      // 3. Sales Item Breakdown (POS Order Items + Standalone POS/Product Transactions + HPP)
      const posItemsRes = await pool.query(
        `
        SELECT * FROM (
          SELECT
            poi.id AS order_item_id,
            po.id AS order_id,
            COALESCE(t.transaction_no, po.order_number, 'POS-' || LPAD(po.id::text, 6, '0')) AS booking_or_order_no,
            to_char(COALESCE(t.transaction_date, ((po.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta')::date), 'YYYY-MM-DD') AS tx_date,
            to_char(COALESCE(t.created_at, (po.created_at AT TIME ZONE 'UTC')) AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') AS tx_datetime,
            COALESCE(NULLIF(BTRIM(po.guest_name), ''), NULLIF(BTRIM(t.guest_name_snapshot), ''), NULLIF(BTRIM(t.party_name), ''), 'Walk-In POS') AS customer_name,
            COALESCE(rm.room_number, t.room_number_snapshot, po.table_number, '-') AS room_or_table,
            COALESCE(NULLIF(BTRIM(pmi.name), ''), 'Item POS') AS item_name,
            COALESCE(NULLIF(BTRIM(pmi.item_code), ''), '') AS item_code,
            COALESCE(pmc.name, 'F&B / POS') AS category_name,
            COALESCE(poi.quantity, 1)::numeric(12,3) AS quantity,
            COALESCE(poi.unit_price, 0)::numeric(14,2) AS unit_price,
            0::numeric(14,2) AS discount_amount,
            (COALESCE(poi.quantity, 1) * COALESCE(poi.unit_price, 0))::numeric(14,2) AS line_total,
            (
              COALESCE(poi.quantity, 1) * COALESCE(
                NULLIF(pmi.average_cost, 0),
                NULLIF(pmi.last_cost, 0),
                0
              )
            )::numeric(14,2) AS total_hpp,
            COALESCE(NULLIF(pmi.average_cost, 0), NULLIF(pmi.last_cost, 0), 0)::numeric(14,2) AS unit_hpp,
            COALESCE(
              NULLIF(BTRIM(t.payment_method), ''),
              (
                SELECT NULLIF(BTRIM(pt.payment_method), '')
                FROM payment_transactions pt
                WHERE pt.transaction_id = t.id
                  AND pt.status = 'SUCCESS'
                ORDER BY pt.id DESC
                LIMIT 1
              ),
              'Cash'
            ) AS payment_method,
            COALESCE(t.payment_status, po.status, 'PAID') AS payment_status,
            t.id AS transaction_id,
            COALESCE(t.tax_amount, 0)::numeric(14,2) AS tax_amount,
            CASE
              WHEN po.reservation_id IS NOT NULL THEN 'Tamu Menginap'
              ELSE 'Walk-In POS'
            END AS guest_segment,
            (
              SELECT ta.id
              FROM transaction_attachments ta
              WHERE ta.property_id = po.property_id
                AND ta.transaction_id = t.id
              ORDER BY CASE WHEN UPPER(COALESCE(ta.attachment_purpose, '')) = 'PAYMENT_PROOF' THEN 0 ELSE 1 END, ta.id DESC
              LIMIT 1
            ) AS attachment_id,
            (
              (COALESCE(poi.quantity, 1) * COALESCE(poi.unit_price, 0)) = 0
              OR UPPER(COALESCE(t.payment_method, '')) LIKE '%COMP%'
              OR UPPER(COALESCE(poi.notes, '')) LIKE '%COMP%'
            ) AS is_complimentary
          FROM pos_order_items poi
          JOIN pos_orders po ON po.id = poi.order_id
          LEFT JOIN pos_menu_items pmi ON pmi.id = poi.menu_item_id AND pmi.property_id = po.property_id
          LEFT JOIN pos_menu_categories pmc ON pmc.id = pmi.category_id AND pmc.property_id = po.property_id
          LEFT JOIN reservations r ON r.id = po.reservation_id
          LEFT JOIN rooms rm ON rm.id = r.room_id AND rm.property_id = po.property_id
          LEFT JOIN transactions t
            ON t.property_id = po.property_id
           AND UPPER(COALESCE(t.source_type, '')) IN ('POS_ORDER', 'POS')
           AND t.source_id = po.id::text
           AND t.deleted_at IS NULL
           AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
          WHERE po.property_id = $1
            AND COALESCE(po.status, 'OPEN') NOT IN ('CANCELLED', 'VOIDED')
            AND (
              po.reservation_id IS NULL
              OR (
                UPPER(COALESCE(r.status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
                AND UPPER(COALESCE(r.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
              )
            )
            AND COALESCE(t.transaction_date, ((po.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta')::date) >= $2::date
            AND COALESCE(t.transaction_date, ((po.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta')::date) <= $3::date

          UNION ALL

          SELECT
            t.id AS order_item_id,
            t.id AS order_id,
            t.transaction_no AS booking_or_order_no,
            to_char(t.transaction_date, 'YYYY-MM-DD') AS tx_date,
            to_char(t.created_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') AS tx_datetime,
            COALESCE(NULLIF(BTRIM(t.guest_name_snapshot), ''), NULLIF(BTRIM(t.party_name), ''), 'Walk-In POS') AS customer_name,
            COALESCE(NULLIF(BTRIM(t.room_number_snapshot), ''), '-') AS room_or_table,
            COALESCE(NULLIF(BTRIM(t.description), ''), COALESCE(t.category_name, 'Penjualan POS')) AS item_name,
            COALESCE(t.category_code, '') AS item_code,
            COALESCE(t.category_name, 'F&B / POS') AS category_name,
            1::numeric(12,3) AS quantity,
            COALESCE(t.amount, t.net_amount, 0)::numeric(14,2) AS unit_price,
            COALESCE(t.discount_amount, 0)::numeric(14,2) AS discount_amount,
            COALESCE(t.net_amount, 0)::numeric(14,2) AS line_total,
            0::numeric(14,2) AS total_hpp,
            0::numeric(14,2) AS unit_hpp,
            COALESCE(
              NULLIF(BTRIM(t.payment_method), ''),
              (
                SELECT NULLIF(BTRIM(pt.payment_method), '')
                FROM payment_transactions pt
                WHERE pt.transaction_id = t.id
                  AND pt.status = 'SUCCESS'
                ORDER BY pt.id DESC
                LIMIT 1
              ),
              'Cash'
            ) AS payment_method,
            COALESCE(t.payment_status, 'PAID') AS payment_status,
            t.id AS transaction_id,
            COALESCE(t.tax_amount, 0)::numeric(14,2) AS tax_amount,
            CASE
              WHEN t.reservation_id IS NOT NULL THEN 'Tamu Menginap'
              ELSE 'Walk-In POS'
            END AS guest_segment,
            (
              SELECT ta.id
              FROM transaction_attachments ta
              WHERE ta.property_id = t.property_id
                AND ta.transaction_id = t.id
              ORDER BY CASE WHEN UPPER(COALESCE(ta.attachment_purpose, '')) = 'PAYMENT_PROOF' THEN 0 ELSE 1 END, ta.id DESC
              LIMIT 1
            ) AS attachment_id,
            (
              COALESCE(t.net_amount, 0) = 0
              OR UPPER(COALESCE(t.payment_method, '')) LIKE '%COMP%'
            ) AS is_complimentary
          FROM transactions t
          WHERE t.property_id = $1
            AND t.transaction_type = 'SALE'
            AND (
              UPPER(COALESCE(t.source_type, '')) IN ('POS', 'POS_ORDER', 'MANUAL_SALE', 'OTHER_SALE')
              OR UPPER(COALESCE(t.category_code, '')) LIKE '%POS%'
              OR UPPER(COALESCE(t.category_code, '')) LIKE '%FNB%'
            )
            AND t.reservation_id IS NULL
            AND t.booking_id IS NULL
            AND t.deleted_at IS NULL
            AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
            AND t.transaction_date >= $2::date
            AND t.transaction_date <= $3::date
            AND NOT EXISTS (
              SELECT 1
              FROM pos_orders po
              WHERE po.property_id = t.property_id
                AND po.id::text = COALESCE(t.source_id, '')
            )
        ) combined_pos
        ORDER BY tx_date DESC, order_id DESC, order_item_id ASC
        `,
        [propertyId, startDate, endDate]
      );

      // 4. Purchase Line Items for Pembelian Report (Transactions PURCHASE + POS Purchase Orders)
      const purchaseLinesRes = await pool.query(
        `
        SELECT * FROM (
          SELECT
            t.id AS transaction_id,
            t.transaction_no,
            to_char(t.transaction_date, 'YYYY-MM-DD') AS transaction_date,
            COALESCE(s.name, NULLIF(BTRIM(t.party_name), ''), '-') AS supplier_name,
            COALESCE(NULLIF(BTRIM(t.source_reference), ''), '-') AS reference_no,
            COALESCE(NULLIF(BTRIM(tl.description_snapshot), ''), NULLIF(BTRIM(t.description), ''), '-') AS item_name,
            COALESCE(pmi.item_code, '') AS item_code,
            COALESCE(tl.quantity, 1)::numeric(12,3) AS quantity,
            COALESCE(tl.unit, pmi.base_unit, 'PCS') AS unit,
            COALESCE(tl.unit_price, t.net_amount, 0)::numeric(14,2) AS unit_price,
            COALESCE(tl.line_total, t.net_amount, 0)::numeric(14,2) AS line_total,
            t.net_amount::numeric(14,2) AS transaction_net_amount,
            COALESCE(NULLIF(BTRIM(t.payment_method), ''), '-') AS payment_method,
            COALESCE(t.payment_status, 'UNPAID') AS payment_status,
            COALESCE(t.purchase_workflow_status, 'PROSES') AS workflow_status,
            COALESCE(t.receiving_status, 'BELUM_DITERIMA') AS receiving_status,
            (
              SELECT COUNT(*)::int
              FROM transaction_attachments ta
              WHERE ta.transaction_id = t.id AND ta.property_id = t.property_id
            ) AS attachment_count,
            COALESCE(tl.sort_order, 0) AS sort_order
          FROM transactions t
          LEFT JOIN suppliers s ON s.id = t.supplier_id
          LEFT JOIN transaction_lines tl ON tl.transaction_id = t.id AND tl.property_id = t.property_id
          LEFT JOIN pos_menu_items pmi ON pmi.id = tl.product_id AND pmi.property_id = t.property_id
          WHERE t.property_id = $1
            AND t.transaction_type = 'PURCHASE'
            AND t.deleted_at IS NULL
            AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
            AND t.transaction_date >= $2::date
            AND t.transaction_date <= $3::date

          UNION ALL

          SELECT
            ppo.id AS transaction_id,
            ppo.po_number AS transaction_no,
            to_char(ppo.order_date, 'YYYY-MM-DD') AS transaction_date,
            COALESCE(ps.name, '-') AS supplier_name,
            ppo.po_number AS reference_no,
            COALESCE(pmi.name, 'Item PO') AS item_name,
            COALESCE(pmi.item_code, '') AS item_code,
            COALESCE(ppoi.ordered_qty, 1)::numeric(12,3) AS quantity,
            COALESCE(u.code, pmi.base_unit, 'PCS') AS unit,
            COALESCE(ppoi.unit_cost, 0)::numeric(14,2) AS unit_price,
            (COALESCE(ppoi.ordered_qty, 1) * COALESCE(ppoi.unit_cost, 0))::numeric(14,2) AS line_total,
            COALESCE(ppo.total_estimated_amount, 0)::numeric(14,2) AS transaction_net_amount,
            '-' AS payment_method,
            CASE WHEN ppo.status = 'COMPLETED' THEN 'PAID' ELSE 'UNPAID' END AS payment_status,
            CASE WHEN ppo.status = 'COMPLETED' THEN 'SELESAI' ELSE 'PROSES' END AS workflow_status,
            ppo.status AS receiving_status,
            0 AS attachment_count,
            ppoi.id AS sort_order
          FROM pos_purchase_orders ppo
          LEFT JOIN pos_suppliers ps ON ps.id = ppo.supplier_id AND ps.property_id = ppo.property_id
          LEFT JOIN pos_purchase_order_items ppoi ON ppoi.po_id = ppo.id
          LEFT JOIN pos_menu_items pmi ON pmi.id = ppoi.product_id AND pmi.property_id = ppo.property_id
          LEFT JOIN pos_product_uoms u ON u.id = ppoi.uom_id
          WHERE ppo.property_id = $1
            AND COALESCE(ppo.status, 'DRAFT') != 'CANCELLED'
            AND ppo.order_date >= $2::date
            AND ppo.order_date <= $3::date
            AND NOT EXISTS (
              SELECT 1
              FROM transactions t
              WHERE t.property_id = ppo.property_id
                AND t.transaction_type = 'PURCHASE'
                AND t.deleted_at IS NULL
                AND t.source_reference = ppo.po_number
            )
        ) combined_purchases
        ORDER BY transaction_date DESC, transaction_id DESC, sort_order ASC
        `,
        [propertyId, startDate, endDate]
      );

      // 5. Daily Occupancy Bar Series
      const dailyOccupancyRes = await pool.query(
        `
        WITH dates AS (
          SELECT d::date AS hotel_date
          FROM generate_series($2::date, $3::date, INTERVAL '1 day') d
        ),
        active_rooms_count AS (
          SELECT COUNT(*)::int AS active_rooms
          FROM rooms
          WHERE property_id = $1 AND COALESCE(is_active, TRUE) = TRUE
        ),
        daily_blocks AS (
          SELECT
            d::date AS hotel_date,
            COUNT(*)::int AS blocked_rooms
          FROM room_operational_blocks b
          CROSS JOIN LATERAL generate_series(b.start_date, b.end_date - INTERVAL '1 day', INTERVAL '1 day') d
          WHERE b.property_id = $1
            AND b.status IN ('ACTIVE', 'RELEASED')
            AND d >= $2::date
            AND d <= $3::date
          GROUP BY d::date
        ),
        daily_sold AS (
          SELECT
            d::date AS hotel_date,
            COUNT(*)::int AS sold_rooms,
            COUNT(*) FILTER (WHERE ${isCompReservationSql})::int AS comp_rooms
          FROM reservations r
          JOIN bookings b ON b.id = r.booking_id
          CROSS JOIN LATERAL generate_series(r.check_in::date, GREATEST(r.check_in::date, (r.check_out::date - INTERVAL '1 day')::date), INTERVAL '1 day') d
          WHERE b.property_id = $1
            AND r.status IN ('BOOKED', 'CHECKED_IN', 'CHECKED_OUT')
            AND COALESCE(b.booking_status, '') != 'CANCELLED'
            AND d >= $2::date
            AND d <= $3::date
          GROUP BY d::date
        )
        SELECT
          to_char(dt.hotel_date, 'YYYY-MM-DD') AS date,
          arc.active_rooms AS gross_rooms,
          GREATEST(0, arc.active_rooms - COALESCE(db.blocked_rooms, 0))::int AS sellable_rooms,
          COALESCE(ds.sold_rooms, 0)::int AS sold_rooms,
          COALESCE(ds.comp_rooms, 0)::int AS complimentary_rooms,
          CASE
            WHEN GREATEST(0, arc.active_rooms - COALESCE(db.blocked_rooms, 0)) > 0 THEN
              ROUND((LEAST(COALESCE(ds.sold_rooms, 0), GREATEST(0, arc.active_rooms - COALESCE(db.blocked_rooms, 0)))::numeric / GREATEST(0, arc.active_rooms - COALESCE(db.blocked_rooms, 0))::numeric) * 100, 1)
            ELSE 0
          END::numeric(5,1) AS occupancy_pct
        FROM dates dt
        CROSS JOIN active_rooms_count arc
        LEFT JOIN daily_blocks db ON db.hotel_date = dt.hotel_date
        LEFT JOIN daily_sold ds ON ds.hotel_date = dt.hotel_date
        ORDER BY dt.hotel_date ASC
        `,
        [propertyId, startDate, endDate]
      );

      // 6. Enriched Room Sales (Opsi 1: Daily / Period-Prorated Room Revenue + Room Rate per Night)
      const roomSalesRes = await pool.query(
        `
        WITH raw_room_sales AS (
          SELECT
            r.id AS reservation_id,
            r.booking_id,
            r.room_id,
            COALESCE(b.bid, r.booking_number, 'RES-' || r.id::text) AS booking_code,
            to_char(r.check_in::date, 'YYYY-MM-DD') AS tx_date,
            to_char(COALESCE(b.created_at, r.check_in) AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') AS tx_datetime,
            to_char(r.check_in::date, 'YYYY-MM-DD') AS check_in,
            to_char(r.check_out::date, 'YYYY-MM-DD') AS check_out,
            GREATEST(1, (r.check_out::date - r.check_in::date))::int AS total_stay_nights,
            GREATEST(
              1,
              (LEAST(GREATEST(r.check_out::date, (r.check_in::date + INTERVAL '1 day')::date), ($3::date + INTERVAL '1 day')::date) - GREATEST(r.check_in::date, $2::date))
            )::int AS period_nights,
            COALESCE(r.stay_type, 'OVERNIGHT') AS stay_type,
            COALESCE(to_char(r.start_at AT TIME ZONE 'Asia/Jakarta', 'HH24:MI'), '14:00') AS start_time,
            COALESCE(to_char(r.end_at AT TIME ZONE 'Asia/Jakarta', 'HH24:MI'), '12:00') AS end_time,
            COALESCE(NULLIF(BTRIM(r.guest_name), ''), NULLIF(BTRIM(b.guest_name_snapshot), ''), 'Tamu Hotel') AS guest_name,
            COALESCE(rm.room_number, '-') AS room_number,
            COALESCE(rt.name, r.booked_room_type_name_snapshot, rm.name, 'Kamar') AS room_type_name,
            COALESCE(
              NULLIF(r.total_price, 0),
              (
                SELECT COALESCE(SUM(t.net_amount), 0)
                FROM transactions t
                WHERE t.property_id = b.property_id
                  AND t.reservation_id = r.id
                  AND t.transaction_type = 'SALE'
                  AND t.deleted_at IS NULL
                  AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
              ),
              0
            )::numeric(14,2) AS full_total_price,
            COALESCE(
              NULLIF(r.discount_amount, 0),
              CASE
                WHEN COALESCE(r.discount_percent, 0) > 0 AND COALESCE(r.discount_percent, 0) < 100
                  THEN ROUND((GREATEST(1, (r.check_out::date - r.check_in::date)) * COALESCE(rt.base_rate, 0)) * (r.discount_percent / 100.0))
                ELSE 0
              END,
              0
            )::numeric(14,2) AS full_discount_amount,
            COALESCE(r.discount_percent, 0)::numeric(5,2) AS discount_percent,
            COALESCE(NULLIF(BTRIM(r.discount_reason), ''), NULLIF(BTRIM(b.global_discount_reason), ''), '') AS discount_reason,
            COALESCE(r.amount_paid, 0)::numeric(14,2) AS full_amount_paid,
            COALESCE(r.remaining_balance, GREATEST(0, COALESCE(r.total_price, 0) - COALESCE(r.amount_paid, 0)))::numeric(14,2) AS full_remaining_balance,
            COALESCE(r.payment_status, 'UNPAID') AS payment_status,
            CASE
              WHEN ${isCompReservationSql} THEN 'Complimentary'
              WHEN UPPER(COALESCE(b.payment_responsibility, '')) = 'OTA_COLLECT' THEN 'OTA COLLECT'
              ELSE COALESCE(
                (
                  SELECT NULLIF(BTRIM(pt.payment_method), '')
                  FROM payment_transactions pt
                  WHERE pt.reservation_id = r.id
                    AND pt.status = 'SUCCESS'
                    AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
                  ORDER BY pt.created_at DESC NULLS LAST, pt.id DESC
                  LIMIT 1
                ),
                (
                  SELECT NULLIF(BTRIM(pt.payment_method), '')
                  FROM payment_allocations pa
                  JOIN payment_transactions pt ON pt.id = pa.payment_transaction_id
                  WHERE pa.booking_id = r.booking_id
                    AND pa.status = 'ACTIVE'
                    AND pt.status = 'SUCCESS'
                  ORDER BY pt.created_at DESC NULLS LAST, pt.id DESC
                  LIMIT 1
                ),
                (
                  SELECT NULLIF(BTRIM(t.payment_method), '')
                  FROM transactions t
                  WHERE t.property_id = b.property_id
                    AND (t.reservation_id = r.id OR t.booking_id = r.booking_id)
                    AND t.transaction_type = 'SALE'
                    AND t.deleted_at IS NULL
                    AND NULLIF(BTRIM(t.payment_method), '') IS NOT NULL
                  ORDER BY t.id DESC
                  LIMIT 1
                ),
                'BELUM BAYAR / PIUTANG'
              )
            END AS payment_method,
            COALESCE(os.name, NULLIF(BTRIM(r.booking_channel), ''), NULLIF(BTRIM(b.booking_channel), ''), NULLIF(BTRIM(b.channel), ''), r.booking_type, 'Walk-In') AS booking_channel,
            COALESCE(os.name, '') AS ota_source_name,
            COALESCE(
              NULLIF(BTRIM(r.guest_segment), ''),
              NULLIF(BTRIM(g.guest_segment), ''),
              CASE
                WHEN UPPER(COALESCE(g.vip_status, '')) IN ('VIP', 'VVIP') THEN 'VIP'
                WHEN os.id IS NOT NULL OR UPPER(COALESCE(r.booking_channel, b.booking_channel, '')) LIKE '%OTA%' THEN 'OTA Guest'
                ELSE 'Reguler'
              END
            ) AS guest_segment,
            COALESCE(
              NULLIF(r.tax_amount, 0),
              (
                SELECT COALESCE(SUM(t.tax_amount), 0)
                FROM transactions t
                WHERE t.property_id = b.property_id
                  AND (t.reservation_id = r.id OR t.booking_id = r.booking_id)
                  AND t.transaction_type = 'SALE'
                  AND t.deleted_at IS NULL
                  AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
              ),
              0
            )::numeric(14,2) AS full_tax_amount,
            (
              SELECT ta.id
              FROM transaction_attachments ta
              JOIN transactions t ON t.id = ta.transaction_id
              WHERE t.property_id = b.property_id
                AND (t.reservation_id = r.id OR t.booking_id = r.booking_id)
                AND t.deleted_at IS NULL
              ORDER BY CASE WHEN UPPER(COALESCE(ta.attachment_purpose, '')) = 'PAYMENT_PROOF' THEN 0 ELSE 1 END, ta.id DESC
              LIMIT 1
            ) AS attachment_id,
            (
              SELECT pe.id
              FROM payment_evidences pe
              WHERE pe.reservation_id = r.id
                AND pe.is_active = TRUE
              ORDER BY pe.uploaded_at DESC NULLS LAST, pe.id DESC
              LIMIT 1
            ) AS payment_evidence_id,
            r.status AS reservation_status,
            ${isCompReservationSql} AS is_complimentary,
            COALESCE(rt.base_rate, 0)::numeric(14,2) AS base_rate
          FROM reservations r
          JOIN bookings b ON b.id = r.booking_id
          LEFT JOIN rooms rm ON rm.id = r.room_id AND rm.property_id = b.property_id
          LEFT JOIN room_types rt ON rt.id = COALESCE(rm.room_type_id, r.booked_room_type_id_snapshot) AND rt.property_id = b.property_id
          LEFT JOIN ota_sources os ON os.id = COALESCE(r.ota_source_id, b.ota_source_id)
          LEFT JOIN reservation_guests rg ON rg.reservation_id = r.id AND rg.role = 'PRIMARY_GUEST'
          LEFT JOIN guests g ON g.id = rg.guest_id
          WHERE b.property_id = $1
            AND r.status IN ('BOOKED', 'CHECKED_IN', 'CHECKED_OUT')
            AND UPPER(COALESCE(r.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
            AND COALESCE(b.booking_status, '') != 'CANCELLED'
            AND r.check_in::date <= $3::date
            AND GREATEST(r.check_out::date, (r.check_in::date + INTERVAL '1 day')::date) > $2::date
        )
        SELECT
          reservation_id,
          booking_id,
          room_id,
          booking_code,
          tx_date,
          tx_datetime,
          check_in,
          check_out,
          period_nights AS nights,
          period_nights,
          total_stay_nights,
          stay_type,
          start_time,
          end_time,
          guest_name,
          room_number,
          room_type_name,
          CASE
            WHEN UPPER(COALESCE(stay_type, '')) IN ('DAY_USE', 'SHORT_TIME') THEN full_total_price
            ELSE ROUND(full_total_price / GREATEST(1, total_stay_nights)::numeric, 2)
          END::numeric(14,2) AS room_rate,
          CASE
            WHEN UPPER(COALESCE(stay_type, '')) IN ('DAY_USE', 'SHORT_TIME') THEN full_total_price
            ELSE ROUND(full_total_price * period_nights::numeric / GREATEST(1, total_stay_nights)::numeric, 2)
          END::numeric(14,2) AS total_price,
          full_total_price,
          CASE
            WHEN UPPER(COALESCE(stay_type, '')) IN ('DAY_USE', 'SHORT_TIME') THEN full_discount_amount
            ELSE ROUND(full_discount_amount * period_nights::numeric / GREATEST(1, total_stay_nights)::numeric, 2)
          END::numeric(14,2) AS discount_amount,
          full_discount_amount,
          discount_percent,
          discount_reason,
          CASE
            WHEN UPPER(COALESCE(stay_type, '')) IN ('DAY_USE', 'SHORT_TIME') THEN full_amount_paid
            ELSE ROUND(full_amount_paid * period_nights::numeric / GREATEST(1, total_stay_nights)::numeric, 2)
          END::numeric(14,2) AS amount_paid,
          full_amount_paid,
          CASE
            WHEN UPPER(COALESCE(stay_type, '')) IN ('DAY_USE', 'SHORT_TIME') THEN full_remaining_balance
            ELSE ROUND(full_remaining_balance * period_nights::numeric / GREATEST(1, total_stay_nights)::numeric, 2)
          END::numeric(14,2) AS remaining_balance,
          full_remaining_balance,
          payment_status,
          payment_method,
          booking_channel,
          ota_source_name,
          guest_segment,
          CASE
            WHEN UPPER(COALESCE(stay_type, '')) IN ('DAY_USE', 'SHORT_TIME') THEN full_tax_amount
            ELSE ROUND(full_tax_amount * period_nights::numeric / GREATEST(1, total_stay_nights)::numeric, 2)
          END::numeric(14,2) AS tax_amount,
          attachment_id,
          payment_evidence_id,
          reservation_status,
          is_complimentary,
          (period_nights * base_rate)::numeric(14,2) AS estimated_comp_value
        FROM raw_room_sales
        ORDER BY check_in DESC, reservation_id DESC
        `,
        [propertyId, startDate, endDate]
      );

      // 6b. Cancelled Bookings / Reservations in [startDate, endDate]
      const cancelledBookingsRes = await pool.query(
        `
        SELECT
          r.id AS reservation_id,
          r.booking_id,
          COALESCE(b.bid, r.booking_number, 'RES-' || r.id::text) AS booking_code,
          COALESCE(NULLIF(BTRIM(r.guest_name), ''), NULLIF(BTRIM(b.guest_name_snapshot), ''), 'Tamu Hotel') AS guest_name,
          COALESCE(rm.room_number, '-') AS room_number,
          COALESCE(rt.name, r.booked_room_type_name_snapshot, rm.name, 'Kamar') AS room_type_name,
          to_char(r.check_in::date, 'YYYY-MM-DD') AS check_in,
          to_char(r.check_out::date, 'YYYY-MM-DD') AS check_out,
          GREATEST(1, (r.check_out::date - r.check_in::date))::int AS nights,
          to_char(COALESCE(r.cancelled_at, r.check_in) AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS cancelled_date,
          COALESCE(
            NULLIF(r.total_price, 0),
            (GREATEST(1, (r.check_out::date - r.check_in::date)) * COALESCE(rt.base_rate, 0)),
            0
          )::numeric(14,2) AS lost_revenue,
          COALESCE(os.name, NULLIF(BTRIM(r.booking_channel), ''), NULLIF(BTRIM(b.booking_channel), ''), 'Walk-In') AS booking_channel,
          COALESCE(NULLIF(BTRIM(r.special_requests), ''), 'Dibatalkan') AS cancel_reason
        FROM reservations r
        JOIN bookings b ON b.id = r.booking_id
        LEFT JOIN rooms rm ON rm.id = r.room_id AND rm.property_id = b.property_id
        LEFT JOIN room_types rt ON rt.id = COALESCE(rm.room_type_id, r.booked_room_type_id_snapshot) AND rt.property_id = b.property_id
        LEFT JOIN ota_sources os ON os.id = COALESCE(r.ota_source_id, b.ota_source_id)
        WHERE b.property_id = $1
          AND (r.status = 'CANCELLED' OR COALESCE(b.booking_status, '') = 'CANCELLED')
          AND (
            (r.check_in::date >= $2::date AND r.check_in::date <= $3::date)
            OR (r.cancelled_at IS NOT NULL AND (r.cancelled_at AT TIME ZONE 'Asia/Jakarta')::date >= $2::date AND (r.cancelled_at AT TIME ZONE 'Asia/Jakarta')::date <= $3::date)
          )
        ORDER BY COALESCE(r.cancelled_at, r.check_in) DESC, r.id DESC
        `,
        [propertyId, startDate, endDate]
      );

      // 6c. Property Pricing Settings (for PPN / Tax calculation)
      const pricingSettingsRes = await pool.query(
        `
        SELECT
          COALESCE(tax_percent, 10)::numeric(5,2) AS tax_percent,
          COALESCE(service_charge_percent, 0)::numeric(5,2) AS service_charge_percent,
          COALESCE(prices_include_tax, FALSE) AS prices_include_tax,
          COALESCE(prices_include_service, FALSE) AS prices_include_service
        FROM property_pricing_settings
        WHERE property_id = $1
        LIMIT 1
        `,
        [propertyId]
      );
      const pricingSettings = pricingSettingsRes.rows[0] || {
        tax_percent: 10,
        service_charge_percent: 0,
        prices_include_tax: false,
        prices_include_service: false
      };

      // 7. Discount Summary (Room Discounts + POS Discounts)
      const nonCancelledTxFilter = `
        AND NOT EXISTS (
          SELECT 1 FROM reservations r_chk
          WHERE r_chk.id = t.reservation_id
            AND (UPPER(COALESCE(r_chk.status, '')) IN ('CANCELLED', 'NO_SHOW') OR UPPER(COALESCE(r_chk.stay_status, '')) IN ('CANCELLED', 'NO_SHOW'))
        )
        AND NOT EXISTS (
          SELECT 1 FROM bookings b_chk
          WHERE b_chk.id = t.booking_id
            AND (
              UPPER(COALESCE(b_chk.booking_status, '')) = 'CANCELLED'
              OR (
                t.reservation_id IS NULL
                AND EXISTS (SELECT 1 FROM reservations r_b WHERE r_b.booking_id = b_chk.id)
                AND NOT EXISTS (
                  SELECT 1 FROM reservations r_b2
                  WHERE r_b2.booking_id = b_chk.id
                    AND UPPER(COALESCE(r_b2.status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
                    AND UPPER(COALESCE(r_b2.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
                )
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM pos_orders po_chk
          LEFT JOIN reservations r_po ON r_po.id = po_chk.reservation_id
          WHERE UPPER(COALESCE(t.source_type, '')) IN ('POS', 'POS_ORDER')
            AND t.source_reference IS NOT NULL
            AND po_chk.property_id = t.property_id
            AND po_chk.order_number = t.source_reference
            AND (
              UPPER(COALESCE(po_chk.status, '')) IN ('CANCELLED', 'VOIDED')
              OR UPPER(COALESCE(r_po.status, '')) = 'CANCELLED'
              OR UPPER(COALESCE(r_po.stay_status, '')) = 'CANCELLED'
            )
        )
      `;

      const roomDiscountFromRes = roomSalesRes.rows
        .filter((r: any) => !r.is_complimentary && Number(r.discount_amount || 0) > 0);
      const resDiscountTotal = roomDiscountFromRes.reduce(
        (s: number, r: any) => s + (Number(r.discount_amount) || 0),
        0
      );
      const bookingGlobalDiscRes = await pool.query(
        `
        SELECT
          COALESCE(SUM(b.global_discount_amount), 0)::numeric(14,2) AS global_disc_total,
          COUNT(*) FILTER (WHERE COALESCE(b.global_discount_amount, 0) > 0)::int AS global_disc_count
        FROM bookings b
        WHERE b.property_id = $1
          AND COALESCE(b.booking_status, '') != 'CANCELLED'
          AND COALESCE(b.global_discount_amount, 0) > 0
          AND EXISTS (
            SELECT 1 FROM reservations r
            WHERE r.booking_id = b.id
              AND r.status IN ('BOOKED', 'CHECKED_IN', 'CHECKED_OUT')
              AND UPPER(COALESCE(r.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
              AND r.check_in::date <= $3::date
              AND GREATEST(r.check_out::date, (r.check_in::date + INTERVAL '1 day')::date) > $2::date
              AND COALESCE(r.discount_amount, 0) = 0
          )
        `,
        [propertyId, startDate, endDate]
      );
      const txDiscountRes = await pool.query(
        `
        SELECT
          COALESCE(SUM(CASE
            WHEN UPPER(COALESCE(t.source_type, '')) IN ('POS', 'POS_ORDER')
              OR UPPER(COALESCE(t.category_code, '')) LIKE '%POS%'
              OR UPPER(COALESCE(t.category_code, '')) LIKE '%FNB%'
            THEN COALESCE(t.discount_amount, 0)
            ELSE 0
          END), 0)::numeric(14,2) AS pos_discount_total,
          COUNT(*) FILTER (WHERE (
            UPPER(COALESCE(t.source_type, '')) IN ('POS', 'POS_ORDER')
            OR UPPER(COALESCE(t.category_code, '')) LIKE '%POS%'
            OR UPPER(COALESCE(t.category_code, '')) LIKE '%FNB%'
          ) AND COALESCE(t.discount_amount, 0) > 0)::int AS pos_discount_count,
          COALESCE(SUM(CASE
            WHEN UPPER(COALESCE(t.source_type, '')) NOT IN ('POS', 'POS_ORDER')
              AND UPPER(COALESCE(t.category_code, '')) NOT LIKE '%POS%'
              AND UPPER(COALESCE(t.category_code, '')) NOT LIKE '%FNB%'
              AND t.reservation_id IS NULL
            THEN COALESCE(t.discount_amount, 0)
            ELSE 0
          END), 0)::numeric(14,2) AS standalone_room_discount_total,
          COUNT(*) FILTER (WHERE (
            UPPER(COALESCE(t.source_type, '')) NOT IN ('POS', 'POS_ORDER')
            AND UPPER(COALESCE(t.category_code, '')) NOT LIKE '%POS%'
            AND UPPER(COALESCE(t.category_code, '')) NOT LIKE '%FNB%'
            AND t.reservation_id IS NULL
          ) AND COALESCE(t.discount_amount, 0) > 0)::int AS standalone_room_discount_count
        FROM transactions t
        WHERE t.property_id = $1
          AND t.transaction_type = 'SALE'
          AND t.deleted_at IS NULL
          AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
          AND t.transaction_date >= $2::date
          AND t.transaction_date <= $3::date
          ${nonCancelledTxFilter}
        `,
        [propertyId, startDate, endDate]
      );

      const globalDiscRow = bookingGlobalDiscRes.rows[0] || {};
      const txDiscRow = txDiscountRes.rows[0] || {};
      const roomDiscountTotal =
        resDiscountTotal +
        Number(globalDiscRow.global_disc_total || 0) +
        Number(txDiscRow.standalone_room_discount_total || 0);
      const roomDiscountCount =
        roomDiscountFromRes.length +
        Number(globalDiscRow.global_disc_count || 0) +
        Number(txDiscRow.standalone_room_discount_count || 0);
      const posDiscountTotal = Number(txDiscRow.pos_discount_total || 0);
      const posDiscountCount = Number(txDiscRow.pos_discount_count || 0);

      const discountSummary = {
        room_discount_total: roomDiscountTotal,
        room_discount_count: roomDiscountCount,
        pos_discount_total: posDiscountTotal,
        pos_discount_count: posDiscountCount,
        total_discount_amount: roomDiscountTotal + posDiscountTotal,
        total_discount_count: roomDiscountCount + posDiscountCount
      };

      // 8. Accounting Statements: Profit/Loss, Cash Flow, and Balance Sheet
      const financialsData = await calculateFinancials(pool, {
        property_id: propertyId,
        start_date: startDate,
        end_date: endDate
      });

      const txAggRes = await pool.query(
        `
        SELECT
          COALESCE(SUM(CASE WHEN t.transaction_type IN ('SALE', 'INCOME') THEN COALESCE(t.tax_amount, 0) ELSE 0 END), 0)::numeric(14,2) AS sales_tax,
          COALESCE(SUM(CASE WHEN t.transaction_type IN ('SALE', 'INCOME') THEN COALESCE(t.service_amount, 0) ELSE 0 END), 0)::numeric(14,2) AS sales_service,
          COALESCE(SUM(CASE WHEN t.transaction_type IN ('SALE', 'INCOME') THEN COALESCE(t.rounding_amount, 0) ELSE 0 END), 0)::numeric(14,2) AS sales_rounding,
          COALESCE(SUM(CASE WHEN t.transaction_type = 'PURCHASE' THEN COALESCE(t.discount_amount, 0) ELSE 0 END), 0)::numeric(14,2) AS purchase_discount,
          COALESCE(SUM(CASE WHEN t.transaction_type = 'PURCHASE' THEN COALESCE(t.tax_amount, 0) ELSE 0 END), 0)::numeric(14,2) AS purchase_tax
        FROM transactions t
        WHERE t.property_id = $1
          AND t.deleted_at IS NULL
          AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
          AND t.transaction_date >= $2::date
          AND t.transaction_date <= $3::date
          ${nonCancelledTxFilter}
        `,
        [propertyId, startDate, endDate]
      );
      const txAgg = txAggRes.rows[0] || {};

      // Stock Movements Valuation (Stok Keluar & Opname Stok in [startDate, endDate])
      const stockMoveRes = await pool.query(
        `
        SELECT
          COALESCE(SUM(
            CASE
              WHEN (UPPER(COALESCE(so.operation_type, '')) LIKE '%OPNAME%' OR UPPER(COALESCE(so.operation_type, '')) LIKE '%ADJUST%')
                THEN ABS(sm.quantity_delta) * COALESCE(NULLIF(sm.unit_cost, 0), NULLIF(pmi.average_cost, 0), NULLIF(pmi.last_cost, 0), 0)
              ELSE 0
            END
          ), 0)::numeric(14,2) AS opname_cost,
          COALESCE(SUM(
            CASE
              WHEN sm.quantity_delta < 0
                AND UPPER(COALESCE(so.operation_type, '')) NOT LIKE '%OPNAME%'
                AND UPPER(COALESCE(so.operation_type, '')) NOT LIKE '%ADJUST%'
                AND UPPER(COALESCE(so.operation_type, '')) NOT LIKE '%SALE%'
                AND UPPER(COALESCE(so.operation_type, '')) NOT LIKE '%POS%'
                THEN ABS(sm.quantity_delta) * COALESCE(NULLIF(sm.unit_cost, 0), NULLIF(pmi.average_cost, 0), NULLIF(pmi.last_cost, 0), 0)
              ELSE 0
            END
          ), 0)::numeric(14,2) AS stock_out_cost
        FROM stock_movements sm
        JOIN stock_operations so ON so.id = sm.operation_id
        LEFT JOIN pos_menu_items pmi ON pmi.id = sm.product_id AND pmi.property_id = sm.property_id
        WHERE sm.property_id = $1
          AND ((sm.created_at AT TIME ZONE 'Asia/Jakarta')::date) >= $2::date
          AND ((sm.created_at AT TIME ZONE 'Asia/Jakarta')::date) <= $3::date
        `,
        [propertyId, startDate, endDate]
      );
      const stockMove = stockMoveRes.rows[0] || {};

      // Cash Flow Query (Opening Balance before startDate + Period Movements)
      const cashFlowRes = await pool.query(
        `
        WITH pt_cash AS (
          SELECT
            ((pt.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta')::date AS p_date,
            COALESCE(pt.amount, 0)::numeric AS amount,
            UPPER(COALESCE(pt.transaction_type, 'PAYMENT')) AS tx_type
          FROM payment_transactions pt
          LEFT JOIN reservations r ON r.id = pt.reservation_id
          LEFT JOIN bookings b ON b.id = COALESCE(pt.booking_id, r.booking_id)
          WHERE (pt.property_id = $1 OR b.property_id = $1)
            AND pt.status = 'SUCCESS'
            AND (r.id IS NULL OR (UPPER(COALESCE(r.status, '')) NOT IN ('CANCELLED', 'NO_SHOW') AND UPPER(COALESCE(r.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')))
            AND (b.id IS NULL OR UPPER(COALESCE(b.booking_status, '')) != 'CANCELLED')
        ),
        tx_cash AS (
          SELECT
            t.transaction_date AS t_date,
            t.transaction_type,
            t.category_code,
            t.department_code,
            COALESCE(t.net_amount, 0)::numeric AS net_amount,
            UPPER(COALESCE(t.payment_status, 'PAID')) AS payment_status,
            t.reservation_id,
            t.booking_id
          FROM transactions t
          WHERE t.property_id = $1
            AND t.deleted_at IS NULL
            AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
            ${nonCancelledTxFilter}
        )
        SELECT
          -- Opening cash before $2::date
          (
            COALESCE((SELECT SUM(CASE WHEN tx_type = 'DEPOSIT_REFUND' THEN -amount ELSE amount END) FROM pt_cash WHERE p_date < $2::date), 0)
            + COALESCE((SELECT SUM(net_amount) FROM tx_cash WHERE t_date < $2::date AND transaction_type IN ('SALE', 'INCOME') AND reservation_id IS NULL AND booking_id IS NULL AND payment_status = 'PAID'), 0)
            - COALESCE((SELECT SUM(net_amount) FROM tx_cash WHERE t_date < $2::date AND transaction_type IN ('EXPENSE', 'PURCHASE') AND payment_status = 'PAID'), 0)
          )::numeric(14,2) AS opening_cash_balance,
          -- Customer receipts in [$2, $3]
          (
            COALESCE((SELECT SUM(amount) FROM pt_cash WHERE p_date >= $2::date AND p_date <= $3::date AND tx_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT', 'DEPOSIT')), 0)
            + COALESCE((SELECT SUM(net_amount) FROM tx_cash WHERE t_date >= $2::date AND t_date <= $3::date AND transaction_type = 'SALE' AND reservation_id IS NULL AND booking_id IS NULL), 0)
          )::numeric(14,2) AS customer_receipts,
          -- Supplier payments in [$2, $3]
          (
            COALESCE((SELECT SUM(net_amount) FROM tx_cash WHERE t_date >= $2::date AND t_date <= $3::date AND transaction_type = 'PURCHASE'), 0)
            + COALESCE((
              SELECT SUM(ppo.total_estimated_amount)
              FROM pos_purchase_orders ppo
              WHERE ppo.property_id = $1
                AND ppo.status = 'COMPLETED'
                AND ppo.order_date >= $2::date
                AND ppo.order_date <= $3::date
                AND NOT EXISTS (
                  SELECT 1 FROM transactions t2
                  WHERE t2.property_id = ppo.property_id
                    AND t2.transaction_type = 'PURCHASE'
                    AND t2.deleted_at IS NULL
                    AND t2.source_reference = ppo.po_number
                )
            ), 0)
          )::numeric(14,2) AS supplier_payments,
          -- Operating expenses (excluding maintenance) in [$2, $3]
          COALESCE((
            SELECT SUM(net_amount) FROM tx_cash
            WHERE t_date >= $2::date AND t_date <= $3::date
              AND transaction_type = 'EXPENSE'
              AND UPPER(COALESCE(department_code, '')) NOT LIKE '%MAINT%'
              AND UPPER(COALESCE(category_code, '')) NOT LIKE '%MAINT%'
          ), 0)::numeric(14,2) AS operating_expenses,
          -- Maintenance expenses in [$2, $3]
          COALESCE((
            SELECT SUM(net_amount) FROM tx_cash
            WHERE t_date >= $2::date AND t_date <= $3::date
              AND transaction_type = 'EXPENSE'
              AND (UPPER(COALESCE(department_code, '')) LIKE '%MAINT%' OR UPPER(COALESCE(category_code, '')) LIKE '%MAINT%')
          ), 0)::numeric(14,2) AS maintenance_expenses,
          -- Other income in [$2, $3]
          COALESCE((
            SELECT SUM(net_amount) FROM tx_cash
            WHERE t_date >= $2::date AND t_date <= $3::date
              AND transaction_type = 'INCOME'
          ), 0)::numeric(14,2) AS other_income_receipts,
          -- Other expenses / deposit refunds in [$2, $3]
          COALESCE((
            SELECT SUM(amount) FROM pt_cash
            WHERE p_date >= $2::date AND p_date <= $3::date
              AND tx_type = 'DEPOSIT_REFUND'
          ), 0)::numeric(14,2) AS other_expenses
        `,
        [propertyId, startDate, endDate]
      );
      const cfRow = cashFlowRes.rows[0] || {};

      // Balance Sheet Valuation as of endDate
      const balanceSheetRes = await pool.query(
        `
        WITH method_balances AS (
          SELECT
            UPPER(COALESCE(m.method, '')) AS method_upper,
            (COALESCE(m.booking_total, 0) + COALESCE(m.pos_total, 0) + COALESCE(m.income_total, 0) - COALESCE(m.purchase_total, 0) - COALESCE(m.expense_total, 0))::numeric AS net_bal
          FROM (
            SELECT
              COALESCE(
                NULLIF(BTRIM(t.payment_method), ''),
                (
                  SELECT NULLIF(BTRIM(pt.payment_method), '')
                  FROM payment_transactions pt
                  WHERE (pt.transaction_id = t.id OR (t.reservation_id IS NOT NULL AND pt.reservation_id = t.reservation_id))
                    AND pt.status = 'SUCCESS'
                  ORDER BY pt.id DESC LIMIT 1
                ),
                (
                  SELECT NULLIF(BTRIM(pt.payment_method), '')
                  FROM payment_allocations pa
                  JOIN payment_transactions pt ON pt.id = pa.payment_transaction_id
                  WHERE t.booking_id IS NOT NULL AND pa.booking_id = t.booking_id
                    AND pa.status = 'ACTIVE' AND pt.status = 'SUCCESS'
                  ORDER BY pt.id DESC LIMIT 1
                ),
                'BELUM_DIISI'
              ) AS method,
              SUM(CASE WHEN t.transaction_type = 'SALE' AND UPPER(COALESCE(t.source_type, '')) NOT IN ('POS', 'POS_ORDER') THEN t.net_amount ELSE 0 END) AS booking_total,
              SUM(CASE WHEN t.transaction_type = 'SALE' AND UPPER(COALESCE(t.source_type, '')) IN ('POS', 'POS_ORDER') THEN t.net_amount ELSE 0 END) AS pos_total,
              SUM(CASE WHEN t.transaction_type = 'INCOME' THEN t.net_amount ELSE 0 END) AS income_total,
              SUM(CASE WHEN t.transaction_type = 'PURCHASE' THEN t.net_amount ELSE 0 END) AS purchase_total,
              SUM(CASE WHEN t.transaction_type = 'EXPENSE' THEN t.net_amount ELSE 0 END) AS expense_total
            FROM transactions t
            WHERE t.property_id = $1
              AND t.deleted_at IS NULL
              AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
              AND t.transaction_date <= $2::date
              ${nonCancelledTxFilter}
            GROUP BY 1
          ) m
        )
        SELECT
          COALESCE((SELECT SUM(net_bal) FROM method_balances WHERE method_upper IN ('CASH', 'TUNAI')), 0)::numeric(14,2) AS cash_on_hand,
          COALESCE((SELECT SUM(net_bal) FROM method_balances WHERE method_upper IN ('BANK')), 0)::numeric(14,2) AS bank_account,
          COALESCE((SELECT SUM(net_bal) FROM method_balances WHERE method_upper LIKE '%TRANSFER%' OR method_upper LIKE '%BCA%' OR method_upper LIKE '%MANDIRI%' OR method_upper LIKE '%BRI%' OR method_upper LIKE '%BNI%'), 0)::numeric(14,2) AS transfer_bank,
          COALESCE((SELECT SUM(net_bal) FROM method_balances WHERE method_upper LIKE '%QRIS%' OR method_upper LIKE '%GOPAY%' OR method_upper LIKE '%OVO%' OR method_upper LIKE '%DANA%' OR method_upper LIKE '%EWALLET%'), 0)::numeric(14,2) AS qris_balance,
          COALESCE((SELECT SUM(net_bal) FROM method_balances WHERE method_upper LIKE '%CARD%' OR method_upper LIKE '%DEBIT%' OR method_upper LIKE '%KREDIT%' OR method_upper LIKE '%EDC%'), 0)::numeric(14,2) AS card_edc,
          COALESCE((
            SELECT SUM(COALESCE(r.remaining_balance, GREATEST(0, COALESCE(r.total_price, 0) - COALESCE(r.amount_paid, 0))))
            FROM reservations r
            JOIN bookings b ON b.id = r.booking_id
            WHERE b.property_id = $1
              AND r.status IN ('BOOKED', 'CHECKED_IN', 'CHECKED_OUT')
              AND UPPER(COALESCE(r.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
              AND COALESCE(b.booking_status, '') != 'CANCELLED'
              AND UPPER(COALESCE(r.payment_status, '')) NOT IN ('PAID', 'LUNAS', 'COMPLIMENTARY')
              AND COALESCE(r.discount_percent, 0) < 100
              AND NOT EXISTS (
                SELECT 1 FROM reservation_complimentary_requests rcr
                WHERE rcr.reservation_id = r.id AND rcr.status = 'APPROVED'
              )
              AND r.check_in::date <= $2::date
          ), 0)::numeric(14,2) AS accounts_receivable,
          COALESCE((
            SELECT SUM(sb.quantity * COALESCE(NULLIF(pmi.average_cost, 0), NULLIF(pmi.last_cost, 0), 0))
            FROM stock_balances sb
            JOIN pos_menu_items pmi ON pmi.id = sb.product_id AND pmi.property_id = sb.property_id
            WHERE sb.property_id = $1
              AND sb.quantity > 0
          ), 0)::numeric(14,2) AS inventory_value,
          COALESCE((
            SELECT SUM(d.original_amount)
            FROM deposits d
            WHERE d.property_id = $1
              AND d.status IN ('RECEIVED', 'PARTIALLY_USED')
          ), 0)::numeric(14,2) AS guest_deposits
        `,
        [propertyId, endDate]
      );
      const bsRow = balanceSheetRes.rows[0] || {};

      // Compute Profit & Loss numbers from active (non-cancelled, non-complimentary) room sales and POS sales
      const sb = financialsData.sales_breakdown;
      const activeRoomSalesTotal = roomSalesRes.rows
        .filter((r: any) => !r.is_complimentary)
        .reduce((s: number, r: any) => s + (Number(r.total_price) || 0), 0);
      const activePosSalesTotal = posItemsRes.rows
        .filter((p: any) => !p.is_complimentary)
        .reduce((s: number, p: any) => s + (Number(p.line_total) || 0), 0);
      const roomRevTotal =
        activeRoomSalesTotal > 0
          ? activeRoomSalesTotal
          : sb && sb.room_total > 0
          ? Number(sb.room_total)
          : roomsRankingRes.rows.reduce((s: number, r: any) => s + (Number(r.room_revenue) || 0), 0);
      const posRevTotal =
        activePosSalesTotal > 0
          ? activePosSalesTotal
          : sb && sb.pos_total > 0
          ? Number(sb.pos_total)
          : posItemsRes.rows.reduce((s: number, p: any) => s + (Number(p.line_total) || 0), 0);
      const otherIncTotal = Number(financialsData.other_income?.total || 0);
      const totalRevenue = roomRevTotal + posRevTotal + otherIncTotal;

      const totalPosHpp = posItemsRes.rows.reduce(
        (s: number, p: any) => s + (Number(p.total_hpp) || 0),
        0
      );
      const grossProfit = totalRevenue - totalPosHpp;

      const totalExpenses = Number(financialsData.expense?.total || 0);
      const stockOutCost = Number(stockMove.stock_out_cost || 0);
      const stockOpnameCost = Number(stockMove.opname_cost || 0);
      const totalStockCost = stockOutCost + stockOpnameCost;

      const purchaseTotal = Number(financialsData.purchase?.total || 0);
      const purchaseDiscount = Number(txAgg.purchase_discount || 0);
      const purchaseTax = Number(txAgg.purchase_tax || 0);

      const netProfit = grossProfit - totalExpenses - totalStockCost - purchaseTotal;

      const profitLoss = {
        revenue: {
          room_sales: roomRevTotal,
          product_sales: posRevTotal,
          other_income: otherIncTotal,
          shipping_revenue: 0,
          tax_exclude: Number(txAgg.sales_tax || 0),
          tax_include: 0,
          service_charge: Number(txAgg.sales_service || 0),
          rounding: Number(txAgg.sales_rounding || 0),
          returns_and_discounts: discountSummary.total_discount_amount,
          total_revenue: totalRevenue
        },
        cogs: {
          sales_cogs: totalPosHpp,
          returns_cogs: 0,
          total_cogs: totalPosHpp
        },
        gross_profit: grossProfit,
        expenses: {
          by_category: financialsData.expense?.by_category || [],
          total_expenses: totalExpenses
        },
        stock_adjustments: {
          stock_out_cost: stockOutCost,
          stock_opname_cost: stockOpnameCost,
          total_stock_cost: totalStockCost
        },
        purchases_summary: {
          purchase_total: purchaseTotal,
          purchase_discount: purchaseDiscount,
          purchase_shipping: 0,
          purchase_tax: purchaseTax,
          total_purchases: purchaseTotal
        },
        net_profit: netProfit
      };

      const openingCash = Number(cfRow.opening_cash_balance || 0);
      const customerReceipts = Number(cfRow.customer_receipts || 0);
      const supplierPayments = Number(cfRow.supplier_payments || 0);
      const operatingExpenses = Number(cfRow.operating_expenses || 0);
      const maintenanceExpenses = Number(cfRow.maintenance_expenses || 0);
      const otherIncomeReceipts = Number(cfRow.other_income_receipts || 0);
      const otherExpenses = Number(cfRow.other_expenses || 0);
      const subtotalOperating =
        customerReceipts -
        supplierPayments -
        operatingExpenses -
        maintenanceExpenses +
        otherIncomeReceipts -
        otherExpenses -
        stockOpnameCost -
        stockOutCost;

      const cashFlow = {
        opening_cash_balance: openingCash,
        operating_activities: {
          customer_receipts: customerReceipts,
          supplier_payments: supplierPayments,
          operating_expenses: operatingExpenses,
          maintenance_expenses: maintenanceExpenses,
          other_income_receipts: otherIncomeReceipts,
          other_expenses: otherExpenses,
          stock_opname_adjustment: stockOpnameCost,
          stock_out_adjustment: stockOutCost,
          subtotal_operating: subtotalOperating
        },
        investing_activities: {
          fixed_assets: 0,
          intangible_assets: 0,
          other_investing: 0,
          subtotal_investing: 0
        },
        total_income_after_investing: subtotalOperating,
        financing_activities: {
          loans: 0,
          equity_changes: 0,
          subtotal_financing: 0
        },
        net_cash_change: subtotalOperating,
        closing_cash_balance: openingCash + subtotalOperating
      };

      const cashOnHand = Math.max(0, Number(bsRow.cash_on_hand || 0));
      const bankAccount = Math.max(0, Number(bsRow.bank_account || 0));
      const transferBank = Math.max(0, Number(bsRow.transfer_bank || 0));
      const qrisBalance = Math.max(0, Number(bsRow.qris_balance || 0));
      // Compute Piutang Tamu (AR) directly from Penjualan Sheet Piutang (CHECKED_OUT + remaining > 0 + != OTA_COLLECT)
      const [periodPiutangRes, allTimePiutangRes] = await Promise.all([
        getTransactions(pool, {
          property_id: propertyId,
          transaction_type: 'SALE',
          operational_sheet: 'PIUTANG' as any,
          start_date: startDate,
          end_date: endDate,
          limit: 500,
          offset: 0,
          includePiutangCount: true,
        }),
        getTransactions(pool, {
          property_id: propertyId,
          transaction_type: 'SALE',
          operational_sheet: 'PIUTANG' as any,
          limit: 1000,
          offset: 0,
          includePiutangCount: true,
        }),
      ]);

      const mapPiutangItem = (row: any) => {
        if (row.booking_bid_group) {
          const g = row.booking_bid_group;
          const children = Array.isArray(g.children) ? g.children : [];
          const roomSummary =
            children
              .map((c: any) => `${c.room_number || ''} ${c.room_type_name || ''}`.trim())
              .filter(Boolean)
              .join(', ') || `${g.room_count || 1} kamar`;
          return {
            bid: String(g.bid || row.booking_bid || row.transaction_no || '-'),
            guest_name: String(g.guest_name || row.party_name || row.guest_name_snapshot || '-'),
            room_count: Number(g.room_count || children.length || 1),
            room_summary: roomSummary,
            check_in: children[0]?.check_in ? String(children[0].check_in).slice(0, 10) : null,
            check_out:
              children.length > 0 && children[children.length - 1]?.check_out
                ? String(children[children.length - 1].check_out).slice(0, 10)
                : null,
            tx_date: String(row.transaction_date || '').slice(0, 10),
            net: Math.round(Number(g.net || 0)),
            paid: Math.round(Number(g.paid || 0)),
            remaining: Math.round(Number(g.remaining || 0)),
          };
        }
        const net = Math.round(Number(row.effective_net_amount ?? row.net_amount ?? 0));
        const paid = Math.round(Number(row.canonical_effective_paid ?? row.paid_amount ?? 0));
        const remaining = Math.round(
          Number(row.canonical_remaining_balance ?? Math.max(0, net - paid))
        );
        return {
          bid: String(row.booking_bid || row.transaction_no || '-'),
          guest_name: String(row.party_name || row.guest_name_snapshot || '-'),
          room_count: 1,
          room_summary: `${row.room_number_snapshot || ''} ${row.room_type_name || ''}`.trim() || '-',
          check_in: row.check_in ? String(row.check_in).slice(0, 10) : null,
          check_out: row.check_out ? String(row.check_out).slice(0, 10) : null,
          tx_date: String(row.transaction_date || '').slice(0, 10),
          net,
          paid,
          remaining,
        };
      };

      const periodPiutangItems = (periodPiutangRes.transactions || []).map(mapPiutangItem);
      const allTimePiutangItems = (allTimePiutangRes.transactions || []).map(mapPiutangItem);
      const periodPiutangTotal = periodPiutangItems.reduce((s, it) => s + it.remaining, 0);
      const allTimePiutangTotal = allTimePiutangItems.reduce((s, it) => s + it.remaining, 0);

      const piutangSheetSummary = {
        period_total: periodPiutangTotal,
        period_count: periodPiutangItems.length,
        all_time_total: allTimePiutangTotal,
        all_time_count: allTimePiutangItems.length,
        items: periodPiutangItems,
        all_time_items: allTimePiutangItems,
      };

      const cardEdc = Math.max(0, Number(bsRow.card_edc || 0));
      const accountsReceivable = Math.max(0, periodPiutangTotal);
      const inventoryValue = Math.max(0, Number(bsRow.inventory_value || 0));
      const subtotalCurrentAssets =
        cashOnHand +
        bankAccount +
        transferBank +
        qrisBalance +
        cardEdc +
        accountsReceivable +
        inventoryValue;
      const fixedAssets = 0;
      const totalAssets = subtotalCurrentAssets + fixedAssets;

      const accountsPayable = Number(financialsData.purchase?.unpaid_total || 0);
      const guestDeposits = Math.max(0, Number(bsRow.guest_deposits || 0));
      const subtotalLiabilities = accountsPayable + guestDeposits;
      const currentPeriodIncome = netProfit;
      const retainedEarnings = Math.max(0, totalAssets - subtotalLiabilities - currentPeriodIncome);
      const subtotalEquity = retainedEarnings + currentPeriodIncome;

      const balanceSheet = {
        assets: {
          current_assets: {
            cash_on_hand: cashOnHand,
            bank_account: bankAccount,
            transfer_bank: transferBank,
            qris_balance: qrisBalance,
            card_edc: cardEdc,
            short_term_investment: 0,
            accounts_receivable: accountsReceivable,
            inventory_value: inventoryValue,
            subtotal_current_assets: subtotalCurrentAssets
          },
          non_current_assets: {
            fixed_assets: fixedAssets,
            subtotal_non_current_assets: fixedAssets
          },
          total_assets: totalAssets
        },
        liabilities_and_equity: {
          liabilities: {
            accounts_payable: accountsPayable,
            guest_deposits: guestDeposits,
            subtotal_liabilities: subtotalLiabilities
          },
          equity: {
            retained_earnings: retainedEarnings,
            current_period_income: currentPeriodIncome,
            subtotal_equity: subtotalEquity
          },
          total_liabilities_and_equity: subtotalLiabilities + subtotalEquity
        }
      };

      return res.json({
        status: 'SUCCESS',
        data: {
          property_id: propertyId,
          start_date: startDate,
          end_date: endDate,
          room_ranking: roomsRankingRes.rows,
          complimentary_stays: compStaysRes.rows,
          pos_item_sales: posItemsRes.rows,
          purchase_lines: purchaseLinesRes.rows,
          daily_occupancy: dailyOccupancyRes.rows,
          room_sales: roomSalesRes.rows,
          cancelled_bookings: cancelledBookingsRes.rows,
          pricing_settings: pricingSettings,
          discount_summary: discountSummary,
          piutang_sheet_summary: piutangSheetSummary,
          accounting_statements: {
            profit_loss: profitLoss,
            cash_flow: cashFlow,
            balance_sheet: balanceSheet
          }
        }
      });
    } catch (err: any) {
      console.error('Error in /api/reports/analytics-hub:', err);
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error'
      });
    }
  });

  return router;
}
