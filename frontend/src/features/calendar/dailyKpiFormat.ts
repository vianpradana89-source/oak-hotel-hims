import type { DailyKpiData } from './calendarApi';

export function formatOccupancyPercent(pct: number | null | undefined): string | null {
  if (pct == null || Number.isNaN(Number(pct))) return null;
  return `${Number(pct).toFixed(1).replace('.', ',')}%`;
}

export function formatOccupancyPrimary(occupied: number, sellable: number): string {
  return `${occupied} / ${sellable} kamar`;
}

export interface DailyKpiCardView {
  key: string;
  title: string;
  value: string;
  secondary: string | null;
  color: string;
  drawerType: string;
}

export function buildDailyKpiCards(kpis: DailyKpiData | null): DailyKpiCardView[] {
  const occupancy = kpis?.occupancy;
  const booked = kpis?.booked_today;
  const occupied = occupancy?.occupied_rooms ?? 0;
  const sellable = occupancy?.sellable_rooms ?? 0;
  const pctLabel = formatOccupancyPercent(occupancy?.occupancy_pct ?? null);

  return [
    {
      key: 'occupancy',
      title: 'Okupansi Hari Ini',
      value: formatOccupancyPrimary(occupied, sellable),
      secondary: pctLabel,
      color: 'hotel-stat-card--primary',
      drawerType: 'occupancy',
    },
    {
      key: 'booked',
      title: 'Booked Hari Ini',
      value: `${booked?.rooms ?? 0} kamar`,
      secondary: `${booked?.bookings ?? 0} booking`,
      color: 'hotel-stat-card--booked',
      drawerType: 'booked',
    },
    {
      key: 'checkin',
      title: 'Check-in Hari Ini',
      value: `${kpis?.check_in_today?.rooms ?? 0} kamar`,
      secondary: null,
      color: 'hotel-stat-card--checkedin',
      drawerType: 'checkin',
    },
    {
      key: 'checkout',
      title: 'Check-out Hari Ini',
      value: `${kpis?.check_out_today?.rooms ?? 0} kamar`,
      secondary: null,
      color: 'hotel-stat-card--checkout',
      drawerType: 'checkout',
    },
    {
      key: 'dirty',
      title: 'Kamar Kotor',
      value: String(kpis?.rooms?.dirty ?? 0),
      secondary: 'kamar',
      color: 'hotel-stat-card--dirty',
      drawerType: 'dirty',
    },
    {
      key: 'vacantClean',
      title: 'Vacant Clean',
      value: String(kpis?.rooms?.vacant_clean ?? 0),
      secondary: 'kamar',
      color: 'hotel-stat-card--ready',
      drawerType: 'ready',
    },
    {
      key: 'checkoutCheck',
      title: 'Checkout Check',
      value: String(kpis?.checkout_check?.pending ?? 0),
      secondary: 'pending',
      color: 'hotel-stat-card--inspection',
      drawerType: 'inspection',
    },
    {
      key: 'maintenance',
      title: 'Maintenance',
      value: String(kpis?.rooms?.maintenance_ooo_oos ?? 0),
      secondary: 'kamar',
      color: 'hotel-stat-card--maintenance',
      drawerType: 'maintenance',
    },
  ];
}
