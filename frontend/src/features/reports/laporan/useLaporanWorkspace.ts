import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../../lib/authenticatedFetch';
import { addHotelDays, hotelDateFromInstant } from '../../calendar/calendarDates.ts';
import type { PeriodPreset, PeriodRange } from './laporanPeriods';
import type { AnalyticsHubData, FinancialsData } from './laporanTypes';

export interface LaporanError {
  code: string;
  message: string;
  endpoint: 'analytics' | 'financials';
}

export interface LaporanWorkspaceData {
  analytics: AnalyticsHubData | null;
  financials: FinancialsData | null;
  analyticsError: LaporanError | null;
  financialsError: LaporanError | null;
  loading: boolean;
  period: PeriodPreset;
  range: PeriodRange | null;
  customStart: string;
  customEnd: string;
  setCustomStart: (v: string) => void;
  setCustomEnd: (v: string) => void;
  setPeriod: (p: PeriodPreset) => void;
  refresh: () => void;
  todayHotelDate: string;
  /** Increments on every reload (used by consumers that need a sync trigger). */
  lastReloadToken: number;
}

function firstOfMonth(hotelDate: string): string {
  const [y, m] = hotelDate.split('-');
  return `${y}-${m}-01`;
}

/**
 * Resolves a preset into an INCLUSIVE [start, end] range.
 * Both analytics-hub and financials endpoints consume inclusive ranges.
 */
export function resolvePeriodRange(
  period: PeriodPreset,
  customStart: string,
  customEnd: string,
  today: string
): PeriodRange | null {
  switch (period) {
    case 'today':
      return { start: today, end: today };
    case 'yesterday': {
      const yesterday = addHotelDays(today, -1);
      return { start: yesterday, end: yesterday };
    }
    case 'last7':
      return { start: addHotelDays(today, -6), end: today };
    case 'this_month':
      return { start: firstOfMonth(today), end: today };
    case 'last_month': {
      const lastPrev = addHotelDays(firstOfMonth(today), -1);
      return { start: firstOfMonth(lastPrev), end: lastPrev };
    }
    case 'custom':
      if (!customStart || !customEnd || customStart > customEnd) return null;
      return { start: customStart, end: customEnd };
    default:
      return null;
  }
}

async function fetchJson(url: string): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await authenticatedFetch(url);
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

/**
 * Loads /api/reports/analytics-hub and /api/reports/financials for a shared
 * inclusive period. The two requests are independent: one failing never blanks
 * the other. Stale responses are discarded via a monotonic version ref.
 */
export function useLaporanWorkspace(
  propertyId: number | null,
  externalRefreshTrigger: number = 0
): LaporanWorkspaceData {
  const todayHotelDate = hotelDateFromInstant(new Date());

  const [period, setPeriod] = useState<PeriodPreset>('today');
  const [customStart, setCustomStart] = useState<string>(todayHotelDate);
  const [customEnd, setCustomEnd] = useState<string>(todayHotelDate);
  const [reloadToken, setReloadToken] = useState<number>(0);
  const [lastReloadToken, setLastReloadToken] = useState<number>(0);

  const [analytics, setAnalytics] = useState<AnalyticsHubData | null>(null);
  const [financials, setFinancials] = useState<FinancialsData | null>(null);
  const [analyticsError, setAnalyticsError] = useState<LaporanError | null>(null);
  const [financialsError, setFinancialsError] = useState<LaporanError | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const versionRef = useRef<number>(0);

  const range = resolvePeriodRange(period, customStart, customEnd, todayHotelDate);
  const rangeStart = range?.start ?? null;
  const rangeEnd = range?.end ?? null;

  const load = useCallback(
    async (targetProp: number, start: string, end: string) => {
      const version = ++versionRef.current;
      setLoading(true);
      setAnalyticsError(null);
      setFinancialsError(null);
      setLastReloadToken(version);

      const base = `/api/reports/analytics-hub?property_id=${targetProp}&start_date=${start}&end_date=${end}`;
      const finBase = `/api/reports/financials?property_id=${targetProp}&start_date=${start}&end_date=${end}`;

      const loadAnalytics = async () => {
        try {
          const { ok, status, json } = await fetchJson(base);
          if (version !== versionRef.current) return;
          if (ok && json?.status === 'SUCCESS' && json.data) {
            setAnalytics(json.data);
            setAnalyticsError(null);
          } else {
            setAnalytics(null);
            setAnalyticsError({
              code: json?.code || (status === 409 ? 'CAPACITY_HISTORY_UNAVAILABLE' : 'ERROR'),
              message: json?.message || 'Gagal memuat data analitik',
              endpoint: 'analytics',
            });
          }
        } catch (err: any) {
          if (version !== versionRef.current) return;
          setAnalytics(null);
          setAnalyticsError({
            code: 'NETWORK_ERROR',
            message: err?.message || 'Gagal terhubung ke server',
            endpoint: 'analytics',
          });
        }
      };

      const loadFinancials = async () => {
        try {
          const { ok, json } = await fetchJson(finBase);
          if (version !== versionRef.current) return;
          if (ok && json?.status === 'SUCCESS' && json.data) {
            setFinancials(json.data);
            setFinancialsError(null);
          } else {
            setFinancials(null);
            setFinancialsError({
              code: json?.code || 'ERROR',
              message: json?.message || 'Gagal memuat data finansial',
              endpoint: 'financials',
            });
          }
        } catch (err: any) {
          if (version !== versionRef.current) return;
          setFinancials(null);
          setFinancialsError({
            code: 'NETWORK_ERROR',
            message: err?.message || 'Gagal terhubung ke server',
            endpoint: 'financials',
          });
        }
      };

      await Promise.allSettled([loadAnalytics(), loadFinancials()]);
      if (version === versionRef.current) setLoading(false);
    },
    []
  );

  useEffect(() => {
    if (propertyId === null || rangeStart === null || rangeEnd === null) {
      setAnalytics(null);
      setFinancials(null);
      setAnalyticsError(null);
      setFinancialsError(null);
      setLoading(false);
      return;
    }
    void load(propertyId, rangeStart, rangeEnd);
  }, [propertyId, rangeStart, rangeEnd, reloadToken, externalRefreshTrigger, load]);

  return {
    analytics,
    financials,
    analyticsError,
    financialsError,
    loading,
    period,
    range,
    customStart,
    customEnd,
    setCustomStart,
    setCustomEnd,
    setPeriod,
    refresh: () => setReloadToken((n) => n + 1),
    todayHotelDate,
    lastReloadToken,
  };
}
