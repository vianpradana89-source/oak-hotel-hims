import {
  addHotelDays,
  hotelDateFromInstant,
  normalizeHotelDate,
} from '../calendar/calendarDates.ts';
import type { OccupancyPeriodPreset } from './occupancyReportingTypes.ts';

/**
 * Returns the first date of the month (YYYY-MM-01) for a given hotel date.
 */
export function getFirstDateOfMonth(hotelDate: string): string {
  const normalized = normalizeHotelDate(hotelDate);
  if (!normalized) return '';
  const [year, month] = normalized.split('-');
  return `${year}-${month}-01`;
}

/**
 * Returns the exclusive end date for the month containing the given hotel date (first date of next month).
 * e.g., 2026-08-27 -> 2026-09-01
 * e.g., 2026-12-15 -> 2027-01-01
 */
export function getFirstDateOfNextMonth(hotelDate: string): string {
  const normalized = normalizeHotelDate(hotelDate);
  if (!normalized) return '';
  const [yearStr, monthStr] = normalized.split('-');
  let year = parseInt(yearStr, 10);
  let month = parseInt(monthStr, 10);

  if (month === 12) {
    year += 1;
    month = 1;
  } else {
    month += 1;
  }

  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export interface PeriodQueryConfig {
  urlParams: string;
  startDate: string;
  endDateExclusive: string;
  displayLabel: string;
  isSingleDay: boolean;
}

/**
 * Constructs the exact query string parameters and boundary metadata for the occupancy report.
 * Strictly adheres to [start_date, end_date) half-open intervals.
 */
export function buildOccupancyQueryConfig(
  period: OccupancyPeriodPreset,
  propertyId: number,
  todayHotelDate: string,
  customStartInclusive: string,
  customEndInclusive: string
): PeriodQueryConfig | null {
  const today = normalizeHotelDate(todayHotelDate) || hotelDateFromInstant(new Date());

  if (period === 'today') {
    const nextDay = addHotelDays(today, 1);
    return {
      urlParams: `property_id=${propertyId}&date=${today}&include_room_types=true&include_daily=true`,
      startDate: today,
      endDateExclusive: nextDay,
      displayLabel: `Hari Ini (${formatDateIndonesian(today)})`,
      isSingleDay: true,
    };
  }

  if (period === '7days') {
    // Trailing 7 days up to today: (today - 6 days) to (today + 1 day exclusive) = 7 nights
    const start = addHotelDays(today, -6);
    const endExclusive = addHotelDays(today, 1);
    return {
      urlParams: `property_id=${propertyId}&start_date=${start}&end_date=${endExclusive}&include_room_types=true&include_daily=true`,
      startDate: start,
      endDateExclusive: endExclusive,
      displayLabel: `7 Hari Terakhir (${formatDateIndonesian(start)} – ${formatDateIndonesian(today)})`,
      isSingleDay: false,
    };
  }

  if (period === 'this_month') {
    const start = getFirstDateOfMonth(today);
    const endExclusive = getFirstDateOfNextMonth(today);
    const lastDayInclusive = addHotelDays(endExclusive, -1);
    return {
      urlParams: `property_id=${propertyId}&start_date=${start}&end_date=${endExclusive}&include_room_types=true&include_daily=true`,
      startDate: start,
      endDateExclusive: endExclusive,
      displayLabel: `Bulan Ini (${formatDateIndonesian(start)} – ${formatDateIndonesian(lastDayInclusive)})`,
      isSingleDay: false,
    };
  }

  if (period === 'custom') {
    const normStart = normalizeHotelDate(customStartInclusive);
    const normEnd = normalizeHotelDate(customEndInclusive);
    if (!normStart || !normEnd) return null;
    if (normStart > normEnd) return null;

    // Convert inclusive UI end date to exclusive backend end date
    const endExclusive = addHotelDays(normEnd, 1);
    const isSingle = normStart === normEnd;

    return {
      urlParams: `property_id=${propertyId}&start_date=${normStart}&end_date=${endExclusive}&include_room_types=true&include_daily=true`,
      startDate: normStart,
      endDateExclusive: endExclusive,
      displayLabel: isSingle
        ? `Kustom (${formatDateIndonesian(normStart)})`
        : `Kustom (${formatDateIndonesian(normStart)} – ${formatDateIndonesian(normEnd)})`,
      isSingleDay: isSingle,
    };
  }

  return null;
}

/**
 * Formats YYYY-MM-DD into Indonesian readable format e.g. "27/08/2026"
 */
export function formatDateIndonesian(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const norm = normalizeHotelDate(dateStr);
  if (!norm) return dateStr;
  const [y, m, d] = norm.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Formats period for display using human-inclusive end date.
 * Single date: "Tanggal Hotel: DD/MM/YYYY"
 * Range: "Periode: DD/MM/YYYY – DD/MM/YYYY (N malam)"
 */
export function formatInclusivePeriodDisplay(
  startDate: string,
  endDateExclusive: string,
  nights: number
): string {
  const normStart = normalizeHotelDate(startDate);
  const normEndExclusive = normalizeHotelDate(endDateExclusive);
  if (!normStart) return '—';

  if (nights <= 1 || (normEndExclusive && normEndExclusive === addHotelDays(normStart, 1))) {
    return `Tanggal Hotel: ${formatDateIndonesian(normStart)}`;
  }

  const inclusiveEnd = normEndExclusive ? addHotelDays(normEndExclusive, -1) : normStart;
  return `Periode: ${formatDateIndonesian(normStart)} – ${formatDateIndonesian(inclusiveEnd)} (${nights} malam)`;
}

/**
 * Returns localized KPI label based on whether it is a single-day or multi-day report.
 */
export function getKpiLabels(isSingleDay: boolean) {
  return {
    occupancy: 'Occupancy',
    gross: isSingleDay ? 'Total Kamar Fisik' : 'Total Gross Room Nights',
    sellable: isSingleDay ? 'Kamar Sellable' : 'Sellable Room Nights',
    sold: 'Room Nights Terjual',
    available: isSingleDay ? 'Kamar Tersedia' : 'Room Nights Tersedia',
    ooo: isSingleDay ? 'Out of Order (OOO)' : 'OOO Room Nights',
    oos: isSingleDay ? 'Out of Service (OOS)' : 'OOS Room Nights',
  };
}
