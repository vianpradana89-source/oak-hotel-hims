import { addHotelDays, normalizeHotelDate } from './calendarDates.ts';

export interface CalendarDayColumn {
  date: string;
}

export interface ReservationCalendarSpan {
  startIndex: number;
  span: number;
}

/**
 * Visible tape-chart span for one reservation.
 * Overnight uses [check_in, check_out). Same-day overnight is invalid and omitted.
 * DAY_USE occupies only the check_in hotel date, including check_in === check_out.
 */
export function getReservationCalendarSpan(
  reservation: { check_in?: unknown; check_out?: unknown; stay_type?: unknown },
  days: CalendarDayColumn[]
): ReservationCalendarSpan | null {
  const ci = normalizeHotelDate(reservation.check_in);
  const stayType = String(reservation.stay_type || 'OVERNIGHT').toUpperCase();
  const isDayUse = stayType === 'DAY_USE';
  const co = isDayUse ? addHotelDays(ci, 1) : normalizeHotelDate(reservation.check_out);
  if (!ci || !co || ci === co) return null;

  const firstVisibleDate = days[0]?.date;
  const visibleRangeEnd = days.length > 0 ? addHotelDays(days[days.length - 1].date, 1) : '';
  if (!firstVisibleDate || !visibleRangeEnd || co <= firstVisibleDate || ci >= visibleRangeEnd) return null;

  const startIndex = days.findIndex((d) => d.date === ci);
  const endIndex = days.findIndex((d) => d.date === co);

  const visibleStart = startIndex === -1 && ci < firstVisibleDate ? 0 : startIndex;
  const visibleEnd = endIndex === -1 && co >= visibleRangeEnd ? days.length : endIndex;
  if (visibleStart < 0 || visibleEnd < 0 || visibleEnd <= visibleStart) return null;

  // Nightly stay is inclusive on check-in and exclusive on check-out.
  // DAY_USE is clipped to a single hotel date: [check_in, check_in + 1).
  const span = Math.max(1, visibleEnd - visibleStart);
  return { startIndex: visibleStart, span };
}
