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
  | 'all_time'
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
  { key: 'all_time', label: 'Semua Waktu' },
  { key: 'custom', label: 'Custom Tanggal' },
];

const MONTH_FULL_ID = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];

export function formatIndonesianLongDate(ymd: string): string {
  const parts = String(ymd || '').split('-');
  if (parts.length !== 3) return ymd;
  const y = parts[0];
  const mIdx = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  return `${d} ${MONTH_FULL_ID[mIdx] || parts[1]} ${y}`;
}

export function formatPeriodDropdownButtonLabel(
  period: PeriodPreset,
  range: PeriodRange | null
): string {
  const presetObj = PERIOD_PRESETS.find((p) => p.key === period);
  const label = presetObj ? presetObj.label : 'Periode';
  if (!range) return label;
  if (period === 'all_time') {
    return `Semua Waktu (${formatIndonesianLongDate(range.start)} – ${formatIndonesianLongDate(range.end)})`;
  }
  if (range.start === range.end) {
    return `${label} (${formatIndonesianLongDate(range.start)})`;
  }
  const sParts = range.start.split('-');
  const eParts = range.end.split('-');
  if (sParts.length === 3 && eParts.length === 3 && sParts[0] === eParts[0] && sParts[1] === eParts[1]) {
    const mIdx = parseInt(sParts[1], 10) - 1;
    const mName = MONTH_FULL_ID[mIdx] || sParts[1];
    return `${label} (${parseInt(sParts[2], 10)} ${mName} - ${parseInt(eParts[2], 10)} ${mName} ${eParts[0]})`;
  }
  return `${label} (${formatIndonesianLongDate(range.start)} - ${formatIndonesianLongDate(range.end)})`;
}

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
