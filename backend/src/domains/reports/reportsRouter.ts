import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { hotelDateFromInstant, normalizeHotelDate } from '../../utils/hotelDate';
import { calculateOccupancy } from './occupancyService';

function parsePositiveInt(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
}

export function createReportsRouter(pool: Pool): Router {
  const router = Router();

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
          AND r.status NOT IN ('CANCELLED')
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

  return router;
}
