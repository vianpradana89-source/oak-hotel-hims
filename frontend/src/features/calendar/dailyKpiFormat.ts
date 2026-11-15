import type { DailyKpiData, DailyKpiDrilldownType, DailyKpiHistoryData } from './calendarApi';

export const DRAWER_TYPE_TO_KPI_DRILLDOWN: Record<string, DailyKpiDrilldownType> = {
  occupancy: 'occupancy',
  booked: 'booked',
  checkin: 'checkin',
  checkout: 'checkout',
  dirty: 'dirty',
  ready: 'vacant_clean',
  inspection: 'checkout_check',
  maintenance: 'maintenance',
};

export function formatKpiStayRange(checkIn: string | null | undefined, checkOut: string | null | undefined): string {
  const start = formatKpiHotelDay(checkIn);
  const end = formatKpiHotelDay(checkOut);
  return `${start} → ${end}`;
}

export function formatKpiHotelDay(value: string | null | undefined): string {
  const key = String(value || '').slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return '?';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${match[3]} ${months[Number(match[2]) - 1]}`;
}

export function formatKpiClock(value: string | null | undefined, timeZone: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: timeZone || 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function maintenanceSourceLabel(fromStatus: boolean, fromBlock: boolean): string {
  if (fromStatus && fromBlock) return 'Status + Block';
  if (fromStatus) return 'Status OOO/OOS';
  if (fromBlock) return 'Operational Block';
  return 'OOO/OOS';
}

export function formatOccupancyPercent(pct: number | null | undefined): string | null {
  if (pct == null || Number.isNaN(Number(pct))) return null;
  return `${Number(pct).toFixed(1).replace('.', ',')}%`;
}

export interface KpiCardView {
  key: string;
  title: string;
  value: string;
  secondary: string | null;
  color: string;
  drawerType: string;
  /** Sparkline data points (empty array means no sparkline shown). */
  trendData: number[];
  /** Factual integer delta vs previous business date; null when not computable. */
  trendDelta: number | null;
  /** Whether a sparkline should be rendered (true only for whitelisted historical metrics). */
  hasTrend: boolean;
  /** Canonical numeric occupancy percentage from the API (0–100), or null when not computable (e.g. sellable=0). Never derived from the display value string. */
  occupancyPct: number | null;
}

const HISTORICAL_METRICS_WHITELIST = new Set(['occupied_rooms', 'booked_rooms', 'booked_bookings', 'check_in_rooms', 'check_out_rooms']);

function resolveTrendData(
  history: DailyKpiHistoryData | null,
  metric: string
): { points: number[]; previousValue: number | null } {
  if (!history || !Array.isArray(history.points) || history.points.length === 0) {
    return { points: [], previousValue: null };
  }
  if (!history.historical_metrics || !history.historical_metrics.includes(metric)) {
    return { points: [], previousValue: null };
  }
  const points = history.points.map((p) => {
    const v = (p as unknown as Record<string, unknown>)[metric];
    return typeof v === 'number' ? v : 0;
  });
  const prevValue = points.length >= 2 ? points[points.length - 2] : null;
  return { points, previousValue: prevValue };
}

function computeDelta(points: number[], previousValue: number | null): number | null {
  if (points.length === 0) return null;
  const current = points[points.length - 1];
  const prev = previousValue != null ? previousValue : (points.length >= 2 ? points[points.length - 2] : null);
  if (prev == null) return null;
  return current - prev;
}

export function buildDailyKpiCards(
  kpis: DailyKpiData | null,
  history?: DailyKpiHistoryData | null
): KpiCardView[] {
  const occupancy = kpis?.occupancy;
  const booked = kpis?.booked_today;
  const occupied = occupancy?.occupied_rooms ?? 0;
  const sellable = occupancy?.sellable_rooms ?? 0;
  const pctLabel = formatOccupancyPercent(occupancy?.occupancy_pct ?? null);
  const oooOos = occupancy?.ooo_oos_rooms ?? 0;

  const supportText = `${occupied} / ${sellable} kamar`;
  const oooText = oooOos > 0 ? ` | OOO/OOS ${oooOos}` : '';

  const makeCard = (
    key: string,
    title: string,
    value: string,
    secondary: string | null,
    color: string,
    drawerType: string,
    metric: string | null
  ): KpiCardView => {
    let trendData: number[] = [];
    let trendDelta: number | null = null;
    let hasTrend = false;
    if (metric && HISTORICAL_METRICS_WHITELIST.has(metric)) {
      const { points, previousValue } = resolveTrendData(history ?? null, metric);
      trendData = points;
      trendDelta = computeDelta(points, previousValue);
      hasTrend = points.length > 0;
    }
    return { key, title, value, secondary, color, drawerType, trendData, trendDelta, hasTrend, occupancyPct: occupancy?.occupancy_pct ?? null };
  };

  return [
    makeCard(
      'occupancy',
      'Okupansi Hari Ini',
      pctLabel ?? `${occupied} / ${sellable}`,
      supportText + oooText,
      'hotel-stat-card--primary',
      'occupancy',
      null // occupancy_pct is NOT in the historical whitelist; no sparkline
    ),
    makeCard(
      'booked',
      'Booked Hari Ini',
      `${booked?.rooms ?? 0} kamar`,
      `${booked?.bookings ?? 0} booking`,
      'hotel-stat-card--booked',
      'booked',
      'booked_rooms'
    ),
    makeCard(
      'checkin',
      'Check-in Hari Ini',
      `${kpis?.check_in_today?.rooms ?? 0} kamar`,
      null,
      'hotel-stat-card--checkedin',
      'checkin',
      'check_in_rooms'
    ),
    makeCard(
      'checkout',
      'Check-out Hari Ini',
      `${kpis?.check_out_today?.rooms ?? 0} kamar`,
      null,
      'hotel-stat-card--checkout',
      'checkout',
      'check_out_rooms'
    ),
    makeCard(
      'dirty',
      'Kamar Kotor',
      String(kpis?.rooms?.dirty ?? 0),
      'kamar',
      'hotel-stat-card--dirty',
      'dirty',
      null // current-only
    ),
    makeCard(
      'vacantClean',
      'Vacant Clean',
      String(kpis?.rooms?.vacant_clean ?? 0),
      'kamar',
      'hotel-stat-card--ready',
      'ready',
      null // current-only
    ),
    makeCard(
      'checkoutCheck',
      'Checkout Check',
      String(kpis?.checkout_check?.pending ?? 0),
      'pending',
      'hotel-stat-card--inspection',
      'inspection',
      null // current-only
    ),
    makeCard(
      'maintenance',
      'Maintenance',
      String(kpis?.rooms?.maintenance_ooo_oos ?? 0),
      'kamar',
      'hotel-stat-card--maintenance',
      'maintenance',
      null // current-only
    ),
  ];
}
