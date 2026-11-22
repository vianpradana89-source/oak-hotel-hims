import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { hotelDateFromInstant, normalizeHotelDate } from '../../utils/hotelDate';
import { getDailyKpiDrilldown, getDailyKpiHistory, getDailyKpis } from './dailyKpiService';
import { calculateOccupancy } from './occupancyService';
import { calculateFinancials } from './financialsService';
import { getTransactions, settleTransactionPayment, addTransactionAttachment, executePurchaseLifecycle, executeExpenseLifecycle } from '../transactions/transactionService';
import { calculateHotelCollectibleBalance } from '../reservations/reservationFinancialCalculator';
import { buildAccountingSubledgerData, ensureAccountingSchema } from './accountingService';
import { TRANSACTION_ATTACHMENT_UPLOAD_DIR } from '../transactions/transactionAttachmentAccess';
import { verifyToken } from '../auth/authService';

const payablesStorage = multer.diskStorage({
  destination: (_req: any, _file: any, cb: (error: Error | null, destination: string) => void) => {
    fs.mkdirSync(TRANSACTION_ATTACHMENT_UPLOAD_DIR, { recursive: true });
    cb(null, TRANSACTION_ATTACHMENT_UPLOAD_DIR);
  },
  filename: (_req: any, file: any, cb: (error: Error | null, filename: string) => void) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'].includes(ext) ? ext : '.jpg';
    const safeName = `tx-att-${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, safeName);
  },
});

const uploadPayableProof = multer({
  storage: payablesStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format berkas tidak didukung. Hanya JPG, PNG, WEBP, dan PDF yang diperbolehkan.'));
    }
  },
});

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

      const isReservationTxVoidedSql = `
        (
          EXISTS (
            SELECT 1
            FROM transactions t_void
            WHERE t_void.property_id = b.property_id
              AND (t_void.reservation_id = r.id OR (t_void.reservation_id IS NULL AND t_void.booking_id = b.id))
              AND t_void.transaction_type = 'SALE'
              AND t_void.deleted_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1
            FROM transactions t_live
            WHERE t_live.property_id = b.property_id
              AND (t_live.reservation_id = r.id OR (t_live.reservation_id IS NULL AND t_live.booking_id = b.id))
              AND t_live.transaction_type = 'SALE'
              AND t_live.deleted_at IS NULL
              AND UPPER(COALESCE(t_live.transaction_status, 'POSTED')) NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
          )
        )
      `;

      // 1–6c. Run all independent operational report queries in parallel
      const [
        roomsRankingRes,
        compStaysRes,
        posItemsRes,
        purchaseLinesRes,
        dailyOccupancyRes,
        roomSalesRes,
        cancelledBookingsRes,
        pricingSettingsRes
      ] = await Promise.all([
        // 1. Per-Room Occupancy & Revenue Ranking in [startDate, endDate] inclusive
        pool.query(
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
            AND NOT ${isReservationTxVoidedSql}
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
      ),

      // 2. Complimentary Reservations & Stays Summary in [startDate, endDate]
      pool.query(
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
      ),

      // 3. Sales Item Breakdown (POS Order Items + Standalone POS/Product Transactions + HPP)
      pool.query(
        `
        SELECT * FROM (
          SELECT
            poi.id AS order_item_id,
            po.id AS order_id,
            COALESCE(NULLIF(BTRIM(b.bid), ''), NULLIF(BTRIM(t.transaction_no), ''), po.order_number, 'POS-' || LPAD(po.id::text, 6, '0')) AS booking_or_order_no,
            to_char(COALESCE(t.transaction_date, ((po.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta')::date), 'YYYY-MM-DD') AS tx_date,
            to_char(COALESCE(t.created_at, (po.created_at AT TIME ZONE 'UTC')) AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') AS tx_datetime,
            COALESCE(NULLIF(BTRIM(po.guest_name), ''), NULLIF(BTRIM(t.guest_name_snapshot), ''), NULLIF(BTRIM(t.party_name), ''), NULLIF(BTRIM(r.guest_name), ''), 'Walk-In POS') AS customer_name,
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
            CASE
              WHEN po.reservation_id IS NOT NULL AND r.id IS NOT NULL THEN
                CASE
                  WHEN UPPER(COALESCE(r.payment_status, '')) = 'PAID'
                    AND COALESCE(r.remaining_balance, GREATEST(0, COALESCE(r.total_price, 0) - COALESCE(r.amount_paid, 0))) <= 0
                  THEN 'PAID'
                  ELSE COALESCE(NULLIF(BTRIM(r.payment_status), ''), 'UNPAID')
                END
              ELSE COALESCE(NULLIF(BTRIM(t.payment_status), ''), 'PAID')
            END AS payment_status,
            t.id AS transaction_id,
            CASE
              WHEN (COALESCE(poi.quantity, 1) * COALESCE(poi.unit_price, 0)) = 0
                OR UPPER(COALESCE(t.payment_method, '')) LIKE '%COMP%'
                OR UPPER(COALESCE(t.payment_status, '')) LIKE '%COMP%'
                OR UPPER(COALESCE(po.status, '')) LIKE '%COMP%'
                OR UPPER(COALESCE(poi.notes, '')) LIKE '%COMP%'
              THEN 0
              ELSE COALESCE(t.tax_amount, po.tax_amount, 0)
            END::numeric(14,2) AS tax_amount,
            CASE
              WHEN (COALESCE(poi.quantity, 1) * COALESCE(poi.unit_price, 0)) = 0
                OR UPPER(COALESCE(t.payment_method, '')) LIKE '%COMP%'
                OR UPPER(COALESCE(t.payment_status, '')) LIKE '%COMP%'
                OR UPPER(COALESCE(po.status, '')) LIKE '%COMP%'
                OR UPPER(COALESCE(poi.notes, '')) LIKE '%COMP%'
              THEN 0
              ELSE COALESCE(t.service_amount, po.service_amount, 0)
            END::numeric(14,2) AS service_amount,
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
              OR UPPER(COALESCE(t.payment_status, '')) LIKE '%COMP%'
              OR UPPER(COALESCE(po.status, '')) LIKE '%COMP%'
              OR UPPER(COALESCE(poi.notes, '')) LIKE '%COMP%'
            ) AS is_complimentary
          FROM pos_order_items poi
          JOIN pos_orders po ON po.id = poi.order_id
          LEFT JOIN pos_menu_items pmi ON pmi.id = poi.menu_item_id AND pmi.property_id = po.property_id
          LEFT JOIN pos_menu_categories pmc ON pmc.id = pmi.category_id AND pmc.property_id = po.property_id
          LEFT JOIN reservations r ON r.id = po.reservation_id
          LEFT JOIN bookings b ON b.id = r.booking_id
          LEFT JOIN rooms rm ON rm.id = r.room_id AND rm.property_id = po.property_id
          LEFT JOIN LATERAL (
            SELECT t_cand.*
            FROM transactions t_cand
            WHERE t_cand.property_id = po.property_id
              AND t_cand.deleted_at IS NULL
              AND UPPER(COALESCE(t_cand.transaction_status, 'POSTED')) NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
              AND NOT EXISTS (
                SELECT 1 FROM transactions t_rev
                WHERE t_rev.property_id = t_cand.property_id
                  AND t_rev.reversal_of_transaction_id = t_cand.id
                  AND t_rev.deleted_at IS NULL
              )
              AND (
                (UPPER(COALESCE(t_cand.source_type, '')) IN ('POS_ORDER', 'POS') AND (t_cand.source_id = po.id::text OR t_cand.source_reference = po.order_number))
                OR (
                  UPPER(COALESCE(t_cand.source_type, '')) = 'FOLIO_ENTRY'
                  AND EXISTS (
                    SELECT 1 FROM folio_entries fe
                    WHERE fe.id::text = t_cand.source_id
                      AND fe.property_id = po.property_id
                      AND fe.source_type = 'POS_ORDER'
                      AND fe.source_id = po.id::text
                      AND COALESCE(fe.is_voided, FALSE) = FALSE
                  )
                )
              )
            ORDER BY t_cand.id DESC
            LIMIT 1
          ) t ON TRUE
          WHERE po.property_id = $1
            AND UPPER(COALESCE(po.status, 'OPEN')) IN ('PAID', 'COMPLETED', 'POSTED', 'CLOSED', 'BILLED_TO_ROOM')
            AND t.id IS NOT NULL
            AND (
              po.reservation_id IS NULL
              OR (
                UPPER(COALESCE(r.status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
                AND UPPER(COALESCE(r.stay_status, '')) NOT IN ('CANCELLED', 'NO_SHOW')
                AND COALESCE(b.booking_status, '') != 'CANCELLED'
                AND NOT ${isReservationTxVoidedSql}
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
            CASE
              WHEN COALESCE(t.net_amount, 0) <= 0
                OR UPPER(COALESCE(t.payment_method, '')) LIKE '%COMP%'
                OR UPPER(COALESCE(t.payment_status, '')) LIKE '%COMP%'
              THEN 0
              ELSE COALESCE(t.tax_amount, 0)
            END::numeric(14,2) AS tax_amount,
            CASE
              WHEN COALESCE(t.net_amount, 0) <= 0
                OR UPPER(COALESCE(t.payment_method, '')) LIKE '%COMP%'
                OR UPPER(COALESCE(t.payment_status, '')) LIKE '%COMP%'
              THEN 0
              ELSE COALESCE(t.service_amount, 0)
            END::numeric(14,2) AS service_amount,
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
              COALESCE(t.net_amount, 0) <= 0
              OR UPPER(COALESCE(t.payment_method, '')) LIKE '%COMP%'
              OR UPPER(COALESCE(t.payment_status, '')) LIKE '%COMP%'
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
            AND NOT EXISTS (
              SELECT 1 FROM transactions t_rev
              WHERE t_rev.property_id = t.property_id
                AND t_rev.reversal_of_transaction_id = t.id
                AND t_rev.deleted_at IS NULL
            )
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
      ),

      // 4. Purchase Line Items for Pembelian Report (Transactions PURCHASE + POS Purchase Orders)
      pool.query(
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
            AND COALESCE(UPPER(t.approval_status), 'APPROVED') != 'REJECTED'
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
            AND COALESCE(UPPER(ppo.status), 'DRAFT') = 'COMPLETED'
            AND COALESCE(UPPER(ppo.approval_status), 'APPROVED') = 'APPROVED'
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
      ),

      // 5. Daily Occupancy Bar Series
      pool.query(
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
      ),

      // 6. Enriched Room Sales (Opsi 1: Daily / Period-Prorated Room Revenue + Room Rate per Night)
      pool.query(
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
            CASE
              WHEN ${isCompReservationSql} THEN 0
              ELSE COALESCE(
                NULLIF(r.tax_amount, 0),
                (
                  SELECT NULLIF(SUM(rnr.tax_amount), 0)
                  FROM reservation_nightly_rates rnr
                  WHERE rnr.reservation_id = r.id
                ),
                (
                  SELECT NULLIF(SUM(t.tax_amount), 0)
                  FROM transactions t
                  WHERE t.property_id = b.property_id
                    AND (t.reservation_id = r.id OR t.booking_id = r.booking_id)
                    AND t.transaction_type = 'SALE'
                    AND t.deleted_at IS NULL
                    AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
                ),
                ROUND(
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
                  ) * COALESCE((SELECT NULLIF(pps.tax_percent, 0) FROM property_pricing_settings pps WHERE pps.property_id = b.property_id LIMIT 1), 11)
                  / (100.0 + COALESCE((SELECT NULLIF(pps.tax_percent, 0) FROM property_pricing_settings pps WHERE pps.property_id = b.property_id LIMIT 1), 11)),
                  2
                ),
                0
              )
            END::numeric(14,2) AS full_tax_amount,
            CASE
              WHEN ${isCompReservationSql} THEN 0
              ELSE COALESCE(
                NULLIF(r.service_amount, 0),
                (
                  SELECT NULLIF(SUM(rnr.service_amount), 0)
                  FROM reservation_nightly_rates rnr
                  WHERE rnr.reservation_id = r.id
                ),
                (
                  SELECT NULLIF(SUM(t.service_amount), 0)
                  FROM transactions t
                  WHERE t.property_id = b.property_id
                    AND (t.reservation_id = r.id OR t.booking_id = r.booking_id)
                    AND t.transaction_type = 'SALE'
                    AND t.deleted_at IS NULL
                    AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
                ),
                CASE
                  WHEN COALESCE((SELECT pps.service_charge_percent FROM property_pricing_settings pps WHERE pps.property_id = b.property_id LIMIT 1), 0) > 0 THEN
                    ROUND(
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
                      ) * COALESCE((SELECT pps.service_charge_percent FROM property_pricing_settings pps WHERE pps.property_id = b.property_id LIMIT 1), 0)
                      / (100.0 + COALESCE((SELECT pps.service_charge_percent FROM property_pricing_settings pps WHERE pps.property_id = b.property_id LIMIT 1), 0)),
                      2
                    )
                  ELSE 0
                END,
                0
              )
            END::numeric(14,2) AS full_service_amount,
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
            AND NOT ${isReservationTxVoidedSql}
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
          CASE
            WHEN UPPER(COALESCE(stay_type, '')) IN ('DAY_USE', 'SHORT_TIME') THEN full_service_amount
            ELSE ROUND(full_service_amount * period_nights::numeric / GREATEST(1, total_stay_nights)::numeric, 2)
          END::numeric(14,2) AS service_amount,
          attachment_id,
          payment_evidence_id,
          reservation_status,
          is_complimentary,
          (period_nights * base_rate)::numeric(14,2) AS estimated_comp_value
        FROM raw_room_sales
        ORDER BY check_in DESC, reservation_id DESC
        `,
        [propertyId, startDate, endDate]
      ),

      // 6b. Cancelled Bookings / Reservations in [startDate, endDate]
      pool.query(
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
          AND (r.status = 'CANCELLED' OR COALESCE(b.booking_status, '') = 'CANCELLED' OR ${isReservationTxVoidedSql})
          AND (
            (r.check_in::date >= $2::date AND r.check_in::date <= $3::date)
            OR (r.cancelled_at IS NOT NULL AND (r.cancelled_at AT TIME ZONE 'Asia/Jakarta')::date >= $2::date AND (r.cancelled_at AT TIME ZONE 'Asia/Jakarta')::date <= $3::date)
          )
        ORDER BY COALESCE(r.cancelled_at, r.check_in) DESC, r.id DESC
        `,
        [propertyId, startDate, endDate]
      ),

      // 6c. Property Pricing Settings (for PPN / Tax calculation)
      pool.query(
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
      )
      ]);
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

      const [
        bookingGlobalDiscRes,
        txDiscountRes,
        financialsData,
        txAggRes,
        stockMoveRes,
        cashFlowRes,
        balanceSheetRes,
      ] = await Promise.all([
        pool.query(
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
        ),
        pool.query(
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
        ),
        calculateFinancials(pool, {
          property_id: propertyId,
          start_date: startDate,
          end_date: endDate
        }),
        pool.query(
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
        ),
        pool.query(
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
        ),
        pool.query(
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
              UPPER(COALESCE(t.approval_status, 'APPROVED')) AS approval_status,
              t.reservation_id,
              t.booking_id
            FROM transactions t
            WHERE t.property_id = $1
              AND t.deleted_at IS NULL
              AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
              ${nonCancelledTxFilter}
          )
          SELECT
            (
              COALESCE((SELECT SUM(CASE WHEN tx_type = 'DEPOSIT_REFUND' THEN -amount ELSE amount END) FROM pt_cash WHERE p_date < $2::date), 0)
              + COALESCE((SELECT SUM(net_amount) FROM tx_cash WHERE t_date < $2::date AND transaction_type IN ('SALE', 'INCOME') AND reservation_id IS NULL AND booking_id IS NULL AND payment_status = 'PAID'), 0)
              - COALESCE((SELECT SUM(net_amount) FROM tx_cash WHERE t_date < $2::date AND transaction_type IN ('EXPENSE', 'PURCHASE') AND payment_status = 'PAID' AND approval_status = 'APPROVED'), 0)
            )::numeric(14,2) AS opening_cash_balance,
            (
              COALESCE((SELECT SUM(amount) FROM pt_cash WHERE p_date >= $2::date AND p_date <= $3::date AND tx_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT', 'DEPOSIT')), 0)
              + COALESCE((SELECT SUM(net_amount) FROM tx_cash WHERE t_date >= $2::date AND t_date <= $3::date AND transaction_type = 'SALE' AND reservation_id IS NULL AND booking_id IS NULL), 0)
            )::numeric(14,2) AS customer_receipts,
            (
              COALESCE((SELECT SUM(net_amount) FROM tx_cash WHERE t_date >= $2::date AND t_date <= $3::date AND transaction_type = 'PURCHASE' AND payment_status = 'PAID' AND approval_status = 'APPROVED'), 0)
              + COALESCE((
                SELECT SUM(ppo.total_estimated_amount)
                FROM pos_purchase_orders ppo
                WHERE ppo.property_id = $1
                  AND ppo.status = 'COMPLETED'
                  AND COALESCE(UPPER(ppo.approval_status), 'APPROVED') = 'APPROVED'
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
            COALESCE((
              SELECT SUM(net_amount) FROM tx_cash
              WHERE t_date >= $2::date AND t_date <= $3::date
                AND transaction_type = 'EXPENSE'
                AND payment_status = 'PAID'
                AND approval_status = 'APPROVED'
                AND UPPER(COALESCE(department_code, '')) NOT LIKE '%MAINT%'
                AND UPPER(COALESCE(category_code, '')) NOT LIKE '%MAINT%'
            ), 0)::numeric(14,2) AS operating_expenses,
            COALESCE((
              SELECT SUM(net_amount) FROM tx_cash
              WHERE t_date >= $2::date AND t_date <= $3::date
                AND transaction_type = 'EXPENSE'
                AND payment_status = 'PAID'
                AND approval_status = 'APPROVED'
                AND (UPPER(COALESCE(department_code, '')) LIKE '%MAINT%' OR UPPER(COALESCE(category_code, '')) LIKE '%MAINT%')
            ), 0)::numeric(14,2) AS maintenance_expenses,
            COALESCE((
              SELECT SUM(net_amount) FROM tx_cash
              WHERE t_date >= $2::date AND t_date <= $3::date
                AND transaction_type = 'INCOME'
            ), 0)::numeric(14,2) AS other_income_receipts,
            COALESCE((
              SELECT SUM(amount) FROM pt_cash
              WHERE p_date >= $2::date AND p_date <= $3::date
                AND tx_type = 'DEPOSIT_REFUND'
            ), 0)::numeric(14,2) AS other_expenses
          `,
          [propertyId, startDate, endDate]
        ),
        pool.query(
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
                SUM(CASE WHEN t.transaction_type = 'PURCHASE' AND COALESCE(UPPER(t.approval_status), 'APPROVED') = 'APPROVED' AND UPPER(COALESCE(t.payment_status, 'PAID')) = 'PAID' THEN t.net_amount ELSE 0 END) AS purchase_total,
                SUM(CASE WHEN t.transaction_type = 'EXPENSE' AND COALESCE(UPPER(t.approval_status), 'APPROVED') = 'APPROVED' AND UPPER(COALESCE(t.payment_status, 'PAID')) = 'PAID' THEN t.net_amount ELSE 0 END) AS expense_total
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
        ),
      ]);

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

      const txAgg = txAggRes.rows[0] || {};
      const stockMove = stockMoveRes.rows[0] || {};
      const cfRow = cashFlowRes.rows[0] || {};
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
      const inventoryValue = Math.max(0, Number(bsRow.inventory_value || 0));

      const accountingSubledger = await buildAccountingSubledgerData(pool, {
        propertyId,
        startDate,
        endDate,
        cashOnHand,
        bankAccount,
        transferBank,
        qrisBalance,
        cardEdc,
        inventoryValue,
        allTimePiutangTotal,
        allTimePiutangItems,
        periodPiutangItems,
        roomSales: roomSalesRes.rows || [],
        posItemSales: posItemsRes.rows || [],
        financialsData,
        pricingSettings,
      });

      const investingFixedAssets = Number(accountingSubledger.fixed_assets.period_purchase_total || 0);
      const financingEquityChanges = -Number(accountingSubledger.period_investor_transfers || 0);
      cashFlow.investing_activities.fixed_assets = investingFixedAssets;
      cashFlow.investing_activities.subtotal_investing = -investingFixedAssets;
      cashFlow.total_income_after_investing = subtotalOperating - investingFixedAssets;
      cashFlow.financing_activities.equity_changes = financingEquityChanges;
      cashFlow.financing_activities.subtotal_financing = financingEquityChanges;
      cashFlow.net_cash_change = subtotalOperating - investingFixedAssets + financingEquityChanges;
      cashFlow.closing_cash_balance = openingCash + cashFlow.net_cash_change;

      const coaByNum = new Map<string, number>();
      for (const acc of accountingSubledger.coa_accounts) {
        coaByNum.set(acc.account_number, Number(acc.current_balance || 0));
      }

      const bsCash = coaByNum.get('11101') ?? cashOnHand;
      const bsBank = coaByNum.get('11102') ?? bankAccount;
      const bsTransfer = coaByNum.get('11105') ?? transferBank;
      const bsQris = coaByNum.get('11106') ?? qrisBalance;
      const bsShortTermInv = coaByNum.get('11200') ?? 0;
      const accountsReceivable = Math.max(0, Number(accountingSubledger.receivables.unpaid_total || allTimePiutangTotal));
      const fixedAssets = Math.max(0, Number(accountingSubledger.fixed_assets.active_total_value || 0));
      const subtotalCurrentAssets =
        bsCash +
        bsBank +
        bsTransfer +
        bsQris +
        cardEdc +
        bsShortTermInv +
        accountsReceivable +
        inventoryValue;
      const totalAssets = subtotalCurrentAssets + fixedAssets;

      const accountsPayable = Math.max(0, Number(accountingSubledger.payables.unpaid_total || 0));
      const guestDeposits = Math.max(0, Number(bsRow.guest_deposits || 0));
      const subtotalLiabilities = accountsPayable + guestDeposits;
      const currentPeriodIncome = netProfit;
      const retainedEarnings = totalAssets - subtotalLiabilities - currentPeriodIncome;
      const subtotalEquity = retainedEarnings + currentPeriodIncome;

      const balanceSheet = {
        assets: {
          current_assets: {
            cash_on_hand: bsCash,
            bank_account: bsBank,
            transfer_bank: bsTransfer,
            qris_balance: bsQris,
            card_edc: cardEdc,
            short_term_investment: bsShortTermInv,
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
          accounting_subledger: accountingSubledger,
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

  // ============================================================================
  // ACCOUNTING CRUD ENDPOINTS (COA, Banks, Investor Transfers, Assets, AP, AR)
  // ============================================================================

  router.post('/accounting/coa', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePositiveInt(req.body.property_id) || 1;
      await ensureAccountingSchema(pool, propertyId);
      const accountNumber = String(req.body.account_number || '').trim();
      const accountName = String(req.body.account_name || '').trim();
      const classification = String(req.body.classification || 'Kas & Bank').trim();
      const openingBalance = Number(req.body.opening_balance || 0);
      const openingDate = req.body.opening_date ? String(req.body.opening_date).slice(0, 10) : null;
      if (!accountNumber || !accountName) {
        return res.status(400).json({ status: 'ERROR', message: 'Nomor akun dan nama akun wajib diisi' });
      }
      const r = await pool.query(
        `INSERT INTO accounting_coa_accounts (property_id, account_number, account_name, classification, opening_balance, opening_date, is_system, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE, NOW())
         ON CONFLICT (property_id, account_number)
         DO UPDATE SET
           account_name = EXCLUDED.account_name,
           classification = EXCLUDED.classification,
           opening_balance = EXCLUDED.opening_balance,
           opening_date = EXCLUDED.opening_date,
           updated_at = NOW()
         RETURNING *`,
        [propertyId, accountNumber, accountName, classification, openingBalance, openingDate]
      );
      return res.json({ status: 'SUCCESS', data: r.rows[0] });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal menyimpan akun COA' });
    }
  });

  router.delete('/accounting/coa/:id', async (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ status: 'ERROR', message: 'ID tidak valid' });
      await ensureAccountingSchema(pool, 1);
      await pool.query(`DELETE FROM accounting_coa_accounts WHERE id = $1 AND is_system = FALSE`, [id]);
      return res.json({ status: 'SUCCESS' });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal menghapus akun COA' });
    }
  });

  router.post('/accounting/banks', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePositiveInt(req.body.property_id) || 1;
      await ensureAccountingSchema(pool, propertyId);
      const bankName = String(req.body.bank_name || '').trim();
      const accountNumber = String(req.body.account_number || '-').trim();
      const accountHolder = String(req.body.account_holder || '-').trim();
      const balance = Number(req.body.balance || 0);
      const notes = req.body.notes ? String(req.body.notes).trim() : null;
      if (!bankName) {
        return res.status(400).json({ status: 'ERROR', message: 'Nama bank / metode wajib diisi' });
      }
      const r = await pool.query(
        `INSERT INTO accounting_bank_accounts (property_id, bank_name, account_number, account_holder, balance, notes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`,
        [propertyId, bankName, accountNumber, accountHolder, balance, notes]
      );
      return res.json({ status: 'SUCCESS', data: r.rows[0] });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal menyimpan rekening bank' });
    }
  });

  router.delete('/accounting/banks/:id', async (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ status: 'ERROR', message: 'ID tidak valid' });
      await ensureAccountingSchema(pool, 1);
      await pool.query(`DELETE FROM accounting_bank_accounts WHERE id = $1`, [id]);
      return res.json({ status: 'SUCCESS' });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal menghapus rekening bank' });
    }
  });

  router.post('/accounting/investor-transfers', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePositiveInt(req.body.property_id) || 1;
      await ensureAccountingSchema(pool, propertyId);
      const sourceAccount = String(req.body.source_account || '').trim();
      const investorName = String(req.body.investor_name || '').trim();
      const amount = Number(req.body.amount || 0);
      const transferDate = req.body.transfer_date
        ? String(req.body.transfer_date).slice(0, 10)
        : hotelDateFromInstant(new Date());
      const notes = req.body.notes ? String(req.body.notes).trim() : null;
      if (!sourceAccount || !investorName || !(amount > 0)) {
        return res.status(400).json({
          status: 'ERROR',
          message: 'Akun sumber, nama investor, dan jumlah (> 0) wajib diisi',
        });
      }
      const r = await pool.query(
        `INSERT INTO accounting_investor_transfers (property_id, source_account, investor_name, amount, transfer_date, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [propertyId, sourceAccount, investorName, amount, transferDate, notes]
      );
      return res.json({ status: 'SUCCESS', data: r.rows[0] });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal mencatat transfer investor' });
    }
  });

  router.delete('/accounting/investor-transfers/:id', async (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ status: 'ERROR', message: 'ID tidak valid' });
      await ensureAccountingSchema(pool, 1);
      await pool.query(`DELETE FROM accounting_investor_transfers WHERE id = $1`, [id]);
      return res.json({ status: 'SUCCESS' });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal menghapus transfer investor' });
    }
  });

  router.post('/accounting/assets', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePositiveInt(req.body.property_id) || 1;
      await ensureAccountingSchema(pool, propertyId);
      const assetCode = req.body.asset_code ? String(req.body.asset_code).trim().toUpperCase() || null : null;
      const assetName = String(req.body.asset_name || '').trim().toUpperCase();
      const brand = String(req.body.brand || '-').trim().toUpperCase() || '-';
      const serialNumber = String(req.body.serial_number || '-').trim().toUpperCase() || '-';
      const photoDataUrl = req.body.photo_data_url ? String(req.body.photo_data_url).trim() || null : null;
      const category = String(req.body.category || 'PERALATAN').trim().toUpperCase() || 'PERALATAN';
      const storageLocation = String(req.body.storage_location || '-').trim().toUpperCase() || '-';
      const purchaseDate = req.body.purchase_date
        ? String(req.body.purchase_date).slice(0, 10)
        : hotelDateFromInstant(new Date());
      const purchasePrice = Number(req.body.purchase_price || 0);
      const currentValue =
        req.body.current_value !== undefined && req.body.current_value !== ''
          ? Number(req.body.current_value)
          : purchasePrice;
      const depreciationRate = Number(req.body.depreciation_rate || 0);
      const status = String(req.body.status || 'ACTIVE').toUpperCase();
      const notes = req.body.notes ? String(req.body.notes).trim().toUpperCase() : null;
      if (!assetName) {
        return res.status(400).json({ status: 'ERROR', message: 'Nama barang wajib diisi' });
      }
      await pool.query(
        `INSERT INTO accounting_asset_categories (property_id, category_name, is_system)
         VALUES ($1, $2, FALSE)
         ON CONFLICT (property_id, category_name) DO NOTHING`,
        [propertyId, category]
      );
      const r = await pool.query(
        `INSERT INTO accounting_fixed_assets
           (property_id, asset_code, asset_name, brand, serial_number, photo_data_url, category, storage_location, purchase_date, purchase_price, current_value, depreciation_rate, status, notes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
         RETURNING *`,
        [
          propertyId,
          assetCode,
          assetName,
          brand,
          serialNumber,
          photoDataUrl,
          category,
          storageLocation,
          purchaseDate,
          purchasePrice,
          currentValue,
          depreciationRate,
          status,
          notes,
        ]
      );
      return res.json({ status: 'SUCCESS', data: r.rows[0] });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal menyimpan aset tetap' });
    }
  });

  router.put('/accounting/assets/:id', async (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ status: 'ERROR', message: 'ID aset tidak valid' });
      const propertyId = parsePositiveInt(req.body.property_id) || 1;
      await ensureAccountingSchema(pool, propertyId);

      const assetCode = req.body.asset_code ? String(req.body.asset_code).trim().toUpperCase() || null : null;
      const assetName = String(req.body.asset_name || '').trim().toUpperCase();
      const brand = String(req.body.brand || '-').trim().toUpperCase() || '-';
      const serialNumber = String(req.body.serial_number || '-').trim().toUpperCase() || '-';
      const photoDataUrl =
        req.body.photo_data_url !== undefined
          ? req.body.photo_data_url
            ? String(req.body.photo_data_url).trim()
            : null
          : undefined;
      const category = String(req.body.category || 'PERALATAN').trim().toUpperCase() || 'PERALATAN';
      const storageLocation = String(req.body.storage_location || '-').trim().toUpperCase() || '-';
      const purchaseDate = req.body.purchase_date
        ? String(req.body.purchase_date).slice(0, 10)
        : hotelDateFromInstant(new Date());
      const purchasePrice = Number(req.body.purchase_price || 0);
      const currentValue =
        req.body.current_value !== undefined && req.body.current_value !== ''
          ? Number(req.body.current_value)
          : purchasePrice;
      const depreciationRate = Number(req.body.depreciation_rate || 0);
      const notes = req.body.notes ? String(req.body.notes).trim().toUpperCase() : null;

      if (!assetName) {
        return res.status(400).json({ status: 'ERROR', message: 'Nama barang wajib diisi' });
      }

      await pool.query(
        `INSERT INTO accounting_asset_categories (property_id, category_name, is_system)
         VALUES ($1, $2, FALSE)
         ON CONFLICT (property_id, category_name) DO NOTHING`,
        [propertyId, category]
      );

      const r = await pool.query(
        `UPDATE accounting_fixed_assets
         SET asset_code = $1,
             asset_name = $2,
             brand = $3,
             serial_number = $4,
             photo_data_url = CASE WHEN $5::boolean THEN $6 ELSE photo_data_url END,
             category = $7,
             storage_location = $8,
             purchase_date = $9,
             purchase_price = $10,
             current_value = $11,
             depreciation_rate = $12,
             notes = $13,
             updated_at = NOW()
         WHERE id = $14
         RETURNING *`,
        [
          assetCode,
          assetName,
          brand,
          serialNumber,
          photoDataUrl !== undefined,
          photoDataUrl ?? null,
          category,
          storageLocation,
          purchaseDate,
          purchasePrice,
          currentValue,
          depreciationRate,
          notes,
          id,
        ]
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ status: 'ERROR', message: 'Aset tidak ditemukan' });
      }
      return res.json({ status: 'SUCCESS', data: r.rows[0] });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal memperbarui aset tetap' });
    }
  });

  router.patch('/accounting/assets/:id', async (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ status: 'ERROR', message: 'ID aset tidak valid' });
      const propertyId = parsePositiveInt(req.body.property_id) || 1;
      await ensureAccountingSchema(pool, propertyId);

      const photoDataUrl = req.body.photo_data_url ? String(req.body.photo_data_url).trim() : null;
      const r = await pool.query(
        `UPDATE accounting_fixed_assets
         SET photo_data_url = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [photoDataUrl, id]
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ status: 'ERROR', message: 'Aset tidak ditemukan' });
      }
      return res.json({ status: 'SUCCESS', data: r.rows[0] });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal memperbarui foto aset' });
    }
  });

  router.post('/accounting/assets/bulk-import', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePositiveInt(req.body.property_id) || 1;
      await ensureAccountingSchema(pool, propertyId);
      const items = Array.isArray(req.body.items) ? req.body.items : [];
      if (items.length === 0) {
        return res.status(400).json({ status: 'ERROR', message: 'Tidak ada baris aset yang valid untuk diimpor' });
      }
      let importedCount = 0;
      for (const item of items) {
        const assetName = String(item.asset_name || '').trim().toUpperCase();
        if (!assetName) continue;
        const assetCode = item.asset_code ? String(item.asset_code).trim().toUpperCase() || null : null;
        const brand = String(item.brand || '-').trim().toUpperCase() || '-';
        const serialNumber = String(item.serial_number || '-').trim().toUpperCase() || '-';
        const category = String(item.category || 'PERALATAN').trim().toUpperCase() || 'PERALATAN';
        const storageLocation = String(item.storage_location || '-').trim().toUpperCase() || '-';
        const purchaseDate = item.purchase_date
          ? String(item.purchase_date).slice(0, 10)
          : hotelDateFromInstant(new Date());
        const purchasePrice = Math.max(0, Number(item.purchase_price || 0));
        const currentValue =
          item.current_value !== undefined && item.current_value !== ''
            ? Math.max(0, Number(item.current_value))
            : purchasePrice;
        const depreciationRate = Math.max(0, Number(item.depreciation_rate || 0));
        const notes = item.notes ? String(item.notes).trim().toUpperCase() : null;

        await pool.query(
          `INSERT INTO accounting_asset_categories (property_id, category_name, is_system)
           VALUES ($1, $2, FALSE)
           ON CONFLICT (property_id, category_name) DO NOTHING`,
          [propertyId, category]
        );
        await pool.query(
          `INSERT INTO accounting_fixed_assets
             (property_id, asset_code, asset_name, brand, serial_number, category, storage_location, purchase_date, purchase_price, current_value, depreciation_rate, status, notes, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ACTIVE', $12, NOW())`,
          [
            propertyId,
            assetCode,
            assetName,
            brand,
            serialNumber,
            category,
            storageLocation,
            purchaseDate,
            purchasePrice,
            currentValue,
            depreciationRate,
            notes,
          ]
        );
        importedCount++;
      }
      return res.json({ status: 'SUCCESS', imported_count: importedCount });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal mengimpor data aset' });
    }
  });

  router.post('/accounting/asset-categories', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePositiveInt(req.body.property_id) || 1;
      await ensureAccountingSchema(pool, propertyId);
      const categoryName = String(req.body.category_name || '').trim();
      if (!categoryName) {
        return res.status(400).json({ status: 'ERROR', message: 'Nama kategori wajib diisi' });
      }
      const r = await pool.query(
        `INSERT INTO accounting_asset_categories (property_id, category_name, is_system)
         VALUES ($1, $2, FALSE)
         ON CONFLICT (property_id, category_name) DO UPDATE SET category_name = EXCLUDED.category_name
         RETURNING *`,
        [propertyId, categoryName]
      );
      return res.json({ status: 'SUCCESS', data: r.rows[0] });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal menambah kategori aset' });
    }
  });

  router.delete('/accounting/asset-categories/:id', async (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id);
      const nameParam = req.query.name ? String(req.query.name).trim() : '';
      await ensureAccountingSchema(pool, 1);
      if (id && id > 0) {
        await pool.query(`DELETE FROM accounting_asset_categories WHERE id = $1`, [id]);
      } else if (nameParam) {
        await pool.query(`DELETE FROM accounting_asset_categories WHERE category_name = $1`, [nameParam]);
      } else {
        return res.status(400).json({ status: 'ERROR', message: 'ID atau nama kategori tidak valid' });
      }
      return res.json({ status: 'SUCCESS' });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal menghapus kategori aset' });
    }
  });

  router.delete('/accounting/assets/:id', async (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ status: 'ERROR', message: 'ID tidak valid' });
      await ensureAccountingSchema(pool, 1);
      await pool.query(`DELETE FROM accounting_fixed_assets WHERE id = $1`, [id]);
      return res.json({ status: 'SUCCESS' });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal menghapus aset tetap' });
    }
  });

  router.post('/accounting/payables', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePositiveInt(req.body.property_id) || 1;
      await ensureAccountingSchema(pool, propertyId);
      const supplierName = String(req.body.supplier_name || '').trim();
      const transactionNo =
        String(req.body.transaction_no || '').trim() || `HTG-${Date.now().toString().slice(-6)}`;
      const totalAmount = Number(req.body.total_amount || 0);
      const paidAmount = Number(req.body.paid_amount || 0);
      const dueDate = req.body.due_date ? String(req.body.due_date).slice(0, 10) : null;
      const notes = req.body.notes ? String(req.body.notes).trim() : null;
      if (!supplierName || !(totalAmount > 0)) {
        return res.status(400).json({ status: 'ERROR', message: 'Nama supplier dan total tagihan (> 0) wajib diisi' });
      }
      const status =
        paidAmount >= totalAmount ? 'PAID' : paidAmount > 0 ? 'PARTIAL' : 'UNPAID';
      const r = await pool.query(
        `INSERT INTO accounting_manual_payables
           (property_id, supplier_name, transaction_no, total_amount, paid_amount, due_date, status, notes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         RETURNING *`,
        [propertyId, supplierName, transactionNo, totalAmount, paidAmount, dueDate, status, notes]
      );
      return res.json({ status: 'SUCCESS', data: r.rows[0] });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal menambah hutang' });
    }
  });

  router.post('/accounting/payables/:id/settle', uploadPayableProof.single('file'), async (req: Request, res: Response) => {
    try {
      const rawId = String(req.params.id || '');
      const propertyId = parsePositiveInt(req.body.property_id) || 1;
      const payAmount = req.body.amount !== undefined ? Math.round(Number(req.body.amount)) : null;
      const paymentMethod = String(req.body.payment_method || 'CASH').trim().toUpperCase();
      await ensureAccountingSchema(pool, propertyId);
      if (rawId.startsWith('MANUAL-AP-')) {
        const id = parsePositiveInt(rawId.replace('MANUAL-AP-', ''));
        if (!id) return res.status(400).json({ status: 'ERROR', message: 'ID hutang tidak valid' });
        const cur = await pool.query(`SELECT * FROM accounting_manual_payables WHERE id = $1`, [id]);
        if (!cur.rowCount) return res.status(404).json({ status: 'ERROR', message: 'Data hutang tidak ditemukan' });
        const row = cur.rows[0];
        const total = Number(row.total_amount || 0);
        const currentPaid = Number(row.paid_amount || 0);
        const newPaid = payAmount !== null && payAmount > 0 ? Math.min(total, currentPaid + payAmount) : total;
        const newStatus = newPaid >= total ? 'PAID' : newPaid > 0 ? 'PARTIAL' : 'UNPAID';

        const proofUrl = req.file ? `/uploads/transactions/${req.file.filename}` : null;
        const proofFilename = req.file ? req.file.originalname : null;
        let proofData: Buffer | null = null;
        let proofMimeType: string | null = null;
        if (req.file) {
          try {
            if (req.file.path && fs.existsSync(req.file.path)) {
              proofData = fs.readFileSync(req.file.path);
              proofMimeType = req.file.mimetype;
            }
          } catch {
            // non-fatal read cache error
          }
        }

        if (proofUrl) {
          await pool.query(
            `UPDATE accounting_manual_payables
             SET paid_amount = $2, status = $3, proof_url = $4, proof_filename = $5, proof_data = $6, proof_mime_type = $7, updated_at = NOW()
             WHERE id = $1`,
            [id, newPaid, newStatus, proofUrl, proofFilename, proofData, proofMimeType]
          );
        } else {
          await pool.query(
            `UPDATE accounting_manual_payables SET paid_amount = $2, status = $3, updated_at = NOW() WHERE id = $1`,
            [id, newPaid, newStatus]
          );
        }
        return res.json({ status: 'SUCCESS' });
      } else if (rawId.startsWith('HIMS-PUR-')) {
        const txId = parsePositiveInt(rawId.replace('HIMS-PUR-', ''));
        if (!txId) return res.status(400).json({ status: 'ERROR', message: 'ID transaksi pembelian tidak valid' });
        const cur = await pool.query(
          `SELECT t.id, t.property_id, t.net_amount,
                  COALESCE((
                    SELECT SUM(pt.amount)
                    FROM payment_transactions pt
                    WHERE pt.transaction_id = t.id
                      AND pt.status = 'SUCCESS'
                      AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
                  ), 0) AS current_paid
           FROM transactions t
           WHERE t.id = $1`,
          [txId]
        );
        if (!cur.rowCount) return res.status(404).json({ status: 'ERROR', message: 'Transaksi pembelian tidak ditemukan' });
        const row = cur.rows[0];
        const propId = Number(row.property_id || propertyId);
        const remaining = Math.max(0, Math.round(Number(row.net_amount || 0) - Number(row.current_paid || 0)));
        const settleAmt = payAmount !== null && payAmount > 0 ? Math.min(remaining, payAmount) : remaining;
        if (settleAmt > 0) {
          await settleTransactionPayment(pool, txId, {
            property_id: propId,
            amount: settleAmt,
            payment_method: paymentMethod,
            notes: `PELUNASAN-HUTANG-${txId}`,
            actor_name: 'Akuntansi',
          });
        } else {
          await pool.query(
            `UPDATE transactions
             SET payment_status = 'PAID',
                 approval_status = 'APPROVED',
                 verification_status = 'VERIFIED',
                 verified_at = COALESCE(verified_at, NOW()),
                 verified_by_name = COALESCE(verified_by_name, 'Akuntansi'),
                 purchase_workflow_status = CASE WHEN transaction_type IN ('PURCHASE', 'EXPENSE') THEN 'SELESAI' ELSE purchase_workflow_status END,
                 expense_workflow_status = CASE WHEN transaction_type = 'EXPENSE' THEN 'SELESAI' ELSE expense_workflow_status END,
                 updated_at = NOW()
             WHERE id = $1`,
            [txId]
          );
        }

        // Upload payment proof if provided
        if (req.file) {
          const storagePath = `/uploads/transactions/${req.file.filename}`;
          let fileData: Buffer | null = null;
          try {
            if (req.file.path && fs.existsSync(req.file.path)) {
              fileData = fs.readFileSync(req.file.path);
            }
          } catch {
            // ignore
          }

          await addTransactionAttachment(pool, propId, txId, {
            fileName: req.file.filename,
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            fileSize: req.file.size,
            storagePath,
            uploadedBy: 'Akuntansi',
            attachmentPurpose: 'PAYMENT_PROOF',
            fileData,
          });
        }

        return res.json({ status: 'SUCCESS' });
      }
      return res.status(400).json({ status: 'ERROR', message: 'Format ID hutang tidak dikenali' });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal melunasi hutang' });
    }
  });

  router.patch('/accounting/payables/:id/approval', async (req: Request, res: Response) => {
    try {
      const rawId = String(req.params.id || '');
      const propertyId = parsePositiveInt(req.body.property_id) || 1;
      const approvalStatus = String(req.body.approval_status || '').toUpperCase() as 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
      const reason = req.body.reason ? String(req.body.reason) : null;
      const actorName = req.body.actor_name ? String(req.body.actor_name) : 'Akuntansi';

      if (!['PENDING_APPROVAL', 'APPROVED', 'REJECTED'].includes(approvalStatus)) {
        return res.status(400).json({ status: 'ERROR', message: 'Status persetujuan tidak valid' });
      }

      if (rawId.startsWith('HIMS-PUR-')) {
        const txId = parsePositiveInt(rawId.replace('HIMS-PUR-', ''));
        if (!txId) return res.status(400).json({ status: 'ERROR', message: 'ID transaksi tidak valid' });
        const cur = await pool.query(
          `SELECT id, property_id, transaction_type FROM transactions WHERE id = $1 AND deleted_at IS NULL`,
          [txId]
        );
        if (!cur.rowCount) {
          return res.status(404).json({ status: 'ERROR', message: 'Transaksi tidak ditemukan' });
        }
        const row = cur.rows[0];
        const propId = Number(row.property_id || propertyId);
        const txType = String(row.transaction_type || '').toUpperCase();

        if (txType === 'EXPENSE') {
          const updated = await executeExpenseLifecycle(pool, txId, {
            property_id: propId,
            action: 'SET_APPROVAL',
            approval_status: approvalStatus,
            reason,
            actor_name: actorName,
          });
          return res.json({ status: 'SUCCESS', data: updated });
        } else {
          const updated = await executePurchaseLifecycle(pool, txId, {
            property_id: propId,
            action: 'SET_APPROVAL',
            approval_status: approvalStatus,
            reason,
            actor_name: actorName,
          });
          return res.json({ status: 'SUCCESS', data: updated });
        }
      }

      return res.status(400).json({ status: 'ERROR', message: 'Persetujuan hanya berlaku untuk pengajuan pembelian atau pengeluaran HIMS' });
    } catch (err: any) {
      return res.status(err.statusCode || 500).json({ status: 'ERROR', message: err.message || 'Gagal memperbarui status persetujuan' });
    }
  });

  router.post('/accounting/payables/:id/proof', uploadPayableProof.single('file'), async (req: Request, res: Response) => {
    try {
      const rawId = String(req.params.id || '');
      const propertyId = parsePositiveInt(req.body.property_id) || 1;
      await ensureAccountingSchema(pool, propertyId);

      if (!req.file) {
        return res.status(400).json({ status: 'ERROR', message: 'Silakan pilih file bukti bayar terlebih dahulu.' });
      }

      const storagePath = `/uploads/transactions/${req.file.filename}`;
      let fileData: Buffer | null = null;
      try {
        if (req.file.path && fs.existsSync(req.file.path)) {
          fileData = fs.readFileSync(req.file.path);
        }
      } catch {
        // ignore
      }

      if (rawId.startsWith('MANUAL-AP-')) {
        const id = parsePositiveInt(rawId.replace('MANUAL-AP-', ''));
        if (!id) return res.status(400).json({ status: 'ERROR', message: 'ID hutang tidak valid' });
        await pool.query(
          `UPDATE accounting_manual_payables
           SET proof_url = $2, proof_filename = $3, proof_mime_type = $4, proof_data = $5, updated_at = NOW()
           WHERE id = $1`,
          [id, storagePath, req.file.originalname, req.file.mimetype, fileData]
        );
        return res.json({
          status: 'SUCCESS',
          data: {
            file_path: `/api/reports/accounting/payables/${id}/proof?t=${Date.now()}`,
          },
        });
      }

      const txId = rawId.startsWith('HIMS-PUR-')
        ? parsePositiveInt(rawId.replace('HIMS-PUR-', ''))
        : parsePositiveInt(rawId);
      if (!txId) {
        return res.status(400).json({ status: 'ERROR', message: 'ID transaksi pembelian tidak valid' });
      }

      const txRes = await pool.query(`SELECT id, property_id FROM transactions WHERE id = $1`, [txId]);
      if (!txRes.rowCount) {
        return res.status(404).json({ status: 'ERROR', message: 'Transaksi pembelian tidak ditemukan' });
      }
      const propId = Number(txRes.rows[0].property_id || propertyId);

      const created = await addTransactionAttachment(pool, propId, txId, {
        fileName: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        storagePath,
        uploadedBy: 'Akuntansi',
        attachmentPurpose: 'PAYMENT_PROOF',
        fileData,
      });

      return res.json({
        status: 'SUCCESS',
        data: {
          attachment: created,
          file_path: `/api/transactions/${txId}/attachments/${created.id}/file?t=${Date.now()}`,
        },
      });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal mengunggah bukti bayar' });
    }
  });

  router.get('/accounting/payables/:id/proof', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ status: 'ERROR', message: 'Akses ditolak. Silakan login terlebih dahulu.' });
      }
      try {
        verifyToken(authHeader.split(' ')[1]);
      } catch {
        return res.status(401).json({ status: 'ERROR', message: 'Sesi login telah kedaluwarsa.' });
      }

      const id = parsePositiveInt(req.params.id);
      if (!id) return res.status(400).json({ status: 'ERROR', message: 'ID hutang tidak valid' });

      const cur = await pool.query(
        `SELECT id, proof_url, proof_filename, proof_mime_type, proof_data FROM accounting_manual_payables WHERE id = $1`,
        [id]
      );
      if (!cur.rowCount) return res.status(404).json({ status: 'ERROR', message: 'Data hutang tidak ditemukan' });
      const row = cur.rows[0];

      const mimeType = row.proof_mime_type || 'application/octet-stream';
      const downloadName = row.proof_filename || `proof-ap-${id}`;

      if (row.proof_url) {
        const basename = path.basename(row.proof_url);
        const diskPath = path.join(TRANSACTION_ATTACHMENT_UPLOAD_DIR, basename);
        if (fs.existsSync(diskPath)) {
          res.setHeader('Content-Type', mimeType);
          res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(downloadName)}"`);
          res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
          return res.sendFile(diskPath);
        }
      }

      if (row.proof_data && Buffer.isBuffer(row.proof_data)) {
        if (row.proof_url) {
          try {
            fs.mkdirSync(TRANSACTION_ATTACHMENT_UPLOAD_DIR, { recursive: true });
            const basename = path.basename(row.proof_url);
            const diskPath = path.join(TRANSACTION_ATTACHMENT_UPLOAD_DIR, basename);
            fs.writeFileSync(diskPath, row.proof_data);
          } catch {
            // cache write non-fatal
          }
        }
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(downloadName)}"`);
        res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return res.send(row.proof_data);
      }

      return res.status(404).json({ status: 'ERROR', message: 'File lampiran tidak ditemukan. Silakan unggah ulang bukti bayar.' });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal memuat bukti bayar' });
    }
  });

  router.get('/accounting/payables/:id/items', async (req: Request, res: Response) => {
    try {
      const rawId = String(req.params.id || '');
      if (rawId.startsWith('HIMS-PUR-')) {
        const txId = parsePositiveInt(rawId.replace('HIMS-PUR-', ''));
        if (!txId) return res.status(400).json({ status: 'ERROR', message: 'ID transaksi pembelian tidak valid' });

        const txRes = await pool.query(
          `SELECT t.id, t.transaction_no, to_char(t.transaction_date, 'YYYY-MM-DD') AS tx_date,
                  COALESCE(s.name, NULLIF(BTRIM(t.party_name), ''), 'Supplier / Vendor') AS supplier_name,
                  t.description, t.net_amount, t.payment_status,
                  t.po_id, ppo.po_number,
                  COALESCE(
                    sl_po.code,
                    (
                      SELECT sl_gr.code
                      FROM pos_goods_receipts gr
                      JOIN stock_locations sl_gr ON sl_gr.id = gr.location_id
                      WHERE (gr.transaction_id = t.id OR (t.po_id IS NOT NULL AND gr.po_id = t.po_id))
                      LIMIT 1
                    ),
                    '—'
                  ) AS warehouse_code
           FROM transactions t
           LEFT JOIN suppliers s ON s.id = t.supplier_id
           LEFT JOIN pos_purchase_orders ppo ON ppo.id = t.po_id AND ppo.property_id = t.property_id
           LEFT JOIN stock_locations sl_po ON sl_po.id = ppo.destination_location_id AND sl_po.property_id = t.property_id
           WHERE t.id = $1`,
          [txId]
        );
        if (!txRes.rowCount) {
          return res.status(404).json({ status: 'ERROR', message: 'Transaksi tidak ditemukan' });
        }
        const tx = txRes.rows[0];

        // 1. Check transaction_lines
        const linesRes = await pool.query(
          `SELECT tl.id, tl.description_snapshot AS item_name, tl.quantity, tl.unit, tl.unit_price, tl.line_total
           FROM transaction_lines tl
           WHERE tl.transaction_id = $1
           ORDER BY tl.sort_order ASC, tl.id ASC`,
          [txId]
        );

        let items: any[] = [];
        if (linesRes.rowCount && linesRes.rowCount > 0) {
          items = linesRes.rows.map((r: any) => ({
            id: r.id,
            item_name: r.item_name,
            quantity: Number(r.quantity || 1),
            unit: r.unit || 'PCS',
            unit_price: Number(r.unit_price || 0),
            line_total: Number(r.line_total || 0),
          }));
        } else if (tx.po_id) {
          // 2. Check pos_purchase_order_items
          const poItemsRes = await pool.query(
            `SELECT poi.id, mi.name AS item_name, poi.ordered_qty AS quantity,
                    COALESCE(uom.code, 'PCS') AS unit,
                    poi.unit_cost AS unit_price,
                    ROUND(poi.ordered_qty * poi.unit_cost) AS line_total
             FROM pos_purchase_order_items poi
             JOIN pos_menu_items mi ON mi.id = poi.product_id
             LEFT JOIN pos_product_uoms uom ON uom.id = poi.uom_id
             WHERE poi.po_id = $1
             ORDER BY poi.id ASC`,
            [tx.po_id]
          );
          if (poItemsRes.rowCount && poItemsRes.rowCount > 0) {
            items = poItemsRes.rows.map((r: any) => ({
              id: r.id,
              item_name: r.item_name,
              quantity: Number(r.quantity || 1),
              unit: r.unit || 'PCS',
              unit_price: Number(r.unit_price || 0),
              line_total: Number(r.line_total || 0),
            }));
          }
        }

        // 3. Fallback to transaction description
        if (items.length === 0) {
          items = [
            {
              id: 1,
              item_name: tx.description || 'Pembelian Operasional / Barang',
              quantity: 1,
              unit: 'PAKET',
              unit_price: Number(tx.net_amount || 0),
              line_total: Number(tx.net_amount || 0),
            },
          ];
        }

        return res.json({
          status: 'SUCCESS',
          data: {
            transaction_no: tx.transaction_no,
            supplier_name: tx.supplier_name,
            tx_date: tx.tx_date,
            total_amount: Number(tx.net_amount || 0),
            warehouse_code: tx.warehouse_code,
            notes: tx.description,
            items,
          },
        });
      } else if (rawId.startsWith('MANUAL-AP-')) {
        const id = parsePositiveInt(rawId.replace('MANUAL-AP-', ''));
        if (!id) return res.status(400).json({ status: 'ERROR', message: 'ID hutang manual tidak valid' });

        const cur = await pool.query(
          `SELECT id, supplier_name, transaction_no, total_amount, paid_amount, notes,
                  to_char(created_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS tx_date,
                  COALESCE(warehouse_code, '—') AS warehouse_code
           FROM accounting_manual_payables
           WHERE id = $1`,
          [id]
        );
        if (!cur.rowCount) return res.status(404).json({ status: 'ERROR', message: 'Hutang tidak ditemukan' });
        const row = cur.rows[0];
        return res.json({
          status: 'SUCCESS',
          data: {
            transaction_no: row.transaction_no,
            supplier_name: row.supplier_name,
            tx_date: row.tx_date,
            total_amount: Number(row.total_amount || 0),
            warehouse_code: row.warehouse_code,
            notes: row.notes,
            items: [
              {
                id: 1,
                item_name: row.notes || 'Pencatatan Hutang Usaha Manual',
                quantity: 1,
                unit: 'LOT',
                unit_price: Number(row.total_amount || 0),
                line_total: Number(row.total_amount || 0),
              },
            ],
          },
        });
      }
      return res.status(400).json({ status: 'ERROR', message: 'Format ID hutang tidak dikenali' });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal memuat rincian pembelian' });
    }
  });

  router.delete('/accounting/payables/:id', async (req: Request, res: Response) => {
    try {
      const rawId = String(req.params.id || '');
      await ensureAccountingSchema(pool, 1);
      if (rawId.startsWith('MANUAL-AP-')) {
        const id = parsePositiveInt(rawId.replace('MANUAL-AP-', ''));
        if (!id) return res.status(400).json({ status: 'ERROR', message: 'ID tidak valid' });
        await pool.query(`DELETE FROM accounting_manual_payables WHERE id = $1`, [id]);
        return res.json({ status: 'SUCCESS' });
      }
      return res.status(400).json({
        status: 'ERROR',
        message: 'Transaksi pembelian HIMS hanya dapat dibatalkan melalui menu Pusat Transaksi',
      });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal menghapus hutang' });
    }
  });

  router.post('/accounting/receivables', async (req: Request, res: Response) => {
    try {
      const propertyId = parsePositiveInt(req.body.property_id) || 1;
      await ensureAccountingSchema(pool, propertyId);
      const customerName = String(req.body.customer_name || '').trim();
      const transactionNo =
        String(req.body.transaction_no || '').trim() || `PTG-${Date.now().toString().slice(-6)}`;
      const totalAmount = Number(req.body.total_amount || 0);
      const paidAmount = Number(req.body.paid_amount || 0);
      const dueDate = req.body.due_date ? String(req.body.due_date).slice(0, 10) : null;
      const notes = req.body.notes ? String(req.body.notes).trim() : null;
      if (!customerName || !(totalAmount > 0)) {
        return res.status(400).json({ status: 'ERROR', message: 'Nama pelanggan dan total piutang (> 0) wajib diisi' });
      }
      const status =
        paidAmount >= totalAmount ? 'PAID' : paidAmount > 0 ? 'PARTIAL' : 'UNPAID';
      const r = await pool.query(
        `INSERT INTO accounting_manual_receivables
           (property_id, customer_name, transaction_no, total_amount, paid_amount, due_date, status, notes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         RETURNING *`,
        [propertyId, customerName, transactionNo, totalAmount, paidAmount, dueDate, status, notes]
      );
      return res.json({ status: 'SUCCESS', data: r.rows[0] });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal menambah piutang' });
    }
  });

  router.post('/accounting/receivables/:id/settle', uploadPayableProof.single('file'), async (req: Request, res: Response) => {
    try {
      const rawId = String(req.params.id || '');
      const propertyId = parsePositiveInt(req.body.property_id) || 1;
      const payAmount = req.body.amount !== undefined ? Math.round(Number(req.body.amount)) : null;
      const paymentMethod = String(req.body.payment_method || 'CASH').trim().toUpperCase();
      await ensureAccountingSchema(pool, propertyId);
      if (rawId.startsWith('MANUAL-AR-')) {
        const id = parsePositiveInt(rawId.replace('MANUAL-AR-', ''));
        if (!id) return res.status(400).json({ status: 'ERROR', message: 'ID piutang tidak valid' });
        const cur = await pool.query(`SELECT * FROM accounting_manual_receivables WHERE id = $1`, [id]);
        if (!cur.rowCount) return res.status(404).json({ status: 'ERROR', message: 'Data piutang tidak ditemukan' });
        const row = cur.rows[0];
        const total = Number(row.total_amount || 0);
        const currentPaid = Number(row.paid_amount || 0);
        const newPaid = payAmount !== null && payAmount > 0 ? Math.min(total, currentPaid + payAmount) : total;
        const newStatus = newPaid >= total ? 'PAID' : newPaid > 0 ? 'PARTIAL' : 'UNPAID';
        await pool.query(
          `UPDATE accounting_manual_receivables SET paid_amount = $2, status = $3, updated_at = NOW() WHERE id = $1`,
          [id, newPaid, newStatus]
        );
        return res.json({ status: 'SUCCESS' });
      } else if (rawId.startsWith('HIMS-AR-')) {
        const bid = rawId.replace('HIMS-AR-', '').trim();
        if (!bid) return res.status(400).json({ status: 'ERROR', message: 'Kode BID piutang tidak valid' });

        // Find all active SALE transactions for this BID / reservation
        const txRes = await pool.query(
          `SELECT t.id, t.property_id, t.reservation_id, t.net_amount,
                  COALESCE(b.payment_responsibility, 'HOTEL_COLLECT') AS payment_responsibility
           FROM transactions t
           LEFT JOIN reservations r ON r.id = t.reservation_id
           LEFT JOIN bookings b ON b.id = COALESCE(t.booking_id, r.booking_id)
           WHERE t.property_id = $1
             AND t.transaction_type = 'SALE'
             AND t.deleted_at IS NULL
             AND COALESCE(t.transaction_status, 'POSTED') NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')
             AND (b.bid = $2 OR r.booking_number = $2 OR t.transaction_no = $2)
           ORDER BY t.id ASC`,
          [propertyId, bid]
        );

        if (!txRes.rowCount) {
          return res.status(404).json({ status: 'ERROR', message: `Transaksi untuk BID ${bid} tidak ditemukan` });
        }

        let budgetLeft = payAmount !== null && payAmount > 0 ? payAmount : Number.MAX_SAFE_INTEGER;
        let settledAny = false;
        let lastError = '';
        const seenReservations = new Set<number>();

        for (const tx of txRes.rows) {
          if (budgetLeft <= 0) break;
          const resId = tx.reservation_id ? Number(tx.reservation_id) : 0;
          if (resId > 0) {
            if (seenReservations.has(resId)) continue;
            seenReservations.add(resId);
          }
          try {
            const propId = Number(tx.property_id || propertyId);
            let rem = 0;

            if (resId > 0) {
              const collectible = await calculateHotelCollectibleBalance(
                pool,
                resId,
                propId,
                String(tx.payment_responsibility || 'HOTEL_COLLECT')
              );
              rem = Math.max(0, Math.round(Number(collectible.hotel_collectible_remaining_balance || 0)));
            } else {
              const pmtRes = await pool.query(
                `SELECT COALESCE(SUM(pt.amount), 0) AS paid
                 FROM payment_transactions pt
                 WHERE pt.transaction_id = $1
                   AND pt.status = 'SUCCESS'
                   AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')`,
                [tx.id]
              );
              const currentPaid = Math.round(Number(pmtRes.rows[0]?.paid || 0));
              const netAmt = Math.round(Number(tx.net_amount || 0));
              rem = Math.max(0, netAmt - currentPaid);
            }

            if (rem <= 0) continue;

            const alloc = Math.min(budgetLeft, rem);
            if (alloc <= 0) continue;

            await settleTransactionPayment(pool, tx.id, {
              property_id: propId,
              amount: alloc,
              payment_method: paymentMethod,
              notes: `PELUNASAN-PIUTANG-${bid}`,
              actor_name: 'Akuntansi',
            });

            if (resId > 0) {
              const afterCollectible = await calculateHotelCollectibleBalance(
                pool,
                resId,
                propId,
                String(tx.payment_responsibility || 'HOTEL_COLLECT')
              );
              const postRem = Math.max(0, Math.round(Number(afterCollectible.hotel_collectible_remaining_balance || 0)));
              const postPaid = Math.max(0, Math.round(Number(afterCollectible.canonical_amount_paid || 0)));
              const resPayStatus = postRem <= 0 ? 'PAID' : postPaid > 0 ? 'PARTIAL' : 'UNPAID';
              const txPayStatus = postRem <= 0 ? 'PAID' : postPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
              await pool.query(
                `UPDATE reservations
                 SET amount_paid = $1,
                     remaining_balance = $2,
                     payment_status = $3,
                     updated_at = NOW()
                 WHERE id = $4`,
                [postPaid, postRem, resPayStatus, resId]
              );
              await pool.query(
                `UPDATE transactions
                 SET payment_status = $1,
                     updated_at = NOW()
                 WHERE reservation_id = $2
                   AND property_id = $3
                   AND transaction_type = 'SALE'
                   AND deleted_at IS NULL`,
                [txPayStatus, resId, propId]
              );
            }

            budgetLeft -= alloc;
            settledAny = true;
          } catch (innerErr: any) {
            lastError = innerErr?.message || '';
            console.warn('Warning settling child tx in HIMS-AR:', innerErr?.message);
          }
        }

        if (!settledAny) {
          return res.status(400).json({
            status: 'ERROR',
            message: lastError || `Tagihan reservasi ${bid} sudah lunas atau tidak memiliki sisa tagihan yang dapat dibayar.`,
          });
        }
        return res.json({ status: 'SUCCESS' });
      }
      return res.status(400).json({
        status: 'ERROR',
        message: 'Format ID piutang tidak dikenali.',
      });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal memproses penerimaan piutang' });
    }
  });

  router.delete('/accounting/receivables/:id', async (req: Request, res: Response) => {
    try {
      const rawId = String(req.params.id || '');
      await ensureAccountingSchema(pool, 1);
      if (rawId.startsWith('MANUAL-AR-')) {
        const id = parsePositiveInt(rawId.replace('MANUAL-AR-', ''));
        if (!id) return res.status(400).json({ status: 'ERROR', message: 'ID tidak valid' });
        await pool.query(`DELETE FROM accounting_manual_receivables WHERE id = $1`, [id]);
        return res.json({ status: 'SUCCESS' });
      }
      return res.status(400).json({
        status: 'ERROR',
        message: 'Piutang reservasi kamar berasal dari Sheet Piutang HIMS dan tidak dapat dihapus manual.',
      });
    } catch (err: any) {
      return res.status(500).json({ status: 'ERROR', message: err.message || 'Gagal menghapus piutang' });
    }
  });

  return router;
}
