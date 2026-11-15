/**
 * Shared period presets for the 7-tab Laporan workspace.
 *
 * Convention: all ranges are INCLUSIVE on both ends ([start, end]).
 * The analytics-hub endpoint consumes inclusive [start_date, end_date];
 * the financials endpoint likewise. This is distinct from the occupancy
 * endpoint's half-open [start, end) convention — each endpoint's own
 * helper/contract handles its own boundary.
 */

export type PeriodPreset =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'this_month'
  | 'last_month'
  | 'custom';

export interface PeriodRange {
  start: string; // inclusive YYYY-MM-DD
  end: string; // inclusive YYYY-MM-DD
}

export const PERIOD_PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: 'today', label: 'Hari Ini' },
  { key: 'yesterday', label: 'Kemarin' },
  { key: 'last7', label: '7 Hari' },
  { key: 'this_month', label: 'Bulan Ini' },
  { key: 'last_month', label: 'Bulan Lalu' },
  { key: 'custom', label: 'Kustom' },
];

/**
 * Formats an inclusive range for display. Single day → "Tanggal Hotel: DD/MM/YYYY".
 * Range → "DD/MM/YYYY – DD/MM/YYYY".
 */
export function formatInclusiveRangeDisplay(start: string, end: string): string {
  const fmt = (d: string) => {
    const [y, m, day] = d.split('-');
    return `${day}/${m}/${y}`;
  };
  if (start === end) {
    return `Tanggal Hotel: ${fmt(start)}`;
  }
  return `Periode: ${fmt(start)} – ${fmt(end)}`;
}
