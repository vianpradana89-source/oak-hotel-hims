import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../../../lib/authenticatedFetch';

export interface DailyOperationsData {
  property_id: number;
  business_date: string;
  date?: string;
  lifecycle: {
    arrivals_today: number;
    departures_today: number;
    in_house: number;
    booked_future_or_today: number;
  };
  rooms: {
    total_active_rooms: number;
    vacant_ready: number;
    vacant_dirty: number;
    cleaning: number;
    waiting_inspection: number;
    occupied: number;
    out_of_order: number;
    out_of_service: number;
    out_of_order_or_service: number;
  };
  financials: {
    cash_collected_today: number;
    outstanding_guest_balance: number;
  };
  business_date_metrics: {
    date: string;
    arrivals: number;
    departures: number;
    cash_collected: number;
  };
  live_snapshot: {
    in_house_current: number;
    booked_active: number;
    outstanding_guest_balance_current: number;
    total_active_rooms: number;
    vacant_ready: number;
    vacant_dirty: number;
    cleaning: number;
    waiting_inspection: number;
    occupied: number;
    out_of_order: number;
    out_of_service: number;
    out_of_order_or_service: number;
  };
}

export interface DailyKpiData {
  property_id: number;
  business_date: string;
  timezone: string;
  occupancy: {
    occupied_rooms: number;
    sellable_rooms: number;
    occupancy_pct: number | null;
    ooo_oos_rooms: number;
  };
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

export interface DailyOpsError {
  endpoint: 'daily-operations' | 'daily-kpis';
  message: string;
}

/**
 * Loads /api/reports/daily-operations and /api/reports/daily-kpis for a given
 * property and optional hotel date. The two requests are independent.
 */
export function useDailyOperations(
  propertyId: number | null,
  hotelDate: string | null,
  refreshTrigger: number = 0
): {
  dailyOps: DailyOperationsData | null;
  dailyKpis: DailyKpiData | null;
  dailyOpsError: DailyOpsError | null;
  dailyKpisError: DailyOpsError | null;
  loading: boolean;
} {
  const [dailyOps, setDailyOps] = useState<DailyOperationsData | null>(null);
  const [dailyKpis, setDailyKpis] = useState<DailyKpiData | null>(null);
  const [dailyOpsError, setDailyOpsError] = useState<DailyOpsError | null>(null);
  const [dailyKpisError, setDailyKpisError] = useState<DailyOpsError | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (propertyId === null) {
      setDailyOps(null);
      setDailyKpis(null);
      setDailyOpsError(null);
      setDailyKpisError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setDailyOpsError(null);
    setDailyKpisError(null);

    const dateParam = hotelDate ? `&date=${encodeURIComponent(hotelDate)}` : '';
    const fetchOps = async () => {
      try {
        const res = await authenticatedFetch(
          `/api/reports/daily-operations?property_id=${propertyId}${dateParam}`,
          { cache: 'no-store' }
        );
        const json = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && json?.status === 'SUCCESS' && json.data) {
          setDailyOps(json.data);
        } else {
          setDailyOps(null);
          setDailyOpsError({
            endpoint: 'daily-operations',
            message: json?.message || 'Gagal memuat data operasional harian',
          });
        }
      } catch (err: any) {
        if (cancelled) return;
        setDailyOps(null);
        setDailyOpsError({
          endpoint: 'daily-operations',
          message: err?.message || 'Gagal terhubung ke server',
        });
      }
    };

    const fetchKpis = async () => {
      try {
        const res = await authenticatedFetch(
          `/api/reports/daily-kpis?property_id=${propertyId}${dateParam}`
        );
        const json = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && json?.status === 'SUCCESS' && json.data) {
          setDailyKpis(json.data);
        } else {
          setDailyKpis(null);
          setDailyKpisError({
            endpoint: 'daily-kpis',
            message: json?.message || 'Gagal memuat KPI harian',
          });
        }
      } catch (err: any) {
        if (cancelled) return;
        setDailyKpis(null);
        setDailyKpisError({
          endpoint: 'daily-kpis',
          message: err?.message || 'Gagal terhubung ke server',
        });
      }
    };

    void Promise.allSettled([fetchOps(), fetchKpis()]).then(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [propertyId, hotelDate, refreshTrigger]);

  return { dailyOps, dailyKpis, dailyOpsError, dailyKpisError, loading };
}
